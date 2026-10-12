// One dispatcher tick, driven through the real code against an in-memory
// database and a scripted Microsoft. Each case is a property that, if it broke,
// would show up in a recipient's inbox rather than on any screen:
//
//   - a message carries exactly the bytes that were attached, or nothing is
//     claimed at all;
//   - a refusal that is about the MAILBOX returns its contacts to the queue
//     and pauses the campaign, rather than marking the whole list refused;
//   - repeated refusals of any kind stop the campaign;
//   - a send that never left (a draft that could not be built) is retried,
//     and one that may have left (unconfirmed) is not, and keeps its draft id.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/email/attachments.pure";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  objects: new Map<string, Uint8Array>(),
  deliveries: [] as { mailbox: string; message: Record<string, unknown>; attachments: unknown[] }[],
  outcomes: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  seq: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Filter = (row: Record<string, unknown>) => boolean;

  class Query implements PromiseLike<unknown> {
    private op: "select" | "update" | "insert" = "select";
    private filters: Filter[] = [];
    private patch: Record<string, unknown> = {};
    private inserts: Record<string, unknown>[] = [];
    private returning = false;
    private count = false;
    private head = false;
    private limitTo = Infinity;
    private orderBy: { column: string; ascending: boolean; nullsFirst?: boolean }[] = [];
    private one: "single" | "maybe" | null = null;

    constructor(private readonly table: string) {}

    private rows() {
      return (db.tables[this.table] ??= []);
    }

    select(_columns?: string, options?: { count?: string; head?: boolean }) {
      if (this.op === "select") {
        this.count = Boolean(options?.count);
        this.head = Boolean(options?.head);
      }
      this.returning = true;
      return this;
    }
    update(patch: Record<string, unknown>) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
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
    gte(column: string, value: string) {
      this.filters.push((row) => row[column] != null && String(row[column]) >= value);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }
    not(column: string, operator: string, value: unknown) {
      if (operator !== "is" || value !== null) throw new Error("fake: unsupported not()");
      this.filters.push((row) => row[column] != null);
      return this;
    }
    order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
      this.orderBy.push({ column, ascending: options.ascending ?? true, ...options });
      return this;
    }
    limit(n: number) {
      this.limitTo = n;
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
      let data: Record<string, unknown>[] = [];
      if (this.op === "insert") {
        for (const input of this.inserts) {
          const row = { id: `row-${++db.seq}`, ...input };
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
        data = data.slice(0, this.limitTo);
      }
      const copy = data.map((row) => ({ ...row }));
      if (this.count) return { data: this.head ? null : copy, count: copy.length, error: null };
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
      storage: {
        from: () => ({
          download: async (path: string) => {
            const bytes = db.objects.get(path);
            return bytes
              ? { data: new Blob([bytes as unknown as BlobPart]), error: null }
              : { data: null, error: { message: "Object not found" } };
          },
        }),
      },
    },
  };
});

vi.mock("@/server/graph-client", () => ({
  isGraphConfigured: () => true,
  defaultMailbox: () => "hello@aurixa.test",
  accessToken: async () => "token",
  GraphError: class GraphError extends Error {},
  deliverMessage: async (
    mailbox: string,
    message: Record<string, unknown>,
    attachments: unknown[],
  ) => {
    db.deliveries.push({ mailbox, message, attachments });
    return (
      db.outcomes.shift() ?? {
        kind: "sent",
        status: 202,
        requestId: "rq",
        path: "sendmail",
        draftId: null,
      }
    );
  },
}));

vi.mock("@/server/audit.server", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => {
    db.audits.push(entry);
  },
}));

const { dispatchDueCampaigns, REFUSALS_BEFORE_PAUSE } = await import("./email-campaigns.server");

const NOW = new Date("2026-10-12T03:00:00.000Z");
const PDF = new TextEncoder().encode("%PDF-1.7 the brochure");

