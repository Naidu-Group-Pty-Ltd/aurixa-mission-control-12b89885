/**
 * What is wrong with ONE of the prime's migrations, and whether it may be run.
 *
 * `primeMigrationLedger.pure.ts` answers how many migrations the prime is
 * holding back. This answers the next question, which is the one an operator
 * actually has to act on: *that* one — why is it sitting there, and is it safe
 * to apply?
 *
 * ## Why it matters to the fleet and not only to the prime
 *
 * `fleetCorpusScope.pure.ts` sends a clone only what the prime's ledger
 * records, and `partitionByDependency` refuses to step over a version the
 * prime has not run. So one unrun migration on the prime is a barrier for
 * every clone behind it, and everything after it in corpus order queues up
 * behind that barrier. The backlog a clone reports is very often not the
 * clone's at all. Fixing it at the prime clears it everywhere at once, which
 * is exactly what "so clones don't suffer for it in their cascade drains"
 * describes.
 *
 * ## The layers, cheapest first, each failing on its own
 *
 * Every layer below answers independently and names itself when it could not
 * answer. None of them is inferred from another's silence.
 *
 *   1. **The name.** A `rollback_*` script is an undo, and the corpus holds
 *      two whose stated purpose is to reverse an RLS fix. Nothing may ever
 *      dispatch one of those from a console.
 *   2. **The shape.** A version carried by two files can only ever record one
 *      of them (`schema_migrations.version` is the primary key), and a body
 *      past the corpus ceiling cannot be read here at all.
 *   3. **The statements.** One blob read, scanned properly — see the scanner
 *      below — for transaction control, non-transactional DDL, destructive
 *      verbs, and statements that would fail on a second run.
 *   4. **The prime's own catalogue.** Reused from
 *      `primeLedgerReconciliation.pure.ts`: does the prime already hold the
 *      objects this file creates?
 *   5. **A rolled-back dry run** on the prime itself. The strongest evidence
 *      available, and the reason a dispatch can be offered at all.
 *
 * ## The one rule the whole feature rests on
 *
 * **A body carrying transaction control may never be dry-run.** The dry run is
 * `BEGIN; … ROLLBACK;`, and a `COMMIT;` inside the body would end that
 * transaction and make everything before it permanent — a "test" that writes
 * to the prime's production database. So the scan gates the run, not the other
 * way round, and it is the one hazard that stops the diagnosis rather than
 * annotating it.
 *
 * Measured over the prime's 1,002 migration files on 20 Sep 2026:
 *
 *      32  carry top-level transaction control (3.2%)
 *      16  use `ALTER TYPE … ADD VALUE` (1.6%)
 *       0  use `CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX`, `ALTER SYSTEM`
 *       0  declare a PROCEDURE, and 0 `CALL` one
 *
 * So the untestable set is under 5% of the corpus — an escape hatch rather
 * than the common case, which is what makes gating on it affordable.
 *
 * That last pair of zeroes is load-bearing and is therefore CHECKED rather
 * than assumed. A PL/pgSQL *function* cannot commit; only a *procedure*
 * invoked by `CALL` can. With neither present, stripping dollar-quoted bodies
 * before looking for transaction control is safe — and without that strip,
 * every `create function … $$ begin … end $$` in the repository would read as
 * a transaction and the feature would refuse nearly everything. `CREATE
 * PROCEDURE` and `CALL` are their own hazard here precisely so the day the
 * corpus gains one, this notices rather than going quietly wrong.
 *
 * ## The asymmetry, which runs the opposite way to the reconciler's
 *
 * `primeLedgerReconciliation.pure.ts` is deliberately narrow: it would rather
 * miss a creation than invent one, because inventing one leads to a wrong
 * stamp. Here a missed hazard defeats a ROLLBACK, so this errs the other way —
 * a statement it cannot classify confidently is treated as a hazard, and the
 * cost of being wrong is one migration an operator applies by hand.
 *
 * ## What it refuses to do
 *
 * It writes nothing and it decides nothing about a clone. It says what one
 * file is, and `mayDispatch` says whether the console may offer to run it —
 * an ALLOW-list of one verdict, because "not obviously bad" is not evidence
 * and a page that offered the act on anything else would be spending the
 * prime's production database on a guess.
 */

