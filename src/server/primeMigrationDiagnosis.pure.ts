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
  /**
   * `head` with the author's own casing and quoting kept.
   *
   * `head` is lower-cased, which is right for matching keywords and wrong for
   * anything that has to WRITE the object's name back out: this corpus is full
   * of policies called `"Users can view their own rows"`, and a `DROP POLICY`
   * composed from the lower-cased form names a policy that does not exist.
   * Everything else about it is identical — comments gone, whitespace
   * collapsed, dollar-quoted bodies elided.
   */
  headRaw: string;
  /**
   * Offset in the ORIGINAL source of the statement's first real character.
   *
   * A leading comment is NOT inside the span, deliberately: a repair that
   * inserts a statement before this one lands under the comment that explains
   * it rather than between the comment and what it describes.
   */
  start: number;
  /** Offset just past the terminating `;`, or the end of the source. */
  end: number;
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
  let startAt = 0;
  let started = false;

  const flush = (endAt: number) => {
    const text = buf.trim();
    if (text) {
      const raw = head.trim().replace(/\s+/g, " ");
      out.push({
        text,
        line: startLine,
        head: raw.toLowerCase(),
        headRaw: raw,
        start: startAt,
        end: endAt,
      });
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
      flush(i + 1);
      continue;
    }
    if (!started && !/\s/.test(c)) {
      started = true;
      startLine = line;
      startAt = i;
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
  flush(sql.length);
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
  Running the same file twice
  ───────────────────────────────────────────────────────────────────────────

  `apply-migration.yml` runs `psql -v ON_ERROR_STOP=1 -f "$FILE"` with NO
  `--single-transaction`. A file that fails half way leaves everything before
  the failure applied, and the repair is to fix the file and dispatch it
  again — over statements that already ran. So "what happens on the second
  run" is not a theoretical property here; it is the question an operator is
  standing in front of at the moment they most need an answer.

  ## Why this is a READING and not a flag

  `DATA_REWRITE` above records what a general "could this statement succeed
  twice?" rule measured: 2,411 hits, 22% of every statement in the repository,
  1,592 of them `CREATE POLICY`. A boolean drawn from that would be red on
  nearly every file and would say nothing. What makes the number readable is
  that the three outcomes are not alike:

    - A second `CREATE TABLE`/`INDEX`/`POLICY` **fails loudly** with
      `42P07`/`42710`, having changed nothing. The file stops; the repair is
      mechanical; no data is wrong.
    - A second unguarded `INSERT` **succeeds** and duplicates rows. Nothing
      reports it. This is the one that costs something.
    - Most of the corpus is neither, because the repository already writes
      `IF NOT EXISTS`, `OR REPLACE`, and `DROP … IF EXISTS` before `CREATE`.

  So the reading separates them, and `rewrites_data` outranks `fails_loudly`
  wherever a file carries both: the silent outcome is the one worth the chip.

  ## The pairing that had to be modelled, and what it was worth

  `DROP POLICY IF EXISTS x ON t; CREATE POLICY x ON t …` is the standard
  idempotent RLS idiom, and `DESTRUCTIVE` above already excludes it for that
  reason. A reading that looked at the `CREATE` alone would call every one of
  those files collision-prone. So the guard is tracked per file, in statement
  order — an EARLIER `DROP … IF EXISTS` of the same object, never a later one,
  because a drop below the create does not make the create safe.

  `IF EXISTS` is required on that drop. A bare `DROP x` is itself a statement
  whose second run fails, so pairing one with a `CREATE` would move a file out
  of `fails_loudly` on the strength of a statement that puts it back in.

  ## What it reads over the prime's own corpus, 21 Sep 2026

  1,002 files, of which 989 could be read here (13 are past the corpus
  ceiling) carrying 11,072 statements:

       688  re-runnable throughout      (68.7%)
       265  a second run FAILS LOUDLY   (26.4%)
        36  a second run REWRITES DATA   (3.6%)
        13  unreadable                   (1.3%)

  945 creations are guarded by an earlier `DROP … IF EXISTS` in their own
  file, and modelling that pairing is what keeps **212 files** out of
  `fails_loudly`. Without it the indicator is noise; with it, it is the thing
  it claims to be.

  The 265 are dominated by `CREATE POLICY` (603 of the capped notes) and they
  are real: `20250124140000_fix_email_communication_rls_policies.sql` drops
  eight policies by their OLD names and creates nine under new ones, so a
  second run stops at the first `CREATE POLICY` with `42710`. That is worth
  saying, and it is worth saying as the mild outcome it is.

  ## The direction this errs, which is the opposite of the dry-run gate's

  The gate above treats what it cannot classify as a hazard, because a missed
  hazard defeats a ROLLBACK against a production database. This reading is a
  DISCLOSURE beside a verdict — it gates nothing — and the same asymmetry here
  would paint the whole corpus. So a statement that names no object it could
  collide with is read as re-runnable, and the two places this cannot see are
  NAMED rather than guessed: a body the console never read is `unreadable` and
  never `rerunnable`, and a `DO $$ … $$` block, whose contents the scanner
  deliberately elides so a PL/pgSQL `begin` is not read as a transaction, is
  COUNTED and said out loud beside the reading. 217 files carry one and 179 of
  those read re-runnable, so this is a caveat on about a fifth of the corpus
  rather than a footnote nobody meets.
*/

export type IdempotencyReading = "rerunnable" | "fails_loudly" | "rewrites_data" | "unreadable";

export type IdempotencyNote = {
  /** What the second run would do, in the operator's words. */
  what: string;
  excerpt: string;
  line: number;
};

export type Idempotency = {
  reading: IdempotencyReading;
  /** One sentence beside the chip. Never database vocabulary. */
  summary: string;
  /** Statements whose second run stops the file. Capped. */
  collides: IdempotencyNote[];
  collideCount: number;
  /** Statements whose second run changes data and does not stop. Capped. */
  rewrites: IdempotencyNote[];
  rewriteCount: number;
  /** Creations an earlier `DROP … IF EXISTS` in this same file already guards. */
  guardedByDrop: number;
  /** `DO $$ … $$` blocks, whose contents this cannot see into. */
  opaqueBlocks: number;
};

/** Notes drawn beside a reading, capped so one file cannot fill the page. */
export const IDEMPOTENCY_ROWS = 6;

/** A possibly-qualified, possibly-quoted identifier as it appears in `head`. */
const IDENT = String.raw`(?:"[^"]+"|[a-z_][\w$]*)`;
const QNAME = `${IDENT}(?:\\.${IDENT})*`;
/** Every guard this reading accepts on a DROP. A bare one is its own collision. */
const IFX = String.raw`if\s+exists\s+`;

/** `"public"."Foo"` and `public.foo` are the same key; quoting and schema go. */
function objectKey(raw: string): string {
  const last = raw.split(".").pop() ?? raw;
  return last.replace(/^"|"$/g, "").toLowerCase();
}

type Named = { kind: string; key: string };

const CREATE_FORMS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: new RegExp(`^create\\s+table\\s+(${QNAME})`), kind: "table" },
  {
    re: new RegExp(`^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(${QNAME})\\s+on\\b`),
    kind: "index",
  },
  { re: new RegExp(`^create\\s+policy\\s+(${IDENT})\\s+on\\s+(${QNAME})`), kind: "policy" },
  {
    re: new RegExp(
      `^create\\s+(?:constraint\\s+)?trigger\\s+(${IDENT})\\b[\\s\\S]*?\\son\\s+(${QNAME})`,
    ),
    kind: "trigger",
  },
  { re: new RegExp(`^create\\s+type\\s+(${QNAME})`), kind: "type" },
  { re: new RegExp(`^create\\s+schema\\s+(${QNAME})`), kind: "schema" },
  { re: new RegExp(`^create\\s+sequence\\s+(${QNAME})`), kind: "sequence" },
  { re: new RegExp(`^create\\s+materialized\\s+view\\s+(${QNAME})`), kind: "materialized view" },
  { re: new RegExp(`^create\\s+view\\s+(${QNAME})`), kind: "view" },
  { re: new RegExp(`^create\\s+extension\\s+(${QNAME})`), kind: "extension" },
  { re: new RegExp(`^create\\s+publication\\s+(${QNAME})`), kind: "publication" },
  { re: new RegExp(`^create\\s+(?:role|user)\\s+(${QNAME})`), kind: "role" },
  {
    re: new RegExp(`^create\\s+(?:function|procedure)\\s+(${QNAME})`),
    kind: "function",
  },
  {
    re: new RegExp(
      `^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})[\\s\\S]*?\\badd\\s+constraint\\s+(${IDENT})`,
    ),
    kind: "constraint",
  },
  {
    re: new RegExp(
      `^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})[\\s\\S]*?\\badd\\s+column\\s+(?!if\\s+not\\s+exists)(${IDENT})`,
    ),
    kind: "column",
  },
  {
    re: new RegExp(`^alter\\s+type\\s+(${QNAME})\\s+add\\s+value\\s+'([^']*)'`),
    kind: "enum value",
  },
];

