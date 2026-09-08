import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `last_error` on a remediation run describes the LAST PASS, not the run's
 * whole history.
 *
 * It used to be cleared only in `succeedRun`, and these runs pause at budget
 * dozens of times before they succeed — 434 edge-function bundles land ~60 at
 * a time. So a run that erred once and then advanced cleanly kept displaying
 * that error as its current state, indefinitely.
 *
 * Measured 8 Sep 2026 on NPC Test: the fleet page showed
 * `Cannot read properties of undefined (reading 'repository')` for twenty
 * minutes while `attempts` sat unmoved at 1 and `deployed` climbed
 * 223 → 237 → 244 → 276 → 283. The run was healthy and looked broken, and
 * disproving that took reading the write paths to establish that a clean
 * budget pause writes `next_attempt_at = now` while an error writes
 * `now + MONITOR_RETRY_MINUTES`.
 *
 * These are source-level because the behaviour lives in two `markRun` payloads
 * and the alternative is a database.
 */
const src = readFileSync("src/server/self-healing.server.ts", "utf8");

/** Source with comments removed — every assertion here is about code. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/** The body of the `if (resume.kind === "requeue")` block at a given offset. */
function requeueBlocks(source: string): string[] {
  const out: string[] = [];
  const marker = 'if (resume.kind === "requeue")';
  let i = source.indexOf(marker);
  while (i !== -1) {
    // Far enough to cover the whole markRun payload without spilling into the
    // next function; these blocks are ~25 lines.
    out.push(source.slice(i, i + 1600));
    i = source.indexOf(marker, i + 1);
  }
  return out;
}

describe("a paused run does not keep reporting an error it has moved past", () => {
  const blocks = requeueBlocks(code);

  it("has the two requeue paths this rule is about", () => {
    // If a third appears, it needs the same rule rather than silently not
    // having it.
    expect(blocks).toHaveLength(2);
  });

  it("every requeue writes last_error, so none of them leaves a stale one", () => {
    for (const block of blocks) expect(block).toMatch(/last_error:/);
  });

  it("the deploy lane reports THIS pass's failure, or none", () => {
    // Not simply `null`: a pass that did fail a slug must say so, and say the
    // same thing the park branch says.
    const deploy = blocks.find((b) => b.includes("failedDetail"));
    expect(deploy).toBeDefined();
    expect(deploy).toMatch(/last_error:\s*\n?\s*failedDetail\.length > 0/);
    expect(deploy).toContain("could not deploy");
    expect(deploy).toMatch(/:\s*null,/);
  });

  it("still never resets the attempt count, which is what holds the history", () => {
    // Clearing the message must not clear the record that a failure happened.
    for (const block of blocks) {
      expect(block).toContain("attempts: run.attempts ?? 0");
      expect(block).not.toMatch(/attempts:\s*0\s*[,}]/);
    }
  });

  it("success still clears it", () => {
    const succeed = code.slice(code.indexOf("async function succeedRun"));
    expect(succeed.slice(0, 500)).toMatch(/last_error:\s*null/);
  });
});
