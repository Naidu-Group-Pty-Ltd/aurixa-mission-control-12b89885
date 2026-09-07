/**
 * Write a clone's link back to Mission Control — the URL, its API key, its
 * agency name and its webhook secret — into the function environment that
 * reads them, and keep the readable halves (the key's delivery record, the
 * endpoint row) in Mission Control's own database. The rules and the
 * measurement are in `missionControlLink.pure.ts`.
 *
 * ## The rule that governs the write
 *
 * **The ref that is written is the ref the key is recorded against.** Every
 * environment write takes the one `projectRef` from `resolveCloneSecretTarget`
 * (or, at provisioning, the ref the pipeline is building), and the key row is
 * stamped `delivered_project_ref` with that same ref — so "is this project
 * linked" is a fact the next pass can read rather than guess.
 *
 * The key's plaintext exists once, at mint, and travels only to the secrets
 * batch of the provisioning pass that minted it; the recorded outcome carries
 * its PREFIX, which is what the product already shows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_SCOPES } from "@/lib/clone-api-scopes";
import {
  resolveCloneSecretTarget,
  CloneSecretTargetError,
  type CloneSecretTarget,
} from "./cloneAllowedOrigins.server";
import type { CloneSecretRefusal } from "./cloneSecretTarget.pure";
import {
  ENV_MISSION_CONTROL_AGENCY_NAME,
  ENV_MISSION_CONTROL_CLONE_API_KEY,
  ENV_MISSION_CONTROL_URL,
  ENV_MISSION_CONTROL_WEBHOOK_SECRET,
  MISSION_CONTROL_LINK_ENV_NAMES,
  MISSION_CONTROL_LINK_KEY_LABEL,
  decideMissionControlLinkRepair,
  planMissionControlLink,
  resolveMissionControlOrigin,
  type LinkKeyFact,
  type MissionControlLinkRepairSkip,
} from "./missionControlLink.pure";

type Db = SupabaseClient<Database>;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const MISSION_CONTROL_LINK_EVENT_ACTION = "set_mission_control_link";

/** What is recorded and reported. The key appears only as its prefix. */
export type MissionControlLinkOutcome = {
  keyMinted: boolean;
  keyPrefix: string | null;
  keysRevoked: number;
  endpoint: "created" | "updated" | "reused";
  envNames: string[];
  why: string[];
};

export type EnsureMissionControlLinkResult =
  | { ok: true; outcome: MissionControlLinkOutcome; /** In-process only. Never log. */ values: Record<string, string> }
  | {
      ok: false;
      stage:
        | "keys_read"
        | "endpoint_read"
        | "endpoint_write"
        | "key_scope_write"
        | "key_write"
        | "env_write";
      error: string;
    };

/**
 * Bring one clone's link into agreement. Endpoint row first (its secret is the
 * readable half), then the key if one is owed, then the environment in ONE
 * request; the delivery stamp and any revocations follow the environment
 * write, never precede it.
 */
