import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RequestError } from "@octokit/request-error";
import {
  SERVER_ERROR_RETRY_WINDOWS_MS,
  describeGitHubFailure,
  describeServerDeferral,
  planServerFailure,
  retriesSpent,
  retryAnchor,
  serverErrorStatus,
} from "./githubServerError.pure";
import { classifyGitHubFailure } from "./rateLimitDeferral.pure";
import { stampFailedAgainst } from "./carrierRefresh.pure";
import { stripComments } from "../sourceComments.pure";

const NOW = Date.parse("2026-10-07T16:53:00.000Z");
const HEAD = "d4b3be7a1f0c2e9d8b7a6c5d4e3f2a1b0c9d8e7f";
const NEXT_HEAD = "44ec13d9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3";

/** The error Octokit itself throws, built by its own class. */
function octokitError(status: number, message: string, method = "POST", url?: string) {
  return new RequestError(message, status, {
    request: {
      method: method as "POST",
      url: url ?? "https://api.github.com/repos/Naidu-Group-Pty-Ltd/npc-client-dashboard/git/trees",
      headers: { authorization: "token ghs_secret" },
    },
    response: { status, url: "", headers: {}, data: "" },
  });
}

describe("what Octokit hands the engine for a 5xx with no body", () => {
  it("is an error whose message is empty, which is what carrier 15d4574f recorded", () => {
    /* `toErrorMessage("")` in `@octokit/request` is "", and the engine wrote
       `e.message`. The status and the route were on the error the whole
       time. */
    const e = octokitError(502, "");
    expect(e.message).toBe("");
    expect(describeGitHubFailure(e)).toBe(
      "GitHub answered 502 to POST /repos/Naidu-Group-Pty-Ltd/npc-client-dashboard/git/trees with no message",
    );
  });
});

describe("which failures are a GitHub server error", () => {
  it("takes 500, 502, 503 and 504 from GitHub", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(serverErrorStatus(octokitError(status, "Server Error"))).toBe(status);
    }
  });

  it("takes a request that never reached GitHub, which Octokit reports as 500", () => {
    expect(serverErrorStatus(octokitError(500, "fetch failed"))).toBe(500);
  });

  it("refuses every 4xx: GitHub's answer about the request is as true in thirty minutes", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(serverErrorStatus(octokitError(status, "nope"))).toBeNull();
    }
  });

  it("refuses an error that names a status but was not a GitHub request", () => {
    const e = Object.assign(new Error("boom"), { status: 502 });
    expect(serverErrorStatus(e)).toBeNull();
    expect(serverErrorStatus(null)).toBeNull();
    expect(serverErrorStatus("502")).toBeNull();
  });

  it("reads the status through the engine's own wrapping", () => {
    const inner = octokitError(503, "", "GET", "https://api.github.com/repos/o/r/branches/main");
    const wrapped = new Error(`Clone o/r@main unreachable: ${inner.message}`, { cause: inner });
    expect(serverErrorStatus(wrapped)).toBe(503);
  });

  it("is never a rate limit, which `rateLimitDeferral` answers first", () => {
    expect(classifyGitHubFailure(octokitError(502, ""), NOW)).toEqual({ kind: "other" });
  });
});

