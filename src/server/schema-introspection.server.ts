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
import {
  BudgetPause,
  formatResumeMarker,
  parseResumeMarker,
  pastDeadline,
} from "./provisioningBudget";

/** Schemas replicated onto a clone. `aml` is not optional — the prime keeps 106 tables there. */
export const REPLICATED_SCHEMAS = ["public", "aml"] as const;

const SCHEMA_LIST = REPLICATED_SCHEMAS.map((s) => `'${s}'`).join(", ");

/** Data API roles whose table privileges must come across, or PostgREST 401/403s on every table. */
export const API_ROLES = ["anon", "authenticated", "service_role"] as const;
const API_ROLE_LIST = API_ROLES.map((r) => `'${r}'`).join(", ");

/** Max passes for the function-convergence loop, so a genuine error cannot loop forever. */
export const MAX_FUNCTION_PASSES = 5;

/**
 * The order the stages run in, and the vocabulary of the resume marker.
 *
 * Declared once and exported because three places have to agree about it: the
 * pipeline that walks it, the row that stores where it paused, and the test
 * that pins the two together. An index into this list IS the marker.
 */
export const STAGE_SEQUENCE: readonly StageName[] = [
  "enums",
  "sequences",
  "tables",
  "functions",
  "constraints",
  "indexes",
  "views",
  "matviews",
  "triggers",
  "rls",
  "policies",
  "grants",
] as const;

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
  /**
   * True when this pass began partway through the sequence, so it says
   * nothing about the stages it skipped. Such a pass never reports `ok`: it
   * asks for one more full pass, which is cheap because every finished stage
   * now answers `alreadyReconciled` immediately.
   */
  partial: boolean;
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

/**
 * `already exists` / `duplicate …` are success on a re-run, not failures.
 *
 * `multiple primary keys … are not allowed` belongs with them, and did not use
 * to. A table created by the tables stage carries its primary key inline, so
 * the constraints stage re-adds one Postgres already has — and it says so with
 * that wording rather than "already exists". Reconciliation was never affected
 * (it counts objects, not errors), but the ledger was: 17,008 recorded
 * constraint failures on the 31 Aug 2026 dry run, of which five tables
 * contributed 200 by themselves, every one of them a key that was already
 * correctly in place.
 *
 * That matters because the ledger is where a real failure is found. A log full
 * of non-failures is how a genuine one goes unread — and the sample an
 * operator sees is capped at twenty, so noise does not merely dilute the
 * signal, it evicts it.
 */
export function isBenignDdlError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("already exists") ||
    m.includes("duplicate key") ||
    m.includes("duplicate object") ||
    m.includes("duplicate table") ||
    m.includes("duplicate column") ||
    m.includes("multiple primary keys")
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

