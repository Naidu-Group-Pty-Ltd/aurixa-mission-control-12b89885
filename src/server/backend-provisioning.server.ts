/**
 * Supabase Management API helpers for programmatically provisioning
 * dedicated backend projects for each clone.
 *
 * Requires two secrets:
 *   SB_MGMT_API_TOKEN  – Personal Access Token from supabase.com/dashboard/account/tokens
 *   SB_ORG_ID          – Organization ID from supabase.com/dashboard/org/_/general
 */

import crypto from "node:crypto";

import { classifySecret } from "./prime-backend.server";
import { assessLedgerState, ledgerRepairHint } from "./cloneLedgerState.pure";
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
  status: "created" | "exists" | "failed";
  error?: string;
  objects_copied?: number;
  objects_failed?: number;
  objects_skipped?: number;
  bytes_copied?: number;
};

export async function createStorageBucket(
  projectRef: string,
  bucket: StorageBucketConfig,
): Promise<BucketReplicationResult> {
  const body = {
    id: bucket.id,
    name: bucket.name,
    public: bucket.public,
    file_size_limit: bucket.file_size_limit,
    allowed_mime_types: bucket.allowed_mime_types,
  };
  const res = await fetch(`${MGMT_API}/projects/${projectRef}/storage/buckets`, {
    method: "POST",
    headers: headers(),
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
    try {
      configResult = await createStorageBucket(targetRef, bucket);
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
  status: "replicated" | "skipped" | "failed";
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
    // Escape single quotes for embedding into SQL literals.
    const q = (s: string) => s.replace(/'/g, "''");
    try {
      // Unschedule any existing job with the same name (silently) then re-schedule.
      await runSqlOnProject(
        cloneRef,
        `do $$ begin
           perform cron.unschedule('${q(job.jobname)}');
         exception when others then null; end $$;
         select cron.schedule('${q(job.jobname)}', '${q(job.schedule)}', $cronbody$${command}$cronbody$);
         ${job.active ? "" : `update cron.job set active = false where jobname = '${q(job.jobname)}';`}`,
      );
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
 */
export async function enforceRequiredExtensions(
  projectRef: string,
  primeRef?: string | null,
): Promise<RequiredExtensionResult[]> {
  const primeNames = primeRef ? await fetchProjectExtensionNames(primeRef) : [];
  const wanted = resolveRequiredExtensions(primeNames);
  const results: RequiredExtensionResult[] = [];
  for (const name of wanted) {
    try {
      const rows = (await runSqlOnProject(
        projectRef,
        `select 1 as present from pg_extension where extname = ${sqlLiteral(name)}`,
      )) as Array<{ present?: number }> | null;
      const present = Array.isArray(rows) && rows.length > 0;
      await runSqlOnProject(
        projectRef,
        `create extension if not exists ${quoteExtensionIdent(name)};`,
      );
      results.push({ name, status: present ? "already_present" : "installed" });
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
): Promise<RealtimeReplicationResult> {
  if (primeTables.length === 0) {
    return { status: "skipped", added: [], failures: [] };
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
      failures: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const added: RealtimePublicationTable[] = [];
  const failures: Array<RealtimePublicationTable & { error: string }> = [];
  for (const t of primeTables) {
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
    status: failures.length === 0 ? "replicated" : added.length > 0 ? "partial" : "failed",
    added,
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
): Promise<{ results: PrimeMigrationResult[]; latestApplied: string | null }> {
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

  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i];
    if (applied.has(m.id)) {
      results.push({ id: m.id, name: m.name, success: true, skipped: true });
      latestApplied = m.id;
      continue;
    }
    await onStatusUpdate?.("migrating", `Applying migration ${i + 1}/${ordered.length}: ${m.name}`);
    try {
      // Resolved here, inside the loop and after the `applied` check above, so
      // a clone that is level pays for no bodies at all. A migration with
      // neither an inline body nor a resolver is a programming error rather
      // than a migration failure, but it is reported through the same channel
      // so it lands in `migrations_applied` where an operator will see it.
      const sql = m.sql ?? (loadSql ? await loadSql({ id: m.id, name: m.name }) : undefined);
      if (sql === undefined) {
        throw new Error(`No SQL available for migration ${m.name} and no loader was provided`);
      }
      await runSqlOnProject(projectRef, sql);
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

  return { results, latestApplied };
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
): Promise<EdgeFunctionDeployResult[]> {
  const results: EdgeFunctionDeployResult[] = [];
  for (let i = 0; i < functions.length; i++) {
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
  | "derived";

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
): Promise<SecretShellResult[]> {
  if (names.length === 0) return [];

  const { toWrite, results } = planCloneSecrets(
    names,
    inheritedValues,
    () => crypto.randomBytes(32).toString("hex"),
    origins ?? null,
    dedicatedNames,
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
  const res = await fetch(`${MGMT_API}/projects/${projectRef}/secrets`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify([{ name, value }]),
  });
  if (!res.ok) {
    return { ok: false, error: `secrets API ${res.status} — ${(await res.text()).slice(0, 300)}` };
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
 * Seed an admin user into the clone's backend using the Management API.
 * Creates the user via the Auth Admin API and inserts their admin role.
 */
export async function seedAdminUser(
  projectRef: string,
  serviceRoleKey: string,
  projectUrl: string,
  adminEmail: string,
  adminPassword: string,
): Promise<{ userId: string | null }> {
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

  if (!createRes.ok) {
    const body = await createRes.text();
    // Resume path: the admin may already exist from a previous attempt
    if (createRes.status === 422 || /already.*(registered|exists)/i.test(body)) {
      return { userId: null };
    }
    throw new Error(`Failed to create admin user: ${createRes.status} — ${body}`);
  }

  const user = await createRes.json();
  const userId = user.id;

  // Best-effort super_admin grant: the clone's schema is whatever the prime
  // repo defines, so only insert if a user_roles table actually exists, and
  // never let a role-model mismatch fail the whole provisioning run.
  await runSqlOnProject(
    projectRef,
    `
DO $$ BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    EXECUTE format(
      'INSERT INTO public.user_roles (user_id, role) VALUES (%L, %L) ON CONFLICT DO NOTHING',
      '${userId}'::uuid, 'super_admin'
    );
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'aurixa: admin role seed skipped: %', SQLERRM;
END $$;
    `.trim(),
  );

  return { userId };
}

// ─── Full Provisioning Pipeline ──────────────────────────────────────

export type ProvisionBackendInput = {
  cloneName: string;
  region?: string;
  adminEmail: string;
  adminPassword: string;
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
  }

  // Step 2: Wait for it to be ready
  await onStatusUpdate?.("provisioning", "Waiting for project to become healthy...");
  await waitForProjectReady(projectRef);

  // Step 3: Get API keys
  await onStatusUpdate?.("provisioning", "Retrieving API keys...");
  const { anonKey, serviceRoleKey } = selectProjectKeys(await getProjectApiKeys(projectRef));
  if (!anonKey || !serviceRoleKey) {
    throw new Error("Could not retrieve client/privileged API keys from new project");
  }

  const projectUrl = getProjectUrl(projectRef);

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
    await onStatusUpdate?.("migrating", "Introspecting the prime's live catalog...");
    const { replicateSchemaByIntrospection, stampMigrationLedgerFromPrime, verifyCloneIsEmpty } =
      await import("./schema-introspection.server");
    const primeRef = input.primeBackendRef;
    const result = await replicateSchemaByIntrospection(projectRef, {
      primeRef,
      onStatusUpdate,
    });
    const emptiness = await verifyCloneIsEmpty(projectRef, { allowRows: 0 }).catch(() => null);
    introspection = {
      ok: result.ok,
      stages: result.stages,
      shortStages: result.shortStages,
      rowsOnClone: emptiness?.totalRows ?? null,
      nonEmptyTables: emptiness?.nonEmpty.map((t) => t.table).slice(0, 20) ?? [],
    };
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
      `Catalog introspection reconciled; stamped ${stamp.stamped} migration ID(s)`,
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

  // Step 4b (G4): guarantee required extensions are enabled before anything
  // downstream (edge fns, cron, webhook fanout, vault-backed cron auth) tries
  // to use them. Non-fatal per extension — surfaced in the parity report.
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

  // Step 5: Deploy the prime's edge functions (non-fatal per function)
  const edgeFunctions = await deployEdgeFunctions(projectRef, snapshot.functions, onStatusUpdate);

  // Step 5b: Replicate storage bucket configuration from the prime. Migrations
  // already replayed the row-level policies on `storage.objects`, but those
  // policies only match if the buckets themselves exist — otherwise every
  // signed-URL / upload path silently 404s on the clone. Non-fatal: we
  // surface per-bucket errors so operators can retry from the clone page.
  let storageBuckets: BucketReplicationResult[] = [];
  try {
    const primeRef = input.primeBackendRef;
    await onStatusUpdate?.("migrating", "Replicating storage buckets + seed assets from prime...");
    storageBuckets = await replicateStorageBuckets(primeRef, projectRef);
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

  // Step 5c: Replicate the prime's [auth] policy (site URL, redirect allow-list,
  // JWT expiry, signup + password rules). Non-fatal — surface the result so
  // operators can retry from the clone page if the Management API rejects it.
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

  let cronJobs: CronJobReplicationResult[] = [];
  try {
    const primeRef = input.primeBackendRef;
    await onStatusUpdate?.("migrating", "Replicating pg_cron schedule from prime...");
    const primeJobs = await fetchPrimeCronJobs(primeRef);
    const primeKeys = selectProjectKeys(await getProjectApiKeys(primeRef).catch(() => []));
    cronJobs = await replicateCronJobs(projectRef, primeRef, primeJobs, {
      primeAnonKey: primeKeys.anonKey,
      cloneAnonKey: anonKey,
    });
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

  // Step 5e (G4): mirror the prime's realtime publication membership so
  // channels subscribing to the same tables continue to receive INSERT /
  // UPDATE / DELETE payloads on the clone. Non-fatal per table.
  let realtimePublication: RealtimeReplicationResult = {
    status: "skipped",
    added: [],
    failures: [],
  };
  try {
    const primeRef = input.primeBackendRef;
    await onStatusUpdate?.("migrating", "Replicating realtime publication from prime...");
    const primeTables = await fetchRealtimePublicationTables(primeRef);
    realtimePublication = await replicateRealtimePublication(projectRef, primeTables);
    if (realtimePublication.status === "partial" || realtimePublication.status === "failed") {
      await onStatusUpdate?.(
        "migrating",
        `Realtime publication ${realtimePublication.status}: ${realtimePublication.added.length}/${primeTables.length} table(s) added, ${realtimePublication.failures.length} failure(s)`,
      );
    }
  } catch (err) {
    realtimePublication = {
      status: "failed",
      added: [],
      failures: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

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
  );

  // Step 7: Seed admin
  await onStatusUpdate?.("seeding_admin", "Creating admin user...");
  const { userId: adminUserId } = await seedAdminUser(
    projectRef,
    serviceRoleKey,
    projectUrl,
    input.adminEmail,
    input.adminPassword,
  );

  return {
    projectRef,
    projectUrl,
    anonKey,
    serviceRoleKey,
    dbPass,
    adminUserId,
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
  };
}

function generateSecurePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  const length = 32;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
