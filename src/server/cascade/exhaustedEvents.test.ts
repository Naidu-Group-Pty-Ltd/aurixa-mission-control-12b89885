/**
 * The attempt ceiling measures futility, not platform kills.
 *
 * A tick the platform cuts spends an attempt and returns nothing, so the
 * refund in `drainOne` — which needs a clean return — never sees it. These
 * pin the judgement that stops three kills from stranding a converging
 * event as a silent zombie, and stops a genuinely dead one from sitting
 * `pending` for ever with nothing reporting it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXHAUSTED_PROGRESS_WINDOW_MS,
  PROGRESS_COLUMN,
  decideExhaustedEvent,
  retirementSummary,
} from "./exhaustedEvents.pure";
import { stripComments } from "../sourceComments.pure";
import { STALL_MINUTES } from "./drainLimits.pure";

const NOW = Date.parse("2026-09-16T09:30:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("decideExhaustedEvent", () => {
  const judge = (lastProgressAt: string | null, attempts = 3, readFailed = false) =>
    decideExhaustedEvent({ attempts, maxAttempts: 3, lastProgressAt, readFailed, nowMs: NOW });

  it("leaves an event under the ceiling to the ordinary claim path", () => {
    expect(judge(minutesAgo(60), 2).act).toBe("leave");
    expect(judge(null, 2).act).toBe("leave");
  });

  it("refunds when the last pass kept progress before it was cut", () => {
    expect(judge(minutesAgo(11)).act).toBe("refund");
  });

  it("the window is wider than the stall reclaim, or every kill would retire", () => {
    /* A killed tick's last write is at least STALL_MINUTES old by the time
       the reclaim releases the claim and this judgement can see the event. */
    expect(EXHAUSTED_PROGRESS_WINDOW_MS).toBeGreaterThan(STALL_MINUTES * 60_000);
  });

  it("and narrower than two reclaims, so only the LAST attempt's progress refunds", () => {
    /* Progress the attempt before the last one kept is two reclaims old by
       the judgement. Counting it would refund an event whose last pass kept
       nothing — F21's third attempt, after the second had settled the other
       line's clones. */
    expect(EXHAUSTED_PROGRESS_WINDOW_MS).toBeLessThan(2 * STALL_MINUTES * 60_000);
  });

  it("retires when nothing has been kept lately", () => {
    expect(judge(minutesAgo(45)).act).toBe("retire");
  });

  it("retires an event no pass ever kept anything on, which is F21's shape", () => {
    /* The CRM line on 20 Oct 2026: every pass was cut before its first ledger
       write, so its row was never stamped. A row's `updated_at` moved on every
       claim and read as converging; the progress stamp never moved at all. */
    const v = judge(null);
    expect(v.act).toBe("retire");
    expect(v.why).toContain("did not start with");
  });

  it("never judges on a failed or unreadable read", () => {
    expect(judge(null, 3, true).act).toBe("leave");
    expect(judge(minutesAgo(45), 3, true).act).toBe("leave");
    expect(judge("not-a-timestamp").act).toBe("leave");
  });

  it("the retirement names the lever, not just the mystery", () => {
    expect(retirementSummary(3)).toContain("Cascade now");
    expect(retirementSummary(3)).toContain("3 attempts");
  });
});

