#!/usr/bin/env node
// Every `/hooks/*` route must be scheduled, or declared as something else.
//
// A worker nobody calls produces no error anywhere. The endpoint is present, it
// is guarded, it passes typecheck and lint, its tests pass — and the queue it
// drains simply never drains. Nothing in the application can tell you: there is
// no failing request to log, because there is no request.
//
// Six of them were in that state when this check was written —
// api-usage-settle, edge-drain, edge-drift, handoff-observability-poll,
// handoff-parity-refresh and drift-refresh — every one of which opens its own
// file by stating the cron cadence that did not exist. `api-usage-settle`
// closes billing periods and pushes charges to Stripe.
//
// So the rule is that a hook is either scheduled in a migration or written down
// here as driven by something else. Both halves are checked, because an entry
// that goes stale is how the list stops meaning anything.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "supabase/migrations";
const ROUTES = "src/routes";

// Hooks that are correctly NOT on a timer, and what drives them instead.
const NOT_SCHEDULED = new Map([
  ["github", "GitHub webhook receiver — fires on repository events."],
  [
    "vercel",
    "Vercel webhook receiver — fires on deployment events. The reconciliation " +
      "sweep it backs up lives inside /hooks/deployment-drain, which IS scheduled, " +
      "because a webhook that was never delivered leaves no trace anywhere.",
  ],
  [
    "migration-enqueue",
    "Called by .github/workflows/apply-migrations.yml on merge, not by a timer. " +
      "It appends to public.schema_migration_queue; what IS scheduled is the " +
      "`schema-migration-drain` pg_cron job that empties it, which calls SQL " +
      "directly rather than an endpoint. A timer here would enqueue nothing, " +
      "because there is nothing to enqueue until a merge happens.",
  ],
  [
    "backend-provisioning-retry",
    "Invoked on demand (cron-secret bearer) to re-queue a FAILED clone backend " +
      "— an operator's decision or a deliberate automation, never a schedule: " +
      "an automatic retry loop on a failed provisioning is how a systemic " +
      "fault burns Supabase project slots unattended. What IS scheduled is " +
      "/hooks/backend-provisioning-drain, which works whatever this re-queues.",
  ],
  [
    "backend-provisioning-repair",
    "The retry hook's mirror: invoked on demand (cron-secret bearer) to converge " +
      "an already-READY clone backend onto the engine as it now stands, after a " +
      "fix that the clone was provisioned before. Never a schedule, for a " +
      "stronger reason than retry's: a repair spends vendor calls against a " +
      "LIVE tenant's project, so it happens because somebody decided it should. " +
      "What IS scheduled is /hooks/backend-provisioning-drain, which works the " +
      "pass this queues exactly as it works any other.",
  ],
]);

const hooks = readdirSync(ROUTES)
  .filter((f) => /^hooks\.[a-z0-9-]+\.tsx?$/.test(f))
  .map((f) => f.replace(/^hooks\./, "").replace(/\.tsx?$/, ""))
  .sort();

const migrationFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ name: f, body: readFileSync(join(MIGRATIONS, f), "utf8") }));

// A hook counts as scheduled when a migration names its path.
//
// Two forms, and the second is scanned PER FILE rather than across the joined
// corpus. `20260820140000_schedule_orphan_hook_workers.sql` builds its URL as
// `v_base || '/hooks/' || j.hook`, so the hook name only ever appears as a bare
// quoted string in a VALUES row — which means the scan has to accept bare
// strings, which means it will also accept any other quoted string in any other
// migration. Scoping it to files that actually construct a `/hooks/` URL is what
// keeps `coalesce(v_dep.provider_slug, 'vercel')` in an unrelated trigger from
// declaring /hooks/vercel scheduled by a migration that says nothing about it —
// a guard that reports a contradiction on correct code is one people learn to
// silence.
//
// Comments are stripped first, and that is not tidiness. A migration that
// EXPLAINS why something exists routinely names a hook path in prose --
// `20260826040000` opens by describing what `/hooks/github` has been doing for
// four months -- and scanning the raw body made that sentence declare the hook
// scheduled. The contradiction then lands on a hook that is a webhook receiver
// and correctly declared not-scheduled, i.e. exactly the "guard that reports a
// contradiction on correct code" this file already warns about, one paragraph
// up. The doubled-hook scan below has always stripped comments; this one now
// does too, from the same helper, so the two cannot disagree about what counts
// as code.
const stripSqlComments = (body) =>
  body
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

