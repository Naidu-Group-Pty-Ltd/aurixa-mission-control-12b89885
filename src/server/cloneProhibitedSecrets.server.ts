/**
 * Remove a management credential from any clone found holding one.
 *
 * ## Why a sweep, and not a better forward rule
 *
 * `classifySecret` now calls these `prime_only` and `classRefusalFor` refuses
 * them on both forward paths, so Mission Control cannot put one on a clone.
 * That was never the whole problem. On 12 Sep 2026 `npc-client-dashboard`
 * held `SB_MANAGEMENT_ACCESS_TOKEN` while `clone_backend_secrets` recorded
 * that name `status: missing`, `last_set_at: null` — Mission Control had not
 * written it, so Mission Control could not see it, and the existing
 * withdrawal lever (`decideCloneWithhold`) can only withdraw what the ledger
 * says was forwarded.
 *
 * **The ledger records intent; only the project records fact.** So this reads
 * the names the project ACTUALLY holds, from the Management API, and acts on
 * those. It is the same rule the rest of this platform arrived at the hard
 * way — the purge is asserted by its effect, never by its configuration.
 *
 * ## Four rules
 *
 * **A failed read is never an empty project.** `listProjectSecretNames`
 * answers `[]` on an API failure, which is right for the parity report that
 * owns it and catastrophic here: it would read as "this clone holds nothing
 * prohibited" and the sweep would report a clean pass for a workspace it
 * never managed to look at. `readHeldSecretNames` below carries the failure
 * instead, and a clone that could not be read is reported `unreadable`.
 *
 * **Deletion is bounded by the policy, never by a pattern applied to the
 * live list.** The names deleted are exactly `prohibitedHoldings(...)` — the
 * intersection of what the project holds with a list this platform wrote. A
 * sweep that computed its own targets from the project's own names is one
 * regex away from removing a clone's service-role key.
 *
 * **It is asserted by effect.** After deleting, the names are read back. The
 * outcome records what the SECOND read saw, so a delete the API accepted and
 * did not perform is reported as still-present rather than as removed.
 *
 * **It never touches the prime or Mission Control.** The ref comes from
 * `resolveCloneSecretTarget`, which refuses the prime's project, refuses
 * Mission Control's own and refuses when it cannot tell. The prime is
 * SUPPOSED to hold a management token — that is the whole design — so a
 * sweep that could reach it would disable the control plane.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { prohibitedHoldings } from "./primeOnlySecrets.pure";
import { deleteCloneSecretValues } from "./backend-provisioning.server";
import { resolveCloneSecretTarget, CloneSecretTargetError } from "./cloneAllowedOrigins.server";

type Db = SupabaseClient<Database>;

const MGMT_API = "https://api.supabase.com/v1";

/**
 * The names a project holds, with failure carried rather than flattened.
 *
 * Deliberately its own reader instead of a change to
 * `listProjectSecretNames`: that function's `[] on failure` contract is
 * depended on by the G3 parity report, where an unreadable project showing
 * "missing everything" is a loud and correct reading. Here the same
 * flattening would be silent and wrong, so the two callers get two readers
 * rather than one caller getting a surprise.
 */
