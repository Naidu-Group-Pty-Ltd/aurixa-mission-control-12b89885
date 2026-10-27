/**
 * The reads, the writes and every refusal, asserted on what the double HOLDS
 * afterwards rather than on the answer alone: the whole risk in a control that
 * fires at clones is that a refusal still wrote something, or that an answer
 * said one clone while the rows said four.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb, jsonOf, type FakeDb, type Row } from "../testing/bookingFakes";
import { fireOperatorCascade, spawnOperatorCascade } from "./operatorCascade.server";

const USER = "a1a1a1a1-0000-4000-8000-0000000000aa";
const NCD = "e40b1d34-0000-4000-8000-000000000001";
const CRM = "282695be-0000-4000-8000-000000000002";
const PRE = "7c1e0f00-0000-4000-8000-000000000003";
const TST = "76b3b300-0000-4000-8000-000000000004";
const PARENT = "15d4574f-0000-4000-8000-0000000000f1";

let db: FakeDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder these modules use
const client = () => db as any;

function fleet(): Row[] {
  return [
    {
      id: NCD,
      name: "NPC Client Dashboard",
      tags: ["crm", "au"],
      created_at: "2026-09-04T00:00:00Z",
    },
    { id: CRM, name: "NPC CRM Independent", tags: ["crm"], created_at: "2026-09-03T00:00:00Z" },
    { id: PRE, name: "Preflight Property Group", tags: ["au"], created_at: "2026-09-02T00:00:00Z" },
    { id: TST, name: "NPC Test", tags: null, created_at: "2026-09-01T00:00:00Z" },
  ];
}

beforeEach(() => {
  db = createFakeDb({ clones: fleet(), cascade_events: [], cascade_results: [] });
});

const events = () => db.tables.cascade_events ?? [];
const results = () => db.tables.cascade_results ?? [];
const notices = () => db.tables.notifications ?? [];

/** Exactly what `/hooks/cascade-drain` claims once the arming grace has passed. */
function expectDrainShape(ev: Row) {
  expect(ev.trigger).toBe("manual");
  expect(ev.status).toBe("pending");
  expect(ev.worker_started_at ?? null).toBeNull();
  expect(ev.completed_at ?? null).toBeNull();
  expect(ev.initiated_by).toBe(USER);
  // The one key the engine reads from the scope; a person's cascade never scopes files.
  expect("module_globs" in jsonOf(ev.scope_filter)).toBe(false);
  // Armed: at least one queued row, every row queued.
  const rows = results().filter((r) => r.cascade_event_id === ev.id);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.status).toBe("queued");
}