/**
 * What a statement CREATES that a second run would collide with, or null.
 *
 * Null covers three different things and deliberately does not distinguish
 * them, because all three are re-runnable: the statement is already guarded
 * (`IF NOT EXISTS`, `OR REPLACE`), it creates nothing, or it creates something
 * unnamed — `CREATE INDEX ON t (c)` auto-names, so a second run makes a second
 * index and succeeds. That last one wastes a little disk and loses nothing.
 */
function createsObject(head: string): Named | null {
  if (/^create\s+(or\s+replace|.*\bif\s+not\s+exists)\b/.test(head)) {
    // `CREATE MATERIALIZED VIEW` has no OR REPLACE, so `or replace` there is
    // a parse error rather than a guard — but such a file never applied once,
    // let alone twice, so there is nothing for this reading to say about it.
    return null;
  }
  for (const f of CREATE_FORMS) {
    const m = f.re.exec(head);
    if (!m) continue;
    const parts = m.slice(1).filter(Boolean).map(objectKey);
    return parts.length > 0 ? { kind: f.kind, key: parts.join(" on ") } : null;
  }
  return null;
}

const DROP_FORMS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: new RegExp(`^drop\\s+table\\s+${IFX}(${QNAME})`), kind: "table" },
  { re: new RegExp(`^drop\\s+index\\s+(?:concurrently\\s+)?${IFX}(${QNAME})`), kind: "index" },
  { re: new RegExp(`^drop\\s+policy\\s+${IFX}(${IDENT})\\s+on\\s+(${QNAME})`), kind: "policy" },
  { re: new RegExp(`^drop\\s+trigger\\s+${IFX}(${IDENT})\\s+on\\s+(${QNAME})`), kind: "trigger" },
  { re: new RegExp(`^drop\\s+type\\s+${IFX}(${QNAME})`), kind: "type" },
  { re: new RegExp(`^drop\\s+schema\\s+${IFX}(${QNAME})`), kind: "schema" },
  { re: new RegExp(`^drop\\s+sequence\\s+${IFX}(${QNAME})`), kind: "sequence" },
  {
    re: new RegExp(`^drop\\s+materialized\\s+view\\s+${IFX}(${QNAME})`),
    kind: "materialized view",
  },
  { re: new RegExp(`^drop\\s+view\\s+${IFX}(${QNAME})`), kind: "view" },
  { re: new RegExp(`^drop\\s+extension\\s+${IFX}(${QNAME})`), kind: "extension" },
  { re: new RegExp(`^drop\\s+publication\\s+${IFX}(${QNAME})`), kind: "publication" },
  { re: new RegExp(`^drop\\s+(?:role|user)\\s+${IFX}(${QNAME})`), kind: "role" },
  { re: new RegExp(`^drop\\s+(?:function|procedure)\\s+${IFX}(${QNAME})`), kind: "function" },
  {
    re: new RegExp(
      `^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})[\\s\\S]*?\\bdrop\\s+constraint\\s+${IFX}(${IDENT})`,
    ),
    kind: "constraint",
  },
  {
    re: new RegExp(
      `^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${QNAME})[\\s\\S]*?\\bdrop\\s+column\\s+${IFX}(${IDENT})`,
    ),
    kind: "column",
  },
];

