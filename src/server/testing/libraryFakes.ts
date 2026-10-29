// A test double for the tables the module library lives in — `modules`,
// `module_detection_runs`, `module_library`, `clone_library_pins`,
// `clone_modules`, `clones`, `audit_log`, `notifications`, `profiles` and
// `user_roles`, and the ones a detection run and a reset write beside them: `prime_config`,
// `repo_blob_analysis`, `module_import_edges`, `module_backend_artifacts`,
// `module_drift_alerts` and `module_config_snapshots` — behind the slice of
// the PostgREST builder that `libraryApproval.server.ts`,
// `library-validation.server.ts`, `cascade/installedGlobs.server.ts`,
// `library-reingest.server.ts`, `module-detection.server.ts` and
// `library-follow.server.ts` use, plus the `has_role` RPC.
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
//    `approval_status`, its UNIQUE (slug, version) from 20261028140000, and
//    the `notification_kind` enum;
//  - an upsert resolves on the unique key production holds for its
//    `onConflict` columns and is 42P10 where it holds none, and a delete
//    cascades along the foreign keys production declares: a module's
//    `clone_modules`, `module_backend_artifacts` and `module_drift_alerts`
//    go with it, a clone's `clone_modules` with the clone, and a run's
//    artifacts, alerts and import edges with the run;
//  - a written `clone_modules` row names a clone and a module that exist, or
//    the whole statement is 23503, as `clone_modules_clone_id_fkey` and
//    `clone_modules_module_id_fkey` refuse it. Rows a test seeds are not
//    judged, so a suite that never writes an install need not seed clones;
//  - `has_role` answers as production's has since 20260820: the user's
//    highest role level against the role's (`ROLE_LEVELS`), and an unknown
//    role is the enum's 22P02;
//  - a filter treats NULL as SQL does: `eq`, `neq`, `in`, `lt` and `gt` never match it;
//  - `maybeSingle` answers null for no row and PGRST116 for several, and
//    `single` answers PGRST116 for anything but one;
//  - `count: "exact"` counts the filtered rows before `range` or `limit`;
//  - an update of `modules.status` that does not write
//    `archived_by_follow_run_id` clears it, as the trigger
//    `modules_follow_mark_is_the_follows` (20261029140000) does.
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
type Op = "select" | "insert" | "update" | "upsert" | "delete";

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
  "clones",
  "audit_log",
  "notifications",
  "profiles",
  "user_roles",
  "prime_config",
  "repo_blob_analysis",
  "module_import_edges",
  "module_backend_artifacts",
  "module_drift_alerts",
  "module_config_snapshots",
] as const;
type Table = (typeof TABLES)[number];

/**
 * The columns each table carries in production (`types.ts`, 28 Oct 2026, and
 * `modules.archived_by_follow_run_id` and
 * `module_detection_runs.diagnostics_pruned_at` from 20261029140000).
 */
