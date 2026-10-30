/**
 * Which of provisioning's finishing steps fit in what is left of the pass.
 *
 * Once the pipeline returns, the runner finishes the backend in the same
 * invocation: it re-points the clone's repository, deploys the functions the
 * clone carries itself, gives it an Anthropic workspace and model keys,
 * compares it with the prime, and marks it ready. None of that was budgeted.
 * It ran in whatever the pipeline had left of a request pg_net abandons at 60
 * seconds, and a pass cut off before the ready write leaves the backend
 * `migrating` with nothing recorded.
 *
 * Measured on `tutorial-demo-orrimere-c158c7`, 30 Oct 2026: a pipeline with
 * nothing left to do took 32 seconds, the re-point took most of the rest, and
 * the clone-owned deploy (fourteen functions on the independent line, one of
 * them 8.1 MB) began a few seconds before the cut. Every pass died there,
 * and the backend could never be marked ready.
 *
 * So:
 *
 *  - the re-point, which nothing else performs and the deployment gate
 *    requires, stops between steps at the deadline and the pass pauses; its
 *    writes are commits, so the next pass carries on from them;
 *  - a step another lane also performs runs only when it fits, and otherwise
 *    is left to that lane, said so in the status line;
 *  - the ready write always lands.
 */

export type FinishingStep = "cloneOwnedFunctions" | "anthropicWorkspace" | "llmKeys" | "parity";

/**
 * How much of the pass a step needs left before it is started, measured
 * against the invocation's deadline rather than pg_net's cut, so the ready
 * write behind it still lands.
 */
export const FINISHING_STEP_NEEDS_MS: Readonly<Record<FinishingStep, number>> = {
  // Builds and uploads every function the clone owns; on the independent
  // line that is fourteen, `ai-dashboard-agent` alone 494 files and 8.1 MB.
  cloneOwnedFunctions: 30_000,
  anthropicWorkspace: 8_000,
  // Up to five vendors, one mint each.
  llmKeys: 12_000,
  // Both catalogues, and the prime's migration object index from GitHub.
  parity: 20_000,
};

/** Who finishes a step this pass had no room for. */
export const FINISHING_STEP_FALLBACK: Readonly<Record<FinishingStep, string>> = {
  cloneOwnedFunctions: "the half-hourly backend catch-up deploys them once the backend is ready",
  anthropicWorkspace: "the half-hourly secrets reconcile provisions it",
  llmKeys: "the half-hourly secrets reconcile mints them",
  parity: "the backend is marked ready without the comparison",
};

const STEP_NAME: Readonly<Record<FinishingStep, string>> = {
  cloneOwnedFunctions: "The functions this clone carries itself were not deployed",
  anthropicWorkspace: "This clone's Anthropic workspace was not provisioned",
  llmKeys: "This clone's model keys were not minted",
  parity: "The new backend was not compared with the prime",
};

/**
 * Whether `step` may start now.
 *
 * With no deadline (a caller that is not budgeted) every step fits, which is
 * how all of them ran before.
 */
export function finishingStepFits(
  step: FinishingStep,
  deadlineAt: number | null | undefined,
  now: number,
): boolean {
  if (deadlineAt === null || deadlineAt === undefined) return true;
  return deadlineAt - now >= FINISHING_STEP_NEEDS_MS[step];
}

/** Why parity was not read, when the pass had no room for it. Shown in the ready line. */
export const PARITY_DEFERRED_REASON =
  "the pass that finished the backend had no time left to run it";

/** The status line for a step left to its own lane. */
export function deferredLine(step: FinishingStep): string {
  return `${STEP_NAME[step]} in this pass — it had no time left; ${FINISHING_STEP_FALLBACK[step]}`;
}
