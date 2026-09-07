/**
 * What a migration CLAIMS it did, in a form a machine can check.
 *
 * ## Why this exists
 *
 * `supabase_migrations.schema_migrations` cannot answer "has this migration
 * been applied?" on this deployment. Measured: **40 of 210** repo versions
 * appear in it, and **103** ledger rows correspond to no repo file at all —
 * Lovable stamps its own apply timestamps, so the repo and the ledger are two
 * namespaces that barely overlap. `docs/MIGRATION_PIPELINE.md` records the same
 * split from the other side.
 *
 * So the ledger is a record of *what ran*, not of *what is true*. This module
 * lets each migration state what should be true once it has run, and something
 * else go and look.
 *
 * ## Why it is worth doing even with the queue-and-drain in place
 *
 * A drain tells you a migration executed without error. It cannot tell you the
 * migration did what its author intended — a `DO $$ … EXCEPTION WHEN OTHERS
 * THEN NULL $$` block "succeeds" having done nothing, and this corpus contains
 * that shape. An assertion is checked against the database's actual catalog, so
 * it catches the migration that ran and quietly achieved nothing.
 *
 * It also answers the 67-file backlog on day one, at zero privilege: PostgREST
 * distinguishes an absent table (`PGRST205`) from one that exists but is
 * forbidden (`42501`), so existence is observable without any new grant.
 *
 * ## The grammar
 *
 * One claim per line, in a leading `--` comment, anywhere in the file:
 *
 *     -- @asserts table:clone_reference_syncs
 *     -- @asserts column:clone_backends.reference_sync_started_at
 *     -- @asserts rpc:cron_delivery_health
 *     -- @asserts cron:reference-data-sync-hourly
 *     -- @asserts rows:mirror_exclusions>=17
 *     -- @asserts enum:clone_backend_status
 *     -- @asserts check:clone_backend_secrets.status=withheld
 *     -- @asserts none:documentation only — creates no object
 *
 * `none` is deliberately available and deliberately requires a reason. A
 * migration that genuinely asserts nothing (a comment change, a data backfill
 * whose row count is not stable) must say so in words rather than be silently
 * exempt, because "no assertion" and "nobody wrote one" have to look different.
 */

export type AssertionKind =
  | "table"
  | "column"
  | "rpc"
  | "cron"
  | "rows"
  | "enum"
  | "check"
  | "none";

export type Assertion =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "rpc"; fn: string }
  | { kind: "cron"; jobname: string }
  | { kind: "rows"; table: string; atLeast: number }
  | { kind: "enum"; type: string }
  /**
   * A CHECK constraint on `<table>.<column>` admits `<value>`.
   *
   * Widening a CHECK creates no object, so `table`/`column` cannot express it
   * and `none` would be a false claim — the migration plainly makes something
   * true. A value the column refuses is rejected by Postgres while looking,
   * from the code that tried to write it, exactly like a write nobody
   * attempted; that is a defect this platform has already paid for on a
   * `reminder_type` column. Declared and not probed, like `enum`.
   */
  | { kind: "check"; table: string; column: string; value: string }
  | { kind: "none"; reason: string };

export type ParseResult = { ok: true; assertions: Assertion[] } | { ok: false; errors: string[] };

/** Matches a leading-comment assertion line. */
const LINE = /^\s*--\s*@asserts\s+(.+?)\s*$/;

const IDENT = /^[a-z_][a-z0-9_]*$/;
/** pg_cron job names are kebab-case throughout this corpus. */
const JOBNAME = /^[a-z0-9][a-z0-9-]*$/;

function bad(raw: string, why: string): string {
  return `\`@asserts ${raw}\` — ${why}`;
}

/**
 * Parse every assertion in a migration file.
 *
 * Returns an error rather than skipping a malformed line. A claim nobody can
 * parse is worse than no claim: it looks like coverage in a listing and checks
 * nothing at run time, which is the exact shape of the guard failures this
 * repository keeps finding.
 */
