import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALL_NOTIFICATION_KINDS,
  INBOX_KINDS,
  NOTIFICATION_RECORD_KINDS,
  RECORD_KINDS_FILTER,
  isInboxKind,
  type NotificationKind,
} from "./notificationDisposition";

describe("a notification is for something that needs a person", () => {
  /*
    The four largest successes in the channel on 18 Sep 2026. Together with
    drift_high (which step 3 retires) they were 79% of 2,459 unread rows.
  */
  it("keeps the measured successes out of the inbox", () => {
    for (const kind of [
      "cascade_completed",
      "deployment_live",
      "module_installed",
      "clone_created",
    ] as NotificationKind[]) {
      expect(isInboxKind(kind), `${kind} is a success and belongs in the record`).toBe(false);
    }
  });

  /*
    The one the whole design turns on. `cascade_blocked` means "this will fail
    for ever until a person acts" and it arrives in the same channel; if it
    ever left the inbox, the September freeze would be silent again.
  */
  it("keeps every actionable kind in the inbox", () => {
    for (const kind of [
      "cascade_blocked",
      "cascade_failed",
      "cascade_partial",
      "cascade_awaiting_approval",
      "deployment_failed",
      "deployment_build_failed",
      "tokens_alert",
      "remediation_awaiting_validation",
      "remediation_failed",
      "migration_drift",
      "seat_limit_reached",
      "device_limit_reached",
      "api_usage_settlement_failed",
      "github_app_access_drift",
      "security_finding_created",
      "support_ticket_escalated",
      "crm_sla_breach",
      "clone_gate_locked",
    ] as NotificationKind[]) {
      expect(isInboxKind(kind), `${kind} needs a person and must stay in the inbox`).toBe(true);
    }
  });

  /*
    Under-notifying is the worse error. A kind added next year appears in the
    inbox until somebody deliberately classifies it, rather than being
    swallowed by a list nobody remembered to update.
  */
  it("treats an unknown kind as inbox", () => {
    expect(isInboxKind("a_kind_nobody_has_classified_yet" as NotificationKind)).toBe(true);
  });

  it("derives the inbox list from the database enum rather than a second list", () => {
    expect(ALL_NOTIFICATION_KINDS.length).toBeGreaterThan(60);
    expect(INBOX_KINDS.length).toBe(ALL_NOTIFICATION_KINDS.length - NOTIFICATION_RECORD_KINDS.size);
    for (const kind of INBOX_KINDS) expect(NOTIFICATION_RECORD_KINDS.has(kind)).toBe(false);
  });

  it("every record kind is a real kind", () => {
    for (const kind of NOTIFICATION_RECORD_KINDS) {
      expect(ALL_NOTIFICATION_KINDS, `${kind} is not in the enum`).toContain(kind);
    }
  });

  /*
    A guard against a careless future addition. Nothing whose NAME says
    something went wrong, is waiting, or is running out may be filed as a
    record — whatever anybody's reasoning was at the time.
  */
  it("refuses to file anything that reads like a problem as a record", () => {
    /* `(?<!un)lock` on purpose: `clone_gate_unlocked` is the success — the
       payment landed and the workspace opened — while `clone_gate_locked` is
       the one a person is owed. A guard that cannot tell them apart would have
       to be weakened, and a weakened guard stops guarding. */
    const forbidden =
      /(fail|error|blocked|breach|reached|approaching|drift|missed|escalat|declin|flag|pending|alert|await|reject|delet|(?<!un)lock|expir)/i;
    for (const kind of NOTIFICATION_RECORD_KINDS) {
      expect(forbidden.test(kind), `${kind} reads like something a person is owed`).toBe(false);
    }
  });

  /*
    The inbox must stay a majority of the vocabulary. If a future edit filed
    most kinds as records, the channel would go quiet for the wrong reason —
    which is the failure this replaces, arriving from the other direction.
  */
  it("keeps most of the vocabulary in the inbox", () => {
    expect(NOTIFICATION_RECORD_KINDS.size).toBeLessThan(ALL_NOTIFICATION_KINDS.length / 2);
  });
});

