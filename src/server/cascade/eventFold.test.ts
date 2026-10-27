import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CREATION_ARM_GRACE_MS } from "./armGrace.pure";
import {
  decideEventFold,
  isArmed,
  isFoldableCommitEvent,
  scopeFilterIsEmpty,
  supersededSummary,
  type FoldableEvent,
} from "./eventFold.pure";

const event = (over: Partial<FoldableEvent> = {}): FoldableEvent => ({
  id: "e-1",
  trigger: "commit",
  mode: "auto_merge",
  status: "pending",
  requires_approval: false,
  worker_started_at: null,
  scope_filter: {},
  created_at: "2026-09-15T00:00:00Z",
  attempts: 0,
  ...over,
});

describe("what is never folded", () => {
  it("a manual event is an operator's explicit act", () => {
    expect(isFoldableCommitEvent(event({ trigger: "manual" }))).toBe(false);
  });

  it("a scheduled event is a policy's", () => {
    expect(isFoldableCommitEvent(event({ trigger: "scheduled" }))).toBe(false);
  });

  it("an event awaiting approval keeps its gate", () => {
    expect(isFoldableCommitEvent(event({ requires_approval: true }))).toBe(false);
  });

  it("a claimed event is running, not waiting", () => {
    expect(isFoldableCommitEvent(event({ worker_started_at: "2026-09-15T00:01:00Z" }))).toBe(false);
  });

  it("an attempts-exhausted event is pending in name only — never a survivor, never superseded", () => {
    /* A pending row at the claim ceiling is one no claim will ever take.
       Folding live work into it stalls the queue behind a row nothing will
       run; superseding it hides the drain's own failure story. */
    const decision = decideEventFold([
      event({ id: "zombie", attempts: 3, created_at: "2026-09-14T00:00:00Z" }),
      event({ id: "live-a", created_at: "2026-09-15T00:00:00Z" }),
      event({ id: "live-b", created_at: "2026-09-15T01:00:00Z" }),
    ]);
    expect(decision.keep).toBe("live-a");
    expect(decision.supersede).toEqual(["live-b"]);
  });

  it("a scoped event delivers a named module, not prime's head", () => {
    expect(isFoldableCommitEvent(event({ scope_filter: { module_globs: ["src/x/**"] } }))).toBe(
      false,
    );
  });

  it("a finished or running event is not in the queue", () => {
    for (const status of ["running", "completed", "failed", "partial"]) {
      expect(isFoldableCommitEvent(event({ status }))).toBe(false);
    }
  });
});

describe("scopeFilterIsEmpty", () => {
  it("treats null and {} as empty, anything else as a real scope", () => {
    expect(scopeFilterIsEmpty(null)).toBe(true);
    expect(scopeFilterIsEmpty(undefined)).toBe(true);
    expect(scopeFilterIsEmpty({})).toBe(true);
    expect(scopeFilterIsEmpty({ module_globs: [] })).toBe(false);
    expect(scopeFilterIsEmpty([])).toBe(false);
    expect(scopeFilterIsEmpty("{}")).toBe(false);
  });
});

