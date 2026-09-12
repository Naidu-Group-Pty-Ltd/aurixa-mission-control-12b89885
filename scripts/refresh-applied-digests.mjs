#!/usr/bin/env node
// Read what the queue actually ran, and either write the manifest or verify it.
//
//     node scripts/refresh-applied-digests.mjs            # rewrite the manifest
//     node scripts/refresh-applied-digests.mjs --check    # verify it, write nothing
//
// The digests live in Mission Control's database, which this repository cannot
// reach directly — no service-role key, no direct database URL, Management API
// 403. So this asks the application, through the same `/hooks/migration-enqueue`
// endpoint the apply workflow already posts to, using the same credential it
// already holds. The `digests` action is read-only.
//
// ## Why `--check` runs in the apply workflow and not in `ci.yml`
//
// `CRON_SECRET` authenticates 32 scheduled workers and the endpoint that
// executes SQL as `postgres`. `apply-migrations.yml` already holds it because
// it cannot do its job without it. `ci.yml` holds no secrets at all and runs on
// every pull request; putting this credential there to power a read-only
// comparison would widen what a CI run can do far past what the check is worth.
//
// The offline half — `check-applied-digests.mjs` — is what runs on every pull
// request, against the committed manifest. This is what stops that manifest
// drifting from the live table unnoticed.
import { readFileSync, writeFileSync } from "node:fs";

const MANIFEST = "scripts/applied-migration-digests.txt";
const CHECK = process.argv.includes("--check");

const BASE = (process.env.MISSION_CONTROL_URL || "").trim().replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET || "";

const fail = (title, msg) => {
  console.error(`::error title=${title}::${msg}`);
  process.exit(1);
};

if (!BASE) {
  fail(
    "Mission Control URL not set",
    "MISSION_CONTROL_URL is empty. It is deliberately not defaulted: a wrong origin " +
      "would ask somebody else's deployment what it has applied.",
  );
}
if (!SECRET) {
  fail(
    "CRON_SECRET not set",
    "The repository secret CRON_SECRET is empty. It must hold the SAME value as the " +
      "`cron_secret` entry in Mission Control's Supabase Vault.",
  );
}

let res;
try {
  res = await fetch(`${BASE}/hooks/migration-enqueue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ action: "digests" }),
  });
} catch (e) {
  fail("Could not reach Mission Control", `${e.message}. Nothing was written.`);
}

if (res.status === 401) {
  fail(
    "Rejected by Mission Control",
    "401 Unauthorized. CRON_SECRET does not match the value Mission Control checks. Do NOT " +
      "guess it: the same value authenticates 32 scheduled jobs.",
  );
}

let body = null;
try {
  body = await res.json();
} catch {
  /* reported by status alone */
}
if (res.status !== 200 || !Array.isArray(body?.digests)) {
  fail("Could not read digests", `HTTP ${res.status}: ${body?.error ?? "no digest list in body"}.`);
}

const live = body.digests;

// An empty answer is refused rather than written. Every settled row carries a
// digest today (56 of 56), so zero means the read went wrong — and writing it
// would erase the whole manifest and turn the offline check into a no-op that
// reports success. This repository has shipped a "confident clear against
// nothing" once already.
if (live.length === 0) {
  fail(
    "Refusing an empty digest list",
    "Mission Control reported no settled migrations at all. That is not a state this queue " +
      "can be in, so it is treated as a failed read rather than written over the manifest.",
  );
}

const HEADER = readFileSync(MANIFEST, "utf8")
  .split("\n")
  .filter((l) => l.startsWith("#") || l.trim() === "")
  .join("\n")
  .replace(/\n+$/, "\n");

const rendered =
  HEADER +
  live
    .slice()
    .sort((a, b) => a.version.localeCompare(b.version))
    .map((d) => `${d.version}  ${d.sha256}  ${d.name}`)
    .join("\n") +
  "\n";

if (!CHECK) {
  writeFileSync(MANIFEST, rendered);
  console.log(`✓ Wrote ${MANIFEST}: ${live.length} settled migration(s).`);
  process.exit(0);
}

// --check. Parse what is committed and compare it to the live table.
const committed = new Map();
for (const raw of readFileSync(MANIFEST, "utf8").split("\n")) {
  const line = raw.replace(/#.*$/, "").trim();
  if (!line) continue;
  const m = /^(\d{14})\s+([0-9a-f]{64})\s+(\S.*)$/.exec(line);
  if (m) committed.set(m[1], { sha256: m[2], name: m[3].trim() });
}

const byVersion = new Map(live.map((d) => [d.version, d]));

const contradicted = [];
const fabricated = [];
for (const [version, entry] of committed) {
  const actual = byVersion.get(version);
  if (!actual) {
    fabricated.push({ version, ...entry });
  } else if (actual.sha256 !== entry.sha256) {
    contradicted.push({ version, committed: entry.sha256, live: actual.sha256, name: entry.name });
  }
}
const behind = live.filter((d) => !committed.has(d.version));

let bad = false;

if (contradicted.length > 0) {
  bad = true;
  console.error(`\n✗ ${contradicted.length} manifest entr(y/ies) disagree with the live queue:\n`);
  for (const c of contradicted) {
    console.error(`  • ${c.version}  ${c.name}`);
    console.error(`      manifest  ${c.committed}`);
    console.error(`      queue     ${c.live}`);
  }
  console.error(
    `\n  The manifest is GENERATED. A hand edit here would make the offline check\n` +
      `  pass against a digest nothing ever ran. Regenerate it:\n` +
      `      npm run migrations:digests\n`,
  );
}

if (fabricated.length > 0) {
  bad = true;
  console.error(`\n✗ ${fabricated.length} manifest entr(y/ies) name a version the queue has not settled:\n`);
  for (const f of fabricated) console.error(`  • ${f.version}  ${f.name}`);
  console.error(
    `\n  An entry for a version that never ran creates a false pass in the offline\n` +
      `  check. Regenerate the manifest: npm run migrations:digests\n`,
  );
}

if (bad) process.exit(1);

// NOT fatal, and it cannot be. A migration's digest exists only once it has
// run, so the manifest is always behind by whatever this push just applied.
// Saying so is the honest reading; failing on it would make every migration
// push red for a file it was impossible to have committed.
if (behind.length > 0) {
  const names = behind.map((d) => d.version).join(", ");
  console.log(
    `::notice title=Digest manifest is behind::${behind.length} settled migration(s) are not yet ` +
      `in ${MANIFEST} (${names}). They are unguarded by check:applied-digests until somebody runs ` +
      `\`npm run migrations:digests\` and commits it.`,
  );
}

console.log(
  `✓ ${MANIFEST} agrees with the live queue on all ${committed.size} entr(y/ies)` +
    `${behind.length > 0 ? `; ${behind.length} settled version(s) not yet recorded` : ""}.`,
);
