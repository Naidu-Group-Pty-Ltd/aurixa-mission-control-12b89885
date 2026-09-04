/**
 * Supabase Management API helpers for programmatically provisioning
 * dedicated backend projects for each clone.
 *
 * Requires two secrets:
 *   SB_MGMT_API_TOKEN  – Personal Access Token from supabase.com/dashboard/account/tokens
 *   SB_ORG_ID          – Organization ID from supabase.com/dashboard/org/_/general
 */

import crypto from "node:crypto";

import { classifySecret, TENANT_SCOPED_REMEDY } from "./prime-backend.server";
import { OversizedMigrationError } from "./oversizedMigration.pure";
import { assessLedgerState, ledgerRepairHint } from "./cloneLedgerState.pure";
import { BudgetPause, pastDeadline } from "./provisioningBudget";
import { chooseRoleLabel, describeSeed, sqlCredentialLiteral } from "./cloneAdminIdentity.pure";
import type { AdminSeedReport } from "./cloneAdminIdentity.pure";
import type { PrimeBackendSnapshot } from "./prime-backend.server";
import type { StageName, StageResult } from "./schema-introspection.server";

const MGMT_API = "https://api.supabase.com/v1";

function getMgmtToken(): string {
  const token = process.env.SB_MGMT_API_TOKEN;
  if (!token) throw new Error("SB_MGMT_API_TOKEN secret is not configured");
  return token;
}

function getOrgId(): string {
  const orgId = process.env.SB_ORG_ID;
  if (!orgId) throw new Error("SB_ORG_ID secret is not configured");
  return orgId;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getMgmtToken()}`,
    "Content-Type": "application/json",
  };
}

// ─── Types ───────────────────────────────────────────────────────────

export type CreateProjectInput = {
  name: string;
  region?: string;
  plan?: "free" | "pro";
  dbPass: string;
};

export type SupabaseProject = {
  id: string; // project ref
  name: string;
  organization_id: string;
  region: string;
  status: string;
  created_at: string;
  database: {
    host: string;
    version: string;
  };
};

export type ApiKey = {
  name: string;
  api_key: string;
};

// ─── Project Lifecycle ───────────────────────────────────────────────

/**
 * G10 — Verify the target Supabase org has capacity before we burn a
 * project slot on `POST /v1/projects`. Free-tier orgs are hard-capped at
 * 2 active projects; the create call otherwise fails after we've already
 * generated a db password and updated status, leaving the operator with
 * a confusing error. This preflight surfaces the exact reason ahead of
 * time and is reused by the twin provisioner (handoffs) with the
 * client's PAT + orgId so we don't consume a free slot in their org.
 */

export type OrgCapacityResult = {
  orgId: string;
  orgName: string | null;
  planTier: string | null;
  activeProjects: number;
  softLimit: number;
  wouldExceed: boolean;
  hardBlock: boolean;
  reason: string | null;
  projects: Array<{ id: string; name: string; status: string; region: string }>;
};

const DEFAULT_SOFT_LIMITS: Record<string, number> = {
  free: 2,
  pro: 30,
  team: 30,
  enterprise: 100,
};

function resolveSoftLimit(planTier: string | null, override?: number | null): number {
  if (typeof override === "number" && override > 0) return override;
  const envOverride = Number(process.env.SB_ORG_PROJECT_SOFT_LIMIT || "");
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  const key = (planTier || "").toLowerCase();
  return DEFAULT_SOFT_LIMITS[key] ?? DEFAULT_SOFT_LIMITS.pro;
}

export async function checkOrgCapacity(input?: {
  token?: string;
  orgId?: string;
  softLimit?: number | null;
}): Promise<OrgCapacityResult> {
  const token = input?.token ?? getMgmtToken();
  const orgId = input?.orgId ?? getOrgId();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Fetch org metadata (best-effort — some plans don't expose `plan`).
  let orgName: string | null = null;
  let planTier: string | null = null;
  try {
    const orgsRes = await fetch(`${MGMT_API}/organizations`, { headers: authHeaders });
    if (orgsRes.ok) {
      const list = (await orgsRes.json()) as Array<Record<string, unknown>>;
      const match = list.find((o) => o.id === orgId || o.slug === orgId);
      if (match) {
        orgName = typeof match.name === "string" ? match.name : null;
        planTier =
          typeof match.plan === "string"
            ? match.plan
            : typeof (match as Record<string, unknown>).tier === "string"
              ? ((match as Record<string, unknown>).tier as string)
              : null;
      }
    }
  } catch {
    // Non-fatal — capacity check falls back to the pro-tier default limit.
  }

  // List projects visible to this PAT, filter by org.
  const projRes = await fetch(`${MGMT_API}/projects`, { headers: authHeaders });
  if (!projRes.ok) {
    const body = await projRes.text();
    throw new Error(`Capacity preflight failed to list projects: ${projRes.status} — ${body}`);
  }
  const allProjects = (await projRes.json()) as Array<Record<string, unknown>>;
  const nonTerminal = new Set([
    "ACTIVE_HEALTHY",
    "COMING_UP",
    "INACTIVE",
    "GOING_DOWN",
    "INIT_FAILED",
    "REMOVED",
    "RESTORING",
    "UPGRADING",
    "PAUSING",
    "RESTORE_FAILED",
    "PAUSED",
    "UNKNOWN",
  ]);
  const orgProjects = allProjects
    .filter((p) => p.organization_id === orgId)
    // Count anything that still occupies a slot; PAUSED counts on the free tier.
    .filter((p) => typeof p.status !== "string" || nonTerminal.has(p.status as string))
    .map((p) => ({
      id: String(p.id ?? p.ref ?? ""),
      name: String(p.name ?? ""),
      status: String(p.status ?? "UNKNOWN"),
      region: String(p.region ?? ""),
    }));

  const softLimit = resolveSoftLimit(planTier, input?.softLimit);
  const activeProjects = orgProjects.length;
  const wouldExceed = activeProjects + 1 > softLimit;
  const hardBlock = wouldExceed && (planTier ?? "").toLowerCase() === "free";
  const reason = hardBlock
    ? `Free-tier orgs are limited to ${softLimit} active projects. Upgrade the org or archive an unused project before provisioning.`
    : wouldExceed
      ? `Creating another project would exceed the configured soft limit of ${softLimit}. Set SB_ORG_PROJECT_SOFT_LIMIT to override, or archive an unused project.`
      : null;

  return {
    orgId,
    orgName,
    planTier,
    activeProjects,
    softLimit,
    wouldExceed,
    hardBlock,
    reason,
    projects: orgProjects,
  };
}

/**
 * Create a new Supabase project under the configured organization.
 */
export async function createSupabaseProject(input: CreateProjectInput): Promise<SupabaseProject> {
  const res = await fetch(`${MGMT_API}/projects`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: input.name,
      organization_id: getOrgId(),
      region: input.region || "us-east-1",
      plan: input.plan || "free",
      db_pass: input.dbPass,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create Supabase project: ${res.status} — ${body}`);
  }

  return res.json();
}

/**
 * Poll project status until it becomes ACTIVE_HEALTHY or times out.
 */
export async function waitForProjectReady(
  projectRef: string,
  maxWaitMs = 120_000,
  pollIntervalMs = 5_000,
): Promise<SupabaseProject> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}`, {
      headers: headers(),
    });
    if (!res.ok) {
      throw new Error(`Failed to check project status: ${res.status}`);
    }
    const project: SupabaseProject = await res.json();
    if (project.status === "ACTIVE_HEALTHY") {
      return project;
    }
    // Wait before polling again
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`Project ${projectRef} did not become ready within ${maxWaitMs / 1000}s`);
}

/**
 * Retrieve the API keys for a project. `reveal=true` is required for the
 * Management API to include raw key values in the response.
 */
export async function getProjectApiKeys(projectRef: string): Promise<ApiKey[]> {
  const res = await fetch(`${MGMT_API}/projects/${projectRef}/api-keys?reveal=true`, {
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get API keys: ${res.status} — ${body}`);
  }
  return res.json();
}

/**
 * The project's token-signing key.
 *
 * `GET /v1/projects/{ref}/postgrest` is the one endpoint that returns it
 * (`PostgrestConfigWithJWTSecretResponse.jwt_secret`) — it is PostgREST's
 * config, and the signing key is part of it because PostgREST is what
 * validates the tokens. It is NOT on the create-project response
 * (`V1ProjectResponse` carries id, ref, organization_id, organization_slug,
 * name, region, created_at and status, and nothing else) and it cannot be
 * derived from the anon or service-role keys, which are signed WITH it.
 *
 * Being readable at any time rather than only at creation is what makes this
 * work for a project Mission Control ADOPTED as well as one it created.
 *
 * `jwt_secret` is not in the schema's `required` list, so a project that does
 * not report one yields null and the caller records the secret as pending
 * rather than writing an empty value.
 */
export async function getProjectJwtSecret(projectRef: string): Promise<string | null> {
  const res = await fetch(`${MGMT_API}/projects/${projectRef}/postgrest`, {
    headers: headers(),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { jwt_secret?: string };
  const secret = body.jwt_secret?.trim();
  return secret && secret.length > 0 ? secret : null;
}

/**
 * Pick the client-safe and privileged keys from a project's key list,
 * handling both legacy (anon / service_role) and current
 * (publishable / secret) Supabase key naming.
 */
export function selectProjectKeys(keys: ApiKey[]): {
  anonKey: string | null;
  serviceRoleKey: string | null;
} {
  const byName = (n: string) => keys.find((k) => k.name === n)?.api_key ?? null;
  const byType = (t: string) =>
    keys.find((k) => (k as { type?: string }).type === t)?.api_key ?? null;
  const byPrefix = (p: string) => keys.find((k) => k.api_key?.startsWith(p))?.api_key ?? null;
  return {
    anonKey: byName("anon") ?? byType("publishable") ?? byPrefix("sb_publishable_"),
    serviceRoleKey: byName("service_role") ?? byType("secret") ?? byPrefix("sb_secret_"),
  };
}

/**
 * Get the project URL from the ref.
 */
export function getProjectUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
}

// ─── Database Queries ────────────────────────────────────────────────

/**
 * Run a SQL query against a project's database via the Management API.
 */
export async function runSqlOnProject(projectRef: string, sql: string): Promise<unknown> {
  const res = await fetch(`${MGMT_API}/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SQL execution failed on ${projectRef}: ${res.status} — ${body}`);
  }

  return res.json();
}

// ─── Storage Bucket Replication ──────────────────────────────────────

/**
 * Shape of a storage bucket as returned by (and accepted by) the Supabase
 * Management API's storage endpoints. Public/private, size caps, and mime
 * allowlists are configuration that must be replicated onto every clone —
 * the row-level policies on `storage.objects` come with the prime's
 * migrations, so a bucket that never gets created leaves those policies
 * unable to match anything on the clone (the app then silently fails uploads).
 */
export type StorageBucketConfig = {
  id: string;
  name: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
};

function normalizeBucket(raw: unknown): StorageBucketConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : typeof r.name === "string" ? r.name : null;
  if (!id) return null;
  return {
    id,
    name: typeof r.name === "string" ? r.name : id,
    public: r.public === true,
    file_size_limit: typeof r.file_size_limit === "number" ? r.file_size_limit : null,
    allowed_mime_types: Array.isArray(r.allowed_mime_types)
      ? r.allowed_mime_types.filter((m): m is string => typeof m === "string")
      : null,
  };
}

// `getPrimeProjectRef()` / `tryGetPrimeProjectRef()` used to live here. Both
// derived a ref from `SUPABASE_URL` and their doc comment said so plainly:
// "Derive the prime project's ref from the server-side Supabase URL." That URL
// is THIS deployment's own project — the database holding `clones`,
// `prime_config` and `cascade_events` — so every step that "replicated from
// the prime" was reading Mission Control's own admin project: the catalogue
// introspection that builds a clone's schema, its storage buckets and seed
// assets, its pg_cron schedule (which would have pointed a clone's jobs at
// Mission Control's own /hooks endpoints), its realtime publication, and every
// handoff parity report.
//
// There is no derivation that can answer this. The prime backend is a piece of
// configuration — `prime_config.supabase_project_ref` — and the resolver that
// reads it (`resolvePrimeBackendRef`, in prime-backend.server.ts) refuses both
// an unset value and this deployment's own ref rather than substituting one.
// Callers pass the resolved ref in; nothing in this module guesses it.

/**
 * List every storage bucket on a project (config only — no object contents).
 */
