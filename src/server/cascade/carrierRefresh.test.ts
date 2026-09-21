/**
 * What a held carrier may re-offer, and what it must leave alone.
 *
 * The scenario at the bottom is the fleet freeze of 20 September 2026 written
 * as a fixture: it is the case the module exists for, and it is the one that
 * would have failed before it existed.
 */
import { describe, expect, it } from "vitest";
import {
  DELIVERED_STATUSES,
  describeCarrierRefresh,
  planCarrierRefresh,
  type CarrierEventFacts,
  type CarrierResultRow,
} from "./carrierRefresh.pure";

const CARRIER: CarrierEventFacts = {
  trigger: "commit",
  completed_at: null,
  scope_filter: null,
};

const HEAD = "075a088819cda6926c35ed865936e330b2bfb7f6";
const OLD = "c4ceeeb39d7991475cd0bed92a5c4e2712a5c0ed";

function row(over: Partial<CarrierResultRow> = {}): CarrierResultRow {
  return {
    id: "row-1",
    clone_name: "npc-client-dashboard",
    status: "skipped",
    delivered_sha: OLD,
    ...over,
  };
}

describe("a delivery behind prime's head is re-offered", () => {
  it("re-queues a row the carrier finished at an older head", () => {
    const d = planCarrierRefresh({ event: CARRIER, rows: [row()], head: HEAD });
    expect(d.kind).toBe("refresh");
    if (d.kind !== "refresh") return;
    expect(d.rowIds).toEqual(["row-1"]);
    expect(d.clones).toEqual(["npc-client-dashboard"]);
    // The sentence names both heads, because an operator reading the row has
    // to be able to tell which delivery is being replaced.
    expect(d.why).toContain("c4ceeeb");
    expect(d.why).toContain("075a088");
  });

  it("re-queues a succeeded row as readily as a skipped one", () => {
    // `succeeded` is a clone whose proposal landed; the next prime commit is
    // still owed to it, and before lineage a fresh event is what delivered it.
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [row({ status: "succeeded" })],
      head: HEAD,
    });
    expect(d.kind).toBe("refresh");
  });

  it("names every clone it re-offers to, once each", () => {
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [
        row({ id: "a", clone_name: "npc-client-dashboard" }),
        row({ id: "b", clone_name: "npc-crm-independent" }),
      ],
      head: HEAD,
    });
    expect(d.kind).toBe("refresh");
    if (d.kind !== "refresh") return;
    expect(d.rowIds).toEqual(["a", "b"]);
    expect(describeCarrierRefresh(d)).toContain("npc-client-dashboard, npc-crm-independent");
  });
});

describe("the cost is bounded by prime moving, not by the tick", () => {
  /*
    The whole safety argument for re-queueing at all. A pass costs ~300 blob
    reads per clone against the App's hourly budget, and a held carrier is
    claimed every five minutes — so a refresh that fired on the claim rather
    than on the head would be the exact multiplication `eventFold`'s header
    was written to stop.
  */
  it("refreshes nothing once the delivered head IS prime's head", () => {
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [row({ delivered_sha: HEAD })],
      head: HEAD,
    });
    expect(d.kind).toBe("none");
  });

  it("is idempotent: the pass that answers a refresh disarms the next one", () => {
    const first = planCarrierRefresh({ event: CARRIER, rows: [row()], head: HEAD });
    expect(first.kind).toBe("refresh");
    // The pass re-delivers and stamps the row with the head it delivered.
    const second = planCarrierRefresh({
      event: CARRIER,
      rows: [row({ delivered_sha: HEAD })],
      head: HEAD,
    });
    expect(second.kind).toBe("none");
  });
});

