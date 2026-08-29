/**
 * Whoever moves a deployment's status owns its clock.
 *
 * `status_since` is what `judgeWait` measures a wait against, and for a while
 * only the drain wrote it. `requestRedeployAfterPush` moved the status without
 * it, so the next drain pass measured "how long has this been deploying" from
 * whenever the row last changed state *in the drain* — and past STUCK_HOURS
 * declared a build that had existed for seconds to be stuck for six hours.
 *
 * Measured: a clone went live -> deploying at 06:00:16 and was marked `failed`
 * at 06:01:04 with "Stuck in deploying for more than 6h: Build queued." Its
 * Turnstile site key had just been published, so the rebuild that would have
 * carried that key into the bundle never ran, and the clone was left failing
 * closed on a CAPTCHA its own browser could not answer.
 *
 * This is a source contract rather than a behavioural test because the fault is
 * an ABSENCE — a field nobody wrote — and absence is exactly what a test with a
 * database double is least likely to notice: the write succeeds either way.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "redeploy.server.ts"), "utf8");

describe("requestRedeployAfterPush stamps status_since", () => {
  it("writes the field at all", () => {
    expect(SOURCE).toMatch(/status_since:/);
  });

  it("stamps it with the current time, not a value read off the row", () => {
    // `new Date().toISOString()` on the same line — a copied `row.status_since`
    // would reintroduce the fault while still satisfying the check above.
    expect(SOURCE).toMatch(/status_since:\s*new Date\(\)\.toISOString\(\)/);
  });

  it("stamps it in the same patch that sets status", () => {
    const patch = SOURCE.slice(
      SOURCE.indexOf("const patch: Record<string, unknown> = {"),
      SOURCE.indexOf("// Cleared so the drain creates a NEW build"),
    );
    expect(patch, "the status_since stamp must live in the status patch").toContain(
      "status_since:",
    );
    expect(patch).toContain("status: decision.resumeAt");
  });
});