export async function listProjectStorageBuckets(
  projectRef: string,
): Promise<StorageBucketConfig[]> {
  const res = await fetch(`${MGMT_API}/projects/${projectRef}/storage/buckets`, {
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to list storage buckets on ${projectRef}: ${res.status} — ${body}`);
  }
  const raw = (await res.json()) as unknown[];
  return raw.map(normalizeBucket).filter((b): b is StorageBucketConfig => b !== null);
}

/**
 * List deployed Edge Function slugs on a project. Used by the handoff
 * parity engine (G3) to detect functions that live on prime but haven't
 * been deployed to the target yet. Returns [] on failure so parity can
 * still compute the rest of the diff.
 */
export async function listProjectEdgeFunctionSlugs(projectRef: string): Promise<string[]> {
  try {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/functions`, {
      headers: headers(),
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r) => {
        const o = r as Record<string, unknown>;
        return typeof o.slug === "string"
          ? o.slug
          : typeof o.name === "string"
            ? (o.name as string)
            : "";
      })
      .filter((s) => s.length > 0)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The clone's live functions, each with the moment it was last deployed.
 *
 * `listProjectEdgeFunctionSlugs` answers "which of these does the target
 * have". A REDEPLOY needs a different question — "which has this pass
 * already refreshed" — and the two stop agreeing the moment the target holds
 * every slug, which is the ordinary state for a cascade: all 423 exist and
 * are simply stale. Answering the first question there would skip every
 * bundle and deploy nothing.
 *
 * Kept beside the existing reader rather than widening it. Provisioning asks
 * the first question on every pass, and changing that return type would edit
 * the one path already known to work.
 *
 * A failed read answers an EMPTY map, never a full one: empty means "nothing
 * is known to be fresh", which redeploys more than strictly necessary. The
 * opposite mistake skips bundles that were never deployed, and does it
 * silently — the same asymmetry `skipFunctionSlugs`' own `.catch(() => [])`
 * is written for.
 */
export async function listProjectEdgeFunctionFreshness(
  projectRef: string,
): Promise<Map<string, number>> {
  const fresh = new Map<string, number>();
  try {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/functions`, {
      headers: headers(),
    });
    if (!res.ok) return fresh;
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return fresh;
    for (const r of raw) {
      const o = r as Record<string, unknown>;
      const slug =
        typeof o.slug === "string" ? o.slug : typeof o.name === "string" ? (o.name as string) : "";
      if (!slug) continue;
      // The Management API reports epoch milliseconds. A seconds value or an
      // ISO string is accepted rather than assumed away, and anything
      // unreadable is left ABSENT — absent means "not known to be fresh",
      // which redeploys, so a format change costs work rather than coverage.
      const stamp = o.updated_at ?? o.created_at;
      const ms =
        typeof stamp === "number"
          ? stamp < 1e12
            ? stamp * 1000
            : stamp
          : typeof stamp === "string"
            ? Date.parse(stamp)
            : Number.NaN;
      if (Number.isFinite(ms)) fresh.set(slug, ms);
    }
    return fresh;
  } catch {
    return fresh;
  }
}

/**
 * List secret NAMES only on a project. Never returns values. Used by G3
 * parity to flag secret keys the target is missing.
 */
export async function listProjectSecretNames(projectRef: string): Promise<string[]> {
  try {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/secrets`, {
      headers: headers(),
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r) => {
        const o = r as Record<string, unknown>;
        return typeof o.name === "string" ? o.name : "";
      })
      .filter((s) => s.length > 0)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Fetch the [auth] config block for a project. G3 parity diffs a
 * whitelisted subset (site_url, uri_allow_list, JWT expiry, signup
 * toggles, password policy) — never OAuth provider secrets.
 */
export async function getProjectAuthConfig(
  projectRef: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/config/auth`, {
      headers: headers(),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Create a bucket on the target project with the same visibility, size cap,
 * and mime allowlist as the source. Idempotent: a bucket that already exists
 * (409) is treated as success so retries and re-runs are safe.
 */
export type BucketReplicationResult = {
  id: string;
  status: "created" | "exists" | "failed" | "deferred";
  error?: string;
  objects_copied?: number;
  objects_failed?: number;
  objects_skipped?: number;
  bytes_copied?: number;
  /** Set when the bucket's CONTENTS were deliberately not copied. */
  contents_withheld?: string;
};

/**
 * Which buckets, if any, may have their CONTENTS copied onto a clone.
 *
 * EMPTY, and that is the policy rather than a placeholder.
 *
 * This engine's governing rule is "structure only, never data" — the
 * replication path carries schema, functions and configuration, and no prime
 * row is ever destined for a clone. Storage objects are data. They are the
 * prime's customers' files: listing photographs, identity captures the AML
 * retention job deletes on a clock, generated reports, uploaded documents.
 *
 * The rule held for rows and had never been tested for objects, because
 * bucket CREATION had never once succeeded — every bucket answered 404 at the
 * Management API, so the object copy below could not run and nobody found out
 * what it would do. Fixing creation made the second half of this step run for
 * the first time, on 4 Sep 2026, and it began walking all 32 of the prime's
 * buckets — 59,050 objects, 25.1 GB — copying what it found onto a tenant's
 * project. It moved 21-24 branding assets onto each clone and, on one of
 * them, a customer document and a customer form, before the pass was stopped.
 *
 * `SEED_ASSET_LIMITS` bounded it only by accident: 500 objects and 512 MB PER
 * BUCKET across 32 buckets authorises ~16,000 objects and ~16 GB. A limit is
 * not a policy.
 *
 * So the copy is now allow-listed and the list is empty. A bucket earns a
 * place here only by being seed material the product genuinely needs and that
 * belongs to nobody — never by being small, and never by being convenient.
 * Adding a name here is a disclosure decision, so it is made once, in the
 * open, and asserted by a test.
 */
export const SEED_ASSET_BUCKETS: readonly string[] = [];

export type StorageConfigResult =
  | { status: "applied"; fileSizeLimit: number; previous?: number | null }
  | { status: "already_matches"; fileSizeLimit: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/**
 * Give the clone the prime's PROJECT-LEVEL upload limit, before any bucket
 * is created against it.
 *
 * A bucket's `file_size_limit` may not exceed the project's global upload
 * limit, and a fresh project gets the platform default while the prime's has
 * been raised. The Storage API does not explain that: it answers the bucket
 * creation with
 *
 *   400 {"statusCode":"413","error":"Payload too large",
 *        "message":"The object exceeded the maximum allowed size"}
 *
 * which reads as something wrong with the bucket. Measured 4 Sep 2026 on the
 * first pass that ever created buckets: `vsl-media` asks for 20 GB and
 * `qa_exports` for 100 MB, and both were refused on every clone — 2 of 32
 * buckets that could never exist, for a reason no bucket-level retry could
 * ever fix.
 *
 * Two rules. The limit is READ from the prime rather than assumed, like every
 * other replicated setting. And a failure here is reported and non-fatal: the
 * buckets that fit are still worth creating, and the two that do not will say
 * exactly why.
 */
export async function replicateStorageConfig(
  primeRef: string,
  cloneRef: string,
): Promise<StorageConfigResult> {
  const read = async (ref: string): Promise<number | null> => {
    const res = await fetch(`${MGMT_API}/projects/${ref}/config/storage`, {
      headers: headers(),
    });
    if (!res.ok) throw new Error(`${res.status} — ${await res.text()}`);
    const body = (await res.json()) as { fileSizeLimit?: unknown };
    return typeof body?.fileSizeLimit === "number" ? body.fileSizeLimit : null;
  };
  let wanted: number | null;
  let current: number | null;
  try {
    [wanted, current] = await Promise.all([read(primeRef), read(cloneRef)]);
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (wanted === null) {
    return { status: "skipped", reason: "the prime's project reports no upload limit" };
  }
  // Never LOWER a clone's limit to match: the buckets are what need room, and
  // a clone that already allows more is not a defect to correct.
  if (current !== null && current >= wanted) {
    return { status: "already_matches", fileSizeLimit: current };
  }
  try {
    const res = await fetch(`${MGMT_API}/projects/${cloneRef}/config/storage`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ fileSizeLimit: wanted }),
    });
    if (!res.ok) return { status: "failed", error: `${res.status} — ${await res.text()}` };
    return { status: "applied", fileSizeLimit: wanted, previous: current };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Create one bucket on the clone, through the PROJECT's Storage API.
 *
 * Not the Management API. `GET /v1/projects/{ref}/storage/buckets` exists and
 * is how the prime's buckets are read — but there is no POST beside it, and
 * asking for one answers:
 *
 *   404 — {"message":"Cannot POST /v1/projects/{ref}/storage/buckets"}
 *
 * So this had never created a bucket. Not once, on any clone: the first
 * complete parity report the engine ever produced, 3 Sep 2026, read
 * `missing_buckets:32` against a prime with 32 and a clone with none, and all
 * 32 results in the audit log carry that same 404.
 *
 * Nothing said so, and the schema hides it: the row-level policies on
 * `storage.objects` arrive with the migrations, so a clone has every policy
 * governing buckets that do not exist. Uploads and signed URLs then 404 at
 * runtime — the app looks built and cannot store a file.
 *
 * The object copy in this same module has always used the Storage API with a
 * service-role key (`replicateBucketObjects`), so the module already knew
 * where storage lives; only creation went to the wrong door.
 */
export async function createStorageBucket(
  projectRef: string,
  bucket: StorageBucketConfig,
  /** Service-role key for the TARGET project. The Storage API takes no management token. */
  serviceRoleKey: string,
): Promise<BucketReplicationResult> {
  const body = {
    id: bucket.id,
    name: bucket.name,
    public: bucket.public,
    file_size_limit: bucket.file_size_limit,
    allowed_mime_types: bucket.allowed_mime_types,
  };
  const res = await fetch(`${getProjectUrl(projectRef)}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.ok) return { id: bucket.id, status: "created" };
  const text = await res.text();
  if (res.status === 409 || /already exists|duplicate/i.test(text)) {
    return { id: bucket.id, status: "exists" };
  }
  return { id: bucket.id, status: "failed", error: `${res.status} — ${text}` };
}

// ─── G2: Seed-asset replication ──────────────────────────────────────
// Bucket *configuration* replication creates empty buckets on the clone. But
// prime buckets like `brand-assets` (default logos, favicons, email header
// images) and `security-reports` (baseline templates, disclosure PDFs) ship
// with seed contents that the app expects to exist. Without those objects,
// the clone renders broken images and the security portal 404s on templates.
// This block walks each prime bucket via the Storage REST API and re-uploads
// every object to the target using service-role keys on both ends. Per-bucket
// caps keep a misconfigured prime from ballooning provisioning cost; per-
// object failures are non-fatal and surfaced on the result row.

type StorageObjectEntry = {
  name: string;
  id: string | null; // null => folder
  metadata: { size?: number; mimetype?: string } | null;
};

const SEED_ASSET_LIMITS = {
  maxObjectsPerBucket: 500,
  maxBytesPerObject: 25 * 1024 * 1024,
  maxTotalBytesPerBucket: 512 * 1024 * 1024,
};

function encodeStoragePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function listBucketFolder(
  projectUrl: string,
  serviceKey: string,
  bucketId: string,
  prefix: string,
): Promise<StorageObjectEntry[]> {
  const out: StorageObjectEntry[] = [];
  const pageSize = 100;
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`${projectUrl}/storage/v1/object/list/${bucketId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix,
        limit: pageSize,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
    });
    if (!res.ok) {
      throw new Error(`list ${bucketId}/${prefix}: ${res.status} — ${await res.text()}`);
    }
    const rows = (await res.json()) as StorageObjectEntry[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

async function walkBucket(
  projectUrl: string,
  serviceKey: string,
  bucketId: string,
): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && files.length < SEED_ASSET_LIMITS.maxObjectsPerBucket) {
    const prefix = queue.shift()!;
    const rows = await listBucketFolder(projectUrl, serviceKey, bucketId, prefix);
    for (const row of rows) {
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      if (row.id === null) {
        queue.push(path);
      } else {
        files.push(path);
        if (files.length >= SEED_ASSET_LIMITS.maxObjectsPerBucket) break;
      }
    }
  }
  return files;
}

async function copyBucketObject(
  sourceUrl: string,
  sourceKey: string,
  targetUrl: string,
  targetKey: string,
  bucketId: string,
  path: string,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string; skipped?: boolean }> {
  const dl = await fetch(`${sourceUrl}/storage/v1/object/${bucketId}/${encodeStoragePath(path)}`, {
    headers: { Authorization: `Bearer ${sourceKey}`, apikey: sourceKey },
  });
  if (!dl.ok) return { ok: false, error: `download ${dl.status}` };
  const contentType = dl.headers.get("content-type") ?? "application/octet-stream";
  const buf = await dl.arrayBuffer();
  if (buf.byteLength > SEED_ASSET_LIMITS.maxBytesPerObject) {
    return { ok: false, error: "object exceeds per-object cap", skipped: true };
  }
  const up = await fetch(`${targetUrl}/storage/v1/object/${bucketId}/${encodeStoragePath(path)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${targetKey}`,
      apikey: targetKey,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: buf,
  });
  if (!up.ok) return { ok: false, error: `upload ${up.status} — ${await up.text()}` };
  return { ok: true, bytes: buf.byteLength };
}

async function replicateBucketObjects(
  sourceUrl: string,
  sourceKey: string,
  targetUrl: string,
  targetKey: string,
  bucketId: string,
): Promise<{ copied: number; failed: number; skipped: number; bytes: number }> {
  const files = await walkBucket(sourceUrl, sourceKey, bucketId);
  let copied = 0;
  let failed = 0;
  let skipped = 0;
  let bytes = 0;
  for (const path of files) {
    if (bytes >= SEED_ASSET_LIMITS.maxTotalBytesPerBucket) {
      skipped++;
      continue;
    }
    const r = await copyBucketObject(sourceUrl, sourceKey, targetUrl, targetKey, bucketId, path);
    if (r.ok) {
      copied++;
      bytes += r.bytes;
    } else if ("skipped" in r && r.skipped) {
      skipped++;
    } else {
      failed++;
    }
  }
  return { copied, failed, skipped, bytes };
}

/**
 * Copy every bucket configuration from the prime to the target clone, and
 * seed each bucket with its prime contents (G2). Object copy is best-effort:
 * if service-role keys can't be retrieved for either side, config replication
 * still runs and object counts are omitted so operators know to retry seed-
 * asset copy manually.
 */
export async function replicateStorageBuckets(
  primeRef: string,
  targetRef: string,
  /**
   * Stop between buckets once this passes, marking the rest `deferred`.
   *
   * The config half is 32 Management-API round trips and the object half is
   * unbounded work, and this loop had no deadline check of any kind — not in
   * front of it, not inside it. It was invisible while every bucket 404'd
   * instantly; the moment creation worked, both clones sat on
   * "Replicating storage buckets..." until the stall reclaim took them, which
   * costs a hard attempt where a pause costs sixty seconds. That is the same
   * class as the cron and realtime steps, found the same way: by making the
   * step do real work for the first time.
   */
  deadlineAt?: number | null,
): Promise<BucketReplicationResult[]> {
  const primeBuckets = await listProjectStorageBuckets(primeRef);
  const results: BucketReplicationResult[] = [];

  let primeService: string | null = null;
  let targetService: string | null = null;
  try {
    primeService = selectProjectKeys(await getProjectApiKeys(primeRef)).serviceRoleKey;
    targetService = selectProjectKeys(await getProjectApiKeys(targetRef)).serviceRoleKey;
  } catch {
    // Object copy will be skipped for every bucket; config replication still runs.
  }
  const primeUrl = getProjectUrl(primeRef);
  const targetUrl = getProjectUrl(targetRef);

  for (const bucket of primeBuckets) {
    let configResult: BucketReplicationResult;
    // Between buckets, never mid-bucket: a half-copied bucket is worse than an
    // uncreated one, and the next pass re-enters here having kept what landed.
    if (pastDeadline(deadlineAt)) {
      results.push({
        id: bucket.id,
        status: "deferred",
        error: "invocation budget spent — carried to the next pass",
      });
      continue;
    }
    // Creation needs the target's service-role key, the same credential the
    // object copy below uses. Without it there is no way to reach the
    // project's Storage API at all, so say that rather than reporting a
    // bucket as failed for a reason that names nothing.
    if (!targetService) {
      results.push({
        id: bucket.id,
        status: "failed",
        error: "no service-role key for the clone — its Storage API cannot be reached",
      });
      continue;
    }
    try {
      configResult = await createStorageBucket(targetRef, bucket, targetService);
    } catch (err) {
      configResult = {
        id: bucket.id,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (configResult.status === "failed" || !primeService || !targetService) {
      results.push(configResult);
      continue;
    }
    // THE BUCKET TRAVELS; ITS CONTENTS DO NOT. See SEED_ASSET_BUCKETS for why
    // the list is empty and what happened when there was no list at all.
    // Recorded rather than silent: an operator reading this report should see
    // that the contents were withheld on purpose, not that a copy failed.
    if (!SEED_ASSET_BUCKETS.includes(bucket.id)) {
      results.push({
        ...configResult,
        contents_withheld:
          "not seed material — a clone receives the bucket, never the prime's objects",
      });
      continue;
    }
    try {
      const counts = await replicateBucketObjects(
        primeUrl,
        primeService,
        targetUrl,
        targetService,
        bucket.id,
      );
      results.push({
        ...configResult,
        objects_copied: counts.copied,
        objects_failed: counts.failed,
        objects_skipped: counts.skipped,
        bytes_copied: counts.bytes,
      });
    } catch (err) {
      results.push({
        ...configResult,
        objects_failed: -1,
        error: `seed-asset copy failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

/**
 * Replicate the prime's [auth] block (site_url, redirect allow-list, JWT
 * expiry, signup toggles, password policy) onto a target clone via the
 * Management API. Only whitelisted, non-secret fields are patched — OAuth
 * provider credentials are configured per-clone. Non-fatal: failures are
 * returned so provisioning can proceed even if auth config is rejected.
 */
export type AuthConfigResult =
  | { status: "applied"; fields: string[]; siteUrl?: string; redirectCount?: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/**
 * Origins for THIS clone — used to rewrite the prime's [auth] block so the
 * new backend accepts sign-ins from the clone's actual frontend host(s)
 * instead of the prime's Cloudflare/Lovable URL (G8).
 */
export type CloneOrigins = {
  /** Preferred canonical origin (e.g. https://client.example.com). */
  siteUrl?: string | null;
  /** Any other origins we should whitelist (deploy_url, lovable preview, cloudflare zone, etc.). */
  additionalRedirectUrls?: (string | null | undefined)[];
};

/**
 * The value `ALLOWED_ORIGINS` must carry on THIS clone.
 *
 * ## Why this exists
 *
 * `ALLOWED_ORIGINS` is classified `deployment_config`, which is right — the
 * prime's value names the prime's own hostnames and copying it onto a clone is
 * the whole defect this classification exists to prevent. But `planCloneSecrets`
 * then said, in a comment, that `applyAuthConfig` "already sets the clone's
 * origins from `cloneOrigins`", and that is not true of this name.
 * `applyAuthConfig` PATCHes `/config/auth`, which is GoTrue's `site_url` and
 * `uri_allow_list`. `ALLOWED_ORIGINS` is an EDGE FUNCTION environment variable,
 * read by `Deno.env.get('ALLOWED_ORIGINS')` in the prime's `_shared/auth.ts`.
 * Two different systems, one comment, and nothing ever wrote the second.
 *
 * ## What that cost, measured on the live clone
 *
 * The prime's CORS helper falls back, when the variable is unset, to a
 * hard-coded pair of the PRIME's production hostnames. So every clone answers
 * every request with somebody else's origin. Probed against
 * `npc-client-dashboard`'s own login endpoint on 26 Aug 2026:
 *
 *     Origin: https://npc.aurixasystems.com.au
 *       → access-control-allow-origin: https://command-centre.npcservices.com.au
 *         access-control-allow-credentials: true
 *
 * Identical for the clone's `.vercel.app` host. The browser sees an
 * allow-origin that is not the page's origin and refuses to hand the response
 * to the script — so signing in fails with no server-side error, on a
 * deployment where the credentials are correct and the account is healthy.
 * That was reported as "the seed admin credentials aren't working".
 *
 * ## Deliberately not also setting `CORS_STRICT_ALLOWED_ORIGINS`
 *
 * The prime's helper offers a flag that makes the unset case fail closed. It is
 * left to the operator. Failing closed here means no origin is trusted for a
 * credentialed response, which takes sign-in down completely — a worse outcome
 * than the status quo for a clone whose origins this could not compute. Getting
 * the value right is the fix; the flag is a posture the operator chooses once
 * they can see it is right.
 *
 * Returns null when nothing usable can be derived, which leaves the secret
 * unset and reported as `skipped_deployment_config` exactly as before.
 */
export function cloneAllowedOrigins(origins: CloneOrigins | null | undefined): string | null {
  const entries = [origins?.siteUrl ?? null, ...(origins?.additionalRedirectUrls ?? [])]
    .map(normalizeOriginEntry)
    .filter((v): v is string => v !== null);
  if (entries.length === 0) return null;
  // Deduplicated, and in the order given: the canonical site URL first, so a
  // reader of the secret can tell which host is the real one.
  return Array.from(new Set(entries)).join(",");
}

/**
 * Deployment-config secrets whose value Mission Control can compute for a
 * clone. Everything else in that class stays unset and is filled in by an
 * operator from the clone page — guessing a webhook URL or a sender address is
 * how a clone starts writing into somebody else's account.
 */
const DERIVED_DEPLOYMENT_CONFIG: Record<
  string,
  (origins: CloneOrigins | null | undefined) => string | null
> = {
  ALLOWED_ORIGINS: cloneAllowedOrigins,
};

/** Normalize a URL/host into a redirect entry. Returns null if unusable. */
function normalizeOriginEntry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname || u.hostname === "localhost") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Build the final auth patch: start from the prime's whitelisted block,
 * then override site_url + uri_allow_list with values scoped to the clone.
 * The prime's own hostnames are DROPPED — a customer's clone must never
 * accept OAuth callbacks or magic-link redirects for the prime domain.
 */
export function buildAuthConfigPatch(
  primeAuth: import("./prime-backend.server").PrimeAuthConfig | null,
  origins: CloneOrigins | null | undefined,
): import("./prime-backend.server").PrimeAuthConfig | null {
  const base = primeAuth ? { ...primeAuth } : null;

  const site = normalizeOriginEntry(origins?.siteUrl ?? null);
  const extras = (origins?.additionalRedirectUrls ?? [])
    .map(normalizeOriginEntry)
    .filter((v): v is string => v !== null);

  if (!site && extras.length === 0) return base;

  const patch = { ...(base ?? {}) };

  if (site) patch.site_url = site;

  // Merge site + extras + wildcard callback path, dedupe, drop prime entries.
  const redirectSet = new Set<string>();
  if (site) {
    redirectSet.add(site);
    redirectSet.add(`${site}/*`);
    redirectSet.add(`${site}/auth/callback`);
  }
  for (const extra of extras) {
    redirectSet.add(extra);
    redirectSet.add(`${extra}/*`);
    redirectSet.add(`${extra}/auth/callback`);
  }
  patch.uri_allow_list = Array.from(redirectSet).join(",");

  return Object.keys(patch).length > 0 ? patch : null;
}

export async function applyAuthConfig(
  projectRef: string,
  authConfig: import("./prime-backend.server").PrimeAuthConfig | null,
  origins?: CloneOrigins | null,
): Promise<AuthConfigResult> {
  const patch = buildAuthConfigPatch(authConfig, origins ?? null);
  if (!patch || Object.keys(patch).length === 0) {
    return {
      status: "skipped",
      reason: "no [auth] block in prime config.toml and no clone origins provided",
    };
  }
  try {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/config/auth`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.text();
      return { status: "failed", error: `${res.status} — ${body}` };
    }
    return {
      status: "applied",
      fields: Object.keys(patch),
      siteUrl: patch.site_url,
      redirectCount: patch.uri_allow_list
        ? patch.uri_allow_list.split(",").filter(Boolean).length
        : 0,
    };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── pg_cron replication ─────────────────────────────────────────────

/**
 * A pg_cron job as it lives in the cron.job catalog. `command` is the raw
 * SQL scheduled by cron; for HTTP-triggered jobs it typically contains a
 * `net.http_post(url := '...', ...)` call whose URL points at the origin
 * project's edge functions. When we replay prime migrations onto a clone,
 * pg_cron re-creates those rows verbatim — meaning every clone's schedule
 * would fire against the PRIME's URL until we rewrite them below.
 */
export type PrimeCronJob = {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  database: string;
};

/**
 * Snapshot the prime's cron.job catalog via the Management API SQL runner.
 * Returns an empty list when pg_cron is not installed on the prime (some
 * projects don't enable the extension), so callers can treat this as
 * best-effort.
 */
export async function fetchPrimeCronJobs(primeRef: string): Promise<PrimeCronJob[]> {
  try {
    const rows = (await runSqlOnProject(
      primeRef,
      `select jobid, jobname, schedule, command, active, database
         from cron.job
        order by jobname`,
    )) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => {
        const o = r as Record<string, unknown>;
        return {
          jobid: Number(o.jobid ?? 0),
          jobname: String(o.jobname ?? ""),
          schedule: String(o.schedule ?? ""),
          command: String(o.command ?? ""),
          active: Boolean(o.active ?? true),
          database: String(o.database ?? "postgres"),
        };
      })
      .filter((j) => j.jobname.length > 0);
  } catch {
    // pg_cron not enabled on prime, or catalog not readable — nothing to replicate.
    return [];
  }
}

export type CronJobReplicationResult = {
  jobname: string;
  /**
   * `deferred` is neither done nor failed: the invocation budget ran out
   * before this job was reached. The caller pauses on it so the next tick
   * carries the rest.
   */
  status: "replicated" | "skipped" | "failed" | "deferred" | "already_present";
  rewrote_url: boolean;
  reason?: string;
  error?: string;
};

/**
 * Rewrite any absolute prime project URLs inside a cron command so the
 * scheduled action fires against the clone project instead. Handles both
 * the raw `<ref>.supabase.co` origin and the stable Lovable proxy hosts.
 * Never rewrites tokens/JWTs — those come from Vault per-project.
 */
export function rewriteCronCommand(
  command: string,
  primeRef: string,
  cloneRef: string,
): { command: string; changed: boolean } {
  if (!command) return { command, changed: false };
  const primeHosts = [
    `${primeRef}.supabase.co`,
    `${primeRef}.supabase.in`,
    `${primeRef}.supabase.net`,
  ];
  const cloneHost = `${cloneRef}.supabase.co`;
  let out = command;
  let changed = false;
  for (const h of primeHosts) {
    if (out.includes(h)) {
      out = out.split(h).join(cloneHost);
      changed = true;
    }
  }
  return { command: out, changed };
}

/**
 * Rewrite the prime's anon key to the clone's wherever it is embedded.
 *
 * 22 of this prime's migration files put the prime's anon JWT INLINE in
 * `net.http_post` Authorization headers, across 15 endpoints. Rewriting the
 * host alone leaves a job that posts to the clone carrying a token for the
 * prime, which the clone rejects — a job that looks scheduled and never works.
 */
export function rewriteEmbeddedAnonKey(
  command: string,
  primeAnonKey: string | null | undefined,
  cloneAnonKey: string | null | undefined,
): { command: string; changed: boolean } {
  if (!command || !primeAnonKey || !cloneAnonKey || primeAnonKey === cloneAnonKey) {
    return { command, changed: false };
  }
  if (!command.includes(primeAnonKey)) return { command, changed: false };
  return { command: command.split(primeAnonKey).join(cloneAnonKey), changed: true };
}

/**
 * Seed the clone's own project URL into its vault.
 *
 * Several of the prime's functions read `vault.decrypted_secrets` for
 * `supabase_url` and fall back to a hardcoded prime URL when the lookup finds
 * nothing — which is exactly a fresh clone's state. Seeding this first means
 * the fallback is never reached; rewriting the bodies (below) means it does
 * not matter if it is.
 */
export async function seedCloneVaultUrl(
  cloneRef: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = getProjectUrl(cloneRef);
  try {
    await runSqlOnProject(
      cloneRef,
      `do $seed$
       begin
         if exists (select 1 from vault.decrypted_secrets where name = 'supabase_url') then
           perform vault.update_secret(
             (select id from vault.decrypted_secrets where name = 'supabase_url' limit 1),
             ${sqlLiteral(url)}, 'supabase_url', 'Project base URL');
         else
           perform vault.create_secret(${sqlLiteral(url)}, 'supabase_url', 'Project base URL');
         end if;
       end $seed$;`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type FunctionRepointResult = {
  name: string;
  status: "rewritten" | "failed";
  error?: string;
};

/**
 * Re-point any function body that still names the prime.
 *
 * `replicateCronJobs` fixes `cron.job.command`. It does not reach `pg_proc`,
 * and on this prime four functions carry the prime's URL as a vault FALLBACK:
 * `bootstrap_cron_vault`, `dispatch_web_push_on_notification`,
 * `dispatch_web_push_for_portal_notification` and
 * `invoke_pdf_parse_recover_stuck_jobs`. `bootstrap_cron_vault` is worse than
 * a fallback — it SEEDS the vault with the prime's URL, so calling it on a
 * clone points that clone at the prime for good.
 *
 * Reads each definition with `pg_get_functiondef`, substitutes the ref, and
 * re-creates it. `CREATE OR REPLACE` in the definition makes this idempotent.
 */
export async function repointPrimeUrlsInFunctions(
  cloneRef: string,
  primeRef: string,
  schemas: readonly string[] = ["public", "aml"],
): Promise<FunctionRepointResult[]> {
  const schemaList = schemas.map((s) => sqlLiteral(s)).join(", ");
  let rows: Array<{ name?: string; def?: string }> = [];
  try {
    rows = ((await runSqlOnProject(
      cloneRef,
      `select p.proname as name, pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in (${schemaList})
          and p.prosrc like '%' || ${sqlLiteral(primeRef)} || '%'`,
    )) ?? []) as Array<{ name?: string; def?: string }>;
  } catch (err) {
    return [
      { name: "(scan)", status: "failed", error: err instanceof Error ? err.message : String(err) },
    ];
  }
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const results: FunctionRepointResult[] = [];
  for (const r of rows) {
    const name = String(r?.name ?? "(unknown)");
    const def = String(r?.def ?? "");
    if (!def || !def.includes(primeRef)) continue;
    try {
      await runSqlOnProject(cloneRef, def.split(primeRef).join(cloneRef));
      results.push({ name, status: "rewritten" });
    } catch (err) {
      results.push({
        name,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Replicate the prime's pg_cron schedule onto a freshly provisioned clone.
 * Runs AFTER migration replay (migrations may already have scheduled the
 * same jobs pointing at prime's URL) — so we unschedule and re-schedule
 * every prime job with its command URL-rewritten to the clone origin.
 *
 * Non-fatal per job: any failure is captured in the returned audit list so
 * operators can retry from the clone page. Jobs with no scheduled command
 * (e.g. purely SQL housekeeping like `select expire_stale_reservations()`)
 * are re-scheduled verbatim — they're portable because they only touch
 * local tables and Vault-backed helpers.
 */
export async function replicateCronJobs(
  cloneRef: string,
  primeRef: string,
  primeJobs: PrimeCronJob[],
  /**
   * The two projects' anon keys. Supplied so a job that carries the prime's
   * key inline — 22 of this prime's migrations write one into a net.http_post
   * Authorization header — is rewritten to the clone's rather than left
   * scheduled and permanently rejected. Omit to rewrite the host only.
   */
  keys?: { primeAnonKey?: string | null; cloneAnonKey?: string | null },
  /**
   * Stop between jobs once this passes, marking the rest `deferred`.
   *
   * This prime schedules 47 jobs and each one is a separate Management-API
   * round trip, so the step costs 40-70 seconds against a 50-second
   * invocation budget: it could never finish inside one pass, and it started
   * from the first job every time. Both clones provisioned on 3 Sep 2026 sat
   * on "Replicating pg_cron schedule from prime..." until the stall reclaim
   * took them, over and over — the same closed loop the tables stage had.
   */
  deadlineAt?: number | null,
): Promise<CronJobReplicationResult[]> {
  if (primeJobs.length === 0) return [];
  // Ensure pg_cron exists on the clone. Extension is idempotent.
  try {
    await runSqlOnProject(cloneRef, `create extension if not exists pg_cron;`);
  } catch (err) {
    return primeJobs.map((j) => ({
      jobname: j.jobname,
      status: "failed" as const,
      rewrote_url: false,
      error: `pg_cron unavailable on clone: ${err instanceof Error ? err.message : String(err)}`,
    }));
  }

  // Ask the CLONE what it already schedules — one query for the whole step,
  // against 47 unschedule+reschedule round trips. The target is the authority,
  // never a diary of past runs: this is what turns repeated budgeted passes
  // into compound progress instead of 47 jobs re-done and re-abandoned.
  //
  // A job is left alone only when its schedule AND its rewritten command both
  // already match, so the drift repair this step exists for (22 of this
  // prime's jobs carry an anon key inline that must be rewritten) still runs
  // on anything that does not.
  const existing = new Map<string, { schedule: string; command: string; active: boolean }>();
  try {
    const rows = (await runSqlOnProject(
      cloneRef,
      `select jobname, schedule, command, active from cron.job`,
    )) as Array<{ jobname?: string; schedule?: string; command?: string; active?: boolean }> | null;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (!r?.jobname) continue;
        existing.set(String(r.jobname), {
          schedule: String(r.schedule ?? ""),
          command: String(r.command ?? ""),
          active: r.active !== false,
        });
      }
    }
  } catch {
    // A clone whose schedule cannot be read is treated as holding nothing,
    // which puts every job back on the write path. The fallback does the work
    // rather than assuming it is done.
  }

  const results: CronJobReplicationResult[] = [];
  for (const job of primeJobs) {
    const hostRewrite = rewriteCronCommand(job.command, primeRef, cloneRef);
    const keyRewrite = rewriteEmbeddedAnonKey(
      hostRewrite.command,
      keys?.primeAnonKey,
      keys?.cloneAnonKey,
    );
    const command = keyRewrite.command;
    const changed = hostRewrite.changed || keyRewrite.changed;

    const already = existing.get(job.jobname);
    if (
      already &&
      already.schedule === job.schedule &&
      already.command === command &&
      already.active === job.active
    ) {
      results.push({
        jobname: job.jobname,
        status: "already_present",
        rewrote_url: changed,
        reason: "schedule and command already match",
      });
      continue;
    }

    // Between jobs, never mid-job: an unschedule that lands without its
    // reschedule leaves the clone with the job GONE, which is worse than
    // leaving it stale.
    if (pastDeadline(deadlineAt)) {
      results.push({
        jobname: job.jobname,
        status: "deferred",
        rewrote_url: changed,
        reason: "invocation budget spent — carried to the next pass",
      });
      continue;
    }

    // Escape single quotes for embedding into SQL literals.
    const q = (s: string) => s.replace(/'/g, "''");
    try {
      // Unschedule any existing job with the same name (silently) then re-schedule.
      //
      // A job the prime has DISABLED is scheduled and then deactivated, and
      // how that second step is written decides whether a failure is visible.
      //
      // It used to be `update cron.job set active = false`, a direct write to
      // an extension's catalogue table, in the same multi-statement batch as
      // the schedule — so anything that refused it took the schedule down with
      // it and the job was left ABSENT rather than present-and-active. That is
      // the state measured on 4 Sep 2026: the prime disables exactly two of
      // its 47 jobs, and those two are the only two missing from BOTH
      // engine-provisioned clones, each of which holds 45 jobs and not one
      // inactive. Two of two, twice, independently.
      //
      // `cron.alter_job` is pg_cron's own API for this and is what the direct
      // write should always have been. Two rules go with it. It runs as its
      // own statement, so a failure to deactivate cannot discard a schedule
      // that succeeded. And a failure to deactivate UNSCHEDULES the job again
      // and reports it, because a copy of a job the prime deliberately stopped,
      // left running on a tenant's database, is worse than not having it:
      // silence there is work nobody asked for.
      await runSqlOnProject(
        cloneRef,
        `do $$ begin
           perform cron.unschedule('${q(job.jobname)}');
         exception when others then null; end $$;
         select cron.schedule('${q(job.jobname)}', '${q(job.schedule)}', $cronbody$${command}$cronbody$);`,
      );
      if (!job.active) {
        try {
          await runSqlOnProject(
            cloneRef,
            `select cron.alter_job(jobid, active := false)
               from cron.job where jobname = '${q(job.jobname)}';`,
          );
        } catch (deactivateErr) {
          const why =
            deactivateErr instanceof Error ? deactivateErr.message : String(deactivateErr);
          try {
            await runSqlOnProject(
              cloneRef,
              `do $$ begin
                 perform cron.unschedule('${q(job.jobname)}');
               exception when others then null; end $$;`,
            );
          } catch {
            // Reported below either way; the job's own error is what matters.
          }
          results.push({
            jobname: job.jobname,
            status: "failed",
            rewrote_url: changed,
            error:
              `scheduled, but could not be disabled as the prime has it — withdrawn rather than ` +
              `left running: ${why}`,
          });
          continue;
        }
      }
      results.push({
        jobname: job.jobname,
        status: "replicated",
        rewrote_url: changed,
      });
    } catch (err) {
      results.push({
        jobname: job.jobname,
        status: "failed",
        rewrote_url: changed,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ─── G4: Required extensions + realtime publication parity ───────────
/**
 * The floor: extensions a clone needs even if the prime somehow lacks them.
 * Missing any of these silently breaks cron (pg_cron), webhook fanout and
 * cron http calls (pg_net), Vault-backed cron auth and secret decryption
 * (supabase_vault + pgcrypto), and the GraphQL endpoint some public reads use.
 *
 * THE FLOOR IS NOT THE LIST. It used to be, and a hard-coded list drifts from
 * the prime silently: this one named "vault", which is not an extension —
 * Postgres knows it as `supabase_vault`, so `create extension` failed every
 * time, non-fatally, and clones were provisioned with no vault at all. It also
 * omitted `vector`, which the prime's embedding columns
 * (`agent_semantic_memories`, `document_chunks`) need before any migration
 * that declares one can apply.
 *
 * `resolveRequiredExtensions` unions this with whatever the prime actually
 * has, so the prime is the authority and the floor is only a backstop.
 */
export const REQUIRED_EXTENSION_FLOOR = [
  "pgcrypto",
  "pg_net",
  "pg_cron",
  "pg_graphql",
  "supabase_vault",
] as const;

/** Shipped with every Postgres; `create extension` on it is noise, not safety. */
const EXTENSIONS_ALWAYS_PRESENT = new Set(["plpgsql"]);

/**
 * Quote an extension name for `create extension`. Most are bare identifiers,
 * but `uuid-ossp` contains a hyphen and is a syntax error unquoted — which is
 * the second reason a clone could end up without an extension the prime has.
 */
export function quoteExtensionIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * The extensions to install on a clone: the floor, plus everything the prime
 * runs, minus the ones Postgres ships anyway. Sorted so the result is stable
 * and diffable.
 */
export function resolveRequiredExtensions(primeExtensionNames: readonly string[]): string[] {
  const names = new Set<string>(REQUIRED_EXTENSION_FLOOR);
  for (const n of primeExtensionNames) {
    const trimmed = (n ?? "").trim();
    if (trimmed) names.add(trimmed);
  }
  for (const skip of EXTENSIONS_ALWAYS_PRESENT) names.delete(skip);
  return [...names].sort();
}

/** @deprecated Kept so existing imports resolve; prefer resolveRequiredExtensions(). */
export const REQUIRED_EXTENSIONS = REQUIRED_EXTENSION_FLOOR;

export type RequiredExtensionResult = {
  name: string;
  status: "installed" | "already_present" | "failed";
  error?: string;
};

/** Every extension installed on a project, by name. */
export async function fetchProjectExtensionNames(projectRef: string): Promise<string[]> {
  try {
    const rows = (await runSqlOnProject(
      projectRef,
      `select extname from pg_extension order by extname`,
    )) as Array<{ extname?: string }> | null;
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => String(r?.extname ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Force-install the extension set the clone depends on. Idempotent per
 * extension; non-fatal per extension so operators can retry from the parity
 * report.
 *
 * Pass the prime's ref to mirror its extensions. Without it only the floor is
 * installed, which is the old behaviour and is not enough for this prime.
 *
 * Asks the clone what it already holds ONCE, and issues `create extension`
 * only for what is missing. The first version probed and then created per
 * extension — two serial Management-API round trips each, on every pass,
 * whether or not anything was absent. This step runs before the schema build
 * (see its call site for why it has to), so that cost came out of the same
 * 50-second invocation budget the build spends: measured on the 1 Sep 2026
 * dry run it was ~30 seconds of every pass on a clone where all twelve
 * extensions had been installed on the first one, leaving the build under
 * half a budget to make progress in.
 *
 * Same class of fault as the schema stages that never asked whether they were
 * already done — verifying a built thing must not cost what building it did.
 *
 * A clone whose extension list cannot be read reports none, which puts every
 * extension back on the create path: the fallback does the work rather than
 * assuming it is done.
 */
export async function enforceRequiredExtensions(
  projectRef: string,
  primeRef?: string | null,
): Promise<RequiredExtensionResult[]> {
  const [primeNames, cloneNames] = await Promise.all([
    primeRef ? fetchProjectExtensionNames(primeRef) : Promise.resolve<string[]>([]),
    fetchProjectExtensionNames(projectRef),
  ]);
  const wanted = resolveRequiredExtensions(primeNames);
  const present = new Set(cloneNames);
  const results: RequiredExtensionResult[] = [];
  for (const name of wanted) {
    if (present.has(name)) {
      results.push({ name, status: "already_present" });
      continue;
    }
    try {
      await runSqlOnProject(
        projectRef,
        `create extension if not exists ${quoteExtensionIdent(name)};`,
      );
      results.push({ name, status: "installed" });
    } catch (err) {
      results.push({
        name,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export type RealtimePublicationTable = { schema: string; table: string };

/**
 * List the tables currently published on `supabase_realtime`. Realtime
 * subscriptions only fire for members of this publication, so a clone that
 * inherits the schema but not membership silently drops every channel.
 */
export async function fetchRealtimePublicationTables(
  projectRef: string,
): Promise<RealtimePublicationTable[]> {
  try {
    const rows = (await runSqlOnProject(
      projectRef,
      `select schemaname as schema, tablename as "table"
         from pg_publication_tables
        where pubname = 'supabase_realtime'
        order by schemaname, tablename`,
    )) as Array<RealtimePublicationTable> | null;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export type RealtimeReplicationResult = {
  status: "replicated" | "partial" | "skipped" | "failed";
  added: RealtimePublicationTable[];
  /** Already on the clone's publication — no round trip spent. */
  alreadyPublished: RealtimePublicationTable[];
  /** Not reached before the invocation budget ran out. Neither done nor failed. */
  deferred: RealtimePublicationTable[];
  failures: Array<RealtimePublicationTable & { error: string }>;
  error?: string;
};

/**
 * Ensure `supabase_realtime` exists on the clone and add every table prime
 * publishes. Also sets `replica identity full` so payloads carry the full row.
 */
export async function replicateRealtimePublication(
  cloneRef: string,
  primeTables: RealtimePublicationTable[],
  /**
   * Stop between tables once this passes, deferring the rest.
   *
   * One Management-API round trip per table, and this prime publishes 95 of
   * them — ~75 seconds against a 50-second invocation budget. The step was
   * guarded in FRONT (a pass with no budget declined to start it) and nowhere
   * inside, so a pass that did start it was killed: a 15-minute stall reclaim
   * and an attempt, where a pause costs 60 seconds. Measured on the Preflight
   * clone, 3 Sep 2026: 22 of the prime's 95 tables published, the worker dead
   * on the step.
   */
  deadlineAt?: number | null,
): Promise<RealtimeReplicationResult> {
  if (primeTables.length === 0) {
    return { status: "skipped", added: [], alreadyPublished: [], deferred: [], failures: [] };
  }
  try {
    await runSqlOnProject(
      cloneRef,
      `do $$ begin
         if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
           create publication supabase_realtime;
         end if;
       end $$;`,
    );
  } catch (err) {
    return {
      status: "failed",
      added: [],
      alreadyPublished: [],
      deferred: [],
      failures: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Ask the clone what it already publishes — one query against 95 round
  // trips. The target is the authority, never a diary: this is what turns
  // repeated budgeted passes into compound progress instead of the same
  // prefix re-added and re-abandoned.
  //
  // A publication membership carries no attributes to drift, so unlike a cron
  // job "present" really is "done" here. A clone whose publication cannot be
  // read reports nothing, which puts every table back on the write path.
  const publishedOnClone = new Set(
    (await fetchRealtimePublicationTables(cloneRef)).map((t) => `${t.schema}.${t.table}`),
  );

  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const added: RealtimePublicationTable[] = [];
  const alreadyPublished: RealtimePublicationTable[] = [];
  const deferred: RealtimePublicationTable[] = [];
  const failures: Array<RealtimePublicationTable & { error: string }> = [];
  for (const t of primeTables) {
    if (publishedOnClone.has(`${t.schema}.${t.table}`)) {
      alreadyPublished.push(t);
      continue;
    }
    if (pastDeadline(deadlineAt)) {
      deferred.push(t);
      continue;
    }
    const fq = `${q(t.schema)}.${q(t.table)}`;
    try {
      await runSqlOnProject(
        cloneRef,
        `do $$ begin
           begin
             alter table ${fq} replica identity full;
           exception when others then null; end;
           begin
             alter publication supabase_realtime add table ${fq};
           exception when duplicate_object then null;
                    when undefined_table then raise;
           end;
         end $$;`,
      );
      added.push(t);
    } catch (err) {
      failures.push({ ...t, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    // A deferral is not a failure, but it is not "replicated" either: the
    // publication is incomplete until the next pass carries the rest.
    status:
      failures.length > 0
        ? added.length > 0 || alreadyPublished.length > 0
          ? "partial"
          : "failed"
        : deferred.length > 0
          ? "partial"
          : "replicated",
    added,
    alreadyPublished,
    deferred,
    failures,
  };
}

/**
 * Every clone backend carries its own migration ledger so replays are
 * idempotent and resumable.
 *
 * Issue #14: we now write to Supabase's canonical
 * `supabase_migrations.schema_migrations` table (matching the Supabase CLI /
 * dashboard convention) instead of only a Lovable-invented
 * `aurixa.schema_migrations` ledger. That way if an operator later connects
 * the clone project to the Supabase CLI (`supabase db push`), the CLI
 * recognises the applied versions and does not attempt to re-run them.
 *
 * We still write to (and read from) `aurixa.schema_migrations` so clones
 * provisioned before this change stay idempotent — any version recorded in
 * either ledger is treated as applied.
 */
const TRACKING_TABLE_SQL = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
-- Legacy Lovable-only ledger, kept as a mirror for older tooling / health
-- checks and for clones provisioned before Issue #14.
create schema if not exists aurixa;
create table if not exists aurixa.schema_migrations (
  version text primary key,
  name text not null,
  applied_at timestamptz not null default now()
);
`.trim();

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Count tables in the schemas a clone replicates. Used only to tell a fresh
 * project apart from one whose schema exists but whose ledger is empty — the
 * two are identical from the ledger's point of view and need opposite
 * treatment.
 */
async function countReplicatedTables(projectRef: string): Promise<number> {
  try {
    const raw = await runSqlOnProject(
      projectRef,
      `select count(*)::int as n from pg_tables where schemaname in ('public', 'aml');`,
    );
    const rows = Array.isArray(raw) ? raw : [];
    const n = (rows[0] as { n?: unknown } | undefined)?.n;
    return typeof n === "number" ? n : Number(n ?? 0) || 0;
  } catch {
    // A project we cannot read is not a project we can judge. Returning 0 lets
    // the replay proceed exactly as it did before this check existed, which is
    // the right failure mode for a check whose only job is to refuse earlier.
    return 0;
  }
}

export type PrimeMigrationResult = {
  id: string;
  name: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
  /**
   * Set when this version was runnable but sits behind a corpus version the
   * clone does not have and this run will not send. It is NOT applied. Names
   * the first few holes so an operator sees what to reconcile rather than a
   * bare "skipped". See `partitionByDependency`.
   */
  blockedBy?: string[];
};

/**
 * Replay the prime's migrations onto a clone project, in order, skipping
 * any version already recorded in the clone's ledger. Stops on the first
 * failure so later migrations never run against a half-applied schema.
 */
export async function applyPrimeMigrations(
  projectRef: string,
  migrations: ReadonlyArray<{ id: string; name: string; sql?: string }>,
  onStatusUpdate?: (status: string, detail: string) => Promise<void>,
  /**
   * Resolve a migration's SQL when the caller did not materialise it.
   *
   * The fleet sync passes metadata only and this resolver, so a body is
   * fetched from GitHub exactly when a clone turns out to be missing that
   * version — never for the ones it already has. Callers that already hold the
   * SQL (provisioning replays a snapshot it just downloaded) pass it on the
   * item and never reach this.
   */
  loadSql?: (m: { id: string; name: string }) => Promise<string>,
  /**
   * Supplied by the SCOPED callers (the fleet sync and the per-clone sync
   * button), which hand `migrations` already narrowed to what the prime's
   * ledger records. Narrowing produces a SET, and a set cannot say whether a
   * cleared version sits behind a withheld one — which is how a clone came to
   * run `builder_stock_ladder_generation` without the migration that defines
   * the function it calls. With this present the replay additionally refuses
   * to step over a hole.
   *
   * Provisioning's own replay passes nothing: it is unscoped by construction
   * (it replays the snapshot it just downloaded), so every predecessor is
   * present and there is no hole to step over.
   */
  scope?: {
    /** The whole corpus, in corpus order — including what was withheld. */
    corpus: ReadonlyArray<{ id: string; name: string }>;
    /** Ids the scope cleared. */
    runnableIds: ReadonlySet<string>;
  },
  /**
   * Stop BETWEEN migrations once the caller's invocation budget is spent.
   *
   * Supplied by the self-healing `sql_migration` lane, which runs inside a
   * bounded invocation: a replay that outlives it is killed mid-loop, its row
   * sits in `executing` until the stall reclaim requeues it twenty minutes
   * later, and every pass starts the whole replay again. The first migration
   * of a pass is always attempted, so a deadline that is already past when
   * the loop starts still moves the clone forward by one; the check runs
   * only before a migration that would actually be SENT, never before one
   * that is merely skipped as applied. The check is handed the slowest
   * migration this pass has applied, so the caller can refuse to START one
   * it may not live to finish. A pass that stops here reports `stoppedEarly`
   * so the caller can requeue rather than pronounce the clone level.
   */
  budget?: { isPastDeadline: (reserveMs: number) => boolean },
  /**
   * What to do with a body the corpus refuses for its size.
   *
   * The template-library seed is one 39 MB INSERT; `loadSql` throws
   * `OversizedMigrationError` rather than hold it. With this supplied the
   * replay streams that migration through `seedChunking.pure.ts` and sends it
   * as statements the API will take, each carrying the file's own ON CONFLICT
   * clause. The cursor makes a budgeted pass RESUME: statement boundaries are
   * deterministic for a given file and budget, so "the first N are done" is a
   * fact the next pass can act on rather than re-sending thirty statements it
   * already sent. Without this, an oversized body fails the migration exactly
   * as before.
   */
  oversize?: OversizeApplyOptions,
): Promise<{
  results: PrimeMigrationResult[];
  latestApplied: string | null;
  /** True when the budget stopped the loop with migrations still unsent. */
  stoppedEarly: boolean;
  /** Chunked statements sent this pass, for a caller deciding whether it progressed. */
  chunksApplied: number;
  /** Where a chunked migration stopped, when the budget stopped it mid-way. */
  chunkCursor: ChunkCursor | null;
}> {
  await runSqlOnProject(projectRef, TRACKING_TABLE_SQL);

  // Union both the canonical Supabase ledger and the legacy aurixa ledger,
  // so a clone that was partially applied under either scheme stays
  // idempotent. (Issue #14.)
  const appliedRaw = await runSqlOnProject(
    projectRef,
    `select version from supabase_migrations.schema_migrations
     union
     select version from aurixa.schema_migrations;`,
  );
  // The query endpoint returns rows as a bare array; tolerate wrapped shapes too.
  const appliedRows = Array.isArray(appliedRaw)
    ? appliedRaw
    : Array.isArray((appliedRaw as { rows?: unknown[] })?.rows)
      ? (appliedRaw as { rows: unknown[] }).rows
      : Array.isArray((appliedRaw as { result?: unknown[] })?.result)
        ? (appliedRaw as { result: unknown[] }).result
        : [];
  const applied = new Set(
    appliedRows
      .map((r) => (r as { version?: unknown })?.version)
      .filter((v): v is string => typeof v === "string"),
  );

  // Pre-flight: refuse a replay that cannot succeed, rather than starting one
  // that halts on migration #1 and reports the migration as the fault.
  const cloneTableCount = await countReplicatedTables(projectRef);
  const assessment = assessLedgerState({
    appliedVersions: [...applied],
    corpusVersions: migrations.map((m) => m.id),
    cloneTableCount,
  });
  const refusal = ledgerRepairHint(assessment);
  if (refusal) throw new Error(refusal);

  const results: PrimeMigrationResult[] = [];
  let latestApplied: string | null = null;

  // A scoped caller's list is a SET of cleared versions; the corpus is a
  // SEQUENCE. Refuse to send anything sitting behind a version this clone does
  // not have and this run will not send — and SKIP it rather than halting,
  // because halting here is what left a 546-table clone with no admin user.
  let sendable: ReadonlyArray<{ id: string; name: string; sql?: string }> = migrations;
  if (scope) {
    const { partitionByDependency } = await import("./fleetCorpusScope.pure");
    const part = partitionByDependency(scope.corpus, scope.runnableIds, applied);
    const sendableIds = new Set(part.send.map((m) => m.id));
    sendable = migrations.filter((m) => sendableIds.has(m.id));
    for (const o of part.orphaned) {
      results.push({
        id: o.meta.id,
        name: o.meta.name,
        success: true,
        skipped: true,
        blockedBy: o.blockedBy,
      });
    }
  }

  const ordered = [...sendable].sort((a, b) => a.name.localeCompare(b.name));
  let attempted = 0;
  let slowestMs = 0;
  let stoppedEarly = false;
  let chunksApplied = 0;
  let chunkCursor: ChunkCursor | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i];
    if (applied.has(m.id)) {
      results.push({ id: m.id, name: m.name, success: true, skipped: true });
      latestApplied = m.id;
      continue;
    }
    // Asked only here — before a migration that would be sent — and never
    // before the first, so a pass that arrives with no budget left still
    // lands one rather than none. Stopping between migrations leaves the
    // ledger consistent; stopping inside one is what the budget prevents.
    if (attempted > 0 && budget?.isPastDeadline(slowestMs)) {
      stoppedEarly = true;
      break;
    }
    attempted += 1;
    const startedAt = Date.now();
    await onStatusUpdate?.("migrating", `Applying migration ${i + 1}/${ordered.length}: ${m.name}`);
    try {
      // Resolved here, inside the loop and after the `applied` check above, so
      // a clone that is level pays for no bodies at all. A migration with
      // neither an inline body nor a resolver is a programming error rather
      // than a migration failure, but it is reported through the same channel
      // so it lands in `migrations_applied` where an operator will see it.
      let sql: string | undefined;
      let sentInChunks = false;
      try {
        sql = m.sql ?? (loadSql ? await loadSql({ id: m.id, name: m.name }) : undefined);
      } catch (e) {
        if (!(e instanceof OversizedMigrationError) || !oversize) throw e;
        // Too big to hold, not too big to send: streamed and chunked. A pass
        // the budget stops inside the seed leaves a cursor and reports
        // `stoppedEarly`; the ledger row is written only once every
        // statement has gone, so a half-sent seed is never "applied".
        const chunked = await applyChunkedSeed(projectRef, m, oversize, budget);
        chunksApplied += chunked.applied;
        if (chunked.stoppedEarly) {
          chunkCursor = chunked.cursor;
          stoppedEarly = true;
          break;
        }
        sentInChunks = true;
      }
      if (!sentInChunks) {
        if (sql === undefined) {
          throw new Error(`No SQL available for migration ${m.name} and no loader was provided`);
        }
        await runSqlOnProject(projectRef, sql);
      }
      // Record in BOTH ledgers: canonical Supabase table is the source of
      // truth going forward, aurixa is kept as a mirror so older tooling /
      // health checks keep working. (Issue #14.)
      await runSqlOnProject(
        projectRef,
        `insert into supabase_migrations.schema_migrations (version, name, statements)
           values (${sqlLiteral(m.id)}, ${sqlLiteral(m.name)}, ARRAY[]::text[])
           on conflict (version) do nothing;
         insert into aurixa.schema_migrations (version, name)
           values (${sqlLiteral(m.id)}, ${sqlLiteral(m.name)})
           on conflict (version) do nothing;`,
      );
      results.push({ id: m.id, name: m.name, success: true });
      latestApplied = m.id;
      slowestMs = Math.max(slowestMs, Date.now() - startedAt);
    } catch (e) {
      results.push({
        id: m.id,
        name: m.name,
        success: false,
        error: e instanceof Error ? e.message : "SQL failed",
      });
      break; // halt replay — schema state beyond this point is undefined
    }
  }

  return { results, latestApplied, stoppedEarly, chunksApplied, chunkCursor };
}

/** Where a chunked seed stopped: the next pass skips this many statements. */
export type ChunkCursor = { migrationId: string; statementsDone: number };

export type OversizeApplyOptions = {
  /** Open the migration's body as a stream. Called twice per seed (two passes). */
  streamSql: (m: { id: string; name: string }) => Promise<AsyncIterable<string>>;
  /** Largest statement to send. Default `DEFAULT_SEED_STATEMENT_BYTES`. */
  maxStatementBytes?: number;
  /** Where the previous pass stopped, if it stopped inside this migration. */
  cursor?: ChunkCursor | null;
  /** Called after every statement lands, so the run's heartbeat carries the cursor. */
  onStatementDone?: (progress: {
    migrationId: string;
    name: string;
    statementsDone: number;
    label: string;
  }) => Promise<void>;
};

/**
 * One megabyte a statement. The prime's own workflow sends ten rows a
 * statement and measured its largest at ~1.1 MB; the rows vary by an order of
 * magnitude in size, so the budget is bytes rather than rows.
 */
export const DEFAULT_SEED_STATEMENT_BYTES = 1_000_000;

async function applyChunkedSeed(
  projectRef: string,
  m: { id: string; name: string },
  oversize: OversizeApplyOptions,
  budget?: { isPastDeadline: (reserveMs: number) => boolean },
): Promise<{ applied: number; stoppedEarly: boolean; cursor: ChunkCursor | null }> {
  const { readSeedShape, chunkSeedStatements, SeedShapeError } =
    await import("./seedChunking.pure");
  const maxStatementBytes = oversize.maxStatementBytes ?? DEFAULT_SEED_STATEMENT_BYTES;
  const skip = oversize.cursor?.migrationId === m.id ? oversize.cursor.statementsDone : 0;
  let index = 0;
  let applied = 0;
  let slowestMs = 0;
  try {
    const shape = await readSeedShape(await oversize.streamSql(m));
    for await (const stmt of chunkSeedStatements(await oversize.streamSql(m), shape, {
      maxStatementBytes,
    })) {
      if (index < skip) {
        index += 1;
        continue;
      }
      // At least one statement a pass, so a pass never comes back with the
      // cursor where it found it.
      if (applied > 0 && budget?.isPastDeadline(slowestMs)) {
        return {
          applied,
          stoppedEarly: true,
          cursor: { migrationId: m.id, statementsDone: index },
        };
      }
      const startedAt = Date.now();
      await runSqlOnProject(projectRef, stmt.sql);
      index += 1;
      applied += 1;
      slowestMs = Math.max(slowestMs, Date.now() - startedAt);
      await oversize.onStatementDone?.({
        migrationId: m.id,
        name: m.name,
        statementsDone: index,
        label: stmt.label,
      });
    }
  } catch (e) {
    if (e instanceof SeedShapeError) {
      throw new Error(
        `${m.name} is past the size ceiling and is not a seed-shaped INSERT this replay can chunk ` +
          `(${e.message}). Apply it to this clone by hand (psql or the SQL editor), record its ` +
          "version in supabase_migrations.schema_migrations, then re-run the sync.",
      );
    }
    throw e;
  }
  return { applied, stoppedEarly: false, cursor: null };
}

// ─── Module Migrations ───────────────────────────────────────────────

/**
 * Per-clone ledger for module-level migrations. Kept in the `aurixa` schema
 * alongside `schema_migrations` so the replicated `public` schema stays
 * byte-identical to the prime's.
 */
const MODULE_TRACKING_TABLE_SQL = `
create schema if not exists aurixa;
create table if not exists aurixa.module_installations (
  module_id text primary key,
  name text not null,
  applied_at timestamptz not null default now()
);
`.trim();

export type ModuleMigrationInput = {
  id: string;
  name: string;
  sql: string;
  dependencies: string[];
  applyOnInstall: boolean;
};

export type ModuleMigrationResult = {
  id: string;
  name: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
};

/**
 * Topologically sort modules by `dependencies` (edges from dep -> module).
 * Returns { ordered, cycle, missingDeps } — modules involved in a cycle or
 * missing a dep are excluded from `ordered` and reported so the caller can
 * mark them failed without attempting SQL.
 */
export function topoSortModules(modules: ModuleMigrationInput[]): {
  ordered: ModuleMigrationInput[];
  cycleIds: Set<string>;
  missingDeps: Map<string, string[]>;
} {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const missingDeps = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>(); // dep -> [dependents]

  for (const m of modules) {
    indegree.set(m.id, 0);
    edges.set(m.id, []);
  }
  for (const m of modules) {
    const missing: string[] = [];
    for (const dep of m.dependencies ?? []) {
      if (!byId.has(dep)) {
        missing.push(dep);
        continue;
      }
      edges.get(dep)!.push(m.id);
      indegree.set(m.id, (indegree.get(m.id) ?? 0) + 1);
    }
    if (missing.length > 0) missingDeps.set(m.id, missing);
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  // Stable order: sort ready set by name so replays are deterministic.
  queue.sort((a, b) => byId.get(a)!.name.localeCompare(byId.get(b)!.name));

  const ordered: ModuleMigrationInput[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    const next: string[] = [];
    for (const dependent of edges.get(id) ?? []) {
      indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
      if (indegree.get(dependent) === 0) next.push(dependent);
    }
    next.sort((a, b) => byId.get(a)!.name.localeCompare(byId.get(b)!.name));
    queue.push(...next);
  }

  const cycleIds = new Set<string>();
  for (const [id, deg] of indegree) {
    if (deg > 0 && !ordered.find((m) => m.id === id)) cycleIds.add(id);
  }

  return { ordered, cycleIds, missingDeps };
}

/**
 * Apply per-module SQL to a clone project in dependency order. Each module's
 * SQL is wrapped in a transaction alongside its ledger insert so a failure
 * leaves the schema untouched. Modules whose dependencies failed (or that
 * are part of a cycle / missing deps) are skipped rather than run against a
 * half-applied schema.
 */
export async function applyModuleMigrations(
  projectRef: string,
  modules: ModuleMigrationInput[],
  onStatusUpdate?: (status: string, detail: string) => Promise<void>,
): Promise<ModuleMigrationResult[]> {
  const eligible = modules.filter((m) => m.applyOnInstall !== false && m.sql.trim().length > 0);
  if (eligible.length === 0) return [];

  await runSqlOnProject(projectRef, MODULE_TRACKING_TABLE_SQL);

  const appliedRaw = await runSqlOnProject(
    projectRef,
    "select module_id from aurixa.module_installations;",
  );
  const appliedRows = Array.isArray(appliedRaw)
    ? appliedRaw
    : Array.isArray((appliedRaw as { rows?: unknown[] })?.rows)
      ? (appliedRaw as { rows: unknown[] }).rows
      : Array.isArray((appliedRaw as { result?: unknown[] })?.result)
        ? (appliedRaw as { result: unknown[] }).result
        : [];
  const alreadyApplied = new Set(
    appliedRows
      .map((r) => (r as { module_id?: unknown })?.module_id)
      .filter((v): v is string => typeof v === "string"),
  );

  const { ordered, cycleIds, missingDeps } = topoSortModules(eligible);
  const results: ModuleMigrationResult[] = [];
  const failed = new Set<string>();

  // Report modules excluded from `ordered` up front.
  for (const m of eligible) {
    if (missingDeps.has(m.id)) {
      const missing = missingDeps.get(m.id)!;
      results.push({
        id: m.id,
        name: m.name,
        ok: false,
        error: `Missing dependencies (not selected/available): ${missing.join(", ")}`,
      });
      failed.add(m.id);
    } else if (cycleIds.has(m.id)) {
      results.push({
        id: m.id,
        name: m.name,
        ok: false,
        error: "Dependency cycle — cannot determine install order",
      });
      failed.add(m.id);
    }
  }

  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i];
    if (failed.has(m.id)) continue;

    if (alreadyApplied.has(m.id)) {
      results.push({ id: m.id, name: m.name, ok: true, skipped: true });
      continue;
    }

    const depFailed = (m.dependencies ?? []).find((d) => failed.has(d));
    if (depFailed) {
      results.push({
        id: m.id,
        name: m.name,
        ok: false,
        error: `Skipped — dependency failed: ${depFailed}`,
      });
      failed.add(m.id);
      continue;
    }

    await onStatusUpdate?.("migrating", `Applying module ${i + 1}/${ordered.length}: ${m.name}`);

    // Wrap the module's SQL + ledger insert in a single transaction so a
    // partial failure rolls back cleanly.
    const wrapped = `begin;\n${m.sql}\n;insert into aurixa.module_installations (module_id, name) values (${sqlLiteral(
      m.id,
    )}, ${sqlLiteral(m.name)}) on conflict (module_id) do nothing;\ncommit;`;

    try {
      await runSqlOnProject(projectRef, wrapped);
      results.push({ id: m.id, name: m.name, ok: true });
    } catch (e) {
      // Best-effort rollback — Supabase Management API auto-aborts the
      // transaction on error, but we send an explicit rollback in case a
      // trailing statement left an open txn state on some paths.
      try {
        await runSqlOnProject(projectRef, "rollback;");
      } catch {
        /* ignore */
      }
      results.push({
        id: m.id,
        name: m.name,
        ok: false,
        error: e instanceof Error ? e.message : "SQL failed",
      });
      failed.add(m.id);
    }
  }

  return results;
}

/**
 * The bundle shape `deployEdgeFunction` accepts.
 *
 * Named so a caller that passes bundles through — the self-healing lane's
 * budgeted loop — can be typed rather than reaching for `any`.
 */
export type EdgeFunctionBundle = Parameters<typeof deployEdgeFunction>[1];

export type EdgeFunctionDeployResult = {
  slug: string;
  success: boolean;
  error?: string;
  /** The verify_jwt flag actually deployed to the clone (may differ from the
   *  prime's flag when Issue #15's anonymous-webhook heuristic overrides it). */
  verifyJwt?: boolean;
  /** Non-null when the deployed flag was auto-corrected away from the prime's;
   *  explains why so operators can audit the decision. */
  verifyJwtOverrideReason?: string;
  /** True when a RESUMED run found the function already on the project and
   *  did not redeploy it. The live project is the authority on what it holds
   *  (asked, never diaried), so the parity check still measures the truth. */
  skipped?: boolean;
};

/**
 * Issue #15: Prime's `verify_jwt` flag is snapshot verbatim, but a clone's
 * JWT audience differs from the prime's — an edge function shipped with
 * `verify_jwt=true` on the prime will 401 external callers hitting the
 * clone's URL because their token was minted against a different project.
 *
 * Any function that is intended to be reached anonymously (webhooks,
 * public hooks, cron callbacks, health probes) MUST be deployed with
 * `verify_jwt=false` on every clone regardless of the prime's setting.
 * We detect those by slug convention: it is the same convention used by
 * `/api/public/*` server routes and by Supabase's own function templates.
 */
const ANON_FUNCTION_SLUG_PATTERNS: RegExp[] = [
  /^hooks?[-_]/i, // hook-*, hooks-*
  /^webhooks?[-_]?/i, // webhook*, webhooks-*
  /[-_]webhooks?$/i, // *-webhook, *-webhooks
  /^public[-_]/i, // public-*
  /^cron[-_]/i, // cron-*
  /^health(check)?$/i, // health, healthcheck
  /^stripe[-_]webhook/i,
  /^github[-_]webhook/i,
];

export function shouldForceAnonymousFunction(slug: string): boolean {
  return ANON_FUNCTION_SLUG_PATTERNS.some((rx) => rx.test(slug));
}

/**
 * Deploy one edge function bundle to a clone project via the Management API.
 * File paths are relative to the prime's supabase/functions/ directory, so
 * `../_shared/x.ts`-style imports inside a function resolve within the bundle.
 */
export async function deployEdgeFunction(
  projectRef: string,
  fn: {
    slug: string;
    entrypointPath: string;
    importMapPath: string | null;
    verifyJwt: boolean;
    files: Array<{ path: string; contentBase64: string }>;
  },
): Promise<{ verifyJwt: boolean; overrideReason: string | null }> {
  // Issue #15: force anonymous for webhook-style slugs regardless of the
  // prime's flag, so external callers minted against the prime's audience
  // (or unauthenticated altogether) still reach the clone's endpoint.
  const forceAnon = shouldForceAnonymousFunction(fn.slug) && fn.verifyJwt === true;
  const effectiveVerifyJwt = forceAnon ? false : fn.verifyJwt;
  const overrideReason = forceAnon
    ? `slug "${fn.slug}" matches an anonymous-webhook pattern; prime had verify_jwt=true, deployed as false on this clone`
    : null;

  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({
      name: fn.slug,
      entrypoint_path: fn.entrypointPath,
      ...(fn.importMapPath ? { import_map_path: fn.importMapPath } : {}),
      verify_jwt: effectiveVerifyJwt,
    }),
  );
  for (const file of fn.files) {
    const bytes = Buffer.from(file.contentBase64, "base64");
    form.append("file", new Blob([new Uint8Array(bytes)]), file.path);
  }

  const res = await fetch(
    `${MGMT_API}/projects/${projectRef}/functions/deploy?slug=${encodeURIComponent(fn.slug)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${getMgmtToken()}` }, // FormData sets its own Content-Type
      body: form,
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deploy failed for ${fn.slug}: ${res.status} — ${body}`);
  }
  return { verifyJwt: effectiveVerifyJwt, overrideReason };
}

export async function deployEdgeFunctions(
  projectRef: string,
  functions: Array<Parameters<typeof deployEdgeFunction>[1]>,
  onStatusUpdate?: (status: string, detail: string) => Promise<void>,
  deadlineAt?: number | null,
): Promise<EdgeFunctionDeployResult[]> {
  const results: EdgeFunctionDeployResult[] = [];
  for (let i = 0; i < functions.length; i++) {
    // Hundreds of functions × one Management API call each is the longest
    // stage in the pipeline, so the invocation budget is checked between
    // deploys. Pausing throws away this pass's partial `results` on purpose:
    // the resumed run asks the project which slugs it already holds and skips
    // them, so the record is recovered from the target rather than a diary.
    if (i > 0 && pastDeadline(deadlineAt)) {
      throw new BudgetPause(
        `deployed ${i}/${functions.length} edge functions this pass — the rest resume next tick`,
      );
    }
    const fn = functions[i];
    await onStatusUpdate?.(
      "migrating",
      `Deploying edge function ${i + 1}/${functions.length}: ${fn.slug}`,
    );
    try {
      const { verifyJwt, overrideReason } = await deployEdgeFunction(projectRef, fn);
      results.push({
        slug: fn.slug,
        success: true,
        verifyJwt,
        ...(overrideReason ? { verifyJwtOverrideReason: overrideReason } : {}),
      });
    } catch (e) {
      // Non-fatal: record and continue so one broken function doesn't block the rest
      results.push({
        slug: fn.slug,
        success: false,
        error: e instanceof Error ? e.message : "deploy failed",
      });
    }
  }
  return results;
}

export type SecretShellStatus =
  | "set"
  | "missing"
  | "failed"
  | "inherited"
  /** Freshly generated on the clone — an identity secret, never copied. */
  | "generated"
  /** Platform-managed (SUPABASE_*); Supabase injects its own. */
  | "skipped_platform"
  /** Names the prime's own domain; the clone supplies its own. */
  | "skipped_deployment_config"
  /** Deployment config Mission Control can compute for THIS clone. */
  | "derived"
  /**
   * A per-tenant vendor credential that must be MINTED for this clone, never
   * copied from the prime (see TENANT_SCOPED_SECRETS). Left unset here; the
   * clone's own identity flow writes it.
   */
  | "tenant_scoped_pending";

export type SecretShellResult = {
  name: string;
  status: SecretShellStatus;
  success: boolean;
  error?: string;
};

/**
 * Sync secrets onto a freshly-provisioned clone project.
 *
 * For each name the prime's edge functions reference we either:
 *   - forward a real value from the prime's own env (when the operator marked
 *     the name inheritable in `prime_secret_forwards`), so the clone's
 *     functions can boot without 500s, OR
 *   - leave the secret unset on the clone and record it as `missing` so the
 *     operator UI can prompt for a value.
 *
 * We NEVER write a placeholder onto the clone — that value made every consumer
 * (Stripe, Lovable AI, VAPID, GitHub) fail at first call.
 */
/**
 * Decide what value each shelled secret should carry on the clone.
 *
 * Pure so the classification is testable without the Management API. The
 * caller supplies the random generator, so a test can assert "not the prime's
 * value" without asserting a particular one.
 *
 * - **identity** secrets are GENERATED, never inherited. Copying
 *   `INTERNAL_EDGE_SECRET` makes a request signed for one deployment valid on
 *   the other; see IDENTITY_SECRETS.
 * - **deployment_config** is skipped, because the prime's value names the
 *   prime's own domain — EXCEPT the handful in `DERIVED_DEPLOYMENT_CONFIG`,
 *   whose value Mission Control can compute for this clone from `origins`.
 *   `ALLOWED_ORIGINS` is one: this comment used to claim `applyAuthConfig`
 *   covered it, and `applyAuthConfig` patches GoTrue's `/config/auth` while
 *   `ALLOWED_ORIGINS` is an edge-function environment variable. Nothing wrote
 *   it, every clone fell back to the prime's hostnames, and sign-in on a clone
 *   failed CORS with the credentials correct. An operator fills the rest in
 *   from the clone page.
 * - **platform** never reaches this function (extractSecretNames drops it),
 *   but is refused here too so a hand-built name list cannot slip one past.
 * - **vendor** credentials are inherited — that is the forwarded-key model.
 */
export function planCloneSecrets(
  names: string[],
  inheritedValues: Record<string, string>,
  generate: () => string,
  origins?: CloneOrigins | null,
  dedicatedNames?: ReadonlySet<string>,
  /**
   * Values that belong to THIS clone — never the prime's. The only source for
   * a tenant-scoped name that Mission Control can supply itself: today the
   * project's own `jwt_secret`, captured from the create response.
   */
  selfValues?: Record<string, string>,
): { toWrite: { name: string; value: string }[]; results: Map<string, SecretShellResult> } {
  const toWrite: { name: string; value: string }[] = [];
  const results = new Map<string, SecretShellResult>();

  for (const name of names) {
    // A name the clone holds a dedicated credential for is never inherited —
    // see `dedicatedSecretNames` on the provisioning input. `missing` is
    // honest for a fresh backend: the dedicated token cannot be read back, so
    // the operator re-mints it (key rotation on the email identity panel).
    if (dedicatedNames?.has(name)) {
      results.set(name, { name, status: "missing", success: true });
      continue;
    }
    const kind = classifySecret(name);

    if (kind === "platform") {
      results.set(name, { name, status: "skipped_platform", success: true });
      continue;
    }
    if (kind === "identity") {
      toWrite.push({ name, value: generate() });
      results.set(name, { name, status: "generated", success: true });
      continue;
    }
    if (kind === "tenant_scoped") {
      // Never INHERITED, whatever `prime_secret_forwards` says: sharing the
      // prime's value is the cross-tenant defect this class exists to stop.
      // A value of the clone's OWN is a different thing entirely, and is
      // exactly what should be written.
      const own = selfValues?.[name];
      if (typeof own === "string" && own.length > 0) {
        toWrite.push({ name, value: own });
        results.set(name, { name, status: "derived", success: true });
        continue;
      }
      results.set(name, {
        name,
        status: "tenant_scoped_pending",
        success: true,
        error:
          `${name} is per-tenant and is never copied from the prime. ` +
          (TENANT_SCOPED_REMEDY[name] ?? "Set this clone's own value before handover."),
      });
      continue;
    }
    if (kind === "deployment_config") {
      const derive = DERIVED_DEPLOYMENT_CONFIG[name];
      const derived = derive ? derive(origins) : null;
      if (derived) {
        toWrite.push({ name, value: derived });
        results.set(name, { name, status: "derived", success: true });
      } else {
        // Nothing usable to compute — leave it unset rather than write a guess.
        results.set(name, { name, status: "skipped_deployment_config", success: true });
      }
      continue;
    }

    const val = inheritedValues[name];
    if (typeof val === "string" && val.length > 0) {
      toWrite.push({ name, value: val });
      results.set(name, { name, status: "inherited", success: true });
    } else {
      results.set(name, { name, status: "missing", success: true });
    }
  }

  return { toWrite, results };
}

export async function syncCloneSecrets(
  projectRef: string,
  names: string[],
  inheritedValues: Record<string, string>,
  origins?: CloneOrigins | null,
  dedicatedNames?: ReadonlySet<string>,
  selfValues?: Record<string, string>,
): Promise<SecretShellResult[]> {
  if (names.length === 0) return [];

  const { toWrite, results } = planCloneSecrets(
    names,
    inheritedValues,
    () => crypto.randomBytes(32).toString("hex"),
    origins ?? null,
    dedicatedNames,
    selfValues,
  );

  if (toWrite.length > 0) {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/secrets`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(toWrite),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      for (const s of toWrite) {
        results.set(s.name, {
          name: s.name,
          status: "failed",
          success: false,
          error: `secrets API ${res.status} — ${body}`,
        });
      }
    }
  }

  return names.map((n) => results.get(n)!);
}

