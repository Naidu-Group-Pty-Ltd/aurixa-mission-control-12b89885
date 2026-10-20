/**
 * A pass the platform ends has to say where it was.
 *
 * F21: no pass on the CRM line finished between 17 and 20 Oct 2026, each one
 * was cut before its first ledger write, and nothing on its row could name the
 * stage. These pin the record that does, and that it costs a live pass
 * nothing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PASS_PHASES,
  TRACE_FLUSH_MS,
  describePassTrace,
  endPass,
  enterPhase,
  settleTrace,
} from "./passTrace.pure";
import { stripComments } from "../sourceComments.pure";

const START = "2026-10-20T04:22:02.000Z";

describe("the trace", () => {
  it("lists each stage entered, in order, with the time since the pass began", () => {
    let t = enterPhase(null, "listing", 0, START);
    t = enterPhase(t, "closure", 3_120.4, START);
    t = enterPhase(t, "prepare", 41_000, START);
    expect(t).toEqual({
      v: 1,
      started_at: START,
      phases: [
        ["listing", 0],
        ["closure", 3_120],
        ["prepare", 41_000],
      ],
    });
  });

  it("never changes the trace it was handed", () => {
    const a = enterPhase(null, "listing", 0, START);
    const b = enterPhase(a, "closure", 10, START);
    expect(a.phases).toHaveLength(1);
    expect(b.phases).toHaveLength(2);
    const c = endPass(b, "paused", 46_000, START);
    expect(b.outcome).toBeUndefined();
    expect(c.outcome).toBe("paused");
  });

  it("says a pass with no outcome was ended in its last stage", () => {
    const t = enterPhase(enterPhase(null, "listing", 0, START), "closure", 2_000, START);
    expect(describePassTrace(t)).toBe(
      "The pass entered closure at 2.0 s and recorded no outcome — it was ended there.",
    );
  });

  it("says where a pass that returned stopped, and when", () => {
    const t = endPass(enterPhase(null, "prepare", 41_000, START), "paused", 46_400, START);
    expect(describePassTrace(t)).toBe("The pass paused in prepare at 46.4 s.");
    const d = endPass(enterPhase(null, "tree", 30_000, START), "deferred", 31_200, START);
    expect(describePassTrace(d)).toBe("The pass deferred in tree at 31.2 s.");
  });

  it("reads nothing it did not write", () => {
    for (const raw of [null, undefined, 42, "x", {}, { v: 2, phases: [["listing", 0]] }]) {
      expect(describePassTrace(raw)).toBeNull();
    }
    expect(describePassTrace({ v: 1, started_at: START, phases: [["nonsense", 1]] })).toBeNull();
  });
});

describe("the engine names every stage, once, in order", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
  const fn = engine.slice(engine.indexOf("export async function processClone("));

  it("marks each declared stage exactly once, in the declared order", () => {
    const marks = [...fn.matchAll(/markPhase\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(marks).toEqual([...PASS_PHASES]);
  });

  it("never on a rehearsal", () => {
    expect(fn).toContain("if (!dryRun) args.resume?.onPhase?.(phase, Date.now() - passStartedAt);");
  });

  it("never waits on the trace", () => {
    expect(fn).not.toMatch(/await\s+markPhase/);
    expect(engine).not.toMatch(/await\s+writeTrace/);
  });

  it("marks the closure before its unbudgeted read, and the tree before its chain", () => {
    const closure = fn.indexOf('markPhase("closure")');
    expect(closure).toBeGreaterThan(-1);
    expect(fn.indexOf("await closeOver(candidatePaths", closure)).toBeGreaterThan(closure);
    const tree = fn.indexOf('markPhase("tree")');
    expect(fn.indexOf("for (const chunk of chunkTreeEntries(treeEntries))", tree)).toBeGreaterThan(
      tree,
    );
  });
});

describe("the drain records the trace and its outcome without costing the pass", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
  const at = engine.indexOf("const writeTrace = (next: PassTrace): void => {");
  const writer = engine.slice(at, engine.indexOf("try {", at));

  it("writes in order, and swallows a failure", () => {
    expect(at).toBeGreaterThan(-1);
    expect(writer).toContain("traceWrites = traceWrites");
    expect(writer).toContain(".update({ pass_trace: next as unknown as Json })");
    expect(writer).toContain(".catch(() => undefined);");
  });

  it("stops writing where the column has not reached the database", () => {
    expect(writer).toContain(
      "if (traceError && isMissingColumnError(traceError)) traceAbsent = true;",
    );
    expect(writer).toContain("if (traceAbsent) return;");
  });

  it("is fed by the pass, and ended on every way out of it", () => {
    expect(engine).toContain(
      "onPhase: (phase, atMs) => writeTrace(enterPhase(passTrace, phase, atMs, traceStartedAt)),",
    );
    const returned = engine.search(
      /writeTrace\(\s*endPass\(\s*passTrace,\s*patch\.status === "queued"/,
    );
    expect(returned).toBeGreaterThan(engine.indexOf("const patch = await processClone({"));
    // A throw is classified first: a window GitHub named is a deferral (the
    // row is queued again), anything else a failure.
    const deferred = (s: string) =>
      s.split(
        'writeTrace(endPass(passTrace, "deferred", Date.now() - traceOrigin, traceStartedAt));',
      ).length - 1;
    const caught = engine.slice(engine.indexOf("const failure = classifyGitHubFailure(e);"));
    expect(deferred(caught)).toBe(2);
    expect(caught).toContain(
      'writeTrace(endPass(passTrace, "failed", Date.now() - traceOrigin, traceStartedAt));',
    );
  });

  it("waits, bounded, for the outcome to land before the pass moves on", () => {
    // In a `finally` on the clone's own try, so a delivery, a pause, a
    // deferral, a failure and a throw all wait — and after the work.
    expect(engine).toMatch(
      /\}\s*finally\s*\{\s*await settleTrace\(traceWrites, TRACE_FLUSH_MS\);\s*\}/,
    );
    expect(TRACE_FLUSH_MS).toBeLessThanOrEqual(2_000);
  });

  it("a bounded wait returns at the bound, and as soon as the writes land", async () => {
    const started = Date.now();
    await settleTrace(new Promise<void>(() => undefined), 25);
    expect(Date.now() - started).toBeLessThan(1_000);
    let landed = false;
    await settleTrace(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          landed = true;
          resolve();
        }, 5),
      ),
      5_000,
    );
    expect(landed).toBe(true);
  });

  it("names its column in the migration that adds it", () => {
    const migration = readFileSync(
      "supabase/migrations/20261020100500_cascade_results_pass_trace.sql",
      "utf8",
    );
    expect(migration).toContain("-- @asserts column:cascade_results.pass_trace");
    expect(migration).toContain("add column if not exists pass_trace jsonb");
  });
});