export async function ensureCloneMissionControlLink(
  supabase: Db,
  cloneId: string,
  projectRef: string,
  cloneName: string | null,
  opts?: { actorUserId?: string | null; now?: number },
): Promise<EnsureMissionControlLinkResult> {
  const now = opts?.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const { generateApiKey } = await import("./clone-api-keys.server");
  const { setCloneSecretValues } = await import("./backend-provisioning.server");

  const keysRes = await supabase
    .from("clone_api_keys")
    .select("id, label, scopes, revoked_at, revoke_at, delivered_project_ref, delivered_env_at")
    .eq("clone_id", cloneId);
  if (keysRes.error) return { ok: false, stage: "keys_read", error: keysRes.error.message };
  const keys: LinkKeyFact[] = (keysRes.data ?? []).map((k) => {
    const row = k as {
      id: string;
      label?: string | null;
      scopes?: string[] | null;
      revoked_at?: string | null;
      revoke_at?: string | null;
      delivered_project_ref?: string | null;
      delivered_env_at?: string | null;
    };
    return {
      id: row.id,
      label: row.label ?? null,
      scopes: row.scopes ?? [],
      revokedAt: row.revoked_at ?? null,
      revokeAt: row.revoke_at ?? null,
      deliveredProjectRef: row.delivered_project_ref ?? null,
      deliveredEnvAt: row.delivered_env_at ?? null,
    };
  });

  const epRes = await supabase
    .from("token_webhook_endpoints")
    .select("id, url, secret, is_active, events")
    .eq("clone_id", cloneId);
  if (epRes.error) return { ok: false, stage: "endpoint_read", error: epRes.error.message };
  const endpoints = (epRes.data ?? []) as Array<{
    id: string;
    url: string;
    secret: string;
    is_active: boolean;
    events: string[] | null;
  }>;

  const plan = planMissionControlLink({
    projectRef,
    cloneName,
    keys,
    endpoints: endpoints.map((e) => ({ id: e.id, url: e.url, isActive: e.is_active, events: e.events ?? [] })),
    now,
    defaultScopes: DEFAULT_SCOPES,
  });

  // The endpoint row FIRST: its secret is the half that can be read back.
  let webhookSecret: string;
  if (plan.endpoint.action === "create") {
    webhookSecret = randomBytes(32).toString("base64url");
    const { error: endpointErr } = await supabase
      .from("token_webhook_endpoints")
      .insert({
        clone_id: cloneId,
        url: plan.endpoint.url,
        secret: webhookSecret,
        events: plan.endpoint.events,
        is_active: true,
        created_by: opts?.actorUserId ?? null,
      })
      .select("id")
      .single();
    if (endpointErr) return { ok: false, stage: "endpoint_write", error: endpointErr.message };
  } else {
    const owned = endpoints.find((e) => e.id === plan.endpoint.id);
    if (!owned) return { ok: false, stage: "endpoint_read", error: "the planned endpoint row was not in the read" };
    webhookSecret = owned.secret;
    if (plan.endpoint.action === "update") {
      const { error: endpointErr } = await supabase
        .from("token_webhook_endpoints")
        .update({ url: plan.endpoint.url, events: plan.endpoint.events, is_active: true, updated_at: nowIso })
        .eq("id", owned.id);
      if (endpointErr) return { ok: false, stage: "endpoint_write", error: endpointErr.message };
    }
  }

  /*
   * Widen a live link key onto the current defaults BEFORE anything else
   * touches it. This is not a rotation: the value is unchanged, nothing is
   * re-delivered, and the clone's environment does not move — so it is safe on
   * a key that is already in service, which is exactly the key that needs it.
   *
   * It fails loudly rather than quietly, because the failure it prevents is a
   * key that authenticates and is then refused for scope — which reads to an
   * operator like a bad credential and sends them to rotate a good one.
   */
  for (const grant of plan.grantScopes) {
    const existing = keys.find((k) => k.id === grant.keyId);
    const { error: scopeErr } = await supabase
      .from("clone_api_keys")
      .update({ scopes: Array.from(new Set([...(existing?.scopes ?? []), ...grant.add])) })
      .eq("id", grant.keyId);
    if (scopeErr) return { ok: false, stage: "key_scope_write", error: scopeErr.message };
  }

  // Then the key, only where none is delivered here.
  let minted: { id: string; raw: string; prefix: string } | null = null;
  if (plan.mintKey) {
    const { raw, hash, prefix } = generateApiKey();
    const { data: keyRow, error: keyErr } = await supabase
      .from("clone_api_keys")
      .insert({
        clone_id: cloneId,
        label: MISSION_CONTROL_LINK_KEY_LABEL,
        scopes: DEFAULT_SCOPES,
        key_hash: hash,
        key_prefix: prefix,
        created_by: opts?.actorUserId ?? null,
        delivered_project_ref: projectRef,
        delivered_env_at: null,
      })
      .select("id")
      .single();
    if (keyErr || !keyRow) {
      return { ok: false, stage: "key_write", error: keyErr?.message ?? "insert returned no row" };
    }
    minted = { id: keyRow.id, raw, prefix };
  }

  const values: Record<string, string> = {
    [ENV_MISSION_CONTROL_URL]: resolveMissionControlOrigin(process.env),
    [ENV_MISSION_CONTROL_WEBHOOK_SECRET]: webhookSecret,
  };
  if (plan.agencyName) values[ENV_MISSION_CONTROL_AGENCY_NAME] = plan.agencyName;
  if (minted) values[ENV_MISSION_CONTROL_CLONE_API_KEY] = minted.raw;

  const env = await setCloneSecretValues(
    projectRef,
    Object.entries(values).map(([name, value]) => ({ name, value })),
  );
  if (!env.ok) return { ok: false, stage: "env_write", error: env.error };

  let keysRevoked = 0;
  if (minted) {
    // Delivered — say so on the row, or the next pass mints again.
    const { error: stampErr } = await supabase
      .from("clone_api_keys")
      .update({ delivered_env_at: nowIso })
      .eq("id", minted.id);
    if (stampErr) {
      console.error("[mission_control_link] key delivered but not stamped", { cloneId, keyId: minted.id, error: stampErr.message });
    }
    if (plan.revokeKeyIds.length > 0) {
      const { error: revokeErr } = await supabase
        .from("clone_api_keys")
        .update({ revoked_at: nowIso })
        .in("id", plan.revokeKeyIds);
      if (revokeErr) {
        console.error("[mission_control_link] undelivered link keys not revoked", { cloneId, error: revokeErr.message });
      } else {
        keysRevoked = plan.revokeKeyIds.length;
      }
    }
    // The clone's own endpoint receives this, signed with the secret its
    // environment just got — the first delivery is the link's own proof.
    try {
      const { fireTokenWebhook } = await import("./token-webhooks.server");
      await fireTokenWebhook(
        "tokens.key.rotated",
        {
          event_reason: "mission_control_link",
          clone_id: cloneId,
          new_key_id: minted.id,
          new_key_prefix: minted.prefix,
          delivered_to: "function_environment",
        },
        cloneId,
      );
    } catch (e) {
      console.error("[mission_control_link] link webhook not fired", { cloneId, error: msg(e) });
    }
  }

  return {
    ok: true,
    values,
    outcome: {
      keyMinted: Boolean(minted),
      keyPrefix: minted?.prefix ?? null,
      keysRevoked,
      endpoint:
        plan.endpoint.action === "create" ? "created" : plan.endpoint.action === "update" ? "updated" : "reused",
      envNames: Object.keys(values),
      why: plan.why,
    },
  };
}

