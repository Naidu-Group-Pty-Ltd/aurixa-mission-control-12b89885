#!/usr/bin/env node
// A migration that has already RUN must not change in the repository.
//
// `schema_migration_queue.sha256` has been written since the first version of
// the queue, and its own comment says it exists "so what RAN can be compared to
// the repo". Nothing ever compared it. Measured 12 Sep 2026: 2 of 55 settled
// rows already differed from their repository file and no surface said so.
//
// ## Why this check is offline
//
// The digests live in Mission Control's database, which this repository cannot
// reach — no service-role key, no direct database URL, Management API 403 (see
// `docs/MIGRATION_AUTOMATION_OPTIONS.md`). Reaching it needs `CRON_SECRET`, the
// credential that authenticates 32 scheduled workers AND the endpoint that
// executes SQL as `postgres`.
//
// Putting that credential into `ci.yml` — which runs on every pull request —
// to power a read-only comparison would widen what a CI run can do far past
// what the check is worth. So the digests travel as a committed manifest
// instead, `scripts/applied-migration-digests.txt`, and this check is pure:
// no network, no credential, runs on every pull request.
//
// The manifest cannot go stale unnoticed, because `apply-migrations.yml` —
// which already holds the credential and already talks to the queue — verifies
// it against the live table on every migration push.
//
// ## What it judges, and what it does not
//
// Only versions the manifest NAMES. A migration the queue has not settled is
// not in it and is not judged; a migration added in this very pull request is
// not in it either, and judging it would be judging a file against a row that
// does not exist yet.
//
// It compares BYTES. Not statements — see `applied-digest-baseline.txt` for why
// a comment-aware comparison is the wrong tool here.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "supabase/migrations";
const MANIFEST = "scripts/applied-migration-digests.txt";
const BASELINE = "scripts/applied-digest-baseline.txt";

const stripComment = (l) => l.replace(/#.*$/, "").trim();

if (!existsSync(MANIFEST)) {
  console.error(
    `\n✗ ${MANIFEST} is missing.\n\n` +
      `  It records the digest of the SQL each settled migration actually ran.\n` +
      `  Regenerate it with \`npm run migrations:digests\`.\n`,
  );
  process.exit(1);
}

const entries = [];
const malformed = [];
for (const raw of readFileSync(MANIFEST, "utf8").split("\n")) {
  const line = stripComment(raw);
  if (!line) continue;
  const m = /^(\d{14})\s+([0-9a-f]{64})\s+(\S.*)$/.exec(line);
  if (!m) {
    malformed.push(raw.trim());
    continue;
  }
  entries.push({ version: m[1], sha256: m[2], name: m[3].trim() });
}

// A line this cannot parse is a hard failure rather than a skip. A manifest
// that silently drops what it cannot read reports coverage it does not have —
// which is the shape of every guard in this repository that had to be fixed
// twice.
if (malformed.length > 0) {
  console.error(`\n✗ ${MANIFEST} has ${malformed.length} line(s) this cannot read:\n`);
  for (const l of malformed.slice(0, 10)) console.error(`  • ${l}`);
  console.error(`\n  Expected \`<14-digit version>  <64-hex sha256>  <filename>\`.`);
  console.error(`  It is generated — regenerate with \`npm run migrations:digests\`.\n`);
  process.exit(1);
}

const baseline = new Set();
if (existsSync(BASELINE)) {
  for (const raw of readFileSync(BASELINE, "utf8").split("\n")) {
    const v = stripComment(raw);
    if (v) baseline.add(v);
  }
}

const drifted = [];
const absent = [];
const staleBaseline = [];
let matched = 0;

for (const e of entries) {
  const path = join(MIGRATIONS, e.name);
  if (!existsSync(path)) {
    // A migration that RAN and whose file is gone. Not drift — the repository
    // no longer describes the schema at all for that version.
    absent.push(e);
    continue;
  }
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual === e.sha256) {
    matched += 1;
    // An exemption for a file that now matches is spent, and leaving it would
    // silently re-arm for the next edit of that same file.
    if (baseline.has(e.version)) staleBaseline.push(e);
  } else if (!baseline.has(e.version)) {
    drifted.push({ ...e, actual });
  }
}

let failed = false;

if (drifted.length > 0) {
  failed = true;
  console.error(`\n✗ ${drifted.length} migration(s) changed after they were applied:\n`);
  for (const d of drifted) {
    console.error(`  • ${MIGRATIONS}/${d.name}`);
    console.error(`      ran   ${d.sha256}`);
    console.error(`      repo  ${d.actual}`);
  }
  console.error(
    `\n  The database is unaffected — it already ran what it ran. What is lost is\n` +
      `  the repository's claim to describe the schema.\n\n` +
      `  NEVER rewrite the queue's copy, which is history. Either put the file\n` +
      `  back to what ran, or carry the change in a NEW migration.\n`,
  );
}

if (absent.length > 0) {
  failed = true;
  console.error(`\n✗ ${absent.length} migration(s) ran here but no longer exist in the repo:\n`);
  for (const a of absent) console.error(`  • ${MIGRATIONS}/${a.name}  (version ${a.version})`);
  console.error(
    `\n  A deleted migration cannot be un-applied. Restore the file; the record of\n` +
      `  what ran is not the repository's to discard.\n`,
  );
}

if (staleBaseline.length > 0) {
  failed = true;
  console.error(`\n✗ ${staleBaseline.length} baseline entr(y/ies) no longer needed:\n`);
  for (const s of staleBaseline) console.error(`  • ${s.version}  (${s.name} now matches)`);
  console.error(
    `\n  Remove them from ${BASELINE}. An exemption left on a file that matches\n` +
      `  re-arms silently the next time that file is edited.\n`,
  );
}

if (failed) process.exit(1);

const exempt = entries.filter((e) => baseline.has(e.version)).length;
console.log(
  `check:applied-digests — ${matched} of ${entries.length} settled migration(s) byte-identical ` +
    `to what ran${exempt > 0 ? `, ${exempt} baselined` : ""}.`,
);
