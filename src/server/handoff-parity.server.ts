/**
 * Handoff parity engine (G1 + G3).
 *
 * Computes a structural diff between the prime Aurixa backend and a target
 * clone / client-owned Supabase project so an admin can review exactly what
 * will move during a handoff before any physical action runs.
 *
 * Surfaces compared:
 *   G1 — Tables & columns in `public`
 *      — RLS enabled flag per table
 *      — RLS policy names per table
 *      — Database functions in `public`
 *      — Installed extensions
 *   G3 — Storage buckets (visibility + size cap + mime allowlist)
 *      — pg_cron jobs (name + schedule + active)
 *      — Edge function slugs
 *      — Secret key names (names only — values never read)
 *      — Auth config (whitelisted subset)
 *   G4 — Required extensions enforced + `supabase_realtime` publication parity
 *   G5 — Table GRANTs (privileges) per role
 *      — Enum types and their label sets
 *      — Triggers on `public` tables (name + table + timing + event)
 */

import {
  runSqlOnProject,
  listProjectStorageBuckets,
  fetchPrimeCronJobs,
  listProjectEdgeFunctionSlugs,
  listProjectSecretNames,
  getProjectAuthConfig,
  fetchRealtimePublicationTables,
  REQUIRED_EXTENSIONS,
  type StorageBucketConfig,
  type PrimeCronJob,
  type RealtimePublicationTable,
} from "./backend-provisioning.server";

type Row = Record<string, unknown>;

function rows(raw: unknown): Row[] {
  if (Array.isArray(raw)) return raw as Row[];
  if (raw && typeof raw === "object" && Array.isArray((raw as any).result)) {
    return (raw as any).result as Row[];
  }
  return [];
}

// `getPrimeProjectRef()` lived here too, a second copy deriving a ref from
// `SUPABASE_URL` — this deployment's own project. Every parity report it fed
// therefore diffed a clone against MISSION CONTROL's admin schema rather than
// the product's, which makes each one a large and entirely bogus diff.
// Callers now resolve the prime backend from configuration
// (`resolvePrimeBackendRef`) and pass the ref in.

// ── Introspection SQL ─────────────────────────────────────────────────

const TABLES_SQL = `
  select table_schema, table_name, column_name, data_type, is_nullable
    from information_schema.columns
   where table_schema = 'public'
   order by table_name, ordinal_position
`;

const RLS_SQL = `
  select c.relname as table_name, c.relrowsecurity as rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
`;

const POLICIES_SQL = `
  select schemaname, tablename, policyname, cmd, roles::text as roles
    from pg_policies
   where schemaname = 'public'
   order by tablename, policyname
`;

const FUNCTIONS_SQL = `
  select n.nspname as schema, p.proname as name,
         pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
   order by name, args
`;

const EXTENSIONS_SQL = `
  select extname as name, extversion as version
    from pg_extension
   order by name
`;

// G5 — Table privileges (GRANTs) for the roles the Data API cares about.
// Without these, RLS alone leaves tables unreachable via PostgREST.
const GRANTS_SQL = `
  select table_name, grantee, privilege_type
    from information_schema.table_privileges
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated', 'service_role')
   order by table_name, grantee, privilege_type
`;

// G5 — Enum types and their labels in public.
const ENUMS_SQL = `
  select t.typname as name, e.enumlabel as label, e.enumsortorder as ord
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
   where n.nspname = 'public'
   order by t.typname, e.enumsortorder
`;

// G5 — Triggers on public tables (skip internal RI/constraint triggers).
const TRIGGERS_SQL = `
  select event_object_table as table_name,
         trigger_name,
         action_timing,
         event_manipulation
    from information_schema.triggers
   where trigger_schema = 'public'
   order by table_name, trigger_name, event_manipulation
`;

/**
 * Schemas a clone must reproduce. `public` alone was the whole of parity, and
 * this prime keeps 106 tables in `aml` that nothing here could see.
 */
const PARITY_SCHEMAS = ["public", "aml"] as const;
const SCHEMA_LIST = PARITY_SCHEMAS.map((s) => `'${s}'`).join(", ");