/** A statement as it appears in the file, with comments and quoting resolved. */
export type SqlStatement = {
  /** The statement's own text, trimmed, comments removed, bodies intact. */
  text: string;
  /** 1-based line of the file the statement starts on. */
  line: number;
  /** Lower-cased leading words, for matching. Dollar-quoted bodies elided. */
  head: string;
};

export type HazardKind =
  | "transaction_control"
  | "non_transactional"
  | "enum_value_added"
  | "procedure"
  | "destructive"
  | "data_rewrite";

export type Hazard = {
  kind: HazardKind;
  /** Enough of the statement to recognise it. Never the whole body. */
  excerpt: string;
  line: number;
  /** What this means for the operator, in their words. */
  note: string;
};

/** How much of a statement is quoted back on the page. */
export const EXCERPT_CHARS = 160;

/** Hazards drawn beside a verdict, capped so one file cannot fill the page. */
export const HAZARD_ROWS = 12;

/*
  ───────────────────────────────────────────────────────────────────────────
  The scanner
  ───────────────────────────────────────────────────────────────────────────

  A regex split on `;` breaks on the first `create function … $$ begin … end $$`
  it meets, and this corpus is full of them. So this walks the text tracking
  what it is inside of: a line comment, a (nestable) block comment, a string, a
  quoted identifier, or a dollar-quoted body with its own tag.

  Postgres nests block comments, which `stripSqlComments` deliberately does not
  model — correctly, for its callers, because over-stripping there makes a
  check report rather than allow. Here over-stripping would hide a `COMMIT`,
  so the nesting is modelled.
*/

type ScanState = "code" | "line_comment" | "block_comment" | "single" | "double" | "dollar";

/** Read a dollar-quote tag at `i`, e.g. `$$` or `$body$`. Null when it is not one. */
function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1;
  return sql[j] === "$" ? sql.slice(i, j + 1) : null;
}

/**
 * Split a migration into statements.
 *
 * Exported because it is the piece everything else here trusts, and a thing
 * everything trusts is a thing that should be tested directly rather than
 * through four consumers.
 */
export function scanSqlStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let state: ScanState = "code";
  let blockDepth = 0;
  let tag = "";
  let buf = "";
  /** The buffer with dollar-quoted bodies replaced, for keyword matching. */
  let head = "";
  let line = 1;
  let startLine = 1;
  let started = false;

  const flush = () => {
    const text = buf.trim();
    if (text) {
      out.push({ text, line: startLine, head: head.trim().toLowerCase().replace(/\s+/g, " ") });
    }
    buf = "";
    head = "";
    started = false;
  };

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "\n") line += 1;

    if (state === "line_comment") {
      if (c === "\n") state = "code";
      continue;
    }

    if (state === "block_comment") {
      if (c === "/" && d === "*") {
        blockDepth += 1;
        i += 1;
        continue;
      }
      if (c === "*" && d === "/") {
        blockDepth -= 1;
        i += 1;
        if (blockDepth === 0) state = "code";
        continue;
      }
      continue;
    }

    if (state === "single" || state === "double") {
      buf += c;
      head += c;
      const quote = state === "single" ? "'" : '"';
      if (c === quote) {
        // A doubled quote is an escaped one and does not close the literal.
        if (d === quote) {
          buf += d;
          head += d;
          i += 1;
        } else {
          state = "code";
        }
      }
      continue;
    }

    if (state === "dollar") {
      buf += c;
      if (c === "$" && sql.startsWith(tag, i)) {
        buf += sql.slice(i + 1, i + tag.length);
        for (const ch of tag.slice(1)) if (ch === "\n") line += 1;
        i += tag.length - 1;
        state = "code";
        // The body never reaches `head`: a PL/pgSQL `begin` is a block opener,
        // not a transaction, and counting it would refuse most of the corpus.
        head += " $BODY$ ";
      }
      continue;
    }

    // state === "code"
    if (c === "-" && d === "-") {
      state = "line_comment";
      i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      state = "block_comment";
      blockDepth = 1;
      i += 1;
      continue;
    }
    if (c === ";") {
      flush();
      continue;
    }
    if (!started && !/\s/.test(c)) {
      started = true;
      startLine = line;
    }
    const opened = dollarTagAt(sql, i);
    if (opened) {
      state = "dollar";
      tag = opened;
      buf += opened;
      i += opened.length - 1;
      continue;
    }
    buf += c;
    head += c;
    if (c === "'") state = "single";
    else if (c === '"') state = "double";
  }
  flush();
  return out;
}

