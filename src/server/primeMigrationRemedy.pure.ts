/**
 * Make one of the prime's migrations safe to run twice — mechanically, and
 * only where that word is honest.
 *
 * `primeMigrationDiagnosis.pure.ts` answers whether a second run of a file
 * would be a no-op. On the prime's own corpus it answers `fails_loudly` for
 * 265 files and `rewrites_data` for 36, and until now that was where the
 * surface stopped: a chip, a list of statements, and a person opening an
 * editor. This is the other half. It reads the SAME walk the chip reads —
 * `idempotencyWalk`, imported rather than re-implemented — and proposes the
 * smallest edit to the file that would move it.
 *
 * ## It edits the FILE, and never the run
 *
 * The tempting shortcut is to apply a patched body instead of the file. It is
 * forbidden here, and the reason is one this repository has already written
 * down: `scripts/check-applied-digests.mjs` exists because *"a migration that
 * has already RUN must not change in the repository"*, and it measured two of
 * fifty-five settled rows already differing from their file with no surface
 * saying so. Applying a body the repository does not hold would manufacture
 * exactly that drift, deliberately, on every repair. So a repair is a change
 * to the file, it travels as a pull request on the prime, and the run that
 * follows is the ordinary one over the ordinary file.
 *
 * ## The two shapes that are sound
 *
 * **Guard in place** — `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`, and the
 * nine other forms Postgres gives a guard to. Nothing moves; a token is
 * inserted. On a fresh database the statement does exactly what it did.
 *
 * **Prepend a drop** — `DROP POLICY IF EXISTS p ON t;` before `CREATE POLICY p
 * ON t`. Postgres has no `IF NOT EXISTS` for policies, triggers or
 * constraints, and this is the corpus's own idiom: 945 creations in it are
 * already guarded this way, which is the pairing `assessIdempotency` models
 * and which keeps 212 files out of `fails_loudly` before this module exists at
 * all.
 *
 * ## The line that decides what is refused
 *
 * **A repair may never turn a loud failure into a quiet wrong answer, and may
 * never claim a re-runnability it cannot deliver.**
 *
 * That line refuses two families, and naming them is most of this module's
 * value:
 *
 *   - **An unguarded `INSERT`.** The obvious repair is `ON CONFLICT DO
 *     NOTHING`. Against a table with no unique constraint covering those rows
 *     it is legal, it never errors, and it **still inserts the duplicate** —
 *     so the chip would move to `rerunnable` while the behaviour stayed
 *     exactly as it was. This module cannot see the constraint set from the
 *     file, so it cannot tell the sound case from the placebo, and a placebo
 *     on this screen is worse than the red chip it replaces. 62 statements
 *     across 36 files.
 *   - **`CREATE TYPE`.** There is no `IF NOT EXISTS`, and `DROP TYPE IF
 *     EXISTS` cascades to every column declared with it. The idiom that does
 *     work — `DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN duplicate_object THEN
 *     NULL; END $$;` — wraps the statement in a block this console's own
 *     scanner deliberately does not read into, so it would move the chip by
 *     making the file LESS legible rather than safer. 40 statements across 13
 *     files.
 *
 * `CREATE PUBLICATION` and `CREATE ROLE` are refused on the same footing (no
 * guard; a drop removes live subscriptions, or fails where the role owns
 * anything). Neither appears in the prime's corpus today, and they are named
 * rather than left to fall through to "no mechanical repair", because an
 * absence with a reason is worth more than a silence.
 *
 * Constraints are the edge that was ARGUED rather than assumed. Dropping and
 * re-adding one revalidates the table, and a primary or unique key another
 * table references cannot be dropped at all — so on a second run the file can
 * still stop. It stops LOUDLY, having written nothing, which is the same band
 * it was already in; it never goes quiet. So the repair is offered, with that
 * cost stated on the row rather than discovered in review.
 *
 * ## Nothing is offered that was not proved
 *
 * A plan is not a list of intentions. The patched text is composed, re-scanned
 * and re-read by `assessIdempotency`, and the plan is DISCARDED unless:
 *
 *   - the patched body scans to exactly the statements the original had plus
 *     the ones this inserted — a count that is off means the surgery broke the
 *     parse, whatever the reading says;
 *   - the bytes account exactly — every edit is an INSERT, so the patched
 *     length is the original plus what was inserted and nothing was lost;
 *   - and the flagged count strictly FELL.
 *
 * A plan that fails any of those answers `unproven` and carries no patch. The
 * repository has paid twice for tests that agreed with the code while only the
 * server disagreed; a repair that cannot demonstrate its own effect is the
 * same mistake with a database at the end of it.
 *
 * ## What it reads over the prime's own corpus, 21 Sep 2026
 *
 * Over the 301 files `assessIdempotency` does not call re-runnable:
 *
 *      255  every flagged statement has a sound repair
 *       31  some do, some are refused
 *       15  none do
 *
 *     1,020 / 234  CREATE POLICY      → prepend DROP POLICY IF EXISTS
 *       333 /  91  CREATE INDEX       → IF NOT EXISTS
 *       222 /  97  CREATE TABLE       → IF NOT EXISTS
 *       180 /  99  CREATE TRIGGER     → prepend DROP TRIGGER IF EXISTS
 *        28 /  23  ADD COLUMN         → IF NOT EXISTS
 *        20 /  18  ADD CONSTRAINT     → prepend DROP CONSTRAINT IF EXISTS
 *        62 /  36  INSERT             → refused
 *        40 /  13  CREATE TYPE        → refused
 *
 * Two of those numbers are load-bearing beyond their size. Every guard repair
 * found its anchor in the original bytes — **0 anchor misses over all 1,913
 * flagged statements** — which is what makes surgery on the file defensible
 * rather than hopeful; and where it does not, the statement is refused as
 * `not_located` rather than patched at a guessed offset. And 1,904 of those
 * 1,913 statements are written with UPPER-CASE keywords, so the inserted text
 * takes the case of the keyword it attaches to. That is not a nicety: a
 * lower-case `if not exists` inside `CREATE TABLE` would be visible on every
 * line of every diff a reviewer reads.
 */