/**
 * What a statement REMOVES if it is there, or null.
 *
 * `IF EXISTS` is required: a bare `DROP` is itself a statement whose second
 * run fails, so pairing one with a `CREATE` would move a file out of
 * `fails_loudly` on the strength of a statement that puts it back in.
 */
function dropsObject(head: string): Named | null {
  for (const f of DROP_FORMS) {
    const m = f.re.exec(head);
    if (!m) continue;
    const parts = m.slice(1).filter(Boolean).map(objectKey);
    return parts.length > 0 ? { kind: f.kind, key: parts.join(" on ") } : null;
  }
  return null;
}

/** A bare `DROP x` — its own second run fails, so it is a collision too. */
const UNGUARDED_DROP =
  /^drop\s+(?!.*\bif\s+exists\b)(table|index|policy|trigger|type|schema|sequence|materialized\s+view|view|extension|publication|function|procedure|role|user)\b/;

const ALTER_DROPS_BARE =
  /^alter\s+table\b[\s\S]*?\bdrop\s+(?:constraint|column)\s+(?!if\s+exists\b)/;

const OPAQUE_BLOCK = /^do\b/;

const COLLIDE_WORDS: Readonly<Record<string, string>> = {
  table: "creates a table that would already be there",
  index: "creates an index that would already be there",
  policy: "creates a row-level security policy that would already be there",
  trigger: "creates a trigger that would already be there",
  type: "creates a type that would already be there",
  schema: "creates a schema that would already be there",
  sequence: "creates a sequence that would already be there",
  view: "creates a view that would already be there",
  "materialized view": "creates a materialized view that would already be there",
  extension: "installs an extension that would already be there",
  publication: "creates a publication that would already be there",
  role: "creates a role that would already be there",
  function: "creates a function that would already be there",
  constraint: "adds a constraint that would already be there",
  column: "adds a column that would already be there",
  "enum value": "adds a value to a type that would already have it",
};

