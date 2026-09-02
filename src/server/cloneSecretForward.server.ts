/**
 * Resolving and pushing a clone's own forwarded credentials.
 *
 * The decision — what may travel, what may not, and what has nothing behind
 * it — is `cloneSecretForward.pure.ts`, and its header carries the reasoning.
 * This is the part that touches the database, the environment and the
 * Management API.
 *
 * Two rules shape the code below rather than the decision.
 *
 * **The ref that is written to comes from `resolveCloneSecretTarget` and
 * nowhere else.** The Management API token reaches every project this
 * organisation owns, including the prime's and Mission Control's; the only
 * thing between "forward a vendor key to a clone" and "overwrite that key on
 * the prime" is where the ref came from. That guard refuses the prime,
 * refuses Mission Control, and refuses when it cannot tell which is which.
 *
 * **A value is read once, written once, and never returned.** It is not put
 * in the result, the ledger, the audit row or a log line — a prefix of a
 * credential is still credential material in a table more people can read
 * than can read the project it belongs to.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveCloneSecretTarget, CloneSecretTargetError } from "./cloneAllowedOrigins.server";
import type { CloneSecretRefusal } from "./cloneSecretTarget.pure";
import { classifySecret } from "./prime-backend.server";
import { namesToWrite, planCloneForwards, type ForwardOutcome } from "./cloneSecretForward.pure";

type Db = SupabaseClient<Database>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether this deployment's environment holds a usable value under `name`. */
export function hasEnvValue(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

/** One clone's authorised names, resolved against policy and the environment. */
export async function resolveCloneForwardOutcomes(
  supabase: Db,
  cloneId: string,
): Promise<{ ok: true; outcomes: ForwardOutcome[] } | { ok: false; error: string }> {
  const rows = await supabase
    .from("clone_secret_forwards")
    .select("name")
    .eq("clone_id", cloneId)
    .order("name", { ascending: true });
  if (rows.error) return { ok: false, error: rows.error.message };

  const fleet = await supabase.from("prime_secret_forwards").select("name, inherit");
  // A failed fleet read is NOT "no fleet policy". Treating it as absent would
  // turn every deliberate `inherit = false` — the management token, the
  // payment keys — into a forwardable name for as long as the read is broken.
  if (fleet.error) return { ok: false, error: fleet.error.message };
  const fleetInherit = new Map((fleet.data ?? []).map((r) => [r.name, r.inherit]));

  const outcomes = planCloneForwards({
    authorised: (rows.data ?? []).map((r) => r.name),
    fleet: fleetInherit,
    classOf: classifySecret,
    envHas: hasEnvValue,
  });
  return { ok: true, outcomes };
}

export type ForwardPushResult =
  | {
      ok: true;
      cloneId: string;
      /** Names written to the clone's project on this push. */
      written: string[];
      /** Every authorised name and what happened to it. */
      outcomes: ForwardOutcome[];
    }
  | { ok: false; cloneId: string; reason: CloneSecretRefusal | "write_failed"; error: string };

/**
 * Write this clone's authorised, available credentials onto its project.
 *
 * The write is ONE Management API call for the whole set, which is what makes
 * a pair like `GOHIGHLEVEL_API_KEY` and `GOHIGHLEVEL_LOCATION_ID` arrive
 * together or not at all — half a pair is indistinguishable from a healthy
 * clone at every surface that reads it, and fails only at the vendor.
 */
export async function pushCloneSecretForwards(
  supabase: Db,
  cloneId: string,
  opts: { actorUserId?: string | null } = {},
): Promise<ForwardPushResult> {
  const resolved = await resolveCloneForwardOutcomes(supabase, cloneId);
  if (!resolved.ok) {
    return { ok: false, cloneId, reason: "unreadable", error: resolved.error };
  }
  const names = namesToWrite(resolved.outcomes);
  if (names.length === 0) {
    // Nothing to write is not a failure — a clone whose every authorised name
    // is already fleet-wide reaches this legitimately — but it is reported as
    // an empty write rather than as a successful one.
    return { ok: true, cloneId, written: [], outcomes: resolved.outcomes };
  }

  let projectRef: string;
  try {
    projectRef = (await resolveCloneSecretTarget(supabase, cloneId)).projectRef;
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, cloneId, reason, error: msg(e) };
  }

  const { setCloneSecretValues } = await import("./backend-provisioning.server");
  const entries = names.map((name) => ({ name, value: process.env[name] as string }));
  const res = await setCloneSecretValues(projectRef, entries);

  const now = new Date().toISOString();
  // Checked, not fired and forgotten. An unrecorded write leaves the operator's
  // secret list reading `missing` over a secret that is set, and every sweep
  // re-writing it for ever with nothing saying why.
  const { error: ledgerErr } = await supabase.from("clone_backend_secrets").upsert(
    names.map((name) => ({
      clone_id: cloneId,
      name,
      status: res.ok ? "inherited" : "failed",
      last_set_at: res.ok ? now : null,
      last_error: res.ok ? null : res.error,
      set_by: opts.actorUserId ?? null,
    })),
    { onConflict: "clone_id,name" },
  );
  if (ledgerErr) {
    console.error(
      `[clone-secret-forward] ledger write failed for ${cloneId}: ${ledgerErr.message}`,
    );
  }

  if (!res.ok) {
    return { ok: false, cloneId, reason: "write_failed", error: res.error };
  }
  return { ok: true, cloneId, written: names, outcomes: resolved.outcomes };
}