/*
  ───────────────────────────────────────────────────────────────────────────
  Hazards
  ───────────────────────────────────────────────────────────────────────────
*/

/** `drop policy` is deliberately absent — see `DESTRUCTIVE` below. */
const TRANSACTION_CONTROL = /^(begin|commit|rollback|start\s+transaction|savepoint|end)\b/;

const NON_TRANSACTIONAL: ReadonlyArray<{ re: RegExp; what: string }> = [
  {
    re: /\b(create|drop)\s+(unique\s+)?index\s+concurrently\b/,
    what: "CREATE INDEX CONCURRENTLY cannot run inside a transaction",
  },
  { re: /^vacuum\b/, what: "VACUUM cannot run inside a transaction" },
  {
    re: /^reindex\b.*\bconcurrently\b/,
    what: "REINDEX CONCURRENTLY cannot run inside a transaction",
  },
  { re: /^alter\s+system\b/, what: "ALTER SYSTEM cannot run inside a transaction" },
  {
    re: /^(create|drop)\s+database\b/,
    what: "a database cannot be created or dropped inside a transaction",
  },
  {
    re: /^(create|drop)\s+tablespace\b/,
    what: "a tablespace cannot be created or dropped inside a transaction",
  },
];

/**
 * Statements that LOSE something, and the three kinds deliberately excluded.
 *
 * Every entry here was kept or dropped on a count taken over the prime's own
 * 988 readable migration files (11,070 statements) on 20 Sep 2026, because a
 * caution that fires on a quarter of the corpus is one operators learn to
 * dismiss — the `eleven unreadable chips` failure, committed on the screen
 * that offers to run something.
 *
 * Kept, and what each is worth:
 *
 *      72 statements /  7 files   DROP TABLE / DROP SCHEMA
 *      34 statements / 21 files   DELETE FROM
 *       3 statements /  3 files   TRUNCATE
 *       3 statements /  3 files   DROP VIEW / TYPE / SEQUENCE
 *
 * — about 3% of files, which is a warning worth reading.
 *
 * Excluded, with the measurement that excluded it:
 *
 *   - **`DROP POLICY`** — 153 files. `DROP POLICY IF EXISTS x; CREATE POLICY x`
 *     is the standard idempotent RLS idiom and loses nothing.
 *   - **`DROP FUNCTION` / `DROP TRIGGER`** — 452 statements across 141 files,
 *     almost all of them drop-and-recreate in the same file. It destroys
 *     CODE, not data, and the file usually puts it straight back.
 *   - **`UPDATE`** — 257 statements across 161 files. An UPDATE with a WHERE
 *     clause is routinely idempotent by construction, and at one file in six
 *     the flag would carry no information.
 */
const DESTRUCTIVE: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /^drop\s+(table|schema)\b/, what: "drops a table or schema and everything in it" },
  { re: /^truncate\b/, what: "empties a table" },
  { re: /^delete\s+from\b/, what: "deletes rows" },
  { re: /\bdrop\s+column\b/, what: "drops a column and everything in it" },
  {
    re: /^drop\s+(materialized\s+view|view|type|sequence)\b/,
    what: "drops an object other migrations may depend on",
  },
];

/**
 * The one re-run that fails SILENTLY.
 *
 * `apply-migration.yml` runs `psql -v ON_ERROR_STOP=1 -f "$FILE"` with NO
 * `--single-transaction`, and says so in its own header: statements apply in
 * order, the run stops at the first error, and what came before it stays
 * applied. So a file that fails half way is re-dispatched over statements that
 * already ran — and that is the question this rule exists to ask.
 *
 * It asks it about INSERT alone, and the narrowing is the finding rather than
 * a shortcut. Measured over the same 11,070 statements, a general
 * "could this statement succeed twice?" rule produced **2,411 hits** — 22% of
 * every statement in the repository — of which `CREATE POLICY` alone was
 * 1,592 across 320 files. That number is unreadable and therefore useless.
 *
 * What survived the narrowing is the distinction that actually matters to an
 * operator. A second `CREATE TABLE`, `CREATE INDEX`, `CREATE POLICY` or
 * `ADD CONSTRAINT` fails LOUDLY, with `42P07`/`42710`, having changed
 * nothing — the repair is mechanical and the file cannot be silently
 * corrupted. A second unguarded `INSERT` **succeeds**, and duplicates rows.
 * That is the case `apply-migration.yml`'s own header names — "data
 * mutations … where a second application is not a no-op" — and it is 62
 * statements across 36 files, 3.6% of the corpus.
 */
