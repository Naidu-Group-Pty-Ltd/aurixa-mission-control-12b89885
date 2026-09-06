/**
 * Re-derive and write every deployment-config secret Mission Control can
 * compute for a clone — `PUBLIC_APP_URL`, the WebAuthn relying party, the
 * web-push host, the Mission Control URL and agency name — from the clone's
 * CURRENT origins and name.
 *
 * ## Why this exists beside the provisioning batch
 *
 * `planCloneSecrets` derives the same names at provisioning, from whatever
 * origins the clone has at that moment — which, before its deployment is
 * live, is usually the hosting provider's own hostname. The moment the custom
 * domain goes live the right values change, and nothing re-derived them: a
 * clone kept `https://<project>.vercel.app` as its public URL in every invite
 * email, and its passkeys were bound to a relying party it no longer served.
 * `applyCloneAllowedOrigins` already covered ONE of these names at that
 * moment; this covers the rest, from the same origins resolver, so the CORS
 * allow-list, the auth redirect list and the public URL cannot disagree.
 *
 * Writes only what has moved since its own last write (read from the event it
 * records), never a value an operator set by hand for a name it does not own,
 * and only through `resolveCloneSecretTarget`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  ALLOWED_ORIGINS_SECRET,
  CloneSecretTargetError,
  resolveCloneOrigins,
  resolveCloneSecretTarget,
  type CloneSecretTarget,
} from "./cloneAllowedOrigins.server";
import type { CloneSecretRefusal } from "./cloneSecretTarget.pure";
import { resolveMissionControlOrigin } from "./missionControlLink.pure";

type Db = SupabaseClient<Database>;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const DERIVED_CONFIG_EVENT_ACTION = "set_derived_deployment_config";

export type ApplyDerivedConfigResult =
  | { ok: true; cloneId: string; projectRef: string; written: string[]; changed: boolean }
  | {
      ok: false;
      cloneId: string;
      reason: CloneSecretRefusal | "nothing_derivable" | "write_failed";
      error: string;
    };

async function lastWrittenValues(supabase: Db, cloneId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from("deployment_events")
    .select("result")
    .eq("clone_id", cloneId)
    .eq("action", DERIVED_CONFIG_EVENT_ACTION)
    .eq("success", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A read that FAILED is not "never written" — see `lastWrittenValue` beside this.
  if (error) throw new Error(`Could not read the last derived-config write: ${error.message}`);
  const values = (data as { result?: { values?: unknown } | null } | null)?.result?.values;
  if (!values || typeof values !== "object") return {};
  return Object.fromEntries(
    Object.entries(values as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

/**
 * Derive and write the deployment config for one clone. Records the outcome
 * in the ledger and on the clone's timeline; never throws for an expected
 * refusal, because the callers are a webhook drain and a sweep.
 */
export async function applyCloneDerivedConfig(
  supabase: Db,
  cloneId: string,
  opts?: { actorUserId?: string | null; providerSlug?: string | null; force?: boolean },
): Promise<ApplyDerivedConfigResult> {
  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    const error = msg(e);
    await recordEvent(supabase, cloneId, opts?.providerSlug, false, error, null, opts?.actorUserId);
    return { ok: false, cloneId, reason, error };
  }

  const origins = await resolveCloneOrigins(supabase, cloneId);
  const { deriveDeploymentConfig, setCloneSecretValues } = await import("./backend-provisioning.server");
  const values = deriveDeploymentConfig(
    origins,
    { displayName: target.cloneName, missionControlOrigin: resolveMissionControlOrigin(process.env) },
    // Owned by `applyCloneAllowedOrigins`, which keeps its own record.
    { exclude: new Set([ALLOWED_ORIGINS_SECRET]) },
  );
  const names = Object.keys(values);
  if (names.length === 0) {
    const error = `Nothing derivable for clone ${cloneId}: no usable origin and no name.`;
    await recordEvent(supabase, cloneId, opts?.providerSlug, false, error, null, opts?.actorUserId);
    return { ok: false, cloneId, reason: "nothing_derivable", error };
  }

  let last: Record<string, string> = {};
  if (!opts?.force) {
    try {
      last = await lastWrittenValues(supabase, cloneId);
    } catch (e) {
      return { ok: false, cloneId, reason: "unreadable", error: msg(e) };
    }
  }
  const toWrite = names.filter((n) => opts?.force || last[n] !== values[n]);
  if (toWrite.length === 0) {
    return { ok: true, cloneId, projectRef: target.projectRef, written: [], changed: false };
  }

  const res = await setCloneSecretValues(
    target.projectRef,
    toWrite.map((name) => ({ name, value: values[name] })),
  );
  const now = new Date().toISOString();
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    toWrite.map((name) => ({
      clone_id: cloneId,
      name,
      status: res.ok ? "set" : "failed",
      last_set_at: res.ok ? now : null,
      last_error: res.ok ? null : res.error,
      set_by: opts?.actorUserId ?? null,
    })),
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[derived_config] written but tracking rows not updated", { cloneId, error: trackErr.message });
  }

  // The values are hostnames, URLs and a display name — safe on a timeline,
  // and what the next pass compares against.
  await recordEvent(
    supabase,
    cloneId,
    opts?.providerSlug,
    res.ok,
    res.ok ? null : res.error,
    { values: Object.fromEntries(toWrite.map((n) => [n, values[n]])) },
    opts?.actorUserId,
  );

  if (!res.ok) return { ok: false, cloneId, reason: "write_failed", error: res.error };
  return { ok: true, cloneId, projectRef: target.projectRef, written: toWrite, changed: true };
}

async function recordEvent(
  supabase: Db,
  cloneId: string,
  providerSlug: string | null | undefined,
  success: boolean,
  errorMessage: string | null,
  result: { values: Record<string, string> } | null,
  actorUserId?: string | null,
): Promise<void> {
  const { error } = await supabase.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: providerSlug ?? "supabase",
    action: DERIVED_CONFIG_EVENT_ACTION,
    success,
    error_message: errorMessage,
    actor_user_id: actorUserId ?? null,
    result: result ?? {},
  });
  if (error) {
    console.error("[derived_config] could not record deployment_event", { cloneId, error: error.message });
  }
}

export type DerivedConfigReconcileResult = {
  considered: number;
  written: number;
  unchanged: number;
  refused: { cloneId: string; reason: string }[];
};

/** Re-derive for every clone with a backend; writes only what moved. */
export async function reconcileCloneDerivedConfig(supabase: Db): Promise<DerivedConfigReconcileResult> {
  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const candidates = (data ?? [])
    .map((r) => r as { clone_id: string | null })
    .filter((r): r is { clone_id: string } => typeof r.clone_id === "string" && r.clone_id.length > 0);

  const out: DerivedConfigReconcileResult = { considered: candidates.length, written: 0, unchanged: 0, refused: [] };
  for (const c of candidates) {
    const res = await applyCloneDerivedConfig(supabase, c.clone_id);
    if (!res.ok) out.refused.push({ cloneId: c.clone_id, reason: res.reason });
    else if (res.changed) out.written += 1;
    else out.unchanged += 1;
  }
  return out;
}
