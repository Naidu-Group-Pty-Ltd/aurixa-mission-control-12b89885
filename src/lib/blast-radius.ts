// Pure, isomorphic blast-radius assessment. Lives in /lib (not /server) so
// route components can import it without dragging server-only code into the
// client bundle. Server modules re-export this from cascade-approvals.server.
import type { Database } from "@/integrations/supabase/types";

export const HIGH_RISK_CLONE_COUNT = 10;
export const AUTO_MERGE_THRESHOLD = 3;

/**
 * Who asked for this cascade.
 *
 * `operator` — a person pressed something: the bulk cascade form, a module
 * push, a brand sync, a schedule a person armed. The blast radius is a fact
 * about a decision being taken NOW, and a second pair of eyes on a wide,
 * irreversible write is a real control.
 *
 * `automatic` — prime's own `main` moved and the webhook minted a cascade to
 * carry it. See {@link assessBlastRadius} for why a count may not gate one.
 */
export type CascadeOrigin = "operator" | "automatic";

export type BlastAssessment = {
  cloneCount: number;
  requiresApproval: boolean;
  reason: string | null;
};

/**
 * Decide whether a cascade event of the given mode targeting `cloneCount`
 * clones must wait for a second operator's approval. Used by the cascade
 * form, the engine, schedules, drift policies, and module-sync.
 *
 * ## Why an automatic cascade is not gated on a count
 *
 * Measured on this fleet, 19 September 2026. The fourth clone was registered
 * at 05:20:23. The next prime commit cascade — 06:59:52, PR #2703 — counted
 * four clones, `4 > AUTO_MERGE_THRESHOLD`, and gated. So did every one after
 * it. By 12:00 eight cascade events stood `pending` with `requires_approval`
 * true and `approved_at` null, carrying 32 queued result rows, and all four
 * tenants sat 69 commits behind prime at `d86f485c` — among the withheld
 * commits PR #2702, *"Close the one table in this database with RLS switched
 * off"*. The gate was making the fleet less safe than distributing would
 * have, which is the clearest possible sign it was asking the wrong question.
 *
 * Three things made it a stall rather than a pause.
 *
 * **There was no first operator.** A webhook event carries
 * `initiated_by = NULL`, and the refusal it printed read *"Auto-merge across
 * 4 clones (>3) requires a second operator."* Nobody was first. `approveCascade`
 * is the only writer of `approved_at` anywhere in this codebase and it is a
 * UI act; `cascade_approvals` has never held a row. A control whose only
 * discharge is an act nobody is positioned to perform is an outage, not a
 * control.
 *
 * **The threshold is a growth cliff, not a radius.** Three is a fleet size
 * every real deployment passes in its first month, after which *every* prime
 * commit — around fifty a day — needs a human. At that rate the human either
 * rubber-stamps, which is not review, or the fleet stops, which is what
 * happened. A gate that fires on all traffic measures nothing.
 *
 * **It is the same decision, asked twice.** A commit cascade does not propose
 * a change; it replays one prime has already merged, and it reads prime's head
 * at run time rather than the commit that minted it. What a client of this
 * fleet gets when the gate holds is not the old, reviewed state — it is an
 * ever-widening divergence from it.
 *
 * So the count binds a cascade somebody STARTED. What bounds an automatic one
 * is content, not arithmetic, and that already runs per file: the path
 * approvals in `cascade_path_approvals`, the sync exclusions, the dry-run
 * boundary, and `deletionPropagation`'s withholding of prime deletions. None
 * of those is weakened here, and a cascade an operator starts is assessed
 * today exactly as it was yesterday — `origin` defaults to `operator`, so a
 * call site that says nothing keeps the gate.
 *
 * A scheduled cascade stays on the operator side deliberately: a schedule is a
 * standing decision by a named person, its brand pushes are irreversible, and
 * it is not the lane that stalled.
 */
export function assessBlastRadius(
  mode: Database["public"]["Enums"]["cascade_mode"],
  cloneCount: number,
  origin: CascadeOrigin = "operator",
): BlastAssessment {
  if (origin === "automatic") {
    return { cloneCount, requiresApproval: false, reason: null };
  }
  if (mode === "auto_merge" && cloneCount > AUTO_MERGE_THRESHOLD) {
    return {
      cloneCount,
      requiresApproval: true,
      reason: `Auto-merge across ${cloneCount} clones (>${AUTO_MERGE_THRESHOLD}) requires a second operator.`,
    };
  }
  if (cloneCount > HIGH_RISK_CLONE_COUNT) {
    return {
      cloneCount,
      requiresApproval: true,
      reason: `Cascade against ${cloneCount} clones (>${HIGH_RISK_CLONE_COUNT}) requires a second operator.`,
    };
  }
  return { cloneCount, requiresApproval: false, reason: null };
}