/**
 * Constraints, keyed schema.table.conname.
 *
 * Parity had no notion of these, and a clone can match on every table and
 * column while having no primary keys, no foreign keys and no uniqueness at
 * all — which is exactly what a half-finished schema transfer produces. The
 * observed case: 2 constraints against the prime's 2,560, reported as sound.
 */
const CONSTRAINTS_SQL = `
  select n.nspname as schema, rel.relname as table_name, con.conname as name,
         con.contype::text as kind
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
   where n.nspname in (${SCHEMA_LIST})
   order by schema, table_name, name
`;

/**
 * Indexes, keyed schema.indexname. Constraint-backed indexes are included:
 * the point is what the database HAS, and excluding them here would hide a
 * primary key's index going missing.
 */
const INDEXES_SQL = `
  select schemaname as schema, tablename as table_name, indexname as name
    from pg_indexes
   where schemaname in (${SCHEMA_LIST})
   order by schema, name
`;

/**
 * Materialized views. `relkind = 'm'`, so every table query in this file
 * misses them — including the one that would notice an index failing to
 * create against a relation that "does not exist".
 */
const MATVIEWS_SQL = `
  select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'm' and n.nspname in (${SCHEMA_LIST})
   order by schema, name
`;

/** Sequences — a missing one breaks every insert that defaults from it. */
const SEQUENCES_SQL = `
  select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'S' and n.nspname in (${SCHEMA_LIST})
   order by schema, name
`;

// ── Fetch snapshots ───────────────────────────────────────────────────