/**
 * One statement this reading has something to say about.
 *
 * `index` is into the array handed in, so a caller holding the statements can
 * go back to the one that was flagged — which is what the repair planner needs
 * and what the chip above deliberately does not carry.
 */
export type IdempotencyFlag = {
  index: number;
  /** `collides` stops the second run; `rewrites` lets it through and writes. */
  band: "collides" | "rewrites";
  /** What the second run would do, in the operator's words. */
  what: string;
};

export type IdempotencyWalk = {
  flags: IdempotencyFlag[];
  guardedByDrop: number;
  opaqueBlocks: number;
};

/**
 * The walk, once.
 *
 * `assessIdempotency` reads this to draw a chip and `planMigrationRepair`
 * reads it to decide what to change, and neither has a copy of the rule. That
 * matters more here than it usually does: a planner working off its own idea
 * of what counts as a collision would offer repairs for statements the chip
 * calls fine, and — far worse — would leave alone statements the chip calls
 * broken while the page said the file was healed.
 *
 * The notes are UNCAPPED here and capped where they are drawn. A page cannot
 * carry 1,020 rows; a repair has to see all of them or it is not a repair.
 */
export function idempotencyWalk(statements: readonly SqlStatement[]): IdempotencyWalk {
  const dropped = new Set<string>();
  const flags: IdempotencyFlag[] = [];
  let guardedByDrop = 0;
  let opaqueBlocks = 0;

  statements.forEach((s, index) => {
    const h = s.head;

    if (OPAQUE_BLOCK.test(h)) {
      opaqueBlocks += 1;
      return;
    }

    const w = DATA_REWRITE.find((x) => x.re.test(h));
    if (w) {
      flags.push({ index, band: "rewrites", what: w.what });
      return;
    }

    const gone = dropsObject(h);
    if (gone) {
      dropped.add(`${gone.kind}:${gone.key}`);
      return;
    }

    if (UNGUARDED_DROP.test(h) || ALTER_DROPS_BARE.test(h)) {
      flags.push({
        index,
        band: "collides",
        what: "removes something that a second run would no longer find",
      });
      return;
    }

    const made = createsObject(h);
    if (!made) return;
    if (dropped.has(`${made.kind}:${made.key}`)) {
      guardedByDrop += 1;
      return;
    }
    flags.push({
      index,
      band: "collides",
      what: COLLIDE_WORDS[made.kind] ?? "creates something that would already be there",
    });
  });

  return { flags, guardedByDrop, opaqueBlocks };
}