import {
  assessIdempotency,
  idempotencyWalk,
  scanSqlStatements,
  EXCERPT_CHARS,
  type IdempotencyReading,
  type SqlStatement,
} from "./primeMigrationDiagnosis.pure";

/** What a repair does to the file. */
export const REPAIR_KINDS = [
  "table",
  "index",
  "schema",
  "sequence",
  "extension",
  "materialized_view",
  "view",
  "function",
  "column",
  "enum_value",
  "policy",
  "trigger",
  "constraint",
  "bare_drop",
] as const;

export type RepairKind = (typeof REPAIR_KINDS)[number];

/** Why a flagged statement was left alone. */
export const REFUSAL_KINDS = [
  "insert",
  "type",
  "publication",
  "role",
  "unrecognised",
  "not_located",
] as const;

export type RefusalKind = (typeof REFUSAL_KINDS)[number];

export type Repair = {
  kind: RepairKind;
  /** 1-based line of the ORIGINAL file the statement starts on. */
  line: number;
  /** What this changes, in the operator's words. Never SQLSTATE. */
  what: string;
  /** The text inserted, exactly as it will appear. */
  inserted: string;
  /** The statement it attaches to, capped. */
  statement: string;
};

export type RepairRefusal = {
  kind: RefusalKind;
  line: number;
  excerpt: string;
  /** Why no mechanical repair exists for this one. */
  why: string;
};

export const REMEDY_OUTCOMES = [
  "healed",
  "improved",
  "nothing_to_do",
  "no_repair",
  "unreadable",
  "unproven",
] as const;

export type RemedyOutcome = (typeof REMEDY_OUTCOMES)[number];

/** Outcomes that carry a patch worth proposing. */
export const OFFERABLE_OUTCOMES: ReadonlySet<RemedyOutcome> = new Set<RemedyOutcome>([
  "healed",
  "improved",
]);

export function mayPropose(outcome: RemedyOutcome): boolean {
  return OFFERABLE_OUTCOMES.has(outcome);
}

