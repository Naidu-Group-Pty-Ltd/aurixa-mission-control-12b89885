/**
 * Step 5h of provisioning: connect one clone to the mobile gateway and the
 * release registry. The SAME function runs at birth and from the reconcile
 * sweep, so a clone born before this existed converges through the identical
 * code path rather than a second "injection" — there are no orphans to find
 * later. What it decides is in `gatewayPlan.pure.ts`; this only performs it.
 *
 * Written, in order:
 *
 *   1. the `clone_mobile_gateways` row (gateway id, credential hash, licences);
 *   2. the six `clone_mobile_release_subscriptions` rows;
 *   3. the clone's environment — credential, gateway id, issuer, JWKS URL and
 *      gateway origin — through `setCloneSecretValues`, which sends only what
 *      changed;
 *   4. the delivery stamp, so the next pass reuses rather than re-mints;
 *   5. the seeded superadmin's Command Centre grant, `issuable`: it exists, and
 *      nothing has been sent.
 *
 * The credential's plaintext exists once, here, and goes only to the secrets
 * batch. Every record carries its prefix.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { cloneIssuerUrl, jwksUrl } from "../anthropicOidc.server";
import { resolveCloneSecretTarget, CloneSecretTargetError } from "../cloneAllowedOrigins.server";
import type { CloneSecretRefusal } from "../cloneSecretTarget.pure";
import { recordSecretLedger } from "../secretLedger.server";
import {
  ENV_MOBILE_CREDENTIAL,
  ENV_MOBILE_GATEWAY_ID,
  ENV_MOBILE_GATEWAY_ORIGIN,
  ENV_MOBILE_ISSUER,
  ENV_MOBILE_JWKS_URL,
  GATEWAY_ID_PREFIX,
  MOBILE_GATEWAY_ENV_NAMES,
  planCloneMobileGateway,
  principalRefForEmail,
  type ExistingGateway,
  type GatewayPlan,
} from "./gatewayPlan.pure";
import { licensedPortalsFor, MOBILE_GATEWAY_ORIGIN } from "./portals.pure";
import {
  credentialDisplayPrefix,
  newCloneMobileCredential,
  newGrantRef,
  randomToken,
  sha256Hex,
} from "./tickets.pure";

type Db = SupabaseClient<Database>;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const MOBILE_GATEWAY_EVENT_ACTION = "set_mobile_gateway";

/** The gateway origin, overridable for staging. */
export function mobileGatewayOrigin(): string {
  return (process.env.MOBILE_GATEWAY_ORIGIN ?? MOBILE_GATEWAY_ORIGIN).trim().replace(/\/+$/, "");
}

/** The key set a clone verifies activation assertions against. */
export function mobileJwksUrl(): string {
  return `${mobileGatewayOrigin()}/api/public/mobile/jwks`;
}

export type MobileGatewayOutcome = {
  gatewayId: string;
  credentialMinted: boolean;
  credentialPrefix: string | null;
  licensedPortals: string[];
  subscriptionsCreated: number;
  subscriptionsUpdated: number;
  superadminGrant: "created" | "existing" | "waiting";
  envNames: string[];
  envWritten: string[];
  envUnchanged: string[];
  frozen: boolean;
  why: string[];
};

export type EnsureMobileGatewayStage =
  | "read"
  | "row_write"
  | "subscriptions_write"
  | "env_write"
  | "stamp_write"
  | "grant_write";

export type EnsureMobileGatewayResult =
  | { ok: true; outcome: MobileGatewayOutcome }
  | { ok: false; stage: EnsureMobileGatewayStage; error: string };

/**
 * Bring one clone's gateway connection into agreement with `projectRef`.
 * Idempotent: a converged clone reads, decides "already converged", and still
 * re-sends the non-secret names only if the project lost them.
 */
