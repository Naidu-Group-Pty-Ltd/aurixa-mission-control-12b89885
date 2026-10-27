// Workspace messages, Mission Control's side, run against a fake Supabase
// that applies the queries' filters and the two unique indexes the migration
// creates — so "sent twice" and "a retry finds the first reply" are checked
// against the database's own rule, not a test that invents its error.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  audits: [] as string[],
  notices: [] as Array<{
    kind: string;
    title: string;
    cloneId?: string | null;
    url?: string | null;
  }>,
  seq: 0,
}));

/** The unique indexes of 20261027120100_workspace_message_replies.sql. */
const UNIQUE: Record<string, string[][]> = {
  clone_announcements: [["client_request_id"]],
  clone_announcement_replies: [["workspace_id", "client_request_id"]],
  clone_announcement_deliveries: [["announcement_id", "clone_id"]],
};

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let values: Row | Row[] | undefined;
    let order: { column: string; ascending: boolean } | null = null;
    const rowsOf = () => (h.tables[table] ??= []);
    const result = (): { data: unknown; error: { message: string; code?: string } | null } => {
      if (h.failing.has(`${table}:${op}`)) {
        return { data: null, error: { message: `${table} ${op} failed` } };
      }
      if (op === "insert") {
        const incoming = Array.isArray(values) ? values : [values as Row];
        const made: Row[] = [];
        for (const v of incoming) {
          for (const cols of UNIQUE[table] ?? []) {
            if (cols.some((c) => v[c] === null || v[c] === undefined)) continue;
            if (rowsOf().some((r) => cols.every((c) => r[c] === v[c]))) {
              return { data: null, error: { message: "duplicate key", code: "23505" } };
            }
          }
          const row = {
            id: `${table}-${++h.seq}`,
            created_at: new Date(Date.now() + h.seq).toISOString(),
            ...v,
          };
          rowsOf().push(row);
          made.push(row);
        }
        return { data: made, error: null };
      }
      let rows = rowsOf().filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of rows) Object.assign(r, values);
      }
      if (order) {
        const { column, ascending } = order;
        rows = [...rows].sort(
          (a, b) =>
            String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (ascending ? 1 : -1),
        );
      }
      return { data: rows, error: null };
    };
    const first = () => {
      const r = result();
      return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (v: Row | Row[]) => ((op = "insert"), (values = v), b),
      update: (v: Row) => ((op = "update"), (values = v), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      not: (c: string, _op: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      order: (column: string, o?: { ascending?: boolean }) => (
        (order = { column, ascending: o?.ascending !== false }),
        b
      ),
      maybeSingle: async () => first(),
      single: async () => {
        const r = first();
        return r.error || r.data ? r : { data: null, error: { message: "no rows" } };
      },
      then: (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, bad),
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("@/server/audit.server", () => ({
  writeAuditLog: vi.fn(async (e: { action: string }) => {
    h.audits.push(e.action);
  }),
  notifyOperators: vi.fn(
    async (n: { kind: string; title: string; cloneId?: string | null; url?: string | null }) => {
      h.notices.push(n);
      return true;
    },
  ),
}));

import {
  announcementsForWorkspace,
  postOperatorReply,
  postWorkspaceReply,
  recordAnnouncementDeliveries,
  recordAnnouncementSeen,
  sendAnnouncement,
} from "./announcements.server";
import { PRIME_WORKSPACE_ID } from "@/lib/cloneAnnouncements.pure";

const CLONE = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";
const OTHER = "e97f18ab-a3e3-4350-a0c9-d3f8584d6243";
const REQ = "0d4c2b52-6d4b-4a5f-9a39-2f2d9e7c1a11";

const message = (extra: Row = {}): Row => ({
  id: "ann-1",
  title: "Aurixa Systems - Going Live - 22 October 2026",
  body: "The platform moves on Wednesday.",
  link_url: null,
  link_label: null,
  severity: "info",
  display: "banner",
  dismissible: true,
  audience_plan_slugs: null,
  audience_clone_ids: null,
  audience_match: "all",
  replies_enabled: false,
  starts_at: null,
  ends_at: null,
  revision: 1,
  published_at: new Date(Date.now() - 60_000).toISOString(),
  archived_at: null,
  ...extra,
});

const draftInput = {
  title: "Maintenance tonight",
  body: "Ten minutes at 9 pm.",
  severity: "info",
  display: "modal",
  dismissible: true,
  audiencePlanSlugs: null,
  audienceCloneIds: [PRIME_WORKSPACE_ID],
  audienceMatch: "all" as const,
  repliesEnabled: true,
  startsAt: null,
  endsAt: null,
  clientRequestId: REQ,
  actorId: "operator-1",
};

const author = {
  ref: "user-9",
  name: "Rugesh Naidu",
  email: "rugesh@example.com",
  role: "superadmin",
};

beforeEach(() => {
  h.tables = {
    clones: [
      { id: CLONE, name: "NPC Client Dashboard", entitled_plan_slug: "scale" },
      { id: OTHER, name: "NPC CRM Independent", entitled_plan_slug: "launch" },
    ],
  };
  h.failing = new Set();
  h.audits = [];
  h.notices = [];
  h.seq = 0;
});

describe("the prime is served", () => {
  it("a key with no clone receives what is addressed to every workspace or to the prime", async () => {
    h.tables.clone_announcements = [
      message({ id: "all" }),
      message({ id: "prime", audience_clone_ids: [PRIME_WORKSPACE_ID] }),
      message({ id: "scale", audience_plan_slugs: ["scale"] }),
      message({ id: "clone", audience_clone_ids: [CLONE] }),
    ];
    const read = await announcementsForWorkspace(null);
    expect(read.ok && read.workspaceId).toBe(PRIME_WORKSPACE_ID);
    expect(read.ok && read.announcements.map((a) => a.id).sort()).toEqual(["all", "prime"]);
  });

  it("a delivery to the prime is stamped like any workspace's", async () => {
    await recordAnnouncementDeliveries(PRIME_WORKSPACE_ID, [{ id: "all", revision: 2 }]);
    expect(h.tables.clone_announcement_deliveries).toEqual([
      expect.objectContaining({
        announcement_id: "all",
        clone_id: PRIME_WORKSPACE_ID,
        delivery_count: 1,
      }),
    ]);
  });

  it("a failed read is a failure, never an empty list", async () => {
    h.failing.add("clone_announcements:select");
    expect((await announcementsForWorkspace(CLONE)).ok).toBe(false);
  });

  it("a workspace is served its own thread and nobody else's", async () => {
    h.tables.clone_announcements = [message({ replies_enabled: true })];
    h.tables.clone_announcement_replies = [
      {
        id: "r1",
        announcement_id: "ann-1",
        workspace_id: CLONE,
        direction: "workspace",
        body: "Mine",
        author_name: "A",
        created_at: "2026-10-27T01:00:00Z",
      },
      {
        id: "r2",
        announcement_id: "ann-1",
        workspace_id: OTHER,
        direction: "workspace",
        body: "Theirs",
        author_name: "B",
        created_at: "2026-10-27T01:05:00Z",
      },
    ];
    const read = await announcementsForWorkspace(CLONE);
    expect(read.ok && read.announcements[0].thread.map((m) => m.body)).toEqual(["Mine"]);
  });

  it("never reads replies when no served message takes them", async () => {
    h.tables.clone_announcements = [message()];
    h.failing.add("clone_announcement_replies:select");
    const read = await announcementsForWorkspace(CLONE);
    expect(read.ok).toBe(true);
  });
});

describe("Send now", () => {
  it("creates the message already published, in one act", async () => {
    const sent = await sendAnnouncement(draftInput);
    expect(sent.ok).toBe(true);
    const rows = h.tables.clone_announcements;
    expect(rows).toHaveLength(1);
    expect(rows[0].published_at).toBeTruthy();
    expect(rows[0].replies_enabled).toBe(true);
    expect(h.audits).toEqual(["clone_announcement.created", "clone_announcement.published"]);
  });

  it("the same act twice sends ONE message", async () => {
    await sendAnnouncement(draftInput);
    const again = await sendAnnouncement(draftInput);
    expect(again.ok && again.repeated).toBe(true);
    expect(h.tables.clone_announcements).toHaveLength(1);
    expect(h.notices.filter((n) => n.kind === "clone_announcement_published")).toHaveLength(1);
  });

  it("sends a draft by saving and publishing it, and refuses a message already out", async () => {
    h.tables.clone_announcements = [message({ id: "draft-1", published_at: null })];
    const sent = await sendAnnouncement({ ...draftInput, id: "draft-1" });
    expect(sent.ok).toBe(true);
    expect(h.tables.clone_announcements[0].published_at).toBeTruthy();
    expect(h.tables.clone_announcements[0].title).toBe("Maintenance tonight");
    const again = await sendAnnouncement({ ...draftInput, id: "draft-1", clientRequestId: null });
    expect(again).toEqual({ ok: false, error: "already_published" });
  });
});

describe("replies", () => {
  it("are refused for an announcement — it takes none", async () => {
    h.tables.clone_announcements = [message()];
    const r = await postWorkspaceReply({
      keyCloneId: CLONE,
      announcementId: "ann-1",
      body: "Hi",
      author,
      clientRequestId: REQ,
    });
    expect(r).toEqual({ ok: false, status: 409, error: "replies_disabled" });
    expect(h.tables.clone_announcement_replies ?? []).toHaveLength(0);
  });

  it("are refused from a workspace the message never reached", async () => {
    h.tables.clone_announcements = [
      message({ replies_enabled: true, audience_clone_ids: [OTHER] }),
    ];
    const r = await postWorkspaceReply({
      keyCloneId: CLONE,
      announcementId: "ann-1",
      body: "Hi",
      author,
      clientRequestId: REQ,
    });
    expect(r).toMatchObject({ ok: false, error: "not_addressed" });
  });

  it("land in the workspace's thread, tell the operators, and a retry is the same reply", async () => {
    h.tables.clone_announcements = [message({ replies_enabled: true })];
    const first = await postWorkspaceReply({
      keyCloneId: CLONE,
      announcementId: "ann-1",
      body: "Will there be downtime?",
      author,
      clientRequestId: REQ,
    });
    expect(first.ok && first.thread.map((m) => [m.from, m.authorName, m.body])).toEqual([
      ["workspace", "Rugesh Naidu", "Will there be downtime?"],
    ]);
    expect(h.notices).toEqual([
      expect.objectContaining({
        kind: "clone_announcement_reply",
        cloneId: CLONE,
        url: `/announcements?thread=ann-1&workspace=${CLONE}`,
      }),
    ]);
    const retry = await postWorkspaceReply({
      keyCloneId: CLONE,
      announcementId: "ann-1",
      body: "Will there be downtime?",
      author,
      clientRequestId: REQ,
    });
    expect(retry.ok).toBe(true);
    expect(h.tables.clone_announcement_replies).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
  });

  it("the prime can reply too, and is never mistaken for a clone", async () => {
    h.tables.clone_announcements = [message({ replies_enabled: true })];
    const r = await postWorkspaceReply({
      keyCloneId: null,
      announcementId: "ann-1",
      body: "Seen.",
      author,
      clientRequestId: REQ,
    });
    expect(r.ok).toBe(true);
    expect(h.tables.clone_announcement_replies[0].workspace_id).toBe(PRIME_WORKSPACE_ID);
    expect(h.notices[0]).toMatchObject({
      cloneId: null,
      title: expect.stringContaining("the prime"),
    });
  });

  it("an operator answers within one workspace's thread, signed Aurixa Systems on the wire, and reads what it answers", async () => {
    h.tables.clone_announcements = [message({ replies_enabled: true })];
    await postWorkspaceReply({
      keyCloneId: CLONE,
      announcementId: "ann-1",
      body: "Question",
      author,
      clientRequestId: REQ,
    });
    const answered = await postOperatorReply({
      announcementId: "ann-1",
      workspaceId: CLONE,
      body: "About ten minutes.",
      actorId: "operator-1",
      actorName: "Jane Operator",
      clientRequestId: "6a9a8b1e-1111-4c4c-9d9d-0e0e0e0e0e0e",
    });
    expect(answered).toEqual({ ok: true });
    const inbound = h.tables.clone_announcement_replies.find((r) => r.direction === "workspace");
    expect(inbound?.operator_read_at).toBeTruthy();
    const read = await announcementsForWorkspace(CLONE);
    const thread = read.ok ? read.announcements[0].thread : [];
    expect(thread.map((m) => [m.from, m.authorName])).toEqual([
      ["workspace", "Rugesh Naidu"],
      ["aurixa", "Aurixa Systems"],
    ]);
    expect(JSON.stringify(thread)).not.toContain("Jane");
  });

  it("an operator cannot answer a message that is not live", async () => {
    h.tables.clone_announcements = [
      message({ replies_enabled: true, archived_at: new Date().toISOString() }),
    ];
    const r = await postOperatorReply({
      announcementId: "ann-1",
      workspaceId: CLONE,
      body: "Hello",
      actorId: "operator-1",
      actorName: "Jane",
      clientRequestId: null,
    });
    expect(r.ok).toBe(false);
  });
});

describe("seen", () => {
  it("counts a person seeing a message on its delivery stamp, never by name", async () => {
    h.tables.clone_announcements = [message()];
    await recordAnnouncementDeliveries(CLONE, [{ id: "ann-1", revision: 1 }]);
    expect(await recordAnnouncementSeen({ keyCloneId: CLONE, announcementId: "ann-1" })).toEqual({
      ok: true,
    });
    expect(await recordAnnouncementSeen({ keyCloneId: CLONE, announcementId: "ann-1" })).toEqual({
      ok: true,
    });
    const [stamp] = h.tables.clone_announcement_deliveries;
    expect(stamp.seen_count).toBe(2);
    expect(stamp.first_seen_at).toBeTruthy();
    expect(Object.keys(stamp)).not.toContain("seen_by");
  });

  it("is refused for a message the workspace could not have been shown", async () => {
    h.tables.clone_announcements = [message({ audience_plan_slugs: ["launch"] })];
    expect(
      await recordAnnouncementSeen({ keyCloneId: CLONE, announcementId: "ann-1" }),
    ).toMatchObject({
      ok: false,
      error: "not_addressed",
    });
  });
});
