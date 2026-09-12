// Pure destructiveness analysis for SQL that the self-healing pipeline wants
// to run against a tenant project. A migration the pipeline applies on its
// own must not be able to destroy data or quietly widen access — anything
// this module flags routes to a human instead of executing.
//
// This is a guardrail, not a SQL parser: it works on comment- and
// string-stripped statements, and it deliberately errs toward flagging.
// A false positive costs one human approval; a false negative costs a
// tenant's table.

export type SqlRiskFinding = {
  /** First 200 chars of the offending statement, for the approval UI. */
  statement: string;
  reason: string;
};

export type SqlRiskAssessment = {
  destructive: boolean;
  findings: SqlRiskFinding[];
  statementCount: number;
};

/**
 * Remove comments, string literals and dollar-quoted bodies so keyword
 * checks can't be fooled by (or false-positive on) text inside them.
 * Literal content is replaced with a space; statement structure survives.
 */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    // Line comment
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      out += " ";
      continue;
    }
    // Block comment (no nesting — postgres nests, but flagging early is fine)
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
      continue;
    }
    // Dollar-quoted string: $tag$ ... $tag$
    if (sql[i] === "$") {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " ";
        continue;
      }
    }
    // Single-quoted string with '' escape
    if (sql[i] === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * A Postgres identifier as it can appear in a statement: bare, or
 * double-quoted (which may contain dots, spaces and `""` escapes).
 */
const SQL_IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

type Rule = { pattern: RegExp; reason: string };

// Order matters only for readability; every rule runs on every statement.
const DESTRUCTIVE_RULES: Rule[] = [
  { pattern: /\bDROP\s+DATABASE\b/i, reason: "drops a database" },
  { pattern: /\bDROP\s+SCHEMA\b/i, reason: "drops a schema" },
  { pattern: /\bDROP\s+TABLE\b/i, reason: "drops a table" },
  { pattern: /\bDROP\s+(OWNED|ROLE|USER)\b/i, reason: "drops a role or role-owned objects" },
  { pattern: /\bTRUNCATE\b/i, reason: "truncates a table" },
  {
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i,
    reason: "drops a column",
  },
  {
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
    reason: "disables row-level security",
  },
  {
    pattern: /\bGRANT\b[\s\S]*\bTO\s+(anon|public)\b/i,
    reason: "grants privileges to anon/public",
  },
  { pattern: /\bALTER\s+ROLE\b/i, reason: "alters a role" },
  {
    pattern: /\bALTER\s+(TABLE|COLUMN)\b[\s\S]*\bTYPE\b/i,
    reason: "rewrites a column type (potentially lossy cast)",
  },
];

/** DELETE/UPDATE with no WHERE clause hit every row in the table. */
function checkUnboundedWrite(statement: string): string | null {
  const isDelete = /^\s*DELETE\s+FROM\b/i.test(statement);
  const isUpdate = /^\s*UPDATE\b/i.test(statement);
  if (!isDelete && !isUpdate) return null;
  if (/\bWHERE\b/i.test(statement)) return null;
  return isDelete ? "DELETE without WHERE" : "UPDATE without WHERE";
}

/**
 * An identifier as Postgres itself reads one: unquoted folds to lower case,
 * quoted keeps its exact spelling (with `""` unescaped).
 */
function normaliseIdentifier(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"');
  }
  return t.toLowerCase();
}

/** `public.users` / `"My Table"` / `t` → one comparable string, or null. */
function normaliseTableRef(raw: string): string | null {
  const parts = raw.match(new RegExp(SQL_IDENTIFIER, "g"));
  if (!parts || parts.length === 0) return null;
  return parts.map(normaliseIdentifier).join(".");
}

/** Every `(policy, table)` pair the script brings back. */
function collectCreatedPolicies(wholeScript: string): Set<string> {
  const created = new Set<string>();
  const rx = new RegExp(
    String.raw`\bCREATE\s+POLICY\s+(${SQL_IDENTIFIER})\s+ON\s+(${SQL_IDENTIFIER}(?:\s*\.\s*${SQL_IDENTIFIER})?)`,
    "gi",
  );
  for (const m of wholeScript.matchAll(rx)) {
    const table = normaliseTableRef(m[2]);
    if (table) created.add(`${normaliseIdentifier(m[1])}\u0000${table}`);
  }
  return created;
}