export async function ensureCloneMobileGateway(
  supabase: Db,
  cloneId: string,
  projectRef: string,
  opts: {
    adminEmail?: string | null;
    actorUserId?: string | null;
    now?: number;
    /**
     * True only from provisioning. A row the sweep creates is a clone born
     * before the gateway existed: it gets no fresh fourteen-day trial (that
     * would hand an established workspace a free fortnight it never had), so
     * it is marked legacy and needs a verified payment or an exception.
     */
    atBirth?: boolean;
  } = {},
): Promise<EnsureMobileGatewayResult> {
  if (!projectRef)
    return { ok: false, stage: "read", error: "No project ref — the backend is not persisted yet" };
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();

  // ── read ──────────────────────────────────────────────────────────────────
  const [cloneRes, gwRes, subsRes, grantRes, backendRes] = await Promise.all([
    supabase.from("clones").select("id, entitlement_keys").eq("id", cloneId).maybeSingle(),
    supabase
      .from("clone_mobile_gateways")
      .select("gateway_id, status, delivered_project_ref, delivered_env_at, licensed_portals")
      .eq("clone_id", cloneId)
      .maybeSingle(),
    supabase
      .from("clone_mobile_release_subscriptions")
      .select("portal, enabled")
      .eq("clone_id", cloneId),
    supabase
      .from("mobile_access_grants")
      .select("id")
      .eq("clone_id", cloneId)
      .eq("portal", "command-centre")
      .eq("principal_kind", "superadmin")
      .neq("status", "revoked")
      .limit(1),
    opts.adminEmail
      ? Promise.resolve({ data: null, error: null })
      : supabase.from("clone_backends").select("admin_email").eq("clone_id", cloneId).maybeSingle(),
  ]);
  // A read that FAILED is not a row that is ABSENT.
  for (const r of [cloneRes, gwRes, subsRes, grantRes, backendRes]) {
    if (r.error) return { ok: false, stage: "read", error: r.error.message };
  }
  if (!cloneRes.data) return { ok: false, stage: "read", error: `Clone ${cloneId} not found` };

  const gateway = gwRes.data as (ExistingGateway & { gateway_id: string }) | null;
  const adminEmail =
    opts.adminEmail ??
    (backendRes.data as { admin_email?: string | null } | null)?.admin_email ??
    null;

  const plan: GatewayPlan = planCloneMobileGateway({
    projectRef,
    gateway,
    subscriptions: (subsRes.data ?? []) as { portal: string; enabled: boolean }[],
    licensedPortals: licensedPortalsFor(
      (cloneRes.data as { entitlement_keys?: string[] | null }).entitlement_keys ?? [],
    ),
    hasLiveSuperadminGrant: (grantRes.data ?? []).length > 0,
    adminEmail,
  });

  if (plan.frozen && gateway) {
    return {
      ok: true,
      outcome: {
        gatewayId: gateway.gateway_id,
        credentialMinted: false,
        credentialPrefix: null,
        licensedPortals: plan.licensedPortals,
        subscriptionsCreated: 0,
        subscriptionsUpdated: 0,
        superadminGrant: (grantRes.data ?? []).length > 0 ? "existing" : "waiting",
        envNames: [],
        envWritten: [],
        envUnchanged: [],
        frozen: true,
        why: plan.why,
      },
    };
  }

  // ── 1. the row ───────────────────────────────────────────────────────────
  const gatewayId = gateway?.gateway_id ?? randomToken(GATEWAY_ID_PREFIX, 12);
  let minted: { raw: string; prefix: string } | null = null;
  if (plan.mintCredential) {
    const raw = newCloneMobileCredential();
    minted = { raw, prefix: credentialDisplayPrefix(raw) };
    const hash = await sha256Hex(raw);
    const fields = {
      credential_prefix: minted.prefix,
      credential_hash: hash,
      delivered_project_ref: projectRef,
      delivered_env_at: null,
      licensed_portals: plan.licensedPortals,
    };
    if (plan.createRow) {
      const { error: insertError } = await supabase.from("clone_mobile_gateways").insert({
        clone_id: cloneId,
        gateway_id: gatewayId,
        ...fields,
        trial_started_at: nowIso,
        legacy_clone: opts.atBirth !== true,
      });
      if (insertError) return { ok: false, stage: "row_write", error: insertError.message };
    } else {
      const { error: updateError } = await supabase
        .from("clone_mobile_gateways")
        .update(fields)
        .eq("clone_id", cloneId);
      if (updateError) return { ok: false, stage: "row_write", error: updateError.message };
    }
  } else if (plan.updateLicences) {
    const { error } = await supabase
      .from("clone_mobile_gateways")
      .update({ licensed_portals: plan.licensedPortals })
      .eq("clone_id", cloneId);
    if (error) return { ok: false, stage: "row_write", error: error.message };
  }

  // ── 2. subscriptions ─────────────────────────────────────────────────────
  if (plan.insertSubscriptions.length) {
    // ignoreDuplicates: a concurrent pass that got there first keeps its
    // channel, which is the operator's to choose.
    const { error } = await supabase.from("clone_mobile_release_subscriptions").upsert(
      plan.insertSubscriptions.map((s) => ({
        clone_id: cloneId,
        portal: s.portal,
        enabled: s.enabled,
      })),
      { onConflict: "clone_id,portal", ignoreDuplicates: true },
    );
    if (error) return { ok: false, stage: "subscriptions_write", error: error.message };
  }
  for (const s of plan.updateSubscriptions) {
    const { error } = await supabase
      .from("clone_mobile_release_subscriptions")
      .update({ enabled: s.enabled })
      .eq("clone_id", cloneId)
      .eq("portal", s.portal);
    if (error) return { ok: false, stage: "subscriptions_write", error: error.message };
  }

  // ── 3. the environment ───────────────────────────────────────────────────
  // The non-secret names are always in the batch: `setCloneSecretValues`
  // compares digests and sends only what the project does not already hold,
  // so a converged clone costs no redeploy.
  const values: Record<string, string> = {
    [ENV_MOBILE_GATEWAY_ID]: gatewayId,
    [ENV_MOBILE_ISSUER]: cloneIssuerUrl(),
    [ENV_MOBILE_JWKS_URL]: jwksUrlForClones(),
    [ENV_MOBILE_GATEWAY_ORIGIN]: mobileGatewayOrigin(),
  };
  if (minted) values[ENV_MOBILE_CREDENTIAL] = minted.raw;
  const { setCloneSecretValues } = await import("../backend-provisioning.server");
  const env = await setCloneSecretValues(
    projectRef,
    Object.entries(values).map(([name, value]) => ({ name, value })),
  );
  if (!env.ok) return { ok: false, stage: "env_write", error: env.error };

  // ── 4. the stamp ─────────────────────────────────────────────────────────
  if (minted) {
    const { error } = await supabase
      .from("clone_mobile_gateways")
      .update({ delivered_env_at: nowIso })
      .eq("clone_id", cloneId);
    // Delivered but unstamped re-mints next pass — wasteful, never wrong.
    if (error) return { ok: false, stage: "stamp_write", error: error.message };
  }

  // ── 5. the superadmin's grant ────────────────────────────────────────────
  let superadminGrant: MobileGatewayOutcome["superadminGrant"] = (grantRes.data ?? []).length
    ? "existing"
    : "waiting";
  if (plan.createSuperadminGrant && adminEmail) {
    const { error } = await supabase.from("mobile_access_grants").insert({
      grant_ref: newGrantRef(),
      clone_id: cloneId,
      portal: "command-centre",
      principal_kind: "superadmin",
      principal_ref: principalRefForEmail(adminEmail),
      principal_email: adminEmail.trim().toLowerCase(),
      status: "issuable",
      created_by: opts.actorUserId ?? null,
    });
    // 23505: the partial unique index — a concurrent pass made it first.
    if (error && error.code !== "23505")
      return { ok: false, stage: "grant_write", error: error.message };
    superadminGrant = error ? "existing" : "created";
  }

  return {
    ok: true,
    outcome: {
      gatewayId,
      credentialMinted: Boolean(minted),
      credentialPrefix: minted?.prefix ?? null,
      licensedPortals: plan.licensedPortals,
      subscriptionsCreated: plan.insertSubscriptions.length,
      subscriptionsUpdated: plan.updateSubscriptions.length,
      superadminGrant,
      envNames: Object.keys(values),
      envWritten: env.written,
      envUnchanged: env.unchanged,
      frozen: false,
      why: plan.why,
    },
  };
}

