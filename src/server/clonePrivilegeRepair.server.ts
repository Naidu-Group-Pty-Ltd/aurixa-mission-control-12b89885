/**
 * Give every existing clone the prime's function EXECUTE grants and view
 * options.
 *
 * ## Why a sweep, and not only the provisioner
 *
 * Provisioning now converges these in its grants stage
 * (`planClonePrivilegeConvergence`). A clone whose schema was verified before
 * that existed never re-enters introspection — `schema_verified_at` skips it,
 * correctly, because re-walking twelve stages over ~650 tables a minute is what
 * once starved its edge-function deploys. So the fleet as it stands on 3 Oct
 * 2026 — four clones, 238 to 247 SECURITY DEFINER functions each callable with
 * the anon key — would never be repaired by the code that now builds clones
 * correctly. This is what repairs them, and what catches any drift a later
 * hand edit introduces.
 *
 * ## What it may touch
 *
 * The target comes from `resolveCloneSecretTarget`, the one resolver that
 * refuses the prime's project and Mission Control's own and refuses when it
 * cannot tell. Every statement is a GRANT or REVOKE of EXECUTE on a function
 * both sides hold, or an `alter view … set/reset` of three named options —
 * nothing else can be planned (see `routinePrivileges.pure.ts`). No row is
 * read or written.
 *
 * ## Budget
 *
 * The first pass on a clone is a few hundred statements; every later one is
 * none. The plan is re-derived from both catalogues on every call, so a pass
 * the budget stops loses nothing and the next one carries only what is still
 * different. The starting clone rotates with the clock so one large clone
 * cannot starve the others.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveCloneSecretTarget, CloneSecretTargetError } from "./cloneAllowedOrigins.server";
import { BudgetPause, pastDeadline } from "./provisioningBudget";

type Db = SupabaseClient<Database>;

export type ClonePrivilegeOutcome = {
  cloneId: string;
  cloneName: string;
  projectRef: string;
  applied: number;
  failed: number;
  grants: number;
  revokes: number;
  viewStatements: number;
  closedDefinerExposures: number;
  invokerRestored: number;
  heldForReference: number;
  cloneOnlyExposedDefiners: string[];
  errors?: string[];
  sample?: string[];
};

export type ClonePrivilegeReconcileResult = {
  dryRun: boolean;
  considered: number;
  /** Clones that needed nothing — the settled state. */
  alreadyAligned: number;
  changed: ClonePrivilegeOutcome[];
  /** The clone the budget stopped in, if any. The next pass resumes it. */
  pausedAt: string | null;
  refused: Array<{ cloneId: string; reason: string; error: string }>;
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Rotate `items` so the run starts at `offset` — fairness across passes, no state needed. */
export function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const k = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

export async function reconcileClonePrivileges(
  supabase: Db,
  opts: { deadlineAt: number; dryRun?: boolean; cloneId?: string; now?: number },
): Promise<ClonePrivilegeReconcileResult> {
  const dryRun = Boolean(opts.dryRun);
  let q = supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  if (opts.cloneId) q = q.eq("clone_id", opts.cloneId);
  const { data, error } = await q;
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const candidates = (data ?? [])
    .map((r) => (r as { clone_id: string | null }).clone_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();

  const out: ClonePrivilegeReconcileResult = {
    dryRun,
    considered: candidates.length,
    alreadyAligned: 0,
    changed: [],
    pausedAt: null,
    refused: [],
  };
  if (candidates.length === 0) return out;

  const { resolvePrimeBackendRef } = await import("./prime-backend.server");
  // Unset is fatal here, as it is for provisioning: with no prime there is no
  // authority to converge towards, and guessing one is how the wrong database
  // was once copied.
  const primeRef = await resolvePrimeBackendRef(supabase);
  const { convergeClonePrivileges } = await import("./schema-introspection.server");

  const minute = Math.floor((opts.now ?? Date.now()) / 60_000);
  for (const cloneId of rotate(candidates, minute)) {
    if (pastDeadline(opts.deadlineAt)) {
      out.pausedAt = cloneId;
      break;
    }
    let target: Awaited<ReturnType<typeof resolveCloneSecretTarget>>;
    try {
      target = await resolveCloneSecretTarget(supabase, cloneId);
    } catch (e) {
      out.refused.push({
        cloneId,
        reason: e instanceof CloneSecretTargetError ? e.reason : "target_unresolved",
        error: msg(e),
      });
      continue;
    }

    try {
      const r = await convergeClonePrivileges(target.projectRef, {
        primeRef,
        deadlineAt: opts.deadlineAt,
        dryRun,
      });
      const planned = r.plan.routines.grants + r.plan.routines.revokes + r.plan.views.statements;
      const outcome: ClonePrivilegeOutcome = {
        cloneId,
        cloneName: target.cloneName,
        projectRef: target.projectRef,
        applied: r.applied,
        failed: r.failed,
        grants: r.plan.routines.grants,
        revokes: r.plan.routines.revokes,
        viewStatements: r.plan.views.statements,
        closedDefinerExposures: r.plan.routines.closedDefinerExposures,
        invokerRestored: r.plan.views.invokerRestored,
        heldForReference: r.plan.routines.heldForReference.length,
        cloneOnlyExposedDefiners: r.plan.routines.cloneOnlyExposedDefiners.slice(0, 20),
        ...(r.errors.length ? { errors: r.errors.slice(0, 10) } : {}),
        ...(dryRun ? { sample: r.sample } : {}),
      };
      if (planned === 0) {
        out.alreadyAligned += 1;
        // A clone-only exposure is not this sweep's to close, but it is worth
        // a line wherever somebody reads the result.
        if (outcome.cloneOnlyExposedDefiners.length) out.changed.push(outcome);
      } else {
        out.changed.push(outcome);
      }
    } catch (e) {
      if (e instanceof BudgetPause) {
        out.pausedAt = cloneId;
        break;
      }
      out.refused.push({ cloneId, reason: "converge_failed", error: msg(e) });
    }
  }
  return out;
}
