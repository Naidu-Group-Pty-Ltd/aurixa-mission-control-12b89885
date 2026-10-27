import { describe, expect, it } from "vitest";
import {
  UNREADABLE,
  approvalNotice,
  fireScopeFilter,
  planSpawn,
  type SpawnFacts,
  type SpawnRequest,
} from "./operatorCascade.pure";

const NCD = "e40b1d34-0000-4000-8000-000000000001";
const CRM = "282695be-0000-4000-8000-000000000002";
const PARENT = "15d4574f-0000-4000-8000-000000000003";
const LIVE = "dd7180c7-0000-4000-8000-000000000004";

const CLONES = [
  { id: NCD, name: "NPC Client Dashboard" },
  { id: CRM, name: "NPC CRM Independent" },
];

const settledParent: SpawnFacts["parent"] = { status: "completed", mode: "auto_merge" };

describe("a retry", () => {
  const retry: SpawnRequest = { intent: "retry", mode: "pr", of: PARENT, cloneId: NCD };

  it("is one clone, named after the cascade it retries, in the mode picked", () => {
    const plan = planSpawn(retry, { clones: CLONES, parent: settledParent });
    expect(plan).toEqual({
      ok: true,
      cloneIds: [NCD],
      scopeFilter: { scope: "selected", clone_ids: [NCD], retry_of: PARENT },
      summary: `Retry of cascade ${PARENT.slice(0, 8)} for one clone in pr mode`,
    });
  });

  /* The detail page offered "Retry as" only while the parent was settled. */
  it("waits while the cascade it retries is still pending or running", () => {
    for (const status of ["pending", "running"]) {
      const plan = planSpawn(retry, { clones: CLONES, parent: { status, mode: "pr" } });
      expect(plan.ok, status).toBe(false);
      if (!plan.ok) expect(plan.reason).toContain(`still ${status}`);
    }
  });

  it("refuses when the parent cannot be read, or no longer exists", () => {
    expect(planSpawn(retry, { clones: CLONES, parent: UNREADABLE }).ok).toBe(false);
    expect(planSpawn(retry, { clones: CLONES, parent: null }).ok).toBe(false);
    expect(planSpawn(retry, { clones: CLONES }).ok).toBe(false);
  });
});

describe("a rollback", () => {
  const rollback: SpawnRequest = {
    intent: "rollback",
    mode: "pr",
    of: PARENT,
    cloneIds: [NCD, CRM, NCD],
  };

  it("names its parent and the mode the parent ran in, each clone once", () => {
    const plan = planSpawn(rollback, { clones: CLONES, parent: settledParent });
    expect(plan).toEqual({
      ok: true,
      cloneIds: [NCD, CRM],
      scopeFilter: {
        scope: "selected",
        clone_ids: [NCD, CRM],
        rollback_of: PARENT,
        source_mode: "auto_merge",
      },
      summary: `Rollback of cascade ${PARENT.slice(0, 8)} (2 clones, pr)`,
    });
  });

  /* "Roll back" was offered on a completed or partial cascade, and on nothing else. */
  it("only rolls back a completed or partial cascade", () => {
    expect(
      planSpawn(rollback, { clones: CLONES, parent: { status: "partial", mode: "pr" } }).ok,
    ).toBe(true);
    const failed = planSpawn(rollback, {
      clones: CLONES,
      parent: { status: "failed", mode: "pr" },
    });
    expect(failed.ok).toBe(false);
  });

  it("refuses an empty list rather than reading it as every clone", () => {
    const plan = planSpawn(
      { ...rollback, cloneIds: [] },
      { clones: CLONES, parent: settledParent },
    );
    expect(plan).toEqual({ ok: false, reason: "No clones to act on.", liveEventId: null });
  });
});

describe("Cascade now", () => {
  const now: SpawnRequest = { intent: "redeliver", mode: "auto_merge", cloneId: CRM };

  it("is one fresh delivery to that clone, recorded as started from its page", () => {
    const plan = planSpawn(now, { clones: CLONES, liveDelivery: null });
    expect(plan).toEqual({
      ok: true,
      cloneIds: [CRM],
      scopeFilter: { scope: "selected", clone_ids: [CRM], origin: "clone_page" },
      summary: "Cascade now for NPC CRM Independent in auto merge mode, started from its page",
    });
  });

  /*
    A delivery already waiting reads prime's head when it runs. Minting beside
    it pushes the same tree twice and leaves two proposals to reconcile.
  */
  it("refuses while a delivery to the clone is in flight, and names that delivery", () => {
    const plan = planSpawn(now, { clones: CLONES, liveDelivery: { eventId: LIVE } });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.liveEventId).toBe(LIVE);
      expect(plan.reason).toContain(`cascade ${LIVE.slice(0, 8)}`);
    }
  });

  it("fails closed when it cannot tell whether a delivery is in flight", () => {
    expect(planSpawn(now, { clones: CLONES, liveDelivery: UNREADABLE }).ok).toBe(false);
    expect(planSpawn(now, { clones: CLONES }).ok).toBe(false);
  });

  it("never carries module_globs, so the pass is the clone's full installed tree", () => {
    const plan = planSpawn(now, { clones: CLONES, liveDelivery: null });
    expect(plan.ok && "module_globs" in plan.scopeFilter).toBe(false);
  });
});

describe("the named clones", () => {
  it("refuses a clone the fleet does not hold", () => {
    const plan = planSpawn(
      { intent: "redeliver", mode: "pr", cloneId: "00000000-0000-4000-8000-00000000dead" },
      { clones: CLONES, liveDelivery: null },
    );
    expect(plan).toEqual({
      ok: false,
      reason: "1 clone named here is no longer in the fleet.",
      liveEventId: null,
    });
  });

  it("refuses when the fleet cannot be read", () => {
    const plan = planSpawn(
      { intent: "retry", mode: "pr", of: PARENT, cloneId: NCD },
      { clones: UNREADABLE, parent: settledParent },
    );
    expect(plan.ok).toBe(false);
  });
});

describe("the scope a /cascades fire records", () => {
  it("keeps All clones as it always was", () => {
    expect(fireScopeFilter("all", ["crm"], [NCD, CRM])).toEqual({ scope: "all" });
  });

  it("records the tags chosen and the clones they reached", () => {
    expect(fireScopeFilter("tagged", [" crm ", "crm", ""], [NCD])).toEqual({
      scope: "tagged",
      tags: ["crm"],
      clone_ids: [NCD],
    });
  });

  it("records the clones picked", () => {
    expect(fireScopeFilter("selected", [], [CRM])).toEqual({ scope: "selected", clone_ids: [CRM] });
  });
});

it("asks a second operator through a notice the drain and approveCascade can find", () => {
  const notice = approvalNotice({
    eventId: PARENT,
    mode: "auto_merge",
    cloneCount: 4,
    reason: "Auto-merge across 4 clones (>3) requires a second operator.",
  });
  expect(notice.kind).toBe("cascade_awaiting_approval");
  // Both clear the notice by this column.
  expect(notice.cascade_event_id).toBe(PARENT);
  expect(notice.url).toBe(`/cascades/${PARENT}`);
  expect(notice.title).toBe("Approval needed · auto merge cascade");
  // It is read by every operator, so it does not say "you".
  expect(notice.body).not.toMatch(/\byou\b/i);
});