/**
 * The JWKS a clone verifies against. The gateway's own route republishes the
 * federation key set, so a clone never needs to know which product the signer
 * also serves; until the gateway host is allocated the federation URL is
 * the same keys.
 */
function jwksUrlForClones(): string {
  return process.env.MOBILE_GATEWAY_ORIGIN || process.env.MOBILE_GATEWAY_LIVE === "true"
    ? mobileJwksUrl()
    : jwksUrl();
}

export type MobileGatewayRepairResult =
  | {
      ok: true;
      cloneId: string;
      projectRef: string;
      changed: boolean;
      outcome: MobileGatewayOutcome;
    }
  | {
      ok: false;
      cloneId: string;
      reason: CloneSecretRefusal | EnsureMobileGatewayStage;
      error: string;
    };

/** One clone, from the sweep or an operator. Never throws for an expected refusal. */
export async function repairCloneMobileGateway(
  supabase: Db,
  cloneId: string,
  opts: { actorUserId?: string | null; now?: number } = {},
): Promise<MobileGatewayRepairResult> {
  let projectRef: string;
  try {
    projectRef = (await resolveCloneSecretTarget(supabase, cloneId)).projectRef;
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, cloneId, reason, error: msg(e) };
  }

  const res = await ensureCloneMobileGateway(supabase, cloneId, projectRef, opts);
  if (res.ok && res.outcome.envWritten.length) {
    const trackErr = await recordSecretLedger(supabase, {
      cloneId,
      names: res.outcome.envNames,
      result: { ok: true, written: res.outcome.envWritten, unchanged: res.outcome.envUnchanged },
      status: "set",
      setBy: opts.actorUserId ?? null,
      now: new Date().toISOString(),
    });
    if (trackErr)
      console.error("[mobile_gateway] written but ledger not updated", {
        cloneId,
        error: trackErr,
      });
  } else if (!res.ok) {
    const trackErr = await recordSecretLedger(supabase, {
      cloneId,
      names: [...MOBILE_GATEWAY_ENV_NAMES],
      result: { ok: false, error: `${res.stage}: ${res.error}` },
      status: "set",
      setBy: opts.actorUserId ?? null,
      now: new Date().toISOString(),
    });
    if (trackErr)
      console.error("[mobile_gateway] failure not recorded in ledger", {
        cloneId,
        error: trackErr,
      });
  }

  const changed =
    res.ok &&
    (res.outcome.credentialMinted ||
      res.outcome.subscriptionsCreated > 0 ||
      res.outcome.subscriptionsUpdated > 0 ||
      res.outcome.superadminGrant === "created" ||
      res.outcome.envWritten.length > 0);
  // A converged pass records nothing: a sweep that writes an event per clone
  // per run buries the one that matters.
  if (!res.ok || changed) {
    await recordEvent(supabase, cloneId, res, opts.actorUserId);
  }
  if (!res.ok) return { ok: false, cloneId, reason: res.stage, error: res.error };
  return { ok: true, cloneId, projectRef, changed, outcome: res.outcome };
}