/*
  The cycle F21 measured, replayed through the judgement: claim, a cut, the
  ten-minute stall reclaim, the judgement, the next claim. What the judge sees
  is what the passes left, so the model only has to say what each pass wrote.
*/
describe("an exhausted event is retired or refunded by what its passes kept", () => {
  const STALL_MS = 10 * 60_000;

  /** Ticks until retirement, or null if the event was still refunding at the end. */
  function cycle(passGrows: (pass: number) => boolean, maxPasses = 50): number | null {
    let now = NOW;
    let grewAt: number | null = null;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      // A claim, and a pass the platform cuts at 60 s; it flushed at 30 s if
      // it kept anything new.
      if (passGrows(pass)) grewAt = now + 30_000;
      now += STALL_MS;
      const v = decideExhaustedEvent({
        attempts: 3,
        maxAttempts: 3,
        lastProgressAt: grewAt === null ? null : new Date(grewAt).toISOString(),
        readFailed: false,
        nowMs: now,
      });
      if (v.act === "retire") return pass;
      if (v.act !== "refund") throw new Error(`unexpected ${v.act}`);
      now += 60_000; // the next tick claims it
    }
    return null;
  }

  it("retires at the first look a pass that never keeps anything", () => {
    expect(cycle(() => false)).toBe(0);
  });

  it("keeps refunding a convergence, and retires once growth stops", () => {
    // The ledger is finite: twenty passes that each keep something, then none.
    expect(cycle((pass) => pass < 20)).toBe(20);
  });

  it("is bounded by the ledger, never by the counter", () => {
    expect(cycle((pass) => pass < 40, 60)).toBe(40);
  });

  /*
    F21 exactly, from the first claim: three attempts, the stall reclaim
    between them, and a judgement only once the ceiling is reached. The
    second attempt settled the client-dashboard line's three clones before
    the CRM line's pass was cut; the third reached only the CRM line.
  */
  function f21(thirdAttemptKeeps: boolean): ReturnType<typeof decideExhaustedEvent> {
    const claimEvery = STALL_MS + 60_000; // the reclaim, then the next tick's claim
    const firstClaim = NOW;
    const kept: number[] = [];
    // Attempt 1: the CRM line first, cut before it kept anything.
    // Attempt 2: three settlements at ~20 s, then the CRM line cut.
    kept.push(firstClaim + claimEvery + 20_000);
    // Attempt 3: the CRM line alone.
    const thirdClaim = firstClaim + 2 * claimEvery;
    if (thirdAttemptKeeps) kept.push(thirdClaim + 20_000);
    const judgedAt = thirdClaim + STALL_MS; // the reclaim, and the judgement in the same tick
    return decideExhaustedEvent({
      attempts: 3,
      maxAttempts: 3,
      lastProgressAt: new Date(Math.max(...kept)).toISOString(),
      readFailed: false,
      nowMs: judgedAt,
    });
  }

  it("retires F21's events: the attempt before the last settled clones, the last kept nothing", () => {
    expect(f21(false).act).toBe("retire");
  });

  it("refunds the same event had its last attempt settled one more clone", () => {
    expect(f21(true).act).toBe("refund");
  });
});

describe("the drain wires the judgement with guarded writes", () => {
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
  const fn = drain.slice(
    drain.indexOf("async function judgeExhaustedEvents"),
    drain.indexOf("async function raiseDriftBeacon"),
  );

  it("reads the progress stamp, never the row's updated_at", () => {
    // The claim's own `pushing` mark moves `updated_at` before any work, which
    // is what refunded the CRM line's events for ever (F21).
    const code = stripComments(fn);
    expect(code.length).toBeGreaterThan(200);
    expect(code).toContain(".select(PROGRESS_COLUMN)");
    expect(code).toContain('.not(PROGRESS_COLUMN, "is", null)');
    expect(code).toContain(".order(PROGRESS_COLUMN, { ascending: false })");
    expect(code).toContain("lastProgressAt: newest?.progressed_at ?? null,");
    expect(code).not.toContain("updated_at");
    expect(code).toContain("readFailed: newestErr !== null");
  });

  it("runs after the reclaim, so a just-released kill is judged this tick", () => {
    expect(drain.indexOf("await reclaimStalled();")).toBeLessThan(
      drain.indexOf("await judgeExhaustedEvents();"),
    );
  });

  it("every write re-checks pending + unclaimed, so a racing claim wins", () => {
    const guards = fn.match(/\.eq\("status", "pending"\)\s*\.is\("worker_started_at", null\)/g);
    expect(guards?.length).toBeGreaterThanOrEqual(2);
  });

  it("a refund goes back to one under the ceiling, never to zero", () => {
    expect(fn).toContain(".update({ attempts: MAX_ATTEMPTS - 1 })");
  });

  it("a retirement is visible: failed status and a notification with the event's link", () => {
    expect(fn).toContain('status: "failed"');
    expect(fn).toContain('kind: "cascade_failed"');
    expect(fn).toContain("url: `/cascades/${event.id}`");
  });

  it("read failures throw — a silent judgement is the zombie with extra steps", () => {
    expect(fn).toMatch(/could not read exhausted events/);
  });
});

