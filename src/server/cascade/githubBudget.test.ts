/**
 * One installation budget, arbitrated — measured 16 Sep 2026, when the
 * window opening at 09:23 was spent by 09:41 and the cascade got a third.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASCADE_CLAIM_FLOOR, SCAN_FLOOR, decideSpend } from "./githubBudget.pure";

describe("decideSpend", () => {
  it("the cascade claims above its floor and waits below it", () => {
    expect(decideSpend({ role: "cascade_claim", remaining: CASCADE_CLAIM_FLOOR }).proceed).toBe(
      true,
    );
    const starved = decideSpend({ role: "cascade_claim", remaining: CASCADE_CLAIM_FLOOR - 1 });
    expect(starved.proceed).toBe(false);
    if (!starved.proceed) expect(starved.why).toContain("cascade floor");
  });

  it("scans yield much earlier — the cascade is the priority consumer", () => {
    expect(SCAN_FLOOR).toBeGreaterThan(CASCADE_CLAIM_FLOOR);
    expect(decideSpend({ role: "scan", remaining: SCAN_FLOOR - 1 }).proceed).toBe(false);
    expect(decideSpend({ role: "scan", remaining: SCAN_FLOOR }).proceed).toBe(true);
  });

  it("an unreadable allowance changes nothing — fail-open to yesterday's behaviour", () => {
    expect(decideSpend({ role: "cascade_claim", remaining: null }).proceed).toBe(true);
    expect(decideSpend({ role: "scan", remaining: null }).proceed).toBe(true);
  });
});

describe("the wiring", () => {
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");

  it("the drain asks the free call before any paid one, and a starved tick claims nothing", () => {
    expect(drain).toContain('decideSpend({ role: "cascade_claim", remaining })');
    expect(drain.indexOf("const remaining = await readGitHubRemaining();")).toBeLessThan(
      drain.indexOf("await drainOne(budget)"),
    );
    expect(drain).toContain("if (spend.proceed) {");
    // The beacon is also behind the gate: a starved tick must not spend its
    // last calls on a branch read.
    expect(drain).toContain("results.length === 0 && spend.proceed");
  });

  it("every scan that reads GitHub yields below the scan floor", () => {
    for (const route of [
      "src/routes/hooks.drift-refresh.tsx",
      "src/routes/hooks.held-file-drift.tsx",
      "src/routes/hooks.backend-catchup.tsx",
    ]) {
      const src = readFileSync(route, "utf8");
      expect(src, route).toContain('decideSpend({ role: "scan"');
      expect(src, route).toContain("skipped: spend.why");
    }
  });
});

describe("the claim fence", () => {
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");

  it("the claim's own timestamp travels as the fence", () => {
    expect(drain).toContain("return claimed ? { ...claimed, fence: nowIso } : null;");
    expect(drain).toContain(
      "executeCascade(supabaseAdmin, claimed.id, { budget, fence: claimed.fence })",
    );
  });

  it("the running-mark never re-stamps source_sha — provenance is not a gate, and the index is UNIQUE", () => {
    /* `uq_cascade_events_commit_sha` covers every commit event whatever its
       status; after a fold, some row always carries prime's head, so a
       re-stamp collides. It had violated silently on every pass since the
       fold existed (the old write was unchecked); the first checked write
       failed the carrier twice in 600 ms — measured 16 Sep 2026, 10:24:02. */
    const mark = engine.slice(
      engine.indexOf('"mark the event running"') - 400,
      engine.indexOf('"mark the event running"'),
    );
    expect(mark).toContain('{ status: "running", started_at: new Date().toISOString() }');
    expect(mark).not.toContain("source_sha: sourceSha");
    expect(mark).not.toContain("source_branch");
  });

  it("every event write in the engine goes through the fenced helper", () => {
    // The helper is the ONLY writer: a raw `.update` on cascade_events
    // inside executeCascade is a zombie write waiting to happen. The two
    // permitted raw sites are the helper itself and reads.
    const body = engine.slice(
      engine.indexOf("export async function executeCascade"),
      engine.indexOf("async function processClone"),
    );
    const raw = body.match(/from\("cascade_events"\)\s*\.update\(/g) ?? [];
    expect(raw).toHaveLength(1); // the helper's own
    expect(body).toContain('if (fence) q = q.eq("worker_started_at", fence);');
    // A fenced-out invocation stops: nothing else is written, nothing is
    // notified, and the result says why.
    expect(body).toContain('return { ok: false, error: "claim superseded — nothing written" };');
  });

  it("the drain's own follow-up writes are guarded too", () => {
    // Refund and terminal-mark ride the counter this claim wrote; the
    // finished stamp and the catch-path revert ride the fence — a zombie
    // stamping `worker_finished_at` onto a live claim would exempt it from
    // the stall reclaim for ever.
    expect(drain).toMatch(
      /update\(\{ attempts: Math\.max\(0, claimed\.attempts - 1\) \}\)\s*\.eq\("id", claimed\.id\)\s*\.eq\("attempts", claimed\.attempts\)/,
    );
    expect(drain).toMatch(
      /update\(\{ worker_finished_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("id", claimed\.id\)\s*\.eq\("worker_started_at", claimed\.fence\)/,
    );
  });
});