async function snapshotProject(ref: string) {
  const [
    t,
    r,
    p,
    f,
    e,
    buckets,
    cron,
    edgeFns,
    secretNames,
    authCfg,
    realtimeTables,
    gr,
    en,
    tr,
    cons,
    idx,
    mv,
    seq,
  ] = await Promise.all([
    runSqlOnProject(ref, TABLES_SQL).then(rows),
    runSqlOnProject(ref, RLS_SQL).then(rows),
    runSqlOnProject(ref, POLICIES_SQL).then(rows),
    runSqlOnProject(ref, FUNCTIONS_SQL).then(rows),
    runSqlOnProject(ref, EXTENSIONS_SQL).then(rows),
    listProjectStorageBuckets(ref).catch(() => [] as StorageBucketConfig[]),
    fetchPrimeCronJobs(ref).catch(() => [] as PrimeCronJob[]),
    listProjectEdgeFunctionSlugs(ref),
    listProjectSecretNames(ref),
    getProjectAuthConfig(ref),
    fetchRealtimePublicationTables(ref).catch(() => [] as RealtimePublicationTable[]),
    runSqlOnProject(ref, GRANTS_SQL)
      .then(rows)
      .catch(() => [] as Row[]),
    runSqlOnProject(ref, ENUMS_SQL)
      .then(rows)
      .catch(() => [] as Row[]),
    runSqlOnProject(ref, TRIGGERS_SQL)
      .then(rows)
      .catch(() => [] as Row[]),
    runSqlOnProject(ref, CONSTRAINTS_SQL)
      .then(rows)
      .catch(() => [] as Row[]),
    runSqlOnProject(ref, INDEXES_SQL)
      .then(rows)
      .catch(() => [] as Row[]),
    runSqlOnProject(ref, MATVIEWS_SQL)
      .then(rows)
      .catch(() => [] as Row[]),
    runSqlOnProject(ref, SEQUENCES_SQL)
      .then(rows)
      .catch(() => [] as Row[]),
  ]);

  const columnsByTable = new Map<string, Map<string, Row>>();
  for (const row of t) {
    const tbl = String(row.table_name);
    if (!columnsByTable.has(tbl)) columnsByTable.set(tbl, new Map());
    columnsByTable.get(tbl)!.set(String(row.column_name), row);
  }

  const rlsByTable = new Map<string, boolean>();
  for (const row of r) rlsByTable.set(String(row.table_name), Boolean(row.rls_enabled));

  const policiesByTable = new Map<string, Row[]>();
  for (const row of p) {
    const tbl = String(row.tablename);
    if (!policiesByTable.has(tbl)) policiesByTable.set(tbl, []);
    policiesByTable.get(tbl)!.push(row);
  }

  const functionSigs = new Set<string>();
  for (const row of f) functionSigs.add(`${row.name}(${row.args})`);

  const extensions = new Map<string, string>();
  for (const row of e) extensions.set(String(row.name), String(row.version ?? ""));

  const bucketsById = new Map<string, StorageBucketConfig>();
  for (const b of buckets) bucketsById.set(b.id, b);

  const cronByName = new Map<string, PrimeCronJob>();
  for (const j of cron) cronByName.set(j.jobname, j);

  const edgeFnSet = new Set<string>(edgeFns);
  const secretSet = new Set<string>(secretNames);

  const realtimeSet = new Set<string>((realtimeTables ?? []).map((t) => `${t.schema}.${t.table}`));

  // G5 — grants: Map<table, Map<role, Set<privilege>>>
  const grantsByTable = new Map<string, Map<string, Set<string>>>();
  for (const row of gr) {
    const tbl = String(row.table_name);
    const role = String(row.grantee);
    const priv = String(row.privilege_type);
    if (!grantsByTable.has(tbl)) grantsByTable.set(tbl, new Map());
    const roleMap = grantsByTable.get(tbl)!;
    if (!roleMap.has(role)) roleMap.set(role, new Set());
    roleMap.get(role)!.add(priv);
  }

  // G5 — enums: Map<typeName, ordered labels>
  const enumsByName = new Map<string, string[]>();
  for (const row of en) {
    const name = String(row.name);
    if (!enumsByName.has(name)) enumsByName.set(name, []);
    enumsByName.get(name)!.push(String(row.label));
  }

  // G5 — triggers keyed by "table.trigger.event" for stable comparison.
  const triggerKeys = new Set<string>();
  for (const row of tr) {
    triggerKeys.add(
      `${row.table_name}.${row.trigger_name}.${row.action_timing}.${row.event_manipulation}`,
    );
  }

  return {
    columnsByTable,
    rlsByTable,
    policiesByTable,
    functionSigs,
    extensions,
    bucketsById,
    cronByName,
    edgeFnSet,
    secretSet,
    realtimeSet,
    grantsByTable,
    enumsByName,
    triggerKeys,
    // Keyed so a rename shows as one missing + one extra rather than a
    // count that happens to match.
    constraintKeys: new Set(cons.map((r) => `${r.schema}.${r.table_name}.${r.name}`)),
    indexKeys: new Set(idx.map((r) => `${r.schema}.${r.name}`)),
    matviewKeys: new Set(mv.map((r) => `${r.schema}.${r.name}`)),
    sequenceKeys: new Set(seq.map((r) => `${r.schema}.${r.name}`)),
    authCfg: authCfg ?? {},
  };
}

type Snapshot = Awaited<ReturnType<typeof snapshotProject>>;

// ── Diff computation ──────────────────────────────────────────────────

function diffTables(prime: Snapshot, target: Snapshot) {
  const primeTables = new Set(prime.columnsByTable.keys());
  const targetTables = new Set(target.columnsByTable.keys());

  const missingInTarget: string[] = [];
  const extraInTarget: string[] = [];
  const columnDrift: Array<{
    table: string;
    missing: string[];
    extra: string[];
    typeChanges: Array<{ column: string; prime: string; target: string }>;
  }> = [];

  for (const t of primeTables) {
    if (!targetTables.has(t)) {
      missingInTarget.push(t);
      continue;
    }
    const primeCols = prime.columnsByTable.get(t)!;
    const targetCols = target.columnsByTable.get(t)!;
    const missing: string[] = [];
    const extra: string[] = [];
    const typeChanges: Array<{ column: string; prime: string; target: string }> = [];
    for (const [name, def] of primeCols) {
      if (!targetCols.has(name)) missing.push(name);
      else {
        const td = targetCols.get(name)!;
        if (String(def.data_type) !== String(td.data_type)) {
          typeChanges.push({
            column: name,
            prime: String(def.data_type),
            target: String(td.data_type),
          });
        }
      }
    }
    for (const name of targetCols.keys()) if (!primeCols.has(name)) extra.push(name);
    if (missing.length || extra.length || typeChanges.length) {
      columnDrift.push({ table: t, missing, extra, typeChanges });
    }
  }
  for (const t of targetTables) if (!primeTables.has(t)) extraInTarget.push(t);

  return {
    prime_count: primeTables.size,
    target_count: targetTables.size,
    missing_in_target: missingInTarget.sort(),
    extra_in_target: extraInTarget.sort(),
    column_drift: columnDrift,
  };
}

