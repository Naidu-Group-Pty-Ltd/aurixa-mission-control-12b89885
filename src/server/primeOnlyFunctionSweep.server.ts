/**
 * Take the prime's own Edge Functions off every clone's project.
 *
 * ## Why a sweep, and why here
 *
 * `primeOnlyFeatures.pure.ts` withholds the GoHighLevel account migration from
 * every clone, and provisioning no longer deploys its twenty-eight functions.
 * Withholding stops the NEXT deploy. It does nothing about the last one, and
 * every clone provisioned before the register existed was given all
 * twenty-eight: measured 28 Sep 2026, all four still ran them.
 *
 * Nothing else would take them off. A function stays deployed until something
 * deletes it, and the clones' own CI stands down because this platform deploys
 * their projects. So the half-hourly backend catch-up runs this first, for
 * every clone, and it settles: a project holding none of them costs one read.
 *
 * It runs before the catch-up's GitHub budget check, and is not gated by it,
 * because it reads nothing from GitHub. A pass the budget skips still sweeps.
 *
 * ## The rules
 *
 * - **Per project, the rules are `sweepPrimeOnlyFunctions`'.** It deletes
 *   only what the register names, by exact name, never on the prime, and never
 *   throws.
 * - **The prime is resolved once, and a failure stops the whole sweep.** A
 *   sweep that cannot tell which project is the prime deletes nothing
 *   anywhere, rather than guessing project by project.
 * - **A read that failed is not a clone with nothing to delete.** Every
 *   refusal is named and returned.
 *
 * ## The CRM line's share
 *
 * The same pass takes off what a clone's recorded CRM line does not carry
 * (`crmLineFeatures.pure.ts`): the GoHighLevel integration's functions AND
 * its pg_cron jobs, on the independent line. The jobs are swept here as well
 * as after provisioning's own applies, because the fleet migration lane
 * applies migrations too and four of the prime's re-schedule them — measured
 * 29 Sep 2026, all four were live on the independent line head. A clone
 * recording no line has nothing swept for it but the prime's own functions,
 * exactly as before.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  sweepPrimeOnlyCronJobs,
  sweepPrimeOnlyFunctions,
  type PrimeOnlyCronSweep,
  type PrimeOnlyFunctionSweep,
} from "@/server/backend-provisioning.server";

export type FleetFunctionSweepOutcome = {
  cloneId: string;
  cloneName: string | null;
  /** Named refusal before the project was reached, or null. */
  refused: string | null;
  /** What the project sweep did, when it was reached. */
  sweep: PrimeOnlyFunctionSweep | null;
  /**
   * What the CRM line's cron sweep did — only for a clone that records a
   * line, and absent otherwise.
   */
  cronSweep?: PrimeOnlyCronSweep | null;
};

export type FleetFunctionSweepResult = {
  considered: number;
  deleted: number;
  failed: number;
  /** Found and left for the next pass. */
  deferred: number;
  /** pg_cron jobs the CRM-line sweep unscheduled, fleet-wide. */
  unscheduled?: number;
  outcomes: FleetFunctionSweepOutcome[];
  /** Fleet-level refusal: nothing was swept at all. */
  refused: string | null;
};

export async function sweepPrimeOnlyFunctionsFromFleet(): Promise<FleetFunctionSweepResult> {
  const result: FleetFunctionSweepResult = {
    considered: 0,
    deleted: 0,
    failed: 0,
    deferred: 0,
    outcomes: [],
    refused: null,
  };

  let primeRef: string;
  try {
    const { resolvePrimeBackendRef } = await import("@/server/prime-backend.server");
    primeRef = (await resolvePrimeBackendRef(supabaseAdmin)).trim();
  } catch (err) {
    result.refused =
      `the prime's project could not be resolved, so no clone's project can be ruled out as the ` +
      `prime: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (!primeRef) {
    result.refused =
      "the prime's project is not known, so no clone's project can be ruled out as the prime";
    return result;
  }

  // `*` so a deployment that has not migrated `crm_mode` reads it as absent.
  const { data: clones, error: clonesErr } = await supabaseAdmin.from("clones").select("*");
  if (clonesErr) {
    result.refused = `could not list clones: ${clonesErr.message}`;
    return result;
  }
  const { data: backends, error: backendsErr } = await supabaseAdmin
    .from("clone_backends")
    .select("clone_id, supabase_project_ref");
  if (backendsErr) {
    result.refused = `could not read the clones' projects: ${backendsErr.message}`;
    return result;
  }
  const refByClone = new Map<string, string>();
  for (const row of backends ?? []) {
    const b = row as { clone_id: string | null; supabase_project_ref: string | null };
    const ref = (b.supabase_project_ref ?? "").trim();
    if (b.clone_id && ref) refByClone.set(b.clone_id, ref);
  }

  for (const clone of clones ?? []) {
    const row = clone as { id: string; name?: string | null; crm_mode?: string | null };
    result.considered += 1;
    const ref = refByClone.get(row.id);
    if (!ref) {
      result.outcomes.push({
        cloneId: row.id,
        cloneName: row.name ?? null,
        refused: "no_backend_project",
        sweep: null,
      });
      continue;
    }
    const crmMode = row.crm_mode ?? null;
    const sweep = await sweepPrimeOnlyFunctions(ref, { primeRef, crmMode });
    result.deleted += sweep.deleted.length;
    result.failed += sweep.failed.length;
    result.deferred += sweep.deferred.length;
    const cronSweep = crmMode ? await sweepPrimeOnlyCronJobs(ref, { primeRef, crmMode }) : null;
    if (cronSweep) {
      result.unscheduled = (result.unscheduled ?? 0) + cronSweep.unscheduled.length;
      result.failed += cronSweep.failed.length;
    }
    result.outcomes.push({
      cloneId: row.id,
      cloneName: row.name ?? null,
      refused: null,
      sweep,
      ...(cronSweep ? { cronSweep } : {}),
    });
  }
  return result;
}

/**
 * Whether a fleet sweep did anything, or could not, that deserves a line in
 * the audit log. A fleet holding none of the functions is the steady state and
 * writes nothing.
 */
export function fleetFunctionSweepIsNoteworthy(result: FleetFunctionSweepResult): boolean {
  if (
    result.refused ||
    result.deleted > 0 ||
    result.failed > 0 ||
    result.deferred > 0 ||
    (result.unscheduled ?? 0) > 0
  ) {
    return true;
  }
  return result.outcomes.some((o) => o.sweep?.skipped || o.cronSweep?.skipped);
}
