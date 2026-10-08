/**
 * A GitHub 5xx is a moment, not a verdict, and an empty message is no record.
 *
 * ## What went wrong
 *
 * Carrier 15d4574f, 7 Oct 2026 at 16:53Z. Rows e40b1d34 and 282695be are the
 * fleet's two parents, NPC Client Dashboard and NPC CRM Independent. Both were
 * recorded `failed` with an EMPTY `error_message`.
 *
 * The record kept nothing about what GitHub said, or to which call. Two facts
 * about the code explain how a failure can carry no words at all:
 *
 *  - `@octokit/request` builds a `RequestError`'s message from the response
 *    body (`toErrorMessage`). A 5xx GitHub serves with an empty body becomes
 *    the empty string. One served as an HTML page becomes the whole page.
 *  - The engine's catch wrote `e.message` and nothing else, so the status and
 *    the route were dropped even when they were there.
 *
 * What those two rows were cannot be recovered now. That is the point: this
 * module stops a failure being recorded that way again, whatever they were.
 *
 * A failed row on a carrier that has not settled is visited by nothing (see
 * `carrierRefresh.pure.ts`). A parent left there holds every clone below it.
 * So whatever GitHub's answer was, it held the whole fleet until a person
 * re-armed the rows, fourteen hours later.
 *
 * ## The rule
 *
 * **A server error is retried a few times against the same prime head, then
 * failed.**
 *
 *  - It counts when GitHub answers 500, 502, 503 or 504. Octokit gives a
 *    request that never reached GitHub (`fetch failed`, a reset socket) the
 *    status 500 as well, and that is the same kind of moment.
 *  - The row goes back to `queued` with a window, and the event is held until
 *    it ends.
 *  - After `SERVER_ERROR_RETRY_WINDOWS_MS.length` retries the row is failed,
 *    and its message says how many retries it had.
 *
 * **The count lives on the row, not the event.** The drain refunds the
 * attempt a deferral spends (`hooks.cascade-drain`), so nothing at the event
 * level bounds this. A 5xx that recurs is not a blip: a tree too large for
 * GitHub to write in time answers 502 on every attempt. The marker is the last
 * clause of the row's own `error_message`, which the next pass reads before it
 * writes anything.
 *
 * **The count is per prime head.** `planCarrierRefresh` re-offers a failed row
 * once per head, so a new head deserves a new count, and an old marker counts
 * for nothing against it.
 *
 * **The prime read is counted too, on the event.** It comes before any head is
 * known and before any row is worked, and a failure there fails the whole
 * event and settles every row under it. Its count is kept in the event's
 * summary against the branch, because nothing else is written between two
 * attempts at it.
 *
 * **Only a server error is retried.** A 4xx is GitHub's answer about the
 * request. A 403 for a permission the App does not hold, or a 422 on a tree,
 * is exactly as true in thirty minutes. A rate limit is `rateLimitDeferral`'s,
 * and is asked first.
 *
 * ## The description
 *
 * `describeGitHubFailure` is what a failed row records for ANY failure. It
 * names the status and the route GitHub was asked, never the query string,
 * which can carry a token. A 4xx with words keeps its own words unchanged,
 * because readers such as `isInvocationCut` match on them. An HTML error page
 * is not printed: it reads as "an HTML error page".
 */

/** How long each retry waits, in order. The count of entries is the bound. */
export const SERVER_ERROR_RETRY_WINDOWS_MS: readonly number[] = [
  2 * 60_000,
  8 * 60_000,
  30 * 60_000,
];

/** The statuses that say GitHub, not the request, failed. */
export const SERVER_ERROR_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

/** A message is cut here. A failure is one line, not a page. */
const MESSAGE_LIMIT = 300;

type HttpErrorShape = {
  status?: unknown;
  message?: unknown;
  name?: unknown;
  cause?: unknown;
  request?: { method?: unknown; url?: unknown } | null;
};

type HttpFailure = {
  status: number;
  method: string;
  path: string;
  text: string;
  /** The message as GitHub's error carried it, before `textOf`. */
  raw: string;
  /** True when the HTTP error was the `cause` of the error caught. */
  wrapped: boolean;
};