export type ColumnInfo = {
  table: string;
  column: string;
  type: string;
  notNull?: boolean;
  /** The column's default expression, or a generated column's own expression. */
  default?: string | null;
  /** pg_attribute.attgenerated: 's' = STORED generated column. */
  generated?: string | null;
};

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
  return missing.map((c) => {
    const head = `alter table ${c.table} add column if not exists ${c.column} ${c.type}`;
    // A generated column added as a plain one does not fail — it succeeds, and
    // reconciles, and is wrong for ever after: the count matches while the
    // value never populates. Carry the expression or do not carry the column.
    return c.generated === "s" && c.default
      ? `${head} generated always as (${c.default}) stored`
      : head;
  });
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
  /**
   * pg_attribute.attgenerated: 's' = STORED generated column, '' = none.
   *
   * A generated column's expression lives in `pg_attrdef` exactly like a
   * default, so reading the column list without this flag produces
   * `default (released_at IS NULL)` — which Postgres refuses with "cannot use
   * column reference in DEFAULT expression", because a default may not see
   * other columns.
   *
   * The whole CREATE TABLE fails on it, so this is never one lost column: on
   * the 1 Sep 2026 dry run seven tables could not be created at all, and
   * behind them 272 columns and 38 constraints failed with "relation does not
   * exist" — a cascade that reads as five unrelated faults and is one.
   */
  generated?: string | null;
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
    } else if (c.generated === "s" && c.default) {
      // Its expression is stored as a default but is NOT one — see ColumnDef.
      s += ` generated always as (${c.default}) stored`;
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
  /**
   * Checked BETWEEN batches, never inside one. Every batch commits on its own,
   * so stopping between them leaves the clone in a state the next invocation
   * simply continues from — while being KILLED mid-stage costs a 15-minute
   * stall reclaim and repeats the whole stage. The `functions` stage is the
   * proof: 624 definitions in batches of 15, up to five convergence passes,
   * which no single invocation was ever going to finish.
   *
   * Batch granularity is the finest interruption this pipeline can honestly
   * offer: below it lies a single `apply_ddl_batch` call, which is one
   * server-side transaction and not ours to divide.
   */
  pauseIfDue?: (about: string, batchIndex?: number) => void,
  /**
   * Batch to resume AT, from a previous invocation's pause.
   *
   * A stage that is genuinely short cannot be skipped, and one whose statement
   * list is larger than a single budget therefore could never finish: it
   * restarted at batch zero every pass and applied the same prefix for ever.
   * Grants showed it first (46 of 149 batches, a dozen passes, three hours);
   * constraints showed it again after grants was made skippable.
   *
   * Safe because the statement list is regenerated by the same ordered query
   * each pass and every statement is idempotent — and because a resumed pass
   * never pronounces the schema complete, so one full pass always re-verifies
   * from the top.
   */
  startBatch = 0,
): Promise<BatchApplyResult> {
  const result: BatchApplyResult = { applied: 0, failed: 0, errors: [] };
  const batches = chunk(statements, batchSize);
  const from = Math.min(Math.max(0, startBatch), batches.length);
  for (let i = from; i < batches.length; i++) {
    const batch = batches[i];
    // Never before the first batch this invocation runs: a worker that has
    // claimed the job must move it, or recycling makes no progress at all.
    if (i > from) pauseIfDue?.(`${stage}: ${i}/${batches.length} batches applied`, i);
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
              a.attgenerated::text as generated,
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

/**
 * Every stage's count for one side, in ONE round trip.
 *
 * `alreadyReconciled` asked two questions per stage and there are twelve
 * stages, so proving a finished schema cost 24 serial Management-API calls at
 * roughly a second each. On a clone whose schema is already complete that is
 * the entire purpose of the pass, and it was ~19 seconds of a 50-second
 * budget — which the tail of the pipeline then does not have. Measured 3 Sep
 * 2026: the cron schedule and the realtime publication were each landing one
 * to three items a pass, not because anything failed but because nothing was
 * left to spend.
 *
 * The counts are the same SQL, composed into one statement per side. A side
 * that cannot be read answers an empty map and every stage falls back to
 * asking for itself — the fallback does the work rather than assuming it is
 * done.
 */
type StageProbe = { n: number; digest: string | null };

async function countAllOn(ref: string): Promise<Partial<Record<StageName, StageProbe>>> {
  // The digest rides in the SAME union as the count, so a stage that needs a
  // definition comparison costs nothing extra to prove finished. A stage with
  // no digest declared answers null and falls back to counting alone.
  const sql = STAGE_SEQUENCE.map(
    (stage) =>
      `select ${sqlLiteral(stage)} as stage, (${COUNTS[stage]}) as n, ` +
      `${DIGESTS[stage] ? `(${DIGESTS[stage]})` : "null"}::text as d`,
  ).join(" union all ");
  try {
    const rows = await query(ref, sql);
    const out: Partial<Record<StageName, StageProbe>> = {};
    for (const r of rows) {
      const stage = str(r.stage) as StageName;
      if (STAGE_SEQUENCE.includes(stage)) {
        out[stage] = { n: num(r.n), digest: r.d == null ? null : str(r.d) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A DEFINITION digest, for the stages where a count cannot see drift.
 *
 * A count answers "does the clone hold as many of these as the prime". It
 * cannot answer "are they the same ones", and for anything whose identity is
 * its DDL rather than its existence, those are different questions.
 *
 * Measured 4 Sep 2026 on both engine-provisioned clones. The prime's
 * `builder_stock_items_rearm_settlement` fires
 * `AFTER INSERT OR UPDATE OF enrichment_status, image_work_stage`; both clones
 * carry a trigger of that name firing `AFTER INSERT` alone — the narrow form
 * the prime's own repository still declares, copied before the prime was
 * widened by hand. One trigger row on each side, so every count reconciles,
 * and the trigger silently does not fire for the updates it exists for. Only
 * the parity report saw it, because parity keys triggers per EVENT.
 *
 * Two things had to change for the engine to be able to repair that.
 * `pg_get_triggerdef` renders a bare `CREATE TRIGGER`, which ERRORS on a
 * trigger that already exists (see toReplaceableTriggerDdl), and the count
 * skip meant the stage was never entered to try.
 *
 * The digest is a FAST PATH and never a verdict of its own: equal digests
 * prove the clone holds exactly the prime's definitions, so the stage is
 * skipped for free. Unequal digests prove nothing — a clone legitimately
 * holds objects the prime has since dropped (see the surplus reading), which
 * would make an equality test re-run the stage for ever. So the stage then
 * asks both sides for their definition LISTS and applies containment.
 */
const DIGESTS: Partial<Record<StageName, string>> = {
  /*
    Indexes are digested by NAME, not by definition.

    A count cannot see WHICH indexes, and a clone legitimately holds a surplus
    (introspection creates and never drops), so `cloneCount >= primeCount`
    reconciles while the clone is genuinely short. Measured 4 Sep 2026 on the
    NPC Test clone: 2,166 indexes on each side, reconciled on every pass, and
    `builder_stock_items_org_development_unit_design_key` — the partial,
    expression-based UNIQUE index that stops duplicate builder stock rows —
    absent. Never attempted: `aurixa.ddl_failures` holds no record of it,
    because the stage was skipped rather than failing. Parity could see it and
    the builder could not act on it, which is the shortfall the trigger digest
    already closed for its own class.

    Only equality is conclusive, exactly as for triggers: an unequal digest is
    the ORDINARY state here (the surplus guarantees it), so it sends the stage
    on to compare name LISTS and apply only what the clone lacks. Entering
    costs one query and, when nothing is missing, zero statements.
  */
  indexes: `select md5(coalesce(string_agg(i.indexname, E'\n' order by i.indexname), ''))
              from pg_indexes i where i.schemaname in (${SCHEMA_LIST})`,
  triggers: `select md5(coalesce(string_agg(d, E'\n' order by d), '')) from (
               select pg_get_triggerdef(t.oid) as d
                 from pg_trigger t
                 join pg_class c on c.oid = t.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where not t.tgisinternal and n.nspname in (${SCHEMA_LIST})) g`,
};

/** A stage is reconciled when the clone holds at least as many objects as the prime. */
export function reconcile(primeCount: number, cloneCount: number): boolean {
  return cloneCount >= primeCount;
}

/**
 * Make a trigger definition re-appliable.
 *
 * `pg_get_triggerdef` renders `CREATE TRIGGER x ...`, which is an ERROR
 * against a trigger that already exists — so the one statement that could
 * repair a drifted trigger was the one statement guaranteed to fail. Postgres
 * 14 added `CREATE OR REPLACE TRIGGER`, and every project this engine builds
 * is well past that.
 *
 * A CONSTRAINT trigger is deliberately left alone: `CREATE OR REPLACE
 * CONSTRAINT TRIGGER` is not valid syntax, so rewriting one would turn a
 * trigger that merely fails as a duplicate into a trigger that fails to parse.
 * The prime carries none today; this is here so that stays true by
 * construction rather than by luck.
 */
export function toReplaceableTriggerDdl(def: string): string {
  return /^\s*create\s+trigger\s/i.test(def)
    ? def.replace(/^(\s*)create\s+trigger\s/i, "$1create or replace trigger ")
    : def;
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
  /**
   * Counts taken once at the start of the pass. A clone's count only ever
   * GROWS during a pass, so a prefetched figure is a lower bound: reading it
   * as reconciled stays true, and reading it as short only re-runs a stage
   * that had nothing to do. Both directions are safe; the expensive one is
   * safe in the harmless direction.
   */
  prefetch?: {
    prime: Partial<Record<StageName, StageProbe>>;
    clone: Partial<Record<StageName, StageProbe>>;
  },
): Promise<StageResult | null> {
  const pre = prefetch?.prime[stage];
  const cre = prefetch?.clone[stage];
  const [primeCount, cloneCount] =
    pre && cre
      ? [pre.n, cre.n]
      : await Promise.all([countOn(primeRef, stage), countOn(cloneRef, stage)]);
  if (!reconcile(primeCount, cloneCount)) return null;

  // Counting says the clone holds enough. For a stage whose identity is its
  // DDL that is not the same as holding the RIGHT ones, and a digest is how
  // this pass can tell for free (see DIGESTS). Only EQUALITY is conclusive:
  // unequal digests are the ordinary state of a clone carrying objects the
  // prime has since dropped, so they send the stage on to compare definitions
  // rather than deciding anything.
  if (DIGESTS[stage] && pre?.digest && cre?.digest && pre.digest !== cre.digest) return null;

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
  pauseIfDue?: (about: string, batchIndex?: number) => void,
  startBatch = 0,
): Promise<StageResult> {
  const applyResult = await applyStatements(
    cloneRef,
    stage,
    statements,
    batchSize,
    pauseIfDue,
    startBatch,
  );
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
  options: {
    primeRef: string;
    onStatusUpdate?: Notify;
    deadlineAt?: number | null;
    /**
     * Stage this invocation should pick up at, from a previous pause. Stages
     * before it were carried by an earlier invocation and are skipped without
     * paying for their catalogue reads. Unset (or unrecognised) starts at the
     * beginning.
     */
    resumeFrom?: string | null;
  },
): Promise<IntrospectionResult> {
  const primeRef = options.primeRef;
  const notify = options?.onStatusUpdate;
  const stages: StageResult[] = [];
  const say = async (detail: string) => {
    await notify?.("migrating", detail);
  };
  // ── Where this invocation starts, and where it says it stopped ──
  //
  // Every stage is idempotent, so replaying one is harmless — but it is not
  // free, and on a prime this size the `tables` stage alone costs a whole
  // invocation. Replaying the prefix every time meant the run reached the
  // same pause point on every pass and the stages after it were never given
  // any budget: 155 of 624 functions, unchanged across three consecutive
  // passes, pausing correctly and progressing not at all.
  //
  // The marker is the stage to resume AT, so an interrupted stage re-runs
  // from its own start while carried stages are skipped.
  const resumeMarker = parseResumeMarker(options.resumeFrom);
  const startIndex = Math.max(
    0,
    resumeMarker.stage ? STAGE_SEQUENCE.indexOf(resumeMarker.stage as StageName) : 0,
  );
  let reachedStage: StageName = STAGE_SEQUENCE[startIndex] ?? "enums";
  let ranAStageThisPass = false;

  /**
   * The batch to resume the interrupted stage at — and ONLY that stage. Once
   * this pass moves on to any other stage the offset is spent, because a batch
   * index means nothing outside the statement list it was counted in.
   */
  let resumeBatch = resumeMarker.batch;
  const takeResumeBatch = (stage: StageName): number =>
    stage === resumeMarker.stage ? resumeBatch : 0;

  const pauseIfDue = (about: string, batchIndex?: number) => {
    if (pastDeadline(options.deadlineAt)) {
      throw new BudgetPause(about, formatResumeMarker(reachedStage, batchIndex));
    }
  };

  /**
   * Enter a stage, or report that an earlier invocation already carried it.
   *
   * The first stage this invocation actually runs never pauses: a worker that
   * has claimed the job must move it, or the recycling makes no forward
   * progress at all.
   */
  const enterStage = (stage: StageName): boolean => {
    if (STAGE_SEQUENCE.indexOf(stage) < startIndex) return false;
    // Moving to a later stage spends the offset: the interrupted stage is
    // behind us, and its batch index does not describe this one's list.
    if (stage !== resumeMarker.stage) resumeBatch = 0;
    reachedStage = stage;
    if (ranAStageThisPass) pauseIfDue(`introspection: ${stage} onward resumes next tick`);
    ranAStageThisPass = true;
    return true;
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
    const done = await alreadyReconciled(stage, primeRef, cloneRef, prefetch);
    if (done) return done;
    // BUILDING a stage's statements is work too, and `applyStatements` only
    // checks the budget between batches — so a build that overruns takes the
    // worker with it. Grants is the one that shows it: its statement list is
    // ~8,900 rows read out of `information_schema.role_table_grants`, and a
    // resumed pass rebuilds the whole list before applying its next slice.
    // The marker carries no batch index here on purpose: nothing has been
    // applied, so the next pass re-enters this stage at the batch it left off
    // at rather than at one it never reached.
    const startBatch = takeResumeBatch(stage);
    pauseIfDue(`introspection: ${stage} statements build resumes next tick`, startBatch);
    return runStage(
      stage,
      primeRef,
      cloneRef,
      await statements(),
      batchSize,
      undefined,
      pauseIfDue,
      startBatch,
    );
  };

  // One round trip per side instead of 24, taken before the first stage.
  // Both sides in parallel: they are different projects.
  const [prefetchPrime, prefetchClone] = await Promise.all([
    countAllOn(primeRef),
    countAllOn(cloneRef),
  ]);
  const prefetch = { prime: prefetchPrime, clone: prefetchClone };

  await ensureApplyHelper(cloneRef);
  await runSqlOnProject(
    cloneRef,
    REPLICATED_SCHEMAS.map((s) => `create schema if not exists ${quoteIdent(s)};`).join("\n"),
  );

  // 1. enum types
  if (enterStage("enums")) {
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
  }

  // 2. sequences
  if (enterStage("sequences")) {
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
  }

  // 3. tables
  //
  // The ONE stage that never asks `alreadyReconciled` first, and deliberately.
  // Every other stage's work is fully described by its object count, so equal
  // counts mean equal schemas. Tables are not: `create table if not exists`
  // skips a table that already exists, so COLUMN DRIFT survives with the
  // counts matching exactly — which is the fault diffMissingColumns exists to
  // repair. Skipping on the count would skip the repair with it. (columns only — constraints and indexes come later)
  //
  // `tableStmts` and `tableStage` outlive this block: step 4b re-applies the
  // table DDL once functions exist. A pass that skipped this stage has
  // neither, and 4b is guarded on that rather than rebuilding them — the next
  // full pass carries it, and rebuilding means another ~10,000-row read.
  let tableStmts: string[] | null = null;
  let tableStage: StageResult | null = null;
  if (enterStage("tables")) {
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
      const entry = grouped.get(key) ?? {
        schema: str(r.schema),
        table: str(r.table_name),
        cols: [],
      };
      entry.cols.push({
        name: str(r.column_name),
        type: str(r.data_type),
        notNull: r.not_null === true || r.not_null === "true",
        default: r.column_default == null ? null : str(r.column_default),
        identity: r.identity == null ? null : str(r.identity),
        generated: r.generated == null ? null : str(r.generated),
      });
      grouped.set(key, entry);
    }

    tableStmts = Array.from(grouped.values()).map((t) =>
      buildCreateTableDdl(t.schema, t.table, t.cols),
    );
    // Applying ~700 `create table if not exists` statements against a clone
    // that already holds every one of them is pure cost, and it is the cost
    // that deadlocked this pipeline: the tables stage consumed most of each
    // invocation, so a full pass never finished the schema, always ended
    // `partial`, and a partial pass may not proceed to the edge functions.
    // The engine could complete the schema and never get past it.
    //
    // So skip the APPLICATION when the count already reconciles — and only
    // the application. The column-drift repair below still runs, which is the
    // whole reason this stage does not use `alreadyReconciled`: equal counts
    // do not mean equal tables.
    // From the prefetch where it has both sides — this is the same "is it
    // already there" question every other stage asks, and on a complete
    // schema it is the only question the pass has.
    const tableCounts =
      typeof prefetch.prime.tables === "number" && typeof prefetch.clone.tables === "number"
        ? [prefetch.prime.tables, prefetch.clone.tables]
        : await Promise.all([countOn(primeRef, "tables"), countOn(cloneRef, "tables")]);
    const tablesAlreadyPresent = reconcile(tableCounts[0], tableCounts[1]);
    tableStage = tablesAlreadyPresent
      ? {
          stage: "tables",
          primeCount: tableCounts[0],
          cloneCount: tableCounts[1],
          applied: 0,
          failed: 0,
          reconciled: true,
          notes: ["every table present — creation skipped, drift still checked"],
        }
      : await runStage(
          "tables",
          primeRef,
          cloneRef,
          tableStmts,
          60,
          undefined,
          pauseIfDue,
          takeResumeBatch("tables"),
        );

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
        default: r.column_default == null ? null : str(r.column_default),
        generated: r.generated == null ? null : str(r.generated),
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
        pauseIfDue,
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
  }

  // 4. functions — repeat until the failure count stops falling
  if (enterStage("functions")) {
    await say("Replicating functions...");
    const fnRows = await query(primeRef, Q.functions);
    // RE-POINT BEFORE COMPARING, AND BEFORE APPLYING.
    //
    // Exactly four of the prime's functions embed its project ref, and the
    // pipeline rewrites them to the clone's own ref at step 5c — a clone whose
    // functions call the prime's project is a tenant reaching into somebody
    // else's database. But this stage compared the prime's definition text
    // against the clone's, so those four read as outstanding on EVERY pass and
    // were re-applied with the prime's ref in them, for step 5c to rewrite
    // again later in the same pass.
    //
    // Measured 4 Sep 2026 on the NPC Test clone, caught mid-pass: all four of
    // `bootstrap_cron_vault`, `dispatch_web_push_for_portal_notification`,
    // `dispatch_web_push_on_notification` and
    // `invoke_pdf_parse_recover_stuck_jobs` were naming the PRIME's project,
    // because that pass had run this stage and had not yet reached step 5c.
    // Passes pause constantly between the two — that is the whole design — so
    // a clone can sit in that state indefinitely, and a pass that dies in the
    // window leaves it there.
    //
    // Rewriting here closes the window rather than narrowing it: what the
    // clone SHOULD hold is the re-pointed text, so that is what "already held"
    // has to mean, and a definition that genuinely needs applying is applied
    // already pointing at the clone. Step 5c stays as the repair for rows
    // written before this, and now has nothing to undo.
    const toCloneRef = (def: string) =>
      primeRef && def.includes(primeRef) ? def.split(primeRef).join(cloneRef) : def;
    const allFnStmts = fnRows.map((r) => toCloneRef(str(r.def))).filter(Boolean);
    const history: number[] = [];
    let lastApply: BatchApplyResult = { applied: 0, failed: 0, errors: [] };
    let totalApplied = 0;
    let lastOutstanding = allFnStmts.length;
    while (shouldRunAnotherFunctionPass(history)) {
      // ASK THE TARGET WHAT IT ALREADY HOLDS, exactly as the stage gate and
      // the edge-function deploy do. This stage applies 739 definitions in
      // batches of 15, and it restarts at batch zero on every invocation —
      // so without this, a budgeted pass spends nearly all of its slice
      // re-issuing CREATE OR REPLACE for functions the clone already has and
      // never reaches the tail. Measured on 31 Aug 2026: the count sat at
      // 594 across a dozen consecutive passes, all of them reporting
      // "Functions pass 1" and all of them doing real work that changed
      // nothing.
      //
      // The comparison is on the definition TEXT, both sides rendered by the
      // same pg_get_functiondef. Identical text is the same function, so
      // skipping it is exactly what CREATE OR REPLACE would have done; any
      // difference at all re-applies. The bias is deliberate — an unnecessary
      // re-apply costs a batch, a wrongly skipped one costs correctness.
      const held = new Set(
        (await query(cloneRef, Q.functions)).map((r) => str(r.def)).filter(Boolean),
      );
      const fnStmts = allFnStmts.filter((stmt) => !held.has(stmt));
      lastOutstanding = fnStmts.length;
      if (fnStmts.length === 0) {
        history.push(0);
        break;
      }
      await say(
        `Functions pass ${history.length + 1} — ${fnStmts.length} of ${allFnStmts.length} outstanding...`,
      );
      lastApply = await applyStatements(cloneRef, "functions", fnStmts, 15, pauseIfDue);
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
      notes: [
        `convergence: ${history.join(" → ")}`,
        `outstanding at last pass: ${lastOutstanding}`,
      ],
    });
  }

  // 4b. A column default that calls a user function could not be created
  // before stage 4 existed. Re-apply the table DDL once the functions are in
  // place and re-reconcile, so that ordering cannot silently lose a table.
  if (tableStmts && tableStage && (!tableStage.reconciled || tableStage.failed > 0)) {
    await say("Re-applying tables now that functions exist...");
    // This re-apply had NO budget check, and it is ~700 statements. An
    // invocation that ran out of clock here was KILLED rather than pausing,
    // which costs a hard attempt every time instead of a free requeue: the
    // 1 Sep 2026 run went from attempts 1 to 3 in this block, one short of
    // terminating a job whose schema was otherwise nearly complete.
    //
    // It pauses against the TABLES stage rather than the stage the cursor
    // happens to sit on, because that is the work being redone — resuming at
    // `functions` would skip the tables stage, leave `tableStmts` null, and
    // guard this block off entirely, so the repair would never run again.
    const pauseInTableRetry = (about: string, batchIndex?: number) => {
      if (pastDeadline(options.deadlineAt)) {
        throw new BudgetPause(about, formatResumeMarker("tables", batchIndex));
      }
    };
    const retry = await applyStatements(
      cloneRef,
      "tables:retry",
      tableStmts,
      60,
      pauseInTableRetry,
      takeResumeBatch("tables"),
    );
    tableStage.applied += retry.applied;
    tableStage.failed = retry.failed;
    tableStage.cloneCount = await countOn(cloneRef, "tables");
    tableStage.reconciled =
      reconcile(tableStage.primeCount, tableStage.cloneCount) &&
      !(tableStage.notes ?? []).some((n) => n.startsWith("still drifted"));
    tableStage.notes = [...(tableStage.notes ?? []), `retry after functions: +${retry.applied}`];
  }

  // 5. constraints, ordered p → u → c → f
  if (enterStage("constraints")) {
    await say("Replicating constraints...");
    stages.push(
      await stageOrSkip(
        "constraints",
        async () => {
          const conRows = await query(primeRef, Q.constraints);
          return conRows.map(
            (r) =>
              `alter table ${quoteIdent(str(r.schema))}.${quoteIdent(str(r.table_name))} add constraint ${quoteIdent(
                str(r.name),
              )} ${str(r.def)}`,
          );
        },
        60,
      ),
    );
  }

  // 6. indexes — skipping the constraint-backed ones stage 5 already made
  //
  // `idxStmts` outlives this block: step 8b re-applies it once materialized
  // views exist, since an index can belong to one. A pass that skipped this
  // stage has none, and 8b is guarded on that.
  let idxStmts: string[] | null = null;
  if (enterStage("indexes")) {
    await say("Replicating indexes...");
    stages.push(
      await stageOrSkip(
        "indexes",
        async () => {
          const idxRows = await query(primeRef, Q.indexes);
          const conIdxNames = new Set(
            (await query(primeRef, Q.constraintIndexNames)).map((r) => str(r.indexname)),
          );
          // Captured for step 8b. A pass that SKIPPED this stage leaves it
          // null, and 8b is guarded on that.
          // ASK THE CLONE WHICH IT HOLDS, and carry only the rest — the
          // same rule the triggers stage follows, and what makes entering
          // this stage cheap now that a surplus keeps its digest unequal
          // for ever. A clone whose index list cannot be read is treated as
          // holding NONE, so every index goes back on the create path rather
          // than being assumed present.
          const heldIdx = new Set(
            (await query(cloneRef, Q.indexes).catch(() => [] as Array<Record<string, unknown>>)).map(
              (r) => str(r.indexname),
            ),
          );
          idxStmts = filterCreatableIndexes(
            idxRows
              .map((r) => ({ indexname: str(r.indexname), indexdef: str(r.indexdef) }))
              .filter((i) => !heldIdx.has(i.indexname)),
            conIdxNames,
          ).map((def) =>
            def.replace(/^create (unique )?index /i, (m) => `${m.trimEnd()} if not exists `),
          );
          return idxStmts;
        },
        60,
      ),
    );
  }

  // 7. views — a view on a view fails when the callee is not in place yet, and
  // catalog order is not dependency order, so converge the same way functions do.
  const viewsDone = enterStage("views")
    ? await alreadyReconciled("views", primeRef, cloneRef, prefetch)
    : null;
  if (viewsDone) stages.push(viewsDone);
  else if (STAGE_SEQUENCE.indexOf("views") >= startIndex) {
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
      viewApply = await applyStatements(cloneRef, "views", viewStmts, 30, pauseIfDue);
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
  }

  // 8. materialized views (relkind 'm' — every table query misses these, and
  //    an index belongs to one, so skipping this breaks the index stage)
  if (enterStage("matviews")) {
    await say("Replicating materialized views...");
    stages.push(
      await stageOrSkip(
        "matviews",
        async () =>
          (await query(primeRef, Q.matviews)).map(
            (r) =>
              `create materialized view if not exists ${quoteIdent(str(r.schema))}.${quoteIdent(
                str(r.name),
              )} as ${str(r.def)}`,
          ),
        15,
      ),
    );
  }

  // 8b. Indexes that belong to matviews could not exist before stage 8.
  // Only when this pass built the index statements; otherwise the next full
  // pass carries it rather than paying for the catalogue read again.
  const idxStage = stages.find((s) => s.stage === "indexes");
  if (idxStmts && idxStage) {
    const idxAfterMv = await applyStatements(cloneRef, "indexes:matview", idxStmts, 60, pauseIfDue);
    idxStage.applied += idxAfterMv.applied;
    idxStage.cloneCount = await countOn(cloneRef, "indexes");
    idxStage.failed = idxAfterMv.failed;
    idxStage.reconciled = reconcile(idxStage.primeCount, idxStage.cloneCount);
  }

  // 9. triggers
  //
  // The one stage that carries only what the clone is actually missing.
  //
  // Reaching here means the digests disagreed (or could not be taken), which
  // is the ordinary state of a clone holding triggers the prime has dropped —
  // so applying the prime's whole list every pass would be F20 again, 474
  // statements to change nothing. Both sides' definitions are compared as
  // TEXT and only the prime definitions the clone does not already hold are
  // applied. That set is normally empty, and when it is not it is one or two
  // statements naming exactly what drifted.
  if (enterStage("triggers")) {
    await say("Replicating triggers...");
    stages.push(
      await stageOrSkip(
        "triggers",
        async () => {
          const [primeDefs, cloneDefs] = await Promise.all([
            query(primeRef, Q.triggers),
            // A clone whose triggers cannot be read holds nothing as far as
            // this is concerned, which puts every definition back on the
            // write path: the fallback does the work rather than assuming it
            // is done. `create or replace` makes that safe to repeat.
            query(cloneRef, Q.triggers).catch(() => [] as Array<Record<string, unknown>>),
          ]);
          const held = new Set(cloneDefs.map((r) => str(r.def)).filter(Boolean));
          return primeDefs
            .map((r) => str(r.def))
            .filter(Boolean)
            .filter((def) => !held.has(def))
            .map(toReplaceableTriggerDdl);
        },
        60,
      ),
    );
  }

  // 10. RLS enable
  if (enterStage("rls")) {
    await say("Enabling row level security...");
    stages.push(
      await stageOrSkip(
        "rls",
        async () =>
          (await query(primeRef, Q.rlsTables)).map(
            (r) =>
              `alter table ${quoteIdent(str(r.schema))}.${quoteIdent(str(r.name))} enable row level security`,
          ),
        60,
      ),
    );
  }

  // 11. policies
  if (enterStage("policies")) {
    await say("Replicating RLS policies...");
    stages.push(
      await stageOrSkip(
        "policies",
        async () =>
          (await query(primeRef, Q.policies)).map((r) =>
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
  }

  // 12. Data API grants. RLS alone is not access: without the prime's table
  // privileges PostgREST cannot reach a single table on the clone.
  if (enterStage("grants")) {
    await say("Replicating Data API grants...");
    stages.push(
      await stageOrSkip(
        "grants",
        async () => {
          const grantRows = await query(primeRef, Q.grants);
          return grantRows.map((r) =>
            buildGrantDdl(str(r.schema), str(r.table_name), str(r.grantee), str(r.privilege_type)),
          );
        },
        60,
      ),
    );
  }

  // A pass that began partway through says nothing about the stages it
  // skipped, so it never pronounces the schema complete: it reports `partial`,
  // the caller clears the marker, and one more pass runs from the top to
  // verify the lot. That pass is cheap — every finished stage answers
  // `alreadyReconciled` with two COUNTs — and it is what closes the loop,
  // because a stage that could not finish early (tables needs types the
  // functions stage creates) succeeds once the rest of the schema exists.
  const partial = startIndex > 0;
  const shortStages = stages.filter((s) => !s.reconciled).map((s) => s.stage);
  return {
    ok: !partial && shortStages.length === 0,
    primeRef,
    cloneRef,
    stages,
    shortStages,
    partial,
  };
}

// ─── Emptiness verification ──────────────────────────────────────────

export type EmptinessResult = {
  empty: boolean;
  totalRows: number;
  nonEmpty: Array<{ table: string; rows: number }>;
  /** False when the budget ran out mid-scan: `totalRows` is then a floor, not a total. */
  complete: boolean;
  tablesScanned: number;
  tablesTotal: number;
};

/**
 * The clone must hold zero rows after introspection (apart from the seeded
 * admin). Counts every row across the replicated schemas.
 *
 * Budgeted, because it runs immediately after the schema build — the step
 * most likely to have just spent the invocation's whole allowance — and it is
 * a DIAGNOSTIC that gates nothing: its result is recorded on the introspection
 * summary and nothing branches on it. On the 2 Sep 2026 dry run it counted 649
 * tables in seven Management-API round trips with no deadline check anywhere
 * in front of it or inside it, so a pass that arrived here with no budget left
 * was KILLED rather than paused — and a kill costs a 15-minute stall reclaim
 * where a pause costs 60 seconds. A measurement must never be able to cost
 * more than the thing it measures.
 *
 * An interrupted scan reports `complete: false` and its caller records the
 * row count as unknown. A partial count read as a total is a clone certified
 * empty on the strength of the tables that happened to be scanned first.
 */
export async function verifyCloneIsEmpty(
  cloneRef: string,
  options?: { allowRows?: number; deadlineAt?: number },
): Promise<EmptinessResult> {
  const listSql = `select n.nspname as schema, c.relname as name
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where c.relkind = 'r' and n.nspname in (${SCHEMA_LIST})
                   order by 1, 2`;
  const tables = await query(cloneRef, listSql);
  const nonEmpty: Array<{ table: string; rows: number }> = [];
  let totalRows = 0;
  let tablesScanned = 0;
  let complete = true;
  for (const group of chunk(tables, 100)) {
    if (!group.length) continue;
    if (pastDeadline(options?.deadlineAt)) {
      complete = false;
      break;
    }
    const union = group
      .map(
        (t) =>
          `select ${sqlLiteral(`${str(t.schema)}.${str(t.name)}`)} as t, count(*)::int as n from ${quoteIdent(
            str(t.schema),
          )}.${quoteIdent(str(t.name))}`,
      )
      .join(" union all ");
    const rows = toRows(await runSqlOnProject(cloneRef, assertReadOnlySourceQuery(union)));
    tablesScanned += group.length;
    for (const r of rows) {
      const n = num(r.n);
      totalRows += n;
      if (n > 0) nonEmpty.push({ table: str(r.t), rows: n });
    }
  }
  return {
    // A scan that did not finish has not shown the clone to be empty, however
    // few rows it found before it stopped.
    empty: complete && totalRows <= (options?.allowRows ?? 0),
    totalRows,
    nonEmpty,
    complete,
    tablesScanned,
    tablesTotal: tables.length,
  };
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
): Promise<{ stamped: number; reconciled: boolean }> {
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

  // Ask before writing, the same rule every schema stage follows. The inserts
  // are idempotent (`on conflict do nothing`), so re-running them is harmless
  // — but not free, and this runs on EVERY pass, ahead of the edge-function
  // deployment that is the pass's actual remaining work. One count is cheaper
  // than five multi-row inserts.
  //
  // Skipping on an equal count is not the silent skip this function's own
  // guard is about: a short ledger still gets stamped, and an EMPTY prime
  // ledger still throws above. What is refused here is only the repetition.
  const cloneLedger = await query(
    cloneRef,
    `select count(*)::int as n from supabase_migrations.schema_migrations`,
  ).catch(() => [] as Array<Record<string, unknown>>);
  if (reconcile(rows.length, num(cloneLedger[0]?.n))) {
    return { stamped: 0, reconciled: true };
  }

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
  return { stamped, reconciled: false };
}
