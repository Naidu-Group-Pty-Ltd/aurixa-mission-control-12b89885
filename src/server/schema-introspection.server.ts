/**
 * Catalog-introspection clone path.
 *
 * A replay of a repository's migrations is not a clone of a database: it
 * reproduces the history someone wrote down, not the schema that exists. Our
 * prime's migration history does not construct its own schema (949 files on
 * disk, 853 tracked, 546 tables materialised out of band), so the replay dies
 * on migration #1 and burns a Supabase project slot each time.
 *
 * This module instead reads the prime's live `pg_catalog`, generates DDL, and
 * applies it to the clone in dependency order — enum types → sequences →
 * tables → functions → constraints → indexes → views → matviews → triggers →
 * RLS → policies — reconciling every stage against the prime afterwards.
 *
 * Invariants:
 *  - Never move a row. Every source query is read-only against pg_catalog /
 *    information_schema and is asserted to start with `select` / `with`.
 *  - "Every statement applied without error" is NOT success. Each stage counts
 *    the objects on both sides and fails the run when the clone is short.
 */

import { runSqlOnProject, sqlLiteral } from "./backend-provisioning.server";
import { ownProjectRef } from "./prime-backend.server";
import { BudgetPause, pastDeadline } from "./provisioningBudget";

/** Schemas replicated onto a clone. `aml` is not optional — the prime keeps 106 tables there. */
export const REPLICATED_SCHEMAS = ["public", "aml"] as const;

const SCHEMA_LIST = REPLICATED_SCHEMAS.map((s) => `'${s}'`).join(", ");

/** Data API roles whose table privileges must come across, or PostgREST 401/403s on every table. */
export const API_ROLES = ["anon", "authenticated", "service_role"] as const;
const API_ROLE_LIST = API_ROLES.map((r) => `'${r}'`).join(", ");

/** Max passes for the function-convergence loop, so a genuine error cannot loop forever. */
export const MAX_FUNCTION_PASSES = 5;

export type StageName =
  | "enums"
  | "sequences"
  | "tables"
  | "functions"
  | "constraints"
  | "indexes"
  | "views"
  | "matviews"
  | "triggers"
  | "rls"
  | "policies"
  | "grants";

export type StageResult = {
  stage: StageName;
  primeCount: number;
  cloneCount: number;
  applied: number;
  failed: number;
  reconciled: boolean;
  /** Sample of failure messages, capped — full detail lives in aurixa.ddl_failures on the clone. */
  errors?: string[];
  /** Extra notes, e.g. column-drift repairs or function convergence path. */
  notes?: string[];
};

export type IntrospectionResult = {
  ok: boolean;
  primeRef: string;
  cloneRef: string;
  stages: StageResult[];
  /** Stages whose clone count came up short. */
  shortStages: StageName[];
};

// ─── Read-only guard ─────────────────────────────────────────────────

/**
 * Every source query this module runs against the PRIME must be a read. We
 * assert it structurally rather than trusting review: a query that does not
 * begin with `select` or `with` is refused outright.
 */
export function isReadOnlySourceQuery(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .toLowerCase();
  if (!/^(select|with)\b/.test(stripped)) return false;
  // `with … as ( … ) insert/update/delete` is a write dressed as a read.
  if (
    /\b(insert\s+into|update\s+\w|delete\s+from|drop\s+|alter\s+|truncate\b|create\s+)/.test(
      stripped,
    )
  )
    return false;
  return true;
}

export function assertReadOnlySourceQuery(sql: string): string {
  if (!isReadOnlySourceQuery(sql)) {
    throw new Error(`Refusing non-read-only source query against the prime: ${sql.slice(0, 120)}`);
  }
  return sql;
}

// ─── Result shape helpers ────────────────────────────────────────────

/** The Management API returns rows as a bare array; tolerate {rows}/{result} wrappers. */
export function toRows(raw: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { rows?: unknown[] })?.rows)
      ? (raw as { rows: unknown[] }).rows
      : Array.isArray((raw as { result?: unknown[] })?.result)
        ? (raw as { result: unknown[] }).result
        : [];
  return arr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
}

/** `already exists` / `duplicate …` are success on a re-run, not failures. */
export function isBenignDdlError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("already exists") ||
    m.includes("duplicate key") ||
    m.includes("duplicate object") ||
    m.includes("duplicate table") ||
    m.includes("duplicate column")
  );
}

/**
 * Stop condition for the function-creation convergence loop. `LANGUAGE sql`
 * bodies are validated at creation, so a function calling one that does not
 * exist yet fails — and catalog order is not dependency order. Keep going only
 * while the failure count is still falling and we have passes left.
 */
export function shouldRunAnotherFunctionPass(
  history: readonly number[],
  maxPasses: number = MAX_FUNCTION_PASSES,
): boolean {
  if (history.length === 0) return true;
  if (history.length >= maxPasses) return false;
  const last = history[history.length - 1];
  if (last === 0) return false;
  if (history.length === 1) return true;
  return last < history[history.length - 2];
}