describe("firing from /cascades", () => {
  /* The acceptance line in DELIVERY_SYSTEM_PLAN.md W4. */
  it("firing at one picked clone inserts exactly one cascade_results row", async () => {
    const answer = await fireOperatorCascade(client(), {
      userId: USER,
      mode: "pr",
      scope: "selected",
      tags: [],
      cloneIds: [PRE],
      confirmedCount: 1,
    });

    expect(answer).toMatchObject({ ok: true, cloneCount: 1, awaitingApproval: false });
    expect(events()).toHaveLength(1);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ clone_id: PRE, status: "queued" });
    expect(jsonOf(events()[0].scope_filter)).toEqual({ scope: "selected", clone_ids: [PRE] });
    expectDrainShape(events()[0]);
  });

  it("By tag arms only the clones carrying a chosen tag", async () => {
    const answer = await fireOperatorCascade(client(), {
      userId: USER,
      mode: "pr",
      scope: "tagged",
      tags: ["au"],
      cloneIds: [],
      confirmedCount: 2,
    });
    expect(answer.ok).toBe(true);
    expect(results().map((r) => r.clone_id)).toEqual([NCD, PRE]);
    expect(jsonOf(events()[0].scope_filter)).toEqual({
      scope: "tagged",
      tags: ["au"],
      clone_ids: [NCD, PRE],
    });
  });

  it("All clones still arms every clone", async () => {
    const answer = await fireOperatorCascade(client(), {
      userId: USER,
      mode: "pr",
      scope: "all",
      tags: [],
      cloneIds: [],
      confirmedCount: 4,
    });
    expect(answer.ok).toBe(true);
    expect(results().map((r) => r.clone_id)).toEqual([NCD, CRM, PRE, TST]);
    expect(jsonOf(events()[0].scope_filter)).toEqual({ scope: "all" });
  });

  /*
    The defect. An empty selection under a narrowing scope reached the whole
    fleet; the server must refuse it whatever the page sent, and write nothing.
  */
  it("refuses an empty Manual select or By tag, and writes nothing", async () => {
    for (const scope of ["selected", "tagged"] as const) {
      const answer = await fireOperatorCascade(client(), {
        userId: USER,
        mode: "auto_merge",
        scope,
        tags: [],
        cloneIds: [],
        confirmedCount: 4,
      });
      expect(answer.ok, scope).toBe(false);
    }
    expect(events()).toHaveLength(0);
    expect(results()).toHaveLength(0);
  });

  it("refuses when the fleet no longer numbers what the operator confirmed", async () => {
    const answer = await fireOperatorCascade(client(), {
      userId: USER,
      mode: "pr",
      scope: "tagged",
      tags: ["crm"],
      cloneIds: [],
      confirmedCount: 1,
    });
    expect(answer.ok).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it("reads a fleet it could not read as a refusal, never as an empty fleet", async () => {
    db.failReads.add("clones");
    const answer = await fireOperatorCascade(client(), {
      userId: USER,
      mode: "pr",
      scope: "all",
      tags: [],
      cloneIds: [],
      confirmedCount: 4,
    });
    expect(answer).toMatchObject({ ok: false });
    if (!answer.ok) expect(answer.error).toMatch(/Could not read the fleet/);
    expect(events()).toHaveLength(0);
  });

  it("holds a wide auto-merge for a second operator and asks for one", async () => {
    const answer = await fireOperatorCascade(client(), {
      userId: USER,
      mode: "auto_merge",
      scope: "all",
      tags: [],
      cloneIds: [],
      confirmedCount: 4,
    });
    expect(answer).toMatchObject({ ok: true, awaitingApproval: true, cloneCount: 4 });
    const ev = events()[0];
    expect(ev.requires_approval).toBe(true);
    expect(results()).toHaveLength(4);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      kind: "cascade_awaiting_approval",
      cascade_event_id: ev.id,
    });
    expect(db.tables.audit_log?.[0]).toMatchObject({
      action: "cascade.awaiting_approval",
      entity_id: ev.id,
      actor_user_id: USER,
    });
  });

  it("settles an event whose rows could not be armed instead of leaving it pending", async () => {
    db.failWrites.add("cascade_results");
    const answer = await fireOperatorCascade(client(), {
      userId: USER,
      mode: "pr",
      scope: "selected",
      tags: [],
      cloneIds: [NCD],
      confirmedCount: 1,
    });
    expect(answer.ok).toBe(false);
    expect(events()).toHaveLength(1);
    expect(events()[0].status).toBe("failed");
    expect(String(events()[0].summary)).toMatch(/^Not started: its clones could not be queued/);
  });
});