describe("one tick cannot exhaust an event", () => {
  /* The other way three attempts die at once: `drainOne` reverts a failed
     event to `pending` (attempts kept) and the SAME tick's next loop
     iteration re-claims it immediately. Measured twice on 16 Sep 2026 —
     10:24:02 and 10:45:03, the second because the claim raced a mid-publish
     build — the carrier went from healthy to `failed · attempts 3` in under
     a second, with one tick body reporting the same error three times. A
     failure is remembered for the rest of its tick, so an event loses at
     most one attempt per minute and every attempt gets its own tick body. */
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");

  it("a failed pass is remembered and not re-claimed this tick", () => {
    expect(drain).toContain("const failedThisTick = new Set<string>();");
    expect(drain).toContain("if (r.ok === false && r.id) failedThisTick.add(r.id);");
    expect(drain).toContain("await drainOne(budget, failedThisTick)");
  });

  it("the claim itself excludes them, so the tick moves on to other work", () => {
    expect(drain).toContain('queue = queue.not("id", "in", `(${[...excluded].join(",")})`);');
    // Only when there is something to exclude — the common path is untouched.
    expect(drain).toContain("if (excluded.size > 0) {");
  });

  it("the failure return names the event, or the loop has nothing to remember", () => {
    expect(drain).toContain("return { processed: true, ok: false, error: msg, id: claimed.id };");
  });
});

describe("a settle that skips the rows settles the rows", () => {
  /* Measured 16 Sep 2026: 124 `queued` rows under settled events — invisible
     to every sweeper, because the reclaim reads PENDING events. The rule:
     the act that settles an event without walking its rows settles the rows
     too, as `skipped` with the carrier's fate in the message. */
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");

  it("the retirement terminalises the rows its passes never reached", () => {
    const at = drain.indexOf('verdict.act === "retire"');
    expect(at).toBeGreaterThan(-1);
    const block = drain.slice(at, at + 1600);
    expect(block).toContain("terminaliseOrphanedRows(");
    expect(block).toContain("retired after ${MAX_ATTEMPTS} attempts");
  });

  it("both pre-loop failure exits in the engine terminalise before returning", () => {
    for (const anchor of ['"record the missing GitHub App"', '"record the failed prime read"']) {
      const at = engine.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      expect(engine.slice(at, at + 400)).toContain("terminaliseOrphanedRows(");
    }
  });

  it("the terminaliser touches only non-terminal rows and marks them skipped, never failed", () => {
    const at = engine.indexOf("export async function terminaliseOrphanedRows(");
    expect(at).toBeGreaterThan(-1);
    const body = engine.slice(at, at + 900);
    expect(body).toContain('.in("status", ["queued", "pushing"])');
    expect(body).toContain('status: "skipped",');
    expect(body).not.toContain('status: "failed"');
  });
});