function diffPolicies(prime: Snapshot, target: Snapshot) {
  const missingRls: string[] = [];
  const missingPolicies: Array<{ table: string; policies: string[] }> = [];

  for (const [tbl, enabled] of prime.rlsByTable) {
    const targetEnabled = target.rlsByTable.get(tbl);
    if (enabled && targetEnabled === false) missingRls.push(tbl);
  }

  for (const [tbl, primePolicies] of prime.policiesByTable) {
    const targetSet = new Set(
      (target.policiesByTable.get(tbl) ?? []).map((r) => String(r.policyname)),
    );
    const missing = primePolicies.map((r) => String(r.policyname)).filter((n) => !targetSet.has(n));
    if (missing.length) missingPolicies.push({ table: tbl, policies: missing });
  }

  return { rls_disabled_in_target: missingRls.sort(), missing_policies: missingPolicies };
}

function diffFunctions(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const sig of prime.functionSigs) if (!target.functionSigs.has(sig)) missing.push(sig);
  for (const sig of target.functionSigs) if (!prime.functionSigs.has(sig)) extra.push(sig);
  return { missing_in_target: missing.sort(), extra_in_target: extra.sort() };
}

function diffExtensions(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const versionSkew: Array<{ name: string; prime: string; target: string }> = [];
  for (const [name, ver] of prime.extensions) {
    const t = target.extensions.get(name);
    if (t === undefined) missing.push(name);
    else if (t !== ver) versionSkew.push({ name, prime: ver, target: t });
  }
  return { missing_in_target: missing.sort(), version_skew: versionSkew };
}

// ── G3 surfaces ───────────────────────────────────────────────────────

function diffBuckets(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const configDrift: Array<{
    id: string;
    field: "public" | "file_size_limit" | "allowed_mime_types";
    prime: unknown;
    target: unknown;
  }> = [];
  const extra: string[] = [];

  for (const [id, pb] of prime.bucketsById) {
    const tb = target.bucketsById.get(id);
    if (!tb) {
      missing.push(id);
      continue;
    }
    if (pb.public !== tb.public) {
      configDrift.push({ id, field: "public", prime: pb.public, target: tb.public });
    }
    if ((pb.file_size_limit ?? null) !== (tb.file_size_limit ?? null)) {
      configDrift.push({
        id,
        field: "file_size_limit",
        prime: pb.file_size_limit,
        target: tb.file_size_limit,
      });
    }
    const pm = JSON.stringify((pb.allowed_mime_types ?? []).slice().sort());
    const tm = JSON.stringify((tb.allowed_mime_types ?? []).slice().sort());
    if (pm !== tm) {
      configDrift.push({
        id,
        field: "allowed_mime_types",
        prime: pb.allowed_mime_types,
        target: tb.allowed_mime_types,
      });
    }
  }
  for (const id of target.bucketsById.keys()) if (!prime.bucketsById.has(id)) extra.push(id);

  return {
    prime_count: prime.bucketsById.size,
    target_count: target.bucketsById.size,
    missing_in_target: missing.sort(),
    extra_in_target: extra.sort(),
    config_drift: configDrift,
  };
}

function diffCron(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const scheduleDrift: Array<{ jobname: string; prime: string; target: string }> = [];
  const activeDrift: Array<{ jobname: string; prime: boolean; target: boolean }> = [];
  const extra: string[] = [];

  for (const [name, pj] of prime.cronByName) {
    const tj = target.cronByName.get(name);
    if (!tj) {
      missing.push(name);
      continue;
    }
    if (pj.schedule !== tj.schedule) {
      scheduleDrift.push({ jobname: name, prime: pj.schedule, target: tj.schedule });
    }
    if (pj.active !== tj.active) {
      activeDrift.push({ jobname: name, prime: pj.active, target: tj.active });
    }
  }
  for (const name of target.cronByName.keys()) if (!prime.cronByName.has(name)) extra.push(name);

  return {
    prime_count: prime.cronByName.size,
    target_count: target.cronByName.size,
    missing_in_target: missing.sort(),
    extra_in_target: extra.sort(),
    schedule_drift: scheduleDrift,
    active_drift: activeDrift,
  };
}

