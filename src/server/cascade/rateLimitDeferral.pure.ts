/**
 * A GitHub rate limit is a window, not a verdict.
 *
 * Measured 2 Sep 2026 at 13:19:50 UTC: cascade event 844df9e5 failed for all
 * three clones with "API rate limit exceeded for installation ID 157200201".
 * The engine recorded each clone `failed`, the event went `failed`, and a
 * `failed` event is never claimed again — so the prime commit it carried
 * (79a9cb78) would have reached no clone without somebody re-arming the row
 * by hand. Nothing about that commit was wrong; the App's hourly budget had
 * been spent, and GitHub said in the same response when it would be back.
 *
 * This module reads that answer off the error and turns it into a moment the
 * event may be claimed again. It decides nothing else: the engine asks it
 * about every failure it catches, and only a limit is deferred. A 403 for a
 * permission the App does not hold looks superficially similar and is NOT a
 * window — it will be exactly as denied in an hour — so the classification
 * keys on the rate-limit vocabulary and headers, never on the status alone.
 */

export type GitHubBudgetFailure =
  | {
      kind: "rate_limited";
      /** ISO instant at which the drain may claim the event again. */
      until: string;
      /** Which limit, in GitHub's own words, for the summary a person reads. */
      detail: string;
    }
  | { kind: "other" };

/** When GitHub names no reset, wait this long. A primary window is an hour. */
export const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
/**
 * Never defer past this, whatever a header says. A reset an hour and more
 * away is either a clock skew or a header this code misread, and an event
 * parked for a day on a misreading is the failure mode being replaced.
 */
export const RATE_LIMIT_CEILING_MS = 65 * 60_000;
/** Claimed a little after the reset, never on it. */
export const RATE_LIMIT_MARGIN_MS = 5_000;

type ErrorShape = {
  status?: unknown;
  message?: unknown;
  response?: { status?: unknown; headers?: Record<string, unknown> } | null;
};

function headerOf(e: ErrorShape, name: string): string | null {
  const headers = e.response?.headers;
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return typeof value === "string" ? value : value == null ? null : String(value);
    }
  }
  return null;
}

/**
 * Classify one failure from a GitHub call.
 *
 * A rate limit is recognised by any of: GitHub's own sentence (primary
 * "API rate limit exceeded", secondary "exceeded a secondary rate limit"),
 * a 429, or an `x-ratelimit-remaining: 0` header on a 403. A 403 that says
 * something else — "Resource not accessible by integration", "Not Found" —
 * is `other`, because retrying it later changes nothing.
 */
export function classifyGitHubFailure(e: unknown, now: number = Date.now()): GitHubBudgetFailure {
  if (!e || typeof e !== "object") return { kind: "other" };
  const err = e as ErrorShape;
  const status =
    typeof err.status === "number"
      ? err.status
      : typeof err.response?.status === "number"
        ? err.response.status
        : null;
  const message = typeof err.message === "string" ? err.message : "";
  const remaining = headerOf(err, "x-ratelimit-remaining");

  const saysLimit = /rate limit/i.test(message);
  const looksLimited =
    status === 429 ||
    (status === 403 && (saysLimit || remaining === "0")) ||
    (status === null && saysLimit);
  if (!looksLimited) return { kind: "other" };

  const detail = /secondary rate limit/i.test(message)
    ? "secondary rate limit"
    : /API rate limit exceeded/i.test(message)
      ? "hourly rate limit"
      : "rate limit";

  let until: number | null = null;
  const retryAfter = headerOf(err, "retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) {
    until = now + Number(retryAfter.trim()) * 1000 + RATE_LIMIT_MARGIN_MS;
  } else {
    const reset = headerOf(err, "x-ratelimit-reset");
    if (reset !== null && /^\d+$/.test(reset.trim())) {
      const at = Number(reset.trim()) * 1000 + RATE_LIMIT_MARGIN_MS;
      // A reset already behind us is a header this response did not mean
      // for this window; fall through to the fallback rather than claiming
      // at once and spending the next attempt on the same 403.
      if (at > now) until = at;
    }
  }
  if (until === null) until = now + RATE_LIMIT_FALLBACK_MS;
  until = Math.min(until, now + RATE_LIMIT_CEILING_MS);

  return { kind: "rate_limited", until: new Date(until).toISOString(), detail };
}

/** The one sentence the event carries while it waits. */
export function describeDeferral(input: {
  until: string;
  detail: string;
  done: number;
  total: number;
}): string {
  const at = input.until.replace(/\.\d{3}Z$/, "Z");
  return (
    `Deferred until ${at} — GitHub ${input.detail} for the App's installation; ` +
    `${input.done} of ${input.total} clone(s) done, the rest resume then`
  );
}

/** The one sentence a pass paused at its invocation budget carries. */
export function describePause(input: { done: number; total: number }): string {
  return `Paused at the invocation budget — ${input.done} of ${input.total} clone(s) done, the rest resume next tick`;
}