describe("the fold", () => {
  it("keeps the OLDEST foldable event — its rows carry the pass progress", () => {
    const decision = decideEventFold([
      event({ id: "newer", created_at: "2026-09-15T02:00:00Z" }),
      event({ id: "oldest", created_at: "2026-09-15T00:00:00Z" }),
      event({ id: "middle", created_at: "2026-09-15T01:00:00Z" }),
    ]);
    expect(decision.keep).toBe("oldest");
    expect(decision.supersede.sort()).toEqual(["middle", "newer"]);
  });

  it("folds only events of the survivor's own mode", () => {
    /* Folding a `pr` proposal into an `auto_merge` one would change what
       happens to the tree, not just when. */
    const decision = decideEventFold([
      event({ id: "keep-me", mode: "auto_merge", created_at: "2026-09-15T00:00:00Z" }),
      event({ id: "same-mode", mode: "auto_merge", created_at: "2026-09-15T01:00:00Z" }),
      event({ id: "other-mode", mode: "pr", created_at: "2026-09-15T02:00:00Z" }),
    ]);
    expect(decision.keep).toBe("keep-me");
    expect(decision.supersede).toEqual(["same-mode"]);
  });

  it("leaves the unfoldable alone whatever their age", () => {
    const decision = decideEventFold([
      event({ id: "manual", trigger: "manual", created_at: "2026-09-14T00:00:00Z" }),
      event({ id: "gated", requires_approval: true, created_at: "2026-09-14T01:00:00Z" }),
      event({ id: "queued-a", created_at: "2026-09-15T00:00:00Z" }),
      event({ id: "queued-b", created_at: "2026-09-15T01:00:00Z" }),
    ]);
    expect(decision.keep).toBe("queued-a");
    expect(decision.supersede).toEqual(["queued-b"]);
  });

  it("does nothing on an empty or fully unfoldable queue", () => {
    expect(decideEventFold([])).toEqual({ keep: null, supersede: [] });
    expect(decideEventFold([event({ trigger: "manual" })])).toEqual({
      keep: null,
      supersede: [],
    });
  });

  it("one foldable event is kept with nothing to fold", () => {
    expect(decideEventFold([event({ id: "only" })])).toEqual({ keep: "only", supersede: [] });
  });

  it("ties on created_at break on id, so two workers reach one answer", () => {
    const decision = decideEventFold([
      event({ id: "b", created_at: "2026-09-15T00:00:00Z" }),
      event({ id: "a", created_at: "2026-09-15T00:00:00Z" }),
    ]);
    expect(decision.keep).toBe("a");
    expect(decision.supersede).toEqual(["b"]);
  });
});

describe("an event still inside its arm grace is not folded yet", () => {
  const T = Date.parse("2026-10-18T21:29:02.000Z");
  const at = (msBeforeNow: number) => new Date(T - msBeforeNow).toISOString();

  it("leaves a young event alone — its rows may still be on their way", () => {
    // Event 0a3c9817, 18 Oct 2026: folded 0.29 s after it was created, closed
    // with no rows yet, and its four rows sat queued under a completed event.
    const decision = decideEventFold(
      [
        event({ id: "carrier", created_at: at(600_000) }),
        event({ id: "young", created_at: at(290) }),
      ],
      T,
    );
    expect(decision).toEqual({ keep: "carrier", supersede: [] });
  });

  it("folds it on a later tick, once the grace has passed", () => {
    const decision = decideEventFold(
      [
        event({ id: "carrier", created_at: at(600_000) }),
        event({ id: "armed", created_at: at(CREATION_ARM_GRACE_MS) }),
      ],
      T,
    );
    expect(decision).toEqual({ keep: "carrier", supersede: ["armed"] });
  });

  it("asked without a clock, folds as it always did", () => {
    const decision = decideEventFold([
      event({ id: "carrier", created_at: at(600_000) }),
      event({ id: "young", created_at: at(290) }),
    ]);
    expect(decision).toEqual({ keep: "carrier", supersede: ["young"] });
  });

  it("reads an unreadable creation time as armed, which is the old behaviour", () => {
    expect(isArmed("not a date", T)).toBe(true);
    expect(isArmed(at(1), T)).toBe(false);
  });
});

describe("the story a superseded row carries", () => {
  it("names the survivor", () => {
    expect(supersededSummary("0123456789abcdef")).toContain("01234567");
    expect(supersededSummary("0123456789abcdef")).toMatch(/superseded/i);
  });
});