/** Rows drawn on the page, capped so one file cannot fill it. */
export const REMEDY_ROWS = 8;

export type RemedyPlan = {
  outcome: RemedyOutcome;
  /** The reading before, from the same module the chip reads. */
  before: IdempotencyReading;
  /** The reading the patched body measures to. Equals `before` with no patch. */
  after: IdempotencyReading;
  /** The whole patched file, or null where there is nothing to offer. */
  patched: string | null;
  repairs: Repair[];
  repairCount: number;
  refusals: RepairRefusal[];
  refusalCount: number;
  /** One sentence for the operator. */
  summary: string;
  /** Why a composed patch was thrown away, where one was. */
  discarded: string | null;
};

/*
  ───────────────────────────────────────────────────────────────────────────
  Recognising the shape
  ───────────────────────────────────────────────────────────────────────────

  These match `headRaw` — the statement's leading words with the author's own
  casing and quoting kept, comments gone, whitespace collapsed, dollar-quoted
  bodies elided. `head` would lose `"Users can view their own rows"`, and a
  DROP composed from the lower-cased form names a policy that does not exist.

  The forms MIRROR `CREATE_FORMS` in the diagnosis module, in its order,
  because a statement that walk flags and this one does not recognise is
  reported as `unrecognised` — a refusal an operator can act on, and a signal
  that the two have drifted.
*/

const ID = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const QN = `${ID}(?:\\.${ID})*`;

/** A keyword run, or a name taken from the source as written. */
type DropPart = { kw: string } | { name: string };

type Family =
  | {
      act: "guard";
      kind: RepairKind;
      /** Located in the ORIGINAL slice. The token goes just past the match. */
      anchor: RegExp;
      token: string;
      /** Whether every occurrence in the statement is patched, or only the first. */
      every: boolean;
      what: string;
    }
  | { act: "prepend"; kind: RepairKind; parts: (m: RegExpExecArray) => DropPart[]; what: string }
  | { act: "refuse"; kind: RefusalKind; why: string };

/**
 * `every` is true only where one statement can legitimately create several
 * things — `ALTER TABLE t ADD COLUMN a …, ADD COLUMN b …` — and false
 * everywhere else on purpose. A `CREATE FUNCTION` body can contain its own
 * `CREATE`, and the slice this is applied to carries that body whole, so
 * patching every match would reach inside somebody's PL/pgSQL.
 */