export async function readHeldSecretNames(
  projectRef: string,
): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  const token = process.env.SB_MGMT_API_TOKEN;
  if (!token) return { ok: false, error: "SB_MGMT_API_TOKEN is not configured" };
  try {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/secrets`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `secrets API ${res.status} — ${(await res.text()).slice(0, 200)}`,
      };
    }
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return { ok: false, error: "secrets API returned a non-array body" };
    const names = raw
      .map((r) => {
        const o = r as Record<string, unknown>;
        return typeof o.name === "string" ? o.name : "";
      })
      .filter((n) => n.length > 0);
    return { ok: true, names };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type ProhibitedSweepOutcome =
  /** Read the project, found nothing prohibited. The only clean reading. */
  | { clone: string; state: "clean" }
  /** Found and removed, confirmed absent by a second read. */
  | { clone: string; state: "removed"; names: string[] }
  /** Found, the delete was accepted, and a re-read still sees them. */
  | { clone: string; state: "still_present"; names: string[] }
  /** Found, the delete itself failed. */
  | { clone: string; state: "delete_failed"; names: string[]; error: string }
  /** Could not look. NEVER reported as clean. */
  | { clone: string; state: "unreadable"; error: string }
  /** Refused a target: no backend yet, or the ref could not be proven a clone's. */
  | { clone: string; state: "skipped"; why: string };

/** Sweep one clone. Never throws: every failure is an outcome a report can render. */
export async function sweepCloneProhibitedSecrets(
  supabase: Db,
  cloneId: string,
  cloneName: string,
): Promise<ProhibitedSweepOutcome> {
  let projectRef: string;
  try {
    const target = await resolveCloneSecretTarget(supabase, cloneId);
    projectRef = target.projectRef;
  } catch (e) {
    const why =
      e instanceof CloneSecretTargetError
        ? `${e.reason}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e);
    return { clone: cloneName, state: "skipped", why };
  }

  const held = await readHeldSecretNames(projectRef);
  if (!held.ok) return { clone: cloneName, state: "unreadable", error: held.error };

  const prohibited = prohibitedHoldings(held.names);
  if (prohibited.length === 0) return { clone: cloneName, state: "clean" };

  console.warn("[prohibited-secrets] removing management credentials from a clone", {
    clone: cloneName,
    projectRef,
    names: prohibited,
  });

  const deleted = await deleteCloneSecretValues(projectRef, prohibited);
  if (!deleted.ok) {
    return { clone: cloneName, state: "delete_failed", names: prohibited, error: deleted.error };
  }

  // Asserted by effect. A delete the API accepted is not a name that is gone.
  const after = await readHeldSecretNames(projectRef);
  if (!after.ok) {
    return { clone: cloneName, state: "unreadable", error: `after delete: ${after.error}` };
  }
  const remaining = prohibitedHoldings(after.names);
  if (remaining.length > 0) {
    return { clone: cloneName, state: "still_present", names: remaining };
  }

  await recordWithheld(supabase, cloneId, prohibited);
  return { clone: cloneName, state: "removed", names: prohibited };
}

/**
 * Leave the removal in the ledger, as `withheld`.
 *
 * Three reasons it is that word and not a new one. It is already in the
 * column's CHECK constraint — `clone_backend_secrets_status_check` admits
 * eight values and a ninth would need a migration, on the lane this same
 * engagement found unable to apply one, so the code would assume a state the
 * database silently rejects. It is already what `cloneSecretForward` refuses
 * on (`ledgerStatus === "withheld"`), so the stamp hardens the forward path
 * as a second layer under the class refusal rather than only describing
 * history. And it is TRUE: after this sweep the name is deliberately not on
 * this clone.
 *
 * Never fails the sweep. The credential is already gone by the time this
 * runs, and a ledger write that could undo that removal by throwing would be
 * a bookkeeping step with power over a security outcome.
 */
async function recordWithheld(
  supabase: Db,
  cloneId: string,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  try {
    const { error } = await supabase.from("clone_backend_secrets").upsert(
      names.map((name) => ({
        clone_id: cloneId,
        name,
        status: "withheld" as const,
        last_set_at: null,
      })),
      { onConflict: "clone_id,name" },
    );
    if (error) {
      console.error("[prohibited-secrets] removed, but the ledger was not stamped", {
        cloneId,
        names,
        error: error.message,
      });
    }
  } catch (e) {
    console.error("[prohibited-secrets] removed, but the ledger write threw", {
      cloneId,
      names,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export type ProhibitedSweepReport = {
  swept: number;
  removed: number;
  unreadable: number;
  outcomes: ProhibitedSweepOutcome[];
};

/**
 * Sweep every clone that has a backend.
 *
 * Ordered by name so two runs read the same, and never short-circuits: one
 * unreadable clone must not cost the rest their pass, which is the same rule
 * the reconcile hook applies to its other sweeps.
 */
export async function reconcileProhibitedSecrets(supabase: Db): Promise<ProhibitedSweepReport> {
  const { data, error } = await supabase
    .from("clones")
    .select("id, name")
    .order("name", { ascending: true });
  if (error) {
    return {
      swept: 0,
      removed: 0,
      unreadable: 0,
      outcomes: [
        { clone: "(fleet)", state: "unreadable", error: `could not list clones: ${error.message}` },
      ],
    };
  }

  const outcomes: ProhibitedSweepOutcome[] = [];
  for (const c of data ?? []) {
    outcomes.push(
      await sweepCloneProhibitedSecrets(supabase, c.id as string, (c.name as string) ?? c.id),
    );
  }
  return {
    swept: outcomes.length,
    removed: outcomes.filter((o) => o.state === "removed").length,
    unreadable: outcomes.filter((o) => o.state === "unreadable").length,
    outcomes,
  };
}