function campaign(over: Row = {}): Row {
  return {
    id: "camp-1",
    name: "October brochure",
    status: "running",
    from_mailbox: "sales@aurixa.test",
    from_name: null,
    reply_to: null,
    subject_template: "Our brochure",
    body_template: '<p>Hello</p><img src="cid:logo.png">',
    body_format: "html",
    timezone: "UTC",
    send_days: [1, 2, 3, 4, 5, 6, 7],
    window_start: "00:00:00",
    window_end: "23:59:00",
    max_messages_per_day: null,
    max_recipients_per_day: null,
    recipients_per_message: 1,
    min_gap_seconds: 0,
    max_messages_per_run: 20,
    starts_at: null,
    ends_at: null,
    last_message_at: null,
    ...over,
  };
}

function recipients(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `rcpt-${i + 1}`,
    campaign_id: "camp-1",
    email: `reader${i + 1}@example.test`,
    email_key: `reader${i + 1}@example.test`,
    status: "pending",
    position: i + 1,
    attempts: 0,
    attributes: {},
    attributes_norm: {},
    unsubscribe_token: `tok${i + 1}`,
  }));
}

async function attach(id: string, name: string, bytes: Uint8Array, stored = bytes) {
  const path = `camp-1/${id}/${name}`;
  db.objects.set(path, stored);
  db.tables.email_campaign_attachments.push({
    id,
    campaign_id: "camp-1",
    file_name: name,
    content_type: "application/pdf",
    size_bytes: bytes.length,
    storage_path: path,
    sha256: await sha256Hex(bytes),
    content_id: name.toLowerCase(),
    position: db.tables.email_campaign_attachments.length,
    created_at: NOW.toISOString(),
  });
}

const statuses = () =>
  (db.tables.email_campaign_recipients ?? []).map((row) => `${row.id}:${row.status}`);

beforeEach(() => {
  db.tables = {
    email_campaigns: [campaign()],
    email_campaign_recipients: recipients(4),
    email_campaign_messages: [],
    email_campaign_quotas: [],
    email_campaign_attachments: [],
    email_suppressions: [],
  };
  db.objects.clear();
  db.deliveries = [];
  db.outcomes = [];
  db.audits = [];
});

describe("a tick with attachments", () => {
  it("sends every message with the verified bytes and records what each carried", async () => {
    await attach("att-1", "brochure.pdf", PDF);
    await attach("att-2", "logo.png", new Uint8Array([137, 80, 78, 71]));

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(summary).toMatchObject({ messages: 4, recipients: 4, failed: 0, paused: 0 });
    expect(db.deliveries).toHaveLength(4);
    expect(db.deliveries[0].mailbox).toBe("sales@aurixa.test");
    const files = db.deliveries[0].attachments as {
      name: string;
      bytes: Uint8Array;
      isInline: boolean;
    }[];
    expect(files.map((f) => [f.name, f.isInline])).toEqual([
      ["brochure.pdf", false],
      // The body shows cid:logo.png, so the logo travels inline.
      ["logo.png", true],
    ]);
    expect([...files[0].bytes]).toEqual([...PDF]);

    const message = db.tables.email_campaign_messages[0];
    expect(message).toMatchObject({
      status: "sent",
      attachment_count: 2,
      attachment_bytes: PDF.length + 4,
    });
    expect(message.attachments).toEqual([
      expect.objectContaining({ id: "att-1", file_name: "brochure.pdf", inline: false }),
      expect.objectContaining({ id: "att-2", file_name: "logo.png", inline: true }),
    ]);
    expect(statuses()).toEqual(["rcpt-1:sent", "rcpt-2:sent", "rcpt-3:sent", "rcpt-4:sent"]);
  });

  it("claims nobody when a stored file no longer matches what was attached", async () => {
    await attach("att-x", "brochure.pdf", PDF, new TextEncoder().encode("%PDF-1.7 tampered!!!!"));

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(db.deliveries).toEqual([]);
    expect(summary.messages).toBe(0);
    expect(summary.skipped.join(" ")).toMatch(/nothing was claimed.*no longer matches/);
    expect(statuses()).toEqual([
      "rcpt-1:pending",
      "rcpt-2:pending",
      "rcpt-3:pending",
      "rcpt-4:pending",
    ]);
    expect(db.tables.email_campaign_messages).toEqual([]);
  });

  it("claims nobody when a file is missing from storage", async () => {
    await attach("att-y", "brochure.pdf", PDF);
    db.objects.clear();

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(db.deliveries).toEqual([]);
    expect(summary.skipped.join(" ")).toMatch(/could not be read from storage/);
    expect(statuses().every((s) => s.endsWith(":pending"))).toBe(true);
  });
});

