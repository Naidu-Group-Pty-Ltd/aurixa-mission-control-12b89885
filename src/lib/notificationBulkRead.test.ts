import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_NOTIFICATION_KINDS, isInboxKind } from "./notificationDisposition";
import {
  BULK_READ_EXEMPT_KINDS,
  describeLeftUnread,
  mayBulkMarkRead,
  planMarkMatching,
} from "./notificationBulkRead.pure";

describe("no bulk mark changes a blocked-cascade notice", () => {
  /*
    The blockage ledger reads every unread `cascade_blocked` as a standing CI
    refusal. A bulk mark that cleared one would change a clone's `ci_red`
    while its pull request stayed exactly as it was.
  */
  it("exempts cascade_blocked", () => {
    expect(mayBulkMarkRead("cascade_blocked")).toBe(false);
    expect(BULK_READ_EXEMPT_KINDS.has("cascade_blocked")).toBe(true);
  });

  it("lets every other kind be marked in bulk", () => {
    for (const kind of ALL_NOTIFICATION_KINDS) {
      if (kind === "cascade_blocked") continue;
      expect(mayBulkMarkRead(kind), kind).toBe(true);
    }
  });

  it("exempts only real kinds, and only kinds the inbox shows", () => {
    for (const kind of BULK_READ_EXEMPT_KINDS) {
      expect(ALL_NOTIFICATION_KINDS).toContain(kind);
      expect(isInboxKind(kind), kind).toBe(true);
    }
  });

  it("says in one sentence why one was left", () => {
    expect(describeLeftUnread(1)).toBe(
      "1 blocked-cascade notice was left unread: it clears itself when its pull request closes.",
    );
    expect(describeLeftUnread(3)).toMatch(/^3 blocked-cascade notices were left unread: /);
  });
});

describe("Mark all matching", () => {
  it("refuses outright when the chosen kind is exempt", () => {
    const plan = planMarkMatching({
      kind: "cascade_blocked",
      severity: "all",
      clone: "all",
      scope: "attention",
    });
    expect(plan.act).toBe(false);
  });

  /* The same rule the page's list query follows. */
  it("lets a chosen kind outrank the scope", () => {
    const plan = planMarkMatching({
      kind: "cascade_completed",
      severity: "all",
      clone: "all",
      scope: "attention",
    });
    expect(plan).toMatchObject({ act: true, kind: "cascade_completed", excludeRecordKinds: false });
  });

  it("matches what Needs attention shows when no kind is chosen", () => {
    const plan = planMarkMatching({
      kind: "all",
      severity: "error",
      clone: "e40b1d34-0000-4000-8000-000000000001",
      scope: "attention",
    });
    expect(plan).toEqual({
      act: true,
      kind: null,
      excludeRecordKinds: true,
      severity: "error",
      cloneId: "e40b1d34-0000-4000-8000-000000000001",
      exempt: ["cascade_blocked"],
      leftUnread: ["cascade_blocked"],
    });
  });

  it("always excludes the exempt kinds from the write", () => {
    const plan = planMarkMatching({
      kind: "drift_high",
      severity: "all",
      clone: "all",
      scope: "everything",
    });
    expect(plan.act && plan.exempt).toEqual(["cascade_blocked"]);
    // A chosen kind cannot have matched a blocked notice, so none is counted.
    expect(plan.act && plan.leftUnread).toEqual([]);
  });
});

/*
  The pages wrote `read_at` in bulk straight from the browser, where nothing
  on the server could apply the rule. Every bulk mark goes through
  `bulk-ops.functions.ts` now; only opening ONE notice writes from the page.
*/
describe("the pages mark in bulk only through the server", () => {
  const page = readFileSync("src/routes/notifications.tsx", "utf8");
  const bell = readFileSync("src/components/notifications-bell.tsx", "utf8");
  const ops = readFileSync("src/server/bulk-ops.functions.ts", "utf8");

  it("writes read_at from the browser for one notice at a time only", () => {
    for (const [name, source] of [
      ["page", page],
      ["bell", bell],
    ] as const) {
      const writes = source.match(/\.update\(\{\s*read_at[^}]*\}\)\s*\.[a-z]+\(/g) ?? [];
      for (const w of writes) expect(w, `${name}: ${w}`).toMatch(/\.eq\($/);
    }
  });

  it("routes the page's bulk marks and the bell's through the server functions", () => {
    expect(page).toContain("bulkMarkNotificationsRead");
    expect(page).toContain("markAllMatchingNotificationsRead");
    expect(bell).toContain("bulkMarkNotificationsRead");
    expect(page).toContain("mayBulkMarkRead");
    expect(bell).toContain("mayBulkMarkRead");
  });

  it("applies the rule on the server, not only in the pages", () => {
    expect(ops).toMatch(/bulkMarkNotificationsRead[\s\S]*?bulkMarkByIds\(/);
    expect(ops).toMatch(/markAllMatchingNotificationsRead[\s\S]*?bulkMarkMatching\(/);
  });

  it("tells the operator why blocked notices are left", () => {
    expect(page).toContain("BULK_READ_EXEMPT_NOTE");
    expect(bell).toContain("BULK_READ_EXEMPT_NOTE");
  });
});
