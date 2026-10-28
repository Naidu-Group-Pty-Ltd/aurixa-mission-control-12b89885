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
  /** What reached a workspace's Realtime: the URL posted to, and the body. */
  broadcasts: [] as Array<{ url: string; body: { messages: Array<Record<string, unknown>> } }>,
  refusing: new Set<string>(),
  /** An update the database refuses this once, as a write lost to a timeout would be. */
  refuseUpdate: null as null | ((table: string, values: Row) => boolean),
}));

/** The unique indexes of 20261027120100_workspace_message_replies.sql. */
const UNIQUE: Record<string, string[][]> = {
  clone_announcements: [["client_request_id"]],
  clone_announcement_replies: [["workspace_id", "client_request_id"]],
  clone_announcement_deliveries: [["announcement_id", "clone_id"]],
};

/** The CHECKs of 20261028150100_workspace_message_recall.sql. */
const CHECKS: Record<string, Array<[string, (r: Row) => boolean]>> = {
  clone_announcements: [
    ["clone_announcements_recalled_is_unpublished", (r) => !r.recalled_at || !r.published_at],
  ],
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
        return { data: made.map((r) => ({ ...r })), error: null };
      }
      let rows = rowsOf().filter((r) => filters.every((f) => f(r)));
      if (op === "update" && h.refuseUpdate?.(table, values as Row)) {
        h.refuseUpdate = null;
        return { data: null, error: { message: "canceling statement due to statement timeout" } };
      }
      if (op === "update") {
        // The CHECKs the migrations declare, refused as Postgres refuses them.
        for (const r of rows) {
          const next = { ...r, ...(values as Row) };
          for (const [name, holds] of CHECKS[table] ?? []) {
            if (!holds(next)) {
              return {
                data: null,
                error: { message: `violates check constraint "${name}"`, code: "23514" },
              };
            }
          }
        }
        for (const r of rows) Object.assign(r, values);
      }
      if (order) {
        const { column, ascending } = order;
        rows = [...rows].sort(
          (a, b) =>
            String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (ascending ? 1 : -1),
        );
      }
      // A copy, as PostgREST's answer is: a row read before an update must
      // not change under the reader when the update lands.
      return { data: rows.map((r) => ({ ...r })), error: null };
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
      gte: (c: string, v: string) => (filters.push((r) => r[c] != null && String(r[c]) >= v), b),
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

// The Management API, which the signal asks for the prime's publishable key.
vi.mock("@/server/backend-provisioning.server", () => ({
  getProjectApiKeys: vi.fn(async () => [{ name: "anon", api_key: "prime-anon" }]),
  selectProjectKeys: (keys: Array<{ name: string; api_key: string }>) => ({
    anonKey: keys.find((k) => k.name === "anon")?.api_key ?? null,
    serviceRoleKey: null,
    gatewayKey: null,
  }),
}));
vi.mock("@/server/prime-backend.server", () => ({
  resolvePrimeBackendRef: vi.fn(async () => "dduzbchuswwbefdunfct"),
}));

// Each workspace's Realtime broadcast endpoint: 202 on acceptance, as measured
// on the wire on 28 Oct 2026; a refusing host answers 503.
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init: { body: string }) => {
    if (h.refusing.has(new URL(url).host)) return new Response("{}", { status: 503 });
    h.broadcasts.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 202 });
  }),
);

