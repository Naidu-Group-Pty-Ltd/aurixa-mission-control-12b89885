/**
 * Deliver fleet policy to clones that were provisioned before it existed.
 *
 * `prime_secret_forwards` is applied by `runBackendProvisioning`, and by
 * nothing else. So marking a name `inherit` reaches every FUTURE clone and no
 * existing one, while the per-clone path reports that same name as
 * `already_fleet_wide` — a reading that is accurate about provisioning and
 * wrong about the fleet.
 *
 * Why this is a sweep rather than a step in the repair pass: the repair pass
 * already carries the fleet set, but it is a whole-engine convergence — vendor
 * calls against a live tenant, minutes of work, and refused outright unless
 * the backend is `ready`. Adding one credential to fleet policy is an ordinary
 * act and needs an ordinary lever; two of the three clones were mid-migration
 * when this was needed and could not have taken a repair at all.
 *
 * It can only ever write to a clone: the ref comes from
 * `resolveCloneSecretTarget`, which refuses the prime's project, refuses
 * Mission Control's own, and refuses when it cannot tell which is which. What
 * may travel is decided by `cloneSecretForward.pure.ts` — the same module, and
 * for the class refusals the same FUNCTION, that the per-clone push uses.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  decideCloneWithhold,
  fleetNamesToWrite,
  fleetNamesWithoutValue,
  planFleetForwards,
  type CloneWithholdOutcome,
  type FleetForwardOutcome,
} from "./cloneSecretForward.pure";
import { hasEnvValue } from "./cloneSecretForward.server";
import { classifySecret } from "./prime-backend.server";
import { CloneSecretTargetError, resolveCloneSecretTarget } from "./cloneAllowedOrigins.server";

type Db = SupabaseClient<Database>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A ledger status that means the clone actually holds the value. */
const SETTLED = new Set(["inherited", "set"]);

/**
 * The status that means the clone must NOT hold it, though fleet policy
 * forwards it. Named once, because a literal at each end is how two ends
 * drift — and the end that drifts here puts a withdrawn credential back.
 */
export const WITHHELD = "withheld";

export type FleetPushResult =
  | {
      ok: true;
      cloneId: string;
      written: string[];
      /** Withheld names that were still on the project, and are not now. */
      removed: string[];
      withoutValue: string[];
      outcomes: FleetForwardOutcome[];
    }
  | { ok: false; cloneId: string; reason: string; error: string };

/**
 * Write the fleet names this clone is missing onto its project.
 *
 * One Management API call for the whole set, which is what makes a pair like
 * `DIDIT_LIVENESS_THRESHOLD` and `DIDIT_FACE_MATCH_THRESHOLD` arrive together
 * or not at all — `readStandaloneThresholds` returns null unless BOTH parse,
 * so half a pair is a verifier that reports itself unconfigured while looking,
 * from the ledger, like a clone that is half done.
 */