const scheduled = new Set();
for (const { body } of migrationFiles) {
  const code = stripSqlComments(body);
  for (const m of code.matchAll(/\/hooks\/([a-z0-9-]+)/g)) scheduled.add(m[1]);
  if (!code.includes("'/hooks/'")) continue;
  for (const m of code.matchAll(/'([a-z0-9-]+)'\s*\)/g)) {
    if (hooks.includes(m[1])) scheduled.add(m[1]);
  }
}

// ── And exactly once ───────────────────────────────────────────────────────
//
// The other way a hook is wrong is being driven TWICE. `/hooks/brand-drift` was
// hit every 30 minutes by both `aurixa-brand-drift-scan` and `brand-drift-30min`
// — fixed in production once, and still latent in the corpus afterwards, because
// nothing compared job names to endpoints. Retiring a legacy name is also where
// a typo reintroduces it: unschedule `brand-drift-30mn`, schedule the canonical
// one, and the corpus quietly has two again.
//
// Last action wins, in position order, so a name the corpus goes on to
// unschedule does not count as driving anything.
const jobHook = new Map();
for (const { body } of migrationFiles) {
  const code = stripSqlComments(body);
  const actions = [];
  for (const m of code.matchAll(/cron\.schedule\s*\(\s*'([^']+)'([\s\S]*?)\)\s*;/g)) {
    const hook = (m[2].match(/\/hooks\/([a-z0-9-]+)/) ?? [])[1];
    if (hook) actions.push({ at: m.index, name: m[1], kind: "schedule", hook });
  }
  for (const m of code.matchAll(/cron\.unschedule\s*\(\s*'([^']+)'/g)) {
    actions.push({ at: m.index, name: m[1], kind: "unschedule" });
  }
  actions.sort((a, b) => a.at - b.at);
  for (const a of actions) {
    if (a.kind === "schedule") jobHook.set(a.name, a.hook);
    else jobHook.delete(a.name);
  }
}
const perHook = new Map();
for (const [job, hook] of jobHook) {
  if (!perHook.has(hook)) perHook.set(hook, []);
  perHook.get(hook).push(job);
}
const doubled = [...perHook.entries()].filter(([, jobs]) => jobs.length > 1);

const orphans = hooks.filter((h) => !scheduled.has(h) && !NOT_SCHEDULED.has(h));
const staleExemptions = [...NOT_SCHEDULED.keys()].filter((h) => !hooks.includes(h));
const contradictions = [...NOT_SCHEDULED.keys()].filter((h) => scheduled.has(h));

const problems = [];
if (doubled.length)
  problems.push(
    `Hook endpoints driven by more than one job:\n` +
      doubled.map(([h, jobs]) => `  • /hooks/${h} ← ${jobs.join(", ")}`).join("\n") +
      `\n  Each fires on its own schedule, so the worker runs twice as often as\n` +
      `  anything says it does. Retire the superseded name with cron.unschedule.`,
  );
if (orphans.length)
  problems.push(
    `Hook routes with no schedule:\n` +
      orphans.map((h) => `  • /hooks/${h}`).join("\n") +
      `\n  Nothing calls these, and nothing will report that. Schedule them in a\n` +
      `  migration, or add them to NOT_SCHEDULED in this script with what does\n` +
      `  drive them.`,
  );
if (staleExemptions.length)
  problems.push(
    `Declared in NOT_SCHEDULED but the route is gone:\n` +
      staleExemptions.map((h) => `  • ${h}`).join("\n"),
  );
if (contradictions.length)
  problems.push(
    `Declared as not-scheduled but a migration schedules them:\n` +
      contradictions.map((h) => `  • ${h}`).join("\n"),
  );

if (problems.length) {
  console.error("\n✖ Cron coverage\n");
  console.error(problems.join("\n\n") + "\n");
  process.exit(1);
}

console.log(
  `✓ Cron coverage: ${hooks.length} hook routes — ` +
    `${hooks.length - NOT_SCHEDULED.size} scheduled, ` +
    `${NOT_SCHEDULED.size} declared event-driven, ` +
    `${perHook.size} endpoints each driven by exactly one job.`,
);
