/**
 * What may be put on the migration queue, and what must be refused at the door.
 *
 * ## Why there is a queue at all
 *
 * Mission Control's database is a Lovable Cloud project in Lovable's Supabase
 * organisation. `get_project` answers 403 for it and Supabase's own
 * documentation is explicit: *"You won't see this project in your Supabase
 * Dashboard, and you won't have access to service role keys or direct database
 * URLs."* So the Management API path the apply-on-merge workflow was built on
 * cannot ever work here, and neither can `psql`.
 *
 * `docs/MIGRATION_AUTOMATION_OPTIONS.md` records every channel that was probed
 * and blocked. What is left is the database asking itself: a queue that
 * `service_role` may append to, drained by a `postgres`-owned pg_cron job. This
 * module is the gate on the append.
 *
 * ## Refusing at enqueue rather than at drain
 *
 * A drain failure is visible an hour later in a table. An enqueue failure is
 * visible in the merge that caused it, in CI, with the diff on screen. So
 * anything that can be judged from the text is judged here.
 *
 * The refusals are deliberately few. This is not a SQL sanitiser and cannot be
 * one — the payload is DDL that will run as `postgres`, which is the whole
 * point and the whole risk, and pretending otherwise by pattern-matching for
 * "dangerous" statements would buy nothing but false confidence. What it
 * refuses is the set of things that are certainly WRONG rather than certainly
 * DANGEROUS: an unusable identity, and a statement the drain physically cannot
 * run.
 */

/** One repository migration, as submitted. */
export type MigrationSubmission = {
  /** The 14-digit version, the only identity a migration has in the ledger. */
  version: string;
  /** The filename, e.g. `20260828030000_migration_queue.sql`. */
  name: string;
  sql: string;
};

export type Rejection = { name: string; reason: string };

export type ValidationResult = {
  accepted: MigrationSubmission[];
  rejected: Rejection[];
};

/**
 * 1 MiB per migration. The largest file in this corpus is well under 100 KiB;
 * a megabyte is room to grow and small enough that a runaway payload is refused
 * rather than parked in a table nobody reads.
 */
export const MAX_SQL_BYTES = 1024 * 1024;
/** Per request, so one merge cannot enqueue a corpus. */
export const MAX_BATCH = 50;

const VERSION = /^\d{14}$/;
const FILENAME = /^(\d{14})_(.+)\.sql$/;

/**
 * Statements the drain cannot run, because it applies a batch inside one
 * transaction.
 *
 * `CREATE INDEX CONCURRENTLY` and friends raise `25001 active sql transaction`.
 * Measured against this corpus: **0 of 211** files contain one, so refusing
 * them costs nothing today and turns a confusing drain-time failure into a
 * red merge with the offending file named.
 *
 * `VACUUM` is here for the same reason. Neither list is a security control.
 *
 * ## Transaction control is the one that actually halted the queue
 *
 * The four rules above were written from first principles and had never fired:
 * 0 of 211 files carried one. The fifth was written from an outage.
 *
 * `aurixa.drain_schema_migrations()` applies each migration with `EXECUTE`
 * inside a PL/pgSQL function, so a migration that opens its own transaction
 * raises `0A000 EXECUTE of transaction commands is not implemented`. That is
 * not a migration that fails and moves on: **a failed migration HALTS the
 * queue**, because migrations are ordered and applying N+1 over a failed N is
 * how a schema silently diverges.
 *
 * Measured 9 Sep 2026. `20260908040000_brokered_usage_is_billable` wrapped
 * itself in `BEGIN; … COMMIT;`, failed at 04:38 on 8 September, and every
 * migration merged afterwards stopped applying — **eight of them**, across
 * three pull requests, over two days, while each merge reported only that its
 * own files were "still queued". Mission Control's database simply stopped
 * moving, and the only place that said so was a red workflow nobody was
 * required to read.
 *
 * The drain already runs each migration in a transaction. A migration that
 * opens one is not asking for something it lacks; it is asking for something
 * it already has.
 *
 * `BEGIN` and `END` are matched ONLY with their semicolon, because PL/pgSQL
 * opens a block with a bare `BEGIN` and closes it with `END;` — `stripSqlComments`
 * deliberately does not understand dollar-quoting, so a rule that matched a
 * bare `BEGIN` would refuse every function body in the corpus. Measured over
 * all 258 files: this list flags exactly the six that carry real transaction
 * control and none of the function bodies.
 */
const NON_TRANSACTIONAL: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bconcurrently\b/i, what: "CONCURRENTLY" },
  { pattern: /^\s*vacuum\b/im, what: "VACUUM" },
  { pattern: /^\s*create\s+database\b/im, what: "CREATE DATABASE" },
  { pattern: /^\s*create\s+tablespace\b/im, what: "CREATE TABLESPACE" },
  // Transaction control. The semicolon is load-bearing: see above.
  { pattern: /^\s*begin\s*;/im, what: "BEGIN" },
  { pattern: /^\s*commit\s*;/im, what: "COMMIT" },
  { pattern: /^\s*rollback\s*;/im, what: "ROLLBACK" },
  { pattern: /^\s*start\s+transaction\b/im, what: "START TRANSACTION" },
  { pattern: /^\s*savepoint\b/im, what: "SAVEPOINT" },
];

