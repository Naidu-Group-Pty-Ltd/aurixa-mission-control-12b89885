#!/usr/bin/env node
// A scheduled job must not be able to send an empty credential.
//
// `deployment-drain-1min` shipped with its Authorization header built as
// `'Bearer ' || COALESCE(current_setting('app.settings.cron_secret', true), '')`
// and baked into the job command with format(%L). The GUC is unset on the live
// deployment — every other job reads `vault.decrypted_secrets` — so the header
// was the literal string `Bearer `, a well-formed request the endpoint answers
// 401. It ran every minute for as long as it existed and never once
// authenticated: 208 refusals in three hours, measured from
// `net._http_response`, while `cron.job_run_details` reported every run as
// succeeded, because queueing the HTTP call IS the success it reports.
//
// Two rules, both about the same idea — a missing credential must fail, never
// degrade into a valid-looking wrong one:
//
//   1. No COALESCE(..., '') around a secret used in an Authorization header.
//   2. A cron command that POSTS TO A /hooks/ PATH must read the secret from
//      the vault, and must read it INSIDE the command so each run picks up a
//      rotation instead of replaying whatever was true at install time.
//
// Rule 2 used to be gated on the command mentioning `Authorization`, and that
// is how it missed SIX workers — including both halves of the cloning engine.
// They build the header into a variable first and pass it through format(%L):
//
//     v_headers := jsonb_build_object('Authorization','Bearer ' || v_secret)::text;
//     PERFORM cron.schedule('backend-provisioning-drain-1min', '* * * * *',
//       format($f$SELECT net.http_post(url:='…/hooks/backend-provisioning-drain',
//         headers:=%L::jsonb, body:='{}'::jsonb)$f$, v_headers));
//
// The scheduled command contains neither the word `Authorization` nor the
// vault, so the check skipped it entirely — and the same `%L` is the "baked at
// install" fault this file exists to catch, one indirection further out.
//
// It also carried a worse consequence than a bad credential. Reading the secret
// early means DECIDING on it early, and every one of those six migrations does:
//
//     IF v_secret IS NULL THEN
//       RAISE NOTICE 'Vault entry cron_secret not found; skipping … schedule.';
//       RETURN;
//     END IF;
//
// The vault was empty when they ran. Six workers were never scheduled, the
// migrations recorded as applied, and a NOTICE nobody reads was the only trace.
// Gating on the /hooks/ path rather than on the header dissolves both faults at
// once, because a command that reads the vault at RUN time has no reason to
// read it at INSTALL time — so there is nothing left to make the schedule
// conditional on. A missing secret then fails the way it should: a 401 in
// `net._http_response`. Read it THERE: `cron_delivery_health()` joins a run to a
// response through `return_message`, which pg_cron sets to `"1 row"` for a
// `SELECT net.http_post(...)` rather than to the request id, so its
// `last_http_status` is NULL for every job. Measured 26 Aug 2026.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Only the EFFECTIVE scheduling of a job matters. Migrations are a history:
// several of these job names were first installed with this exact defect and
// rescheduled correctly by a later migration, and on a replay from zero the
// last writer wins. Flagging the superseded ones would fail CI on a corpus
// whose end state is correct — and a guard that reports a contradiction on
// correct code is one people learn to silence.
const lastSchedule = new Map(); // jobname -> { file, body }
const rawFindings = [];

for (const file of files) {
  const sql = readFileSync(join(DIR, file), "utf8");
  // Comments explain the defect; they are not the defect.
  const code = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  // A secret coalesced to the empty string next to a Bearer header, anywhere.
  for (const m of code.matchAll(/'Bearer\s*'\s*\|\|\s*(?:COALESCE|coalesce)\([^)]*,\s*''\s*\)/g)) {
    rawFindings.push({
      file,
      scope: "any",
      why: "Bearer built with COALESCE(..., '') — a missing secret becomes an empty one",
      snippet: m[0].replace(/\s+/g, " ").slice(0, 100),
    });
  }

  // A literally empty bearer written straight into a header object.
  for (const m of code.matchAll(/"Authorization"\s*:\s*"Bearer\s*"/gi)) {
    rawFindings.push({
      file,
      scope: "any",
      why: "Authorization header is a literal empty Bearer",
      snippet: m[0],
    });
  }

  // Record the last ACTION on each job name, in position order.
  //
  // Scheduling is not the only thing that happens to a job. A name can also be
  // RETIRED — `cron.unschedule('brand-drift-30min')` — and four names are,
  // because production runs them under different names and the corpus scheduled
  // both. Judging the credential of a job the corpus goes on to delete reports a
  // defect on correct code, which is how a guard earns the reputation that gets
  // it silenced. So the last action wins, and only a name still SCHEDULED at the
  // end of the corpus is judged.
  const actions = [];
  for (const m of code.matchAll(/cron\.schedule\s*\(\s*'([^']+)'([\s\S]*?)\)\s*;/g)) {
    actions.push({ at: m.index, name: m[1], kind: "schedule", body: m[2] });
  }
  for (const m of code.matchAll(/cron\.unschedule\s*\(\s*'([^']+)'/g)) {
    actions.push({ at: m.index, name: m[1], kind: "unschedule" });
  }
  // Within one file a canonical block unschedules the name and then schedules
  // it again, so position decides — not which regex ran first.
  actions.sort((a, b) => a.at - b.at);
  for (const a of actions) {
    if (a.kind === "schedule") lastSchedule.set(a.name, { file, body: a.body });
    else lastSchedule.delete(a.name);
  }
}

