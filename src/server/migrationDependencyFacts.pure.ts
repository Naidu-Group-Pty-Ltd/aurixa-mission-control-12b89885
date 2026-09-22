/**
 * What a migration CREATES, and what it REQUIRES already to exist.
 *
 * Two sets per file, read from its SQL, so a hole in the corpus can be asked
 * the only question that matters about it: does anything after it actually
 * depend on it?
 *
 * ## The defect this exists for
 *
 * `partitionByDependency` orphans EVERY runnable migration that follows the
 * first hole. That was deliberate and it was right about the danger — a
 * migration whose dependency was withheld fails on the clone, which is the
 * `20261027010000` / `20260712000000` incident its own header records. It is
 * wrong about the blast radius, and on a thinly-stamped clone the difference
 * is total rather than marginal.
 *
 * Measured 22 Sep 2026 on `qvuwrvwzjyigptmnijyb` (the CRM clone), against the
 * prime's 1,021-file corpus and that clone's live ledger:
 *
 *     blanket (today)   would_send    0 | orphaned  35
 *     per-dependency    would_send   34 | orphaned   1
 *
 * Its first hole is at corpus ordinal **1**, and it is
 * `20250124120000_fix_client_data_rls_policies.sql` — a policy fix from
 * January 2025. Nothing at ordinal 500 depends on it, and nothing ever could:
 * it creates no object any later file can name. Under the blanket rule that
 * one file has shut that clone's cascade since it was provisioned.
 *
 * The one migration still orphaned is orphaned for a reason anybody can read:
 * `20260921060000` requires `market_updates`, `market_ingestion_runs` and
 * `market_source_fetch_runs`, and those are created by the holes
 * `20260703000000` and `20260725010000`. That is the incident class, correctly
 * caught, with the blast radius it actually has.
 *
 * ## It is the prime's own extractor
 *
 * `scripts/lib/migrationDependencyOrder.mjs` on the prime already computes
 * exactly this, runs in that repository's CI, and has paid for every rule in
 * it. This is a port of the two functions the barrier needs, not a second
 * opinion — the forms, the foreign-schema list and the refusals are its.
 * Three of those refusals are load-bearing and each was measured there rather
 * than assumed:
 *
 *   - **A PL/pgSQL body is not a reference.** A function body is stored as
 *     text and resolved when it runs, so a body naming a table created later
 *     is correct and common. Comments and string literals go the same way.
 *     {@link stripUnresolved} blanks all four before anything is read.
 *   - **`if exists` is not a requirement.** `drop policy if exists p on t`
 *     SUCCEEDS when `t` does not exist — the guard covers the relation, not
 *     just the policy — and reading it the other way produced 88 findings on
 *     the prime's corpus, every one wrong.
 *   - **A foreign schema is evidence of nothing.** Nothing in either
 *     repository creates `cron.job` or `auth.users`.
 *
 * ## An unknown object never blocks
 *
 * This answers what a file NAMES, never whether the name resolves. The
 * decision that uses it — {@link partitionByDependency} — intersects a
 * candidate's requirements with a hole's creations, so a name no hole creates
 * contributes nothing. That is the conservative direction: an extractor that
 * misses a reference falls back to sending, which is the behaviour of every
 * migration ahead of the first hole today; an extractor that invents one
 * orphans a file that would have been sent, which is the behaviour of every
 * migration behind it today. Neither is new, and the second is what this
 * replaces.
 */

/**
 * Schemas an extension or the platform owns. A reference to one is not
 * evidence of anything.
 */
const FOREIGN_SCHEMAS = new Set([
  "auth",
  "storage",
  "extensions",
  "vault",
  "graphql",
  "graphql_public",
  "realtime",
  "supabase_functions",
  "supabase_migrations",
  "pgsodium",
  "pgbouncer",
  "cron",
  "net",
  "pg_catalog",
  "information_schema",
  "pgtle",
]);