describe("refusals", () => {
  it("returns the contacts and pauses the campaign when the MAILBOX is refused", async () => {
    db.outcomes.push({
      kind: "refused",
      status: 403,
      code: "ErrorAccessDenied",
      message: "Access is denied.",
      path: "sendmail",
      draftId: null,
    });

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(db.deliveries).toHaveLength(1);
    expect(summary).toMatchObject({ messages: 0, failed: 0, paused: 1 });
    // Nothing was sent, so nobody is marked refused — they are all still owed.
    expect(statuses().every((s) => s.endsWith(":pending"))).toBe(true);
    const row = db.tables.email_campaigns[0];
    expect(row.status).toBe("paused");
    expect(String(row.paused_reason)).toMatch(/sales@aurixa\.test.*Nothing was sent/);
    expect(db.audits[0]).toMatchObject({ action: "email_campaign_paused_by_dispatcher" });
  });

  it("does the same for a message too large for the mailbox", async () => {
    db.outcomes.push({
      kind: "refused",
      status: 413,
      code: "ErrorMessageSizeExceeded",
      message: "too big",
      path: "draft",
      draftId: null,
    });
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(summary.paused).toBe(1);
    expect(String(db.tables.email_campaigns[0].paused_reason)).toMatch(/attachments/);
    expect(statuses().every((s) => s.endsWith(":pending"))).toBe(true);
  });

  it("keeps an address problem on the address and carries on", async () => {
    db.outcomes.push({
      kind: "refused",
      status: 400,
      code: "ErrorInvalidRecipients",
      message: "bad address",
      path: "sendmail",
      draftId: null,
    });
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(summary).toMatchObject({ messages: 4, failed: 1, recipients: 3, paused: 0 });
    expect(statuses()).toEqual(["rcpt-1:failed", "rcpt-2:sent", "rcpt-3:sent", "rcpt-4:sent"]);
  });

  it(`pauses after ${REFUSALS_BEFORE_PAUSE} refusals in a row, whatever they were`, async () => {
    for (let i = 0; i < 4; i++) {
      db.outcomes.push({
        kind: "refused",
        status: 400,
        code: "SomethingNew",
        message: `odd ${i}`,
        path: "sendmail",
        draftId: null,
      });
    }
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(db.deliveries).toHaveLength(REFUSALS_BEFORE_PAUSE);
    expect(summary.paused).toBe(1);
    expect(statuses()).toEqual([
      "rcpt-1:failed",
      "rcpt-2:failed",
      "rcpt-3:failed",
      "rcpt-4:pending",
    ]);
    expect(String(db.tables.email_campaigns[0].paused_reason)).toMatch(/in a row.*odd 2/);
  });
});

describe("sends that may or may not have left", () => {
  it("releases the claim when a draft could not even be built", async () => {
    db.outcomes.push({
      kind: "deferred",
      message: "uploading brochure.pdf: Graph answered 502",
      path: "draft",
      draftId: null,
    });
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(db.deliveries).toHaveLength(1);
    expect(summary.messages).toBe(0);
    expect(summary.skipped.join(" ")).toMatch(/nothing was sent this tick/);
    expect(statuses().every((s) => s.endsWith(":pending"))).toBe(true);
    expect(db.tables.email_campaigns[0].status).toBe("running");
  });

  it("never releases an unconfirmed draft send, and records the draft to look for", async () => {
    db.outcomes.push({
      kind: "unconfirmed",
      message: "connection reset — if draft d-9 is still in the mailbox's Drafts folder…",
      path: "draft",
      draftId: "d-9",
    });
    await dispatchDueCampaigns({ now: NOW });
    expect(statuses()[0]).toBe("rcpt-1:unconfirmed");
    expect(db.tables.email_campaign_messages[0]).toMatchObject({
      status: "unconfirmed",
      graph_draft_id: "d-9",
    });
  });
});
