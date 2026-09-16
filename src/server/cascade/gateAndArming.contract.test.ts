/**
 * Two gates found by drilling paths that had never fired in production, both
 * of the same species: a row that looks like ordinary pending work and that
 * nothing will ever act on.
 *
 * THE APPROVAL STRAND — `approveCascade` runs the engine inline exactly once.
 * When that run dies, the reclaim reverts the event to pending-unclaimed, and
 * a claim that filters `requires_approval = false` alone never offers it to
 * anyone again. The gate was already discharged by a second operator; the
 * drain must be its rescue path.
 *
 * THE CREATION RACE — the trigger commits the event and its result rows in
 * two statements, and the per-minute drain claimed one inside the 807ms gap
 * between them (16 Sep 2026, event dd7180c7): the pass read zero rows,
 * honestly completed "(of 0)", and the rows landed a second later, stranded,
 * with the delivery silently lost until unrelated future traffic.
 *
 * These pin the source because the machinery under test is route/server
 * internals the way the drain's other contracts already do: the claim's two
 * passes, the engine's unarmed hold, the creation grace, and the rule that
 * EVERY act that settles an event settles its rows — the rejection path and
 * the drain's two terminal exits were the sites the first sweep missed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeCascadeOutcome, type CascadeRunResult } from "@/lib/cascadeRunOutcome";
import { CREATION_ARM_GRACE_MS } from "./armGrace.pure";

const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
const approvals = readFileSync("src/server/cascade-approvals.functions.ts", "utf8");

describe("the drain backstops an approved gate", () => {
  it("claims in two passes: ungated first, then gated-with-approval-recorded", () => {
    // The second pass is what un-strands an approved event whose inline run
    // died. Both predicates must be present, and the approved pass must
    // never drop the approval check — `requires_approval = true` alone would
    // BYPASS the gate.
    expect(drain).toMatch(/\.eq\("requires_approval", true\)\.not\("approved_at", "is", null\)/);
    expect(drain).toContain('queue.eq("requires_approval", false)');
    expect(drain).toContain("(await selectCandidate(false)) ?? (await selectCandidate(true))");
  });

  it("still refuses an UNapproved gated event anywhere in the claim", () => {
    // No third pass, no pass that reads requires_approval=true without
    // pairing it to a recorded approval.
    const gatedReads = drain.match(/eq\("requires_approval", true\)/g) ?? [];
    for (const read of gatedReads) {
      void read;
    }
    const pairings = drain.match(
      /\.eq\("requires_approval", true\)\.not\("approved_at", "is", null\)/g,
    );
    expect(gatedReads.length).toBe((pairings ?? []).length);
  });
});

describe("armed, then claimable", () => {
  it("a fresh event is not drain-claimable until its rows have had time to land", () => {
    // The floor is at the CLAIM, once, inside `selectCandidate` — so both
    // passes and every creation site, present and future, are covered by
    // one spelling. It covers at least one drain interval; anything shorter
    // can still lose the race to the next tick.
    expect(CREATION_ARM_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(drain).toContain(
      "const armedBefore = new Date(Date.now() - CREATION_ARM_GRACE_MS).toISOString();",
    );
    expect(drain).toContain('.lt("created_at", armedBefore)');
  });

  it("the engine holds a rows-less event instead of judging it", () => {
    // Asked of the whole ledger (any status), because zero QUEUED rows is a
    // normal end-state for a finished resume; and held BEFORE the pre-loop
    // exits, because failing an unarmed event settles it while its rows may
    // still be in flight.
    expect(engine).toContain('{ count: "exact", head: true }');
    expect(engine).toContain('"hold an unarmed event"');
    expect(engine).toContain('return { ok: true, status: "unarmed" };');
    expect(engine.indexOf("hold an unarmed event")).toBeLessThan(engine.indexOf("let octokit;"));
  });

  it("an unarmed claim keeps its attempt, so rows that never arrive end at a story", () => {
    // A refunded unarmed claim is an infinite claim loop: the drain refunds
    // deferrals because the fault is GitHub's window, and an event whose
    // trigger died mid-creation is nobody's window.
    expect(drain).toMatch(/res\.status === "unarmed"\s*\?\s*false/);
    expect(drain).toMatch(/Claimed \$\{MAX_ATTEMPTS\} times before any result row appeared/);
  });

  it("the outcome vocabulary carries the held shape without inventing counts", () => {
    const unarmed = { ok: true, status: "unarmed" } satisfies CascadeRunResult;
    const said = describeCascadeOutcome(unarmed);
    expect(said.level).toBe("info");
    expect(said.message).toContain("armed");
  });
});

describe("every act that settles an event settles its rows", () => {
  it("a rejection terminalises the rows it strands", () => {
    const reject = approvals.slice(approvals.indexOf("export const rejectCascade"));
    expect(reject).toContain("terminaliseOrphanedRows(");
    expect(reject).toContain("rejected by a reviewer");
    // After the event moves to failed, never before — settling rows under an
    // event that then fails to settle would tell the opposite lie.
    expect(reject.indexOf('status: "failed"')).toBeLessThan(
      reject.indexOf("terminaliseOrphanedRows("),
    );
  });

  it("the drain's two terminal exits settle rows too, alongside the retire block", () => {
    // Retire block, attempt-ceiling failure, and the catch's terminal
    // branch: three sites, each a settle, each walks its rows.
    const calls = drain.match(/terminaliseOrphanedRows\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // The catch settles only when its own fenced write landed — a zombie
    // settling a newer claim's rows is worse than the strand it prevents.
    expect(drain).toMatch(/if \(terminal && \(settled \?\? \[\]\)\.length > 0\)/);
  });
});
