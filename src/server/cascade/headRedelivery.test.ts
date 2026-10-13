/**
 * Prime's head is owed a delivery until a pass has made one — and a
 * person's "no" is never undone on the way.
 *
 * The failure this exists for, from 11–12 Oct 2026: five commit events in a
 * row were retired at the attempt ceiling while one clone's variant merges
 * re-ran every tick, and the head's own event (050dedb7, prime@9b5e472) was
 * among them. The drift beacon saw "the head has an event" and stayed
 * silent, so the fleet sat behind prime with nothing in the queue and
 * nothing reporting it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { supersededSummary } from "./eventFold.pure";
import {
  HEAD_REDELIVERY_AUDIT_ACTION,
  HEAD_REDELIVERY_COOLDOWN_MS,
  HEAD_REDELIVERY_ID_NAMESPACE,
  HEAD_REDELIVERY_MAX,
  HEAD_REDELIVERY_SCOPE,
  REJECTION_SUMMARY_PREFIX,
  SUPERSEDED_SUMMARY_PREFIX,
  decideHeadRedelivery,
  findSupersedingCarrier,
  isReviewerRejection,
  isSupersededSummary,
  nameBasedUuid,
  priorRedeliveriesFrom,
  redeliveryEvent,
  redeliveryEventId,
  redeliverySummary,
  settledAt,
  type PriorRedeliveries,
  type RedeliveryEventReading,
} from "./headRedelivery.pure";

const HEAD_SHA = "9b5e472c72c6c5ed9aef37f10465ad5a59956ad3";
const HEAD_ID = "050dedb7-1111-4222-8333-944445555666";
const CARRIER_ID = "211c4329-aaaa-4bbb-8ccc-9dddeeeeffff";
const REDELIVERY_ID = "7d1e0f00-1234-4567-89ab-cdef01234567";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const HOURS_AGO = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function event(over: Partial<RedeliveryEventReading> = {}): RedeliveryEventReading {
  return {
    id: HEAD_ID,
    status: "failed",
    mode: "pr",
    summary: "Exhausted: 3 attempts without progress",
    requires_approval: false,
    approved_at: null,
    worker_finished_at: HOURS_AGO(5),
    completed_at: HOURS_AGO(5),
    updated_at: HOURS_AGO(5),
    created_at: HOURS_AGO(9),
    ...over,
  };
}

const NONE: PriorRedeliveries = { count: 0, lastAt: null, lastEventId: null };

function decide(over: Partial<Parameters<typeof decideHeadRedelivery>[0]> = {}) {
  return decideHeadRedelivery({
    head: event(),
    carrier: null,
    carrierUnreadable: false,
    liveDeliveries: 0,
    prior: NONE,
    lastRedelivery: null,
    lastRedeliveryUnreadable: false,
    nowMs: NOW,
    ...over,
  });
}

function refusal(v: ReturnType<typeof decide>): string {
  if (v.redeliver) throw new Error(`expected a refusal, got a redelivery (${v.cause})`);
  return v.why;
}

describe("the summaries it reads", () => {
  it("recognises a reviewer's rejection by the prefix rejectCascade writes", () => {
    // `cascade-approvals.functions.ts` writes `Rejected by reviewer[: reason]`.
    const writer = readFileSync("src/server/cascade-approvals.functions.ts", "utf8");
    expect(writer).toContain("summary: `Rejected by reviewer${");
    expect(REJECTION_SUMMARY_PREFIX).toBe("Rejected by reviewer");
    expect(isReviewerRejection("Rejected by reviewer")).toBe(true);
    expect(isReviewerRejection("Rejected by reviewer: wrong tenant")).toBe(true);
    expect(isReviewerRejection("Exhausted after 3 attempts")).toBe(false);
    expect(isReviewerRejection(null)).toBe(false);
  });

  it("recognises a folded event by the summary the fold composes, never a copy of it", () => {
    expect(supersededSummary(CARRIER_ID).startsWith(SUPERSEDED_SUMMARY_PREFIX)).toBe(true);
    expect(isSupersededSummary(supersededSummary(CARRIER_ID))).toBe(true);
    expect(isSupersededSummary("Completed: 4 clones")).toBe(false);
    expect(isSupersededSummary(null)).toBe(false);
  });

  it("dates a settled event by when its worker stopped, falling back to its last write", () => {
    expect(settledAt(event({ worker_finished_at: "a", completed_at: "b", updated_at: "c" }))).toBe(
      "a",
    );
    expect(settledAt(event({ worker_finished_at: null, completed_at: "b", updated_at: "c" }))).toBe(
      "b",
    );
    expect(
      settledAt(event({ worker_finished_at: null, completed_at: null, updated_at: "c" })),
    ).toBe("c");
  });
});

describe("findSupersedingCarrier", () => {
  const carrier = { id: CARRIER_ID, created_at: HOURS_AGO(12) };
  const other = { id: "aaaaaaaa-0000-4000-8000-000000000000", created_at: HOURS_AGO(11) };

  it("matches the carrier by recomposing the summary whole", () => {
    expect(findSupersedingCarrier(supersededSummary(CARRIER_ID), [other, carrier])).toEqual(
      carrier,
    );
  });

  it("names nothing for a summary that is not a fold's", () => {
    expect(findSupersedingCarrier("Completed", [carrier])).toBeNull();
    expect(findSupersedingCarrier(null, [carrier])).toBeNull();
  });

  it("names nothing when no candidate composes the same summary", () => {
    expect(findSupersedingCarrier(supersededSummary(CARRIER_ID), [other])).toBeNull();
  });

  it("takes the newest of two ids sharing an 8-character prefix", () => {
    const older = {
      id: `${CARRIER_ID.slice(0, 8)}-0000-4000-8000-000000000001`,
      created_at: HOURS_AGO(30),
    };
    expect(findSupersedingCarrier(supersededSummary(CARRIER_ID), [older, carrier])).toEqual(
      carrier,
    );
  });
});

describe("decideHeadRedelivery — what it redelivers", () => {
  it("redelivers a head whose own event failed automatically, as redelivery 1", () => {
    expect(decide()).toEqual({
      redeliver: true,
      cause: "head_failed",
      failedDeliveryId: HEAD_ID,
      mode: "pr",
      redelivery: 1,
    });
  });

  it("treats a partial head as owed: some clone it owed is still behind", () => {
    const v = decide({ head: event({ status: "partial" }) });
    expect(v.redeliver && v.cause).toBe("head_failed");
  });

  it("redelivers a head folded into a carrier that then failed, naming the carrier", () => {
    const v = decide({
      head: event({ status: "completed", summary: supersededSummary(CARRIER_ID) }),
      carrier: event({
        id: CARRIER_ID,
        status: "failed",
        summary: "Exhausted",
        mode: "auto_merge",
      }),
    });
    expect(v).toEqual({
      redeliver: true,
      cause: "carrier_failed",
      failedDeliveryId: CARRIER_ID,
      mode: "auto_merge",
      redelivery: 1,
    });
  });

  it("counts on from the audit log: the next redelivery is one past the last", () => {
    const v = decide({
      prior: { count: 2, lastAt: HOURS_AGO(3), lastEventId: REDELIVERY_ID },
      lastRedelivery: event({
        id: REDELIVERY_ID,
        status: "failed",
        worker_finished_at: HOURS_AGO(2),
      }),
    });
    expect(v.redeliver && v.redelivery).toBe(3);
  });
});

describe("decideHeadRedelivery — fail closed", () => {
  it("refuses when the redelivery count could not be read", () => {
    expect(refusal(decide({ prior: null }))).toMatch(/could not be read/);
  });

  it("refuses when the queue could not be read", () => {
    expect(refusal(decide({ liveDeliveries: null }))).toMatch(/queue could not be read/);
  });

  it("refuses when the carrier could not be read", () => {
    const why = refusal(
      decide({
        head: event({ status: "completed", summary: supersededSummary(CARRIER_ID) }),
        carrierUnreadable: true,
      }),
    );
    expect(why).toMatch(/carrier could not be read/);
  });

  it("refuses when the carrier a fold names cannot be found", () => {
    const why = refusal(
      decide({ head: event({ status: "completed", summary: supersededSummary(CARRIER_ID) }) }),
    );
    expect(why).toMatch(/could not be found/);
  });

  it("refuses when the last redelivery could not be read", () => {
    const why = refusal(
      decide({
        prior: { count: 1, lastAt: HOURS_AGO(3), lastEventId: REDELIVERY_ID },
        lastRedeliveryUnreadable: true,
      }),
    );
    expect(why).toMatch(/last redelivery could not be read/);
  });

  it("refuses a mode it cannot read rather than choosing how a tenant's code lands", () => {
    expect(refusal(decide({ head: event({ mode: "squash" }) }))).toMatch(/mode could not be read/);
  });

  it("refuses when no time on the failure is readable", () => {
    const why = refusal(
      decide({
        head: event({ worker_finished_at: null, completed_at: null, updated_at: "not a date" }),
      }),
    );
    expect(why).toMatch(/no readable time/);
  });
});

describe("decideHeadRedelivery — a delivery already owed is not minted twice", () => {
  it("stands down while any delivery is in the drain's hands", () => {
    expect(refusal(decide({ liveDeliveries: 1 }))).toMatch(
      /^a delivery is already in the drain's hands/,
    );
  });

  it("stands down while the head's own event is still queued or running", () => {
    expect(refusal(decide({ head: event({ status: "pending" }) }))).toMatch(/still in the queue/);
    expect(refusal(decide({ head: event({ status: "running" }) }))).toMatch(/still in the queue/);
  });

  it("stands down while the carrier is still queued", () => {
    const why = refusal(
      decide({
        head: event({ status: "completed", summary: supersededSummary(CARRIER_ID) }),
        carrier: event({ id: CARRIER_ID, status: "pending" }),
      }),
    );
    expect(why).toMatch(/carrier is still queued/);
  });

  it("says nothing for a head whose event delivered", () => {
    expect(refusal(decide({ head: event({ status: "completed", summary: "Completed" }) }))).toBe(
      "the head's event delivered",
    );
  });

  it("stands down for a carrier that completed — it read prime's head when it ran", () => {
    const why = refusal(
      decide({
        head: event({ status: "completed", summary: supersededSummary(CARRIER_ID) }),
        carrier: event({ id: CARRIER_ID, status: "completed", summary: "Completed" }),
      }),
    );
    expect(why).toMatch(/carrier completed/);
  });

  it("stands down while the last redelivery is in flight, and once it delivered", () => {
    const prior = { count: 1, lastAt: HOURS_AGO(3), lastEventId: REDELIVERY_ID };
    expect(
      refusal(decide({ prior, lastRedelivery: event({ id: REDELIVERY_ID, status: "running" }) })),
    ).toMatch(/still in the queue/);
    expect(
      refusal(decide({ prior, lastRedelivery: event({ id: REDELIVERY_ID, status: "completed" }) })),
    ).toMatch(/delivered prime's head/);
  });
});

describe("decideHeadRedelivery — a person's refusal is final", () => {
  it("never redelivers over a reviewer's rejection of the head", () => {
    const why = refusal(
      decide({ head: event({ summary: "Rejected by reviewer: not this week" }) }),
    );
    expect(why).toMatch(/reviewer rejected the head/);
  });

  it("never redelivers over a reviewer's rejection of the carrier", () => {
    const why = refusal(
      decide({
        head: event({ status: "completed", summary: supersededSummary(CARRIER_ID) }),
        carrier: event({ id: CARRIER_ID, status: "failed", summary: "Rejected by reviewer" }),
      }),
    );
    expect(why).toMatch(/reviewer rejected the carrier/);
  });

  it("never redelivers over a reviewer's rejection of a redelivery", () => {
    const why = refusal(
      decide({
        prior: { count: 1, lastAt: HOURS_AGO(3), lastEventId: REDELIVERY_ID },
        lastRedelivery: event({
          id: REDELIVERY_ID,
          status: "failed",
          summary: "Rejected by reviewer",
        }),
      }),
    );
    expect(why).toMatch(/rejected the last redelivery/);
  });

  it("leaves a head awaiting a second operator to them", () => {
    const why = refusal(
      decide({ head: event({ status: "failed", requires_approval: true, approved_at: null }) }),
    );
    expect(why).toMatch(/second operator/);
  });

  it("leaves a carrier awaiting a second operator to them", () => {
    const why = refusal(
      decide({
        head: event({ status: "completed", summary: supersededSummary(CARRIER_ID) }),
        carrier: event({
          id: CARRIER_ID,
          status: "failed",
          requires_approval: true,
          approved_at: null,
        }),
      }),
    );
    expect(why).toMatch(/second operator/);
  });

  it("redelivers a gated head a second operator approved and the counter then retired", () => {
    const v = decide({ head: event({ requires_approval: true, approved_at: HOURS_AGO(8) }) });
    expect(v.redeliver).toBe(true);
  });
});

describe("decideHeadRedelivery — bounded", () => {
  it("waits out the cooldown from the failure itself", () => {
    const fresh = event({
      worker_finished_at: new Date(NOW - HEAD_REDELIVERY_COOLDOWN_MS + 60_000).toISOString(),
    });
    expect(refusal(decide({ head: fresh }))).toMatch(/cooling down/);
    const stale = event({
      worker_finished_at: new Date(NOW - HEAD_REDELIVERY_COOLDOWN_MS - 60_000).toISOString(),
    });
    expect(decide({ head: stale }).redeliver).toBe(true);
  });

  it("waits out the cooldown from the last redelivery's minting and from its settling", () => {
    const recent = new Date(NOW - 30 * 60_000).toISOString();
    expect(
      refusal(
        decide({
          prior: { count: 1, lastAt: recent, lastEventId: REDELIVERY_ID },
          lastRedelivery: event({
            id: REDELIVERY_ID,
            status: "failed",
            worker_finished_at: HOURS_AGO(4),
          }),
        }),
      ),
    ).toMatch(/cooling down/);
    expect(
      refusal(
        decide({
          prior: { count: 1, lastAt: HOURS_AGO(4), lastEventId: REDELIVERY_ID },
          lastRedelivery: event({
            id: REDELIVERY_ID,
            status: "failed",
            worker_finished_at: recent,
          }),
        }),
      ),
    ).toMatch(/cooling down/);
  });

  it("counts a redelivery the audit names and the table does not hold", () => {
    // Deleted, or never armed: it delivered nothing, and the cooldown and
    // the ceiling still count it.
    const v = decide({
      prior: { count: 1, lastAt: HOURS_AGO(3), lastEventId: REDELIVERY_ID },
      lastRedelivery: null,
    });
    expect(v.redeliver && v.redelivery).toBe(2);
    expect(
      refusal(
        decide({
          prior: {
            count: 1,
            lastAt: new Date(NOW - 60_000).toISOString(),
            lastEventId: REDELIVERY_ID,
          },
          lastRedelivery: null,
        }),
      ),
    ).toMatch(/cooling down/);
  });

  it(`stops at ${HEAD_REDELIVERY_MAX} redeliveries — the failure is then an operator's`, () => {
    const why = refusal(
      decide({
        prior: { count: HEAD_REDELIVERY_MAX, lastAt: HOURS_AGO(30), lastEventId: REDELIVERY_ID },
        lastRedelivery: event({
          id: REDELIVERY_ID,
          status: "failed",
          worker_finished_at: HOURS_AGO(29),
        }),
      }),
    );
    expect(why).toMatch(/redelivered 3 times already/);
  });

  it("the cooldown is an hour and the ceiling three, as the header promises", () => {
    expect(HEAD_REDELIVERY_COOLDOWN_MS).toBe(3_600_000);
    expect(HEAD_REDELIVERY_MAX).toBe(3);
  });
});

describe("redeliveryEvent", () => {
  const minted = redeliveryEvent({
    headEventId: HEAD_ID,
    failedDeliveryId: CARRIER_ID,
    cause: "carrier_failed",
    mode: "pr",
    redelivery: 2,
    headSha: HEAD_SHA,
    sourceBranch: "main",
  });

  it("is a new, pending, ungated delivery nobody pressed", () => {
    expect(minted.status).toBe("pending");
    expect(minted.requires_approval).toBe(false);
    expect(minted.initiated_by).toBeNull();
    expect(minted.mode).toBe("pr");
    expect(minted.source_sha).toBe(HEAD_SHA);
    expect(minted.source_branch).toBe("main");
  });

  it("is never a commit event, so the unique SHA index the head holds is never raced", () => {
    expect(minted.trigger).toBe("scheduled");
  });

  it("names what it retries and which head it redelivers", () => {
    expect(minted.scope_filter).toEqual({
      scope: HEAD_REDELIVERY_SCOPE,
      retry_of: CARRIER_ID,
      redelivers_head_event: HEAD_ID,
      redelivery: 2,
    });
  });

  it("carries a scope filter the fold and the carrier refresh both refuse, and no module globs", () => {
    // Both are unscoped-commit-only; the engine reads only `module_globs`, so
    // the pass is the full tree at prime's head.
    expect(Object.keys(minted.scope_filter).length).toBeGreaterThan(0);
    expect("module_globs" in minted.scope_filter).toBe(false);
  });

  it("says what was owed and that the failed event is untouched", () => {
    expect(minted.summary).toBe(
      redeliverySummary({
        headEventId: HEAD_ID,
        failedDeliveryId: CARRIER_ID,
        cause: "carrier_failed",
        redelivery: 2,
        headSha: HEAD_SHA,
      }),
    );
    expect(minted.summary).toContain("Redelivery 2 of 3");
    expect(minted.summary).toContain("prime@9b5e472");
    expect(minted.summary).toContain("folded into cascade 211c4329");
    expect(minted.summary).toContain("The failed event is untouched");
  });

  it("does not read as a reviewer's rejection or a fold", () => {
    expect(isReviewerRejection(minted.summary)).toBe(false);
    expect(isSupersededSummary(minted.summary)).toBe(false);
  });
});

describe("two overlapping ticks mint one redelivery", () => {
  // The drain holds no lock. Two idle ticks can both read no live delivery
  // and the same prior count, so both decide the same redelivery. The event
  // id is what stops both minting: it is derived, so both name one row.
  const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("derives a name-based UUID exactly as RFC 9562 does", async () => {
    // RFC 9562's own example: the DNS namespace and "www.example.com".
    expect(await nameBasedUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
    await expect(nameBasedUuid("not-a-uuid", "x")).rejects.toThrow(/not a UUID namespace/);
  });

  it("names the same row for the same head and redelivery, in this namespace", async () => {
    const a = await redeliveryEventId(HEAD_ID, 1);
    expect(a).toBe(await redeliveryEventId(HEAD_ID, 1));
    expect(a).toMatch(V5);
    // Pinned: a build that derived it differently would not collide with
    // one that did not, and two ticks on two builds would both mint.
    expect(HEAD_REDELIVERY_ID_NAMESPACE).toBe("4b98edb5-2039-4c6c-b63c-ba17a08acf71");
    expect(a).toBe("089d6a53-e7a0-51d4-b0a1-344617629402");
  });

  it("names a different row for the next redelivery and for another head", async () => {
    const ids = await Promise.all([
      redeliveryEventId(HEAD_ID, 1),
      redeliveryEventId(HEAD_ID, 2),
      redeliveryEventId(HEAD_ID, 3),
      redeliveryEventId(CARRIER_ID, 1),
    ]);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(V5);
  });

  it("gives two ticks that read the same facts the same verdict and the same id", async () => {
    const [a, b] = [decide(), decide()];
    if (!a.redeliver || !b.redeliver) throw new Error("expected both ticks to redeliver");
    expect(await redeliveryEventId(HEAD_ID, a.redelivery)).toBe(
      await redeliveryEventId(HEAD_ID, b.redelivery),
    );
  });
});

describe("priorRedeliveriesFrom", () => {
  const row = (at: string, id: string | null, extra: Record<string, unknown> = {}) => ({
    created_at: at,
    metadata: id === null ? { ...extra } : { redelivery_event_id: id, ...extra },
  });

  it("counts nothing from no rows", () => {
    expect(priorRedeliveriesFrom([])).toEqual(NONE);
  });

  it("counts the loser's row of an overlapping mint as the same redelivery", () => {
    const prior = priorRedeliveriesFrom([
      row(HOURS_AGO(1), REDELIVERY_ID),
      row(HOURS_AGO(1.0001), REDELIVERY_ID),
    ]);
    expect(prior).toEqual({ count: 1, lastAt: HOURS_AGO(1), lastEventId: REDELIVERY_ID });
  });

  it("counts distinct redeliveries, and reads the newest row for the cooldown", () => {
    const prior = priorRedeliveriesFrom([
      row(HOURS_AGO(2), "b"),
      row(HOURS_AGO(3), "a"),
      row(HOURS_AGO(3.0001), "a"),
    ]);
    expect(prior).toEqual({ count: 2, lastAt: HOURS_AGO(2), lastEventId: "b" });
  });

  it("counts a row that names no id on its own, so it brings the ceiling nearer", () => {
    const prior = priorRedeliveriesFrom([
      row(HOURS_AGO(2), null),
      { created_at: HOURS_AGO(3), metadata: null },
      { created_at: HOURS_AGO(4), metadata: ["not", "an", "object"] },
      row(HOURS_AGO(5), ""),
      row(HOURS_AGO(6), "a"),
    ]);
    expect(prior.count).toBe(5);
    expect(prior.lastEventId).toBeNull();
    expect(prior.lastAt).toBe(HOURS_AGO(2));
  });

  it("reaches the ceiling at three distinct redeliveries, however many rows they wrote", () => {
    const prior = priorRedeliveriesFrom([
      row(HOURS_AGO(2), "c"),
      row(HOURS_AGO(2), "c"),
      row(HOURS_AGO(4), "b"),
      row(HOURS_AGO(6), "a"),
      row(HOURS_AGO(6), "a"),
    ]);
    expect(prior.count).toBe(HEAD_REDELIVERY_MAX);
    expect(refusal(decide({ prior }))).toMatch(/redelivered 3 times already/);
  });
});

describe("the drain's redelivery is wired the way the module promises", () => {
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
  const start = drain.indexOf("async function raiseDriftBeacon(");
  const beacon = drain.slice(start, drain.indexOf("async function redeliverHead(", start));
  const redeliver = drain.slice(
    drain.indexOf("async function redeliverHead("),
    drain.indexOf("async function drainOne("),
  );

  it("asks only when the head has an event, the read succeeded and nothing commit-shaped is claimable", () => {
    expect(beacon).toContain("headEventId = existing.failed ? null : existing.eventId;");
    expect(beacon).toMatch(
      /if \(headSha && headEventId && claimableCommitEvents === 0\) \{\s*return await redeliverHead\(/,
    );
  });

  it("counts every live delivery in three queries, never an interpolated filter", () => {
    // Comments may name the rule; only code is judged.
    const code = redeliver.replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain(".or(");
    expect(redeliver.match(/\{ count: "exact", head: true \}/g) ?? []).toHaveLength(3);
    expect(redeliver).toContain('.eq("status", "running")');
    expect(redeliver).toContain('.not("approved_at", "is", null)');
  });

  it("writes the counter BEFORE the event, and refuses when the counter cannot be written", () => {
    const counter = redeliver.indexOf('.from("audit_log").insert(');
    const minted = redeliver.indexOf('.from("cascade_events").insert(');
    expect(counter).toBeGreaterThan(-1);
    expect(minted).toBeGreaterThan(-1);
    expect(counter).toBeLessThan(minted);
    expect(redeliver).toMatch(/if \(countErr\) \{[\s\S]{0,300}return null;/);
    expect(redeliver).toContain("action: HEAD_REDELIVERY_AUDIT_ACTION,");
    expect(HEAD_REDELIVERY_AUDIT_ACTION).toBe("cascade.head_redelivered");
  });

  it("derives the event id, never draws it, and stops at a conflict before arming a clone", () => {
    expect(redeliver).not.toContain("randomUUID");
    expect(redeliver).toContain(
      "const newId = await redeliveryEventId(head.id, verdict.redelivery);",
    );
    const conflict = redeliver.indexOf('eventErr.code === "23505"');
    const armed = redeliver.indexOf('.from("cascade_results").insert(');
    expect(conflict).toBeGreaterThan(-1);
    expect(conflict).toBeLessThan(armed);
    expect(redeliver.slice(conflict, armed)).toMatch(/23505"\) \{[\s\S]{0,400}return null;/);
  });

  it("counts prior redeliveries by distinct id, through the module's own reader", () => {
    expect(redeliver).toContain("priorRedeliveriesFrom(audits ?? [])");
    expect(redeliver).not.toContain("rows.length");
  });

  it("counts from the same audit action it writes, keyed on the head", () => {
    expect(redeliver).toMatch(
      /\.eq\("action", HEAD_REDELIVERY_AUDIT_ACTION\)\s*\.eq\("entity_type", "cascade_event"\)\s*\.eq\("entity_id", head\.id\)/,
    );
  });

  it("arms a queued row for every clone, and closes an event left with none", () => {
    expect(redeliver).toContain('.from("clones").select("id")');
    expect(redeliver).toMatch(
      /cascade_event_id: newId,\s*clone_id: c\.id,\s*status: "queued" as const,/,
    );
    expect(redeliver).toMatch(/if \(rowsErr\) \{[\s\S]{0,700}status: "failed"/);
  });

  it("never takes the tick down", () => {
    expect(redeliver).toMatch(
      /\} catch \(e\) \{\s*console\.error\(\s*"\[cascade-drain\] head redelivery failed:"/,
    );
    // …and it is the function's last word: nothing after the catch can throw.
    expect(redeliver.trimEnd().endsWith("return null;\n  }\n}")).toBe(true);
  });
});