export async function pushFleetSecretForwards(
  supabase: Db,
  cloneId: string,
  opts: { actorUserId?: string | null } = {},
): Promise<FleetPushResult> {
  const fleet = await supabase.from("prime_secret_forwards").select("name, inherit");
  // A failed fleet read is NOT "no fleet policy" — the same rule the per-clone
  // resolver states. Reading it as absent would turn every deliberate
  // `inherit = false` into a name with no policy for as long as the read is
  // broken.
  if (fleet.error) return { ok: false, cloneId, reason: "unreadable", error: fleet.error.message };

  const ledger = await supabase
    .from("clone_backend_secrets")
    .select("name, status")
    .eq("clone_id", cloneId);
  // Likewise: an unreadable ledger is not an empty one. Treating it as empty
  // would re-write every fleet credential on every pass, which is the opposite
  // of settling.
  if (ledger.error)
    return { ok: false, cloneId, reason: "unreadable", error: ledger.error.message };

  /*
   * Deliberately taken off this clone.
   *
   * Two jobs, and only one of them was ever done here. Not writing a withheld
   * name is what keeps this sweep from putting it straight back; REMOVING one
   * that predates the decision is what makes the decision true.
   *
   * `withholdCloneSecret` does exactly that, and it is reachable —
   * `/hooks/clone-secret-withhold`, deliberately unscheduled, one credential
   * on one clone at a time with the reason recorded. It is the right shape for
   * a decision about a single tenant that nothing can derive.
   *
   * What it does not cover is a name that becomes withheld by POLICY. The
   * `brokered` secret class marks one withheld for the whole fleet at once,
   * which writes the ledger row and removes nothing — and no sweep read that
   * row as work. Measured in the audit log: `clone_secret_withheld` fired
   * three times, all for DIDIT_API_KEY, and never for the Airtable pair.
   *
   * Measured 8 Sep 2026: `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` read
   * `withheld` on all three clones with `last_set_at: null`, beside
   * `DIDIT_API_KEY` carrying real timestamps from the hook above — the two
   * shapes of the same status, one enforced and one only recorded, and
   * nothing distinguishing them anywhere a reader would look. Meanwhile one
   * clone went on reading Airtable DIRECTLY with a pair it had been given
   * before the policy existed.
   * `resolveListingsRoute` prefers the direct road whenever a token and a base
   * id are both present, so the broker was never reached and its Listings page
   * stayed empty for five hours.
   *
   * An Airtable personal access token carries its whole SCOPE. This is the
   * exposure `AIRTABLE_KEY_OWNERSHIP.md` exists to close, and it was still
   * live on a tenant project.
   */
  const withheldNames = new Set(
    (ledger.data ?? []).filter((r) => (r.status ?? "") === WITHHELD).map((r) => r.name),
  );

  const outcomes = planFleetForwards({
    fleet: new Map((fleet.data ?? []).map((r) => [r.name, r.inherit])),
    classOf: classifySecret,
    envHas: hasEnvValue,
    settled: new Set(
      (ledger.data ?? []).filter((r) => SETTLED.has(r.status ?? "")).map((r) => r.name),
    ),
    // Deliberately taken off THIS clone. Not `settled` — the project does not
    // hold the value and the ledger must not claim it does — so it needs its
    // own channel or this sweep writes it straight back within thirty minutes.
    withheld: withheldNames,
  });

  const names = fleetNamesToWrite(outcomes);
  const withoutValue = fleetNamesWithoutValue(outcomes);
  if (names.length === 0 && withheldNames.size === 0) {
    // Reported as an empty write rather than as a successful one — the shape
    // every silent-success defect in this platform has taken.
    return { ok: true, cloneId, written: [], removed: [], withoutValue, outcomes };
  }

  let projectRef: string;
  try {
    projectRef = (await resolveCloneSecretTarget(supabase, cloneId)).projectRef;
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, cloneId, reason, error: msg(e) };
  }

  const removed = await enforceWithheld(supabase, cloneId, projectRef, withheldNames, opts);

  if (names.length === 0) {
    return { ok: true, cloneId, written: [], removed, withoutValue, outcomes };
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
      `[fleet-secret-forward] ledger write failed for ${cloneId}: ${ledgerErr.message}`,
    );
  }

  if (!res.ok) return { ok: false, cloneId, reason: "write_failed", error: res.error };
  return { ok: true, cloneId, written: names, removed, withoutValue, outcomes };
}

/**
 * Make a withheld name true on the project, not merely recorded in a ledger.
 *
 * Deletes only names this clone's ledger already says are withheld — a
 * decision taken elsewhere, enforced here — and only those the project is
 * observed to hold.
 *
 * `listProjectSecretNames` answers `[]` for a transport failure exactly as it
 * does for a project holding none, so an empty answer removes nothing. That is
 * the conservative direction and the rule this repository keeps restating: a
 * read that FAILED is not a set that is EMPTY.
 *
 * A failure to delete is logged and never thrown: this runs inside the forward
 * sweep, and taking the sweep down over one stale name would stop every OTHER
 * clone settling.
 */
async function enforceWithheld(
  supabase: Db,
  cloneId: string,
  projectRef: string,
  withheldNames: ReadonlySet<string>,
  opts: { actorUserId?: string | null },
): Promise<string[]> {
  if (withheldNames.size === 0) return [];

  const { listProjectSecretNames, deleteCloneSecretValues } =
    await import("./backend-provisioning.server");
  const present = await listProjectSecretNames(projectRef);
  const stale = present.filter((name) => withheldNames.has(name));
  if (stale.length === 0) return [];

  const del = await deleteCloneSecretValues(projectRef, stale);
  if (!del.ok) {
    console.error(
      `[fleet-secret-forward] withheld names still on ${cloneId}: ${stale.join(", ")} — ${del.error}`,
    );
    return [];
  }

  // Stamp it. `withheld` with a null `last_set_at` is what a policy recorded
  // but never carried out looks like, and it read the same as one that had
  // been.
  const now = new Date().toISOString();
  const { error } = await supabase.from("clone_backend_secrets").upsert(
    stale.map((name) => ({
      clone_id: cloneId,
      name,
      status: WITHHELD,
      last_set_at: now,
      last_error: null,
      set_by: opts.actorUserId ?? null,
    })),
    { onConflict: "clone_id,name" },
  );
  if (error) {
    console.error(
      `[fleet-secret-forward] removed ${stale.join(", ")} from ${cloneId} but could not stamp: ${error.message}`,
    );
  }
  console.warn(
    `[fleet-secret-forward] removed withheld names from ${cloneId}: ${stale.join(", ")}`,
  );
  return stale;
}