const COLUMNS: Record<Table, readonly string[]> = {
  modules: [
    "ai_confidence",
    "ai_reasoning",
    "apply_on_install",
    "approved_at",
    "approved_by",
    "archived_by_follow_run_id",
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
    "diagnostics_pruned_at",
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
  clones: [
    "billing_stripe_customer_id",
    "billing_user_id",
    "cloudflare_enabled",
    "cloudflare_zone_id",
    "codex_nightly_enabled",
    "commits_behind",
    "contract_excluded_module_slugs",
    "created_at",
    "crm_mode",
    "default_branch",
    "deploy_url",
    "drift_suggestions",
    "entitled_module_slugs",
    "entitled_plan_slug",
    "entitlement_keys",
    "entitlements_synced_at",
    "github_app_installation_id",
    "github_owner",
    "github_repo",
    "github_url",
    "id",
    "idempotency_key",
    "isolated_tenant",
    "last_cascade_at",
    "last_drift_check_at",
    "last_synced_sha",
    "lovable_project_id",
    "lovable_project_url",
    "merge_drain_at",
    "name",
    "notes",
    "owner_user_id",
    "parent_clone_id",
    "provisioning_method",
    "purchased_addon_slugs",
    "repo_full_name",
    "revoked_module_slugs",
    "slug",
    "subdomain",
    "subdomain_fqdn",
    "subdomain_status",
    "sync_scope",
    "sync_status",
    "tags",
    "updated_at",
  ],
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
  prime_config: [
    "cascade_follows_lineage",
    "clone_gate_default_hours",
    "clone_gate_enabled",
    "codex_auto_merge_ceiling",
    "codex_autofix_enabled",
    "codex_autofix_max_per_night",
    "codex_cascade_gate",
    "codex_deep_scan_scope",
    "codex_nightly_cron",
    "codex_nightly_enabled",
    "codex_post_merge_revalidate",
    "codex_pr_check_enabled",
    "codex_pr_check_fail_on",
    "codex_pr_scan_enabled",
    "codex_scan_dedup_hours",
    "convergence_slo_minutes",
    "created_at",
    "crm_dependent_parent_clone_id",
    "crm_independent_parent_clone_id",
    "default_branch",
    "default_cascade_mode",
    "default_clone_org",
    "github_app_installation_id",
    "github_owner",
    "github_repo",
    "id",
    "notes",
    "supabase_project_ref",
    "updated_at",
  ],
  repo_blob_analysis: [
    "analysis",
    "blob_sha",
    "byte_size",
    "created_at",
    "kind",
    "last_seen_at",
    "path",
  ],
  module_import_edges: [
    "created_at",
    "detection_run_id",
    "id",
    "import_type",
    "source_file",
    "target_file",
  ],
  module_backend_artifacts: [
    "artifact_kind",
    "confidence",
    "created_at",
    "detection_run_id",
    "file_path",
    "id",
    "identifier",
    "link_reason",
    "metadata",
    "module_id",
    "module_slug",
    "shared_with_modules",
  ],
  module_drift_alerts: [
    "alert_type",
    "created_at",
    "detection_run_id",
    "file_path",
    "id",
    "module_id",
    "reasoning",
    "resolved",
    "resolved_at",
    "resolved_by",
    "severity",
    "suggested_module_slug",
  ],
  module_config_snapshots: [
    "clone_id",
    "created_at",
    "created_by",
    "id",
    "is_active",
    "label",
    "module_ids",
  ],
};

/**
 * The unique keys an upsert may resolve on: the primary key, and each UNIQUE
 * constraint production holds that a caller names in `onConflict`.
 */
const UNIQUE_KEYS: Partial<Record<Table, string[][]>> = {
  clone_modules: [["id"], ["clone_id", "module_id"]],
  clone_library_pins: [["id"], ["clone_id", "slug"]],
  module_library: [["id"], ["slug", "version"]],
  repo_blob_analysis: [["blob_sha"]],
};

/** Production's ON DELETE rules: whose rows go with a deleted row, and whose are nulled. */
const ON_DELETE: Partial<
  Record<Table, Array<{ table: Table; column: string; rule: "cascade" | "set null" }>>
> = {
  clones: [{ table: "clone_modules", column: "clone_id", rule: "cascade" }],
  modules: [
    { table: "clone_modules", column: "module_id", rule: "cascade" },
    { table: "module_backend_artifacts", column: "module_id", rule: "cascade" },
    { table: "module_drift_alerts", column: "module_id", rule: "cascade" },
  ],
  module_detection_runs: [
    { table: "module_backend_artifacts", column: "detection_run_id", rule: "cascade" },
    { table: "module_drift_alerts", column: "detection_run_id", rule: "cascade" },
    { table: "module_import_edges", column: "detection_run_id", rule: "cascade" },
    { table: "modules", column: "detection_run_id", rule: "set null" },
    { table: "module_detection_runs", column: "previous_run_id", rule: "set null" },
  ],
};

/** Production's foreign keys a written row is held to: the column, the table it names, the constraint. */
const REFERENCES: Partial<
  Record<Table, Array<{ column: string; table: Table; constraint: string }>>
> = {
  clone_modules: [
    { column: "clone_id", table: "clones", constraint: "clone_modules_clone_id_fkey" },
    { column: "module_id", table: "modules", constraint: "clone_modules_module_id_fkey" },
  ],
};

/** The foreign key a written row breaks, as Postgres words it, or null. */
function unreferenced(db: LibraryFakeDb, table: Table, row: Row): PgError | null {
  for (const { column, table: parent, constraint } of REFERENCES[table] ?? []) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    if (db.tables[parent].some((p) => p.id === value)) continue;
    return {
      message: `insert or update on table "${table}" violates foreign key constraint "${constraint}"`,
      code: "23503",
      details: `Key (${column})=(${String(value)}) is not present in table "${parent}".`,
      hint: null,
    };
  }
  return null;
}

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
  clones: ["github_owner", "github_repo", "name", "provisioning_method", "slug"],
  audit_log: ["action"],
  notifications: ["kind", "title"],
  profiles: ["user_id"],
  user_roles: ["role", "user_id"],
  prime_config: ["github_owner", "github_repo"],
  repo_blob_analysis: ["analysis", "blob_sha", "kind", "path"],
  module_import_edges: ["detection_run_id", "source_file", "target_file"],
  module_backend_artifacts: ["artifact_kind", "identifier", "module_slug"],
  module_drift_alerts: ["alert_type"],
  module_config_snapshots: ["clone_id"],
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
    case "repo_blob_analysis":
      return { created_at: now, last_seen_at: now, byte_size: null };
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