const findings = [];

// The COALESCE / empty-bearer rules apply to whichever migration STILL
// determines a job's command. A superseded one is history.
const effectiveFiles = new Set([...lastSchedule.values()].map((v) => v.file));
for (const f of rawFindings) {
  if (effectiveFiles.has(f.file)) findings.push(f);
}

// The one vault entry that holds the cron credential. Every scheduled job on
// this deployment reads this name; `verifyCronAuth` accepts the ENV names
// CRON_SECRET and DRIFT_REFRESH_TOKEN, which are a different namespace and are
// not vault entries. `agreements-refresh` shipped reading `DRIFT_REFRESH_TOKEN`
// FROM THE VAULT, where no such row exists, so the subselect returned NULL and
// `'Bearer ' || NULL` is NULL — the same "missing credential degrades into a
// valid-looking wrong one" this file exists to catch, one level deeper than
// COALESCE(..., '').
const CRON_VAULT_SECRET = "cron_secret";

// Posting to the lovable.app origin cannot authenticate, however good the
// token is: it 307s to the custom domain and libcurl drops `Authorization` on
// a cross-host hop. Measured — the identical body and a correct `cron_secret`
// answers 401 there and 200 on the custom domain.
const REDIRECTING_ORIGIN = "aurixa-mission-control.lovable.app";

for (const [jobname, { file, body }] of lastSchedule) {
  // Every /hooks/ endpoint is behind verifyCronAuth, so a job that posts to one
  // needs a credential whether or not the word appears in the command text.
  // Asking about the PATH rather than the header is what catches a header
  // hidden behind format(%L).
  if (!/\/hooks\//.test(body)) continue;

  if (body.includes(REDIRECTING_ORIGIN)) {
    findings.push({
      file,
      why:
        `'${jobname}' posts to ${REDIRECTING_ORIGIN}, which 307s to the custom domain — ` +
        `libcurl drops Authorization across hosts, so the request always arrives ` +
        `unauthenticated`,
      snippet: body.replace(/\s+/g, " ").slice(0, 120),
    });
  }

  // A vault name the deployment does not hold reads as NULL, not as an error.
  for (const m of body.matchAll(/decrypted_secrets\s+WHERE\s+name\s*=\s*'([^']+)'/gi)) {
    if (m[1] !== CRON_VAULT_SECRET) {
      findings.push({
        file,
        why:
          `'${jobname}' reads vault entry '${m[1]}' for its credential; the cron secret ` +
          `is '${CRON_VAULT_SECRET}'. A name the vault does not hold yields NULL, and ` +
          `'Bearer ' || NULL is a null header rather than a failure`,
        snippet: m[0],
      });
    }
  }

  if (/vault\.decrypted_secrets/i.test(body)) continue;
  const interpolated = /%L/.test(body);
  findings.push({
    file,
    why:
      `the effective scheduling of '${jobname}' posts to a /hooks/ path without reading ` +
      `vault.decrypted_secrets inside the command` +
      (interpolated
        ? " — its headers are interpolated with format(%L), so the credential is " +
          "frozen at install time and the schedule is conditional on the secret " +
          "already existing"
        : ""),
    snippet: body.replace(/\s+/g, " ").slice(0, 120),
  });
}

if (findings.length) {
  console.error("Scheduled jobs must not be able to send an empty credential.\n");
  for (const f of findings) {
    console.error(`  ${f.file}\n    ${f.why}\n    ${f.snippet}\n`);
  }
  console.error(
    "Build the header inside the command as:\n" +
      "  'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)",
  );
  process.exit(1);
}

console.log(`check:cron-auth — ${files.length} migrations, no job can send an empty credential`);
