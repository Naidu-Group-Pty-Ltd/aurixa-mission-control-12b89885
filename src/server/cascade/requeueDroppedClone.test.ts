import { describe, it, expect } from "vitest";
import { planRequeue, type DroppedCloneFacts } from "./requeueDroppedClone.pure";

const READY: DroppedCloneFacts = {
  sourceEventId: "3506bda4-e2f2-4fd9-816b-0b307fbd476f",
  sourceMode: "auto_merge",
  cloneId: "clone-1",
  hasLiveDelivery: false,
  alreadyRequeued: false,
};

describe("planRequeue", () => {
  it("mints a scoped delivery naming the clone and its parent", () => {
    const p = planRequeue(READY);
    expect(p.mint).toBe(true);
    if (!p.mint) return;
    expect(p.event.scope_filter.clone_ids).toEqual(["clone-1"]);
    expect(p.event.scope_filter.retry_of).toBe(READY.sourceEventId);
    expect(p.event.status).toBe("pending");
  });

  it("uses `retry_of`, which the lineage panel already walks", () => {
    // Not a new key. `cascade-lineage-panel` reads `scope_filter->>'retry_of'`
    // for ancestors and `.contains("scope_filter", { retry_of: event.id })`
    // for descendants, so the repair shows beside its parent with no change to
    // any surface. A `requeue_of` would have been invisible there.
    const p = planRequeue(READY);
    expect(p.mint && Object.keys(p.event.scope_filter)).toContain("retry_of");
  });

  it("inherits the parent's mode — a PR delivery never becomes an auto-merge", () => {
    // The mode is how a tenant's code lands. A repair may re-run a delivery;
    // it may not decide that what was offered for review is now merged.
    for (const mode of ["pr", "auto_merge", "notify"] as const) {
      const p = planRequeue({ ...READY, sourceMode: mode });
      expect(p.mint && p.event.mode, mode).toBe(mode);
    }
  });

  it("is `scheduled` and initiated by nobody, because machinery took it", () => {
    const p = planRequeue(READY);
    expect(p.mint && p.event.trigger).toBe("scheduled");
    expect(p.mint && p.event.initiated_by).toBeNull();
  });

  it("refuses when this delivery was already re-queued", () => {
    // Without this the custodian mints one a tick until the daily cap, and
    // every one of them pushes the same tree.
    const p = planRequeue({ ...READY, alreadyRequeued: true });
    expect(p.mint).toBe(false);
  });

  it("refuses when a delivery is already queued for this clone", () => {
    // A cascade reads prime's head when it RUNS, so one already waiting will
    // carry everything this one would.
    const p = planRequeue({ ...READY, hasLiveDelivery: true });
    expect(p.mint).toBe(false);
    expect(p.mint === false && p.why).toContain("already queued");
  });

  it("FAILS CLOSED on every unreadable fact", () => {
    // A custodian that mints on "I could not check" mints on every tick a
    // database hiccups. Each of these is a refusal, not a default.
    const unreadable: Array<Partial<DroppedCloneFacts>> = [
      { alreadyRequeued: null },
      { hasLiveDelivery: null },
      { sourceMode: null },
    ];
    for (const patch of unreadable) {
      const p = planRequeue({ ...READY, ...patch });
      expect(p.mint, JSON.stringify(patch)).toBe(false);
    }
  });

  it("checks whether it already ran BEFORE anything else", () => {
    // Ordering matters: an unreadable live-delivery check must not stop the
    // idempotency check from refusing. Both null still refuses, and the reason
    // names the one that is load-bearing.
    const p = planRequeue({ ...READY, alreadyRequeued: true, hasLiveDelivery: null });
    expect(p.mint).toBe(false);
    expect(p.mint === false && p.why).toContain("already been re-queued");
  });

  it("never proposes touching the settled delivery it repairs", () => {
    // The parent is a true record of what happened that day at that SHA.
    // Rewriting its status to re-run it destroys the record in order to
    // reproduce the event.
    const p = planRequeue(READY);
    const json = JSON.stringify(p);
    expect(json).not.toContain('"completed_at"');
    expect(json).not.toMatch(/"status"\s*:\s*"partial"/);
    expect(p.mint && p.event.status).toBe("pending");
  });
});