const FAMILIES: ReadonlyArray<{ re: RegExp; family: Family }> = [
  {
    re: new RegExp(`^create\\s+table\\s+(${QN})`, "i"),
    family: {
      act: "guard",
      kind: "table",
      anchor: /\bcreate\s+table\s+/i,
      token: "if not exists ",
      every: false,
      what: "creates the table only where it is not already there",
    },
  },
  {
    re: new RegExp(`^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(${QN})\\s+on\\b`, "i"),
    family: {
      act: "guard",
      kind: "index",
      anchor: /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?/i,
      token: "if not exists ",
      every: false,
      what: "creates the index only where it is not already there",
    },
  },
  {
    re: new RegExp(`^create\\s+policy\\s+(${ID})\\s+on\\s+(${QN})`, "i"),
    family: {
      act: "prepend",
      kind: "policy",
      parts: (m) => [{ kw: "drop policy if exists" }, { name: m[1] }, { kw: "on" }, { name: m[2] }],
      what: "removes any policy of that name first, so the creation below always has room",
    },
  },
  {
    re: new RegExp(
      `^create\\s+(?:constraint\\s+)?trigger\\s+(${ID})\\b[\\s\\S]*?\\son\\s+(${QN})`,
      "i",
    ),
    family: {
      act: "prepend",
      kind: "trigger",
      parts: (m) => [
        { kw: "drop trigger if exists" },
        { name: m[1] },
        { kw: "on" },
        { name: m[2] },
      ],
      what: "removes any trigger of that name first, so the creation below always has room",
    },
  },
  {
    re: new RegExp(`^create\\s+type\\s+(${QN})`, "i"),
    family: {
      act: "refuse",
      kind: "type",
      why:
        "Postgres gives CREATE TYPE no IF NOT EXISTS, and dropping the type first would take " +
        "every column declared with it. There is no edit to this file that is both safe and " +
        "readable — the type has to be reconciled by hand.",
    },
  },
  {
    re: new RegExp(`^create\\s+schema\\s+(${QN})`, "i"),
    family: {
      act: "guard",
      kind: "schema",
      anchor: /\bcreate\s+schema\s+/i,
      token: "if not exists ",
      every: false,
      what: "creates the schema only where it is not already there",
    },
  },
  {
    re: new RegExp(`^create\\s+sequence\\s+(${QN})`, "i"),
    family: {
      act: "guard",
      kind: "sequence",
      anchor: /\bcreate\s+sequence\s+/i,
      token: "if not exists ",
      every: false,
      what: "creates the sequence only where it is not already there",
    },
  },
  {
    re: new RegExp(`^create\\s+materialized\\s+view\\s+(${QN})`, "i"),
    family: {
      act: "guard",
      kind: "materialized_view",
      anchor: /\bcreate\s+materialized\s+view\s+/i,
      token: "if not exists ",
      every: false,
      what: "creates the materialized view only where it is not already there",
    },
  },
  {
    re: new RegExp(`^create\\s+view\\s+(${QN})`, "i"),
    family: {
      act: "guard",
      kind: "view",
      anchor: /\bcreate\s+/i,
      token: "or replace ",
      every: false,
      what: "replaces the view where it is already there rather than failing",
    },
  },
  {
    re: new RegExp(`^create\\s+extension\\s+(${QN})`, "i"),
    family: {
      act: "guard",
      kind: "extension",
      anchor: /\bcreate\s+extension\s+/i,
      token: "if not exists ",
      every: false,
      what: "installs the extension only where it is not already there",
    },
  },
  {
    re: new RegExp(`^create\\s+publication\\s+(${QN})`, "i"),
    family: {
      act: "refuse",
      kind: "publication",
      why:
        "Postgres gives CREATE PUBLICATION no IF NOT EXISTS, and dropping it first would " +
        "disconnect every subscription reading from it.",
    },
  },
  {
    re: new RegExp(`^create\\s+(?:role|user)\\s+(${QN})`, "i"),
    family: {
      act: "refuse",
      kind: "role",
      why:
        "Postgres gives CREATE ROLE no IF NOT EXISTS, and dropping a role first fails wherever " +
        "it owns anything — which on a database that has run this once, it does.",
    },
  },
  {
    re: new RegExp(`^create\\s+(?:function|procedure)\\s+(${QN})`, "i"),
    family: {
      act: "guard",
      kind: "function",
      anchor: /\bcreate\s+/i,
      token: "or replace ",
      every: false,
      what: "replaces the function where it is already there rather than failing",
    },
  },
  {
    re: new RegExp(
      `^alter\\s+table\\s+(if\\s+exists\\s+)?(?:only\\s+)?(${QN})[\\s\\S]*?\\badd\\s+constraint\\s+(${ID})`,
      "i",
    ),
    family: {
      act: "prepend",
      kind: "constraint",
      parts: (m) => [
        { kw: "alter table" },
        ...(m[1] ? [{ kw: "if exists" } as DropPart] : []),
        { name: m[2] },
        { kw: "drop constraint if exists" },
        { name: m[3] },
      ],
      what:
        "removes any constraint of that name first. Re-adding one revalidates the whole table, " +
        "and a key another table references cannot be dropped at all — so a second run can still " +
        "stop here, loudly, having written nothing",
    },
  },
  {
    re: new RegExp(
      `^alter\\s+table\\s+[\\s\\S]*?\\badd\\s+column\\s+(?!if\\s+not\\s+exists)(${ID})`,
      "i",
    ),
    family: {
      act: "guard",
      kind: "column",
      anchor: /\badd\s+column\s+(?!if\s+not\s+exists\b)/i,
      token: "if not exists ",
      // One ALTER TABLE may add several columns, and this is an ALTER — it
      // carries no body a `CREATE` could be hiding in.
      every: true,
      what: "adds the column only where it is not already there",
    },
  },
  {
    re: new RegExp(`^alter\\s+type\\s+(${QN})\\s+add\\s+value\\s+'`, "i"),
    family: {
      act: "guard",
      kind: "enum_value",
      anchor: /\badd\s+value\s+(?!if\s+not\s+exists\b)/i,
      token: "if not exists ",
      every: false,
      what: "adds the value only where the type does not already have it",
    },
  },
  {
    re: /^drop\s+(table|index|policy|trigger|type|schema|sequence|materialized\s+view|view|extension|publication|function|procedure|role|user)\b(?![\s\S]*\bif\s+exists\b)/i,
    family: {
      act: "guard",
      kind: "bare_drop",
      // Rebuilt per match below, because the object word is part of the anchor.
      anchor: /\bdrop\s+/i,
      token: "if exists ",
      every: false,
      what: "removes it only where it is still there",
    },
  },
  {
    re: /^alter\s+table\b[\s\S]*?\bdrop\s+(constraint|column)\s+(?!if\s+exists\b)/i,
    family: {
      act: "guard",
      kind: "bare_drop",
      anchor: /\bdrop\s+(?:constraint|column)\s+(?!if\s+exists\b)/i,
      token: "if exists ",
      every: true,
      what: "removes it only where it is still there",
    },
  },
  {
    re: /^insert\s+into\b/i,
    family: {
      act: "refuse",
      kind: "insert",
      why:
        "The only edit that would move the reading is ON CONFLICT DO NOTHING, and on a table " +
        "with no unique constraint covering these rows that clause is legal, never errors, and " +
        "still inserts the duplicate. This console cannot see the constraint from the file, so " +
        "offering it would change the indicator without changing what happens.",
    },
  },
];

