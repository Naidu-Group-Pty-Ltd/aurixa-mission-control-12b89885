/**
 * The shapes a cascade run can answer in, and one sentence for whoever asked.
 *
 * In `src/lib` rather than beside the engine because the SENTENCE is read by
 * client routes, and TanStack Start's import protection refuses any client
 * module that reaches into `src/server/**` — measured 2 Sep 2026: the build
 * failed on `src/routes/cascades.tsx` importing the helper from
 * `src/server/cascade/`. The types live here with it so the engine, the drain
 * and the routes all name one definition.
 */

/**
 * How much wall clock a pass may still spend, asked before each clone.
 *
 * `reserveMs` is the slowest clone this pass has processed so far: the caller
 * answers "is there room for one more of those?", the same question the sql
 * and edge-deploy lanes ask, and for the same reason — a hook pg_net abandons
 * at 60 seconds, and an isolate cut mid-clone leaves its result at `pushing`
 * with nothing to say why.
 */
export type CascadeBudget = { isPastDeadline: (reserveMs: number) => boolean };

export type CascadeRunResult =
  | {
      ok: true;
      status: "completed" | "failed" | "partial";
      counts: { succeeded: number; opened: number; failed: number; skipped: number; total: number };
    }
  | {
      ok: true;
      /**
       * GitHub's rate limit stopped the pass. The clone it stopped on is back
       * at `queued`, the event is `pending` with `next_attempt_at` at the
       * reset GitHub named, and nothing was failed — a window is not a verdict.
       */
      status: "deferred";
      until: string;
      done: number;
      total: number;
    }
  | {
      ok: true;
      /**
       * The invocation budget stopped the pass with clones still queued. The
       * event is `pending` with `next_attempt_at = now()`, so the next tick
       * carries on where this one stopped.
       */
      status: "resuming";
      done: number;
      total: number;
      /**
       * Whether the pass moved a clone forward without finishing it — blobs
       * prepared inside a clone whose pass is larger than one tick. Progress
       * that is not a finished clone is still progress, and is refunded as such.
       */
      progressed: boolean;
    }
  | { ok: false; error: string };

/**
 * One sentence for whoever pressed the button.
 *
 * `executeCascade` can now answer in five shapes, and three of them are not
 * a finished run: an error, a pass GitHub's rate limit deferred, and a pass
 * that paused at its invocation budget. Four surfaces used to read
 * `res.counts` off every non-error answer, which the two held shapes do not
 * carry — a partial tally shown as a final one is the misreading this exists
 * to prevent, so the held shapes say what was done and when the rest follows.
 */
export function describeCascadeOutcome(res: CascadeRunResult): {
  level: "success" | "warning" | "info" | "error";
  message: string;
} {
  if (!res.ok) return { level: "error", message: res.error };
  if (res.status === "deferred") {
    return {
      level: "warning",
      message:
        `Cascade deferred until ${res.until.replace(/\.\d{3}Z$/, "Z")} — GitHub's rate limit; ` +
        `${res.done} of ${res.total} clone(s) done, the rest resume then`,
    };
  }
  if (res.status === "resuming") {
    return {
      level: "info",
      message:
        `Cascade paused at the invocation budget — ${res.done} of ${res.total} clone(s) done, ` +
        `the rest resume on the next tick`,
    };
  }
  const { succeeded, opened, failed, skipped } = res.counts;
  return {
    level: "success",
    message: `Cascade ${res.status}: ${succeeded} merged · ${opened} PRs · ${failed} failed · ${skipped} skipped`,
  };
}