function diffEdgeFunctions(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const slug of prime.edgeFnSet) if (!target.edgeFnSet.has(slug)) missing.push(slug);
  for (const slug of target.edgeFnSet) if (!prime.edgeFnSet.has(slug)) extra.push(slug);
  return {
    prime_count: prime.edgeFnSet.size,
    target_count: target.edgeFnSet.size,
    missing_in_target: missing.sort(),
    extra_in_target: extra.sort(),
  };
}

function diffSecrets(prime: Snapshot, target: Snapshot) {
  // Names only — values are never read.
  const missing: string[] = [];
  const extra: string[] = [];
  for (const name of prime.secretSet) if (!target.secretSet.has(name)) missing.push(name);
  for (const name of target.secretSet) if (!prime.secretSet.has(name)) extra.push(name);
  return {
    prime_count: prime.secretSet.size,
    target_count: target.secretSet.size,
    missing_in_target: missing.sort(),
    extra_in_target: extra.sort(),
  };
}

// Only compare a whitelisted subset of the auth config. OAuth provider
// credentials, SMTP passwords, and other secrets are excluded by design.
const AUTH_FIELDS_TO_COMPARE = [
  "site_url",
  "uri_allow_list",
  "jwt_exp",
  "disable_signup",
  "mailer_autoconfirm",
  "password_min_length",
  "external_email_enabled",
  "external_phone_enabled",
] as const;

function diffAuthConfig(prime: Snapshot, target: Snapshot) {
  const drift: Array<{ field: string; prime: unknown; target: unknown }> = [];
  for (const field of AUTH_FIELDS_TO_COMPARE) {
    const pv = (prime.authCfg as Record<string, unknown>)[field] ?? null;
    const tv = (target.authCfg as Record<string, unknown>)[field] ?? null;
    if (JSON.stringify(pv) !== JSON.stringify(tv)) {
      drift.push({ field, prime: pv, target: tv });
    }
  }
  return { drift };
}

// G4 — required extensions must be enabled on the target.
function diffRequiredExtensions(target: Snapshot) {
  const missing = REQUIRED_EXTENSIONS.filter((n) => !target.extensions.has(n));
  return { required: [...REQUIRED_EXTENSIONS], missing_in_target: missing };
}

// G4 — realtime publication membership parity.
function diffRealtime(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const q of prime.realtimeSet) if (!target.realtimeSet.has(q)) missing.push(q);
  for (const q of target.realtimeSet) if (!prime.realtimeSet.has(q)) extra.push(q);
  return {
    prime_count: prime.realtimeSet.size,
    target_count: target.realtimeSet.size,
    missing_in_target: missing.sort(),
    extra_in_target: extra.sort(),
  };
}

// ── G5 surfaces ───────────────────────────────────────────────────────

// G5 — GRANT parity. Without GRANTs to anon/authenticated/service_role, RLS
// alone leaves public tables unreachable via PostgREST. Blocking when a table
// on the target is missing every one of the roles the prime had granted.
function diffGrants(prime: Snapshot, target: Snapshot) {
  const drift: Array<{
    table: string;
    role: string;
    missing_privileges: string[];
    extra_privileges: string[];
  }> = [];
  const missing_grantees: Array<{ table: string; role: string }> = [];

  for (const [tbl, primeRoles] of prime.grantsByTable) {
    const targetRoles = target.grantsByTable.get(tbl) ?? new Map<string, Set<string>>();
    for (const [role, primePrivs] of primeRoles) {
      const targetPrivs = targetRoles.get(role);
      if (!targetPrivs || targetPrivs.size === 0) {
        missing_grantees.push({ table: tbl, role });
        continue;
      }
      const missing = [...primePrivs].filter((p) => !targetPrivs.has(p));
      const extra = [...targetPrivs].filter((p) => !primePrivs.has(p));
      if (missing.length || extra.length) {
        drift.push({
          table: tbl,
          role,
          missing_privileges: missing.sort(),
          extra_privileges: extra.sort(),
        });
      }
    }
  }
  return { drift, missing_grantees };
}