/**
 * `DROP POLICY …; CREATE POLICY …` on the SAME policy is the house idiom for
 * making an RLS migration re-runnable, and it removes nothing: after the pair
 * the table carries the policy it started with.
 *
 * Measured over the prime's corpus — 1,222 `DROP POLICY` statements across 150
 * files — 575 are exactly that shape. Flagging them cost more than one
 * approval: the SQL lane parks the WHOLE batch on any finding, so a single
 * `IF EXISTS` guard held sixteen migrations, fifteen of them untouched by it.
 *
 * The exemption is deliberately TIGHTER than the one
 * {@link checkDropWithoutRecreate} gives a function, trigger or view. Those ask
 * only whether the script creates SOMETHING of that kind. For a policy that is
 * not good enough, because a policy IS the access boundary: `DROP p1 … CREATE
 * p2` passes a kind-only test while leaving the table governed by a different
 * rule. So the same policy NAME on the same TABLE has to come back, and the
 * remaining 647 — which replace a policy with a differently-named one — stay
 * flagged, as they should.
 *
 * Matching is on the reference exactly as written, normalised the way Postgres
 * normalises identifiers. A bare `t` is therefore not the same table as
 * `public.t`: measured, no migration in the corpus turns on that distinction
 * (0 of 1,222 matched on the bare name alone), and being wrong in that
 * direction costs one human approval rather than a tenant's access boundary.
 *
 * A statement this cannot parse is flagged rather than exempted.
 */
function checkDroppedPolicy(statement: string, createdPolicies: Set<string>): string | null {
  if (!/\bDROP\s+POLICY\b/i.test(statement)) return null;
  const m = new RegExp(
    String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${SQL_IDENTIFIER})\s+ON\s+(${SQL_IDENTIFIER}(?:\s*\.\s*${SQL_IDENTIFIER})?)`,
    "i",
  ).exec(statement);
  if (!m) return "drops a row-level-security policy";
  const table = normaliseTableRef(m[2]);
  if (!table) return "drops a row-level-security policy";
  if (createdPolicies.has(`${normaliseIdentifier(m[1])}\u0000${table}`)) return null;
  return "drops a row-level-security policy without recreating it";
}

/**
 * DROP FUNCTION / DROP TRIGGER / DROP VIEW are routine in idempotent
 * migrations when the same script recreates the object. Only flag them
 * when the script does not.
 */
function checkDropWithoutRecreate(statement: string, wholeScript: string): string | null {
  if (/\bDROP\s+(FUNCTION|TRIGGER|VIEW)\b/i.test(statement)) {
    const kind = /\bDROP\s+(FUNCTION|TRIGGER|VIEW)\b/i.exec(statement)![1].toUpperCase();
    const recreates = new RegExp(
      `\\bCREATE\\s+(OR\\s+REPLACE\\s+)?(CONSTRAINT\\s+)?${kind}\\b`,
      "i",
    );
    if (!recreates.test(wholeScript)) {
      return `drops a ${kind.toLowerCase()} without recreating it`;
    }
  }
  return null;
}

export function assessSqlDestructiveness(sql: string): SqlRiskAssessment {
  const stripped = stripSqlLiterals(sql);
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Built once for the whole script: the policy check runs per statement and
  // a script can carry dozens of them.
  const createdPolicies = collectCreatedPolicies(stripped);

  const findings: SqlRiskFinding[] = [];
  for (const statement of statements) {
    const excerpt = statement.replace(/\s+/g, " ").slice(0, 200);
    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.pattern.test(statement)) {
        findings.push({ statement: excerpt, reason: rule.reason });
      }
    }
    const unbounded = checkUnboundedWrite(statement);
    if (unbounded) findings.push({ statement: excerpt, reason: unbounded });
    const dropped = checkDropWithoutRecreate(statement, stripped);
    if (dropped) findings.push({ statement: excerpt, reason: dropped });
    const droppedPolicy = checkDroppedPolicy(statement, createdPolicies);
    if (droppedPolicy) findings.push({ statement: excerpt, reason: droppedPolicy });
  }

  return {
    destructive: findings.length > 0,
    findings,
    statementCount: statements.length,
  };
}