/** The one bare-drop form whose anchor depends on which object word was used. */
const BARE_DROP_WORD =
  /^drop\s+(table|index|policy|trigger|type|schema|sequence|materialized\s+view|view|extension|publication|function|procedure|role|user)\b/i;

function familyFor(headRaw: string): { family: Family; match: RegExpExecArray } | null {
  for (const f of FAMILIES) {
    const m = f.re.exec(headRaw);
    if (!m) continue;
    if (f.family.act === "guard" && f.family.kind === "bare_drop") {
      const word = BARE_DROP_WORD.exec(headRaw)?.[1];
      if (word) {
        const escaped = word.replace(/\s+/g, String.raw`\s+`);
        return {
          family: { ...f.family, anchor: new RegExp(`\\bdrop\\s+${escaped}\\s+`, "i") },
          match: m,
        };
      }
    }
    return { family: f.family, match: m };
  }
  return null;
}

/*
  ───────────────────────────────────────────────────────────────────────────
  Writing it back
  ───────────────────────────────────────────────────────────────────────────
*/

/** The inserted keywords take the case of the keyword they attach to. */
function cased(sample: string, token: string): string {
  const letters = sample.replace(/[^A-Za-z]/g, "");
  return letters.length > 0 && letters === letters.toUpperCase() ? token.toUpperCase() : token;
}

function renderDrop(parts: readonly DropPart[], upper: boolean): string {
  return `${parts.map((p) => ("kw" in p ? (upper ? p.kw.toUpperCase() : p.kw) : p.name)).join(" ")};`;
}

/** The whitespace at the start of the line `at` sits on, where it is all whitespace. */
function indentAt(sql: string, at: number): string {
  const nl = sql.lastIndexOf("\n", at - 1);
  const lead = sql.slice(nl + 1, at);
  return /^[ \t]*$/.test(lead) ? lead : "";
}

type Edit = { at: number; text: string };