describe("what it will not touch", () => {
  it("never re-queues a failed row", () => {
    // `requeueDroppedClone` owns this, and its attempt accounting depends on
    // the row staying failed: an in-place retry refunds every pass and the
    // ceiling that retires a bad event is never reached.
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [row({ status: "failed" })],
      head: HEAD,
    });
    expect(d.kind).toBe("none");
    expect(DELIVERED_STATUSES.has("failed")).toBe(false);
  });

  it("never touches a row that is still live", () => {
    for (const status of ["queued", "pushing"]) {
      const d = planCarrierRefresh({
        event: CARRIER,
        rows: [row({ status })],
        head: HEAD,
      });
      expect(d.kind).toBe("none");
    }
  });

  it("never re-queues a row that decided about no content", () => {
    // "Clone not found", a pin that failed validation: `delivered_sha` is
    // null, and re-offering one re-runs a refusal rather than a delivery.
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [row({ delivered_sha: null })],
      head: HEAD,
    });
    expect(d.kind).toBe("none");
  });

  it("never refreshes a settled event", () => {
    const d = planCarrierRefresh({
      event: { ...CARRIER, completed_at: "2026-09-20T18:05:00Z" },
      rows: [row()],
      head: HEAD,
    });
    expect(d.kind).toBe("none");
    expect(d.why).toContain("settled");
  });

  it("never refreshes a manual or scheduled event", () => {
    for (const trigger of ["manual", "scheduled"]) {
      const d = planCarrierRefresh({
        event: { ...CARRIER, trigger },
        rows: [row()],
        head: HEAD,
      });
      expect(d.kind).toBe("none");
      expect(d.why).toContain(trigger);
    }
  });

  it("never refreshes a scoped event, and reads {} as unscoped", () => {
    const scoped = planCarrierRefresh({
      event: { ...CARRIER, scope_filter: { module: "aml" } },
      rows: [row()],
      head: HEAD,
    });
    expect(scoped.kind).toBe("none");

    const empty = planCarrierRefresh({
      event: { ...CARRIER, scope_filter: {} },
      rows: [row()],
      head: HEAD,
    });
    expect(empty.kind).toBe("refresh");
  });

  it("decides nothing when no head was resolved", () => {
    const d = planCarrierRefresh({ event: CARRIER, rows: [row()], head: "   " });
    expect(d.kind).toBe("none");
  });

  it("describes only a refresh", () => {
    expect(describeCarrierRefresh({ kind: "none", why: "x" })).toBeNull();
  });
});

describe("the fleet freeze of 20 September 2026", () => {
  /*
    prime@c4ceeeb reached the two clones that read prime directly at 18:00:26Z
    and held the two below them. Both proposals went red; the carrier stayed
    pending on lineage; nine further prime commits stood down into it. The
    state below is that carrier as the tenth claim found it.
  */
  const rows: CarrierResultRow[] = [
    // Delivered, red, and never revisited.
    { id: "ncd", clone_name: "npc-client-dashboard", status: "skipped", delivered_sha: OLD },
    { id: "crm", clone_name: "npc-crm-independent", status: "skipped", delivered_sha: OLD },
    // Held behind their parent, still queued, seen by every pass.
    { id: "pfl", clone_name: "preflight-property-group", status: "queued", delivered_sha: null },
    { id: "tst", clone_name: "npc-test-76b3b3", status: "queued", delivered_sha: null },
  ];

  it("re-offers prime's current head to exactly the two clones the carrier had finished", () => {
    const d = planCarrierRefresh({ event: CARRIER, rows, head: HEAD });
    expect(d.kind).toBe("refresh");
    if (d.kind !== "refresh") return;
    expect(d.rowIds).toEqual(["ncd", "crm"]);
    // The held children are already queued. Touching them would change
    // nothing and would double-count the pass's own total.
    expect(d.rowIds).not.toContain("pfl");
    expect(d.rowIds).not.toContain("tst");
  });

  it("stops once the carrier has caught up, even while the children are still held", () => {
    // The lineage hold is a correct wait on a person's merge, and it must not
    // become a reason to re-buy the parents' trees every five minutes.
    const caughtUp = rows.map((r) => (r.delivered_sha ? { ...r, delivered_sha: HEAD } : r));
    expect(planCarrierRefresh({ event: CARRIER, rows: caughtUp, head: HEAD }).kind).toBe("none");
  });
});
