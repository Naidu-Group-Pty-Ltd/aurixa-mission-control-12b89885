// A test double for the tables a clone's billing tenant lives in: `clones`,
// `billing_plans`, `tenants` and `token_ledger`, behind the slice of the
// PostgREST builder that `ensureTenant` and `clone-metering-tenant.server.ts`
// use.
//
// It answers as the server does rather than replaying canned results:
//
//  - a select returns only the columns it names, and resolves the embeds it
//    names (`billing_plans:plan_id(slug)`), so code that reads a column it did
//    not ask for reads `undefined`, as it would against PostgREST;
//  - `maybeSingle` answers null for no row and PGRST116 for several, and
//    `single` answers PGRST116 for anything but one;
//  - the constraints `tenants` carries in production are enforced, with
//    Postgres's own codes and wording: UNIQUE (clone_id, external_ref), the
//    partial unique indexes on `billing_user_id`, `stripe_customer_id` and a
//    clone-less `external_ref`, and the foreign keys to `clones` and
//    `billing_plans` (measured on Mission Control's database, 27 Oct 2026);
//  - an update matches its filters, so a compare-and-set that matches nothing
//    returns no rows.
//
// A failure is injected per table and operation, as the error PostgREST
// passes through for a statement the 8-second `authenticator` timeout
// cancelled. `beforeWrite` runs between a caller's read and its write, which
// is where a concurrent request lands.
import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;
type PgError = { message: string; code: string; details: string | null; hint: string | null };
type Result = { data: unknown; error: PgError | null };
type Op = "select" | "insert" | "update";

export const STATEMENT_TIMEOUT: PgError = {
  message: "canceling statement due to statement timeout",
  code: "57014",
  details: null,
  hint: null,
};