// G5 — Enum type parity: any enum used by a shared column must exist on the
// target with the same label set (order matters for ordinal comparisons).
function diffEnums(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const labelDrift: Array<{ name: string; prime: string[]; target: string[] }> = [];
  for (const [name, primeLabels] of prime.enumsByName) {
    const targetLabels = target.enumsByName.get(name);
    if (!targetLabels) {
      missing.push(name);
      continue;
    }
    if (JSON.stringify(primeLabels) !== JSON.stringify(targetLabels)) {
      labelDrift.push({ name, prime: primeLabels, target: targetLabels });
    }
  }
  return { missing_in_target: missing.sort(), label_drift: labelDrift };
}

// G5 — Trigger parity on public tables.
function diffTriggers(prime: Snapshot, target: Snapshot) {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const k of prime.triggerKeys) if (!target.triggerKeys.has(k)) missing.push(k);
  for (const k of target.triggerKeys) if (!prime.triggerKeys.has(k)) extra.push(k);
  return {
    prime_count: prime.triggerKeys.size,
    target_count: target.triggerKeys.size,
    missing_in_target: missing.sort(),
    extra_in_target: extra.sort(),
  };
}

// ── Public entry ──────────────────────────────────────────────────────

/**
 * Set-difference helper for the object classes that are just names. Reporting
 * both directions matters: a rename is a missing plus an extra, and a count
 * comparison would call it equal.
 */
function diffKeySets(prime: Set<string>, target: Set<string>) {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const k of prime) if (!target.has(k)) missing.push(k);
  for (const k of target) if (!prime.has(k)) extra.push(k);
  return {
    prime_count: prime.size,
    target_count: target.size,
    missing_in_target: missing.sort(),
    extra_in_target: extra.sort(),
  };
}

function diffConstraints(prime: Snapshot, target: Snapshot) {
  return diffKeySets(prime.constraintKeys, target.constraintKeys);
}

function diffIndexes(prime: Snapshot, target: Snapshot) {
  return diffKeySets(prime.indexKeys, target.indexKeys);
}

function diffMatviews(prime: Snapshot, target: Snapshot) {
  return diffKeySets(prime.matviewKeys, target.matviewKeys);
}

function diffSequences(prime: Snapshot, target: Snapshot) {
  return diffKeySets(prime.sequenceKeys, target.sequenceKeys);
}

export type ParityResult = {
  prime_ref: string;
  target_ref: string;
  tables_diff: ReturnType<typeof diffTables>;
  policies_diff: ReturnType<typeof diffPolicies>;
  functions_diff: ReturnType<typeof diffFunctions>;
  extensions_diff: ReturnType<typeof diffExtensions>;
  buckets_diff: ReturnType<typeof diffBuckets>;
  cron_diff: ReturnType<typeof diffCron>;
  edge_functions_diff: ReturnType<typeof diffEdgeFunctions>;
  secrets_diff: ReturnType<typeof diffSecrets>;
  auth_config_diff: ReturnType<typeof diffAuthConfig>;
  required_extensions_diff: ReturnType<typeof diffRequiredExtensions>;
  realtime_diff: ReturnType<typeof diffRealtime>;
  grants_diff: ReturnType<typeof diffGrants>;
  enums_diff: ReturnType<typeof diffEnums>;
  triggers_diff: ReturnType<typeof diffTriggers>;
  constraints_diff: ReturnType<typeof diffConstraints>;
  indexes_diff: ReturnType<typeof diffIndexes>;
  matviews_diff: ReturnType<typeof diffMatviews>;
  sequences_diff: ReturnType<typeof diffSequences>;
  blocking_issues: string[];
  /**
   * What the CLONE holds and the prime does not.
   *
   * Catalog introspection creates and never drops, and every stage reconciles
   * on `cloneCount >= primeCount` — so an object the prime DELETES survives on
   * the clone for ever and the engine reads that as reconciled. Measured on
   * the Preflight clone, 3 Sep 2026: `public.builder_design_images`, present
   * on the clone and in no schema of the prime, against a `tables` stage that
   * reported reconciled.
   *
   * Every `extra_in_target` list this function already computed was written to
   * the jsonb column and named by nothing an operator reads: `blocking_issues`
   * counts only what is MISSING, and the row's own status line said "verified
   * against the prime". So the surplus is rolled up here and put in the
   * summary.
   *
   * NOT blocking, deliberately. Removing an object from a live tenant database
   * destroys data if the object is theirs rather than the prime's leftover,
   * and nothing in the schema distinguishes the two. This names the drift; it
   * does not act on it.
   */
  surplus_in_target: { total: number; by_class: Record<string, number>; sample: string[] };
  risk_level: "low" | "medium" | "high" | "blocking";
  summary: string;
};