export function parseAssertions(sql: string): ParseResult {
  const assertions: Assertion[] = [];
  const errors: string[] = [];

  for (const line of sql.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const raw = m[1];
    const sep = raw.indexOf(":");
    if (sep < 1) {
      errors.push(bad(raw, "expected `<kind>:<target>`"));
      continue;
    }
    const kind = raw.slice(0, sep).trim().toLowerCase();
    const target = raw.slice(sep + 1).trim();
    if (!target) {
      errors.push(bad(raw, "has no target"));
      continue;
    }

    switch (kind) {
      case "table": {
        if (!IDENT.test(target))
          errors.push(bad(raw, "table must be a bare lower_snake identifier"));
        else assertions.push({ kind: "table", table: target });
        break;
      }
      case "column": {
        const dot = target.indexOf(".");
        const t = target.slice(0, dot);
        const c = target.slice(dot + 1);
        if (dot < 1 || !IDENT.test(t) || !IDENT.test(c)) {
          errors.push(bad(raw, "expected `column:<table>.<column>`"));
        } else assertions.push({ kind: "column", table: t, column: c });
        break;
      }
      case "rpc": {
        // Tolerate a written-out signature; only the name is checkable.
        const name = target.replace(/\(.*$/, "").trim();
        if (!IDENT.test(name)) errors.push(bad(raw, "rpc must be a bare function name"));
        else assertions.push({ kind: "rpc", fn: name });
        break;
      }
      case "cron": {
        if (!JOBNAME.test(target)) errors.push(bad(raw, "cron must be a kebab-case job name"));
        else assertions.push({ kind: "cron", jobname: target });
        break;
      }
      case "rows": {
        const rm = /^([a-z_][a-z0-9_]*)\s*>=\s*(\d+)$/.exec(target);
        if (!rm) errors.push(bad(raw, "expected `rows:<table>>=<n>`"));
        else assertions.push({ kind: "rows", table: rm[1], atLeast: Number(rm[2]) });
        break;
      }
      case "enum": {
        if (!IDENT.test(target)) errors.push(bad(raw, "enum must be a bare type name"));
        else assertions.push({ kind: "enum", type: target });
        break;
      }
      case "check": {
        const cm = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)=(.+)$/.exec(target);
        if (!cm || cm[3].trim().length === 0) {
          errors.push(bad(raw, "expected `check:<table>.<column>=<value>`"));
        } else {
          assertions.push({ kind: "check", table: cm[1], column: cm[2], value: cm[3].trim() });
        }
        break;
      }
      case "none": {
        // A reason, not a token. Short reasons are how `none` becomes a rubber
        // stamp, so require enough words to be an actual explanation.
        if (target.length < 12) errors.push(bad(raw, "`none` needs a reason, not a word"));
        else assertions.push({ kind: "none", reason: target });
        break;
      }
      default:
        errors.push(
          bad(raw, `unknown kind \`${kind}\` (table, column, rpc, cron, rows, enum, check, none)`),
        );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, assertions };
}

/**
 * A migration with no assertion at all.
 *
 * Kept separate from a parse error so the CI guard can treat "you wrote it
 * wrong" and "you did not write one" differently — the first is a typo, the
 * second is a policy decision about a file somebody just added.
 */
export function hasAnyAssertion(sql: string): boolean {
  return sql.split(/\r?\n/).some((l) => LINE.test(l));
}

/** Render an assertion back to its source form, for messages and manifests. */
export function formatAssertion(a: Assertion): string {
  switch (a.kind) {
    case "table":
      return `table:${a.table}`;
    case "column":
      return `column:${a.table}.${a.column}`;
    case "rpc":
      return `rpc:${a.fn}`;
    case "cron":
      return `cron:${a.jobname}`;
    case "rows":
      return `rows:${a.table}>=${a.atLeast}`;
    case "enum":
      return `enum:${a.type}`;
    case "check":
      return `check:${a.table}.${a.column}=${a.value}`;
    case "none":
      return `none:${a.reason}`;
  }
}

/**
 * Is this assertion answerable without any privilege beyond reading the
 * catalog through PostgREST?
 *
 * `cron` and `enum` are not: `cron.job` lives in a schema PostgREST does not
 * expose (it answers `PGRST106`), and `pg_type` likewise. Those need the
 * service-role client or the `cron_delivery_health` helper, so CI — which has
 * only the publishable key — reports them as `unassertable` rather than
 * guessing. Saying "I could not check this" is the whole point of the
 * distinction; a checker that silently drops what it cannot see reports
 * coverage it does not have.
 */
export function isPubliclyCheckable(a: Assertion): boolean {
  return a.kind === "table" || a.kind === "column" || a.kind === "rpc" || a.kind === "rows";
}