export type MissionControlLinkRepairFailure =
  | CloneSecretRefusal
  | "keys_read"
  | "endpoint_read"
  | "endpoint_write"
  | "key_scope_write"
  | "key_write"
  | "env_write";

export type MissionControlLinkRepairResult =
  | { ok: true; cloneId: string; projectRef: string; changed: boolean; outcome: MissionControlLinkOutcome }
  | { ok: true; cloneId: string; changed: false; skipped: MissionControlLinkRepairSkip }
  | { ok: false; cloneId: string; reason: MissionControlLinkRepairFailure; error: string };

/**
 * Repair one clone's link. Never throws for an expected refusal — the callers
 * are a cron sweep and an operator action.
 */
export async function repairCloneMissionControlLink(
  supabase: Db,
  cloneId: string,
  opts?: { actorUserId?: string | null; force?: boolean; now?: number },
): Promise<MissionControlLinkRepairResult> {
  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, cloneId, reason, error: msg(e) };
  }
  const projectRef = target.projectRef;

  if (!opts?.force) {
    const { data, error } = await supabase
      .from("clone_backend_secrets")
      .select("status, last_error, updated_at")
      .eq("clone_id", cloneId)
      .eq("name", ENV_MISSION_CONTROL_CLONE_API_KEY)
      .maybeSingle();
    // A read that FAILED is not a row that is ABSENT.
    if (error) return { ok: false, cloneId, reason: "unreadable", error: `Could not read the ledger: ${error.message}` };
    const row = data as { status?: string | null; last_error?: string | null; updated_at?: string | null } | null;
    const verdict = decideMissionControlLinkRepair({
      projectRef,
      ledgerStatus: row?.status ?? null,
      lastError: row?.last_error ?? null,
      updatedAt: row?.updated_at ?? null,
      now: opts?.now ?? Date.now(),
    });
    if (!verdict.act) return { ok: true, cloneId, changed: false, skipped: verdict.reason };
  }

  const res = await ensureCloneMissionControlLink(supabase, cloneId, projectRef, target.cloneName, {
    actorUserId: opts?.actorUserId ?? null,
    now: opts?.now,
  });
  const now = new Date().toISOString();
  const names = res.ok ? res.outcome.envNames : [...MISSION_CONTROL_LINK_ENV_NAMES];
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    names.map((name) => ({
      clone_id: cloneId,
      name,
      status: res.ok ? "set" : "failed",
      last_set_at: res.ok ? now : null,
      last_error: res.ok ? null : `${res.stage}: ${res.error}`,
      set_by: opts?.actorUserId ?? null,
    })),
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[mission_control_link] written but tracking rows not updated", { cloneId, projectRef, error: trackErr.message });
  }

  await recordEvent(supabase, cloneId, res.ok, res.ok ? null : `${res.stage}: ${res.error}`, res.ok ? res.outcome : null, opts?.actorUserId);

  if (!res.ok) return { ok: false, cloneId, reason: res.stage, error: res.error };
  return {
    ok: true,
    cloneId,
    projectRef,
    changed: res.outcome.keyMinted || res.outcome.endpoint !== "reused",
    outcome: res.outcome,
  };
}