import {
  announcementsForWorkspace,
  archiveAnnouncement,
  postOperatorReply,
  postWorkspaceReply,
  publishAnnouncement,
  recallAnnouncement,
  recordAnnouncementDeliveries,
  recordAnnouncementSeen,
  recordAnnouncementWithdrawals,
  sendAnnouncement,
  updateAnnouncement,
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

const PRIME_RT = "https://dduzbchuswwbefdunfct.supabase.co/realtime/v1/api/broadcast";
const CLONE_RT = "https://plisdzywzleljorrphxv.supabase.co/realtime/v1/api/broadcast";
const OTHER_RT = "https://qvuwrvwzjyigptmnijyb.supabase.co/realtime/v1/api/broadcast";

beforeEach(() => {
  h.tables = {
    clones: [
      { id: CLONE, name: "NPC Client Dashboard", entitled_plan_slug: "scale" },
      { id: OTHER, name: "NPC CRM Independent", entitled_plan_slug: "launch" },
    ],
    clone_backends: [
      { clone_id: CLONE, supabase_url: "https://plisdzywzleljorrphxv.supabase.co", anon_key: "clone-anon" },
      { clone_id: OTHER, supabase_url: "https://qvuwrvwzjyigptmnijyb.supabase.co", anon_key: "other-anon" },
    ],
  };
  h.failing = new Set();
  h.audits = [];
  h.notices = [];
  h.seq = 0;
  h.broadcasts = [];
  h.refusing = new Set();
  h.refuseUpdate = null;
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
      title: expect.stringContaining("Prime workspace"),
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
    expect(answered).toEqual({ ok: true, signal: { reached: 1, signalled: 1, failed: 0 } });
    // The answer is that workspace's own thread: only its Realtime is told.
    expect(h.broadcasts.map((b) => b.url)).toEqual([CLONE_RT]);
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

describe("a workspace hears at once", () => {
  it("Send now signals the workspace it reaches, with nothing about the message", async () => {
    const sent = await sendAnnouncement(draftInput);
    expect(sent.ok && sent.signal).toEqual({ reached: 1, signalled: 1, failed: 0 });
    expect(h.broadcasts).toHaveLength(1);
    const [b] = h.broadcasts;
    expect(b.url).toBe(PRIME_RT);
    expect(b.body.messages).toEqual([
      {
        topic: "aurixa-systems-notices",
        event: "changed",
        payload: { at: expect.any(String) },
        private: false,
      },
    ]);
    expect(JSON.stringify(b.body)).not.toContain("Maintenance tonight");
  });

  it("a message to every workspace signals the prime and every clone", async () => {
    const sent = await sendAnnouncement({ ...draftInput, audienceCloneIds: null });
    expect(sent.ok && sent.signal).toEqual({ reached: 3, signalled: 3, failed: 0 });
    expect(h.broadcasts.map((b) => b.url).sort()).toEqual([CLONE_RT, OTHER_RT, PRIME_RT].sort());
  });

  it("a draft signals nobody", async () => {
    h.tables.clone_announcements = [message({ published_at: null })];
    const saved = await updateAnnouncement({ ...draftInput, id: "ann-1", clientRequestId: null });
    expect(saved.ok && saved.signal).toBeUndefined();
    expect(h.broadcasts).toHaveLength(0);
  });

  it("narrowing a live message signals the workspace that is losing it", async () => {
    h.tables.clone_announcements = [message({ audience_clone_ids: [CLONE, OTHER] })];
    await updateAnnouncement({
      ...draftInput,
      id: "ann-1",
      audienceCloneIds: [CLONE],
      clientRequestId: null,
    });
    expect(h.broadcasts.map((b) => b.url).sort()).toEqual([CLONE_RT, OTHER_RT].sort());
  });

  it("archiving signals the workspaces that are showing it", async () => {
    h.tables.clone_announcements = [message({ audience_clone_ids: [OTHER] })];
    const archived = await archiveAnnouncement({ id: "ann-1", actorId: "operator-1", reason: "Done" });
    expect(archived.ok).toBe(true);
    expect(h.broadcasts.map((b) => b.url)).toEqual([OTHER_RT]);
  });

  it("a workspace whose Realtime refuses is counted, and the message is still sent", async () => {
    h.refusing.add("qvuwrvwzjyigptmnijyb.supabase.co");
    const sent = await sendAnnouncement({ ...draftInput, audienceCloneIds: [CLONE, OTHER] });
    expect(sent.ok && sent.signal).toEqual({ reached: 2, signalled: 1, failed: 1 });
    expect(h.tables.clone_announcements[0].published_at).toBeTruthy();
  });

  it("a workspace with no known Realtime is counted as not signalled", async () => {
    h.tables.clone_backends = [];
    const sent = await sendAnnouncement({ ...draftInput, audienceCloneIds: [CLONE] });
    expect(sent.ok && sent.signal).toEqual({ reached: 1, signalled: 0, failed: 1 });
    expect(h.broadcasts).toHaveLength(0);
  });

  it("the answer says when the workspace's notices next change by themselves", async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    h.tables.clone_announcements = [
      message({ id: "now" }),
      message({ id: "later", starts_at: startsAt }),
    ];
    const read = await announcementsForWorkspace(null);
    expect(read.ok && read.announcements.map((a) => a.id)).toEqual(["now"]);
    expect(read.ok && read.nextChangeAt).toBe(startsAt);
  });
});

describe("an operator is told who answered", () => {
  it("names the business the workspace's own server reported, and the workspace", async () => {
    h.tables.clone_announcements = [message({ replies_enabled: true })];
    await postWorkspaceReply({
      keyCloneId: CLONE,
      announcementId: "ann-1",
      body: "We are ready.",
      author,
      clientRequestId: REQ,
      businessName: "Preflight Property Group",
    });
    expect(h.notices).toEqual([
      expect.objectContaining({
        kind: "clone_announcement_reply",
        title: "New reply from Preflight Property Group (NPC Client Dashboard)",
        metadata: expect.objectContaining({
          business_name: "Preflight Property Group",
          workspace_name: "NPC Client Dashboard",
          author_name: "Rugesh Naidu",
          excerpt: "We are ready.",
        }),
      }),
    ]);
  });
});

describe("recall", () => {
  it("takes a live message down at once: unpublished, marked recalled, the revision bumped", async () => {
    h.tables.clone_announcements = [message({ revision: 10 })];
    const recalled = await recallAnnouncement({
      id: "ann-1",
      actorId: "operator-1",
      note: "Wrong date",
    });
    expect(recalled.ok).toBe(true);
    const [row] = h.tables.clone_announcements;
    expect(row.published_at).toBeNull();
    expect(row.recalled_at).toEqual(expect.any(String));
    expect(row.revision).toBe(11);
    expect(h.audits).toEqual(["clone_announcement.recalled"]);
    expect(h.notices).toEqual([
      expect.objectContaining({
        kind: "clone_announcement_recalled",
        title: "Message recalled: " + row.title,
      }),
    ]);
    // No workspace is served it any more.
    const read = await announcementsForWorkspace(CLONE);
    expect(read.ok && read.announcements).toEqual([]);
  });

  it("signals every workspace it reached, so their dashboards drop it within seconds", async () => {
    h.tables.clone_announcements = [message()];
    const recalled = await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    expect(recalled.ok && recalled.signal).toEqual({ reached: 3, signalled: 3, failed: 0 });
    expect(h.broadcasts.map((b) => b.url).sort()).toEqual([CLONE_RT, OTHER_RT, PRIME_RT].sort());
    expect(JSON.stringify(h.broadcasts)).not.toContain("Going Live");
  });

  it("recalls a scheduled message before anyone sees it", async () => {
    h.tables.clone_announcements = [
      message({
        starts_at: new Date(Date.now() + 3_600_000).toISOString(),
        audience_clone_ids: [OTHER],
      }),
    ];
    const recalled = await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    expect(recalled.ok).toBe(true);
    expect(h.tables.clone_announcements[0].published_at).toBeNull();
    expect(h.broadcasts.map((b) => b.url)).toEqual([OTHER_RT]);
  });

  it("refuses what is not out — a draft, a recalled or an archived message — and changes nothing", async () => {
    h.tables.clone_announcements = [
      message({ id: "draft", published_at: null }),
      message({ id: "archived", archived_at: new Date().toISOString() }),
    ];
    expect(await recallAnnouncement({ id: "draft", actorId: "o" })).toEqual({
      ok: false,
      error: "not_out",
    });
    expect(await recallAnnouncement({ id: "archived", actorId: "o" })).toEqual({
      ok: false,
      error: "ended",
    });
    expect(await recallAnnouncement({ id: "missing", actorId: "o" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(h.audits).toEqual([]);
    expect(h.broadcasts).toEqual([]);

    h.tables.clone_announcements = [message()];
    await recallAnnouncement({ id: "ann-1", actorId: "o" });
    expect(await recallAnnouncement({ id: "ann-1", actorId: "o" })).toEqual({
      ok: false,
      error: "not_out",
    });
    expect(h.audits).toEqual(["clone_announcement.recalled"]);
  });

  it("a late retry of the send that put it out never puts it back", async () => {
    const sent = await sendAnnouncement(draftInput);
    const id = sent.ok ? (sent.row.id as string) : "";
    await recallAnnouncement({ id, actorId: "operator-1" });
    const retry = await sendAnnouncement(draftInput);
    expect(retry.ok && retry.repeated).toBe(true);
    expect(h.tables.clone_announcements[0].published_at).toBeNull();
    expect(h.audits.filter((a) => a === "clone_announcement.published")).toHaveLength(1);
  });

  it("sent again from the editor, it goes out corrected, no longer recalled, and new to every dashboard", async () => {
    h.tables.clone_announcements = [message({ revision: 4 })];
    await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    const again = await sendAnnouncement({
      ...draftInput,
      id: "ann-1",
      title: "Going Live - 1 November 2026",
      clientRequestId: "6f1d9c2e-1b7a-4c55-8e0b-5a3e9d7c2f10",
    });
    expect(again.ok).toBe(true);
    const [row] = h.tables.clone_announcements;
    expect(row.published_at).toEqual(expect.any(String));
    expect(row.recalled_at).toBeNull();
    // The dismissals of revision 4 do not hide revision 5.
    expect(row.revision).toBe(5);
    expect(row.title).toBe("Going Live - 1 November 2026");
  });

  it("publishing a recalled message clears the recall, as the database requires", async () => {
    h.tables.clone_announcements = [message()];
    await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    expect((await publishAnnouncement({ id: "ann-1", actorId: "operator-1" })).ok).toBe(true);
    expect(h.tables.clone_announcements[0].recalled_at).toBeNull();
  });

  it("a send again that fails changes nothing, and its retry sends the correction", async () => {
    h.tables.clone_announcements = [message()];
    await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    const again = {
      ...draftInput,
      id: "ann-1",
      title: "Going Live - 1 November 2026",
      clientRequestId: "6f1d9c2e-1b7a-4c55-8e0b-5a3e9d7c2f10",
    };
    h.refuseUpdate = (table, values) => table === "clone_announcements" && !!values.published_at;
    expect((await sendAnnouncement(again)).ok).toBe(false);
    expect(h.tables.clone_announcements[0]).toMatchObject({
      title: message().title,
      published_at: null,
      recalled_at: expect.any(String),
    });

    // The same act, tried again: sent, not reported already sent.
    const retry = await sendAnnouncement(again);
    expect(retry.ok && retry.repeated).toBeFalsy();
    expect(h.tables.clone_announcements[0]).toMatchObject({
      title: "Going Live - 1 November 2026",
      published_at: expect.any(String),
      recalled_at: null,
    });
  });
});

describe("a recall is confirmed by the workspaces themselves", () => {
  const stamp = (cloneId: string, extra: Row = {}): Row => ({
    announcement_id: "ann-1",
    clone_id: cloneId,
    first_delivered_at: new Date(Date.now() - 3_600_000).toISOString(),
    last_delivered_at: new Date(Date.now() - 600_000).toISOString(),
    delivery_count: 3,
    last_revision: 1,
    withdrawn_at: null,
    ...extra,
  });

  it("a workspace that had it confirms on its next fetch; one that never fetched it has nothing to withdraw", async () => {
    h.tables.clone_announcements = [message()];
    h.tables.clone_announcement_deliveries = [stamp(CLONE)];
    await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });

    await recordAnnouncementWithdrawals(CLONE, []);
    await recordAnnouncementWithdrawals(OTHER, []);
    expect(h.tables.clone_announcement_deliveries).toEqual([
      expect.objectContaining({ clone_id: CLONE, withdrawn_at: expect.any(String) }),
    ]);
  });

  it("an answer read before the recall landed, still holding it, withdraws nothing", async () => {
    h.tables.clone_announcements = [message()];
    h.tables.clone_announcement_deliveries = [stamp(CLONE)];
    await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    await recordAnnouncementWithdrawals(CLONE, [{ id: "ann-1" }]);
    expect(h.tables.clone_announcement_deliveries[0].withdrawn_at).toBeNull();
    await recordAnnouncementWithdrawals(CLONE, []);
    expect(h.tables.clone_announcement_deliveries[0].withdrawn_at).toEqual(expect.any(String));
  });

  it("is stamped once, at the first fetch after the recall", async () => {
    h.tables.clone_announcements = [message()];
    h.tables.clone_announcement_deliveries = [stamp(CLONE)];
    await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    await recordAnnouncementWithdrawals(CLONE, []);
    const first = h.tables.clone_announcement_deliveries[0].withdrawn_at;
    await new Promise((r) => setTimeout(r, 5));
    await recordAnnouncementWithdrawals(CLONE, []);
    expect(h.tables.clone_announcement_deliveries[0].withdrawn_at).toBe(first);
  });

  it("a withdrawal from an earlier recall does not count for a later one", async () => {
    h.tables.clone_announcements = [message()];
    h.tables.clone_announcement_deliveries = [
      stamp(CLONE, { withdrawn_at: new Date(Date.now() - 3_000_000).toISOString() }),
    ];
    await recallAnnouncement({ id: "ann-1", actorId: "operator-1" });
    await recordAnnouncementWithdrawals(CLONE, []);
    const w = Date.parse(h.tables.clone_announcement_deliveries[0].withdrawn_at as string);
    expect(w).toBeGreaterThanOrEqual(
      Date.parse(h.tables.clone_announcements[0].recalled_at as string),
    );
  });

  it("delivered again after it is sent again, it is no longer withdrawn", async () => {
    h.tables.clone_announcement_deliveries = [
      stamp(CLONE, { withdrawn_at: new Date().toISOString() }),
    ];
    await recordAnnouncementDeliveries(CLONE, [{ id: "ann-1", revision: 2 }]);
    expect(h.tables.clone_announcement_deliveries[0].withdrawn_at).toBeNull();
  });

  it("with no recent recall it reads one small list and writes nothing", async () => {
    h.tables.clone_announcements = [message()];
    h.tables.clone_announcement_deliveries = [stamp(CLONE)];
    await recordAnnouncementWithdrawals(CLONE, []);
    expect(h.tables.clone_announcement_deliveries[0].withdrawn_at).toBeNull();
  });

  it("never fails a workspace's answer when it cannot read", async () => {
    h.failing.add("clone_announcements:select");
    await expect(recordAnnouncementWithdrawals(CLONE, [])).resolves.toBeUndefined();
  });
});