/**
 * Write a single named secret onto a clone project. Used by the admin
 * "set secret value" server function so operators can fill in what
 * provisioning could not inherit.
 */
export async function setCloneSecretValue(
  projectRef: string,
  name: string,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return setCloneSecretValues(projectRef, [{ name, value }]);
}

/**
 * Write several secrets to a clone project in ONE request.
 *
 * The Management API's secrets endpoint already takes an array; writing a set
 * one call at a time is what makes a half-written pair possible. Two secrets
 * that are only meaningful together — a Resend key and the single address it
 * is scoped to send from — must arrive together or not at all, because the
 * half-written state is indistinguishable from a healthy one at every surface
 * that reads it, and is exactly the state the first clone shipped in.
 */
export async function setCloneSecretValues(
  projectRef: string,
  entries: Array<{ name: string; value: string }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (entries.length === 0) return { ok: true };
  const res = await fetch(`${MGMT_API}/projects/${projectRef}/secrets`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(entries),
  });
  if (!res.ok) {
    const names = entries.map((e) => e.name).join(", ");
    return {
      ok: false,
      error: `secrets API ${res.status} writing ${names} — ${(await res.text()).slice(0, 300)}`,
    };
  }
  return { ok: true };
}

// ─── Legacy bootstrap schema (reference only) ────────────────────────