async function recordEvent(
  supabase: Db,
  cloneId: string,
  res: EnsureMobileGatewayResult,
  actorUserId?: string | null,
): Promise<void> {
  // The prefix and the reasons; never the credential.
  const { error } = await supabase.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: "supabase",
    action: MOBILE_GATEWAY_EVENT_ACTION,
    success: res.ok,
    error_message: res.ok ? null : `${res.stage}: ${res.error}`,
    actor_user_id: actorUserId ?? null,
    result: res.ok ? res.outcome : {},
  });
  if (error)
    console.error("[mobile_gateway] could not record deployment_event", {
      cloneId,
      error: error.message,
    });
}

export type MobileGatewayReconcileResult = {
  considered: number;
  converged: number;
  changed: number;
  refused: { cloneId: string; reason: string }[];
};

/** Every clone with a live backend, through the same function birth uses. */
export async function reconcileCloneMobileGateways(
  supabase: Db,
  opts: { now?: number } = {},
): Promise<MobileGatewayReconcileResult> {
  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);
  const ids = (data ?? [])
    .map((r) => (r as { clone_id: string | null }).clone_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const out: MobileGatewayReconcileResult = {
    considered: ids.length,
    converged: 0,
    changed: 0,
    refused: [],
  };
  for (const id of ids) {
    const res = await repairCloneMobileGateway(supabase, id, { now: opts.now });
    if (!res.ok) out.refused.push({ cloneId: id, reason: res.reason });
    else if (res.changed) out.changed += 1;
    else out.converged += 1;
  }
  return out;
}

/**
 * Withdraw the clone's gateway: the row is revoked, every live grant with it.
 * Only what this module minted is touched — the credential is invalidated by
 * the row's status (the clone keeps a dead value it can no longer use), and
 * grants are matched by clone, never by anything a caller names.
 */
export async function revokeCloneMobileGateway(
  supabase: Db,
  cloneId: string,
  reason: string,
  opts: { now?: number } = {},
): Promise<{ ok: true; grantsRevoked: number } | { ok: false; error: string }> {
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  const { error: gwErr } = await supabase
    .from("clone_mobile_gateways")
    .update({ status: "revoked", revoked_at: nowIso })
    .eq("clone_id", cloneId);
  if (gwErr) return { ok: false, error: gwErr.message };
  const { data, error } = await supabase
    .from("mobile_access_grants")
    .update({ status: "revoked", revoked_at: nowIso, revoked_reason: reason })
    .eq("clone_id", cloneId)
    .neq("status", "revoked")
    .select("id");
  if (error) return { ok: false, error: error.message };
  return { ok: true, grantsRevoked: (data ?? []).length };
}