describe("a pass stamps progress in exactly the two places the drain counts it", () => {
  const raw = readFileSync("src/server/cascade-engine.server.ts", "utf8");
  const engine = stripComments(raw);
  const loop = (() => {
    const at = engine.indexOf("for (const r of orderedRows) {");
    const end = engine.indexOf(
      "if (deferred || stoppedEarly || lineageHolds.length > 0 || serverDeferrals.length > 0) {",
      at,
    );
    expect(at, "the per-clone loop").toBeGreaterThan(-1);
    expect(end, "the hand-back after it").toBeGreaterThan(at);
    return engine.slice(at, end);
  })();

  it("names one column, the one the migration adds", () => {
    expect(PROGRESS_COLUMN).toBe("progressed_at");
    const migration = readFileSync(
      "supabase/migrations/20261020100000_cascade_results_progressed_at.sql",
      "utf8",
    );
    expect(migration).toContain("-- @asserts column:cascade_results.progressed_at");
    expect(migration).toContain("add column if not exists progressed_at timestamptz");
  });

  it("the ledger flush stamps it, gated on the ledger having grown since the pass began", () => {
    const at = engine.indexOf("onProgress: async (progress) => {");
    expect(at).toBeGreaterThan(-1);
    const body = engine.slice(at, engine.indexOf("budget: opts?.budget", at));
    expect(body).toContain("const grew = ledgerGrew(priorLedger, progress);");
    expect(body).toContain("[PROGRESS_COLUMN]: new Date().toISOString()");
    // One update carries both, so a stamp cannot land without its ledger.
    expect(body).toMatch(/grew\s*\?\s*\{ \.\.\.ledgerWrite, \[PROGRESS_COLUMN\]/);
    // And a database that predates the column keeps the ledger.
    expect(body).toContain("progressError && grew && isMissingColumnError(progressError)");
    expect(body).toContain(".update(ledgerWrite)");
  });

  it("a settlement stamps it in the same update, and settles anyway where the column is absent", () => {
    const at = engine.indexOf("async function writeSettlement(");
    expect(at).toBeGreaterThan(-1);
    const body = engine.slice(at, engine.indexOf("\n}\n", at));
    expect(body).toContain(".update({ ...patch, [PROGRESS_COLUMN]: new Date().toISOString() })");
    expect(body).toContain(
      "if (!stamped.error || !isMissingColumnError(stamped.error)) return stamped.error;",
    );
    expect(body).toContain('.from("cascade_results").update(patch).eq("id", rowId);');
  });

  it("every write that takes a row out of the queue goes through it — the four `done` counts", () => {
    // A missing clone, a failed pin, the pass's own verdict, and an error the
    // pass could not defer: exactly what `skipped++`, `failed++` and the
    // patch-status counts add up to as `done`.
    const calls = loop.match(/await writeSettlement\(supabase, r\.id, /g) ?? [];
    expect(calls).toHaveLength(4);
    expect(loop).toContain(
      "await writeSettlement(supabase, r.id, settledRowPatch(patch, sourceSha));",
    );
    // No settlement around it: every direct row write left in the loop keeps
    // its row in the queue (a hold, the pushing mark, a pause, a requeue, the
    // trace) or is the ledger flush.
    const direct = [
      ...loop.matchAll(
        /\.from\("cascade_results"\)\s*\.update\(([\s\S]*?)\)\s*\.eq\("id", r\.id\)/g,
      ),
    ];
    expect(direct.length).toBeGreaterThan(5);
    for (const [, arg] of direct) {
      expect(arg).not.toContain("completed_at");
      expect(arg).not.toContain("settledRowPatch");
      expect(arg).not.toMatch(/status: "(succeeded|pr_opened|skipped|failed)"/);
    }
  });

  it("is never written anywhere else — not by the claim's pushing mark, not by a retirement", () => {
    // The import, the settlement and the flush.
    expect(engine.split("PROGRESS_COLUMN").length - 1).toBe(3);
    expect(engine).not.toContain("progressed_at");
    const pushing = engine.indexOf(
      '.update({ status: "pushing", started_at: new Date().toISOString() })',
    );
    expect(pushing).toBeGreaterThan(-1);
    // Retiring an event skips its unreached rows, and skipping them is not
    // progress: a stamp there would read the retirement as a convergence.
    const at = engine.indexOf("export async function terminaliseOrphanedRows(");
    expect(engine.slice(at, at + 900)).not.toContain("PROGRESS_COLUMN");
    expect(engine.slice(at, at + 900)).not.toContain("writeSettlement");
  });
});
