/**
 * Hands the migration files a merge ADDED to Mission Control, and waits for its
 * database to apply them.
 *
 * ## Why the Management API is gone
 *
 * `apply-migrations.mjs` sent this SQL to the Supabase Management API under a
 * `PROJECT_REF`. That could never have worked, and the failure message it
 * produced -- "SUPABASE_ACCESS_TOKEN is not set" -- pointed at the wrong thing.
 * Mission Control's database is a Lovable Cloud project in LOVABLE's Supabase
 * organisation:
 *
 *     list_projects (this account's Supabase auth) -> 4 projects, none of them it
 *     get_project('fgpvagejkaeqedcwvbte')          -> 403 "You do not have permission"
 *
 * confirmed by Supabase's own documentation on identifying a Lovable backend:
 * *"You won't see this project in your Supabase Dashboard, and you won't have
 * access to service role keys or direct database URLs."* No token issued to
 * this account can reach that project, so setting the secret could not have
 * helped. `psql`/`DATABASE_URL` is unavailable for the same reason.
 *
 * So the SQL goes to the application, which writes it to a queue in its own
 * database, which a `postgres`-owned pg_cron job drains within the minute.
 * docs/MIGRATION_QUEUE.md carries the design and what it costs.
 *
 * ## The target is no longer configurable
 *
 * The old script needed `FORBIDDEN_REFS` and a behavioural identity probe
 * because its token reached every project in the organisation and a wrong ref
 * did not fail -- it wrote this control plane's admin schema onto a tenant.
 * There is no ref here. The endpoint is Mission Control, and Mission Control
 * writes to the database it is connected to. That class of bug is gone rather
 * than guarded.
 *
 * ## It waits, and a failure is red
 *
 * Enqueueing is not applying. A workflow that posts and exits green would
 * reintroduce the exact silence this replaces: a migration that merged, looked
 * fine, and never ran. So it polls until every submitted version reaches
 * `applied` or `failed`, and exits non-zero on failure, on a version the queue
 * never received, and on the wait running out.
 */
import { readFileSync } from "node:fs";

const BASE = (process.env.MISSION_CONTROL_URL || "").trim().replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET || "";
const FILES = (process.env.FILES || "")
  .split(/[\s,]+/)
  .map((f) => f.trim())
  .filter(Boolean);
const RUN = process.env.RUN_URL || "";

/** Parse and report without sending, so the selection is exercised in CI. */
const DRY_RUN = process.env.DRY_RUN === "1";

/** ~5 minutes. The drain runs every minute; anything past this is a fault. */
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 10_000;

const fail = (title, msg) => {
  console.error(`::error title=${title}::${msg}`);
  process.exit(1);
};

if (FILES.length === 0) {
  console.log("No migrations to apply.");
  process.exit(0);
}

if (!DRY_RUN) {
  if (!BASE) {
    fail(
      "Mission Control URL not set",
      "MISSION_CONTROL_URL is empty. Set the repository variable MISSION_CONTROL_URL " +
        "to this deployment's public origin (e.g. https://mission-control.aurixasystems.com.au). " +
        "It is deliberately not defaulted: a wrong origin would post migration SQL to " +
        "somebody else's deployment.",
    );
  }
  if (!SECRET) {
    fail(
      "CRON_SECRET not set",
      "The repository secret CRON_SECRET is empty. It must hold the SAME value as the " +
        "`cron_secret` entry in Mission Control's Supabase Vault -- the one every scheduled " +
        "worker already authenticates with. Note this is a GITHUB secret: GitHub has no " +
        "reserved-name restriction, unlike Lovable, which refuses any name starting with " +
        "`SUPABASE_`.",
    );
  }
}

/**
 * Migrations the workflow has established were applied OUT OF BAND, by path.
 *
 * The workflow reads the git author of the commit that ADDED each file; one
 * authored by the Lovable app was applied by Lovable before it reached the
 * repository. See `RECORD_ONLY` in `apply-migrations.yml` and the measurement
 * in `20260912150000_recorded_never_replayed.sql`.
 *
 * Empty is the safe default: an unset variable means every file runs, which is
 * the behaviour that existed before this.
 */
const RECORD_ONLY = new Set(
  (process.env.RECORD_ONLY || "")
    .split(/[\s,]+/)
    .map((f) => f.trim())
    .filter(Boolean),
);

/** `20260828030000_schema_migration_queue.sql` -> its version and name. */
const submissions = [];
for (const path of FILES) {
  const name = path.split("/").pop() ?? path;
  const m = /^(\d{14})_(.+)\.sql$/.exec(name);
  if (!m) {
    fail(
      "Unversioned migration",
      `${path} has no 14-digit version, so it cannot be recorded. Rename it to ` +
        `<YYYYMMDDHHMMSS>_<name>.sql.`,
    );
  }
  let sql;
  try {
    sql = readFileSync(path, "utf8");
  } catch (e) {
    fail("Unreadable migration", `${path}: ${e.message}`);
  }
  submissions.push({ version: m[1], name, sql, alreadyApplied: RECORD_ONLY.has(path) });
}

