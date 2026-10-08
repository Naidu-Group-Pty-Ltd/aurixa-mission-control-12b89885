/**
 * Checks GitHub never started are re-run by the drain, a few times per head.
 *
 * ## What went wrong
 *
 * `decideCascadeMerge` recognises a head whose every failed check ended within
 * seconds of starting (`never_started`). That is how GitHub declines to start
 * jobs on a private repository once the organisation's included Actions minutes
 * are spent or its spending limit is reached. The verdict names the remedy:
 * fix the limit, "then re-run the checks".
 *
 * Nothing in the platform re-ran them. Fixing the limit starts no job that was
 * already declined, so a proposal held for billing stayed held after billing
 * recovered, until a person found it and pressed re-run.
 *
 * Measured on the fleet's two parent clones. At 03:17Z and 03:18Z on 7 Oct
 * 2026, every job of the `CI` run on each one's cascade head failed one to
 * three seconds after it was created, with no step run: NPC Client
 * Dashboard's run 37566131354 and the CRM line's run 37566080080. Nothing
 * re-ran them until a person did, at 06:41Z on 8 Oct, twenty-seven hours
 * later. Every clone below the first parent was held by lineage for all of
 * that time.
 *
 * ## The rule
 *
 * **A head whose failures all never started is re-run by the drain, on
 * growing windows, a bounded number of times.**
 *
 *  - Billing cannot be read with the permissions a repository-scoped App
 *    holds, so the re-run is itself the probe. A re-run while the limit still
 *    stands is declined in seconds and costs no minutes, because no job runs.
 *    A single re-run would usually be spent before anybody fixed the limit,
 *    so it is retried on windows, not once.
 *  - The windows are counted from the moment the newest attempt was declined,
 *    so a re-run that is still queued or running is never re-run again.
 *  - **The count is GitHub's own, per head.** Every attempt leaves a check run
 *    of the same name on the head, so the re-runs already spent are the number
 *    of runs of a declined check, less one. Nothing is written to remember it,
 *    and a new head (the next cascade push) starts the count again.
 *  - Once the count is spent the drain stops and says so. The hold still names
 *    the remedy, and a re-run by hand or the next push starts the jobs again.
 *
 * **Only a head where EVERY failure never started is re-run**, which is what
 * `never_started` already means. One check that ran and failed makes the
 * verdict `failing`, and nothing here touches it. A real failure is never
 * re-run in the hope of a different answer.
 *
 * **Only GitHub Actions runs are re-run.** The workflow run is read from the
 * check run's own `details_url`. A check from any other app has no such link,
 * and is left alone.
 *
 * The re-run needs the App's `Actions: Read and write` permission. Without it
 * GitHub refuses, and the hold says that the App cannot do this itself.
 *
 * Client-safe: pure.
 */

/** How long after the newest declined attempt each re-run waits, in order. */
export const NEVER_STARTED_RERUN_WINDOWS_MS: readonly number[] = [
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
];

/** A check run as the planner reads it. */
export type DeclinedCheck = {
  name: string;
  completed_at?: string | null;
  /** GitHub Actions links its check runs to `/actions/runs/{run_id}/job/{job_id}`. */
  details_url?: string | null;
};

export type NeverStartedRerunPlan =
  | {
      act: "rerun";
      /** The workflow runs to re-run, each once. */
      runIds: number[];
      /** This re-run, counting from one. */
      retry: number;
      of: number;
    }
  | { act: "wait"; until: string; retry: number; of: number }
  | { act: "exhausted"; of: number }
  /** Nothing here can re-run these: no Actions run to name, or no count to bound it. */
  | { act: "unaddressable"; why: string };