describe("the description a failed row carries", () => {
  it("names the route and never the query string, which can carry a token", () => {
    const e = octokitError(
      500,
      "",
      "GET",
      "https://api.github.com/repos/o/r/contents/x.ts?ref=main&access_token=abc",
    );
    const said = describeGitHubFailure(e);
    expect(said).toBe("GitHub answered 500 to GET /repos/o/r/contents/x.ts with no message");
    expect(said).not.toContain("access_token");
  });

  it("keeps a 5xx's own words after the route", () => {
    expect(describeGitHubFailure(octokitError(500, "Server Error"))).toBe(
      "GitHub answered 500 to POST /repos/Naidu-Group-Pty-Ltd/npc-client-dashboard/git/trees: Server Error",
    );
  });

  it("does not print an HTML error page", () => {
    const page = "<!DOCTYPE html>\n<html><head><title>Unicorn!</title></head><body>…</body></html>";
    expect(describeGitHubFailure(octokitError(502, page))).toBe(
      "GitHub answered 502 to POST /repos/Naidu-Group-Pty-Ltd/npc-client-dashboard/git/trees: an HTML error page",
    );
  });

  it("leaves a 4xx that said something exactly as it was", () => {
    expect(describeGitHubFailure(octokitError(422, "Validation Failed"))).toBe("Validation Failed");
    expect(describeGitHubFailure(octokitError(403, "Resource not accessible by integration"))).toBe(
      "Resource not accessible by integration",
    );
  });

  it("names a 4xx that said nothing", () => {
    expect(describeGitHubFailure(octokitError(404, ""))).toBe(
      "GitHub answered 404 to POST /repos/Naidu-Group-Pty-Ltd/npc-client-dashboard/git/trees with no message",
    );
  });

  it("keeps the engine's step and puts GitHub's answer beside it", () => {
    const inner = octokitError(502, "", "GET", "https://api.github.com/repos/o/r/branches/main");
    const wrapped = new Error(`Clone o/r@main unreachable: ${inner.message}`, { cause: inner });
    expect(describeGitHubFailure(wrapped)).toBe(
      "Clone o/r@main unreachable (GitHub answered 502 to GET /repos/o/r/branches/main with no message)",
    );
  });

  it("keeps a plain error's message, and says what failed when it has none", () => {
    expect(describeGitHubFailure(new Error("Pin validation failed: x"))).toBe(
      "Pin validation failed: x",
    );
    expect(describeGitHubFailure(new TypeError(""))).toBe("TypeError with no message");
    expect(describeGitHubFailure(undefined)).toBe("a failure with no message");
  });

  it("cuts a long message to one line", () => {
    const said = describeGitHubFailure(new Error(`a\n${"b".repeat(1000)}`));
    expect(said.length).toBeLessThanOrEqual(300);
    expect(said).not.toContain("\n");
  });
});

describe("a server error is retried against the same head, then failed", () => {
  it("defers the first one with the first window and a marker naming the head", () => {
    const plan = planServerFailure({
      e: octokitError(502, ""),
      anchor: retryAnchor(HEAD),
      priorMessage: null,
      now: NOW,
    });
    expect(plan).toMatchObject({ act: "defer", status: 502, retry: 1, of: 3 });
    if (plan?.act !== "defer") throw new Error("expected a deferral");
    expect(plan.until).toBe(new Date(NOW + SERVER_ERROR_RETRY_WINDOWS_MS[0]).toISOString());
    expect(plan.rowMessage).toBe(
      "Deferred until 2026-10-07T16:55:00Z — GitHub answered 502 to POST " +
        "/repos/Naidu-Group-Pty-Ltd/npc-client-dashboard/git/trees with no message; " +
        "retry 1 of 3 against prime@d4b3be7",
    );
  });

  it("counts on from the row's own last message, with a longer window each time", () => {
    let prior: string | null = null;
    const windows: number[] = [];
    for (let i = 0; i < SERVER_ERROR_RETRY_WINDOWS_MS.length; i++) {
      const plan = planServerFailure({
        e: octokitError(502, ""),
        anchor: retryAnchor(HEAD),
        priorMessage: prior,
        now: NOW,
      });
      if (plan?.act !== "defer") throw new Error(`expected retry ${i + 1} to defer`);
      expect(plan.retry).toBe(i + 1);
      windows.push(Date.parse(plan.until) - NOW);
      prior = plan.rowMessage;
    }
    expect(windows).toEqual([...SERVER_ERROR_RETRY_WINDOWS_MS]);
    const last = planServerFailure({
      e: octokitError(502, ""),
      anchor: retryAnchor(HEAD),
      priorMessage: prior,
      now: NOW,
    });
    expect(last).toEqual({
      act: "fail",
      status: 502,
      rowMessage:
        "GitHub answered 502 to POST /repos/Naidu-Group-Pty-Ltd/npc-client-dashboard/git/trees " +
        "with no message; 3 retries against this head did not clear it",
    });
  });

  it("starts the count again at a new head, which the carrier refresh offers once", () => {
    const spent = planServerFailure({
      e: octokitError(502, ""),
      anchor: retryAnchor(HEAD),
      priorMessage: "Deferred until x — y; retry 3 of 3 against prime@d4b3be7",
      now: NOW,
    });
    expect(spent?.act).toBe("fail");
    const fresh = planServerFailure({
      e: octokitError(502, ""),
      anchor: retryAnchor(NEXT_HEAD),
      priorMessage: "Deferred until x — y; retry 3 of 3 against prime@d4b3be7",
      now: NOW,
    });
    expect(fresh).toMatchObject({ act: "defer", retry: 1 });
  });

  it("counts a rate limit's or a hold's message as no retry spent", () => {
    const anchor = retryAnchor(HEAD);
    expect(
      retriesSpent("Deferred until 2026-10-07T17:00:00Z: API rate limit exceeded", anchor),
    ).toBe(0);
    expect(
      retriesSpent("Held: the parent NPC Client Dashboard carries prime@aaaaaaa", anchor),
    ).toBe(0);
    expect(retriesSpent(null, anchor)).toBe(0);
  });

  it("is a stamped failure the carrier refresh will not re-offer at the same head", () => {
    const plan = planServerFailure({
      e: octokitError(502, ""),
      anchor: retryAnchor(HEAD),
      priorMessage: "Deferred until x — y; retry 3 of 3 against prime@d4b3be7",
      now: NOW,
    });
    if (plan?.act !== "fail") throw new Error("expected a failure");
    expect(stampFailedAgainst(HEAD, plan.rowMessage)).toMatch(
      /^Failed against prime@d4b3be7 — GitHub answered 502/,
    );
  });

  it("has nothing to say about anything but a server error", () => {
    expect(
      planServerFailure({
        e: octokitError(422, "Validation Failed"),
        anchor: retryAnchor(HEAD),
        priorMessage: null,
      }),
    ).toBeNull();
    expect(
      planServerFailure({ e: new Error(""), anchor: retryAnchor(HEAD), priorMessage: null }),
    ).toBeNull();
  });
});