/** The route GitHub was asked, without the origin or the query string. */
function routeOf(url: string): string {
  try {
    return new URL(url, "https://api.github.com").pathname;
  } catch {
    const at = url.search(/[?#]/);
    return at === -1 ? url : url.slice(0, at);
  }
}

/** One line of what GitHub said, or "" when it said nothing. */
function textOf(message: unknown): string {
  if (typeof message !== "string") return "";
  const trimmed = message.trim();
  if (trimmed === "") return "";
  if (/^<!doctype html|^<html|<\/html>\s*$/i.test(trimmed)) return "an HTML error page";
  const line = trimmed.replace(/\s+/g, " ");
  return line.length > MESSAGE_LIMIT ? `${line.slice(0, MESSAGE_LIMIT - 1)}…` : line;
}

/**
 * The HTTP failure an Octokit error carries, looking one `cause` deep. The
 * engine wraps some failures (`Clone … unreachable: …`) and keeps the original
 * as the cause, so its status is still there to read.
 */
function httpFailureOf(e: unknown): HttpFailure | null {
  let at: unknown = e;
  for (let depth = 0; depth < 2 && at && typeof at === "object"; depth++) {
    const err = at as HttpErrorShape;
    const req = err.request;
    if (
      typeof err.status === "number" &&
      req &&
      typeof req === "object" &&
      typeof req.method === "string" &&
      typeof req.url === "string"
    ) {
      const raw = typeof err.message === "string" ? err.message : "";
      return {
        status: err.status,
        method: req.method.toUpperCase(),
        path: routeOf(req.url),
        text: textOf(raw),
        raw,
        wrapped: depth > 0,
      };
    }
    at = err.cause;
  }
  return null;
}

/** The status of a GitHub server error, or null when it is something else. */
export function serverErrorStatus(e: unknown): number | null {
  const http = httpFailureOf(e);
  return http && SERVER_ERROR_STATUSES.has(http.status) ? http.status : null;
}

/**
 * One line a failed row can carry about any failure.
 *
 * A GitHub server error, or a GitHub answer with no words, names its status
 * and route. Where the engine wrapped it, the engine's own words say which
 * step it was, and GitHub's answer follows in brackets. A 4xx that said
 * something keeps its words as they were. Anything else keeps its message,
 * and an empty one still says what kind of thing failed.
 */
export function describeGitHubFailure(e: unknown): string {
  const http = httpFailureOf(e);
  if (http && (http.status >= 500 || http.status === 0 || http.text === "")) {
    const answer =
      `GitHub answered ${http.status} to ${http.method} ${http.path}` +
      (http.text ? `: ${http.text}` : " with no message");
    if (!http.wrapped || !(e instanceof Error)) return answer;
    // The wrapping repeats GitHub's message after its own words; what is left
    // once that is taken off is the step.
    const own = e.message.endsWith(http.raw)
      ? e.message.slice(0, e.message.length - http.raw.length)
      : e.message;
    const step = textOf(own.replace(/[\s:—-]+$/, ""));
    return step ? `${step} (${answer})` : answer;
  }
  if (e instanceof Error) {
    const own = textOf(e.message);
    return own || `${e.name || "Error"} with no message`;
  }
  return textOf(String(e ?? "")) || "a failure with no message";
}

/** What a retried row is held against: the head it failed at. */
export function retryAnchor(head: string): string {
  return `prime@${head.trim().slice(0, 7)}`;
}

const RETRY_MARKER = /; retry (\d+) of (\d+) against (\S+)$/;

/** The retries already spent against `anchor`, read off the row's last message. */
export function retriesSpent(priorMessage: string | null | undefined, anchor: string): number {
  const m = (priorMessage ?? "").match(RETRY_MARKER);
  if (!m || m[3] !== anchor) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export type ServerFailurePlan =
  | {
      act: "defer";
      status: number;
      /** ISO instant the row may be tried again. */
      until: string;
      /** This retry, counting from one. */
      retry: number;
      of: number;
      /** The row's `error_message` while it waits. */
      rowMessage: string;
    }
  | {
      act: "fail";
      status: number;
      /** What the failed row records, before the head stamp is added. */
      rowMessage: string;
    };

/**
 * What to do with a row whose pass ended on `e`, or null when `e` is not a
 * GitHub server error and this module has nothing to say about it.
 */
export function planServerFailure(input: {
  e: unknown;
  /**
   * What the count is kept against: `retryAnchor(head)` for a result row, or
   * the branch for the prime read, which happens before any head is known.
   */
  anchor: string;
  /** The message the last attempt left, where the count is read from. */
  priorMessage: string | null | undefined;
  now?: number;
}): ServerFailurePlan | null {
  const status = serverErrorStatus(input.e);
  if (status === null) return null;
  const description = describeGitHubFailure(input.e);
  const anchor = input.anchor.trim();
  const of = SERVER_ERROR_RETRY_WINDOWS_MS.length;
  const retry = retriesSpent(input.priorMessage, anchor) + 1;
  if (retry > of) {
    return {
      act: "fail",
      status,
      rowMessage: `${description}; ${of} retries against this head did not clear it`,
    };
  }
  const now = input.now ?? Date.now();
  const until = new Date(now + SERVER_ERROR_RETRY_WINDOWS_MS[retry - 1]).toISOString();
  return {
    act: "defer",
    status,
    until,
    retry,
    of,
    rowMessage: `Deferred until ${until.replace(/\.\d{3}Z$/, "Z")} — ${description}; retry ${retry} of ${of} against ${anchor}`,
  };
}

/** The one sentence a carrier holding for GitHub server errors carries. */
export function describeServerDeferral(input: {
  until: string;
  deferrals: ReadonlyArray<{ clone: string; status: number; retry: number; of: number }>;
  done: number;
  total: number;
}): string {
  const at = input.until.replace(/\.\d{3}Z$/, "Z");
  const [first, ...rest] = input.deferrals;
  const who = first
    ? `GitHub answered ${first.status} on ${first.clone}'s pass (retry ${first.retry} of ${first.of})` +
      (rest.length > 0 ? ` and on ${rest.length} other clone(s)` : "")
    : "GitHub answered with a server error";
  return (
    `Deferred until ${at} — ${who}; ` +
    `${input.done} of ${input.total} clone(s) done, the rest resume then`
  );
}