export type ForwardReconcileResult = {
  considered: number;
  pushed: number;
  written: number;
  refused: Array<{ clone_id: string; reason: string; error: string }>;
};

/**
 * Push every clone's authorised forwards that are not already on its project.
 *
 * The row is the authorisation, so applying it should not depend on anybody
 * remembering to press a button — the same reasoning as the JWT reconcile,
 * and the same reason a clone provisioned before a row existed is covered at
 * all.
 *
 * The ledger is the filter: a name already recorded `inherited` for this clone
 * is skipped, so a settled fleet costs two reads a pass and no Management API
 * calls. A `failed` row is NOT skipped — that is the state a retry is for.
 */
export async function reconcileCloneSecretForwards(supabase: Db): Promise<ForwardReconcileResult> {
  const out: ForwardReconcileResult = { considered: 0, pushed: 0, written: 0, refused: [] };

  const rows = await supabase.from("clone_secret_forwards").select("clone_id, name");
  if (rows.error) {
    out.refused.push({ clone_id: "*", reason: "unreadable", error: rows.error.message });
    return out;
  }
  const authorised = new Map<string, Set<string>>();
  for (const r of rows.data ?? []) {
    if (!authorised.has(r.clone_id)) authorised.set(r.clone_id, new Set());
    (authorised.get(r.clone_id) as Set<string>).add(r.name);
  }
  out.considered = authorised.size;
  if (authorised.size === 0) return out;

  const ledger = await supabase
    .from("clone_backend_secrets")
    .select("clone_id, name, status")
    .in("clone_id", [...authorised.keys()]);
  if (ledger.error) {
    out.refused.push({ clone_id: "*", reason: "unreadable", error: ledger.error.message });
    return out;
  }
  const settled = new Set(
    (ledger.data ?? [])
      .filter((r) => r.status === "inherited" || r.status === "set")
      .map((r) => `${r.clone_id} ${r.name}`),
  );

  for (const [cloneId, wanted] of authorised) {
    const outstanding = [...wanted].some((n) => !settled.has(`${cloneId} ${n}`));
    if (!outstanding) continue;
    const res = await pushCloneSecretForwards(supabase, cloneId);
    if (!res.ok) {
      out.refused.push({ clone_id: cloneId, reason: res.reason, error: res.error });
      continue;
    }
    if (res.written.length > 0) {
      out.pushed += 1;
      out.written += res.written.length;
    }
  }
  return out;
}
