import { describe, expect, it } from "vitest";
import {
  PRIME_WORKSPACE_LABEL,
  WORKSPACE_REPLY_KIND,
  replyNotificationOf,
  workspaceReplyAlertOf,
} from "./workspaceReplyAlert.pure";
import { PRIME_WORKSPACE_ID } from "./cloneAnnouncements.pure";

const CLONE = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";

const facts = (extra = {}) => ({
  announcementId: "ann-1",
  messageTitle: "Going live",
  workspaceId: CLONE,
  cloneName: "NPC Client Dashboard",
  businessName: "Preflight Property Group",
  authorName: "Rugesh Naidu",
  body: "Thanks — we are ready.",
  ...extra,
});

/** The notification row the server writes, as Realtime hands it back. */
const rowOf = (n: ReturnType<typeof replyNotificationOf>, id = "n-1") => ({
  id,
  kind: WORKSPACE_REPLY_KIND,
  title: n.title,
  body: n.body,
  url: n.url,
  created_at: "2026-10-28T10:00:00.000Z",
  metadata: n.metadata,
});

describe("the notification a workspace reply writes", () => {
  it("names the business and the workspace, who wrote, and on what", () => {
    const n = replyNotificationOf(facts());
    expect(n.title).toBe("New reply from Preflight Property Group (NPC Client Dashboard)");
    expect(n.body).toBe("Rugesh Naidu on “Going live”: Thanks — we are ready.");
    expect(n.url).toBe(`/announcements?thread=ann-1&workspace=${CLONE}`);
    expect(n.metadata).toMatchObject({
      v: 1,
      workspace_id: CLONE,
      workspace_name: "NPC Client Dashboard",
      business_name: "Preflight Property Group",
      author_name: "Rugesh Naidu",
      message_title: "Going live",
    });
  });

  it("calls the prime the Prime workspace", () => {
    const n = replyNotificationOf(
      facts({
        workspaceId: PRIME_WORKSPACE_ID,
        cloneName: null,
        businessName: "Naidu Property Consulting Services",
      }),
    );
    expect(n.title).toBe(
      `New reply from Naidu Property Consulting Services (${PRIME_WORKSPACE_LABEL})`,
    );
    expect(n.metadata.workspace_name).toBe(PRIME_WORKSPACE_LABEL);
  });

  it("names the workspace alone where its server named no business", () => {
    const n = replyNotificationOf(facts({ businessName: null }));
    expect(n.title).toBe("New reply from NPC Client Dashboard");
    expect(n.metadata.business_name).toBeNull();
  });

  it("does not repeat a business that is the workspace's own name", () => {
    expect(replyNotificationOf(facts({ businessName: "NPC Client Dashboard" })).title).toBe(
      "New reply from NPC Client Dashboard",
    );
  });

  it("cuts a long reply to an excerpt, and folds its whitespace", () => {
    const n = replyNotificationOf(facts({ body: `Line one\n\n${"word ".repeat(80)}` }));
    expect(String(n.metadata.excerpt).length).toBeLessThanOrEqual(160);
    expect(String(n.metadata.excerpt)).toMatch(/^Line one word/);
    expect(String(n.metadata.excerpt).endsWith("…")).toBe(true);
  });
});

describe("the alert every surface draws", () => {
  it("reads back exactly what the server wrote", () => {
    const alert = workspaceReplyAlertOf(rowOf(replyNotificationOf(facts())));
    expect(alert).toEqual({
      id: "n-1",
      business: "Preflight Property Group",
      workspace: "NPC Client Dashboard",
      isPrime: false,
      author: "Rugesh Naidu",
      excerpt: "Thanks — we are ready.",
      messageTitle: "Going live",
      href: `/announcements?thread=ann-1&workspace=${CLONE}`,
      createdAt: "2026-10-28T10:00:00.000Z",
    });
  });

  it("falls back to the workspace where no business was named", () => {
    const alert = workspaceReplyAlertOf(rowOf(replyNotificationOf(facts({ businessName: null }))));
    expect(alert?.business).toBe("NPC Client Dashboard");
  });

  it("knows the prime", () => {
    const alert = workspaceReplyAlertOf(
      rowOf(replyNotificationOf(facts({ workspaceId: PRIME_WORKSPACE_ID, cloneName: null }))),
    );
    expect(alert?.isPrime).toBe(true);
    expect(alert?.workspace).toBe(PRIME_WORKSPACE_LABEL);
  });

  it("still reads a row written before the metadata carried names", () => {
    const alert = workspaceReplyAlertOf({
      id: "old",
      kind: WORKSPACE_REPLY_KIND,
      title: "Reply from the prime: Going live",
      body: "Rugesh Naidu wrote: hello",
      url: "/announcements?thread=a&workspace=b",
      created_at: "2026-10-27T10:00:00.000Z",
      metadata: { announcement_id: "a", workspace_id: PRIME_WORKSPACE_ID },
    });
    expect(alert).toMatchObject({
      business: "Reply from the prime: Going live",
      excerpt: "Rugesh Naidu wrote: hello",
      isPrime: true,
    });
  });

  it("is nothing for any other kind", () => {
    expect(
      workspaceReplyAlertOf({
        id: "x",
        kind: "cascade_completed",
        title: "t",
        body: null,
        url: null,
        created_at: "2026-10-28T10:00:00.000Z",
        metadata: {},
      }),
    ).toBeNull();
  });
});