/** The workflow run an Actions check run belongs to, or null. */
export function workflowRunIdOf(detailsUrl: string | null | undefined): number | null {
  if (typeof detailsUrl !== "string") return null;
  const m = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(detailsUrl);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The re-runs already spent on this head: the most runs any declined check
 * has, less one. The most rather than the fewest, so a job that appears in two
 * workflows can only make this stop sooner, never later.
 */
export function rerunsSpent(
  declined: ReadonlyArray<Pick<DeclinedCheck, "name">>,
  allRuns: ReadonlyArray<{ name: string }>,
): number {
  let most = 0;
  for (const { name } of declined) {
    const runs = allRuns.filter((r) => r.name === name).length;
    if (runs > most) most = runs;
  }
  return Math.max(0, most - 1);
}

/**
 * What the drain does with a head whose every failure never started.
 *
 * `declined` is the failed checks of the LATEST attempt, which the verdict was
 * decided on. `allRuns` is every check run on the head across attempts, or
 * null when it could not be read: with no count there is no bound, so nothing
 * is re-run.
 */
export function planNeverStartedRerun(input: {
  declined: ReadonlyArray<DeclinedCheck>;
  allRuns: ReadonlyArray<{ name: string }> | null;
  now?: number;
}): NeverStartedRerunPlan {
  const of = NEVER_STARTED_RERUN_WINDOWS_MS.length;
  if (input.declined.length === 0) {
    return { act: "unaddressable", why: "no declined check was handed in" };
  }
  if (input.allRuns === null) {
    return {
      act: "unaddressable",
      why: "the head's earlier attempts could not be read, so a re-run could not be counted",
    };
  }
  const spent = rerunsSpent(input.declined, input.allRuns);
  if (spent >= of) return { act: "exhausted", of };

  const runIds = [
    ...new Set(
      input.declined
        .map((c) => workflowRunIdOf(c.details_url))
        .filter((id): id is number => id !== null),
    ),
  ];
  if (runIds.length === 0) {
    return { act: "unaddressable", why: "none of the declined checks is a GitHub Actions run" };
  }

  const declinedAt = input.declined
    .map((c) => (c.completed_at ? Date.parse(c.completed_at) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  // A decline with no readable time cannot be waited out, so it is waited
  // on as though it had just happened: the next pass reads it again.
  const now = input.now ?? Date.now();
  const last = declinedAt.length > 0 ? Math.max(...declinedAt) : now;
  const retry = spent + 1;
  const due = last + NEVER_STARTED_RERUN_WINDOWS_MS[spent];
  if (now < due) {
    return { act: "wait", until: new Date(due).toISOString(), retry, of };
  }
  return { act: "rerun", runIds, retry, of };
}

/** What happened when the drain asked GitHub to re-run, for the hold's words. */
export type RerunOutcome =
  | { ok: true }
  /** GitHub refused; `forbidden` when the App lacks the permission. */
  | { ok: false; forbidden: boolean; why: string };

/**
 * The clause the hold carries about re-running, appended to the verdict's own
 * words. It is part of the open reason, which `openSentence` folds into one
 * sentence, so it is rewritten on every pass rather than accumulated.
 */
export function describeNeverStartedRerun(
  plan: NeverStartedRerunPlan,
  outcome?: RerunOutcome,
): string {
  const at = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");
  switch (plan.act) {
    case "rerun":
      if (!outcome || outcome.ok) {
        return (
          `Mission Control has re-run them (retry ${plan.retry} of ${plan.of}); ` +
          "if they start this time, the limit has been lifted."
        );
      }
      return outcome.forbidden
        ? `Mission Control could not re-run them, because the GitHub App lacks Actions: Read and write (${outcome.why}); grant it, or re-run them by hand.`
        : `Mission Control could not re-run them (${outcome.why}); re-run them by hand.`;
    case "wait":
      return `Mission Control re-runs them itself after ${at(plan.until)} (retry ${plan.retry} of ${plan.of}).`;
    case "exhausted":
      return `Mission Control has re-run them ${plan.of} times on this head and has stopped; a re-run by hand, or the next cascade push, starts them again.`;
    case "unaddressable":
      return `Mission Control cannot re-run them itself: ${plan.why}.`;
  }
}

/** Whether GitHub refused a re-run because the App lacks the permission. */
export function rerunForbidden(e: unknown): boolean {
  const status =
    e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number"
      ? (e as { status: number }).status
      : null;
  const message = e instanceof Error ? e.message : String(e ?? "");
  return status === 403 && /Resource not accessible by integration/i.test(message);
}
