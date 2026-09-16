import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideEventFold,
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
    const claimLoopAt = drain.indexOf("const r = await drainOne(budget, failedThisTick)");
    expect(foldAt).toBeGreaterThan(-1);
    expect(claimLoopAt).toBeGreaterThan(foldAt);
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
