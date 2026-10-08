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
  UNEXPLAINED_FAILURE,
  describeCarrierRefresh,
  failedAgainst,
  planCarrierRefresh,
  settledRowPatch,
  stampFailedAgainst,
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

  it("re-queues a `pr_opened` row — the state a standing proposal is actually in", () => {
    /*
      The defect this test exists for. The first cut of `DELIVERED_STATUSES`
      was `succeeded | skipped`, inferred from the engine's return shapes, and
      it would have refused the very carrier this module was written for: both
      of its finished rows carry `pr_opened`. Measured over the whole ledger on
      21 Sep 2026 — succeeded 631, skipped 396, failed 42, pr_opened 3,
      queued 2 — and all three `pr_opened` rows carry a delivered sha and a
      pull request. Rare because transient, and transient is the state a held
      carrier's rows sit in.
    */
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [row({ status: "pr_opened" })],
      head: HEAD,
    });
    expect(d.kind).toBe("refresh");
  });

  it("holds an opinion about every status a reconciled row may carry", () => {
    // Anchored to `prReconcile`'s own union, so a fourth terminal status
    // cannot enter the pipeline while this module quietly ignores it.
    expect([...DELIVERED_STATUSES].sort()).toEqual(["pr_opened", "skipped", "succeeded"]);
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

describe("a failed row is offered each prime head once", () => {
  const failed = (over: Partial<CarrierResultRow> = {}) =>
    row({ status: "failed", delivered_sha: null, ...over });

  it("is not a delivery, and is never mistaken for one", () => {
    expect(DELIVERED_STATUSES.has("failed")).toBe(false);
  });

  it("re-offers a failure written before the stamp existed, once", () => {
    // The legacy row has no head on it at all. It is owed one attempt at the
    // current head, and that attempt stamps it.
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [failed({ error_message: "" })],
      head: HEAD,
    });
    expect(d.kind).toBe("refresh");
    if (d.kind !== "refresh") return;
    expect(d.rowIds).toEqual(["row-1"]);
    expect(d.why).toContain("before the head was recorded");
    expect(d.why).toContain(`prime@${HEAD.slice(0, 7)}`);
  });

  it("re-offers a failure stamped against an older head", () => {
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [failed({ error_message: stampFailedAgainst(OLD, "Bad Gateway") })],
      head: HEAD,
    });
    expect(d.kind).toBe("refresh");
    if (d.kind !== "refresh") return;
    expect(d.why).toContain(`failed against prime@${OLD.slice(0, 7)}`);
  });

  it("leaves a failure stamped against the head it is about to deliver", () => {
    // This is the bound. A deterministic failure costs one attempt per prime
    // commit, never one per five-minute claim of a held carrier.
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [failed({ error_message: stampFailedAgainst(HEAD, "Bad Gateway") })],
      head: HEAD,
    });
    expect(d.kind).toBe("none");
  });

  it("needs no delivered head: a failure is a pass that delivered nothing", () => {
    const d = planCarrierRefresh({ event: CARRIER, rows: [failed()], head: HEAD });
    expect(d.kind).toBe("refresh");
  });

  it("offers a failed row nothing on a carrier this module has no opinion about", () => {
    for (const event of [
      { ...CARRIER, completed_at: "2026-10-07T17:00:00Z" },
      { ...CARRIER, trigger: "manual" },
      { ...CARRIER, scope_filter: { module: "aml" } },
    ]) {
      expect(planCarrierRefresh({ event, rows: [failed()], head: HEAD }).kind).toBe("none");
    }
  });

  it("names a re-offered failure beside a re-offered delivery in one sentence", () => {
    const d = planCarrierRefresh({
      event: CARRIER,
      rows: [
        row({ id: "a", clone_name: "npc-client-dashboard", status: "pr_opened" }),
        failed({ id: "b", clone_name: "npc-crm-independent" }),
      ],
      head: HEAD,
    });
    expect(d.kind).toBe("refresh");
    if (d.kind !== "refresh") return;
    expect(d.rowIds).toEqual(["a", "b"]);
    expect(describeCarrierRefresh(d)).toMatch(
      /^Re-offered to npc-client-dashboard, npc-crm-independent — 1 clone\(s\) were delivered/,
    );
  });
});

describe("the stamp a failed row carries", () => {
  it("leads the message with the head, short", () => {
    expect(stampFailedAgainst(HEAD, "Bad Gateway")).toBe(
      `Failed against prime@${HEAD.slice(0, 7)} — Bad Gateway`,
    );
    expect(failedAgainst(stampFailedAgainst(HEAD, "Bad Gateway"))).toBe(HEAD.slice(0, 7));
  });

  it("says something where the failure said nothing", () => {
    // Both 15d4574f parent rows carried an empty message.
    for (const empty of ["", "   ", null, undefined]) {
      expect(stampFailedAgainst(HEAD, empty)).toBe(
        `Failed against prime@${HEAD.slice(0, 7)} — ${UNEXPLAINED_FAILURE}`,
      );
    }
  });

  it("is idempotent, and a later head replaces an earlier one rather than stacking", () => {
    const once = stampFailedAgainst(OLD, "Bad Gateway");
    expect(stampFailedAgainst(OLD, once)).toBe(once);
    expect(stampFailedAgainst(HEAD, once)).toBe(stampFailedAgainst(HEAD, "Bad Gateway"));
    expect(stampFailedAgainst(HEAD, stampFailedAgainst(OLD, ""))).toBe(
      stampFailedAgainst(HEAD, ""),
    );
  });

  it("stamps nothing it cannot vouch for", () => {
    expect(stampFailedAgainst("  ", "Bad Gateway")).toBe("Bad Gateway");
    expect(failedAgainst("Bad Gateway")).toBeNull();
    expect(failedAgainst(null)).toBeNull();
    // A message that merely mentions a head is not a stamp.
    expect(failedAgainst(`Pin points at prime@${OLD.slice(0, 7)}`)).toBeNull();
  });
});