export type TenantFakeDb = {
  tables: { clones: Row[]; billing_plans: Row[]; tenants: Row[]; token_ledger: Row[] };
  /** `${table}.${op}` (or `rpc.${name}`) keys whose calls answer this error while set. */
  failures: Map<string, PgError>;
  /** Runs before an insert or update lands, as a concurrent writer would. */
  beforeWrite: ((table: string, op: Op) => void) | null;
  /** Every write that landed, in order. */
  writes: Array<{ table: string; op: Op; rows: Row[] }>;
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  from: (table: string) => Builder;
  rpc: (name: string, args: Record<string, unknown>) => Promise<Result>;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- a query builder is a fluent any-typed chain */
type Builder = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

const EMBEDS: Record<string, { table: keyof TenantFakeDb["tables"]; key: string }> = {
  "billing_plans:plan_id": { table: "billing_plans", key: "plan_id" },
  "clones:clone_id": { table: "clones", key: "clone_id" },
};

/** Split a select list at its top-level commas: `a, b:c(d, e)` → `a`, `b:c(d, e)`. */
function columnsOf(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of select) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function project(db: TenantFakeDb, row: Row, select: string | null): Row {
  if (select === null || select.trim() === "*") return structuredClone(row);
  const out: Row = {};
  for (const column of columnsOf(select)) {
    const embed = /^([a-z_]+:[a-z_]+)\((.*)\)$/.exec(column);
    if (embed) {
      const spec = EMBEDS[embed[1]];
      if (!spec) throw new Error(`tenant fake: embed ${embed[1]} is not modelled`);
      const target = db.tables[spec.table].find((r) => r.id === row[spec.key]);
      out[embed[1].split(":")[0]] = target ? project(db, target, embed[2]) : null;
    } else if (column === "*") {
      Object.assign(out, structuredClone(row));
    } else {
      out[column] = row[column] ?? null;
    }
  }
  return out;
}

function unique(name: string, columns: string, values: string): PgError {
  return {
    message: `duplicate key value violates unique constraint "${name}"`,
    code: "23505",
    details: `Key (${columns})=(${values}) already exists.`,
    hint: null,
  };
}

/** The constraints production's `tenants` carries, checked for one candidate row. */
function tenantViolation(db: TenantFakeDb, row: Row, self: Row | null): PgError | null {
  const others = db.tables.tenants.filter((t) => t !== self);
  if (row.clone_id && !db.tables.clones.some((c) => c.id === row.clone_id)) {
    return {
      message:
        'insert or update on table "tenants" violates foreign key constraint "tenants_clone_id_fkey"',
      code: "23503",
      details: `Key (clone_id)=(${row.clone_id}) is not present in table "clones".`,
      hint: null,
    };
  }
  if (row.plan_id && !db.tables.billing_plans.some((p) => p.id === row.plan_id)) {
    return {
      message:
        'insert or update on table "tenants" violates foreign key constraint "tenants_plan_id_fkey"',
      code: "23503",
      details: `Key (plan_id)=(${row.plan_id}) is not present in table "billing_plans".`,
      hint: null,
    };
  }
  // NULLs are distinct in a unique constraint, so (NULL, ref) never collides
  // here; the partial index below is what holds clone-less refs apart.
  if (
    row.clone_id != null &&
    others.some((t) => t.clone_id === row.clone_id && t.external_ref === row.external_ref)
  ) {
    return unique(
      "tenants_clone_id_external_ref_key",
      "clone_id, external_ref",
      `${row.clone_id}, ${row.external_ref}`,
    );
  }
  if (
    row.clone_id == null &&
    others.some((t) => t.clone_id == null && t.external_ref === row.external_ref)
  ) {
    return unique("tenants_prime_external_ref_key", "external_ref", String(row.external_ref));
  }
  for (const [column, index] of [
    ["billing_user_id", "tenants_billing_user_id_uidx"],
    ["stripe_customer_id", "tenants_stripe_customer_id_uidx"],
  ] as const) {
    if (row[column] != null && others.some((t) => t[column] === row[column])) {
      return unique(index, column, String(row[column]));
    }
  }
  return null;
}

export function createTenantFakeDb(seed: Partial<TenantFakeDb["tables"]> = {}): TenantFakeDb {
  const db: TenantFakeDb = {
    tables: {
      clones: (seed.clones ?? []).map((r) => ({ ...r })),
      billing_plans: (seed.billing_plans ?? []).map((r) => ({ ...r })),
      tenants: (seed.tenants ?? []).map((r) => ({ ...r })),
      token_ledger: (seed.token_ledger ?? []).map((r) => ({ ...r })),
    },
    failures: new Map(),
    beforeWrite: null,
    writes: [],
    rpcs: [],
    from: (table: string) => builder(db, table),
    rpc: async (name, args) => {
      db.rpcs.push({ name, args });
      const failure = db.failures.get(`rpc.${name}`);
      if (failure) return { data: null, error: failure };
      if (name === "grant_tokens") {
        db.tables.token_ledger.push({
          id: randomUUID(),
          tenant_id: args._tenant_id,
          kind: "grant",
          tokens: args._tokens,
          reason: args._reason,
          expires_at: args._expires_at ?? null,
          created_at: new Date().toISOString(),
        });
        return { data: null, error: null };
      }
      throw new Error(`tenant fake: rpc ${name} is not modelled`);
    },
  };
  return db;
}

function builder(db: TenantFakeDb, table: string): Builder {
  if (!(table in db.tables)) throw new Error(`tenant fake: table ${table} is not modelled`);
  const rows = () => db.tables[table as keyof TenantFakeDb["tables"]];
  let op: Op = "select";
  let values: Row | Row[] | null = null;
  let select: string | null = null;
  let returning = false;
  const filters: Array<(r: Row) => boolean> = [];
  let order: { column: string; ascending: boolean } | null = null;
  let limit: number | null = null;

  const run = (mode: "many" | "single" | "maybeSingle"): Result => {
    const failure = db.failures.get(`${table}.${op}`);
    if (failure) return { data: null, error: failure };

    let result: Row[];
    if (op === "select") {
      result = rows().filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { column, ascending } = order;
        result = [...result].sort((a, b) => {
          const x = a[column] as number | string;
          const y = b[column] as number | string;
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (limit !== null) result = result.slice(0, limit);
    } else {
      db.beforeWrite?.(table, op);
      if (op === "insert") {
        const now = new Date().toISOString();
        const incoming = (Array.isArray(values) ? values : [values ?? {}]).map((v) => ({
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          ...(table === "tenants" ? { status: "active", metadata: {}, billing_exempt: false } : {}),
          ...v,
        }));
        if (table === "tenants") {
          for (const row of incoming) {
            const violation = tenantViolation(db, row, null);
            if (violation) return { data: null, error: violation };
          }
        }
        rows().push(...incoming);
        result = incoming;
      } else {
        result = rows().filter((r) => filters.every((f) => f(r)));
        if (table === "tenants") {
          for (const row of result) {
            const violation = tenantViolation(db, { ...row, ...(values as Row) }, row);
            if (violation) return { data: null, error: violation };
          }
        }
        for (const row of result) Object.assign(row, values as Row);
      }
      db.writes.push({ table, op, rows: result.map((r) => ({ ...r })) });
    }

    const data = op === "select" || returning ? result.map((r) => project(db, r, select)) : null;
    if (mode === "single") {
      return data && data.length === 1
        ? { data: data[0], error: null }
        : {
            data: null,
            error: {
              message: "JSON object requested, multiple (or no) rows returned",
              code: "PGRST116",
              details: `The result contains ${data?.length ?? 0} rows`,
              hint: null,
            },
          };
    }
    if (mode === "maybeSingle") {
      if (data && data.length > 1) {
        return {
          data: null,
          error: {
            message: "JSON object requested, multiple (or no) rows returned",
            code: "PGRST116",
            details: `The result contains ${data.length} rows`,
            hint: null,
          },
        };
      }
      return { data: data?.[0] ?? null, error: null };
    }
    return { data, error: null };
  };

  const b: Builder = {
    select: (columns?: string) => {
      if (op !== "select") returning = true;
      select = columns ?? "*";
      return b;
    },
    insert: (v: Row | Row[]) => ((op = "insert"), (values = v), b),
    update: (v: Row) => ((op = "update"), (values = v), b),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    // `.filter(column, operator, value)`, for the two operators the callers
    // compose it from. `eq` never matches a NULL, as in SQL.
    filter: (c: string, operator: string, v: unknown) => {
      if (operator === "eq") filters.push((r) => r[c] != null && r[c] === v);
      else if (operator === "is") filters.push((r) => (r[c] ?? null) === v);
      else throw new Error(`tenant fake: filter operator ${operator} is not modelled`);
      return b;
    },
    in: (c: string, list: unknown[]) => (filters.push((r) => list.includes(r[c])), b),
    order: (c: string, opts?: { ascending?: boolean }) => (
      (order = { column: c, ascending: opts?.ascending !== false }),
      b
    ),
    limit: (n: number) => ((limit = n), b),
    maybeSingle: async () => run("maybeSingle"),
    single: async () => run("single"),
    then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(run("many")).then(resolve, reject),
  };
  return b;
}