/** Words a loose form can sweep up that are not object names. */
const NOT_A_NAME = /^(select|values|only|table|public|current_user|session_user)$/;

const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*`;

/**
 * Blank every span the planner does not resolve — line comments, block
 * comments (which nest in Postgres), single-quoted literals and dollar-quoted
 * bodies — keeping the source's length so nothing downstream shifts.
 *
 * One left-to-right scan rather than a regex per form, because these forms
 * contain each other: a `--` inside a string is not a comment and a `'` inside
 * a dollar-quoted body is not a string, and a regex per form gets that wrong
 * in both directions.
 */
export function stripUnresolved(src: string): string {
  const n = src.length;
  const spans: Array<[number, number]> = [];
  let i = 0;

  while (i < n) {
    const c = src.charCodeAt(i);

    // `--` to end of line
    if (c === 45 && src.charCodeAt(i + 1) === 45) {
      let end = src.indexOf("\n", i);
      if (end === -1) end = n;
      spans.push([i, end]);
      i = end;
      continue;
    }

    // `/* … */`, nesting
    if (c === 47 && src.charCodeAt(i + 1) === 42) {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        const open = src.indexOf("/*", j);
        const close = src.indexOf("*/", j);
        if (close === -1) {
          j = n;
          break;
        }
        if (open !== -1 && open < close) {
          depth += 1;
          j = open + 2;
          continue;
        }
        depth -= 1;
        j = close + 2;
      }
      spans.push([i, j]);
      i = j;
      continue;
    }

    // `'…'`, with `''` as an escaped quote
    if (c === 39) {
      let j = i + 1;
      for (;;) {
        const q = src.indexOf("'", j);
        if (q === -1) {
          j = n;
          break;
        }
        if (src.charCodeAt(q + 1) === 39) {
          j = q + 2;
          continue;
        }
        j = q + 1;
        break;
      }
      spans.push([i, j]);
      i = j;
      continue;
    }

    // `$tag$ … $tag$`
    if (c === 36) {
      let j = i + 1;
      while (j < n) {
        const k = src.charCodeAt(j);
        const word =
          (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95;
        if (!word) break;
        j += 1;
      }
      if (src.charCodeAt(j) === 36) {
        const tag = src.slice(i, j + 1);
        const close = src.indexOf(tag, j + 1);
        const end = close === -1 ? n : close + tag.length;
        spans.push([i, end]);
        i = end;
        continue;
      }
    }

    i += 1;
  }

  if (spans.length === 0) return src;

  const parts: string[] = [];
  let prev = 0;
  for (const [from, to] of spans) {
    if (from > prev) parts.push(src.slice(prev, from));
    parts.push(src.slice(from, to).replace(/[^\n]/g, " "));
    prev = to;
  }
  if (prev < n) parts.push(src.slice(prev));
  return parts.join("");
}

/**
 * One object name, as both sides of a comparison must spell it: unquoted,
 * lower-cased, with a leading `public.` dropped because a bare name and a
 * `public.`-qualified one are the same object.
 */
