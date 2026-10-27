/**
 * Every bulk mark, against a double that evaluates the filters it is handed,
 * asserted on which rows are still unread afterwards.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./testing/bookingFakes";
import { bulkMarkByIds, bulkMarkMatching } from "./notificationBulkRead.server";

const A = "e40b1d34-0000-4000-8000-000000000001";
const B = "282695be-0000-4000-8000-000000000002";

let db: FakeDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder this module uses
const client = () => db as any;

function notice(id: string, kind: string, over: Partial<Row> = {}): Row {
  return { id, kind, severity: "warning", clone_id: A, read_at: null, ...over };
}

beforeEach(() => {
  db = createFakeDb({
    notifications: [
      notice("drift-a", "drift_high"),
      notice("blocked-a", "cascade_blocked", { severity: "error" }),
      notice("completed-b", "cascade_completed", { clone_id: B, severity: "success" }),
      notice("remediation-b", "remediation_failed", { clone_id: B, severity: "error" }),
      notice("blocked-b", "cascade_blocked", { clone_id: B, severity: "error" }),
      notice("drift-read", "drift_high", { read_at: "2026-10-26T00:00:00Z" }),
    ],
  });
});

const unread = () =>
  (db.tables.notifications ?? [])
    .filter((n) => n.read_at === null)
    .map((n) => n.id)
    .sort();

describe("Mark page read, and the bell's Mark all read", () => {
  /* The acceptance line in DELIVERY_SYSTEM_PLAN.md W4. */
  it("leaves cascade_blocked unread even when its id is sent", async () => {
    const answer = await bulkMarkByIds(
      client(),
      ["drift-a", "blocked-a", "remediation-b", "blocked-b"],
      true,
    );
    expect(answer).toEqual({ ok: true, count: 2 });
    expect(unread()).toEqual(["blocked-a", "blocked-b", "completed-b"]);
  });

  it("never raises a cleared blocked notice again by marking it unread", async () => {
    db.tables.notifications.push(
      notice("blocked-cleared", "cascade_blocked", { read_at: "2026-10-26T00:00:00Z" }),
    );
    await bulkMarkByIds(client(), ["blocked-cleared", "drift-read"], false);
    expect(unread()).toContain("drift-read");
    expect(unread()).not.toContain("blocked-cleared");
  });

  it("reports a failed write as a failure", async () => {
    db.failWrites.add("notifications");
    expect(await bulkMarkByIds(client(), ["drift-a"], true)).toMatchObject({ ok: false });
    expect(unread()).toContain("drift-a");
  });
});

describe("Mark all matching", () => {
  /* The acceptance line in DELIVERY_SYSTEM_PLAN.md W4. */
  it("leaves cascade_blocked unread under Needs attention, and says how many it left", async () => {
    const answer = await bulkMarkMatching(client(), {
      kind: "all",
      severity: "all",
      clone: "all",
      scope: "attention",
    });
    expect(answer).toEqual({ ok: true, count: 2, leftUnread: 2 });
    // The record kind is not what the page was showing, so it is not touched either.
    expect(unread()).toEqual(["blocked-a", "blocked-b", "completed-b"]);
  });

  it("leaves cascade_blocked unread under Everything too", async () => {
    const answer = await bulkMarkMatching(client(), {
      kind: "all",
      severity: "all",
      clone: "all",
      scope: "everything",
    });
    expect(answer).toEqual({ ok: true, count: 3, leftUnread: 2 });
    expect(unread()).toEqual(["blocked-a", "blocked-b"]);
  });

  it("counts only the blocked notices the same filters match", async () => {
    const answer = await bulkMarkMatching(client(), {
      kind: "all",
      severity: "error",
      clone: B,
      scope: "attention",
    });
    expect(answer).toEqual({ ok: true, count: 1, leftUnread: 1 });
    expect(unread()).toEqual(["blocked-a", "blocked-b", "completed-b", "drift-a"]);
  });

  it("refuses outright when the chosen kind is cascade_blocked, and writes nothing", async () => {
    const answer = await bulkMarkMatching(client(), {
      kind: "cascade_blocked",
      severity: "all",
      clone: "all",
      scope: "attention",
    });
    expect(answer.ok).toBe(false);
    expect(unread()).toHaveLength(5);
  });

  it("marks only the kind chosen when one is chosen", async () => {
    const answer = await bulkMarkMatching(client(), {
      kind: "drift_high",
      severity: "all",
      clone: "all",
      scope: "attention",
    });
    expect(answer).toEqual({ ok: true, count: 1, leftUnread: 0 });
    expect(unread()).not.toContain("drift-a");
  });

  /* A count that failed is unknown, never zero. */
  it("says it does not know how many it left when the count fails", async () => {
    db.failReads.add("notifications");
    const answer = await bulkMarkMatching(client(), {
      kind: "all",
      severity: "all",
      clone: "all",
      scope: "everything",
    });
    expect(answer).toEqual({ ok: true, count: 3, leftUnread: null });
  });
});
