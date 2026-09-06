/**
 * Pair the PRIME's own cron secrets — by the owner's decision, 6 Sep 2026.
 *
 * ## What this fixes
 *
 * Two of the prime's scheduled jobs sent an `x-cron-secret` header built from
 * `current_setting('app.market_ingestion_cron_secret')`, which was never set,
 * against ten market functions comparing it to `MARKET_INGESTION_CRON_SECRET`,
 * which was never set either: `agent-planner` and `market-qa-subscriptions`
 * answered 401 to every tick on the prime, and — because a clone mirrors the
 * prime's shape — on every clone. `finance-portal-batch6` compares the same
 * header against `FINANCE_PORTAL_CRON_SECRET`, whose vault half
 * (`finance_portal_cron_secret`) the prime never held.
 *
 * ## The rules
 *
 * **This is the ONE module that hands the prime's ref to a secret writer.**
 * Every clone-side writer takes its ref from `resolveCloneSecretTarget`, which
 * refuses the prime by design. Here the ref comes from
 * `resolvePrimeBackendRef` and from nowhere else — the same resolver that
 * refuses to name Mission Control's own project — and it is used for exactly
 * the two pairs in `PRIME_PAIR_SPECS`. A test asserts both.
 *
 * **Converge, never rotate.** A pair whose mirror already holds a usable value
 * is reused and the environment re-asserted; only a missing half is minted.
 * Scheduled hourly for that reason: a pass over an agreeing prime writes
 * nothing, and a pass over a prime somebody half-changed puts it back.
 *
 * **Once the prime holds a half, every clone follows.** The clone sweep reads
 * the prime's shape and mints each clone its OWN pair where the prime holds
 * one — never the prime's value.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { PRIME_PAIR_SPECS, ownedSecretEnvNames } from "./cloneOwnedSecrets.pure";
import { ensureOwnedSecrets, type OwnedSecretsOutcome } from "./cloneOwnedSecrets.server";

type Db = SupabaseClient<Database>;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const PRIME_SECRET_PAIRS_AUDIT_ACTION = "prime.secret_pairs";

export type PrimeSecretPairsResult =
  | { ok: true; projectRef: string; changed: boolean; outcome: OwnedSecretsOutcome }
  | { ok: false; reason: "prime_unresolved" | "mirror_read" | "plan" | "mirror_write" | "env_write"; error: string };

export async function ensurePrimeSecretPairs(
  supabase: Db,
  opts?: { actorUserId?: string | null },
): Promise<PrimeSecretPairsResult> {
  let projectRef: string;
  try {
    const { resolvePrimeBackendRef } = await import("./prime-backend.server");
    projectRef = await resolvePrimeBackendRef(supabase);
  } catch (e) {
    return { ok: false, reason: "prime_unresolved", error: msg(e) };
  }

  // The prime is paired with its own list and nothing else. The gate on the
  // clone specs does not apply here — on the prime the question is what its
  // own jobs read, not what the prime holds — so the shape is not consulted.
  const res = await ensureOwnedSecrets(projectRef, PRIME_PAIR_SPECS, null);

  const { writeAuditLog } = await import("./audit.server");
  await writeAuditLog({
    action: PRIME_SECRET_PAIRS_AUDIT_ACTION,
    entityType: "prime_backend",
    entityId: projectRef,
    actorUserId: opts?.actorUserId ?? null,
    // Names and reasons only.
    metadata: res.ok
      ? { success: true, names: ownedSecretEnvNames(PRIME_PAIR_SPECS), ...res.outcome }
      : { success: false, stage: res.stage, error: res.error },
  });

  if (!res.ok) return { ok: false, reason: res.stage, error: res.error };
  return { ok: true, projectRef, changed: res.outcome.minted.length > 0, outcome: res.outcome };
}