export async function computeParity(primeRef: string, targetRef: string): Promise<ParityResult> {
  const [prime, target] = await Promise.all([
    snapshotProject(primeRef),
    snapshotProject(targetRef),
  ]);

  const tables = diffTables(prime, target);
  const policies = diffPolicies(prime, target);
  const functions = diffFunctions(prime, target);
  const extensions = diffExtensions(prime, target);
  const buckets = diffBuckets(prime, target);
  const cron = diffCron(prime, target);
  const edgeFns = diffEdgeFunctions(prime, target);
  const secrets = diffSecrets(prime, target);
  const authCfg = diffAuthConfig(prime, target);
  const requiredExt = diffRequiredExtensions(target);
  const realtime = diffRealtime(prime, target);
  const grants = diffGrants(prime, target);
  const enums = diffEnums(prime, target);
  const triggers = diffTriggers(prime, target);
  const constraints = diffConstraints(prime, target);
  const indexes = diffIndexes(prime, target);
  const matviews = diffMatviews(prime, target);
  const sequences = diffSequences(prime, target);

  const blocking: string[] = [];
  if (tables.missing_in_target.length)
    blocking.push(`missing_tables:${tables.missing_in_target.length}`);
  if (tables.column_drift.some((c) => c.missing.length || c.typeChanges.length))
    blocking.push("column_drift");
  if (policies.rls_disabled_in_target.length)
    blocking.push(`rls_disabled:${policies.rls_disabled_in_target.length}`);
  if (policies.missing_policies.length)
    blocking.push(`missing_policies:${policies.missing_policies.length}`);
  if (functions.missing_in_target.length)
    blocking.push(`missing_functions:${functions.missing_in_target.length}`);
  if (extensions.missing_in_target.length)
    blocking.push(`missing_extensions:${extensions.missing_in_target.length}`);
  if (buckets.missing_in_target.length)
    blocking.push(`missing_buckets:${buckets.missing_in_target.length}`);
  if (secrets.missing_in_target.length)
    blocking.push(`missing_secrets:${secrets.missing_in_target.length}`);
  if (edgeFns.missing_in_target.length)
    blocking.push(`missing_edge_functions:${edgeFns.missing_in_target.length}`);
  if (requiredExt.missing_in_target.length)
    blocking.push(`missing_required_extensions:${requiredExt.missing_in_target.length}`);
  if (realtime.missing_in_target.length)
    blocking.push(`missing_realtime_tables:${realtime.missing_in_target.length}`);
  // G5 blockers — GRANT gaps break PostgREST reachability; enum drift breaks
  // shared-column inserts; missing triggers break cascade/audit invariants.
  if (grants.missing_grantees.length)
    blocking.push(`missing_grantees:${grants.missing_grantees.length}`);
  if (enums.missing_in_target.length)
    blocking.push(`missing_enums:${enums.missing_in_target.length}`);
  if (enums.label_drift.length) blocking.push(`enum_label_drift:${enums.label_drift.length}`);
  if (triggers.missing_in_target.length)
    blocking.push(`missing_triggers:${triggers.missing_in_target.length}`);
  // A clone can match on every table and column while holding no keys at all.
  if (constraints.missing_in_target.length)
    blocking.push(`missing_constraints:${constraints.missing_in_target.length}`);
  if (indexes.missing_in_target.length)
    blocking.push(`missing_indexes:${indexes.missing_in_target.length}`);
  if (matviews.missing_in_target.length)
    blocking.push(`missing_matviews:${matviews.missing_in_target.length}`);
  if (sequences.missing_in_target.length)
    blocking.push(`missing_sequences:${sequences.missing_in_target.length}`);

  // `clone >= prime` is a CONTAINMENT check, not an equality check. Reporting
  // containment as "matches the prime" is what let a dropped table sit on a
  // tenant's database unremarked.
  const surplusSources: Array<[string, readonly string[]]> = [
    ["tables", tables.extra_in_target],
    ["functions", functions.extra_in_target],
    ["edge_functions", edgeFns.extra_in_target],
    ["triggers", triggers.extra_in_target],
    ["constraints", constraints.extra_in_target],
    ["indexes", indexes.extra_in_target],
    ["matviews", matviews.extra_in_target],
    ["sequences", sequences.extra_in_target],
  ];
  const byClass: Record<string, number> = {};
  const surplusSample: string[] = [];
  let surplusTotal = 0;
  for (const [name, list] of surplusSources) {
    if (!Array.isArray(list) || list.length === 0) continue;
    byClass[name] = list.length;
    surplusTotal += list.length;
    // Named, capped, and prefixed by class so a sample of twenty is readable
    // rather than twenty bare identifiers from nine different catalogs.
    for (const item of list.slice(0, 5)) surplusSample.push(`${name}:${item}`);
  }
  const surplus = { total: surplusTotal, by_class: byClass, sample: surplusSample.slice(0, 20) };

  let risk: ParityResult["risk_level"] = "low";
  if (
    extensions.version_skew.length ||
    tables.extra_in_target.length ||
    buckets.config_drift.length ||
    cron.missing_in_target.length ||
    cron.schedule_drift.length ||
    authCfg.drift.length ||
    grants.drift.length ||
    triggers.extra_in_target.length
  ) {
    risk = "medium";
  }
  if (functions.extra_in_target.length || edgeFns.extra_in_target.length) risk = "medium";
  if (blocking.length) risk = "blocking";

  const summary =
    `prime=${tables.prime_count} tables / ${prime.functionSigs.size} fns / ` +
    `${buckets.prime_count} buckets / ${cron.prime_count} cron / ${edgeFns.prime_count} edge-fns / ` +
    `${secrets.prime_count} secrets / ${prime.enumsByName.size} enums / ${triggers.prime_count} triggers · ` +
    `target=${tables.target_count} tables / ${target.functionSigs.size} fns / ` +
    `${buckets.target_count} buckets / ${cron.target_count} cron / ${edgeFns.target_count} edge-fns / ` +
    `${secrets.target_count} secrets / ${target.enumsByName.size} enums / ${triggers.target_count} triggers · ` +
    `blocking=${blocking.length}` +
    // Said in the summary because the jsonb is where it was already recorded
    // and nobody reads jsonb.
    (surplus.total > 0
      ? ` · clone-only (prime dropped or tenant-added)=${surplus.total} [${Object.entries(
          surplus.by_class,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}]`
      : "");

  return {
    prime_ref: primeRef,
    target_ref: targetRef,
    tables_diff: tables,
    policies_diff: policies,
    functions_diff: functions,
    extensions_diff: extensions,
    buckets_diff: buckets,
    cron_diff: cron,
    edge_functions_diff: edgeFns,
    secrets_diff: secrets,
    auth_config_diff: authCfg,
    required_extensions_diff: requiredExt,
    realtime_diff: realtime,
    grants_diff: grants,
    enums_diff: enums,
    triggers_diff: triggers,
    constraints_diff: constraints,
    indexes_diff: indexes,
    matviews_diff: matviews,
    sequences_diff: sequences,
    blocking_issues: blocking,
    surplus_in_target: surplus,
    risk_level: risk,
    summary,
  };
}
