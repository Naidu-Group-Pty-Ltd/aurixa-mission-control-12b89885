import { isUpstreamRateLimit } from "@/server/provisioningBudget";

/**
 * What an upstream quota refusal costs a remediation run.
 *
 * ## What this exists to stop
 *
 * `executeRemediationRun` charges an attempt for every thrown error, and at
 * `max_attempts` the run is marked `failed` and a person is paged. That is
 * right for a run that keeps failing at its own work. It is wrong for a run
 * that never got to do any: measured 7 Sep 2026, all three clones' backend
 * catch-up runs sat at 20 of 30 attempts with the same `last_error` —
 *
 *   API rate limit exceeded for installation ID 157200201
 *
 * — having landed 154, 131 and 6 of the prime's 423 function bundles. The
 * quota was letting roughly 124 bundles through an hour across the fleet, so
 * the work would have converged in about eight hours; the attempt counter was
 * burning at six an hour, so all three would have PARKED in about ninety
 * minutes with two thirds of the fleet's backends never updated — and the
 * notification would have named the deploy as the thing that failed.
 *
 * This is the same charge `isUpstreamRateLimit` was written for on 31 Aug,
 * on the provisioning side of the same engine. The recognition is THAT
 * module's and is imported rather than restated: two spellings of "is this a
 * quota" is how one of them comes to disagree with the other. What is new
 * here is the accounting, because the two paths bound the retrying
 * differently — provisioning is held by `reclaimStalled`'s wall clock, and a
 * remediation run has no such ceiling, so it needs one of its own.
 *
 * ## The two rules
 *
 * **A deferral is bounded, because recognition can still be wrong.** An
 * installation refusing permanently, or a genuine fault whose message happens
 * to name a limit, must still reach a human. Past the ceiling the deferral
 * stops and the error is charged like any other, so the run walks its
 * remaining attempts and parks normally. Unbounded deferral is the worse
 * failure of the two: it is silent.
 *
 * **Progress clears the streak, and only CONSECUTIVE refusals count.** The
 * count lives on the run's `result`, which every lane REPLACES on a pass that
 * did work — so a pass that landed bundles resets it without anything having
 * to remember to. What is bounded is "refused this many times in a row",
 * which is the question, rather than "refused this many times ever", which
 * would park a run making steady progress through an intermittent limit.
 */

/** How many consecutive upstream refusals a run may defer before it is charged. */
export const MAX_UPSTREAM_DEFERRALS = 40;

/** Where the consecutive-refusal count lives on a run's `result` jsonb. */
export const UPSTREAM_DEFERRAL_KEY = "upstream_deferrals";

export type UpstreamDeferral =
  /** Requeue without spending an attempt; `deferrals` is the new count. */
  | { readonly kind: "defer"; readonly deferrals: number }
  /** Out of deferrals, or not a refusal — account for it as an ordinary failure. */
  | { readonly kind: "charge" };

/**
 * Read the consecutive-refusal count off a run's `result`.
 *
 * A result that is absent, not an object, or carries no count answers ZERO —
 * the conservative direction here, because it grants the run a full ceiling
 * of deferrals rather than parking it early on a reading that was never
 * written.
 */
export function deferralsSoFar(result: unknown): number {
  if (!result || typeof result !== "object" || Array.isArray(result)) return 0;
  const raw = (result as Record<string, unknown>)[UPSTREAM_DEFERRAL_KEY];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** Decide what a thrown error costs this run. */
export function planUpstreamDeferral(input: {
  /** The thrown value itself — `isUpstreamRateLimit` reads its status as well as its message. */
  readonly error: unknown;
  readonly result: unknown;
  readonly maxDeferrals?: number;
}): UpstreamDeferral {
  if (!isUpstreamRateLimit(input.error)) return { kind: "charge" };

  const ceiling = input.maxDeferrals ?? MAX_UPSTREAM_DEFERRALS;
  const next = deferralsSoFar(input.result) + 1;
  if (next > ceiling) return { kind: "charge" };
  return { kind: "defer", deferrals: next };
}