async function recordEvent(
  supabase: Db,
  cloneId: string,
  success: boolean,
  errorMessage: string | null,
  outcome: MissionControlLinkOutcome | null,
  actorUserId?: string | null,
): Promise<void> {
  // The prefix and the reasons; never the key, never the webhook secret.
  const { error } = await supabase.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: "supabase",
    action: MISSION_CONTROL_LINK_EVENT_ACTION,
    success,
    error_message: errorMessage,
    actor_user_id: actorUserId ?? null,
    result: outcome ?? {},
  });
  if (error) {
    console.error("[mission_control_link] could not record deployment_event", { cloneId, error: error.message });
  }
}

export type MissionControlLinkReconcileResult = {
  considered: number;
  linked: number;
  alreadyLinked: number;
  skipped: Record<string, number>;
  refused: { cloneId: string; reason: MissionControlLinkRepairFailure }[];
};

/** Carry every clone whose link is missing, undelivered, or pointing at a project it no longer has. */
export async function reconcileCloneMissionControlLinks(
  supabase: Db,
  opts: { now?: number } = {},
): Promise<MissionControlLinkReconcileResult> {
  const now = opts.now ?? Date.now();

  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const candidates = (data ?? [])
    .map((r) => r as { clone_id: string | null })
    .filter((r): r is { clone_id: string } => typeof r.clone_id === "string" && r.clone_id.length > 0);

  const out: MissionControlLinkReconcileResult = {
    considered: candidates.length,
    linked: 0,
    alreadyLinked: 0,
    skipped: {},
    refused: [],
  };

  for (const c of candidates) {
    const res = await repairCloneMissionControlLink(supabase, c.clone_id, { now });
    if (!res.ok) {
      out.refused.push({ cloneId: c.clone_id, reason: res.reason });
    } else if ("skipped" in res) {
      out.skipped[res.skipped] = (out.skipped[res.skipped] ?? 0) + 1;
    } else if (res.changed) {
      out.linked += 1;
    } else {
      out.alreadyLinked += 1;
    }
  }
  return out;
}