/**
 * Legacy hand-rolled base schema, kept for the Settings preview page.
 * Provisioning no longer uses this — clone schemas come from the prime
 * repo's own migration files (see applyPrimeMigrations).
 */
export function getCloneBootstrapSql(): string {
  // This is the essential schema every clone needs.
  // It mirrors the prime's schema but only includes the tables
  // a clone instance needs to operate independently.
  return `
-- Core enums
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('super_admin', 'admin', 'operator', 'user');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Profiles viewable by authenticated"
    ON public.profiles FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "Users can insert own profile"
    ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- User roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- ── Hierarchy helper functions ──

CREATE OR REPLACE FUNCTION public.role_level(_role public.app_role)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = public
AS $fn$
BEGIN
  RETURN CASE _role::text
    WHEN 'super_admin' THEN 100
    WHEN 'admin'       THEN 80
    WHEN 'operator'    THEN 50
    WHEN 'user'        THEN 10
    ELSE 0
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.highest_role_level(_user_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE _level integer;
BEGIN
  SELECT COALESCE(MAX(public.role_level(role)), 0) INTO _level
  FROM public.user_roles WHERE user_id = _user_id;
  RETURN _level;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.can_assign_role(_assigner_id uuid, _target_role public.app_role)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  RETURN public.highest_role_level(_assigner_id) > public.role_level(_target_role);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.can_manage_user(_manager_id uuid, _target_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  RETURN public.highest_role_level(_manager_id) > public.highest_role_level(_target_user_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$fn$;

CREATE OR REPLACE FUNCTION public.is_operator(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('super_admin', 'admin', 'operator')
  )
$fn$;

-- Handle new user trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
  RETURN NEW;
END;
$fn$;

-- Bootstrap first admin trigger (grants super_admin to first user)
CREATE OR REPLACE FUNCTION public.bootstrap_first_admin()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin') THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin');
  END IF;
  RETURN NEW;
END;
$fn$;

-- Updated at helper
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

-- ── Guardrail triggers ──

CREATE OR REPLACE FUNCTION public.guard_last_super_admin()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF OLD.role = 'super_admin' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles WHERE role = 'super_admin' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot remove the last super_admin from the system';
    END IF;
  END IF;
  RETURN OLD;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_role_hierarchy()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NEW.assigned_by IS NULL THEN RETURN NEW; END IF;
  IF NOT public.can_assign_role(NEW.assigned_by, NEW.role) THEN
    RAISE EXCEPTION 'Insufficient privileges: cannot assign role %', NEW.role;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Attach triggers
DO $$ BEGIN
  CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER on_first_signup_bootstrap_admin
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.bootstrap_first_admin();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER guard_last_super_admin_delete
    BEFORE DELETE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.guard_last_super_admin();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER guard_last_super_admin_update
    BEFORE UPDATE ON public.user_roles
    FOR EACH ROW
    WHEN (OLD.role = 'super_admin' AND NEW.role <> 'super_admin')
    EXECUTE FUNCTION public.guard_last_super_admin();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER enforce_role_hierarchy_insert
    BEFORE INSERT ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.enforce_role_hierarchy();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER enforce_role_hierarchy_update
    BEFORE UPDATE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.enforce_role_hierarchy();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- User roles RLS (hierarchy-aware)
DO $$ BEGIN
  CREATE POLICY "Users can read own roles"
    ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "Admins and super_admins can read all roles"
    ON public.user_roles FOR SELECT TO authenticated
    USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "Hierarchy-enforced role assignment"
    ON public.user_roles FOR INSERT TO authenticated
    WITH CHECK (public.can_assign_role(auth.uid(), role) AND assigned_by = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "Hierarchy-enforced role update"
    ON public.user_roles FOR UPDATE TO authenticated
    USING (public.can_manage_user(auth.uid(), user_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE POLICY "Hierarchy-enforced role deletion"
    ON public.user_roles FOR DELETE TO authenticated
    USING (public.can_manage_user(auth.uid(), user_id));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Timestamp triggers
DO $$ BEGIN
  CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
  `.trim();
}

