/**
 * A refusal says which kind it was, and every call is counted — including the
 * ones that never touch the octokit client.
 *
 * ## The two gaps this closes
 *
 * `fetchBlobTextStream` reaches GitHub with a RAW `fetch`, because it needs
 * the response as a stream rather than a parsed body. That put it outside
 * both of the mechanisms built for App-installation calls, and the cost of
 * each showed up within an hour of the other being fixed.
 *
 *   * **It threw away the reason.** The error read `Streaming blob <sha>
 *     failed: HTTP 403` and carried neither the status as a property nor any
 *     of GitHub's body. A 403 from that endpoint is at least three events
 *     with three opposite remedies — a primary rate limit (wait for the
 *     window), a secondary rate limit on an expensive request (back off; a
 *     40 MB blob is exactly that shape), or a permanent refusal (waiting is
 *     the wrong answer for ever). Measured 19 Sep 2026 on
 *     `npc-test-76b3b3`, blocked at
 *     `20261202000000_seed_template_library_v13_cash_flow_foots.sql`: the
 *     installation was at roughly 750 calls against a 5,000/hour window with
 *     every other lane flowing, so reading it as a quota refusal would have
 *     parked the clone waiting on a window that was never closed. The
 *     evidence was in the body, and the body was dropped.
 *
 *   * **It was invisible to the meter.** Counting is done in
 *     `getAppOctokit`'s hook, which a raw fetch never enters — so the single
 *     most expensive request this system makes was the one request the ledger
 *     did not see. The ledger existed for four hours before this was noticed,
 *     which is the argument for deriving the rule rather than trusting the
 *     one choke point to stay the only one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every source file under src/, excluding tests. */
function sources(dir = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(full) && !/\.(test|spec)\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Strip comments so an assertion about behaviour cannot be satisfied — or
 * broken — by prose. A block that must not CLASSIFY a refusal still has to
 * explain why, and those two readings of the same text are opposites.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const withRawGithubFetch = sources()
  .map((file) => ({ file, src: readFileSync(file, "utf8") }))
  .filter(({ src }) => /fetch\(\s*`?https:\/\/api\.github\.com/.test(src));

describe("every raw GitHub fetch is counted", () => {
  it("finds the raw-fetch sites at all", () => {
    // Zero here means the detection broke and everything below is vacuous —
    // the failure mode a contract test over an absence is most exposed to.
    expect(withRawGithubFetch.length).toBeGreaterThan(0);
  });

  for (const { file, src } of withRawGithubFetch) {
    it(`${file} counts before it spends`, () => {
      expect(src, "no countGithubCall in a file that fetches GitHub directly").toContain(
        "countGithubCall()",
      );
      // And counted BEFORE the request, not after: a counter that runs only on
      // the success path undercounts exactly the calls that cost the most.
      const counted = src.indexOf("countGithubCall()");
      const spent = src.search(/fetch\(\s*`?https:\/\/api\.github\.com/);
      expect(counted, `${file} spends before it counts`).toBeLessThan(spent);
    });
  }
});

describe("a streaming refusal says which kind it was", () => {
  const src = readFileSync("src/server/prime-backend.server.ts", "utf8");
  const fn = src.slice(src.indexOf("async function fetchBlobTextStream"));
  const guard = fn.slice(fn.indexOf("if (!res.ok"), fn.indexOf("const reader"));

  it("carries the status as a property, not only in prose", () => {
    // `isUpstreamRateLimit` reads `.status` first. An error that only says
    // "HTTP 403" in a sentence is unreadable to it.
    expect(guard).toMatch(/status\s*=\s*res\.status/);
  });

  it("includes GitHub's own body in the message", () => {
    expect(guard).toContain("res.text()");
    // Truncated: this is diagnostic text on a path that has already failed.
    expect(guard).toMatch(/slice\(0,\s*\d+\)/);
  });

  it("never lets reading the body replace the refusal", () => {
    // A body that will not read must not throw a second error that hides the
    // first — the failure would then be reported as whatever went wrong while
    // trying to explain it.
    const tryBlock = guard.slice(guard.indexOf("try {"), guard.indexOf("throw err"));
    expect(tryBlock).toContain("catch");
    expect(guard).toContain("throw err");
  });

  it("does not pre-judge a 403 as a quota refusal", () => {
    // The whole point. Classifying it would have been convenient and wrong:
    // the window was open when this fired. Whatever decides the remedy must
    // read what GitHub said, not assume it.
    //
    // Judged on the CODE and not the comments, because the comments necessarily
    // discuss the three kinds of refusal this must not choose between — the
    // first draft of this assertion failed on its own explanation, which is an
    // assertion measuring the wrong thing rather than a defect in the guard.
    expect(code(guard)).not.toMatch(/rate.?limit/i);
    expect(code(guard)).not.toContain("heldUpstreamLimited");
  });
});