describe("the prime read, which comes before any head", () => {
  it("is counted against the branch, on the event's own summary", () => {
    const e = octokitError(
      502,
      "",
      "GET",
      "https://api.github.com/repos/Naidu-Group-Pty-Ltd/npc-property-dashbord/branches/main",
    );
    const anchor = "Naidu-Group-Pty-Ltd/npc-property-dashbord@main";
    const first = planServerFailure({ e, anchor, priorMessage: "Held: …", now: NOW });
    if (first?.act !== "defer") throw new Error("expected a deferral");
    expect(first.rowMessage).toBe(
      "Deferred until 2026-10-07T16:55:00Z — GitHub answered 502 to GET " +
        "/repos/Naidu-Group-Pty-Ltd/npc-property-dashbord/branches/main with no message; " +
        "retry 1 of 3 against Naidu-Group-Pty-Ltd/npc-property-dashbord@main",
    );
    const second = planServerFailure({ e, anchor, priorMessage: first.rowMessage, now: NOW });
    expect(second).toMatchObject({ act: "defer", retry: 2 });
    // A row's head marker is not the branch's, and counts nothing against it.
    expect(retriesSpent(first.rowMessage, retryAnchor(HEAD))).toBe(0);
  });
});

describe("the sentence a carrier holding for server errors carries", () => {
  it("names the first clone, its status and its retry, and counts the rest", () => {
    expect(
      describeServerDeferral({
        until: "2026-10-07T17:01:00.000Z",
        deferrals: [
          { clone: "NPC Client Dashboard", status: 502, retry: 2, of: 3 },
          { clone: "NPC CRM Independent", status: 502, retry: 1, of: 3 },
        ],
        done: 1,
        total: 4,
      }),
    ).toBe(
      "Deferred until 2026-10-07T17:01:00Z — GitHub answered 502 on NPC Client Dashboard's pass " +
        "(retry 2 of 3) and on 1 other clone(s); 1 of 4 clone(s) done, the rest resume then",
    );
  });
});

describe("the engine consults the plan where a pass ends on an error", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("asks it for every row, against the head, with the row's own last message", () => {
    expect(engine).toMatch(
      /planServerFailure\(\{\s*e,\s*anchor: retryAnchor\(sourceSha\),\s*priorMessage: r\.error_message,?\s*\}\)/,
    );
  });

  it("asks it for the prime read, against the branch, with the event's summary", () => {
    expect(engine).toMatch(
      /planServerFailure\(\{\s*e,\s*anchor: branch,\s*priorMessage: event\.summary\s*\}\)/,
    );
  });

  it("holds the event for a server deferral rather than settling it", () => {
    expect(engine).toContain("serverDeferrals.length > 0");
    expect(engine).toContain("describeServerDeferral({");
  });

  it("never records a bare `e.message` on a failed row", () => {
    expect(engine).not.toMatch(
      /error_message: stampFailedAgainst\(\s*sourceSha,\s*e instanceof Error \? e\.message/,
    );
  });
});