/**
 * Find an existing auth user's id by email, via the Auth Admin API.
 *
 * Only used on the resume path of {@link seedAdminUser}. Returns null when the
 * project genuinely has no such user, so the caller can say so rather than
 * granting a role to `undefined`.
 */
async function findUserIdByEmail(
  projectUrl: string,
  serviceRoleKey: string,
  email: string,
): Promise<string | null> {
  const res = await fetch(
    `${projectUrl}/auth/v1/admin/users?page=1&per_page=200&filter=${encodeURIComponent(email)}`,
    {
      headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
    },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { users?: Array<{ id?: string; email?: string }> };
  const wanted = email.trim().toLowerCase();
  // The filter is a server-side CONTAINS, so it can answer with neighbours —
  // `admin@x` matches `superadmin@x`. Compare exactly rather than taking [0].
  const hit = (body.users ?? []).find((u) => (u.email ?? "").trim().toLowerCase() === wanted);
  return hit?.id ?? null;
}

/**
 * Seed an admin user into the clone's backend using the Management API.
 * Creates the user via the Auth Admin API and inserts their admin role.
 */
export async function seedAdminUser(
  projectRef: string,
  serviceRoleKey: string,
  projectUrl: string,
  adminEmail: string,
  adminPassword: string,
): Promise<{ userId: string | null; report: AdminSeedReport }> {
  // Create user via Supabase Auth Admin API (using service role key)
  const createRes = await fetch(`${projectUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
      user_metadata: { display_name: "Admin" },
    }),
  });

  let userId: string | null = null;

  if (!createRes.ok) {
    const body = await createRes.text();
    if (createRes.status === 422 || /already.*(registered|exists)/i.test(body)) {
      // Resume path: the admin already exists from an earlier attempt.
      //
      // This used to `return { userId: null }` here — BEFORE the role grant
      // below. So the one run that mattered, the retry after a half-finished
      // provisioning, created nobody and granted nothing: the account existed,
      // could sign in, and held no `super_admin`. That is worse than no admin
      // at all, because it looks like a seeded clone. Every retry reproduced
      // it, because every retry took this branch.
      //
      // The user is looked up instead, and falls through to the same grant.
      userId = await findUserIdByEmail(projectUrl, serviceRoleKey, adminEmail);
      if (!userId) {
        throw new Error(
          `The admin user ${adminEmail} already exists on ${projectRef} but could not be ` +
            "read back, so its role could not be granted. Check the project's Auth users.",
        );
      }
    } else {
      throw new Error(`Failed to create admin user: ${createRes.status} — ${body}`);
    }
  } else {
    const user = await createRes.json();
    userId = user.id;
  }

  // Reached on BOTH paths now — freshly created and already-existing alike.
  //
  // AND AN AUTH USER IS NOT, ON ITS OWN, AN ADMIN ANYBODY CAN SIGN IN AS.
  //
  // What this used to do — grant `super_admin` in `public.user_roles` against
  // the auth id — could not work against the prime this platform clones, for
  // three independent reasons, and reported success for all of them because
  // the block swallowed every error into a warning:
  //
  //   * the product's login path reads `public.custom_users` and compares a
  //     bcrypt `password_hash` (`_shared/password.ts`); it never consults
  //     `auth.users`;
  //   * `public.user_roles.user_id` is a foreign key to `public.custom_users`,
  //     so an auth id is refused with 23503;
  //   * `public.app_role` spells the top role `superadmin`, so `super_admin`
  //     is refused with 22P02 even where the key would have been accepted.
  //
  // Measured on the first clone on 1 Sep 2026: `auth.users` held ZERO rows
  // after a run that had reported this step done.
  //
  // So the seed writes into the store the product actually reads, chooses a
  // role label the column actually admits, and REPORTS what it managed —
  // because a seeded admin who cannot sign in is worse than no admin, the
  // clone having been made to look finished.
  const report = await seedProductAdminIdentity(projectRef, adminEmail, adminPassword, userId);

  return { userId, report };
}

/**
 * Seed the identity the prime's own login path reads, and verify it.
 *
 * Everything here is conditional on the prime actually defining these tables:
 * a prime that authenticates through Supabase Auth has no `custom_users`, and
 * must not be failed for its absence. What is NOT conditional is honesty about
 * the outcome — the caller decides what to do with a clone nobody can enter.
 */
export async function seedProductAdminIdentity(
  projectRef: string,
  adminEmail: string,
  adminPassword: string,
  authUserId: string | null,
): Promise<AdminSeedReport> {
  const emailLit = sqlCredentialLiteral(adminEmail.trim().toLowerCase());
  const pwLit = sqlCredentialLiteral(adminPassword);

  // The role label is chosen BY THE COLUMN, not by us: `app_role` is an enum
  // on one table and free text on another, and the two spell it differently.
  const roleRows = (await runSqlOnProject(
    projectRef,
    `select e.enumlabel::text as label
       from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = 'app_role'
      order by e.enumsortorder`,
  )) as Array<{ label?: unknown }>;
  const enumLabels = (Array.isArray(roleRows) ? roleRows : [])
    .map((r) => (typeof r?.label === "string" ? r.label : null))
    .filter((v): v is string => Boolean(v));
  const enumRole = chooseRoleLabel(enumLabels);
  const enumRoleLit = enumRole ? sqlCredentialLiteral(enumRole) : "null";

  const rows = (await runSqlOnProject(
    projectRef,
    `
do $seed$
declare
  v_id uuid;
  v_role text;
begin
  if to_regclass('public.custom_users') is null then
    return;
  end if;

  select id into v_id from public.custom_users
   where lower(email) = ${emailLit} or lower(username) = ${emailLit}
   order by created_at limit 1;

  -- The role TEXT column takes the product's own spelling; the enum column is
  -- handled separately below because the two disagree by design.
  v_role := coalesce(${enumRoleLit}, 'admin');

  if v_id is null then
    v_id := gen_random_uuid();
    insert into public.custom_users (id, username, email, password_hash, role, is_active)
    values (v_id, 'admin', ${emailLit},
            extensions.crypt(${pwLit}, extensions.gen_salt('bf', 10)),
            v_role, true);
  else
    update public.custom_users
       set password_hash = extensions.crypt(${pwLit}, extensions.gen_salt('bf', 10)),
           is_active = true,
           deleted_at = null,
           failed_login_attempts = 0,
           locked_until = null,
           updated_at = now()
     where id = v_id;
  end if;

  -- The role row is best-effort and never fails the seed: a prime may model
  -- authority entirely inside custom_users.role.
  begin
    if to_regclass('public.user_roles') is not null and ${enumRole ? "true" : "false"} then
      execute format(
        'insert into public.user_roles (user_id, role) values (%L, %L::public.app_role) on conflict do nothing',
        v_id, ${enumRoleLit});
    end if;
  exception when others then
    raise warning 'aurixa: admin role row skipped: %', sqlerrm;
  end;
end
$seed$;

select
  (to_regclass('public.custom_users') is not null
     and exists (select 1 from public.custom_users
                  where lower(email) = ${emailLit})) as product_identity,
  coalesce((select password_hash = extensions.crypt(${pwLit}, password_hash)
              from public.custom_users where lower(email) = ${emailLit} limit 1), false)
    as password_verifies,
  (select r.role::text from public.user_roles r
     join public.custom_users u on u.id = r.user_id
    where lower(u.email) = ${emailLit} limit 1) as role_label,
  ${authUserId ? "true" : "false"} as auth_user
    `.trim(),
  )) as Array<Record<string, unknown>>;

  const row = Array.isArray(rows) ? (rows[0] ?? {}) : {};
  const notes: string[] = [];
  if (!enumRole && enumLabels.length > 0) {
    notes.push(
      `public.app_role admits ${enumLabels.join(", ")}, none of which names an administrator — no role row written`,
    );
  }
  return {
    product_identity: row.product_identity === true,
    password_verifies: row.password_verifies === true,
    role_label: typeof row.role_label === "string" ? row.role_label : null,
    auth_user: Boolean(authUserId),
    notes,
  };
}

// ─── Full Provisioning Pipeline ──────────────────────────────────────

export type ProvisionBackendInput = {
  cloneName: string;
  region?: string;
  adminEmail: string;
  /** Null only when `repair` is set, where no identity is seeded at all. */
  adminPassword: string | null;
  /** The prime repo's Supabase architecture to replicate onto the new project. */
  snapshot: PrimeBackendSnapshot;
  /**
   * Resume onto a project created by an earlier failed run instead of
   * creating (and paying for) a fresh one. The migration ledger makes the
   * replay pick up exactly where it stopped.
   */
  existingProjectRef?: string | null;
  /**
   * Real values for secret names the operator marked inheritable in
   * `prime_secret_forwards`. Passed as a plain map (name → value) so this
   * module stays server-only. Names not present are recorded as `missing`
   * on the clone and surfaced to operators via the clone secrets UI.
   */
  inheritedSecrets?: Record<string, string>;
  /**
   * Secret names this clone holds a DEDICATED credential for (today: a
   * per-clone Resend key from `clone_email_identities`). Never inherited from
   * the prime, whatever `prime_secret_forwards` says — a re-provision that
   * silently swapped a clone's own key back to the prime's shared one is a
   * regression to the model this exists to replace. Recorded as `missing`
   * (the ledger's own word) because a fresh backend genuinely does not hold
   * the value yet: the dedicated token cannot be read back and is re-minted by
   * a key rotation on the clone's email identity panel.
   */
  dedicatedSecretNames?: string[];
  /**
   * The clone's own frontend origins. Used to rewrite the prime's
   * [auth] `site_url` + `uri_allow_list` so the new backend accepts
   * sign-ins from the clone's own hosts, not the prime's (G8).
   */
  cloneOrigins?: CloneOrigins;
  /**
   * How the clone's schema gets built. Default `introspection` reads the
   * prime's live catalog; `migration-replay` forces the legacy path.
   */
  schemaStrategy?: SchemaStrategy;
  /**
   * The prime PRODUCT's Supabase project ref — the source every replication
   * step below reads from. Required rather than optional: it is not derivable,
   * and the previous derivation silently pointed all of them at Mission
   * Control's own project. Resolve it with `resolvePrimeBackendRef()`.
   */
  primeBackendRef: string;
  /**
   * Absolute wall-clock deadline for THIS invocation — not for the pipeline.
   * The drain worker that runs this lives ~60 seconds (pg_net's wait, plus
   * whatever grace the hosting runtime gives); the pipeline takes minutes.
   * When the deadline passes, the next stage boundary throws `BudgetPause`
   * instead of letting the runtime kill the worker mid-write, and the drain
   * requeues the job as forward progress rather than as a failed attempt.
   * Omitted = no budget (the operator wizard's direct path).
   */
  deadlineAt?: number | null;
  /**
   * Introspection stage to resume at, from a previous invocation's budget
   * pause. Stages before it were carried already and are skipped without
   * paying for their catalogue reads — the difference between a run that
   * progresses and one that replays the same prefix for ever.
   */
  introspectionResumeStage?: string | null;
  /**
   * Converge a backend that is already provisioned, rather than build one.
   *
   * Every replication step here checks the target before it writes — that is
   * what the budget work made them do — so a repair pass reconciles what is
   * already right and carries only what is missing. The ONE step that does not
   * work that way is the admin seed, which rewrites `password_hash` and clears
   * `failed_login_attempts` / `locked_until` whether or not anybody has since
   * signed in. So a repair skips it: the admin identity belongs to the tenant
   * once the clone is handed over, and a convergence pass is not entitled to
   * reset it. `adminPassword` is not read in this mode.
   */
  repair?: boolean;
  /**
   * Called the MOMENT a project is created, before anything else is spent on
   * it. The caller persists the ref so a death anywhere after creation can
   * never orphan a paid project: the resume path reads the persisted ref and
   * continues onto it. Without this the ref reached the row only in the final
   * update, which is after every step that can die.
   */
  onProjectRef?: (projectRef: string) => Promise<void>;
};

export type SchemaStrategy = "introspection" | "migration-replay";

export type IntrospectionSummary = {
  ok: boolean;
  stages: StageResult[];
  shortStages: StageName[];
  rowsOnClone: number | null;
  nonEmptyTables: string[];
};

export type ProvisionBackendResult = {
  projectRef: string;
  projectUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /** null when resuming an existing project — the original password is kept */
  dbPass: string | null;
  adminUserId: string | null;
  /**
   * What the admin seed managed, or null when the pass deliberately did not
   * run it (a repair). Null is "not attempted", never "attempted and empty" —
   * a caller that cannot tell those apart is how a clone nobody can sign into
   * came to look finished once already.
   */
  adminSeed: AdminSeedReport | null;
  migrationsApplied: PrimeMigrationResult[];
  latestMigration: string | null;
  /** Present when the schema was built by catalog introspection. */
  introspection?: IntrospectionSummary | null;
  edgeFunctions: EdgeFunctionDeployResult[];
  secretShells: SecretShellResult[];
  storageBuckets: BucketReplicationResult[];
  authConfig: AuthConfigResult;
  cronJobs: CronJobReplicationResult[];
  requiredExtensions: RequiredExtensionResult[];
  realtimePublication: RealtimeReplicationResult;
  /** The project-level upload limit, which decides which buckets can exist. */
  storageConfig: StorageConfigResult;
};

/**
 * Full pipeline: create project → wait ready → get keys → replay the prime's
 * migrations → deploy the prime's edge functions → create empty-shell secrets
 * → seed admin. Structure only — no data ever leaves the prime.
 */
export async function provisionCloneBackend(
  input: ProvisionBackendInput,
  onStatusUpdate?: (status: string, detail: string) => Promise<void>,
): Promise<ProvisionBackendResult> {
  const { snapshot } = input;

  // Budget check between stages. Throws BudgetPause, which the drain treats
  // as forward progress — never a burned attempt. See provisioningBudget.ts.
  const pauseIfDue = (about: string) => {
    if (pastDeadline(input.deadlineAt)) throw new BudgetPause(about);
  };

  // Step 1: Create the project (or resume onto a surviving one)
  let projectRef = input.existingProjectRef ?? null;
  let dbPass: string | null = null;

  if (projectRef) {
    await onStatusUpdate?.("provisioning", `Resuming on existing project ${projectRef}...`);
  } else {
    // G10: preflight org capacity so we don't burn a slot on a doomed create.
    await onStatusUpdate?.("provisioning", "Checking Supabase org capacity...");
    const capacity = await checkOrgCapacity();
    if (capacity.hardBlock) {
      throw new Error(
        `Org capacity check failed: ${capacity.reason} ` +
          `(${capacity.activeProjects}/${capacity.softLimit} active projects on ${capacity.planTier ?? "unknown"} plan).`,
      );
    }
    if (capacity.wouldExceed) {
      await onStatusUpdate?.(
        "provisioning",
        `Warning: soft limit exceeded (${capacity.activeProjects}/${capacity.softLimit}) — proceeding.`,
      );
    }
    dbPass = generateSecurePassword();
    await onStatusUpdate?.("provisioning", "Creating Supabase project...");
    const project = await createSupabaseProject({
      name: `aurixa-clone-${input.cloneName}`,
      region: input.region,
      dbPass,
    });
    projectRef = project.id;
    // Persist the ref the MOMENT it exists — a death anywhere after this
    // point must resume onto this project, never create (and pay for) a
    // second one. The final row update writing it again is idempotent.
    await input.onProjectRef?.(projectRef);
  }

  // Step 2: Wait for it to be ready. A fresh project can take minutes to
  // report healthy, which is longer than the invocation lives — so the wait
  // is clamped to the budget and its expiry converts to a pause: the ref is
  // persisted, so the next tick resumes the same wait at no cost.
  await onStatusUpdate?.("provisioning", "Waiting for project to become healthy...");
  const remainingForWait =
    typeof input.deadlineAt === "number" ? input.deadlineAt - Date.now() : null;
  try {
    await waitForProjectReady(
      projectRef,
      remainingForWait === null ? undefined : Math.max(15_000, Math.min(120_000, remainingForWait)),
    );
  } catch (err) {
    if (remainingForWait !== null && pastDeadline(input.deadlineAt)) {
      throw new BudgetPause("waiting for the new project to report healthy");
    }
    throw err;
  }

  // Step 3: Get API keys
  await onStatusUpdate?.("provisioning", "Retrieving API keys...");
  const { anonKey, serviceRoleKey } = selectProjectKeys(await getProjectApiKeys(projectRef));
  if (!anonKey || !serviceRoleKey) {
    throw new Error("Could not retrieve client/privileged API keys from new project");
  }
  // The clone's own token-signing key, read from its PostgREST config. Best
  // effort: a project that will not report one records JWT_SECRET as pending
  // with a remedy, which is the honest state — never a generated value, which
  // would sign tokens this project's own PostgREST rejects.
  const ownJwtSecret = await getProjectJwtSecret(projectRef).catch(() => null);

  const projectUrl = getProjectUrl(projectRef);

  // Step 3b: extensions, BEFORE the schema is built.
  //
  // This ran after the schema build and that was a deadlock. The prime's
  // schema DEPENDS on its extensions: `vector` supplies the type that
  // `agent_semantic_memories`, `document_chunks`, `pdf_import_chunks`,
  // `market_updates` and five more tables declare a column of. Without it
  // those tables cannot be created; without those tables every column added
  // to them fails "relation does not exist", and so does every function that
  // reads them.
  //
  // Measured on the 31 Aug 2026 dry run, once the schema build was finally
  // able to run to the end of its stages: 6 table failures on
  // `type "vector" does not exist`, 337 column failures and 28 function
  // failures behind them, all from that one absence — while the step that
  // installs it sat on the far side of the build that could not finish.
  //
  // The ordering was survivable only while the build ran to completion in a
  // single invocation. It stopped being survivable the moment the build
  // learned to pause and resume, because a build that never finishes never
  // reaches what comes after it.
  //
  // Non-fatal per extension, and reported: a clone missing `pg_cron` or
  // `pg_net` has no working background layer at all, which is precisely the
  // silent failure this platform has had before.
  let requiredExtensions: RequiredExtensionResult[] = [];
  try {
    await onStatusUpdate?.("migrating", "Enforcing required Postgres extensions...");
    // Mirror the prime's extensions, not a hard-coded guess. See
    // resolveRequiredExtensions for what that list used to miss.
    requiredExtensions = await enforceRequiredExtensions(projectRef, input.primeBackendRef);
    const failedExt = requiredExtensions.filter((r) => r.status === "failed");
    if (failedExt.length > 0) {
      await onStatusUpdate?.(
        "migrating",
        `${failedExt.length}/${requiredExtensions.length} extension(s) failed to install — ${failedExt.map((e) => e.name).join(", ")}`,
      );
    }
  } catch (err) {
    await onStatusUpdate?.(
      "migrating",
      `Required-extension enforcement skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 4: Build the clone's schema.
  //
  // Default path is catalog introspection: read the prime's live pg_catalog
  // and generate DDL. A replay of the repo's migration history is NOT a clone
  // of the database — for our prime the history assumes base tables no
  // migration creates, so it dies on migration #1. `applyPrimeMigrations` is
  // kept (it is still right for incremental + module migrations) and can be
  // forced with `schemaStrategy: "migration-replay"`.
  const strategy = input.schemaStrategy ?? "introspection";
  let migrationsApplied: PrimeMigrationResult[] = [];
  let latestApplied: string | null = null;
  let introspection: IntrospectionSummary | null = null;

  if (strategy === "introspection") {
    pauseIfDue("building the schema by introspection");
    await onStatusUpdate?.("migrating", "Introspecting the prime's live catalog...");
    const { replicateSchemaByIntrospection, stampMigrationLedgerFromPrime, verifyCloneIsEmpty } =
      await import("./schema-introspection.server");
    const primeRef = input.primeBackendRef;
    const result = await replicateSchemaByIntrospection(projectRef, {
      primeRef,
      onStatusUpdate,
      deadlineAt: input.deadlineAt,
      resumeFrom: input.introspectionResumeStage ?? null,
    });
    // Counting every row on the clone is a reading, not a gate — nothing below
    // branches on it. So it gets the budget that is LEFT, never the budget the
    // schema build needed: it sits directly behind the heaviest step in the
    // pipeline, and a diagnostic that can kill the worker costs a 15-minute
    // stall reclaim to learn something no decision uses.
    //
    // And it only runs on a pass that BUILT something. A pass where every
    // stage answered `alreadyReconciled` applied no DDL and inserted no row,
    // so the clone holds exactly what the previous pass already counted —
    // re-counting 649 tables tells nobody anything new, and it is spending
    // the tail of a budget the edge-function deployment below needs. That
    // deployment always makes at least one function of progress and then
    // checks the clock, so whatever this scan takes comes straight out of
    // the pass's only remaining productive work: measured on 3 Sep 2026, a
    // pass arrived at the deploy loop with enough budget for exactly ONE of
    // 423 functions.
    //
    // The reading is kept where it means something (the pass that builds the
    // schema) and dropped where it is a repetition.
    const builtSomething = result.stages.some((st) => st.applied > 0 || !st.reconciled);
    const emptiness = builtSomething
      ? await verifyCloneIsEmpty(projectRef, {
          allowRows: 0,
          deadlineAt: input.deadlineAt ?? undefined,
        }).catch(() => null)
      : null;
    introspection = {
      ok: result.ok,
      stages: result.stages,
      shortStages: result.shortStages,
      // A scan cut short by the budget is not a row count. `null` already
      // means "not measured" here; reporting a partial sum as the total would
      // certify a clone empty on the tables that happened to be scanned first.
      rowsOnClone: emptiness?.complete ? emptiness.totalRows : null,
      // Whereas a table it DID find rows in really does hold them, finished or
      // not — that half of the reading is sound either way.
      nonEmptyTables: emptiness?.nonEmpty.map((t) => t.table).slice(0, 20) ?? [],
    };
    if (result.partial) {
      // Not a failure and not a success: this pass resumed partway through
      // and reached the end of the sequence, so the stages it skipped are
      // unverified. Pause out, clearing the marker, and let one full pass
      // confirm the schema from the top.
      throw new BudgetPause(
        "schema build reached the end of a resumed pass — verifying from the first stage next tick",
        "",
      );
    }
    if (!result.ok) {
      const short = result.stages
        .filter((s) => !s.reconciled)
        .map((s) => `${s.stage} ${s.cloneCount}/${s.primeCount}`)
        .join(", ");
      throw new Error(
        `Schema introspection did not reconcile against the prime: ${short} ` +
          `(project ${projectRef} kept — a retry resumes idempotently)`,
      );
    }
    // Stamp the prime's applied migration IDs so future INCREMENTAL migrations
    // still apply cleanly instead of replaying history the clone already has.
    //
    // NOT best-effort, despite reading like a finishing touch. The stamp is
    // what makes the introspected schema syncable at all: without it the
    // ledger is empty, `migration-sync` computes every prime migration as
    // pending, and the replay dies on #1 against objects that already exist —
    // permanently, on every retry. The failure surfaces months later as "this
    // clone will not take migrations", with nothing connecting it back to
    // provisioning. A `.catch(() => ({ stamped: 0 }))` here turned that into a
    // success that printed "stamped 0 migration ID(s)" and moved on.
    const stamp = await stampMigrationLedgerFromPrime(projectRef, primeRef);
    latestApplied =
      [...snapshot.migrations].sort((a, b) => a.name.localeCompare(b.name)).at(-1)?.id ?? null;
    await onStatusUpdate?.(
      "migrating",
      stamp.reconciled
        ? "Catalog introspection reconciled; migration ledger already stamped"
        : `Catalog introspection reconciled; stamped ${stamp.stamped} migration ID(s)`,
    );
  } else {
    await onStatusUpdate?.(
      "migrating",
      `Replaying ${snapshot.migrations.length} migration(s) from ${snapshot.sourceRepo}@${snapshot.sourceSha.slice(0, 7)}...`,
    );
    const replay = await applyPrimeMigrations(projectRef, snapshot.migrations, onStatusUpdate);
    migrationsApplied = replay.results;
    latestApplied = replay.latestApplied;
    const migrationFailure = migrationsApplied.find((r) => !r.success);
    if (migrationFailure) {
      throw new Error(
        `Migration ${migrationFailure.name} failed: ${migrationFailure.error ?? "unknown"} ` +
          `(project ${projectRef} kept — retry resumes from the failed migration)`,
      );
    }
  }

  // Step 5: Deploy the prime's edge functions (non-fatal per function)
  pauseIfDue("deploying edge functions");
  // An empty function list must never be mistaken for a prime with no
  // functions. A resumed schema pass declines to fetch the bundle source
  // because it cannot reach this point — so if it somehow does, stop and
  // fetch it, rather than "successfully" deploying nothing. The empty
  // resumeStage clears the marker, so the next pass takes a full snapshot.
  if (snapshot.functionSourceOmitted) {
    throw new BudgetPause(
      "the edge functions need the prime's source, which this pass did not fetch — taking a full snapshot next tick",
      "",
    );
  }
  // On a resume, ask the PROJECT which functions it already holds and deploy
  // only the rest — the target is the authority, never a diary of past runs.
  // This is what turns repeated budgeted invocations into compound progress
  // over the longest stage in the pipeline.
  let functionsToDeploy = snapshot.functions;
  let alreadyDeployed: EdgeFunctionDeployResult[] = [];
  if (input.existingProjectRef) {
    const liveSlugs = new Set(
      await listProjectEdgeFunctionSlugs(projectRef).catch(() => [] as string[]),
    );
    if (liveSlugs.size > 0) {
      alreadyDeployed = snapshot.functions
        .filter((f) => liveSlugs.has(f.slug))
        .map((f) => ({ slug: f.slug, success: true, skipped: true }));
      functionsToDeploy = snapshot.functions.filter((f) => !liveSlugs.has(f.slug));
      if (alreadyDeployed.length > 0) {
        await onStatusUpdate?.(
          "migrating",
          `Resume: ${alreadyDeployed.length}/${snapshot.functions.length} edge functions already on the project — deploying the remaining ${functionsToDeploy.length}`,
        );
      }
    }
  }
  const deployedNow = await deployEdgeFunctions(
    projectRef,
    functionsToDeploy,
    onStatusUpdate,
    input.deadlineAt,
  );
  const edgeFunctions = [...alreadyDeployed, ...deployedNow];

  // A pass that carried only SOME of the functions may not pronounce the
  // deployment complete, exactly as a resumed schema pass may not pronounce
  // the schema complete. Without this the pipeline would run to the end and
  // mark the clone `ready` holding 60 of 423 functions — a workspace that
  // looks finished and is missing most of its backend, which is the worst
  // outcome available here.
  //
  // The empty resume stage clears the marker, so the next pass takes a fresh
  // snapshot, asks the project what it now holds, and fetches the next slice.
  if (snapshot.functionSourceTruncated) {
    throw new BudgetPause(
      `${edgeFunctions.length} edge functions carried this pass — fetching the next batch next tick`,
      "",
    );
  }

  // Step 5b: Replicate storage bucket configuration from the prime. Migrations
  // already replayed the row-level policies on `storage.objects`, but those
  // policies only match if the buckets themselves exist — otherwise every
  // signed-URL / upload path silently 404s on the clone. Non-fatal: we
  // surface per-bucket errors so operators can retry from the clone page.
  pauseIfDue("replicating storage buckets");
  let storageBuckets: BucketReplicationResult[] = [];
  let storageConfig: StorageConfigResult = {
    status: "skipped",
    reason: "not attempted on this pass",
  };
  try {
    const primeRef = input.primeBackendRef;
    // The project's upload limit FIRST: a bucket may not ask for more room
    // than the project allows, and the refusal reads as a bucket fault rather
    // than a missing project setting (see replicateStorageConfig).
    storageConfig = await replicateStorageConfig(primeRef, projectRef);
    if (storageConfig.status === "failed") {
      await onStatusUpdate?.(
        "migrating",
        `Project upload limit not replicated (${storageConfig.error}) — buckets asking for more room than this project allows will be refused`,
      );
    }
    await onStatusUpdate?.("migrating", "Replicating storage bucket configuration from prime...");
    storageBuckets = await replicateStorageBuckets(primeRef, projectRef, input.deadlineAt ?? null);
    const failed = storageBuckets.filter((b) => b.status === "failed");
    const totalObjects = storageBuckets.reduce((n, b) => n + (b.objects_copied ?? 0), 0);
    const totalBytes = storageBuckets.reduce((n, b) => n + (b.bytes_copied ?? 0), 0);
    const objectFailures = storageBuckets.reduce(
      (n, b) => n + Math.max(0, b.objects_failed ?? 0),
      0,
    );
    if (failed.length > 0) {
      await onStatusUpdate?.(
        "migrating",
        `${failed.length}/${storageBuckets.length} bucket(s) failed — ${totalObjects} seed object(s) copied (${Math.round(totalBytes / 1024)} KB), ${objectFailures} object failure(s)`,
      );
    } else if (totalObjects > 0) {
      await onStatusUpdate?.(
        "migrating",
        `Copied ${totalObjects} seed object(s) across ${storageBuckets.length} bucket(s) (${Math.round(totalBytes / 1024)} KB${objectFailures ? `, ${objectFailures} failure(s)` : ""})`,
      );
    }
  } catch (err) {
    await onStatusUpdate?.(
      "migrating",
      `Storage bucket replication skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Deferred buckets pause the pass, OUTSIDE the catch above — thrown from
  // inside it, a BudgetPause would be swallowed as a failed replication and
  // the pipeline would run on and mark a clone ready holding some of the
  // prime's 32 buckets. The same rule the cron and realtime steps follow, and
  // for the same reason.
  const deferredBuckets = storageBuckets.filter((b) => b.status === "deferred");
  if (deferredBuckets.length > 0) {
    const failedBuckets = storageBuckets.filter((b) => b.status === "failed");
    await onStatusUpdate?.(
      "migrating",
      `${storageBuckets.length - deferredBuckets.length}/${storageBuckets.length} storage bucket(s) replicated this pass — the rest resume next tick`,
    );
    throw new BudgetPause(
      `${deferredBuckets.length} of ${storageBuckets.length} storage bucket(s) carried to the next pass` +
        (failedBuckets.length > 0
          ? ` — ${failedBuckets.length} FAILED and will not replicate on a retry: ${failedBuckets
              .slice(0, 3)
              .map((b) => `${b.id} (${b.error ?? "no error recorded"})`)
              .join("; ")}`
          : ""),
      "",
    );
  }

  // Step 5c: Replicate the prime's [auth] policy (site URL, redirect allow-list,
  // JWT expiry, signup + password rules). Non-fatal — surface the result so
  // operators can retry from the clone page if the Management API rejects it.
  pauseIfDue("replicating auth policy");
  let authConfigResult: AuthConfigResult = { status: "skipped", reason: "not attempted" };
  try {
    await onStatusUpdate?.("migrating", "Replicating auth policy from prime config.toml...");
    authConfigResult = await applyAuthConfig(
      projectRef,
      snapshot.authConfig,
      input.cloneOrigins ?? null,
    );
    if (authConfigResult.status === "failed") {
      await onStatusUpdate?.(
        "migrating",
        `Auth policy replication failed (non-fatal): ${authConfigResult.error}`,
      );
    }
  } catch (err) {
    authConfigResult = {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 5d: Replicate the prime's pg_cron schedule. Migrations already
  // replayed any `cron.schedule(...)` calls verbatim on the clone, which
  // means every job's `net.http_post` currently fires against the PRIME's
  // URL. We rewrite each job's command so the clone's schedule fires
  // against the clone's own edge functions instead. Non-fatal per job.
  // Step 5d-pre: take the prime's URL out of everything that still holds it,
  // BEFORE any job is scheduled. Cron commands were already rewritten; these
  // two are the places that rewrite does not reach, and both fire on a fresh
  // clone precisely because it is fresh. Non-fatal — surfaced for retry.
  pauseIfDue("seeding vault URL and re-pointing prime references");
  let vaultSeed: { ok: boolean; error?: string } = { ok: false };
  let functionRepoints: FunctionRepointResult[] = [];
  try {
    const primeRef = input.primeBackendRef;
    await onStatusUpdate?.("migrating", "Seeding this project's own URL into its vault...");
    vaultSeed = await seedCloneVaultUrl(projectRef);
    if (!vaultSeed.ok) {
      await onStatusUpdate?.(
        "migrating",
        `Vault seed failed (${vaultSeed.error ?? "unknown"}) — functions that read supabase_url will fall back to the prime until this is fixed`,
      );
    }
    await onStatusUpdate?.("migrating", "Re-pointing any function body that names the prime...");
    functionRepoints = await repointPrimeUrlsInFunctions(projectRef, primeRef);
    const repointFailed = functionRepoints.filter((r) => r.status === "failed");
    if (repointFailed.length > 0) {
      await onStatusUpdate?.(
        "migrating",
        `${repointFailed.length} function(s) still name the prime — operators can retry from the clone page`,
      );
    }
  } catch (err) {
    await onStatusUpdate?.(
      "migrating",
      `Prime-reference cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  pauseIfDue("replicating the pg_cron schedule");
  let cronJobs: CronJobReplicationResult[] = [];
  try {
    const primeRef = input.primeBackendRef;
    await onStatusUpdate?.("migrating", "Replicating pg_cron schedule from prime...");
    const primeJobs = await fetchPrimeCronJobs(primeRef);
    const primeKeys = selectProjectKeys(await getProjectApiKeys(primeRef).catch(() => []));
    cronJobs = await replicateCronJobs(
      projectRef,
      primeRef,
      primeJobs,
      {
        primeAnonKey: primeKeys.anonKey,
        cloneAnonKey: anonKey,
      },
      input.deadlineAt,
    );
    const failed = cronJobs.filter((c) => c.status === "failed");
    if (failed.length > 0) {
      await onStatusUpdate?.(
        "migrating",
        `${failed.length}/${cronJobs.length} cron job(s) failed to replicate — operators can retry`,
      );
    }
  } catch (err) {
    await onStatusUpdate?.(
      "migrating",
      `Cron replication skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // OUTSIDE the try, deliberately. `replicateCronJobs` returns its deferrals
  // rather than throwing them, because the catch above would turn a
  // BudgetPause into "Cron replication skipped" — a pause reported as a
  // decision not to do the work, and the pass would run on and mark the clone
  // ready holding a partial schedule. A clone missing cron jobs has no
  // background layer for whatever they drive, which is exactly the silent
  // failure this platform has had before.
  const deferredCron = cronJobs.filter((c) => c.status === "deferred");
  const failedCron = cronJobs.filter((c) => c.status === "failed");
  if (deferredCron.length > 0) {
    await onStatusUpdate?.(
      "migrating",
      `${cronJobs.length - deferredCron.length}/${cronJobs.length} cron job(s) replicated this pass — the rest resume next tick`,
    );
    // A DEFERRAL MUST NOT HIDE A FAILURE. The failure line above is written to
    // the same `status_detail` this pause is about to overwrite, so a job that
    // can NEVER replicate looked exactly like one that merely ran out of time
    // — on every pass, for ever, while the count of "carried" jobs oscillated
    // and the clone's schedule never grew. Observed on the Preflight clone,
    // 3 Sep 2026: 45 of 47 jobs, holding, with two failing silently behind a
    // deferral message.
    throw new BudgetPause(
      `${deferredCron.length} of ${cronJobs.length} cron job(s) carried to the next pass` +
        (failedCron.length > 0
          ? ` — ${failedCron.length} FAILED and will not replicate on a retry: ${failedCron
              .slice(0, 3)
              .map((c) => `${c.jobname} (${c.error ?? "no error recorded"})`)
              .join("; ")}`
          : ""),
      "",
    );
  }

  // Step 5e (G4): mirror the prime's realtime publication membership so
  // channels subscribing to the same tables continue to receive INSERT /
  // UPDATE / DELETE payloads on the clone. Non-fatal per table.
  pauseIfDue("replicating the realtime publication");
  let realtimePublication: RealtimeReplicationResult = {
    status: "skipped",
    added: [],
    alreadyPublished: [],
    deferred: [],
    failures: [],
  };
  try {
    const primeRef = input.primeBackendRef;
    await onStatusUpdate?.("migrating", "Replicating realtime publication from prime...");
    const primeTables = await fetchRealtimePublicationTables(primeRef);
    realtimePublication = await replicateRealtimePublication(
      projectRef,
      primeTables,
      input.deadlineAt,
    );
    if (realtimePublication.status === "partial" || realtimePublication.status === "failed") {
      await onStatusUpdate?.(
        "migrating",
        `Realtime publication ${realtimePublication.status}: ${realtimePublication.added.length} added, ${realtimePublication.alreadyPublished.length} already present, ${realtimePublication.deferred.length} deferred of ${primeTables.length} table(s), ${realtimePublication.failures.length} failure(s)`,
      );
    }
  } catch (err) {
    realtimePublication = {
      status: "failed",
      added: [],
      alreadyPublished: [],
      deferred: [],
      failures: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Outside the catch, for the same reason the cron deferral is: a throw
  // inside it is recorded as a FAILED replication and the pass runs on, so a
  // clone would be marked ready publishing a fraction of the prime's tables —
  // and a table missing from the publication drops every realtime channel
  // subscribed to it, silently.
  if (realtimePublication.deferred.length > 0) {
    const rtFailures = realtimePublication.failures;
    // Same rule as the cron deferral: A DEFERRAL MUST NOT HIDE A FAILURE.
    // Observed on the Preflight clone, 3 Sep 2026 — the publication grew from
    // 22 to 23 across a dozen passes while each pass reported roughly twenty
    // tables "carried", because the twenty it actually attempted were failing
    // and the failure line was overwritten by this pause. Without the reason
    // travelling with the pause, a publication that can never complete is
    // indistinguishable from one that is merely slow.
    throw new BudgetPause(
      `${realtimePublication.deferred.length} of ${realtimePublication.deferred.length + realtimePublication.added.length + realtimePublication.alreadyPublished.length} realtime table(s) carried to the next pass` +
        (rtFailures.length > 0
          ? ` — ${rtFailures.length} FAILED and will not publish on a retry: ${rtFailures
              .slice(0, 3)
              .map((f) => `${f.schema}.${f.table} (${f.error})`)
              .join("; ")}`
          : ""),
      "",
    );
  }

  pauseIfDue("syncing secrets");
  await onStatusUpdate?.(
    "migrating",
    `Syncing ${snapshot.secretNames.length} secret(s) — inheriting whitelisted values...`,
  );
  const secretShells = await syncCloneSecrets(
    projectRef,
    snapshot.secretNames,
    input.inheritedSecrets ?? {},
    // The same origins `applyAuthConfig` was given at step 5c. Passing them
    // here is what makes ALLOWED_ORIGINS this clone's own rather than unset.
    input.cloneOrigins ?? null,
    new Set(input.dedicatedSecretNames ?? []),
    // Values that belong to THIS clone rather than being copied from the
    // prime. `JWT_SECRET` is tenant-scoped precisely so it can never be
    // inherited, which would otherwise leave every clone unable to sign its
    // own access tokens — so provisioning supplies the project's own.
    ownJwtSecret ? { JWT_SECRET: ownJwtSecret } : undefined,
  );

  // Step 7: Seed admin — UNLESS this is a repair.
  //
  // A convergence pass may not touch the tenant's own credential. The seed
  // below rewrites `password_hash` and clears `failed_login_attempts` and
  // `locked_until` on an existing row unconditionally, so running it over a
  // handed-over clone silently resets the administrator's password and
  // releases a lockout — and reports success while doing it. Skipped
  // explicitly and SAID, so the step is visibly not-run rather than absent.
  if (input.repair) {
    await onStatusUpdate?.(
      "seeding_admin",
      "Admin identity left untouched — a repair converges infrastructure and never re-seeds a tenant's credential.",
    );
    return {
      projectRef,
      projectUrl,
      anonKey,
      serviceRoleKey,
      dbPass,
      adminUserId: null,
      adminSeed: null,
      migrationsApplied,
      latestMigration: latestApplied,
      introspection,

      edgeFunctions,
      secretShells,
      storageBuckets,
      authConfig: authConfigResult,
      cronJobs,
      requiredExtensions,
      realtimePublication,
      storageConfig,
    };
  }
  pauseIfDue("seeding the admin user");
  // Loudly, rather than seeding a blank credential: an empty password on an
  // administrator account is worse than any failure this could report.
  if (!input.adminPassword) {
    throw new Error(
      "No admin password was supplied for a provisioning pass — refusing to seed an administrator with an empty credential",
    );
  }
  await onStatusUpdate?.("seeding_admin", "Creating admin user...");
  const { userId: adminUserId, report: adminSeed } = await seedAdminUser(
    projectRef,
    serviceRoleKey,
    projectUrl,
    input.adminEmail,
    input.adminPassword,
  );
  // SAID, NOT SWALLOWED. The previous version reported this step done whether
  // or not anybody could sign in, which is how a clone came to look finished
  // with zero rows in every identity table it has. The run is not failed over
  // it — the schema, functions and secrets are all real and worth keeping, and
  // a prime that authenticates some third way is not a fault — but the
  // operator is told, in the status line they are already watching.
  await onStatusUpdate?.(
    "seeding_admin",
    [describeSeed(adminSeed, input.adminEmail), ...adminSeed.notes].join(" "),
  );

  return {
    projectRef,
    projectUrl,
    anonKey,
    serviceRoleKey,
    dbPass,
    adminUserId,
    adminSeed,
    migrationsApplied,
    latestMigration: latestApplied,
    introspection,

    edgeFunctions,
    secretShells,
    storageBuckets,
    authConfig: authConfigResult,
    cronJobs,
    requiredExtensions,
    realtimePublication,
    storageConfig,
  };
}

export function generateSecurePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  const length = 32;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/**
 * Queue a clone's backend for the pg_cron drain worker.
 *
 * One implementation with several callers — the operator wizard's
 * `provisionBackend` server function, the signed-agreement flow, the retry
 * hook and the repair hook — because this upsert IS the contract with
 * `/hooks/backend-provisioning-drain`, and two writers of that row shape is
 * how the queue and the worker drift.
 *
 * Issue #12 lives here now: `clone_modules` (written by provisionClone) is
 * the authoritative module set; the caller's `moduleIds` are only a fallback
 * for a clone with nothing installed yet.
 *
 * ── The two modes, and why `repair` is not just a relaxed guard ──
 *
 * A PROVISION builds a backend that does not exist yet and refuses a row at
 * `ready`, because the wizard must never provision the same clone twice.
 *
 * A REPAIR takes a row at `ready` and NOTHING ELSE, and converges it onto the
 * engine as it now stands. That is the case the `ready` refusal had no answer
 * for: every fix to this pipeline leaves the clones provisioned before it
 * frozen holding the old gaps, and the only remedy the product offered was to
 * destroy a tenant's Supabase project. Between the two modes and the retry
 * hook (`failed` only) every terminal state has a lever and no in-flight row
 * can be claimed by any of them.
 *
 * A repair carries NO admin credential, and that is deliberate rather than a
 * convenience: `seedProductAdminIdentity` rewrites `password_hash` and clears
 * `failed_login_attempts` / `locked_until` unconditionally, so re-running step
 * 7 over a live tenant is a silent credential reset and a lockout release. The
 * admin belongs to the tenant once the clone is handed over. It is also what
 * makes a clone repairable at all after a terminal failure cleared its queued
 * password — which is the state the first two engine-provisioned clones were
 * actually in.
 */
export async function enqueueCloneBackendProvisioning(
  // Narrow structural type: both the request-scoped client and the
  // service-role client satisfy it.
  supabase: {
    from: (table: string) => any;
  },
  userId: string,
  input: {
    cloneId: string;
    cloneName: string;
    region?: string;
    adminEmail: string;
    /** Null only in repair mode, where nothing is seeded and none is needed. */
    adminPassword: string | null;
    moduleIds?: string[];
    /** Converge an already-ready backend rather than build a new one. */
    repair?: boolean;
  },
): Promise<{ ok: true; queued: true } | { ok: false; error: string }> {
  const { encryptSecret } = await import("./crypto.server");

  const { data: clone } = await supabase
    .from("clones")
    .select("id, name")
    .eq("id", input.cloneId)
    .single();
  if (!clone) return { ok: false, error: "Clone not found" };

  const { data: existing } = await supabase
    .from("clone_backends")
    .select("id, status, supabase_project_ref")
    .eq("clone_id", input.cloneId)
    .maybeSingle();
  if (input.repair) {
    // The mirror of the retry hook's `failed` guard. Stated as three separate
    // refusals because each one is a different thing to tell an operator.
    if (!existing) return { ok: false, error: "This clone has no backend to repair" };
    if (existing.status !== "ready") {
      return {
        ok: false,
        error: `Repair converges a READY backend — this one is '${existing.status}'. A failed backend is re-queued by the retry hook; one in flight is already being worked.`,
      };
    }
    if (!existing.supabase_project_ref) {
      return {
        ok: false,
        error:
          "This backend names no Supabase project, so there is nothing to converge onto — provision it rather than repairing it",
      };
    }
  } else {
    if (existing && existing.status === "ready") {
      return { ok: false, error: "This clone already has a provisioned backend" };
    }
    if (!input.adminPassword) {
      return { ok: false, error: "An admin password is required to provision a backend" };
    }
  }

  const { data: installed } = await supabase
    .from("clone_modules")
    .select("module_id")
    .eq("clone_id", input.cloneId);
  const dbModuleIds = (installed ?? [])
    .map((r: { module_id: string | null }) => r.module_id)
    .filter(Boolean) as string[];
  const resolvedModuleIds = dbModuleIds.length > 0 ? dbModuleIds : (input.moduleIds ?? []);
  if (input.moduleIds && input.moduleIds.length > 0 && dbModuleIds.length > 0) {
    const a = new Set(input.moduleIds);
    const b = new Set(dbModuleIds);
    const drift = a.size !== b.size || [...a].some((x) => !b.has(x));
    if (drift) {
      console.warn(
        "[provisionBackend] moduleIds drift between caller input and clone_modules; using clone_modules",
        { cloneId: input.cloneId, input: [...a], installed: [...b] },
      );
    }
  }

  const { error: upsertErr } = await supabase.from("clone_backends").upsert(
    {
      clone_id: input.cloneId,
      status: "pending" as const,
      region: input.region || "us-east-1",
      admin_email: input.adminEmail,
      // A repair seeds nobody, so it queues no credential — and the drain's
      // claim and its stranded sweep both read `repair_requested_at` for
      // exactly that reason.
      queued_admin_password_enc: input.adminPassword ? encryptSecret(input.adminPassword) : null,
      repair_requested_at: input.repair ? new Date().toISOString() : null,
      queued_module_ids: resolvedModuleIds,
      queued_at: new Date().toISOString(),
      worker_started_at: null,
      worker_finished_at: null,
      attempts: 0,
      enqueued_by: userId,
      error_message: null,
      status_detail: input.repair
        ? "Repair queued — the worker will converge this backend onto the current engine within ~60 seconds"
        : "Queued — background worker will start within ~60 seconds",
    },
    { onConflict: "clone_id" },
  );
  if (upsertErr) return { ok: false, error: upsertErr.message };

  return { ok: true, queued: true };
}
