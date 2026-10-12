// The warmup engine, driven through the real code against an in-memory
// database and an in-memory Microsoft: mailboxes with folders, drafts that
// become Sent Items, and delivery to the recipient's inbox or Junk. Each case
// is something that, if it broke, would show up in a real mailbox:
//
//   - a conversation runs end to end: sent, found where it landed, rescued
//     from Junk, read, flagged, filed out of the inbox, answered — and the
//     answer goes through the same again;
//   - mailboxes of one organisation are never paired (outside test mode);
//   - mail that never arrives is recorded as missing, and a draft that never
//     left as failed, not as sent;
//   - the pool's pause stops new mail but still tidies what is in flight;
//   - a mailbox whose sends keep being refused stops, with the reason.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  vault: new Map<string, string>(),
}));

type Item = {
  id: string;
  folder: string;
  internetMessageId: string;
  isDraft: boolean;
  isRead: boolean;
  flagged: boolean;
  inference: "focused" | "other";
  subject: string;
  bodyHtml: string;
  to: string;
  from: string;
};

const graph = vi.hoisted(() => ({
  boxes: new Map<string, Item[]>(),
  seq: 0,
  /** Recipients whose copy lands in Junk. */
  junkFor: new Set<string>(),
  /** Recipients whose copy never arrives. */
  dropFor: new Set<string>(),
  /** Senders whose drafts Microsoft refuses to create. */
  refuseDraftsFor: new Set<string>(),
  /** Drafts are "sent" but never leave. */
  stuckDrafts: false,
  roles: ["Mail.Send", "Mail.ReadWrite"] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Row = Record<string, unknown>;
  type Filter = (row: Row) => boolean;

  const DEFAULTS: Record<string, Row> = {
    email_warmup_messages: {
      parent_id: null,
      depth: 0,
      placement: null,
      focused: null,
      sender_item_id: null,
      internet_message_id: null,
      recipient_item_id: null,
      will_reply: false,
      will_flag: false,
      sent_at: null,
      sent_confirmed_at: null,
      sender_filed_at: null,
      next_check_at: null,
      check_attempts: 0,
      landed_at: null,
      engage_at: null,
      engaged_at: null,
      rescued_at: null,
      flagged_at: null,
      filed_at: null,
      reply_due_at: null,
      replied_at: null,
      action_attempts: 0,
      error: null,
    },
  };

  class Query implements PromiseLike<unknown> {
    private op: "select" | "update" | "insert" = "select";
    private filters: Filter[] = [];
    private patch: Row = {};
    private inserts: Row[] = [];
    private returning = false;
    private limitTo = Infinity;
    private offset = 0;
    private orderBy: { column: string; ascending: boolean }[] = [];
    private one: "single" | "maybe" | null = null;

    constructor(private readonly table: string) {}
    private rows() {
      return (db.tables[this.table] ??= []);
    }
    select() {
      this.returning = true;
      return this;
    }
    update(patch: Row) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.inserts = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    neq(column: string, value: unknown) {
      this.filters.push((row) => row[column] !== value);
      return this;
    }
    is(column: string, value: null) {
      this.filters.push((row) => (row[column] ?? null) === value);
      return this;
    }
    gte(column: string, value: string) {
      this.filters.push((row) => row[column] != null && String(row[column]) >= value);
      return this;
    }
    lte(column: string, value: string) {
      this.filters.push((row) => row[column] != null && String(row[column]) <= value);
      return this;
    }
    lt(column: string, value: string) {
      this.filters.push((row) => row[column] != null && String(row[column]) < value);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }
    /** Only the lease's shape: `col.is.null,col.lt."<iso>"`. */
    or(expression: string) {
      const terms = (expression.match(/(?:[^,"]|"[^"]*")+/g) ?? []).map((term) => {
        const [column, operator, ...rest] = term.split(".");
        const value = rest.join(".").replace(/^"|"$/g, "");
        if (operator === "is" && value === "null") return (row: Row) => row[column] == null;
        if (operator === "lt")
          return (row: Row) => row[column] != null && String(row[column]) < value;
        throw new Error(`fake: unsupported or() term ${term}`);
      });
      this.filters.push((row) => terms.some((test) => test(row)));
      return this;
    }
    order(column: string, options: { ascending?: boolean } = {}) {
      this.orderBy.push({ column, ascending: options.ascending ?? true });
      return this;
    }
    limit(n: number) {
      this.limitTo = n;
      return this;
    }
    range(from: number, to: number) {
      this.offset = from;
      this.limitTo = to - from + 1;
      return this;
    }
    single() {
      this.one = "single";
      return this;
    }
    maybeSingle() {
      this.one = "maybe";
      return this;
    }
    private run() {
      const matching = () => this.rows().filter((row) => this.filters.every((f) => f(row)));
      let data: Row[] = [];
      if (this.op === "insert") {
        for (const input of this.inserts) {
          const row = { ...(DEFAULTS[this.table] ?? {}), ...input };
          this.rows().push(row);
          data.push(row);
        }
      } else if (this.op === "update") {
        data = matching();
        for (const row of data) Object.assign(row, this.patch);
      } else {
        data = matching();
        for (const { column, ascending } of [...this.orderBy].reverse()) {
          data = [...data].sort((a, b) => {
            const left = a[column] as string | number | null;
            const right = b[column] as string | number | null;
            if (left === right) return 0;
            if (left == null) return -1;
            if (right == null) return 1;
            return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          });
        }
        data = data.slice(this.offset, this.offset + this.limitTo);
      }
      const copy = data.map((row) => ({ ...row }));
      if (this.one) return { data: copy[0] ?? null, error: null };
      return { data: this.returning || this.op === "select" ? copy : null, error: null };
    }
    then<T1, T2>(
      resolve?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
      reject?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return Promise.resolve()
        .then(() => this.run())
        .then(resolve, reject);
    }
  }

  return {
    supabaseAdmin: {
      from: (table: string) => new Query(table),
      rpc: async (name: string, args: { p_tenant: string }) => {
        if (name !== "microsoft_tenant_credentials") throw new Error(`fake: no rpc ${name}`);
        return { data: db.vault.get(args.p_tenant) ?? null, error: null };
      },
    },
  };
});

vi.mock("@/server/audit.server", () => ({ writeAuditLog: async () => undefined }));

vi.mock("@/server/graph-client", () => {
  class GraphError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code: string | null,
    ) {
      super(message);
    }
  }
  type Config = { tenantId: string };
  const box = (address: string) => {
    let items = graph.boxes.get(address);
    if (!items) {
      items = [];
      graph.boxes.set(address, items);
    }
    return items;
  };
  const find = (mailbox: string, id: string) => box(mailbox).find((item) => item.id === id);
  const gone = () =>
    new GraphError("The specified object was not found in the store.", 404, "ErrorItemNotFound");
  const nextId = () => `imm-${++graph.seq}`;

  return {
    GraphError,
    defaultGraphConfig: () => ({
      tenantId: "org-a",
      clientId: "client-a",
      clientSecret: "secret-a",
      mailbox: null,
      key: "default",
    }),
    accessToken: async () => "token",
    forgetToken: () => undefined,
    probeMailboxes: async () => [],
    grantedRoles: async () => graph.roles,
    organisationOf: async (config: Config) => config.tenantId,
    ensureMailFolder: async (mailbox: string) => `warmup:${mailbox}`,
    createDraftMessage: async (
      mailbox: string,
      message: {
        subject: string;
        body: { content: string };
        toRecipients: { emailAddress: { address: string } }[];
      },
    ) => {
      if (graph.refuseDraftsFor.has(mailbox)) {
        throw new GraphError("Access is denied.", 403, "ErrorAccessDenied");
      }
      const item: Item = {
        id: nextId(),
        folder: "drafts",
        internetMessageId: `<m${graph.seq}@${mailbox.split("@")[1]}>`,
        isDraft: true,
        isRead: true,
        flagged: false,
        inference: "focused",
        subject: message.subject,
        bodyHtml: message.body.content,
        to: message.toRecipients[0].emailAddress.address,
        from: mailbox,
      };
      box(mailbox).push(item);
      return { id: item.id, internetMessageId: item.internetMessageId };
    },
    sendDraftMessage: async (mailbox: string, id: string) => {
      const draft = find(mailbox, id);
      if (!draft) throw gone();
      if (graph.stuckDrafts) return { kind: "sent", status: 202, requestId: null };
      draft.folder = "sentitems";
      draft.isDraft = false;
      if (!graph.dropFor.has(draft.to)) {
        box(draft.to).push({
          ...draft,
          id: nextId(),
          folder: graph.junkFor.has(draft.to) ? "junkemail" : "inbox",
          isRead: false,
        });
      }
      return { kind: "sent", status: 202, requestId: null };
    },
    getMailboxMessage: async (mailbox: string, id: string) => {
      const item = find(mailbox, id);
      return item
        ? {
            id: item.id,
            internetMessageId: item.internetMessageId,
            isDraft: item.isDraft,
            isRead: item.isRead,
          }
        : null;
    },
    findMessageByInternetId: async (
      mailbox: string,
      folder: string | null,
      internetMessageId: string,
    ) => {
      const item = box(mailbox).find(
        (candidate) =>
          candidate.internetMessageId === internetMessageId &&
          !candidate.isDraft &&
          candidate.from !== mailbox &&
          (folder === null || candidate.folder === folder),
      );
      return item
        ? {
            id: item.id,
            internetMessageId,
            isRead: item.isRead,
            inferenceClassification: item.inference,
          }
        : null;
    },
    updateMailboxMessage: async (
      mailbox: string,
      id: string,
      patch: {
        isRead?: boolean;
        flag?: { flagStatus: string };
        inferenceClassification?: "focused";
        body?: { content: string };
      },
    ) => {
      const item = find(mailbox, id);
      if (!item) throw gone();
      if (patch.isRead !== undefined) item.isRead = patch.isRead;
      if (patch.flag) item.flagged = patch.flag.flagStatus === "flagged";
      if (patch.inferenceClassification) item.inference = patch.inferenceClassification;
      if (patch.body) item.bodyHtml = patch.body.content;
    },
    moveMailboxMessage: async (mailbox: string, id: string, destination: string) => {
      const item = find(mailbox, id);
      if (!item) throw gone();
      item.folder = destination;
      return id;
    },
    deleteMailboxMessage: async (mailbox: string, id: string) => {
      const items = box(mailbox);
      const at = items.findIndex((item) => item.id === id);
      if (at >= 0) items.splice(at, 1);
    },
    createReplyDraft: async (mailbox: string, id: string) => {
      const original = find(mailbox, id);
      if (!original) throw gone();
      const draft: Item = {
        id: nextId(),
        folder: "drafts",
        internetMessageId: `<r${graph.seq}@${mailbox.split("@")[1]}>`,
        isDraft: true,
        isRead: true,
        flagged: false,
        inference: "focused",
        subject: `RE: ${original.subject}`,
        bodyHtml: `<html><body><hr><p>quoted: ${original.subject}</p></body></html>`,
        to: original.from,
        from: mailbox,
      };
      box(mailbox).push(draft);
      return {
        id: draft.id,
        internetMessageId: draft.internetMessageId,
        subject: draft.subject,
        bodyHtml: draft.bodyHtml,
      };
    },
  };
});

const { runWarmupTick } = await import("./email-warmup.server");
const { forgetTenantConfig } = await import("./microsoft-tenants.server");

const TENANT_B = "22222222-2222-4222-8222-222222222222";
// Monday 12 Oct 2026, 10:00 in Sydney.
const BASE = Date.parse("2026-10-11T23:00:00Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const tick = (minutes: number, budgetMs = 30_000) =>
  runWarmupTick({ now: at(minutes), random: () => 0, budgetMs });

function mailbox(id: string, address: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: null,
    mailbox: address,
    display_name: null,
    status: "active",
    status_reason: null,
    start_per_day: 2,
    increase_per_day: 2,
    max_per_day: 30,
    reply_rate: 0,
    important_rate: 0,
    weekdays_only: false,
    timezone: "Australia/Sydney",
    window_start: "08:00:00",
    window_end: "18:00:00",
    tidy_sent: true,
    active_days: 0,
    last_active_on: null,
    next_send_at: null,
    warmup_folder_id: `warmup:${address}`,
    organisation_id: null,
    prepared_at: "2026-10-01T00:00:00Z",
    consecutive_failures: 0,
    last_error: null,
    last_error_at: null,
    removed_at: null,
    removed_by: null,
    created_by: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const messages = () => db.tables.email_warmup_messages;
const mailboxRow = (id: string) => db.tables.email_warmup_mailboxes.find((row) => row.id === id)!;
const items = (address: string) => graph.boxes.get(address) ?? [];

beforeEach(() => {
  forgetTenantConfig();
  db.tables = {
    email_warmup_settings: [
      {
        id: true,
        paused: false,
        allow_same_organisation: false,
        lease_until: null,
        lease_token: null,
        last_tick_at: null,
        last_tick_note: null,
      },
    ],
    email_warmup_mailboxes: [
      // Alex: the deployment's own tenant (organisation A).
      mailbox("mb-alex", "alex@a.test", { display_name: "Alex Smith" }),
      // Sam: an added tenant in organisation B, and an eager correspondent.
      mailbox("mb-sam", "sam@b.test", {
        tenant_id: TENANT_B,
        display_name: "Sam Jones",
        reply_rate: 100,
        important_rate: 100,
      }),
    ],
    email_warmup_messages: [],
    microsoft_tenants: [
      {
        id: TENANT_B,
        label: "Partner",
        default_mailbox: null,
        credentials_version: 1,
        removed_at: null,
        vault_secret_id: "vault-b",
      },
    ],
  };
  db.vault.clear();
  db.vault.set(
    TENANT_B,
    JSON.stringify({ tenantId: "org-b", clientId: "client-b", clientSecret: "secret-b" }),
  );
  graph.boxes.clear();
  graph.seq = 0;
  graph.junkFor.clear();
  graph.dropFor.clear();
  graph.refuseDraftsFor.clear();
  graph.stuckDrafts = false;
  graph.roles = ["Mail.Send", "Mail.ReadWrite"];
});

describe("a conversation, end to end", () => {
  it("is sent, found, rescued from Junk, read, flagged, filed and answered — and the answer is too", async () => {
    graph.junkFor.add("sam@b.test");

    // 10:00 — both mailboxes are due and each writes to the other.
    const first = await tick(0);
    expect(first).toMatchObject({ sent: 2, failed: 0 });
    const alexToSam = messages().find((m) => m.sender_id === "mb-alex")!;
    const samToAlex = messages().find((m) => m.sender_id === "mb-sam")!;
    expect(alexToSam).toMatchObject({ status: "sent", recipient_id: "mb-sam", depth: 0 });
    // Sam's rates decide what Sam does with Alex's mail: always answer, always flag.
    expect(alexToSam).toMatchObject({ will_reply: true, will_flag: true });
    expect(samToAlex).toMatchObject({ will_reply: false, will_flag: false });
    expect(mailboxRow("mb-alex")).toMatchObject({ active_days: 1, last_active_on: "2026-10-12" });
    // The second of today's two goes later in the day, not now.
    expect(Date.parse(String(mailboxRow("mb-alex").next_send_at))).toBeGreaterThan(
      at(60).getTime(),
    );

    // 10:05 — both found where they landed; the sent copies are filed.
    const second = await tick(5);
    expect(second).toMatchObject({ found: 2, inJunk: 1, sent: 0 });
    expect(alexToSam).toMatchObject({ status: "landed", placement: "junk" });
    expect(samToAlex).toMatchObject({ status: "landed", placement: "inbox" });
    expect(items("alex@a.test").find((i) => i.id === alexToSam.sender_item_id)?.folder).toBe(
      "warmup:alex@a.test",
    );

    // 10:08 — read like a person would: out of Junk, read, flagged, filed.
    const third = await tick(8);
    expect(third).toMatchObject({ engaged: 2, rescued: 1 });
    const samsCopy = items("sam@b.test").find((i) => i.id === alexToSam.recipient_item_id)!;
    expect(samsCopy).toMatchObject({ folder: "warmup:sam@b.test", isRead: true, flagged: true });
    expect(alexToSam).toMatchObject({ status: "engaged" });
    expect(alexToSam.rescued_at).toBeTruthy();
    expect(samToAlex).toMatchObject({ status: "done" });
    expect(items("alex@a.test").find((i) => i.id === samToAlex.recipient_item_id)).toMatchObject({
      folder: "warmup:alex@a.test",
      isRead: true,
      flagged: false,
    });

    // 10:20 — Sam answers, above Microsoft's quoted copy.
    const fourth = await tick(20);
    expect(fourth).toMatchObject({ replied: 1 });
    expect(alexToSam).toMatchObject({ status: "done" });
    const reply = messages().find((m) => m.parent_id === alexToSam.id)!;
    expect(reply).toMatchObject({
      status: "sent",
      depth: 1,
      thread_id: alexToSam.thread_id,
      sender_id: "mb-sam",
      recipient_id: "mb-alex",
    });
    expect(String(reply.subject)).toMatch(/^RE: /);
    const samsSent = items("sam@b.test").find((i) => i.id === reply.sender_item_id)!;
    expect(samsSent.bodyHtml).toMatch(/^<html><body><div><p>.*Sam<\/p><\/div><hr>/);

    // 10:25 and 10:32 — the reply is found in Alex's inbox and read; Alex,
    // who never replies, closes the thread.
    await tick(25);
    expect(reply).toMatchObject({ status: "landed", placement: "inbox" });
    await tick(32);
    expect(reply).toMatchObject({ status: "done" });
    expect(messages().every((m) => m.status === "done")).toBe(true);
    // Nothing warmup sent or received is left in an inbox, Junk, or Sent Items.
    for (const address of ["alex@a.test", "sam@b.test"]) {
      expect(items(address).every((i) => i.folder === `warmup:${address}`)).toBe(true);
    }
  });
});

describe("pairing", () => {
  it("never pairs two mailboxes of one organisation", async () => {
    db.tables.email_warmup_mailboxes = [
      mailbox("mb-1", "one@a.test"),
      mailbox("mb-2", "two@a.test"),
    ];
    const summary = await tick(0);
    expect(summary.sent).toBe(0);
    expect(summary.notes.join(" ")).toMatch(/no mailbox in another organisation/);
    expect(mailboxRow("mb-1").last_error).toMatch(/another organisation/);
    expect(Date.parse(String(mailboxRow("mb-1").next_send_at))).toBeGreaterThan(at(29).getTime());
  });

  it("does in test mode", async () => {
    db.tables.email_warmup_settings[0].allow_same_organisation = true;
    db.tables.email_warmup_mailboxes = [
      mailbox("mb-1", "one@a.test"),
      mailbox("mb-2", "two@a.test"),
    ];
    expect((await tick(0)).sent).toBe(2);
  });

  it("does not write to a paused mailbox", async () => {
    mailboxRow("mb-sam").status = "paused";
    const summary = await tick(0);
    expect(summary.sent).toBe(0);
    expect(summary.notes.join(" ")).toMatch(/no other mailbox in the pool is warming/);
  });

  it("waits outside the window, and says when it will next send", async () => {
    const evening = 10 * 60; // 20:00 in Sydney
    const summary = await tick(evening);
    expect(summary.sent).toBe(0);
    // Tomorrow from 08:00.
    expect(String(mailboxRow("mb-alex").next_send_at) >= "2026-10-12T21:00:00.000Z").toBe(true);
  });
});

describe("what goes wrong", () => {
  it("records mail that never arrives as missing, after six hours of looking", async () => {
    graph.dropFor.add("sam@b.test");
    await tick(0);
    const lost = messages().find((m) => m.recipient_id === "mb-sam")!;
    await tick(5);
    expect(lost).toMatchObject({ status: "sent", check_attempts: 1 });
    const later = await tick(6 * 60 + 5);
    expect(later.missing).toBeGreaterThanOrEqual(1);
    expect(lost).toMatchObject({ status: "missing" });
    expect(String(lost.error)).toMatch(/never arrived/);
  });

  it("records a draft that never left as failed, and deletes it", async () => {
    graph.stuckDrafts = true;
    await tick(0);
    const stuck = messages()[0];
    await tick(5);
    expect(stuck.status).toBe("sent"); // still waiting: it may yet go
    await tick(50);
    expect(stuck).toMatchObject({ status: "failed" });
    expect(String(stuck.error)).toMatch(/still in Drafts/);
    expect(items(String(stuck.sender_address)).some((i) => i.id === stuck.sender_item_id)).toBe(
      false,
    );
  });

  it("stops a mailbox whose sends keep being refused, with the reason", async () => {
    graph.refuseDraftsFor.add("alex@a.test");
    mailboxRow("mb-sam").status = "paused"; // only Alex sends
    db.tables.email_warmup_mailboxes.push(mailbox("mb-kim", "kim@b.test", { tenant_id: TENANT_B }));
    for (const minutes of [0, 40, 80]) {
      mailboxRow("mb-alex").next_send_at = null;
      await tick(minutes);
    }
    expect(mailboxRow("mb-alex")).toMatchObject({ status: "error", consecutive_failures: 3 });
    expect(String(mailboxRow("mb-alex").status_reason)).toMatch(/refused.*Access is denied/);
    expect(messages().filter((m) => m.status === "failed")).toHaveLength(3);
  });

  it("finishes rows a dead pass left half-sent", async () => {
    db.tables.email_warmup_messages.push(
      {
        id: "orphan-1",
        thread_id: "orphan-1",
        sender_id: "mb-alex",
        recipient_id: "mb-sam",
        sender_address: "alex@a.test",
        recipient_address: "sam@b.test",
        subject: "x",
        status: "sending",
        sender_item_id: null,
        created_at: at(-30).toISOString(),
        check_attempts: 0,
        action_attempts: 0,
      },
      {
        id: "orphan-2",
        thread_id: "orphan-2",
        sender_id: "mb-alex",
        recipient_id: "mb-sam",
        sender_address: "alex@a.test",
        recipient_address: "sam@b.test",
        subject: "y",
        status: "sending",
        sender_item_id: "imm-x",
        created_at: at(-30).toISOString(),
        check_attempts: 0,
        action_attempts: 0,
      },
    );
    mailboxRow("mb-alex").status = "paused";
    mailboxRow("mb-sam").status = "paused";
    await tick(0);
    expect(messages().find((m) => m.id === "orphan-1")).toMatchObject({ status: "failed" });
    expect(messages().find((m) => m.id === "orphan-2")).toMatchObject({ status: "sent" });
  });
});

describe("pausing", () => {
  it("stops new mail pool-wide, but still files what is in flight", async () => {
    await tick(0);
    await tick(5);
    db.tables.email_warmup_settings[0].paused = true;
    const summary = await tick(8);
    expect(summary).toMatchObject({ paused: true, engaged: 2, sent: 0 });
    expect(db.tables.email_warmup_settings[0].last_tick_note).toMatch(/^the pool is paused/);
  });
});

describe("one pass at a time", () => {
  it("leaves the pool alone while another pass holds it", async () => {
    db.tables.email_warmup_settings[0].lease_until = at(1).toISOString();
    const summary = await tick(0);
    expect(summary.leased).toBe(true);
    expect(messages()).toHaveLength(0);
  });

  it("releases the lease and records what it did", async () => {
    await tick(0);
    const settings = db.tables.email_warmup_settings[0];
    expect(settings.lease_until).toBeNull();
    expect(settings.last_tick_note).toMatch(/^sent 2/);
  });
});

describe("preparing a mailbox", () => {
  it("creates its warmup folder before it sends", async () => {
    mailboxRow("mb-alex").prepared_at = null;
    mailboxRow("mb-alex").warmup_folder_id = null;
    const summary = await tick(0);
    expect(summary.prepared).toBe(1);
    expect(mailboxRow("mb-alex")).toMatchObject({
      warmup_folder_id: "warmup:alex@a.test",
      organisation_id: "org-a",
    });
  });

  it("puts a mailbox whose application cannot file mail into error, saying why", async () => {
    graph.roles = ["Mail.Send"];
    mailboxRow("mb-alex").prepared_at = null;
    await tick(0);
    expect(mailboxRow("mb-alex")).toMatchObject({ status: "error" });
    expect(String(mailboxRow("mb-alex").status_reason)).toMatch(/Mail\.ReadWrite/);
  });
});

describe("an outage is not a missing message", () => {
  const breakSamsTenant = () => {
    db.vault.delete(TENANT_B);
    forgetTenantConfig();
  };
  const mendSamsTenant = () => {
    db.vault.set(
      TENANT_B,
      JSON.stringify({ tenantId: "org-b", clientId: "client-b", clientSecret: "secret-b" }),
    );
    forgetTenantConfig();
  };

  it("keeps looking through hours of failed checks, and finds the mail once it can", async () => {
    await tick(0);
    const toSam = messages().find((m) => m.recipient_id === "mb-sam")!;
    breakSamsTenant();
    // Seven hours on — past the point a search that RAN would call it missing.
    await tick(7 * 60);
    expect(toSam).toMatchObject({ status: "sent" });
    expect(String(toSam.error)).toMatch(/could not reach sam@b\.test/);
    mendSamsTenant();
    await tick(7 * 60 + 30);
    expect(toSam).toMatchObject({ status: "landed", placement: "inbox" });
  });

  it("does not call mail missing when its sending could not be confirmed either", async () => {
    // Sam's message to Alex never arrives, and Sam's own tenant is down, so
    // nobody can say whether it ever left.
    graph.dropFor.add("alex@a.test");
    await tick(0);
    const fromSam = messages().find((m) => m.sender_id === "mb-sam")!;
    breakSamsTenant();
    const summary = await tick(7 * 60);
    expect(summary.missing).toBe(0);
    expect(fromSam).toMatchObject({ status: "sent" });
    expect(String(fromSam.error)).toMatch(/could not confirm it was sent/);
    // Once it can be confirmed, not finding it means what it says.
    mendSamsTenant();
    await tick(7 * 60 + 30);
    expect(fromSam).toMatchObject({ status: "missing" });
  });

  it("gives up after two days as unchecked, never as missing", async () => {
    await tick(0);
    const toSam = messages().find((m) => m.recipient_id === "mb-sam")!;
    breakSamsTenant();
    const summary = await tick(49 * 60);
    expect(summary.missing).toBe(0);
    expect(toSam).toMatchObject({ status: "done", placement: null });
    expect(String(toSam.error)).toMatch(/^could not be checked: could not reach sam@b\.test/);
  });
});

describe("answering", () => {
  // Alex writes to Sam, who always answers; the reply falls due at 10:18.
  async function upToTheReply() {
    await tick(0);
    await tick(5);
    await tick(8);
    const parent = messages().find((m) => m.sender_id === "mb-alex" && m.depth === 0)!;
    expect(parent.status).toBe("engaged");
    return parent;
  }
  const replyDrafts = () => items("sam@b.test").filter((i) => i.subject.startsWith("RE: "));

  it("never answers twice when a pass sent the reply and died before recording it", async () => {
    const parent = await upToTheReply();
    // What a pass that died after the send leaves behind.
    db.tables.email_warmup_messages.push({
      id: "earlier-reply",
      thread_id: parent.thread_id,
      parent_id: parent.id,
      depth: 1,
      sender_id: "mb-sam",
      recipient_id: "mb-alex",
      sender_address: "sam@b.test",
      recipient_address: "alex@a.test",
      subject: `RE: ${String(parent.subject)}`,
      status: "sent",
      sent_at: at(19).toISOString(),
      next_check_at: at(400).toISOString(),
      created_at: at(19).toISOString(),
      check_attempts: 0,
      action_attempts: 0,
    });
    const summary = await tick(20);
    expect(summary.replied).toBe(0);
    expect(replyDrafts()).toHaveLength(0);
    expect(parent).toMatchObject({ status: "done", replied_at: at(19).toISOString() });
    expect(messages().filter((m) => m.parent_id === parent.id)).toHaveLength(1);
  });

  it("waits while a reply is still being sent, rather than writing another", async () => {
    const parent = await upToTheReply();
    db.tables.email_warmup_messages.push({
      id: "in-flight-reply",
      thread_id: parent.thread_id,
      parent_id: parent.id,
      depth: 1,
      sender_id: "mb-sam",
      recipient_id: "mb-alex",
      sender_address: "sam@b.test",
      recipient_address: "alex@a.test",
      subject: "RE: x",
      status: "sending",
      created_at: at(19).toISOString(),
      check_attempts: 0,
      action_attempts: 0,
    });
    await tick(20);
    expect(replyDrafts()).toHaveLength(0);
    expect(parent.status).toBe("engaged");
    expect(String(parent.reply_due_at) > at(20).toISOString()).toBe(true);
  });

  it("does answer again when the earlier attempt failed", async () => {
    const parent = await upToTheReply();
    db.tables.email_warmup_messages.push({
      id: "refused-reply",
      thread_id: parent.thread_id,
      parent_id: parent.id,
      depth: 1,
      sender_id: "mb-sam",
      recipient_id: "mb-alex",
      sender_address: "sam@b.test",
      recipient_address: "alex@a.test",
      subject: "RE: x",
      status: "failed",
      created_at: at(19).toISOString(),
      check_attempts: 0,
      action_attempts: 0,
    });
    const summary = await tick(20);
    expect(summary.replied).toBe(1);
    expect(parent.status).toBe("done");
  });
});