describe("the wiring the fold depends on", () => {
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
  const trigger = readFileSync("src/server/cascade-trigger.server.ts", "utf8");
  const webhook = readFileSync("src/routes/hooks.github.tsx", "utf8");

  it("the drain folds the backlog before anything is claimed", () => {
    const foldAt = drain.indexOf("await foldQueuedCommitEvents()");
    const claimLoopAt = drain.indexOf("const r = await drainOne(budget, ranThisTick)");
    expect(foldAt).toBeGreaterThan(-1);
    expect(claimLoopAt).toBeGreaterThan(foldAt);
  });

  it("the drain folds with the clock, so the arm grace holds at the fold too", () => {
    expect(drain).toContain("decideEventFold((data ?? []) as FoldableEvent[], Date.now())");
  });

  it("the drain settles rows still queued under a settled event, after the fold", () => {
    const sweep = drain.slice(
      drain.indexOf("async function settleStrandedRows"),
      drain.indexOf("async function claimOne"),
    );
    expect(sweep).toContain('.select("id, cascade_events!inner(status)")');
    expect(sweep).toContain('.eq("status", "queued")');
    expect(sweep).toContain('.in("cascade_events.status", ["completed", "failed"])');
    // Re-checked at the write, so a row a claim has since moved is left alone.
    expect(sweep.slice(sweep.indexOf(".update("))).toContain('.eq("status", "queued")');
    expect(sweep).toContain("carrierSettledMessage(");
  });

  it("the sweep leaves a row anything touched within a stall window — a retry's re-armed rows", () => {
    // "Retry failed" re-queues a failed event's rows before it reopens the
    // event, so between its two writes a re-armed row reads exactly like a
    // strand (Codex P2 on #369). Only age tells them apart, and it is asked at
    // the read and again at the write.
    const sweep = drain.slice(
      drain.indexOf("async function settleStrandedRows"),
      drain.indexOf("async function claimOne"),
    );
    expect(sweep).toMatch(
      /const untouchedSince = new Date\(Date\.now\(\) - STALL_MINUTES \* 60_000\)\.toISOString\(\);/,
    );
    const read = sweep.slice(0, sweep.indexOf(".update("));
    const write = sweep.slice(sweep.indexOf(".update("));
    expect(read).toContain('.lt("updated_at", untouchedSince)');
    expect(write).toContain('.lt("updated_at", untouchedSince)');
    // The age means something only because every write to a row stamps it —
    // the retry's own reset included.
    const table = readFileSync(
      "supabase/migrations/20260419215311_091021d2-99de-4fc1-b893-0cfa0ddf8f6c.sql",
      "utf8",
    );
    expect(table).toMatch(
      /CREATE TRIGGER update_cascade_results_updated_at\s+BEFORE UPDATE ON public\.cascade_results\s+FOR EACH ROW EXECUTE FUNCTION public\.update_updated_at_column\(\);/,
    );
    expect(drain.indexOf("await settleStrandedRows()")).toBeGreaterThan(
      drain.indexOf("await foldQueuedCommitEvents()"),
    );
  });

  it("the fold's updates re-check pending + unclaimed, so a racing claim wins", () => {
    const fold = drain.slice(
      drain.indexOf("async function foldQueuedCommitEvents"),
      drain.indexOf("async function claimOne"),
    );
    const close = fold.slice(fold.indexOf('status: "completed"'));
    expect(close).toContain('.eq("status", "pending")');
    expect(close).toContain('.is("worker_started_at", null)');
  });

  it("superseded results are skipped, never failed — nothing failed", () => {
    const fold = drain.slice(
      drain.indexOf("async function foldQueuedCommitEvents"),
      drain.indexOf("async function claimOne"),
    );
    expect(fold).toContain('status: "skipped"');
    expect(fold).not.toContain('status: "failed"');
  });

  it("creation stands a commit push down only for a pending UNCLAIMED carrier", () => {
    const stand = trigger.slice(trigger.indexOf("One queued commit cascade carries"));
    expect(stand).toContain('.eq("status", "pending")');
    expect(stand).toContain('.is("worker_started_at", null)');
    // A read that failed creates the event as before — a duplicate is a
    // cost, a push that silently cascades nowhere is the original sin.
    expect(stand).toContain("if (!pendingErr)");
  });

  it("the webhook never fires an event it did not just create", () => {
    /* Firing the pending carrier from the webhook would race the drain's
       claim and run the same pass twice against the same budget. */
    const push = webhook.slice(
      webhook.indexOf("const { eventId, cloneCount, error, alreadyExisted"),
    );
    const standDownAt = push.indexOf("if (alreadyExisted)");
    const fireAt = push.indexOf("executeCascade(supabaseAdmin, eventId)");
    expect(standDownAt).toBeGreaterThan(-1);
    expect(fireAt).toBeGreaterThan(standDownAt);
  });
});