/**
 * Whether running this file a second time would be a no-op.
 *
 * Takes null for a body that was never read, so the one place that decides
 * also enforces the rule that matters: a file nobody could open reads
 * `unreadable` and never `rerunnable`. A reading is a claim about a body, and
 * there is no body to make a claim about.
 */
export function assessIdempotency(statements: readonly SqlStatement[] | null): Idempotency {
  if (!statements) {
    return {
      reading: "unreadable",
      summary: "The file was not read here, so nothing was measured about running it twice.",
      collides: [],
      collideCount: 0,
      rewrites: [],
      rewriteCount: 0,
      guardedByDrop: 0,
      opaqueBlocks: 0,
    };
  }

  const { flags, guardedByDrop, opaqueBlocks } = idempotencyWalk(statements);

  const collides: IdempotencyNote[] = [];
  const rewrites: IdempotencyNote[] = [];
  let collideCount = 0;
  let rewriteCount = 0;

  for (const f of flags) {
    const s = statements[f.index];
    const into = f.band === "collides" ? collides : rewrites;
    if (f.band === "collides") collideCount += 1;
    else rewriteCount += 1;
    if (into.length < IDEMPOTENCY_ROWS)
      into.push({ what: f.what, excerpt: excerpt(s.text), line: s.line });
  }

  const reading: IdempotencyReading =
    rewriteCount > 0 ? "rewrites_data" : collideCount > 0 ? "fails_loudly" : "rerunnable";

  return {
    reading,
    summary: idempotencySummary(reading, collideCount, rewriteCount, opaqueBlocks),
    collides,
    collideCount,
    rewrites,
    rewriteCount,
    guardedByDrop,
    opaqueBlocks,
  };
}

