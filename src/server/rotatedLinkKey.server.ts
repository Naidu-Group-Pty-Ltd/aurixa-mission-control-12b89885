/**
 * Deliver a key a clone rotated for itself (key audit S5).
 *
 * Its own module, not the link pass's: the link pass writes a clone's
 * environment in one request per pass, and keeps it that way. A rotation is a
 * second, separate writer of one name, used only by
 * `/api/public/clones/rotate-key`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveCloneSecretTarget, type CloneSecretTarget } from "./cloneAllowedOrigins.server";
import { recordSecretLedger } from "./secretLedger.server";
import { ENV_MISSION_CONTROL_CLONE_API_KEY } from "./missionControlLink.pure";

type Db = SupabaseClient<Database>;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Deliver a key a clone rotated for itself into that clone's function
 * environment, and record it as delivered there (key audit S5).
 *
 * The clone's own `mission-control-rotate-key` function was meant to store the
 * new key, and cannot: writing a project secret needs a management token, and
 * a clone never holds one. So the rotation minted a key nobody received, and
 * revoked the old one an hour later. Mission Control holds the token, so it
 * writes the key itself, through the same writer and the same target rule as
 * the link pass, and stamps the key delivered so the link plan counts it.
 *
 * The plaintext reaches only the secrets batch; the result carries no part of
 * it.
 */
export async function deliverRotatedLinkKey(
  supabase: Db,
  cloneId: string,
  keyId: string,
  raw: string,
): Promise<{ ok: true; projectRef: string } | { ok: false; error: string }> {
  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    return { ok: false, error: `Refusing to write the rotated key: ${msg(e)}` };
  }
  const { setCloneSecretValues } = await import("./backend-provisioning.server");
  const env = await setCloneSecretValues(target.projectRef, [
    { name: ENV_MISSION_CONTROL_CLONE_API_KEY, value: raw },
  ]);
  if (!env.ok) return { ok: false, error: env.error };

  const nowIso = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from("clone_api_keys")
    .update({ delivered_env_at: nowIso, delivered_project_ref: target.projectRef })
    .eq("id", keyId);
  if (stampErr) {
    // Delivered all the same. Unstamped, the link plan mints a fresh key once
    // the old one is revoked, which converges on a key the clone holds.
    console.error("[mission_control_link] rotated key delivered but not stamped", {
      cloneId,
      keyId,
      error: stampErr.message,
    });
  }
  const trackErr = await recordSecretLedger(supabase, {
    cloneId,
    names: [ENV_MISSION_CONTROL_CLONE_API_KEY],
    result: { ok: true, written: env.written, unchanged: env.unchanged },
    status: "set",
    now: nowIso,
  });
  if (trackErr)
    console.error("[mission_control_link] rotated key delivered but ledger not updated", {
      cloneId,
      error: trackErr,
    });
  return { ok: true, projectRef: target.projectRef };
}