console.log(`Submitting ${submissions.length} migration(s):`);
for (const s of submissions) {
  console.log(`  ${s.version}  ${s.name}${s.alreadyApplied ? "   [record only — applied out of band]" : ""}`);
}

if (DRY_RUN) {
  console.log("DRY_RUN=1 — parsed and validated locally, nothing sent.");
  process.exit(0);
}

const post = async (body) => {
  const res = await fetch(`${BASE}/hooks/migration-enqueue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* a non-JSON body is reported by status alone */
  }
  return { status: res.status, json };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const versions = submissions.map((s) => s.version);

const enqueue = await post({
  action: "enqueue",
  migrations: submissions,
  enqueuedBy: RUN || "github-actions",
});

if (enqueue.status === 401) {
  fail(
    "Rejected by Mission Control",
    "401 Unauthorized. CRON_SECRET does not match the `cron_secret` value Mission Control " +
      "checks. Do NOT guess it: the same value authenticates 32 scheduled jobs, and a wrong " +
      "one here means it was read from the wrong place, not that it should be changed.",
  );
}

const rejected = enqueue.json?.rejected ?? [];
if (rejected.length > 0) {
  for (const r of rejected) {
    console.error(`::error file=supabase/migrations/${r.name}::${r.reason}`);
  }
}

if (enqueue.status !== 200) {
  fail(
    "Enqueue failed",
    `HTTP ${enqueue.status}: ${enqueue.json?.error ?? "no detail"}. Nothing was applied.`,
  );
}

console.log(
  `Enqueued ${enqueue.json?.enqueued?.length ?? 0}; ` +
    `${enqueue.json?.alreadyQueued?.length ?? 0} already queued; ` +
    `${enqueue.json?.alreadyApplied?.length ?? 0} already settled.`,
);

// Poll. Enqueueing is not applying, and a green run that only proved the POST
// succeeded is the same silence this pipeline exists to remove.
let verdict = enqueue.json?.verdict ?? null;
for (let i = 0; i < POLL_ATTEMPTS && !(verdict && verdict.settled); i += 1) {
  await sleep(POLL_INTERVAL_MS);
  const status = await post({ action: "status", versions });
  if (status.status !== 200) {
    console.log(`  poll ${i + 1}/${POLL_ATTEMPTS}: HTTP ${status.status}, retrying`);
    continue;
  }
  verdict = status.json?.verdict ?? null;
  const pending = verdict?.pending?.length ?? 0;
  const applied = verdict?.applied?.length ?? 0;
  const recorded = verdict?.recorded?.length ?? 0;
  console.log(
    `  poll ${i + 1}/${POLL_ATTEMPTS}: ${applied} applied, ${recorded} recorded, ${pending} pending`,
  );
}

if (!verdict) {
  fail("No verdict", "Mission Control never returned a queue verdict. Nothing is confirmed.");
}

if (verdict.failed?.length > 0) {
  for (const f of verdict.failed) {
    console.error(
      `::error file=supabase/migrations/${f.name}::failed after ${f.attempts} attempt(s): ${f.error}`,
    );
  }
  fail(
    "Migration failed",
    `${verdict.failed.length} migration(s) failed to apply. The queue is HALTED until the ` +
      `failed row is resolved -- migrations are ordered, so nothing after them runs. Fix the ` +
      `SQL in a new migration and clear the failed row.`,
  );
}

// A version the queue never received is a lost enqueue, not a slow one. The
// remedies differ, so the report must too.
if (verdict.missing?.length > 0) {
  fail(
    "Migrations never reached the queue",
    `${verdict.missing.join(", ")} are not on the queue at all. They were accepted by the ` +
      `endpoint but no row exists, which points at the write rather than at the drain.`,
  );
}

if (!verdict.settled) {
  fail(
    "Timed out waiting for the drain",
    `${verdict.pending.join(", ")} are still queued after ${
      (POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000
    }s. The \`schema-migration-drain\` job runs every minute, so check it is scheduled and ` +
      `active: \`select jobname, active from cron.job where jobname = 'schema-migration-drain'\`. ` +
      `The migrations remain queued and will apply when it next runs.`,
  );
}

// Said separately, because they are different facts. A `recorded` version was
// stamped and NOT executed here — the submitter established it had already been
// applied out of band — and a run that printed both as "applied" would be the
// only place an operator could have learned the difference.
if (verdict.applied.length > 0) {
  console.log(`✓ Applied ${verdict.applied.length} migration(s): ${verdict.applied.join(", ")}`);
}
if (verdict.recorded?.length > 0) {
  console.log(
    `✓ Recorded ${verdict.recorded.length} migration(s) without executing them, having been ` +
      `applied out of band before they were committed: ${verdict.recorded.join(", ")}`,
  );
  console.log(
    `  Their effect is not asserted here. \`migration-drift-hourly\` checks each file's own ` +
      `\`-- @asserts\` claims against the database every hour and reports on /health.`,
  );
}
if (verdict.applied.length === 0 && !(verdict.recorded?.length > 0)) {
  console.log("✓ Nothing left to do — every submitted version was already settled.");
}
