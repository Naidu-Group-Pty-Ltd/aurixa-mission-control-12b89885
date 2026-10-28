// A test double for the tables the module library lives in — `modules`,
// `module_detection_runs`, `module_library`, `clone_library_pins`,
// `clone_modules`, `audit_log`, `notifications`, `profiles` and `user_roles` —
// behind the slice of the PostgREST builder that `libraryApproval.server.ts`,
// `library-validation.server.ts`, `cascade/installedGlobs.server.ts` and
// `library-reingest.server.ts` use, plus the `has_role` RPC.
//
// It answers as the server does rather than replaying canned results:
//
//  - a select returns only the columns it names, and resolves the one embed
//    these callers use (`modules(slug, file_globs)` from `clone_modules`), so
//    code that reads a column it did not ask for reads `undefined`, as it
//    would against PostgREST;
//  - a column the table does not carry is refused the way production refuses
//    it: 42703 from Postgres for a read, a filter or an order
//    (`column module_library.source_commit_sha does not exist`), and PGRST204
//    from PostgREST's schema cache for a write (`Could not find the
//    'source_commit_sha' column of 'module_library' in the schema cache`).
//    `schema: "before"` is the database before 20261028120000;
//  - an insert takes production's defaults and meets its constraints, with
//    Postgres's own codes and wording: NOT NULL, `module_library`'s CHECK on
//    `approval_status`, and the `notification_kind` enum;
//  - `has_role` answers as production's has since 20260820: the user's
//    highest role level against the role's (`ROLE_LEVELS`), and an unknown
//    role is the enum's 22P02;
//  - a filter treats NULL as SQL does: `eq`, `neq` and `in` never match it;
//  - `maybeSingle` answers null for no row and PGRST116 for several, and
//    `single` answers PGRST116 for anything but one;
//  - `count: "exact"` counts the filtered rows before `range` or `limit`.
//
// A failure is injected per table and operation (`module_library.select`,
// `rpc.has_role`), as the error PostgREST passes through for a statement the
// 8-second `authenticator` timeout cancelled. Nothing here invents an error a
// server would not give.
import { randomUUID } from "node:crypto";
import { Constants } from "@/integrations/supabase/types";
import { ROLE_LEVELS } from "@/integrations/supabase/roles";

export type Row = Record<string, unknown>;
export type PgError = {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
};
type Result = { data: unknown; error: PgError | null; count?: number | null };
type Op = "select" | "insert" | "update";

export const STATEMENT_TIMEOUT: PgError = {
  message: "canceling statement due to statement timeout",
  code: "57014",
  details: null,
  hint: null,
};

const TABLES = [
  "modules",
  "module_detection_runs",
  "module_library",
  "clone_library_pins",
  "clone_modules",
  "audit_log",
  "notifications",
  "profiles",
  "user_roles",
] as const;
type Table = (typeof TABLES)[number];

/** The columns each table carries in production (`types.ts`, 28 Oct 2026). */
const COLUMNS: Record<Table, readonly string[]> = {
  modules: [
    "ai_confidence",
    "ai_reasoning",
    "apply_on_install",
    "approved_at",
    "approved_by",
    "backend_file_globs",
    "backend_manifest",
    "clone_migration_sql",
    "cohesion_score",
    "coupling_score",
    "created_at",
    "cron_jobs",
    "database_rpcs",
    "database_tables",
    "dependencies",
    "description",
    "detected_by_ai",
    "detection_run_id",
    "edge_functions",
    "external_hosts",
    "file_globs",
    "id",
    "incompatible_with",
    "layer",
    "name",
    "orphan_file_count",
    "rejection_reason",
    "required_migrations",
    "required_secrets",
    "requires",
    "resolved_files",
    "route_entry_file",
    "routes",
    "shared_by_modules",
    "slug",
    "status",
    "storage_buckets",
    "tree_snapshot_hash",
    "updated_at",
  ],
  module_detection_runs: [
    "backend_module_count",
    "backend_summary",
    "commit_sha",
    "completed_at",
    "created_at",
    "database_object_count",
    "delta_mode",
    "dependency_count",
    "edge_function_count",
    "error_message",
    "file_count",
    "id",
    "initiated_by",
    "inserted_modules",
    "migration_count",
    "orphan_files_found",
    "parameters",
    "pass_count",
    "passes",
    "previous_run_id",
    "proposed_modules",
    "sampled_file_count",
    "secret_count",
    "started_at",
    "status",
    "strategy",
    "tree_hash",
    "updated_at",
    "updated_modules",
  ],
  module_library: [
    "approval_status",
    "approved_at",
    "approved_by",
    "created_at",
    "deprecated_at",
    "deprecated_reason",
    "description",
    "entry_file",
    "file_count",
    "file_paths",
    "id",
    "is_latest",
    "metadata",
    "name",
    "published_at",
    "published_by",
    "rejection_reason",
    "replacement_slug",
    "route_path",
    "slug",
    "source_commit_sha",
    "source_detection_run_id",
    "source_module_id",
    "tags",
    "updated_at",
    "version",
  ],
  clone_library_pins: [
    "clone_id",
    "created_at",
    "id",
    "library_entry_id",
    "notes",
    "pinned_at",
    "pinned_by",
    "slug",
    "updated_at",
    "version",
  ],
  clone_modules: ["clone_id", "id", "installed_at", "installed_by", "module_id", "version"],
  audit_log: [
    "action",
    "actor_user_id",
    "created_at",
    "entity_id",
    "entity_type",
    "id",
    "metadata",
  ],
  notifications: [
    "body",
    "cascade_event_id",
    "clone_id",
    "created_at",
    "id",
    "kind",
    "metadata",
    "read_at",
    "severity",
    "title",
    "url",
  ],
  profiles: ["avatar_url", "created_at", "display_name", "id", "updated_at", "user_id"],
  user_roles: ["assigned_at", "assigned_by", "created_at", "id", "role", "user_id"],
};