export function canonicalObjectName(raw: string): string {
  const parts = raw
    .split(".")
    .map((p) => p.replace(/"/g, "").trim().toLowerCase())
    .filter(Boolean);
  if (parts.length > 1 && parts[0] === "public") parts.shift();
  return parts.join(".");
}

const schemaOf = (raw: string): string | null => {
  const parts = raw.split(".").map((p) => p.replace(/"/g, "").trim().toLowerCase());
  return parts.length > 1 ? parts[0] : null;
};

const CREATE_RE = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temp\s+|temporary\s+|unrecoverable\s+)?(?:unique\s+)?` +
    String.raw`(materialized\s+view|table|view|function|procedure|sequence|type|schema|index|trigger)\s+` +
    String.raw`(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${NAME})`,
  "gi",
);

/**
 * The forms Postgres resolves AT THE STATEMENT.
 *
 * `if exists` / `if not exists` variants are deliberately absent: a statement
 * that tolerates the object's absence does not require its presence.
 */
const REQUIREMENT_FORMS: readonly RegExp[] = [
  new RegExp(String.raw`\balter\s+table\s+(?!if\s+exists\b)(?:only\s+)?(${NAME})`, "gi"),
  new RegExp(String.raw`\balter\s+(?:materialized\s+)?view\s+(?!if\s+exists\b)(${NAME})`, "gi"),
  new RegExp(String.raw`\balter\s+sequence\s+(?!if\s+exists\b)(${NAME})`, "gi"),
  new RegExp(String.raw`\balter\s+type\s+(?!if\s+exists\b)(${NAME})`, "gi"),
  new RegExp(
    String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${NAME}\s+)?on\s+(?:only\s+)?(${NAME})`,
    "gi",
  ),
  new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+${NAME}\s+(?:before|after|instead\s+of)\b[\s\S]{0,200}?\bon\s+(${NAME})`,
    "gi",
  ),
  new RegExp(
    String.raw`\bcreate\s+policy\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+on\s+(${NAME})`,
    "gi",
  ),
  new RegExp(
    String.raw`\bdrop\s+policy\s+(?!if\s+exists\b)(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+on\s+(${NAME})`,
    "gi",
  ),
  new RegExp(String.raw`\breferences\s+(${NAME})`, "gi"),
  new RegExp(String.raw`\binsert\s+into\s+(${NAME})`, "gi"),
  new RegExp(String.raw`\bupdate\s+(?:only\s+)?(${NAME})\s+set\b`, "gi"),
  new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?(${NAME})`, "gi"),
  new RegExp(
    String.raw`\bcomment\s+on\s+(?:table|view|column|function|index|type|sequence|constraint\s+${NAME}\s+on)\s+(${NAME})`,
    "gi",
  ),
  new RegExp(
    String.raw`\bgrant\s+[\s\S]{1,120}?\bon\s+(?:table\s+|sequence\s+|function\s+|all\s+tables\s+in\s+schema\s+)?(${NAME})\s+to\b`,
    "gi",
  ),
];

export type MigrationDependencyFacts = {
  /** Object names this migration creates, canonical and de-duplicated. */
  readonly creates: readonly string[];
  /** Object names it resolves at the statement, canonical and de-duplicated. */
  readonly requires: readonly string[];
};

/** Nothing named either way. The answer for a body that could not be read. */
export const NO_DEPENDENCY_FACTS: MigrationDependencyFacts = Object.freeze({
  creates: Object.freeze([]) as readonly string[],
  requires: Object.freeze([]) as readonly string[],
});

/**
 * Read one migration's SQL for the two sets.
 *
 * Both are name sets and neither carries a class: the decision this feeds
 * intersects them, and a name that two kinds of object share is a name a
 * migration could legitimately be waiting for either way.
 */
export function dependencyFactsOf(sql: string): MigrationDependencyFacts {
  if (typeof sql !== "string" || sql === "") return NO_DEPENDENCY_FACTS;
  const resolved = stripUnresolved(sql);

  const creates = new Set<string>();
  CREATE_RE.lastIndex = 0;
  for (const m of resolved.matchAll(CREATE_RE)) {
    const name = canonicalObjectName(m[2] ?? "");
    if (name) creates.add(name);
  }

  const requires = new Set<string>();
  for (const re of REQUIREMENT_FORMS) {
    re.lastIndex = 0;
    for (const m of resolved.matchAll(re)) {
      const raw = m[1] ?? "";
      const schema = schemaOf(raw);
      if (schema && FOREIGN_SCHEMAS.has(schema)) continue;
      const name = canonicalObjectName(raw);
      if (!name || NOT_A_NAME.test(name)) continue;
      requires.add(name);
    }
  }

  return { creates: [...creates], requires: [...requires] };
}
