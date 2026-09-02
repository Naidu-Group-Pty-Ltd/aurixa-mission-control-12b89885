import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_CEILING_MS,
  RATE_LIMIT_FALLBACK_MS,
  RATE_LIMIT_MARGIN_MS,
  classifyGitHubFailure,
  describeDeferral,
  describePause,
} from "./rateLimitDeferral.pure";

const NOW = Date.parse("2026-09-02T13:19:50.000Z");

function ghError(input: {
  status?: number;
  message: string;
  headers?: Record<string, string>;
}): Error & { status?: number; response?: { status?: number; headers?: Record<string, string> } } {
  const e = new Error(input.message) as Error & {
    status?: number;
    response?: { status?: number; headers?: Record<string, string> };
  };
  e.status = input.status;
  e.response = { status: input.status, headers: input.headers ?? {} };
  return e;
}

describe("classifyGitHubFailure", () => {
  it("reads the primary limit's reset off the response and claims just after it", () => {
    /* The exact failure of 2 Sep 2026: a 403 whose message is GitHub's own
       sentence, with the window's reset in the headers. */
    const reset = Math.floor(NOW / 1000) + 40 * 60;
    const verdict = classifyGitHubFailure(
      ghError({
        status: 403,
        message:
          "API rate limit exceeded for installation ID 157200201. If you reach out to GitHub Support for help, please include the request ID 85C6:262230",
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      }),
      NOW,
    );
    expect(verdict.kind).toBe("rate_limited");
    if (verdict.kind !== "rate_limited") return;
    expect(Date.parse(verdict.until)).toBe(reset * 1000 + RATE_LIMIT_MARGIN_MS);
    expect(verdict.detail).toBe("hourly rate limit");
  });

  it("prefers retry-after when a secondary limit names one", () => {
    const verdict = classifyGitHubFailure(
      ghError({
        status: 403,
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        headers: {
          "Retry-After": "120",
          "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3000),
        },
      }),
      NOW,
    );
    expect(verdict).toEqual({
      kind: "rate_limited",
      until: new Date(NOW + 120_000 + RATE_LIMIT_MARGIN_MS).toISOString(),
      detail: "secondary rate limit",
    });
  });

  it("treats a 429 as a limit even without GitHub's sentence", () => {
    const verdict = classifyGitHubFailure(
      ghError({ status: 429, message: "Too Many Requests" }),
      NOW,
    );
    expect(verdict.kind).toBe("rate_limited");
    if (verdict.kind !== "rate_limited") return;
    expect(Date.parse(verdict.until)).toBe(NOW + RATE_LIMIT_FALLBACK_MS);
  });

  it("a 403 that is a permission is not a window", () => {
    /* Exactly as denied in an hour. Deferring it would hide a configuration
       fault behind a clock. */
    expect(
      classifyGitHubFailure(
        ghError({ status: 403, message: "Resource not accessible by integration" }),
        NOW,
      ),
    ).toEqual({ kind: "other" });
    expect(classifyGitHubFailure(ghError({ status: 404, message: "Not Found" }), NOW)).toEqual({
      kind: "other",
    });
    expect(classifyGitHubFailure(ghError({ status: 500, message: "boom" }), NOW)).toEqual({
      kind: "other",
    });
    expect(classifyGitHubFailure(null, NOW)).toEqual({ kind: "other" });
    expect(classifyGitHubFailure("API rate limit exceeded", NOW)).toEqual({ kind: "other" });
  });

  it("recognises the sentence when the engine has already wrapped the error without a status", () => {
    /* `processClone` rethrows some failures as `new Error(\`Clone … unreachable: ${e.message}\`)`,
       which keeps the words and loses the status. The words are enough. */
    const verdict = classifyGitHubFailure(
      new Error(
        "Clone Naidu-Group-Pty-Ltd/npc-test-76b3b3@main unreachable: API rate limit exceeded for installation ID 157200201.",
      ),
      NOW,
    );
    expect(verdict.kind).toBe("rate_limited");
    if (verdict.kind !== "rate_limited") return;
    expect(Date.parse(verdict.until)).toBe(NOW + RATE_LIMIT_FALLBACK_MS);
  });

  it("a reset already behind us falls back rather than claiming at once", () => {
    const verdict = classifyGitHubFailure(
      ghError({
        status: 403,
        message: "API rate limit exceeded for installation ID 1.",
        headers: { "x-ratelimit-reset": String(Math.floor(NOW / 1000) - 60) },
      }),
      NOW,
    );
    expect(verdict.kind).toBe("rate_limited");
    if (verdict.kind !== "rate_limited") return;
    expect(Date.parse(verdict.until)).toBe(NOW + RATE_LIMIT_FALLBACK_MS);
  });

  it("never defers past the ceiling, whatever the header says", () => {
    const verdict = classifyGitHubFailure(
      ghError({
        status: 403,
        message: "API rate limit exceeded for installation ID 1.",
        headers: { "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 86_400) },
      }),
      NOW,
    );
    expect(verdict.kind).toBe("rate_limited");
    if (verdict.kind !== "rate_limited") return;
    expect(Date.parse(verdict.until)).toBe(NOW + RATE_LIMIT_CEILING_MS);
  });

  it("an exhausted window on a 403 counts even when the message is not GitHub's", () => {
    const verdict = classifyGitHubFailure(
      ghError({ status: 403, message: "Forbidden", headers: { "x-ratelimit-remaining": "0" } }),
      NOW,
    );
    expect(verdict.kind).toBe("rate_limited");
  });
});

describe("the sentences", () => {
  it("say when, which limit, and how much is left", () => {
    const s = describeDeferral({
      until: "2026-09-02T14:19:55.000Z",
      detail: "hourly rate limit",
      done: 1,
      total: 3,
    });
    expect(s).toBe(
      "Deferred until 2026-09-02T14:19:55Z — GitHub hourly rate limit for the App's installation; 1 of 3 clone(s) done, the rest resume then",
    );
    expect(describePause({ done: 2, total: 3 })).toContain("2 of 3 clone(s) done");
  });
});