const DATA_REWRITE: ReadonlyArray<{ re: RegExp; what: string }> = [
  {
    re: /^insert\s+into\b(?![\s\S]*\bon\s+conflict\b)/,
    what: "an INSERT with no ON CONFLICT clause — running it twice would duplicate rows rather than fail",
  },
];

const excerpt = (text: string) =>
  text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS - 1)}…`;

/** Every hazard in a scanned body, in file order. */
export function hazardsIn(statements: readonly SqlStatement[]): Hazard[] {
  const out: Hazard[] = [];
  const add = (s: SqlStatement, kind: HazardKind, note: string) =>
    out.push({ kind, excerpt: excerpt(s.text), line: s.line, note });

  for (const s of statements) {
    const h = s.head;
    if (TRANSACTION_CONTROL.test(h)) {
      add(
        s,
        "transaction_control",
        "the file manages its own transaction, so a rolled-back trial run cannot be trusted to roll back",
      );
      continue;
    }
    if (/^(create|drop)\s+(or\s+replace\s+)?procedure\b/.test(h) || /^call\s+/.test(h)) {
      add(s, "procedure", "a procedure can commit, which a rolled-back trial run cannot contain");
      continue;
    }
    const nt = NON_TRANSACTIONAL.find((n) => n.re.test(h));
    if (nt) {
      add(s, "non_transactional", nt.what);
      continue;
    }
    if (/^alter\s+type\b[\s\S]*\badd\s+value\b/.test(h)) {
      add(
        s,
        "enum_value_added",
        "a new enum value cannot be used until the transaction that added it has committed",
      );
      continue;
    }
    const d = DESTRUCTIVE.find((x) => x.re.test(h));
    if (d) add(s, "destructive", d.what);
    const w = DATA_REWRITE.find((x) => x.re.test(h));
    if (w) add(s, "data_rewrite", w.what);
  }
  return out;
}

/** The hazards that forbid a rolled-back trial run against the prime. */
export const UNTESTABLE_HAZARDS: ReadonlySet<HazardKind> = new Set([
  "transaction_control",
  "non_transactional",
  "enum_value_added",
  "procedure",
]);

/** True when a body may be sent to the prime wrapped in BEGIN … ROLLBACK. */
export function isSafeToDryRun(hazards: readonly Hazard[]): boolean {
  return !hazards.some((h) => UNTESTABLE_HAZARDS.has(h.kind));
}

/*
  ───────────────────────────────────────────────────────────────────────────
  The trial run's answer
  ───────────────────────────────────────────────────────────────────────────
*/

export type DryRunOutcome =
  | { ran: true; ok: true; ms: number }
  | { ran: true; ok: false; sqlstate: string | null; message: string; ms: number }
  /** Not attempted, or attempted and unable to answer. `why` is the sentence. */
  | { ran: false; why: string };

/**
 * States that mean THIS RUN ran out of patience, not that the migration is
 * wrong.
 *
 * `lock_not_available` is the `lock_timeout` the trial run sets; `query_
 * canceled` is its `statement_timeout`. Both are limits WE imposed so a trial
 * run could not sit on a production table, and reading either as "this
 * migration would fail" would be `a timeout is not evidence of absence` on the
 * one screen that offers to run something.
 */
export const DRY_RUN_INCONCLUSIVE_STATES: ReadonlySet<string> = new Set(["55P03", "57014"]);

/** Postgres codes worth translating. Anything else is shown as the server said it. */
const SQLSTATE_WORDS: Readonly<Record<string, string>> = {
  "42P07": "something it creates already exists",
  "42710": "an object it creates already exists under that name",
  "42P01": "it refers to a table that does not exist here",
  "42703": "it refers to a column that does not exist here",
  "42883": "it calls a function that does not exist here",
  "42P06": "a schema it creates already exists",
  "23505": "a row it inserts collides with one already there",
  "23503": "a row it writes has no matching parent row",
  "42501": "the credential running it lacks the privilege",
  "3F000": "it names a schema that does not exist here",
  "55P03": "it could not take a lock within the trial run's allowance",
  "57014": "it ran longer than the trial run's allowance",
};

/** The plain sentence for a SQLSTATE, or null when there is nothing to add. */
export function sqlstateWords(code: string | null): string | null {
  if (!code) return null;
  return SQLSTATE_WORDS[code.toUpperCase()] ?? null;
}

/**
 * Pull a SQLSTATE out of whatever the Management API answered with.
 *
 * `runSqlOnProject` throws with the raw response body appended, and that body
 * has been seen as JSON carrying `code`, as JSON carrying only `message`, and
 * as plain text. Rather than assume one shape, this looks for the two forms a
 * code is ever written in and answers null when it finds neither — the honest
 * result, since a verdict that invented a code would name the wrong remedy.
 *
 * `an error code is observed on the wire, never assumed from the database that
 * raises it` — the rule `isMissingRankingRelation` was rewritten under, where
 * two tests vouched for Postgres codes a PostgREST caller never sees.
 */
export function readSqlFailure(raw: string): { sqlstate: string | null; message: string } {
  const json = /"code"\s*:\s*"([0-9A-Za-z]{5})"/.exec(raw);
  const bare = /\bSQLSTATE[: ]\s*([0-9A-Za-z]{5})\b/.exec(raw);
  const sqlstate = (json?.[1] ?? bare?.[1] ?? null)?.toUpperCase() ?? null;
  const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const message = msg
    ? msg[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    : raw.trim();
  return { sqlstate, message: message.slice(0, 600) };
}

/*
  ───────────────────────────────────────────────────────────────────────────
  The verdict
  ───────────────────────────────────────────────────────────────────────────
*/

export type DiagnosisVerdict =
  | "rollback_script"
  | "version_collision"
  | "already_applied"
  | "oversized"
  | "blocked_by_prerequisite"
  | "unsafe_to_test"
  | "would_fail"
  | "ready"
  | "undiagnosed";

/**
 * The one verdict that may offer to run something.
 *
 * An ALLOW-list, the shape `payingCanUnlock` was rewritten into after a
 * deny-list answered yes to every word the build had never heard of. A verdict
 * this module gains tomorrow is refused by default, and the refusal is the
 * safe direction: withholding the shortcut never withholds the act, because
 * the prime's workflow is still there to be run by hand.
 */
export const DISPATCHABLE_VERDICTS: ReadonlySet<DiagnosisVerdict> = new Set<DiagnosisVerdict>([
  "ready",
]);

export function mayDispatch(verdict: DiagnosisVerdict): boolean {
  return DISPATCHABLE_VERDICTS.has(verdict);
}

export type DiagnosisInput = {
  meta: { id: string; name: string; path: string };
  /** Other files in the corpus carrying this same 14-digit version. */
  collidingNames: readonly string[];
  /** The prime's ledger already records this version. */
  alreadyApplied: boolean;
  /**
   * Corpus versions before this one that the prime has not run. Null when the
   * scope could not be computed — which is not the same as "none", and is
   * reported as a gap in the diagnosis rather than as a clean prerequisite
   * check.
   */
  blockedBy: readonly string[] | null;
  /** The body, or why there is not one. */
  body:
    | { read: true; sql: string; bytes: number }
    | { read: false; oversized: boolean; why: string };
  dryRun: DryRunOutcome;
  /** What the prime's live catalogue says about the objects it creates. */
  catalogue:
    | { read: true; verdict: "satisfied" | "unsatisfied" | "indeterminate"; missing: string[] }
    | { read: false; why: string }
    | null;
};

export type MigrationDiagnosis = {
  id: string;
  name: string;
  path: string;
  verdict: DiagnosisVerdict;
  /** One sentence naming what was found. Never database vocabulary. */
  headline: string;
  /** The act that discharges it, or null when there is nothing owed. */
  remedy: string | null;
  /** True only for `ready`; the page reads this and never the verdict word. */
  dispatchable: boolean;
  statementCount: number | null;
  bytes: number | null;
  hazards: Hazard[];
  /** How many hazards there are in total, because `hazards` is capped. */
  hazardCount: number;
  destructiveCount: number;
  dataRewriteCount: number;
  blockedBy: string[] | null;
  dryRun: DryRunOutcome;
  catalogueNote: string | null;
};

/** Two or more files in the corpus carrying one version. */
export type VersionCollision = { version: string; names: string[] };

/**
 * Every version the corpus carries more than once.
 *
 * `supabase_migrations.schema_migrations.version` is the PRIMARY KEY, so a
 * version written by two files can only ever record one of them. The other is
 * permanently absent from the ledger — and `fleetCorpusScope.pure.ts` withholds
 * whatever the ledger does not record, while `partitionByDependency` refuses to
 * step over it. So a collision is not untidiness: it is a hole that cannot be
 * closed by running anything, and every clone queues behind it for ever.
 *
 * Measured on the prime, 20 Sep 2026: **32 versions carried by 77 files**, so
 * 45 files cannot be recorded whatever is run. `20260717000000` is
 * `add_builder_invoice_current_payment` AND
 * `restrict_finance_portal_notification_routing` — two unrelated migrations
 * that cannot both be stamped.
 *
 * It is surveyed over the whole corpus rather than asked per file, because the
 * fleet-wide number is the one that explains a backlog nobody could clear.
 */
export function findVersionCollisions(
  metas: ReadonlyArray<{ id: string; name: string }>,
): VersionCollision[] {
  const byVersion = new Map<string, string[]>();
  for (const m of metas) {
    const seen = byVersion.get(m.id);
    if (seen) seen.push(m.name);
    else byVersion.set(m.id, [m.name]);
  }
  const out: VersionCollision[] = [];
  for (const [version, names] of byVersion) {
    if (names.length > 1) out.push({ version, names: [...names].sort() });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version));
}

/** `…_rollback_…` / `…_revert_…` / `…_undo_…` anywhere in the filename. */
export function isRollbackScript(name: string): boolean {
  return /(^|[_-])(rollback|revert|undo)([_-]|\.)/i.test(name);
}

const listVersions = (v: readonly string[]) =>
  v.length <= 3 ? v.join(", ") : `${v.slice(0, 3).join(", ")} and ${v.length - 3} more`;

/**
 * The whole judgement, in one place, in a fixed order.
 *
 * The order is not arbitrary. A refusal about the FILE outranks a refusal
 * about the database, because a file that must never run is not made runnable
 * by a database that would accept it; and a cheap certain refusal outranks an
 * expensive uncertain one, so nothing below is ever attributed to the wrong
 * cause. `blocked_by_prerequisite` sits above the trial run for that reason
 * alone: a body that fails because the migration BEFORE it never ran would be
 * reported as this file's fault, which is the mistake
 * `assertAcquisitionAnswered` was written to stop one level up.
 */
export function diagnoseMigration(input: DiagnosisInput): MigrationDiagnosis {
  const { meta } = input;
  const base = {
    id: meta.id,
    name: meta.name,
    path: meta.path,
    blockedBy: input.blockedBy === null ? null : [...input.blockedBy],
    dryRun: input.dryRun,
  };

  const statements = input.body.read ? scanSqlStatements(input.body.sql) : null;
  const all = statements ? hazardsIn(statements) : [];
  const shaped = {
    ...base,
    statementCount: statements ? statements.length : null,
    bytes: input.body.read ? input.body.bytes : null,
    hazards: all.slice(0, HAZARD_ROWS),
    hazardCount: all.length,
    destructiveCount: all.filter((h) => h.kind === "destructive").length,
    dataRewriteCount: all.filter((h) => h.kind === "data_rewrite").length,
    catalogueNote: catalogueNote(input.catalogue),
  };

  const settle = (
    verdict: DiagnosisVerdict,
    headline: string,
    remedy: string | null,
  ): MigrationDiagnosis => ({
    ...shaped,
    verdict,
    headline,
    remedy,
    dispatchable: mayDispatch(verdict),
  });

  // 1. The name. Never runnable from here, whatever anything else says.
  if (isRollbackScript(meta.name)) {
    return settle(
      "rollback_script",
      "This file is named as an undo. It is withheld on purpose and must never be applied from a console.",
      "If it genuinely needs to run, do it by hand with the author of the change it reverses.",
    );
  }

  // 2. The shape.
  if (input.collidingNames.length > 0) {
    return settle(
      "version_collision",
      `Version ${meta.id} is carried by more than one file (${listVersions(input.collidingNames)}), and the prime's ledger can record only one of them.`,
      "Rename one of the files in the prime repository so each version is unique, then read this again.",
    );
  }

  if (input.alreadyApplied) {
    return settle(
      "already_applied",
      "The prime's ledger already records this version, so it is not holding anything back.",
      null,
    );
  }

  if (!input.body.read) {
    return input.body.oversized
      ? settle(
          "oversized",
          `The body is past the size this console will hold, so nothing below could be measured. ${input.body.why}`,
          "Apply it through the prime's own workflow, which streams a file of this size in one piece.",
        )
      : settle(
          "undiagnosed",
          `The body could not be read, so nothing about this file was measured. ${input.body.why}`,
          "Try again once the repository read succeeds; nothing here is a statement about the migration.",
        );
  }

  // 3. Prerequisites, before anything that would be attributed to this file.
  if (input.blockedBy === null) {
    return settle(
      "undiagnosed",
      "Which earlier migrations the prime has run could not be established, so this file's position is unknown.",
      "Read the prime's SQL position again; a failed read is not a clear run.",
    );
  }
  if (input.blockedBy.length > 0) {
    return settle(
      "blocked_by_prerequisite",
      `${input.blockedBy.length} earlier migration${input.blockedBy.length === 1 ? "" : "s"} the prime has not run sits in front of this one (${listVersions(input.blockedBy)}).`,
      "Diagnose the earliest of those first. Running this one now would fail against a schema missing their effect, and the failure would read as this file's.",
    );
  }

  // 4. The statements decide whether there can be a trial run at all.
  const blocking = shaped.hazards.filter((h) => UNTESTABLE_HAZARDS.has(h.kind));
  if (!isSafeToDryRun(all)) {
    const first = blocking[0] ?? all.find((h) => UNTESTABLE_HAZARDS.has(h.kind))!;
    return settle(
      "unsafe_to_test",
      `This file cannot be tried safely from here: line ${first.line} — ${first.note}.`,
      "Read it, then apply it through the prime's own Apply-a-migration workflow, which is built for exactly this case.",
    );
  }

  // 5. The trial run.
  if (!input.dryRun.ran) {
    return settle(
      "undiagnosed",
      `No trial run was made, so nothing here says whether it would succeed. ${input.dryRun.why}`,
      "Run the diagnosis again once the prime's database can be reached.",
    );
  }
  if (!input.dryRun.ok) {
    if (input.dryRun.sqlstate && DRY_RUN_INCONCLUSIVE_STATES.has(input.dryRun.sqlstate)) {
      return settle(
        "undiagnosed",
        `The trial run hit this console's own limit rather than an error in the file — ${sqlstateWords(input.dryRun.sqlstate)}.`,
        "Nothing was applied and nothing was learned. Try again when the prime's database is quieter.",
      );
    }
    const words = sqlstateWords(input.dryRun.sqlstate);
    return settle(
      "would_fail",
      `Tried against the prime and rolled back: it fails${words ? ` because ${words}` : ""}${input.dryRun.sqlstate ? ` (${input.dryRun.sqlstate})` : ""}. ${input.dryRun.message}`,
      "Fix the file in the prime repository and read this again. Nothing was applied.",
    );
  }

  const cautions: string[] = [];
  if (shaped.destructiveCount > 0) {
    cautions.push(
      `${shaped.destructiveCount} statement${shaped.destructiveCount === 1 ? "" : "s"} here destroy data`,
    );
  }
  if (shaped.dataRewriteCount > 0) {
    cautions.push(
      `${shaped.dataRewriteCount} would duplicate rows rather than fail if this file is ever run twice`,
    );
  }

  return settle(
    "ready",
    `Tried against the prime and rolled back cleanly in ${input.dryRun.ms} ms. It applies against the schema the prime has now.`,
    cautions.length > 0 ? `Read before dispatching: ${cautions.join("; ")}.` : null,
  );
}

function catalogueNote(c: DiagnosisInput["catalogue"]): string | null {
  if (!c) return null;
  if (!c.read) return `The prime's catalogue was not read: ${c.why}`;
  if (c.verdict === "satisfied") {
    return "Every object this file creates already exists on the prime, so it has probably run under an id nothing recorded.";
  }
  if (c.verdict === "unsatisfied") {
    const n = c.missing.length;
    return `The prime is missing ${n} object${n === 1 ? "" : "s"} this file creates${n > 0 ? ` (${c.missing.slice(0, 4).join(", ")}${n > 4 ? `, and ${n - 4} more` : ""})` : ""}, so it has not run here.`;
  }
  return "This file creates nothing that can be looked for in the prime's catalogue, so the catalogue has no opinion either way.";
}