// ─── Column drift ────────────────────────────────────────────────────

export type ColumnInfo = { table: string; column: string; type: string; notNull?: boolean };

/**
 * `create table if not exists` does not repair an existing table: on a re-run,
 * an already-present table is skipped and column drift survives invisibly —
 * counts match while columns do not. Compare full signatures and emit
 * `alter table … add column if not exists …` for what the clone is missing.
 */
export function diffMissingColumns(
  prime: readonly ColumnInfo[],
  clone: readonly ColumnInfo[],
): ColumnInfo[] {
  const have = new Set(clone.map((c) => `${c.table}\u0000${c.column}`));
  return prime.filter((c) => !have.has(`${c.table}\u0000${c.column}`));
}

export function buildAddColumnStatements(missing: readonly ColumnInfo[]): string[] {
  return missing.map(
    (c) => `alter table ${c.table} add column if not exists ${c.column} ${c.type}`,
  );
}

/** Per-table signature of `attname + format_type` pairs, for a cheap drift check. */
export function columnSignature(columns: readonly ColumnInfo[]): Map<string, string> {
  const byTable = new Map<string, string[]>();
  for (const c of columns) {
    const list = byTable.get(c.table) ?? [];
    list.push(`${c.column}:${c.type}`);
    byTable.set(c.table, list);
  }
  const out = new Map<string, string>();
  for (const [table, cols] of byTable) out.set(table, [...cols].sort().join("|"));
  return out;
}

export function driftedTables(prime: Map<string, string>, clone: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [table, sig] of prime) if (clone.get(table) !== sig) out.push(table);
  return out.sort();
}

// ─── Index filtering ─────────────────────────────────────────────────

/**
 * `pg_indexes` includes constraint-backed indexes; creating everything it
 * returns double-creates whatever the constraints stage already made. We
 * filter them out when generating DDL but reconcile against the UNFILTERED
 * count, because that is what the clone will report.
 */
export const CONSTRAINT_BACKED_INDEX_FILTER = `
  not exists (
    select 1 from pg_constraint c
    join pg_class ic on ic.oid = c.conindid
    where ic.relname = i.indexname
  )`;

export function isConstraintBacked(
  indexName: string,
  constraintIndexNames: ReadonlySet<string>,
): boolean {
  return constraintIndexNames.has(indexName);
}

export function filterCreatableIndexes(
  indexes: readonly { indexname: string; indexdef: string }[],
  constraintIndexNames: ReadonlySet<string>,
): string[] {
  return indexes
    .filter((i) => !isConstraintBacked(i.indexname, constraintIndexNames))
    .map((i) => i.indexdef);
}

// ─── DDL builders ────────────────────────────────────────────────────

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function buildEnumDdl(schema: string, typeName: string, labels: readonly string[]): string {
  const values = labels.map((l) => sqlLiteral(l)).join(", ");
  return `do $$ begin create type ${quoteIdent(schema)}.${quoteIdent(typeName)} as enum (${values}); exception when duplicate_object then null; end $$`;
}

export type ColumnDef = {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  /** pg_attribute.attidentity: 'a' = always, 'd' = by default, '' = none. */
  identity?: string | null;
};

export function buildCreateTableDdl(
  schema: string,
  table: string,
  columns: readonly ColumnDef[],
): string {
  const cols = columns.map((c) => {
    let s = `${quoteIdent(c.name)} ${c.type}`;
    // Identity columns carry no pg_attrdef default — they must be declared.
    if (c.identity === "a" || c.identity === "d") {
      s += ` generated ${c.identity === "a" ? "always" : "by default"} as identity`;
    } else if (c.default) {
      s += ` default ${c.default}`;
    }
    if (c.notNull) s += " not null";
    return s;
  });
  return `create table if not exists ${quoteIdent(schema)}.${quoteIdent(table)} (\n  ${cols.join(",\n  ")}\n)`;
}

export function buildPolicyDdl(p: {
  schemaname: string;
  tablename: string;
  policyname: string;
  permissive: string;
  roles: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}): string {
  const roles = parsePgArray(p.roles);
  const target = roles.length ? roles.map((r) => quoteIdent(r)).join(", ") : "public";
  const as = /permissive/i.test(p.permissive ?? "") ? "permissive" : "restrictive";
  let sql = `create policy ${quoteIdent(p.policyname)} on ${quoteIdent(p.schemaname)}.${quoteIdent(
    p.tablename,
  )} as ${as} for ${(p.cmd || "ALL").toLowerCase()} to ${target}`;
  if (p.qual) sql += ` using (${p.qual})`;
  if (p.with_check) sql += ` with check (${p.with_check})`;
  return sql;
}