describe("nothing stopped being written, and the record stays reachable", () => {
  const bell = readFileSync("src/components/notifications-bell.tsx", "utf8");
  const page = readFileSync("src/routes/notifications.tsx", "utf8");
  const activity = readFileSync("src/components/clone-activity-history.tsx", "utf8");
  const disposition = readFileSync("src/lib/notificationDisposition.ts", "utf8");

  /*
    The trap this had to avoid. `CloneActivityHistory` reads the notifications
    table as a clone's activity feed, so suppressing the WRITE would have
    deleted the history along with the noise — removing a notice must never
    remove a control.
  */
  it("the clone activity feed still reads every kind", () => {
    expect(activity).toContain('from("notifications")');
    expect(activity.includes("INBOX_KINDS")).toBe(false);
    expect(activity.includes("isInboxKind")).toBe(false);
  });

  it("the bell filters both its query and its live inserts", () => {
    expect(bell).toContain("RECORD_KINDS_FILTER");
    expect(bell).toContain("isInboxKind");
  });

  /*
    THE QUERY IS A NEGATION, AND THAT IS THE POINT.

    `Constants` is generated from the database by hand and goes stale. A kind
    added there and not yet regenerated here is missing from `INBOX_KINDS`, so
    an `IN` filter would drop it out of the inbox — the exact failure this
    module exists to prevent, arriving through the query instead of the list.
    `NOT IN` cannot do that: an unclassified kind matches nothing on the record
    list and appears in the inbox, which is where it belongs.
  */
  it("asks for everything EXCEPT the record, never for a list of the inbox", () => {
    for (const [name, source] of [
      ["bell", bell],
      ["page", page],
    ] as const) {
      expect(source, `${name} must not filter by an enumerated inbox list`).not.toMatch(
        /\.in\(\s*"kind"\s*,/,
      );
      expect(source, `${name} must negate the record list`).toContain(
        '.not("kind", "in", RECORD_KINDS_FILTER)',
      );
    }
  });

  it("the filter is a PostgREST group of exactly the record kinds", () => {
    expect(RECORD_KINDS_FILTER.startsWith("(")).toBe(true);
    expect(RECORD_KINDS_FILTER.endsWith(")")).toBe(true);
    const listed = RECORD_KINDS_FILTER.slice(1, -1).split(",");
    expect(listed.sort()).toEqual([...NOTIFICATION_RECORD_KINDS].sort());
    /* No value may need quoting, or the group would have to be escaped. */
    for (const k of listed) expect(k).toMatch(/^[a-z_]+$/);
  });

  it("the page defaults to attention and can still show everything", () => {
    expect(page).toContain('"attention"');
    expect(page).toContain('"everything"');
    expect(page).toContain("RECORD_KINDS_FILTER");
  });

  /*
    An operator who explicitly picks "Cascade completed" has asked for records.
    Handing them an empty list because of a default scope reads as a broken
    page.
  */
  it("an explicitly chosen kind outranks the scope", () => {
    expect(page).toMatch(
      /if \(search\.kind !== "all"\)[\s\S]{0,400}?else if \(search\.scope === "attention"\)/,
    );
  });

  /*
    The bulk mark is the one control on that page that writes, and its
    confirmation promises "matching the current filters". A default scope that
    did not count as a filter would make that promise false while silently
    excluding 983 rows.
  */
  it("counts the default scope as a filter, so the bulk confirmation is honest", () => {
    expect(page).toContain('search.scope !== "everything"');
    expect(page).toMatch(/filterSummary\([\s\S]{0,400}?scope: string/);
  });

  it("no disposition filter reaches an insert", () => {
    expect(/\.insert\([\s\S]{0,200}?RECORD_KINDS_FILTER/.test(page)).toBe(false);
    expect(/\.insert\([\s\S]{0,200}?RECORD_KINDS_FILTER/.test(bell)).toBe(false);
  });

  /*
    Disposition is a product decision about what the inbox is for;
    `notification_preferences` is a per-person mute over toasts. Conflating
    them would make a product decision look like somebody's setting.
  */
  it("is not a second preferences system", () => {
    /* It may NAME the preferences table to say the two are different things;
       what it must never do is read or write it. Disposition decides what may
       ever reach the inbox, a preference decides which of those a given person
       wants to see, and one implementing the other is how a product decision
       comes to look like somebody's setting. */
    expect(disposition.includes('from("notification_preferences")')).toBe(false);
    expect(disposition.includes("useNotificationPreferences")).toBe(false);
    expect(disposition.includes("isMuted")).toBe(false);
    expect(disposition).toContain("orthogonal to `notification_preferences`");
  });
});