/**
 * Strip SQL comments so a rule never fires on prose.
 *
 * Every guard in this repository that skipped this step went on to report a
 * contradiction about correct code — `check-cron-coverage` flagged a webhook
 * receiver because a migration's header paragraph mentioned its path. A
 * migration that EXPLAINS why it avoids `CONCURRENTLY` must not be refused for
 * saying the word.
 *
 * Deliberately conservative: it removes `--` to end of line and `/* … *\/`
 * blocks, and it does not attempt to understand dollar-quoting. A `--` inside a
 * string literal would be over-stripped, which can only make this check more
 * permissive, never less — and permissive here means the drain reports it
 * instead, which is the pre-existing behaviour rather than a new failure.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function reject(name: string, reason: string): Rejection {
  return { name, reason };
}

/**
 * Judge a batch. Every submission is judged; one bad file does not hide the
 * next one's problem, because a caller that fixes them one merge at a time is
 * a caller that spends a day on five typos.
 */
export function validateSubmissions(submissions: readonly MigrationSubmission[]): ValidationResult {
  const accepted: MigrationSubmission[] = [];
  const rejected: Rejection[] = [];

  if (submissions.length > MAX_BATCH) {
    return {
      accepted: [],
      rejected: [
        reject(
          `<batch of ${submissions.length}>`,
          `more than ${MAX_BATCH} migrations in one request; split the merge or apply by hand`,
        ),
      ],
    };
  }

  const seen = new Set<string>();

  for (const s of submissions) {
    const name = typeof s?.name === "string" ? s.name : "<unnamed>";

    const fileMatch = typeof s?.name === "string" ? FILENAME.exec(s.name) : null;
    if (!fileMatch) {
      rejected.push(reject(name, "filename must be <14-digit version>_<name>.sql"));
      continue;
    }
    if (typeof s.version !== "string" || !VERSION.test(s.version)) {
      rejected.push(reject(name, "version must be exactly 14 digits"));
      continue;
    }
    // The version is the row's identity AND the ledger's. Letting the two
    // disagree is how a file gets recorded under somebody else's identity and
    // is then skipped forever on every later replay.
    if (fileMatch[1] !== s.version) {
      rejected.push(
        reject(name, `version ${s.version} does not match the filename's ${fileMatch[1]}`),
      );
      continue;
    }
    if (seen.has(s.version)) {
      rejected.push(reject(name, `version ${s.version} appears twice in this request`));
      continue;
    }

    if (typeof s.sql !== "string" || s.sql.trim().length === 0) {
      rejected.push(reject(name, "sql is empty"));
      continue;
    }
    const bytes = new TextEncoder().encode(s.sql).length;
    if (bytes > MAX_SQL_BYTES) {
      rejected.push(reject(name, `sql is ${bytes} bytes, over the ${MAX_SQL_BYTES} limit`));
      continue;
    }

    const code = stripSqlComments(s.sql);
    const blocked = NON_TRANSACTIONAL.find((n) => n.pattern.test(code));
    if (blocked) {
      rejected.push(
        reject(
          name,
          `contains ${blocked.what}, which cannot run inside the drain's transaction. ` +
            `Apply it by hand and record the version, or split it out.`,
        ),
      );
      continue;
    }

    seen.add(s.version);
    accepted.push({ version: s.version, name: s.name, sql: s.sql });
  }

  // Applied in version order by the drain; sorting here means the queue reads
  // in the order it will run, which is the order an operator reasons about.
  accepted.sort((a, b) => a.version.localeCompare(b.version));
  return { accepted, rejected };
}

/**
 * `applied` and `failed` are terminal; `queued` and `running` are not.
 *
 * `failed` halts the queue rather than being skipped. Migrations are ordered
 * and applying N+1 after N failed is how a schema becomes something nobody can
 * reproduce — the same rule `applyPrimeMigrations` follows for a clone.
 */
export type QueueStatus = "queued" | "running" | "applied" | "failed";

export type QueueRow = {
  version: string;
  name: string;
  status: QueueStatus;
  attempts: number;
  error: string | null;
};

export type BatchVerdict = {
  /** Every named version reached a terminal state. */
  settled: boolean;
  applied: string[];
  failed: QueueRow[];
  pending: string[];
  /** Versions that are not on the queue at all. */
  missing: string[];
};

/**
 * Where a submitted batch has got to.
 *
 * `missing` is separate from `pending` on purpose. A version the queue has
 * never heard of is a lost enqueue — a different fault with a different remedy
 * from one that is merely waiting, and reporting the two as one is how a
 * caller waits out a timeout for something that was never going to arrive.
 */
export function judgeBatch(versions: readonly string[], rows: readonly QueueRow[]): BatchVerdict {
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const applied: string[] = [];
  const failed: QueueRow[] = [];
  const pending: string[] = [];
  const missing: string[] = [];

  for (const v of versions) {
    const row = byVersion.get(v);
    if (!row) {
      missing.push(v);
      continue;
    }
    if (row.status === "applied") applied.push(v);
    else if (row.status === "failed") failed.push(row);
    else pending.push(v);
  }

  return {
    settled: pending.length === 0 && missing.length === 0,
    applied,
    failed,
    pending,
    missing,
  };
}