const excerpt = (text: string) =>
  text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS - 1)}…`;

/** Whether a composed patch may be offered, and why not where it may not. */
export type PatchProof = { held: true } | { held: false; why: string };

/**
 * Re-read a composed patch and decide whether it did what it promised.
 *
 * Separate from the planner and exported, for two reasons. It is the one step
 * whose whole job is to catch a bug in the step before it, and a check that
 * can only be reached through the code it is checking is a check nobody can
 * demonstrate: planted against the shipped planner, removing this branch broke
 * no test, because every family it plans happens to be sound. That is the
 * vacuous gate this repository has paid for twice, and the remedy both times
 * was to make the rule reachable on its own.
 *
 * Three questions, and each one has a different bug behind it:
 *
 *   - **Did the bytes account?** Every edit is an insertion, so the patched
 *     length is the original plus what was inserted. Anything else means an
 *     offset was wrong and something was overwritten.
 *   - **Does it still parse into the statements it had?** A guard dropped in
 *     the wrong place can leave valid-looking text that splits differently,
 *     and a reading taken over the wrong statements is worse than no reading.
 *   - **Is it actually better?** Measured with the same module the chip reads,
 *     rather than inferred from the fact that repairs were planned.
 */
export function proveRepair(args: {
  original: string;
  patched: string;
  insertedBytes: number;
  /** How many whole statements the patch adds. */
  prepends: number;
}): PatchProof {
  const { original, patched, insertedBytes, prepends } = args;

  if (patched.length !== original.length + insertedBytes) {
    return {
      held: false,
      why: "the patched file did not come to the length its own edits account for",
    };
  }

  const before = scanSqlStatements(original);
  const after = scanSqlStatements(patched);
  const expected = before.length + prepends;
  if (after.length !== expected) {
    return {
      held: false,
      why: `the patched file reads as ${after.length} statements where ${expected} were expected`,
    };
  }

  const b = assessIdempotency(before);
  const a = assessIdempotency(after);
  if (a.collideCount + a.rewriteCount >= b.collideCount + b.rewriteCount) {
    return {
      held: false,
      why: "re-reading the patched file found no fewer statements that would stop or rewrite on a second run",
    };
  }

  return { held: true };
}

/**
 * Plan every repair this file admits, compose them, and prove the result.
 *
 * Takes null for a body nobody read, because the alternative is a page that
 * cannot tell "this file needs nothing" from "we never opened it" — the same
 * distinction `assessIdempotency` refuses to collapse one module up.
 */
export function planMigrationRepair(sql: string | null): RemedyPlan {
  if (sql === null) {
    return blank(
      "unreadable",
      "unreadable",
      "unreadable",
      "The file was not read here, so there is nothing to repair and nothing to say about it.",
    );
  }

  const statements = scanSqlStatements(sql);
  const first = assessIdempotency(statements);

  if (first.reading === "rerunnable") {
    return blank(
      "nothing_to_do",
      "rerunnable",
      "rerunnable",
      "Every statement in this file is already written to be repeated. There is nothing to repair.",
    );
  }

  const { flags } = idempotencyWalk(statements);
  const repairs: Repair[] = [];
  const refusals: RepairRefusal[] = [];
  const edits: Edit[] = [];
  let repairCount = 0;
  let refusalCount = 0;
  let prepends = 0;

  const refuse = (s: SqlStatement, kind: RefusalKind, why: string) => {
    refusalCount += 1;
    if (refusals.length < REMEDY_ROWS)
      refusals.push({ kind, line: s.line, excerpt: excerpt(s.text), why });
  };
  const repair = (r: Repair) => {
    repairCount += 1;
    if (repairs.length < REMEDY_ROWS) repairs.push(r);
  };

  for (const flag of flags) {
    const s = statements[flag.index];
    const found = familyFor(s.headRaw);

    if (!found) {
      refuse(
        s,
        "unrecognised",
        "This console read the statement as one whose second run would not be a no-op, and has " +
          "no mechanical repair written for its shape.",
      );
      continue;
    }

    const { family, match } = found;

    if (family.act === "refuse") {
      refuse(s, family.kind, family.why);
      continue;
    }

    const slice = sql.slice(s.start, s.end);

    if (family.act === "prepend") {
      const parts = family.parts(match);
      /*
        Every regex above requires the groups its parts read, so this cannot
        fire today. It is here because the failure if one ever stopped
        requiring one is a `DROP POLICY IF EXISTS undefined ON t;` committed
        to the prime — and the whole module's rule is that a repair which
        cannot name what it is guarding is refused rather than guessed.
      */
      if (parts.some((part) => "name" in part && !part.name)) {
        refuse(
          s,
          "not_located",
          "The object this statement creates could not be named from the file, so there is " +
            "nothing to write a guard against.",
        );
        continue;
      }
      const lead = /^[A-Za-z]+/.exec(s.headRaw)?.[0] ?? "";
      const upper = lead.length > 0 && lead === lead.toUpperCase();
      const drop = renderDrop(parts, upper);
      const indent = indentAt(sql, s.start);
      edits.push({ at: s.start, text: `${drop}\n${indent}` });
      prepends += 1;
      repair({
        kind: family.kind,
        line: s.line,
        what: family.what,
        inserted: drop,
        statement: excerpt(s.text),
      });
      continue;
    }

    // family.act === "guard"
    const re = new RegExp(family.anchor.source, family.every ? "gi" : "i");
    const hits: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
      hits.push(m);
      if (!family.every) break;
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }

    if (hits.length === 0) {
      // The shape was recognised in the collapsed head and could not be found
      // in the bytes — a comment between the keywords, most likely. Refused
      // rather than patched at a guessed offset. Measured at 0 over the whole
      // prime corpus, and kept because "measured 0" is not "cannot happen".
      refuse(
        s,
        "not_located",
        "The statement's keywords could not be found in the file exactly as written — a comment " +
          "between them, most likely — so there is nowhere to put the guard without guessing.",
      );
      continue;
    }

    const token = cased(hits[0][0], family.token);
    for (const hit of hits) edits.push({ at: s.start + hit.index + hit[0].length, text: token });
    repair({
      kind: family.kind,
      line: s.line,
      what: family.what,
      inserted: token.trim(),
      statement: excerpt(s.text),
    });
  }

  if (edits.length === 0) {
    return {
      outcome: "no_repair",
      before: first.reading,
      after: first.reading,
      patched: null,
      repairs,
      repairCount,
      refusals,
      refusalCount,
      summary:
        refusalCount > 0
          ? `Nothing here can be repaired mechanically: all ${refusalCount} statement${refusalCount === 1 ? "" : "s"} that would stop or rewrite on a second run need a person.`
          : "Nothing here could be repaired mechanically.",
      discarded: null,
    };
  }

  const inserted = edits.reduce((n, e) => n + e.text.length, 0);
  const patched = applyEdits(sql, edits);

  const proof = proveRepair({ original: sql, patched, insertedBytes: inserted, prepends });
  const second = assessIdempotency(scanSqlStatements(patched));
  const failure = proof.held ? null : proof.why;

  if (failure) {
    return {
      outcome: "unproven",
      before: first.reading,
      after: first.reading,
      patched: null,
      repairs,
      repairCount,
      refusals,
      refusalCount,
      summary:
        "A repair was composed for this file and then thrown away, because re-reading it did not " +
        "show the change it promised. Nothing is offered.",
      discarded: failure,
    };
  }

  const healed = second.reading === "rerunnable";

  return {
    outcome: healed ? "healed" : "improved",
    before: first.reading,
    after: second.reading,
    patched,
    repairs,
    repairCount,
    refusals,
    refusalCount,
    summary: healed
      ? `${repairCount} statement${repairCount === 1 ? "" : "s"} would be guarded, after which running this file a second time changes nothing.`
      : `${repairCount} statement${repairCount === 1 ? "" : "s"} would be guarded, and ${refusalCount} need${refusalCount === 1 ? "s" : ""} a person. This file would still not be safe to run twice.`,
    discarded: null,
  };
}

/** Insertions only, applied from the end so earlier offsets stay true. */
function applyEdits(sql: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.at - a.at || b.text.localeCompare(a.text));
  let out = sql;
  for (const e of ordered) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

function blank(
  outcome: RemedyOutcome,
  before: IdempotencyReading,
  after: IdempotencyReading,
  summary: string,
): RemedyPlan {
  return {
    outcome,
    before,
    after,
    patched: null,
    repairs: [],
    repairCount: 0,
    refusals: [],
    refusalCount: 0,
    summary,
    discarded: null,
  };
}