describe("the patch a finished pass writes", () => {
  it("stamps a failure with the head it failed against", () => {
    expect(settledRowPatch({ status: "failed", error_message: "" }, HEAD)).toEqual({
      status: "failed",
      error_message: `Failed against prime@${HEAD.slice(0, 7)} — ${UNEXPLAINED_FAILURE}`,
    });
    expect(settledRowPatch({ status: "failed" }, HEAD).error_message).toContain(
      UNEXPLAINED_FAILURE,
    );
  });

  it("clears the note a hold or a deferral left on a row that has since delivered", () => {
    for (const status of DELIVERED_STATUSES) {
      expect(settledRowPatch({ status, files_changed: 3 }, HEAD)).toEqual({
        status,
        files_changed: 3,
        error_message: null,
      });
    }
  });

  it("keeps a message a delivery names for itself", () => {
    const patch = { status: "skipped", error_message: "Nothing to deliver for this scope" };
    expect(settledRowPatch(patch, HEAD)).toBe(patch);
  });

  it("leaves a pause exactly as it is", () => {
    const patch = { status: "queued", progress: { prepared: {} } };
    expect(settledRowPatch(patch, HEAD)).toBe(patch);
  });
});

describe("what it will not touch", () => {
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

  it("never re-queues a skip that decided about no content", () => {
    // "Clone not found": `delivered_sha` is null, and re-offering one re-runs
    // a refusal rather than a delivery.
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
    // Read from the live ledger, not invented: both carry `pr_opened`.
    { id: "ncd", clone_name: "npc-client-dashboard", status: "pr_opened", delivered_sha: OLD },
    { id: "crm", clone_name: "npc-crm-independent", status: "pr_opened", delivered_sha: OLD },
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

describe("carrier 15d4574f, 7–8 October 2026", () => {
  /*
    prime@14a3280's carrier, created 00:03Z on 7 Oct. At 16:53Z, three
    minutes after prime@d4b3be7 folded into it, a pass failed both parent rows
    with an empty error message while their proposals (#315, #81) stayed open.
    The children were held behind them, the carrier went back to `pending`
    every five minutes, and three more prime pushes folded into it before a
    person re-armed the parents by hand at 06:58Z on 8 Oct. The state below is
    the carrier as the claim after prime@44ec13d found it. `delivered_sha` on
    the failed rows is what the CRM row still records; a failed row's
    re-offer does not read it.
  */
  const AT_FAILURE = "d4b3be7e512deea6ee183444f75a7a8fa54b41c2";
  const NOW = "44ec13daf32b5b7f3821c001311554bbdac7d45f";
  const legacy: CarrierResultRow[] = [
    {
      id: "e40b1d34",
      clone_name: "NPC Client Dashboard",
      status: "failed",
      delivered_sha: "1dc42834a9738d07fe09380b20bac5e7a43c5e0c",
      error_message: "",
    },
    {
      id: "282695be",
      clone_name: "NPC CRM Independent",
      status: "failed",
      delivered_sha: "1dc42834a9738d07fe09380b20bac5e7a43c5e0c",
      error_message: "",
    },
    {
      id: "bf6d1f53",
      clone_name: "Preflight Property Group",
      status: "queued",
      delivered_sha: null,
    },
    { id: "b7dd327b", clone_name: "NPC Test", status: "queued", delivered_sha: null },
  ];

  it("re-offers both parents, which the old rule left failed for fourteen hours", () => {
    const d = planCarrierRefresh({ event: CARRIER, rows: legacy, head: NOW });
    expect(d.kind).toBe("refresh");
    if (d.kind !== "refresh") return;
    expect(d.rowIds).toEqual(["e40b1d34", "282695be"]);
  });

  it("had the stamp existed, offers them the next head and not the one they failed at", () => {
    const stamped = legacy.map((r) =>
      r.status === "failed" ? { ...r, error_message: stampFailedAgainst(AT_FAILURE, "") } : r,
    );
    expect(planCarrierRefresh({ event: CARRIER, rows: stamped, head: AT_FAILURE }).kind).toBe(
      "none",
    );
    expect(planCarrierRefresh({ event: CARRIER, rows: stamped, head: NOW }).kind).toBe("refresh");
  });

  it("settles after one attempt at the head: the retry that fails again is not retried this head", () => {
    const retried = legacy.map((r) =>
      r.status === "failed"
        ? { ...r, ...settledRowPatch({ status: "failed", error_message: "Bad Gateway" }, NOW) }
        : r,
    );
    expect(planCarrierRefresh({ event: CARRIER, rows: retried, head: NOW }).kind).toBe("none");
  });
});