/** The two columns 20261028120000 adds. */
const ADDED_BY_THIS_CHANGE: Partial<Record<Table, string[]>> = {
  module_detection_runs: ["commit_sha"],
  module_library: ["source_commit_sha"],
};

/** NOT NULL columns with no default, which an insert must name. */
const REQUIRED: Partial<Record<Table, string[]>> = {
  modules: ["name", "slug"],
  module_library: ["name", "slug", "entry_file"],
  clone_library_pins: ["clone_id", "library_entry_id", "slug", "version"],
  clone_modules: ["clone_id", "module_id"],
  audit_log: ["action"],
  notifications: ["kind", "title"],
  profiles: ["user_id"],
  user_roles: ["role", "user_id"],
};

/** Production's column defaults, for the columns an insert may leave out. */
function defaultsFor(table: Table, now: string): Row {
  const base: Row = { id: randomUUID(), created_at: now };
  switch (table) {
    case "module_library":
      return {
        ...base,
        updated_at: now,
        approval_status: "pending",
        approved_at: null,
        approved_by: null,
        deprecated_at: null,
        deprecated_reason: null,
        description: null,
        file_count: 0,
        file_paths: [],
        is_latest: true,
        metadata: {},
        published_at: now,
        published_by: null,
        rejection_reason: null,
        replacement_slug: null,
        route_path: null,
        source_commit_sha: null,
        source_detection_run_id: null,
        source_module_id: null,
        tags: [],
        version: 1,
      };
    case "audit_log":
      return { ...base, actor_user_id: null, entity_id: null, entity_type: null, metadata: {} };
    case "notifications":
      return {
        ...base,
        body: null,
        cascade_event_id: null,
        clone_id: null,
        metadata: {},
        read_at: null,
        severity: "info",
        url: null,
      };
    default:
      return { ...base, updated_at: now };
  }
}

const notNull = (table: Table, column: string): PgError => ({
  message: `null value in column "${column}" of relation "${table}" violates not-null constraint`,
  code: "23502",
  details: null,
  hint: null,
});

/** The constraints production holds an inserted or updated row to. */
function violation(table: Table, row: Row): PgError | null {
  for (const column of REQUIRED[table] ?? []) {
    if (row[column] === null || row[column] === undefined) return notNull(table, column);
  }
  if (
    table === "module_library" &&
    !["pending", "approved", "rejected"].includes(String(row.approval_status))
  ) {
    return {
      message:
        'new row for relation "module_library" violates check constraint "module_library_approval_status_check"',
      code: "23514",
      details: null,
      hint: null,
    };
  }
  if (
    table === "notifications" &&
    !(Constants.public.Enums.notification_kind as readonly string[]).includes(String(row.kind))
  ) {
    return {
      message: `invalid input value for enum notification_kind: "${String(row.kind)}"`,
      code: "22P02",
      details: null,
      hint: null,
    };
  }
  return null;
}