/**
 * The row an UPDATE leaves, BEFORE triggers included: production's
 * `modules_follow_mark_is_the_follows` clears the follow's archive mark on a
 * status change that does not write the mark to a new value.
 */
function updated(table: Table, old: Row, values: Row): Row {
  const next = { ...old, ...structuredClone(values) };
  if (
    table === "modules" &&
    "status" in values &&
    (next.status ?? null) !== (old.status ?? null) &&
    (next.archived_by_follow_run_id ?? null) === (old.archived_by_follow_run_id ?? null)
  ) {
    next.archived_by_follow_run_id = null;
  }
  return next;
}

const notNull = (table: Table, column: string): PgError => ({
  message: `null value in column "${column}" of relation "${table}" violates not-null constraint`,
  code: "23502",
  details: null,
  hint: null,
});

/**
 * The constraints production holds an inserted or updated row to. `others` is
 * every other row the table would hold once the write lands, for the unique key.
 */
function violation(table: Table, row: Row, others: Row[]): PgError | null {
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
  // 20261028120000: an approved entry records a commit, and a run records a
  // commit or nothing. Postgres passes a CHECK whose expression is NULL, which
  // is why the entry's is written with coalesce there.
  const isCommit = (v: unknown) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
  if (
    table === "module_library" &&
    row.approval_status === "approved" &&
    !isCommit(row.source_commit_sha)
  ) {
    return {
      message:
        'new row for relation "module_library" violates check constraint "module_library_approved_at_a_commit"',
      code: "23514",
      details: null,
      hint: null,
    };
  }
  if (
    table === "module_detection_runs" &&
    row.commit_sha !== null &&
    row.commit_sha !== undefined &&
    !isCommit(row.commit_sha)
  ) {
    return {
      message:
        'new row for relation "module_detection_runs" violates check constraint "module_detection_runs_commit_sha_is_a_commit"',
      code: "23514",
      details: null,
      hint: null,
    };
  }
  // A unique key holds NULLs distinct, as Postgres does by default.
  const present = (v: unknown) => v !== null && v !== undefined;
  if (table === "module_library" && present(row.slug) && present(row.version)) {
    const taken = others.find((o) => o.slug === row.slug && o.version === row.version);
    if (taken) {
      return {
        message: 'duplicate key value violates unique constraint "module_library_slug_version_key"',
        code: "23505",
        details: `Key (slug, version)=(${String(row.slug)}, ${String(row.version)}) already exists.`,
        hint: null,
      };
    }
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

let lastStatementAt = 0;

/**
 * `now()` as two statements see it: never the same instant twice. Production
 * stamps each statement with its own transaction time, so a row written after
 * another is later than it, and "the completion after the reset" is a
 * question with an answer. Two inserts in one millisecond here would tie.
 */
function statementNow(): string {
  lastStatementAt = Math.max(Date.now(), lastStatementAt + 1);
  return new Date(lastStatementAt).toISOString();
}

/** Apply production's ON DELETE rules for rows of `table` that were deleted. */
function cascadeDelete(db: LibraryFakeDb, table: Table, deleted: Row[]): void {
  const ids = new Set<unknown>(
    deleted.map((r) => r.id).filter((id) => id !== null && id !== undefined),
  );
  if (ids.size === 0) return;
  for (const { table: child, column, rule } of ON_DELETE[table] ?? []) {
    const hit = db.tables[child].filter((r) => ids.has(r[column]));
    if (hit.length === 0) continue;
    if (rule === "set null") {
      for (const r of hit) r[column] = null;
      continue;
    }
    const gone = new Set(hit);
    db.tables[child] = db.tables[child].filter((r) => !gone.has(r));
    cascadeDelete(db, child, hit);
  }
}

const noMatchingConstraint: PgError = {
  message: "there is no unique or exclusion constraint matching the ON CONFLICT specification",
  code: "42P10",
  details: null,
  hint: null,
};

const affectsRowTwice: PgError = {
  message: "ON CONFLICT DO UPDATE command cannot affect row a second time",
  code: "21000",
  details: null,
  hint: "Ensure that no rows proposed for insertion within the same command have duplicate constrained values.",
};

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
  let conflict: string[] | null = null;

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
      if (op === "delete") {
        result = rows().filter((r) => filters.every((f) => f(r)));
        const gone = new Set(result);
        db.tables[table] = rows().filter((r) => !gone.has(r));
        cascadeDelete(db, table, result);
      } else if (op === "upsert") {
        // PostgREST resolves on the primary key unless `onConflict` names a
        // unique constraint, and Postgres refuses columns that are not one.
        const key = conflict ?? ["id"];
        const keyed = (UNIQUE_KEYS[table] ?? [["id"]]).some(
          (k) => k.length === key.length && k.every((c) => key.includes(c)),
        );
        if (!keyed) return { data: null, error: noMatchingConstraint };
        const keyOf = (r: Row) => JSON.stringify(key.map((c) => r[c] ?? null));
        const proposed = new Set<string>();
        for (const v of incoming) {
          const k = keyOf(v);
          if (proposed.has(k)) return { data: null, error: affectsRowTwice };
          proposed.add(k);
        }
        // One statement: every row is judged before any lands.
        const now = statementNow();
        const plan = incoming.map((v) => {
          const existing = rows().find((r) =>
            key.every((c) => r[c] !== null && r[c] !== undefined && r[c] === v[c]),
          );
          return existing
            ? { existing, row: { ...existing, ...structuredClone(v) } }
            : { existing: null, row: { ...defaultsFor(table, now), ...structuredClone(v) } };
        });
        const after = [
          ...rows().filter((r) => !plan.some((p) => p.existing === r)),
          ...plan.map((p) => p.row),
        ];
        for (const p of plan) {
          const broken =
            violation(
              table,
              p.row,
              after.filter((r) => r !== p.row),
            ) ?? unreferenced(db, table, p.row);
          if (broken) return { data: null, error: broken };
        }
        result = plan.map((p) => {
          if (p.existing) return Object.assign(p.existing, p.row);
          rows().push(p.row);
          return p.row;
        });
      } else if (op === "insert") {
        const now = statementNow();
        const created = incoming.map((v) => ({
          ...defaultsFor(table, now),
          ...structuredClone(v),
        }));
        for (const row of created) {
          const others = [...rows(), ...created.filter((c) => c !== row)];
          const broken = violation(table, row, others) ?? unreferenced(db, table, row);
          if (broken) return { data: null, error: broken };
        }
        rows().push(...created);
        result = created;
      } else {
        result = rows().filter((r) => filters.every((f) => f(r)));
        const after = (r: Row): Row => (result.includes(r) ? updated(table, r, values as Row) : r);
        for (const row of result) {
          const others = rows()
            .filter((r) => r !== row)
            .map(after);
          const broken =
            violation(table, after(row), others) ?? unreferenced(db, table, after(row));
          if (broken) return { data: null, error: broken };
        }
        for (const row of result) Object.assign(row, updated(table, row, values as Row));
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
    upsert: (v: Row | Row[], opts?: { onConflict?: string }) => {
      op = "upsert";
      values = v;
      conflict = opts?.onConflict ? opts.onConflict.split(",").map((c) => c.trim()) : null;
      return b;
    },
    delete: () => ((op = "delete"), b),
    // SQL: a comparison with NULL is unknown, so no NULL ever matches these.
    eq: (c: string, v: unknown) => filterOn(c, (x) => x !== null && x !== undefined && x === v),
    neq: (c: string, v: unknown) => filterOn(c, (x) => x !== null && x !== undefined && x !== v),
    in: (c: string, list: unknown[]) =>
      filterOn(c, (x) => x !== null && x !== undefined && list.includes(x)),
    lt: (c: string, v: number | string) =>
      filterOn(c, (x) => x !== null && x !== undefined && (x as number | string) < v),
    gt: (c: string, v: number | string) =>
      filterOn(c, (x) => x !== null && x !== undefined && (x as number | string) > v),
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
