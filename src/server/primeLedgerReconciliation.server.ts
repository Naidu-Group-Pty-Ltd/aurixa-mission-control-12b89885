/**
 * Report which repo migrations the prime's ledger omits but its DATABASE
 * already satisfies.
 *
 * Read-only. Nothing here stamps a ledger or sends anything to a clone — see
 * `primeLedgerReconciliation.pure.ts` for why the verdicts are evidence and
 * not permission.
 *
 * The number this produces is the one that decides how much of the fleet's
 * backlog is bookkeeping and how much is real: on this prime, 64 of the repo's
 * migrations after `20260831060152` are absent from the ledger and 6 are
 * recorded, while the prime demonstrably HAS objects several of the absent
 * ones create.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  openPrimeMigrationCorpus,
  resolvePrimeBackendRef,
  resolvePrimeSource,
} from "./prime-backend.server";
import { runSqlOnProject } from "./backend-provisioning.server";
import {
  extractCreatedObjects,
  reconcileMigration,
  summarise,
  type MigrationEvidence,
  type ReconciliationSummary,
} from "./primeLedgerReconciliation.pure";

type Db = SupabaseClient<Database>;

export type ReconciliationReport = {
  ok: true;
  primeRef: string;
  /** Repo versions the prime's ledger does not record. */
  candidates: number;
  summary: ReconciliationSummary;
  /** Every row, newest first — the operator reads this before stamping anything. */
  rows: MigrationEvidence[];
};

/** One `kind:schema.name` row per object the prime's catalog actually holds. */
const LIVE_OBJECTS_SQL = `
select 'table:'||n.nspname||'.'||c.relname o from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p')
union all select 'view:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('v','m')
union all select 'index:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='i'
union all select 'sequence:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S'
union all select 'function:'||n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
union all select 'type:'||n.nspname||'.'||t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace`;

export async function buildPrimeLedgerReconciliation(
  supabase: Db,
  opts: { limit?: number } = {},
): Promise<ReconciliationReport | { ok: false; error: string }> {
  const source = await resolvePrimeSource(supabase);
  if (!source) return { ok: false, error: "The prime repo source is not configured." };

  let primeRef: string;
  try {
    primeRef = await resolvePrimeBackendRef(supabase);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not resolve the prime" };
  }

  const corpus = await openPrimeMigrationCorpus(getAppOctokit(), source);

  const rows = (await runSqlOnProject(
    primeRef,
    `select version from supabase_migrations.schema_migrations`,
  )) as Array<{ version?: unknown }>;
  const ledger = new Set(
    (Array.isArray(rows) ? rows : [])
      .map((r) => r?.version)
      .filter((v): v is string => typeof v === "string"),
  );
  // An empty read here would make every migration look like a candidate and
  // every one of them look stampable. Same refusal as the scope's.
  if (ledger.size === 0) {
    return { ok: false, error: `The prime (${primeRef}) reports no applied migrations.` };
  }

  const live = (await runSqlOnProject(primeRef, LIVE_OBJECTS_SQL)) as Array<{ o?: unknown }>;
  const present = new Set(
    (Array.isArray(live) ? live : [])
      .map((r) => r?.o)
      .filter((v): v is string => typeof v === "string"),
  );

  // Newest first: the recent gap is what stops clones advancing today, and a
  // body is a GitHub round trip, so the cap spends them where they matter.
  const candidates = corpus.metas.filter((m) => !ledger.has(m.id)).reverse();
  const take = candidates.slice(0, opts.limit ?? 120);

  const evidence: MigrationEvidence[] = [];
  for (const m of take) {
    let sql: string;
    try {
      sql = await corpus.loadSql(m.id);
    } catch {
      // A body we cannot read is not a migration we can vouch for.
      evidence.push({ id: m.id, name: m.name, verdict: "indeterminate", creates: [], missing: [] });
      continue;
    }
    evidence.push(reconcileMigration({ id: m.id, name: m.name }, sql, present));
  }

  return {
    ok: true,
    primeRef,
    candidates: candidates.length,
    summary: summarise(evidence),
    rows: evidence,
  };
}

/** Exported for the report surface; extraction is the pure module's. */
export { extractCreatedObjects };