/** `{a,b}` → ["a","b"]; tolerates a real array coming back from the API. */
export function parsePgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => str(v)).filter(Boolean);
  const s = str(value).trim();
  if (!s || s === "{}") return [];
  const inner = s.startsWith("{") && s.endsWith("}") ? s.slice(1, -1) : s;
  return inner
    .split(",")
    .map((p) => p.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export function buildGrantDdl(
  schema: string,
  table: string,
  grantee: string,
  privilege: string,
): string {
  return `grant ${privilege.toLowerCase()} on ${quoteIdent(schema)}.${quoteIdent(table)} to ${quoteIdent(grantee)}`;
}

// ─── Batch DDL application ───────────────────────────────────────────

/**
 * Helper installed on the CLONE: executes a jsonb array of statements, each in
 * its own BEGIN … EXCEPTION block, so one failure does not abort the batch.
 * Failures are recorded to `aurixa.ddl_failures` and returned to the caller.
 */
const APPLY_HELPER_SQL = `
create schema if not exists aurixa;
create table if not exists aurixa.ddl_failures (
  id bigserial primary key,
  stage text,
  statement text,
  error text,
  failed_at timestamptz not null default now()
);
create or replace function aurixa.apply_ddl_batch(stmts jsonb, stage text default null)
returns jsonb
language plpgsql
as $fn$
declare
  s text;
  ok int := 0;
  failures jsonb := '[]'::jsonb;
begin
  for s in select value::text from jsonb_array_elements_text(stmts) as t(value) loop
    begin
      execute s;
      ok := ok + 1;
    exception when others then
      if position('already exists' in lower(sqlerrm)) > 0
         or position('duplicate' in lower(sqlerrm)) > 0 then
        ok := ok + 1;
      else
        insert into aurixa.ddl_failures (stage, statement, error)
          values (stage, left(s, 4000), sqlerrm);
        failures := failures || jsonb_build_object('error', sqlerrm, 'statement', left(s, 300));
      end if;
    end;
  end loop;
  return jsonb_build_object('applied', ok, 'failures', failures);
end;
$fn$;
`.trim();

export type BatchApplyResult = { applied: number; failed: number; errors: string[] };

async function ensureApplyHelper(cloneRef: string): Promise<void> {
  await runSqlOnProject(cloneRef, APPLY_HELPER_SQL);
}

/** Apply DDL statements to the clone in fault-isolated batches. */
export async function applyStatements(
  cloneRef: string,
  stage: string,
  statements: readonly string[],
  batchSize = 60,
): Promise<BatchApplyResult> {
  const result: BatchApplyResult = { applied: 0, failed: 0, errors: [] };
  for (const batch of chunk(statements, batchSize)) {
    const payload = sqlLiteral(JSON.stringify(batch));
    const raw = await runSqlOnProject(
      cloneRef,
      `select aurixa.apply_ddl_batch(${payload}::jsonb, ${sqlLiteral(stage)}) as r`,
    );
    const rows = toRows(raw);
    const r = (rows[0]?.r ?? {}) as { applied?: unknown; failures?: unknown };
    const parsed = typeof r === "string" ? (JSON.parse(r) as typeof r) : r;
    result.applied += num(parsed?.applied);
    const failures = Array.isArray(parsed?.failures) ? parsed.failures : [];
    result.failed += failures.length;
    for (const f of failures.slice(0, 5)) {
      const msg = str((f as { error?: unknown })?.error);
      if (msg && !isBenignDdlError(msg) && result.errors.length < 20) result.errors.push(msg);
    }
  }
  return result;
}

// ─── Catalog queries ─────────────────────────────────────────────────

const Q = {
  enums: `select n.nspname as schema, t.typname as name,
            to_jsonb(array_agg(e.enumlabel::text order by e.enumsortorder)) as labels
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
          join pg_enum e on e.enumtypid = t.oid
          where t.typtype = 'e' and n.nspname in (${SCHEMA_LIST})
          group by 1, 2 order by 1, 2`,

  sequences: `select n.nspname as schema, c.relname as name
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind = 'S' and n.nspname in (${SCHEMA_LIST})
              order by 1, 2`,

  columns: `select n.nspname as schema, c.relname as table_name, a.attname as column_name,
              format_type(a.atttypid, a.atttypmod) as data_type,
              a.attnotnull as not_null,
              pg_get_expr(d.adbin, d.adrelid) as column_default,
              a.attidentity::text as identity,
              a.attnum as ord
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            join pg_namespace n on n.oid = c.relnamespace
            left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
            where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
              and n.nspname in (${SCHEMA_LIST})
            order by 1, 2, a.attnum`,

  functions: `select p.oid::text as oid, pg_get_functiondef(p.oid) as def
              from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
              where n.nspname in (${SCHEMA_LIST})
                and p.prokind in ('f', 'p')
                and d.objid is null
              order by p.oid`,

  constraints: `select n.nspname as schema, rel.relname as table_name, c.conname as name,
                  c.contype as contype, pg_get_constraintdef(c.oid) as def
                from pg_constraint c
                join pg_class rel on rel.oid = c.conrelid
                join pg_namespace n on n.oid = rel.relnamespace
                where n.nspname in (${SCHEMA_LIST})
                order by case c.contype when 'p' then 0 when 'u' then 1 when 'c' then 2
                                        when 'f' then 3 else 4 end, rel.relname, c.conname`,

  indexes: `select i.schemaname as schema, i.indexname as indexname, i.indexdef as indexdef
            from pg_indexes i
            where i.schemaname in (${SCHEMA_LIST})
            order by 1, 2`,

  constraintIndexNames: `select ic.relname as indexname
                         from pg_constraint c
                         join pg_class ic on ic.oid = c.conindid
                         join pg_namespace n on n.oid = ic.relnamespace
                         where n.nspname in (${SCHEMA_LIST})`,

  views: `select schemaname as schema, viewname as name, definition as def
          from pg_views where schemaname in (${SCHEMA_LIST}) order by 1, 2`,

  matviews: `select n.nspname as schema, c.relname as name, pg_get_viewdef(c.oid, true) as def
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind = 'm' and n.nspname in (${SCHEMA_LIST}) order by 1, 2`,

  triggers: `select pg_get_triggerdef(t.oid) as def
             from pg_trigger t
             join pg_class c on c.oid = t.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
             where not t.tgisinternal and n.nspname in (${SCHEMA_LIST})
             order by c.relname, t.tgname`,

  rlsTables: `select n.nspname as schema, c.relname as name
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind = 'r' and c.relrowsecurity
                and n.nspname in (${SCHEMA_LIST}) order by 1, 2`,

  policies: `select schemaname, tablename, policyname, permissive,
               roles::text as roles, cmd, qual, with_check
             from pg_policies where schemaname in (${SCHEMA_LIST})
             order by tablename, policyname`,

  // PostgREST reaches nothing without these: RLS alone is not access.
  grants: `select table_schema as schema, table_name, grantee, privilege_type
           from information_schema.role_table_grants
           where table_schema in (${SCHEMA_LIST})
             and grantee in (${API_ROLE_LIST})
           order by 1, 2, 3, 4`,
};

/** Count queries used for reconciliation — run identically on both sides. */
const COUNTS: Record<StageName, string> = {
  enums: `select count(distinct t.oid)::int as n from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype='e' and n.nspname in (${SCHEMA_LIST})`,
  sequences: `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and n.nspname in (${SCHEMA_LIST})`,
  tables: `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in (${SCHEMA_LIST})`,
  functions: `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace left join pg_depend d on d.objid=p.oid and d.deptype='e' where n.nspname in (${SCHEMA_LIST}) and p.prokind in ('f','p') and d.objid is null`,
  constraints: `select count(*)::int as n from pg_constraint c join pg_class rel on rel.oid=c.conrelid join pg_namespace n on n.oid=rel.relnamespace where n.nspname in (${SCHEMA_LIST})`,
  // Unfiltered on purpose: the clone reports constraint-backed indexes too.
  indexes: `select count(*)::int as n from pg_indexes i where i.schemaname in (${SCHEMA_LIST})`,
  views: `select count(*)::int as n from pg_views where schemaname in (${SCHEMA_LIST})`,
  matviews: `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='m' and n.nspname in (${SCHEMA_LIST})`,
  triggers: `select count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in (${SCHEMA_LIST})`,
  rls: `select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and c.relrowsecurity and n.nspname in (${SCHEMA_LIST})`,
  policies: `select count(*)::int as n from pg_policies where schemaname in (${SCHEMA_LIST})`,
  grants: `select count(*)::int as n from information_schema.role_table_grants where table_schema in (${SCHEMA_LIST}) and grantee in (${API_ROLE_LIST})`,
};

async function query(ref: string, sql: string): Promise<Array<Record<string, unknown>>> {
  return toRows(await runSqlOnProject(ref, assertReadOnlySourceQuery(sql)));
}

async function countOn(ref: string, stage: StageName): Promise<number> {
  const rows = await query(ref, COUNTS[stage]);
  return num(rows[0]?.n);
}

/** A stage is reconciled when the clone holds at least as many objects as the prime. */
export function reconcile(primeCount: number, cloneCount: number): boolean {
  return cloneCount >= primeCount;
}

// ─── Stage runner ────────────────────────────────────────────────────

type Notify = (status: string, detail: string) => Promise<void>;

/**
 * Has the clone already caught up on this stage?
 *
 * Two cheap COUNT queries, one per side. Every stage's work is idempotent, so
 * re-running a finished stage is harmless — but it is not FREE, and that is
 * what stalled the first real clone: each invocation redid the completed
 * stages, ran out of wall clock inside the heavy `tables` stage, and was
 * killed before reaching anything new. Skipping what is already reconciled
 * hands the whole budget to the stage that still has work, which is the same
 * "ask the target what it already holds" rule the edge-function resume uses.
 */
async function alreadyReconciled(
  stage: StageName,
  primeRef: string,
  cloneRef: string,
): Promise<StageResult | null> {
  const [primeCount, cloneCount] = await Promise.all([
    countOn(primeRef, stage),
    countOn(cloneRef, stage),
  ]);
  if (!reconcile(primeCount, cloneCount)) return null;
  return {
    stage,
    primeCount,
    cloneCount,
    applied: 0,
    failed: 0,
    reconciled: true,
    notes: ["already reconciled — skipped on resume"],
  };
}

async function runStage(
  stage: StageName,
  primeRef: string,
  cloneRef: string,
  statements: readonly string[],
  batchSize: number,
  notes?: string[],
): Promise<StageResult> {
  const applyResult = await applyStatements(cloneRef, stage, statements, batchSize);
  const [primeCount, cloneCount] = await Promise.all([
    countOn(primeRef, stage),
    countOn(cloneRef, stage),
  ]);
  return {
    stage,
    primeCount,
    cloneCount,
    applied: applyResult.applied,
    failed: applyResult.failed,
    reconciled: reconcile(primeCount, cloneCount),
    ...(applyResult.errors.length ? { errors: applyResult.errors } : {}),
    ...(notes && notes.length ? { notes } : {}),
  };
}

// ─── Main entry point ────────────────────────────────────────────────

export async function replicateSchemaByIntrospection(
  cloneRef: string,
  options: { primeRef: string; onStatusUpdate?: Notify; deadlineAt?: number | null },
): Promise<IntrospectionResult> {
  const primeRef = options.primeRef;
  const notify = options?.onStatusUpdate;
  const stages: StageResult[] = [];
  const say = async (detail: string) => {
    await notify?.("migrating", detail);
  };
  // Every stage is idempotent (`if not exists` / `create or replace` / the
  // reconcile counts), so a run that pauses between stages re-enters from the
  // top on the next invocation and the completed stages no-op through. The
  // pause sits BETWEEN stages, never inside one — a stage is the transaction
  // of meaning here, and pausing mid-batch is exactly the half-applied state
  // the batches exist to avoid. Stage 1 never pauses: an invocation that has
  // claimed the job must move it, or the recycle makes no forward progress.
  const pauseIfDue = (about: string) => {
    if (pastDeadline(options.deadlineAt)) throw new BudgetPause(about);
  };

  if (primeRef === cloneRef) throw new Error("Refusing to introspect the prime onto itself");

  // The guard that would have caught the original defect. `primeRef` used to
  // default to a ref derived from `SUPABASE_URL`, which is this deployment's
  // OWN project — so the default clone strategy replicated Mission Control's
  // admin schema (clones, prime_config, cascade_events) onto every new clone
  // instead of the product's. It is refused here as well as at the resolver,
  // because this is the last point before 500-odd tables are written and a
  // wrong source is indistinguishable from a right one once they are.
  const own = ownProjectRef();
  if (own && primeRef.toLowerCase() === own) {
    throw new Error(
      `Refusing to introspect this deployment's own project (${primeRef}) onto a clone — ` +
        "that is Mission Control's admin schema, not the product's. " +
        "Set prime_config.supabase_project_ref to the prime PRODUCT's project.",
    );
  }

  /** Run a stage, unless the clone has already caught up on it. */
  const stageOrSkip = async (
    stage: StageName,
    statements: () => Promise<readonly string[]> | readonly string[],
    batchSize: number,
  ): Promise<StageResult> => {
    const done = await alreadyReconciled(stage, primeRef, cloneRef);
    if (done) return done;
    return runStage(stage, primeRef, cloneRef, await statements(), batchSize);
  };

  await ensureApplyHelper(cloneRef);
  await runSqlOnProject(
    cloneRef,
    REPLICATED_SCHEMAS.map((s) => `create schema if not exists ${quoteIdent(s)};`).join("\n"),
  );

  // 1. enum types
  await say("Introspecting prime: enum types...");
  stages.push(
    await stageOrSkip(
      "enums",
      async () => {
        const enumRows = await query(primeRef, Q.enums);
        return enumRows.map((r) =>
          buildEnumDdl(str(r.schema), str(r.name), parsePgArray(r.labels)),
        );
      },
      60,
    ),
  );

  // 2. sequences
  pauseIfDue("introspection: sequences onward resume next tick");
  await say("Replicating sequences...");
  stages.push(
    await stageOrSkip(
      "sequences",
      async () => {
        const seqRows = await query(primeRef, Q.sequences);
        return seqRows.map(
          (r) =>
            `create sequence if not exists ${quoteIdent(str(r.schema))}.${quoteIdent(str(r.name))}`,
        );
      },
      60,
    ),
  );

  // 3. tables (columns only — constraints and indexes come later)
  pauseIfDue("introspection: tables onward resume next tick");
  await say("Replicating tables...");
  const primeCols = await query(primeRef, Q.columns);
  const grouped = new Map<
    string,
    {
      schema: string;
      table: string;
      cols: ColumnDef[];
    }
  >();
  for (const r of primeCols) {
    const key = `${str(r.schema)}.${str(r.table_name)}`;
    const entry = grouped.get(key) ?? { schema: str(r.schema), table: str(r.table_name), cols: [] };
    entry.cols.push({
      name: str(r.column_name),
      type: str(r.data_type),
      notNull: r.not_null === true || r.not_null === "true",
      default: r.column_default == null ? null : str(r.column_default),
      identity: r.identity == null ? null : str(r.identity),
    });
    grouped.set(key, entry);
  }

  const tableStmts = Array.from(grouped.values()).map((t) =>
    buildCreateTableDdl(t.schema, t.table, t.cols),
  );
  const tableStage = await runStage("tables", primeRef, cloneRef, tableStmts, 60);

  // The single heaviest stage in the pipeline, and the one that has to be
  // interruptible from the inside: three catalog reads of ~10,000 rows plus
  // ~15 batched DDL round trips do not fit one invocation on a prime this
  // size. Without a pause here the worker is KILLED rather than exiting, and
  // a kill costs a 15-minute stall reclaim where a pause costs 60 seconds.
  pauseIfDue("introspection: column drift repair resumes next tick");

  // 3b. Column drift: `create table if not exists` never repairs an existing
  // table, so counts can match while columns do not.
  const cloneCols = await query(cloneRef, Q.columns);
  const toInfo = (rows: Array<Record<string, unknown>>): ColumnInfo[] =>
    rows.map((r) => ({
      table: `${quoteIdent(str(r.schema))}.${quoteIdent(str(r.table_name))}`,
      column: quoteIdent(str(r.column_name)),
      type: str(r.data_type),
    }));
  const primeInfo = toInfo(primeCols);
  const missing = diffMissingColumns(primeInfo, toInfo(cloneCols));
  if (missing.length) {
    await say(`Repairing ${missing.length} drifted column(s)...`);
    const repair = await applyStatements(
      cloneRef,
      "tables:columns",
      buildAddColumnStatements(missing),
      60,
    );
    tableStage.applied += repair.applied;
    tableStage.failed += repair.failed;
    tableStage.notes = [
      ...(tableStage.notes ?? []),
      `column drift: ${missing.length} missing, ${repair.applied} repaired`,
    ];
    // Re-read only when the repair itself reported a failure. A clean repair
    // already knows what it added, and this verification is another ~10,000
    // row read — the difference between finishing the stage inside the
    // invocation and being killed one step from the end.
    if (repair.failed > 0) {
      const afterCols = toInfo(await query(cloneRef, Q.columns));
      const stillDrifted = driftedTables(columnSignature(primeInfo), columnSignature(afterCols));
      if (stillDrifted.length) {
        tableStage.reconciled = false;
        tableStage.notes.push(`still drifted: ${stillDrifted.slice(0, 10).join(", ")}`);
      }
    }
  }
  stages.push(tableStage);

  // 4. functions — repeat until the failure count stops falling
  pauseIfDue("introspection: functions onward resume next tick");
  await say("Replicating functions...");
  const fnRows = await query(primeRef, Q.functions);
  const fnStmts = fnRows.map((r) => str(r.def)).filter(Boolean);
  const history: number[] = [];
  let lastApply: BatchApplyResult = { applied: 0, failed: 0, errors: [] };
  let totalApplied = 0;
  while (shouldRunAnotherFunctionPass(history)) {
    await say(`Functions pass ${history.length + 1}...`);
    lastApply = await applyStatements(cloneRef, "functions", fnStmts, 15);
    totalApplied += lastApply.applied;
    history.push(lastApply.failed);
  }
  const [fnPrime, fnClone] = await Promise.all([
    countOn(primeRef, "functions"),
    countOn(cloneRef, "functions"),
  ]);
  stages.push({
    stage: "functions",
    primeCount: fnPrime,
    cloneCount: fnClone,
    applied: totalApplied,
    failed: history[history.length - 1] ?? 0,
    reconciled: reconcile(fnPrime, fnClone),
    ...(lastApply.errors.length ? { errors: lastApply.errors } : {}),
    notes: [`convergence: ${history.join(" → ")}`],
  });

  // 4b. A column default that calls a user function could not be created
  // before stage 4 existed. Re-apply the table DDL once the functions are in
  // place and re-reconcile, so that ordering cannot silently lose a table.
  if (!tableStage.reconciled || tableStage.failed > 0) {
    await say("Re-applying tables now that functions exist...");
    const retry = await applyStatements(cloneRef, "tables:retry", tableStmts, 60);
    tableStage.applied += retry.applied;
    tableStage.failed = retry.failed;
    tableStage.cloneCount = await countOn(cloneRef, "tables");
    tableStage.reconciled =
      reconcile(tableStage.primeCount, tableStage.cloneCount) &&
      !(tableStage.notes ?? []).some((n) => n.startsWith("still drifted"));
    tableStage.notes = [...(tableStage.notes ?? []), `retry after functions: +${retry.applied}`];
  }

  // 5. constraints, ordered p → u → c → f
  pauseIfDue("introspection: constraints onward resume next tick");
  await say("Replicating constraints...");
  const conRows = await query(primeRef, Q.constraints);
  const conStmts = conRows.map(
    (r) =>
      `alter table ${quoteIdent(str(r.schema))}.${quoteIdent(str(r.table_name))} add constraint ${quoteIdent(
        str(r.name),
      )} ${str(r.def)}`,
  );
  stages.push(await runStage("constraints", primeRef, cloneRef, conStmts, 60));

  // 6. indexes — skipping the constraint-backed ones stage 5 already made
  pauseIfDue("introspection: indexes onward resume next tick");
  await say("Replicating indexes...");
  const idxRows = await query(primeRef, Q.indexes);
  const conIdxNames = new Set(
    (await query(primeRef, Q.constraintIndexNames)).map((r) => str(r.indexname)),
  );
  const idxStmts = filterCreatableIndexes(
    idxRows.map((r) => ({ indexname: str(r.indexname), indexdef: str(r.indexdef) })),
    conIdxNames,
  ).map((def) => def.replace(/^create (unique )?index /i, (m) => `${m.trimEnd()} if not exists `));
  stages.push(await runStage("indexes", primeRef, cloneRef, idxStmts, 60));

  // 7. views — a view on a view fails when the callee is not in place yet, and
  // catalog order is not dependency order, so converge the same way functions do.
  pauseIfDue("introspection: views onward resume next tick");
  await say("Replicating views...");
  const viewRows = await query(primeRef, Q.views);
  const viewStmts = viewRows.map(
    (r) =>
      `create or replace view ${quoteIdent(str(r.schema))}.${quoteIdent(str(r.name))} as ${str(r.def)}`,
  );
  const viewHistory: number[] = [];
  let viewApply: BatchApplyResult = { applied: 0, failed: 0, errors: [] };
  let viewApplied = 0;
  while (shouldRunAnotherFunctionPass(viewHistory, 3)) {
    viewApply = await applyStatements(cloneRef, "views", viewStmts, 30);
    viewApplied += viewApply.applied;
    viewHistory.push(viewApply.failed);
  }
  const [viewPrime, viewClone] = await Promise.all([
    countOn(primeRef, "views"),
    countOn(cloneRef, "views"),
  ]);
  stages.push({
    stage: "views",
    primeCount: viewPrime,
    cloneCount: viewClone,
    applied: viewApplied,
    failed: viewHistory[viewHistory.length - 1] ?? 0,
    reconciled: reconcile(viewPrime, viewClone),
    ...(viewApply.errors.length ? { errors: viewApply.errors } : {}),
    notes: [`convergence: ${viewHistory.join(" → ")}`],
  });

  // 8. materialized views (relkind 'm' — every table query misses these, and
  //    an index belongs to one, so skipping this breaks the index stage)
  pauseIfDue("introspection: materialized views onward resume next tick");
  await say("Replicating materialized views...");
  const mvRows = await query(primeRef, Q.matviews);
  stages.push(
    await runStage(
      "matviews",
      primeRef,
      cloneRef,
      mvRows.map(
        (r) =>
          `create materialized view if not exists ${quoteIdent(str(r.schema))}.${quoteIdent(
            str(r.name),
          )} as ${str(r.def)}`,
      ),
      15,
    ),
  );

  // 8b. Indexes that belong to matviews could not exist before stage 8.
  const idxAfterMv = await applyStatements(cloneRef, "indexes:matview", idxStmts, 60);
  const idxStage = stages.find((s) => s.stage === "indexes");
  if (idxStage) {
    idxStage.applied += idxAfterMv.applied;
    idxStage.cloneCount = await countOn(cloneRef, "indexes");
    idxStage.failed = idxAfterMv.failed;
    idxStage.reconciled = reconcile(idxStage.primeCount, idxStage.cloneCount);
  }

  // 9. triggers
  pauseIfDue("introspection: triggers onward resume next tick");
  await say("Replicating triggers...");
  const trgRows = await query(primeRef, Q.triggers);
  stages.push(
    await runStage(
      "triggers",
      primeRef,
      cloneRef,
      trgRows.map((r) => str(r.def)).filter(Boolean),
      60,
    ),
  );

  // 10. RLS enable
  pauseIfDue("introspection: RLS onward resumes next tick");
  await say("Enabling row level security...");
  const rlsRows = await query(primeRef, Q.rlsTables);
  stages.push(
    await runStage(
      "rls",
      primeRef,
      cloneRef,
      rlsRows.map(
        (r) =>
          `alter table ${quoteIdent(str(r.schema))}.${quoteIdent(str(r.name))} enable row level security`,
      ),
      60,
    ),
  );

  // 11. policies
  pauseIfDue("introspection: policies onward resume next tick");
  await say("Replicating RLS policies...");
  const polRows = await query(primeRef, Q.policies);
  stages.push(
    await runStage(
      "policies",
      primeRef,
      cloneRef,
      polRows.map((r) =>
        buildPolicyDdl({
          schemaname: str(r.schemaname),
          tablename: str(r.tablename),
          policyname: str(r.policyname),
          permissive: str(r.permissive),
          roles: str(r.roles),
          cmd: str(r.cmd),
          qual: r.qual == null ? null : str(r.qual),
          with_check: r.with_check == null ? null : str(r.with_check),
        }),
      ),
      60,
    ),
  );

  // 12. Data API grants. RLS alone is not access: without the prime's table
  // privileges PostgREST cannot reach a single table on the clone.
  pauseIfDue("introspection: grants resume next tick");
  await say("Replicating Data API grants...");
  const grantRows = await query(primeRef, Q.grants);
  const grantStmts = grantRows.map((r) =>
    buildGrantDdl(str(r.schema), str(r.table_name), str(r.grantee), str(r.privilege_type)),
  );
  stages.push(await runStage("grants", primeRef, cloneRef, grantStmts, 60));

  const shortStages = stages.filter((s) => !s.reconciled).map((s) => s.stage);
  return { ok: shortStages.length === 0, primeRef, cloneRef, stages, shortStages };
}

// ─── Emptiness verification ──────────────────────────────────────────

export type EmptinessResult = {
  empty: boolean;
  totalRows: number;
  nonEmpty: Array<{ table: string; rows: number }>;
};

/**
 * The clone must hold zero rows after introspection (apart from the seeded
 * admin). Counts every row across the replicated schemas.
 */
export async function verifyCloneIsEmpty(
  cloneRef: string,
  options?: { allowRows?: number },
): Promise<EmptinessResult> {
  const listSql = `select n.nspname as schema, c.relname as name
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where c.relkind = 'r' and n.nspname in (${SCHEMA_LIST})
                   order by 1, 2`;
  const tables = await query(cloneRef, listSql);
  const nonEmpty: Array<{ table: string; rows: number }> = [];
  let totalRows = 0;
  for (const group of chunk(tables, 100)) {
    if (!group.length) continue;
    const union = group
      .map(
        (t) =>
          `select ${sqlLiteral(`${str(t.schema)}.${str(t.name)}`)} as t, count(*)::int as n from ${quoteIdent(
            str(t.schema),
          )}.${quoteIdent(str(t.name))}`,
      )
      .join(" union all ");
    const rows = toRows(await runSqlOnProject(cloneRef, assertReadOnlySourceQuery(union)));
    for (const r of rows) {
      const n = num(r.n);
      totalRows += n;
      if (n > 0) nonEmpty.push({ table: str(r.t), rows: n });
    }
  }
  return { empty: totalRows <= (options?.allowRows ?? 0), totalRows, nonEmpty };
}

// ─── Migration ledger stamping ───────────────────────────────────────

/**
 * After introspection the clone's schema already matches the prime, but its
 * migration ledger is empty — so future INCREMENTAL migrations would try to
 * replay history that is already present. Stamp the prime's applied IDs.
 */
export async function stampMigrationLedgerFromPrime(
  cloneRef: string,
  primeRef: string,
): Promise<{ stamped: number }> {
  const ref = primeRef;
  const rows = await query(
    ref,
    `select version, coalesce(name, version) as name
     from supabase_migrations.schema_migrations order by version`,
  );
  // An empty prime ledger is not "nothing to do" — it is the condition that
  // makes the clone permanently unsyncable. Introspection builds the schema
  // without recording a single version, so `migration-sync` later computes
  // `corpus − ledger` as the ENTIRE corpus and replays it from #1 against a
  // populated database. Migration #1 fails on an object that already exists,
  // `applyPrimeMigrations` halts, and it will halt identically on every future
  // attempt. Failing here is the only point where an operator can still act.
  if (!rows.length) {
    throw new Error(
      `The prime backend (${ref}) has no rows in supabase_migrations.schema_migrations, ` +
        "so there is nothing to stamp onto the clone. A clone with a schema and no ledger " +
        "can never sync migrations — refusing to leave one in that state.",
    );
  }
  await runSqlOnProject(
    cloneRef,
    `create schema if not exists supabase_migrations;
     create table if not exists supabase_migrations.schema_migrations (
       version text primary key, name text, statements text[]
     );`,
  );
  let stamped = 0;
  for (const group of chunk(rows, 200)) {
    const values = group
      .map((r) => `(${sqlLiteral(str(r.version))}, ${sqlLiteral(str(r.name))}, ARRAY[]::text[])`)
      .join(", ");
    await runSqlOnProject(
      cloneRef,
      `insert into supabase_migrations.schema_migrations (version, name, statements)
       values ${values} on conflict (version) do nothing;`,
    );
    stamped += group.length;
  }
  return { stamped };
}
