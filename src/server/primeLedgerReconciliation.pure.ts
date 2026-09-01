/**
 * Is a migration the prime's ledger does not record nonetheless ALREADY TRUE
 * of the prime's database?
 *
 * ## Why the question has to be asked at all
 *
 * `fleetCorpusScope.pure.ts` treats the prime's ledger as the authority on
 * what the prime has run, and clones are sent only what it records. That rule
 * is right — it is what stopped two `rollback_*` scripts undoing an RLS fix on
 * a tenant. But the ledger is a poor witness for the thing it is being asked
 * about, and this is measurable rather than arguable:
 *
 *   - The prime's database HAS `ensure_builder_stock_settlement_scheduled()`
 *     (`pg_proc` = 1). Its ledger does NOT record
 *     `20261012000000_builder_stock_auto_source_drain.sql`, the migration that
 *     creates it. The prime ran the file; the ledger missed it.
 *   - 481 of the prime's 890 ledger rows carry an EMPTY `name` and a version
 *     that matches no repo file — Lovable stamps its own apply timestamp. The
 *     repo holds `20250912170521` where the ledger holds `20250912050519`:
 *     twelve hours apart, and no column relates them.
 *   - Of 64 repo migrations after `20260831060152`, the ledger records 6.
 *
 * So "absent from the ledger" conflates two very different states: a migration
 * the prime deliberately never ran (a rollback script, future-dated work), and
 * one it ran under an id nothing wrote down. The first must stay withheld
 * forever. The second is the reason clones cannot advance.
 *
 * ## What this module does, and what it refuses to do
 *
 * It reads the SQL and asks the prime's live catalog whether the objects that
 * SQL creates are already there. That is evidence about the schema — the thing
 * we actually care about — rather than about the bookkeeping.
 *
 * It is deliberately only EVIDENCE. Nothing here stamps a ledger, and the
 * verdicts are named so they cannot be mistaken for permission:
 *
 *   - `satisfied`     every object it creates already exists on the prime
 *   - `unsatisfied`   at least one does not — the prime has NOT run this
 *   - `indeterminate` the SQL creates nothing this module can name
 *
 * `indeterminate` is the important one and is never merged into `satisfied`.
 * A migration that only ALTERs, INSERTs, GRANTs or drops has no creation to
 * look for, and "found nothing to check" must not read as "checked and found
 * everything". A pure-`ALTER` migration and a rollback script are
 * indistinguishable to this test, and one of those must never be stamped.
 *
 * ## Why the extraction is deliberately narrow
 *
 * Only unambiguous `CREATE` forms are recognised. A parser that guessed at the
 * hard cases would produce `satisfied` for migrations it had merely failed to
 * understand, and `satisfied` is the verdict that leads to a tenant running
 * something. Missing a real creation costs an `indeterminate` and an operator
 * reading one more file; inventing one costs a wrong stamp. The asymmetry is
 * the whole design.
 */

export type CreatedObjectKind = "table" | "function" | "type" | "view" | "index" | "sequence";

export type CreatedObject = {
  kind: CreatedObjectKind;
  /** Schema-qualified, lower-cased. Unqualified names are assumed `public`. */
  qualified: string;
};

export type ReconciliationVerdict = "satisfied" | "unsatisfied" | "indeterminate";

export type MigrationEvidence = {
  id: string;
  name: string;
  verdict: ReconciliationVerdict;
  /** What the SQL creates. Empty exactly when the verdict is indeterminate. */
  creates: CreatedObject[];
  /** The subset the prime does not have. Empty unless `unsatisfied`. */
  missing: CreatedObject[];
};

/** Strip line and block comments, and the bodies of dollar-quoted strings. */
export function stripSqlNoise(sql: string): string {
  // Dollar-quoted bodies first: a function body routinely contains the word
  // CREATE, and counting those would attribute a caller's mention to the file
  // as though it were a definition.
  const withoutBodies = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " $BODY$ ");
  return withoutBodies.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const PATTERNS: ReadonlyArray<{ kind: CreatedObjectKind; re: RegExp }> = [
  // `CREATE TABLE [IF NOT EXISTS] [schema.]name`
  { kind: "table", re: /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/gi },
  {
    kind: "function",
    re: /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(/gi,
  },
  { kind: "type", re: /\bcreate\s+type\s+([a-z0-9_."]+)/gi },
  {
    kind: "view",
    re: /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/gi,
  },
  {
    kind: "index",
    re: /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)\s+on\b/gi,
  },
  { kind: "sequence", re: /\bcreate\s+sequence\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/gi },
];

/** `"Public"."Thing"` / `thing` → `public.thing`. */
export function qualify(raw: string, kind: CreatedObjectKind): string {
  const bare = raw.replace(/"/g, "").trim().toLowerCase();
  if (!bare) return "";
  // An index lives in a schema but is named without one in `CREATE INDEX x ON`.
  const parts = bare.split(".");
  if (parts.length >= 2) return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  return kind === "index" ? `public.${bare}` : `public.${bare}`;
}

export function extractCreatedObjects(sql: string): CreatedObject[] {
  const text = stripSqlNoise(sql);
  const seen = new Set<string>();
  const out: CreatedObject[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const qualified = qualify(m[1] ?? "", kind);
      if (!qualified || qualified.endsWith(".")) continue;
      const key = `${kind}:${qualified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, qualified });
    }
  }
  return out;
}

/**
 * @param present Objects the prime's catalog reports, as `kind:schema.name`.
 */
export function reconcileMigration(
  meta: { id: string; name: string },
  sql: string,
  present: ReadonlySet<string>,
): MigrationEvidence {
  const creates = extractCreatedObjects(sql);
  if (creates.length === 0) {
    return { ...meta, verdict: "indeterminate", creates: [], missing: [] };
  }
  const missing = creates.filter((c) => !present.has(`${c.kind}:${c.qualified}`));
  return {
    ...meta,
    verdict: missing.length === 0 ? "satisfied" : "unsatisfied",
    creates,
    missing,
  };
}

export type ReconciliationSummary = {
  satisfied: number;
  unsatisfied: number;
  indeterminate: number;
};

export function summarise(rows: readonly MigrationEvidence[]): ReconciliationSummary {
  return {
    satisfied: rows.filter((r) => r.verdict === "satisfied").length,
    unsatisfied: rows.filter((r) => r.verdict === "unsatisfied").length,
    indeterminate: rows.filter((r) => r.verdict === "indeterminate").length,
  };
}