export type FleetReconcileResult = {
  considered: number;
  pushed: number;
  written: number;
  /**
   * Withheld names found still on a project and taken off it, per clone.
   *
   * Counted separately from `written` because it is the opposite act, and
   * because a sweep that removes a credential should never be reported as one
   * that changed nothing.
   */
  removed: Array<{ clone_id: string; names: string[] }>;
  /** Fleet names this deployment holds no value for, per clone. */
  withoutValue: Array<{ clone_id: string; names: string[] }>;
  refused: Array<{ clone_id: string; reason: string; error: string }>;
};

/**
 * Bring every clone up to current fleet policy.
 *
 * The ledger is the filter, so a settled fleet costs two reads a pass and no
 * Management API calls. A `failed` row is deliberately not filtered out — that
 * is the state a retry is for.
 *
 * Every clone with a provisioned backend is considered, whatever its status.
 * A backend mid-migration still has a project and can still take an
 * environment variable, and excluding it would reintroduce the gap this closes
 * for exactly the clones most likely to be behind.
 */
export async function reconcileFleetSecretForwards(supabase: Db): Promise<FleetReconcileResult> {
  const out: FleetReconcileResult = {
    considered: 0,
    pushed: 0,
    written: 0,
    removed: [],
    withoutValue: [],
    refused: [],
  };

  const backends = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  if (backends.error) {
    out.refused.push({ clone_id: "*", reason: "unreadable", error: backends.error.message });
    return out;
  }

  const cloneIds = (backends.data ?? []).map((r) => r.clone_id);
  out.considered = cloneIds.length;
  if (cloneIds.length === 0) return out;

  for (const cloneId of cloneIds) {
    const res = await pushFleetSecretForwards(supabase, cloneId);
    if (!res.ok) {
      out.refused.push({ clone_id: cloneId, reason: res.reason, error: res.error });
      continue;
    }
    if (res.removed.length > 0) {
      out.removed.push({ clone_id: cloneId, names: res.removed });
    }
    if (res.withoutValue.length > 0) {
      out.withoutValue.push({ clone_id: cloneId, names: res.withoutValue });
    }
    if (res.written.length > 0) {
      out.pushed += 1;
      out.written += res.written.length;
    }
  }

  return out;
}

/**
 * Take one forwarded credential off ONE clone and keep it off.
 *
 * The ledger write comes AFTER the delete and is checked, because the order
 * decides what a half-done act leaves behind. Recorded-then-deleted would, on
 * a failed delete, leave a ledger saying the project does not hold a value it
 * still holds — the register lying in the direction that hides a live
 * credential on a tenant's project. Deleted-then-recorded leaves, on a failed
 * write, a project without the value and a ledger still saying `inherited`:
 * the next sweep puts it back, which is visible, undoes nothing, and is the
 * state this function can be run again from.
 */
export async function withholdCloneSecret(
  supabase: Db,
  cloneId: string,
  name: string,
  reason: string,
  opts: { actorUserId?: string | null } = {},
): Promise<
  | { ok: true; outcome: CloneWithholdOutcome }
  | { ok: false; reason: string; error: string; outcome?: CloneWithholdOutcome }
> {
  const ledger = await supabase
    .from("clone_backend_secrets")
    .select("status")
    .eq("clone_id", cloneId)
    .eq("name", name)
    .maybeSingle();
  // An unreadable ledger is not an absent row. Deciding on a failed read would
  // let a transport fault look like "this clone never had it".
  if (ledger.error) return { ok: false, reason: "unreadable", error: ledger.error.message };

  const outcome = decideCloneWithhold({
    name,
    ledgerStatus: ledger.data?.status ?? null,
    reason,
  });
  if (outcome.act !== "withhold") {
    return outcome.act === "already_withheld"
      ? { ok: true, outcome }
      : { ok: false, reason: "refused", error: outcome.why, outcome };
  }

  let projectRef: string;
  try {
    projectRef = (await resolveCloneSecretTarget(supabase, cloneId)).projectRef;
  } catch (e) {
    const reasonCode = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, reason: reasonCode, error: msg(e) };
  }

  const { deleteCloneSecretValues } = await import("./backend-provisioning.server");
  const del = await deleteCloneSecretValues(projectRef, [name]);
  if (!del.ok) return { ok: false, reason: "delete_failed", error: del.error };

  const { error: ledgerErr } = await supabase.from("clone_backend_secrets").upsert(
    [
      {
        clone_id: cloneId,
        name,
        status: WITHHELD,
        last_set_at: new Date().toISOString(),
        last_error: null,
        set_by: opts.actorUserId ?? null,
      },
    ],
    { onConflict: "clone_id,name" },
  );
  if (ledgerErr)
    return { ok: false, reason: "ledger_write_failed", error: ledgerErr.message, outcome };

  return { ok: true, outcome };
}