function idempotencySummary(
  reading: IdempotencyReading,
  collideCount: number,
  rewriteCount: number,
  opaqueBlocks: number,
): string {
  const blocks =
    opaqueBlocks > 0
      ? ` ${opaqueBlocks} statement${opaqueBlocks === 1 ? "" : "s"} here run a block this console does not read into, so anything inside is not covered by that.`
      : "";
  if (reading === "rewrites_data") {
    return (
      `Running this file a second time would change data rather than stop: ${rewriteCount} statement${rewriteCount === 1 ? "" : "s"} would write again and succeed.` +
      (collideCount > 0
        ? ` ${collideCount} other${collideCount === 1 ? "" : "s"} would fail first, which may or may not reach them.`
        : "") +
      blocks
    );
  }
  if (reading === "fails_loudly") {
    return (
      `Running this file a second time would stop at the first of ${collideCount} statement${collideCount === 1 ? "" : "s"} that creates something already there. Nothing would be written twice.` +
      blocks
    );
  }
  return `Running this file a second time changes nothing: every statement in it is already written to be repeated.${blocks}`;
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

/**
 * Every verdict, as a value rather than only as a type.
 *
 * The type is DERIVED from this list, so a verdict added tomorrow is in both
 * or in neither. A union written by hand and a list written beside it is how a
 * test comes to assert a property of the list rather than of the product —
 * measured here: with the two written separately, renaming a survey standing
 * to `ready` left the disjointness test green.
 */
export const DIAGNOSIS_VERDICTS = [
  "rollback_script",
  "version_collision",
  "already_applied",
  "oversized",
  "blocked_by_prerequisite",
  "unsafe_to_test",
  "would_fail",
  "ready",
  "undiagnosed",
] as const;

export type DiagnosisVerdict = (typeof DIAGNOSIS_VERDICTS)[number];

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
  /**
   * What a SECOND run of this file would do — carried on every verdict,
   * including the ones that refuse to run it at all.
   *
   * It belongs beside the verdict rather than inside it because the two answer
   * different questions. The verdict says whether this console may dispatch
   * the file now; this says what happens if it is dispatched again, which is
   * the question an operator arrives with after a half-failed run, when the
   * verdict has already been spent.
   */
  idempotency: Idempotency;
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

/*
  ───────────────────────────────────────────────────────────────────────────
  The one cascade both surfaces walk
  ───────────────────────────────────────────────────────────────────────────

  Two things ask what stands in a migration's way: the diagnosis, which then
  goes on to try it against the prime, and the survey, which stops here
  because it is reading three hundred files and may not spend a database round
  trip on each. If each walked its own copy of the order, the list and the
  page would eventually disagree about the same file — and the disagreement
  would be silent, because each is right about itself.

  So the order lives here once, and both read its answer. `null` means nothing
  in the FILE objects; it does not mean the file is good, which is exactly the
  distinction the two callers then part company on.
*/
export type PreTrialStop =
  | { at: "rollback_script" }
  | { at: "version_collision" }
  | { at: "already_applied" }
  | { at: "oversized"; why: string }
  | { at: "unread"; why: string }
  | { at: "position_unknown" }
  | { at: "blocked"; versions: string[] }
  | { at: "unsafe_to_test"; hazard: Hazard };

/**
 * What stops this file before anything is asked of the prime's database.
 *
 * The order is not arbitrary and is the same one `diagnoseMigration`'s header
 * argues for: a refusal about the FILE outranks a refusal about the database,
 * and a cheap certain refusal outranks an expensive uncertain one, so nothing
 * below is ever attributed to the wrong cause.
 */
export function stopBeforeTrialRun(args: {
  name: string;
  collidingNames: readonly string[];
  alreadyApplied: boolean;
  body: DiagnosisInput["body"];
  blockedBy: readonly string[] | null;
  hazards: readonly Hazard[];
}): PreTrialStop | null {
  if (isRollbackScript(args.name)) return { at: "rollback_script" };
  if (args.collidingNames.length > 0) return { at: "version_collision" };
  if (args.alreadyApplied) return { at: "already_applied" };
  if (!args.body.read) {
    return args.body.oversized
      ? { at: "oversized", why: args.body.why }
      : { at: "unread", why: args.body.why };
  }
  if (args.blockedBy === null) return { at: "position_unknown" };
  if (args.blockedBy.length > 0) return { at: "blocked", versions: [...args.blockedBy] };
  const blocking = args.hazards.find((h) => UNTESTABLE_HAZARDS.has(h.kind));
  if (blocking) return { at: "unsafe_to_test", hazard: blocking };
  return null;
}

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
    idempotency: assessIdempotency(statements),
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

  // Layers 1-4, walked by the one cascade the survey walks too.
  const stop = stopBeforeTrialRun({
    name: meta.name,
    collidingNames: input.collidingNames,
    alreadyApplied: input.alreadyApplied,
    body: input.body,
    blockedBy: input.blockedBy,
    hazards: all,
  });
  if (stop) {
    switch (stop.at) {
      case "rollback_script":
        return settle(
          "rollback_script",
          "This file is named as an undo. It is withheld on purpose and must never be applied from a console.",
          "If it genuinely needs to run, do it by hand with the author of the change it reverses.",
        );
      case "version_collision":
        return settle(
          "version_collision",
          `Version ${meta.id} is carried by more than one file (${listVersions(input.collidingNames)}), and the prime's ledger can record only one of them.`,
          "Rename one of the files in the prime repository so each version is unique, then read this again.",
        );
      case "already_applied":
        return settle(
          "already_applied",
          "The prime's ledger already records this version, so it is not holding anything back.",
          null,
        );
      case "oversized":
        return settle(
          "oversized",
          `The body is past the size this console will hold, so nothing below could be measured. ${stop.why}`,
          "Apply it through the prime's own workflow, which streams a file of this size in one piece.",
        );
      case "unread":
        return settle(
          "undiagnosed",
          `The body could not be read, so nothing about this file was measured. ${stop.why}`,
          "Try again once the repository read succeeds; nothing here is a statement about the migration.",
        );
      case "position_unknown":
        return settle(
          "undiagnosed",
          "Which earlier migrations the prime has run could not be established, so this file's position is unknown.",
          "Read the prime's SQL position again; a failed read is not a clear run.",
        );
      case "blocked":
        return settle(
          "blocked_by_prerequisite",
          `${stop.versions.length} earlier migration${stop.versions.length === 1 ? "" : "s"} the prime has not run sits in front of this one (${listVersions(stop.versions)}).`,
          "Diagnose the earliest of those first. Running this one now would fail against a schema missing their effect, and the failure would read as this file's.",
        );
      case "unsafe_to_test":
        return settle(
          "unsafe_to_test",
          `This file cannot be tried safely from here: line ${stop.hazard.line} — ${stop.hazard.note}.`,
          "Read it, then apply it through the prime's own Apply-a-migration workflow, which is built for exactly this case.",
        );
    }
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

/*
  ───────────────────────────────────────────────────────────────────────────
  What the tree listing alone already says
  ───────────────────────────────────────────────────────────────────────────

  Three facts about the whole corpus cost nothing beyond the listing every
  other reading here already pays for: no body is read, no statement is
  scanned and the prime's database is not asked. They are worth drawing
  precisely because they are the ones a per-file diagnosis cannot show.

  A collision is the sharpest of them. `schema_migrations.version` is the
  primary key, so a version two files carry can only ever record one of them
  and no amount of running anything closes the hole — every clone queues behind
  it for ever. On this prime there are 32, across 77 files.
*/

export type OversizeFile = { id: string; name: string; bytes: number };

export type CorpusFacts = {
  /** Migration files on the prime's default branch. */
  files: number;
  /** Files named as an undo, which must never be dispatched from a console. */
  rollbackScripts: string[];
  /** Versions carried by more than one file. */
  collisions: VersionCollision[];
  /** Files the listing reports as past the ceiling this console reads. */
  oversize: OversizeFile[];
  /**
   * Files the listing gave no size for.
   *
   * Counted separately and never folded into `oversize`, because an unknown
   * size is not a small one — the same distinction `loadSql` makes when it
   * fetches an unsized blob rather than waving it through. Folding them in
   * either way would state something the listing did not say.
   */
  sizeUnknown: number;
};

/**
 * Everything the corpus listing already knows, before anything is fetched.
 *
 * `sizeOf` answers null for a file the listing carried no size for; this never
 * reads that as zero.
 */
export function corpusFacts(
  metas: ReadonlyArray<{ id: string; name: string }>,
  sizeOf: (id: string) => number | null,
  ceilingBytes: number,
): CorpusFacts {
  const oversize: OversizeFile[] = [];
  let sizeUnknown = 0;
  for (const m of metas) {
    const bytes = sizeOf(m.id);
    if (bytes === null) sizeUnknown += 1;
    else if (bytes > ceilingBytes) oversize.push({ id: m.id, name: m.name, bytes });
  }
  return {
    files: metas.length,
    rollbackScripts: metas.filter((m) => isRollbackScript(m.name)).map((m) => m.name),
    collisions: findVersionCollisions(metas),
    oversize,
    sizeUnknown,
  };
}

/*
  ───────────────────────────────────────────────────────────────────────────
  The survey: three hundred files, no database
  ───────────────────────────────────────────────────────────────────────────

  `diagnoseMigration` spends two Management API statements and a rolled-back
  trial run per file. That is the right price for the ONE file an operator has
  chosen. It is the wrong price for the list they choose it from: the prime
  withholds enough migrations that asking the database about each would be
  hundreds of round trips against a production project to draw a table.

  So the survey walks the same cascade and stops where the database begins. It
  is not a cheaper diagnosis; it answers a different question, and the two
  vocabularies are kept apart on purpose so neither can be read as the other:

      DiagnosisVerdict   may this console run this file NOW?
      SurveyStanding     what is standing in this file's way, before
                         anything was asked of the prime?

  `needs_a_trial_run` is the whole point of the separation. It is what a
  perfectly healthy file reads in a list, and it is emphatically NOT `ready` —
  a survey has no evidence that a body applies, only that nothing in the file
  forbids trying. A test asserts the two vocabularies share no value, the way
  the AML obligation and outcome vocabularies are held apart, because the day
  one word appears in both is the day a list starts making a promise no
  trial run backed.
*/

export const SURVEY_STANDINGS = [
  /** Named as an undo. Never dispatched from a console. */
  "must_not_run",
  /** Two files carry this version, so the ledger can record only one. */
  "cannot_be_recorded",
  /** The prime's ledger already has it; it holds nothing back. */
  "applied",
  /** Earlier migrations the prime has not run sit in front of it. */
  "blocked",
  /** Its own statements forbid a rolled-back trial run here. */
  "hand_apply",
  /** Past the size this console reads. */
  "too_large",
  /** The body, or the prime's position, could not be read. */
  "unknown",
  /** Nothing in the file objects. Whether it APPLIES is still untested. */
  "needs_a_trial_run",
] as const;

export type SurveyStanding = (typeof SURVEY_STANDINGS)[number];

export type MigrationSurvey = {
  id: string;
  name: string;
  path: string;
  standing: SurveyStanding;
  /** A table cell's worth of words. Never database vocabulary. */
  note: string;
  /** What a SECOND run would do — the whole reason the survey reads bodies. */
  idempotency: Idempotency;
  statementCount: number | null;
  bytes: number | null;
  hazardCount: number;
  destructiveCount: number;
  dataRewriteCount: number;
  /** How many unrun migrations sit in front of it, or null when unknown. */
  blockedByCount: number | null;
};

export type SurveyInput = {
  meta: { id: string; name: string; path: string };
  collidingNames: readonly string[];
  alreadyApplied: boolean;
  blockedBy: readonly string[] | null;
  body: DiagnosisInput["body"];
};

/** The standings that mean an operator owes this file something. */
export const OWED_STANDINGS: ReadonlySet<SurveyStanding> = new Set<SurveyStanding>([
  "cannot_be_recorded",
  "blocked",
  "hand_apply",
  "too_large",
  "needs_a_trial_run",
]);

/**
 * One migration, read from its own bytes and the prime's ledger — and nothing
 * else.
 *
 * Every field it carries can be computed without a database, which is what
 * makes it affordable over a whole withheld set. Where it cannot answer it
 * says `unknown` and names which read failed, because a survey row that read
 * clean and a survey row nobody could read look identical in a table.
 */
export function surveyMigration(input: SurveyInput): MigrationSurvey {
  const statements = input.body.read ? scanSqlStatements(input.body.sql) : null;
  const hazards = statements ? hazardsIn(statements) : [];
  const stop = stopBeforeTrialRun({
    name: input.meta.name,
    collidingNames: input.collidingNames,
    alreadyApplied: input.alreadyApplied,
    body: input.body,
    blockedBy: input.blockedBy,
    hazards,
  });

  const shaped = {
    id: input.meta.id,
    name: input.meta.name,
    path: input.meta.path,
    idempotency: assessIdempotency(statements),
    statementCount: statements ? statements.length : null,
    bytes: input.body.read ? input.body.bytes : null,
    hazardCount: hazards.length,
    destructiveCount: hazards.filter((h) => h.kind === "destructive").length,
    dataRewriteCount: hazards.filter((h) => h.kind === "data_rewrite").length,
    blockedByCount: input.blockedBy === null ? null : input.blockedBy.length,
  };

  const at = (standing: SurveyStanding, note: string): MigrationSurvey => ({
    ...shaped,
    standing,
    note,
  });

  if (!stop) {
    return at(
      "needs_a_trial_run",
      "Nothing in the file stands in its way. Whether it applies to the prime's schema has not been tested.",
    );
  }
  switch (stop.at) {
    case "rollback_script":
      return at("must_not_run", "Named as an undo. It is withheld on purpose.");
    case "version_collision":
      return at(
        "cannot_be_recorded",
        `Another file carries version ${input.meta.id}, and only one of them can ever be recorded.`,
      );
    case "already_applied":
      return at("applied", "The prime has already run it.");
    case "oversized":
      return at("too_large", `Past the size this console reads. ${stop.why}`);
    case "unread":
      return at("unknown", `Its body could not be read. ${stop.why}`);
    case "position_unknown":
      return at(
        "unknown",
        "What the prime has already run could not be established, so this file's position is unknown.",
      );
    case "blocked":
      return at(
        "blocked",
        `${stop.versions.length} earlier migration${stop.versions.length === 1 ? "" : "s"} the prime has not run sits in front of it.`,
      );
    case "unsafe_to_test":
      return at(
        "hand_apply",
        `Line ${stop.hazard.line} — ${stop.hazard.note}. It goes through the prime's own workflow.`,
      );
  }
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