export type LibraryFakeDb = {
  tables: Record<Table, Row[]>;
  /** `${table}.${op}` (or `rpc.has_role`) keys whose calls answer this error while set. */
  failures: Map<string, PgError>;
  /** Every write that landed, in order. */
  writes: Array<{ table: string; op: Op; rows: Row[] }>;
  from: (table: string) => Builder;
  rpc: (name: string, args: Record<string, unknown>) => Promise<Result>;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- a query builder is a fluent any-typed chain */
type Builder = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Split a select list at its top-level commas: `a, b(c, d)` → `a`, `b(c, d)`. */
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

/** The embeds modelled: a many-to-one through a foreign key on the row. */
const EMBEDS: Partial<Record<Table, Record<string, { table: Table; key: string }>>> = {
  clone_modules: { modules: { table: "modules", key: "module_id" } },
};

export function createLibraryFakeDb(
  seed: Partial<Record<Table, Row[]>> = {},
  options: { schema?: "after" | "before" } = {},
): LibraryFakeDb {
  const columns = (table: Table): Set<string> => {
    const all = new Set(COLUMNS[table]);
    if (options.schema === "before")
      for (const c of ADDED_BY_THIS_CHANGE[table] ?? []) all.delete(c);
    return all;
  };

  const db: LibraryFakeDb = {
    tables: Object.fromEntries(
      TABLES.map((t) => [t, (seed[t] ?? []).map((r) => ({ ...r }))]),
    ) as Record<Table, Row[]>,
    failures: new Map(),
    writes: [],
    from: (table: string) => {
      if (!(TABLES as readonly string[]).includes(table)) {
        throw new Error(`library fake: table ${table} is not modelled`);
      }
      return builder(db, table as Table, columns(table as Table));
    },
    rpc: async (name, args) => {
      const failure = db.failures.get(`rpc.${name}`);
      if (failure) return { data: null, error: failure };
      if (name !== "has_role") throw new Error(`library fake: rpc ${name} is not modelled`);
      const role = String(args._role);
      if (!(role in ROLE_LEVELS)) {
        return {
          data: null,
          error: {
            message: `invalid input value for enum app_role: "${role}"`,
            code: "22P02",
            details: null,
            hint: null,
          },
        };
      }
      const held = db.tables.user_roles
        .filter((r) => r.user_id === args._user_id)
        .map((r) => ROLE_LEVELS[r.role as keyof typeof ROLE_LEVELS] ?? 0);
      const highest = held.length > 0 ? Math.max(...held) : 0;
      return { data: highest >= ROLE_LEVELS[role as keyof typeof ROLE_LEVELS], error: null };
    },
  };
  return db;
}

function builder(db: LibraryFakeDb, table: Table, known: Set<string>): Builder {
  const rows = () => db.tables[table];
  let op: Op = "select";
  let values: Row | Row[] | null = null;
  let select: string | null = null;
  let returning = false;
  let counting = false;
  const referenced: string[] = [];
  const filters: Array<(r: Row) => boolean> = [];
  const orders: Array<{ column: string; ascending: boolean }> = [];
  let limit: number | null = null;
  let range: [number, number] | null = null;

  const missingColumn = (column: string): PgError => ({
    message: `column ${table}.${column} does not exist`,
    code: "42703",
    details: null,
    hint: null,
  });
  const notInCache = (column: string): PgError => ({
    message: `Could not find the '${column}' column of '${table}' in the schema cache`,
    code: "PGRST204",
    details: null,
    hint: null,
  });

  /** A projected row, or the column the table does not carry. */
  const project = (row: Row, list: string | null): Row | { missing: string } => {
    if (list === null || list.trim() === "*") {
      return Object.fromEntries([...known].map((c) => [c, structuredClone(row[c] ?? null)]));
    }
    const out: Row = {};
    for (const column of columnsOf(list)) {
      const embed = /^([a-z_]+)\((.*)\)$/.exec(column);
      if (embed) {
        const spec = EMBEDS[table]?.[embed[1]];
        if (!spec) throw new Error(`library fake: embed ${embed[1]} on ${table} is not modelled`);
        const target = db.tables[spec.table].find((r) => r.id === row[spec.key]);
        const inner = builder(db, spec.table, new Set(COLUMNS[spec.table]));
        if (!target) {
          out[embed[1]] = null;
          continue;
        }
        const projected = inner.__project(target, embed[2]);
        if ("missing" in projected) return projected;
        out[embed[1]] = projected;
        continue;
      }
      if (column === "*") {
        Object.assign(out, project(row, "*"));
        continue;
      }
      if (!known.has(column)) return { missing: column };
      out[column] = structuredClone(row[column] ?? null);
    }
    return out;
  };

  const run = (mode: "many" | "single" | "maybeSingle"): Result => {
    const failure = db.failures.get(`${table}.${op}`);
    if (failure) return { data: null, error: failure };

    for (const column of referenced) {
      if (!known.has(column)) return { data: null, error: missingColumn(column) };
    }

    let result: Row[];
    let matched = 0;
    if (op === "select") {
      result = rows().filter((r) => filters.every((f) => f(r)));
      matched = result.length;
      if (orders.length > 0) {
        result = [...result].sort((a, b) => {
          for (const { column, ascending } of orders) {
            const x = a[column];
            const y = b[column];
            if (x === y) continue;
            // Postgres: NULLS LAST ascending, NULLS FIRST descending.
            if (x === null || x === undefined) return ascending ? 1 : -1;
            if (y === null || y === undefined) return ascending ? -1 : 1;
            const cmp = (x as number | string) < (y as number | string) ? -1 : 1;
            return ascending ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (range) result = result.slice(range[0], range[1] + 1);
      if (limit !== null) result = result.slice(0, limit);
    } else {
      const incoming = Array.isArray(values) ? values : [values ?? {}];
      for (const v of incoming) {
        for (const column of Object.keys(v)) {
          if (!known.has(column)) return { data: null, error: notInCache(column) };
        }
      }
      if (op === "insert") {
        const now = new Date().toISOString();
        const created = incoming.map((v) => ({
          ...defaultsFor(table, now),
          ...structuredClone(v),
        }));
        for (const row of created) {
          const broken = violation(table, row);
          if (broken) return { data: null, error: broken };
        }
        rows().push(...created);
        result = created;
      } else {
        result = rows().filter((r) => filters.every((f) => f(r)));
        for (const row of result) {
          const broken = violation(table, { ...row, ...(values as Row) });
          if (broken) return { data: null, error: broken };
        }
        for (const row of result) Object.assign(row, structuredClone(values as Row));
      }
      db.writes.push({ table, op, rows: result.map((r) => ({ ...r })) });
    }

    let data: Row[] | null = null;
    if (op === "select" || returning) {
      data = [];
      for (const r of result) {
        const projected = project(r, select);
        if ("missing" in projected)
          return { data: null, error: missingColumn(projected.missing as string) };
        data.push(projected);
      }
    }
    const count = counting && op === "select" ? matched : undefined;
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
    return count === undefined ? { data, error: null } : { data, error: null, count };
  };

  const filterOn = (column: string, test: (value: unknown) => boolean) => {
    referenced.push(column);
    filters.push((r) => test(r[column]));
    return b;
  };

  const b: Builder = {
    __project: project,
    select: (list?: string, opts?: { count?: string }) => {
      if (op !== "select") returning = true;
      select = list ?? "*";
      if (opts?.count === "exact") counting = true;
      return b;
    },
    insert: (v: Row | Row[]) => ((op = "insert"), (values = v), b),
    update: (v: Row) => ((op = "update"), (values = v), b),
    // SQL: a comparison with NULL is unknown, so no NULL ever matches these.
    eq: (c: string, v: unknown) => filterOn(c, (x) => x !== null && x !== undefined && x === v),
    neq: (c: string, v: unknown) => filterOn(c, (x) => x !== null && x !== undefined && x !== v),
    in: (c: string, list: unknown[]) =>
      filterOn(c, (x) => x !== null && x !== undefined && list.includes(x)),
    is: (c: string, v: unknown) => {
      if (v !== null) throw new Error("library fake: is() is modelled for null only");
      return filterOn(c, (x) => x === null || x === undefined);
    },
    not: (c: string, operator: string, v: unknown) => {
      if (operator !== "is" || v !== null) {
        throw new Error(`library fake: not(${c}, ${operator}) is not modelled`);
      }
      return filterOn(c, (x) => x !== null && x !== undefined);
    },
    order: (c: string, opts?: { ascending?: boolean }) => {
      referenced.push(c);
      orders.push({ column: c, ascending: opts?.ascending !== false });
      return b;
    },
    limit: (n: number) => ((limit = n), b),
    range: (from: number, to: number) => ((range = [from, to]), b),
    maybeSingle: async () => run("maybeSingle"),
    single: async () => run("single"),
    then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(run("many")).then(resolve, reject),
  };
  return b;
}