describe("Cascade now", () => {
  /* The acceptance line in DELIVERY_SYSTEM_PLAN.md W4. */
  it("creates one event for that clone, armed for it alone", async () => {
    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "redeliver", mode: "pr", cloneId: CRM },
    });

    expect(answer).toMatchObject({ ok: true, cloneCount: 1, awaitingApproval: false });
    expect(events()).toHaveLength(1);
    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ clone_id: CRM, status: "queued" });
    expect(jsonOf(events()[0].scope_filter)).toEqual({
      scope: "selected",
      clone_ids: [CRM],
      origin: "clone_page",
    });
    expect(String(events()[0].summary)).toContain("NPC CRM Independent");
    expectDrainShape(events()[0]);
  });

  it("refuses while a delivery to the clone is in flight, names it, and writes nothing", async () => {
    db.tables.cascade_events.push({ id: PARENT, status: "pending", mode: "auto_merge" });
    db.tables.cascade_results.push({ cascade_event_id: PARENT, clone_id: CRM, status: "queued" });

    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "redeliver", mode: "pr", cloneId: CRM },
    });

    expect(answer).toMatchObject({ ok: false, liveEventId: PARENT });
    expect(events()).toHaveLength(1);
    expect(results()).toHaveLength(1);
  });

  it("is not held back by a row stranded under a settled event", async () => {
    db.tables.cascade_events.push({ id: PARENT, status: "completed", mode: "auto_merge" });
    db.tables.cascade_results.push({ cascade_event_id: PARENT, clone_id: CRM, status: "queued" });

    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "redeliver", mode: "pr", cloneId: CRM },
    });
    expect(answer.ok).toBe(true);
  });

  it("is not held back by another clone's delivery", async () => {
    db.tables.cascade_events.push({ id: PARENT, status: "running", mode: "auto_merge" });
    db.tables.cascade_results.push({ cascade_event_id: PARENT, clone_id: NCD, status: "pushing" });

    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "redeliver", mode: "pr", cloneId: CRM },
    });
    expect(answer.ok).toBe(true);
  });

  it("refuses when it cannot read the queue, rather than minting beside an unseen delivery", async () => {
    db.failReads.add("cascade_events");
    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "redeliver", mode: "pr", cloneId: CRM },
    });
    expect(answer.ok).toBe(false);
    expect(results()).toHaveLength(0);
  });
});

describe("retry and rollback from the cascade detail page", () => {
  it("retries one clone of a settled cascade, naming it", async () => {
    db.tables.cascade_events.push({ id: PARENT, status: "partial", mode: "auto_merge" });
    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "retry", mode: "pr", of: PARENT, cloneId: NCD },
    });
    expect(answer.ok).toBe(true);
    const ev = events().find((e) => e.id !== PARENT)!;
    expect(ev.mode).toBe("pr");
    expect(jsonOf(ev.scope_filter)).toEqual({
      scope: "selected",
      clone_ids: [NCD],
      retry_of: PARENT,
    });
    expectDrainShape(ev);
  });

  it("refuses to retry while the parent is still running", async () => {
    db.tables.cascade_events.push({ id: PARENT, status: "running", mode: "pr" });
    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "retry", mode: "pr", of: PARENT, cloneId: NCD },
    });
    expect(answer.ok).toBe(false);
    expect(events()).toHaveLength(1);
  });

  /*
    The detail page's spawn never asked the gate. One authority asks it of
    every cascade a person starts, so a rollback wide enough to cross a
    threshold waits for a second operator as the same reach fired from
    /cascades does.
  */
  it("holds a rollback across more clones than the gate allows", async () => {
    const wide = Array.from({ length: 11 }, (_, i) => ({
      id: `0000000${i.toString(16)}-0000-4000-8000-0000000000${(16 + i).toString(16)}`,
      name: `Clone ${i}`,
      tags: null,
    }));
    db = createFakeDb({
      clones: wide,
      cascade_events: [{ id: PARENT, status: "completed", mode: "pr" }],
      cascade_results: [],
    });
    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "rollback", mode: "pr", of: PARENT, cloneIds: wide.map((c) => c.id) },
    });
    expect(answer).toMatchObject({ ok: true, awaitingApproval: true, cloneCount: 11 });
    const ev = events().find((e) => e.id !== PARENT)!;
    expect(ev.requires_approval).toBe(true);
    expect(jsonOf(ev.scope_filter)).toMatchObject({ rollback_of: PARENT, source_mode: "pr" });
  });

  it("runs a one-clone retry without the gate, as it always ran", async () => {
    db.tables.cascade_events.push({ id: PARENT, status: "completed", mode: "auto_merge" });
    const answer = await spawnOperatorCascade(client(), {
      userId: USER,
      request: { intent: "retry", mode: "auto_merge", of: PARENT, cloneId: NCD },
    });
    expect(answer).toMatchObject({ ok: true, awaitingApproval: false });
    expect(notices()).toHaveLength(0);
  });
});
