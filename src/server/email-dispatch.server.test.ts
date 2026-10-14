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
//     and one that may have left (unconfirmed) is not, and keeps its draft id;
//   - a campaign sends through its own Microsoft tenant's credentials, and a
//     tenant whose credentials fail holds up only its own campaigns;
//   - a campaign with sending times sends at them and not between, and a
//     segmented one sends each segment its own message — one state per BCC
//     line — and no more than its share of each sending time;
//   - a campaign whose contacts are bouncing past its limit, or whose mailbox's
//     warmup mail is landing in spam, stops itself; and a contact at a domain
//     that takes no mail is stepped over, not sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/email/attachments.pure";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  objects: new Map<string, Uint8Array>(),
  deliveries: [] as {
    mailbox: string;
    message: Record<string, unknown>;
    attachments: unknown[];
    tenant: string | undefined;
  }[],
  /** Vault, by tenant id: what `microsoft_tenant_credentials` returns. */
  vault: new Map<string, string>(),
  /** Tenant config keys whose token request Microsoft refuses. */
  refusedTokens: new Set<string>(),
  outcomes: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  /** Recipient domains DNS says take no mail, with why. */
  deadDomains: new Map<string, string>(),
  /** Set to make the domain check throw, as a resolver outage would. */
  domainCheckFails: false,
  seq: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  type Row = Record<string, unknown>;
  type Filter = (row: Row) => boolean;

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
    is(column: string, value: null) {
      this.filters.push((row) => (row[column] ?? null) === value);
      return this;
    }
    gte(column: string, value: string) {
      this.filters.push((row) => row[column] != null && String(row[column]) >= value);
      return this;
    }
    lt(column: string, value: string) {
      this.filters.push((row) => row[column] != null && String(row[column]) < value);
      return this;
    }
    /** Only the shape the lease uses: `col.is.null,col.lt."<iso>"`. */
    or(expression: string) {
      const terms = (expression.match(/(?:[^,"]|"[^"]*")+/g) ?? []).map((term) => {
        const [column, operator, ...rest] = term.split(".");
        const value = rest.join(".").replace(/^"|"$/g, "");
        if (operator === "is" && value === "null") return (row: Row) => row[column] == null;
        if (operator === "lt") {
          return (row: Row) => row[column] != null && String(row[column]) < value;
        }
        throw new Error(`fake: unsupported or() term ${term}`);
      });
      this.filters.push((row) => terms.some((test) => test(row)));
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
    /** Only the shape quotas and segments use: `attributes_norm->>key`, `in`, a pgInList. */
    filter(column: string, operator: string, list: string) {
      if (operator !== "in") throw new Error(`fake: unsupported filter ${operator}`);
      const [base, key] = column.split("->>");
      const values = JSON.parse(`[${list.slice(1, -1)}]`) as string[];
      this.filters.push((row) => {
        const value = key ? (row[base] as Record<string, unknown> | null)?.[key] : row[column];
        return values.includes(value as string);
      });
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
          const row: Record<string, unknown> = { id: `row-${++db.seq}`, ...input };
          // The column default the real table has, which the ledger reads.
          if (this.table === "email_campaign_messages" && row.queued_at == null) {
            row.queued_at = new Date().toISOString();
          }
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
      rpc: async (name: string, args: { p_tenant: string }) => {
        if (name !== "microsoft_tenant_credentials") throw new Error(`fake: no rpc ${name}`);
        return { data: db.vault.get(args.p_tenant) ?? null, error: null };
      },
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

vi.mock("@/server/graph-client", () => {
  class GraphError extends Error {}
  return {
    defaultGraphConfig: () => ({
      tenantId: "deployment-tenant",
      clientId: "deployment-client",
      clientSecret: "deployment-secret",
      mailbox: "hello@aurixa.test",
      key: "default",
    }),
    accessToken: async (config: { key?: string; label?: string }) => {
      if (config.key && db.refusedTokens.has(config.key)) {
        throw new GraphError(`Microsoft rejected the application credentials for ${config.label}`);
      }
      return "token";
    },
    forgetToken: () => {},
    probeMailboxes: async () => [],
    GraphError,
    deliverMessage: async (
      mailbox: string,
      message: Record<string, unknown>,
      attachments: unknown[],
      config: { tenantId: string },
    ) => {
      db.deliveries.push({ mailbox, message, attachments, tenant: config?.tenantId });
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
  };
});

vi.mock("@/server/email-domain-health.server", () => ({
  deadRecipientDomains: async (domains: string[]) => {
    if (db.domainCheckFails) throw new Error("resolver unreachable");
    return new Map(
      domains.filter((d) => db.deadDomains.has(d)).map((d) => [d, db.deadDomains.get(d)!]),
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
    unsubscribe_token: "camptoken",
    started_at: null,
    bounce_pause_percent: 5,
    warmup_guard: true,
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
    email_campaign_segments: [],
    email_campaign_attachments: [],
    email_suppressions: [],
    email_campaign_bounces: [],
    email_warmup_mailboxes: [],
    email_warmup_daily: [],
    microsoft_tenants: [],
  };
  db.deadDomains.clear();
  db.domainCheckFails = false;
  db.vault.clear();
  db.refusedTokens.clear();
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

describe("one pass per campaign, however many ticks arrive", () => {
  it("lets only one of two simultaneous ticks work the campaign", async () => {
    // pg_net delivers ticks in bursts; two calls landing together must not
    // both read the same last_message_at and both send.
    db.tables.email_campaigns = [campaign({ min_gap_seconds: 60 })];
    const [first, second] = await Promise.all([
      dispatchDueCampaigns({ now: NOW, budgetMs: 1000 }),
      dispatchDueCampaigns({ now: NOW, budgetMs: 1000 }),
    ]);
    expect(first.leased + second.leased).toBe(1);
    // The gap is 60 s and the budget 1 s: exactly one message between them.
    expect(db.deliveries).toHaveLength(1);
    const row = db.tables.email_campaigns[0];
    expect(row.dispatch_lease_until).toBeNull();
    expect(row.dispatch_lease_token).toBeNull();
  });

  it("leaves a campaign alone while another pass holds an unexpired lease", async () => {
    db.tables.email_campaigns = [
      campaign({
        dispatch_lease_until: new Date(Date.now() + 60_000).toISOString(),
        dispatch_lease_token: "someone-else",
      }),
    ];
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(summary).toMatchObject({ leased: 1, campaigns: 0, messages: 0 });
    expect(db.deliveries).toEqual([]);
    // Not ours to release.
    expect(db.tables.email_campaigns[0].dispatch_lease_token).toBe("someone-else");
  });

  it("takes over a lease its holder never released", async () => {
    db.tables.email_campaigns = [
      campaign({
        dispatch_lease_until: new Date(Date.now() - 1000).toISOString(),
        dispatch_lease_token: "died",
      }),
    ];
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(summary.leased).toBe(0);
    expect(summary.messages).toBe(4);
  });
});

describe("a pass that covers the wait for the next one", () => {
  it("waits out the gap inside the pass and keeps sending, spaced by it", async () => {
    db.tables.email_campaigns = [campaign({ min_gap_seconds: 1 })];
    const started = Date.now();
    const times: number[] = [];
    const deliveries = db.deliveries;
    const push = deliveries.push.bind(deliveries);
    deliveries.push = (...items) => {
      times.push(Date.now() - started);
      return push(...items);
    };

    const summary = await dispatchDueCampaigns({ now: NOW, budgetMs: 2500 });

    // t ≈ 0, 1 s, 2 s; a fourth would start after the 2.5 s budget.
    expect(summary.messages).toBe(3);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(950);
    }
    expect(statuses()).toEqual(["rcpt-1:sent", "rcpt-2:sent", "rcpt-3:sent", "rcpt-4:pending"]);
    const row = db.tables.email_campaigns[0];
    expect(row.last_tick_note).toMatch(/sent 3 messages; waiting out the gap/);
    // The next message is due one gap after the last one.
    expect(Date.parse(String(row.next_send_at)) - Date.parse(String(row.last_message_at))).toBe(
      1000,
    );
  }, 10_000);

  it("stops mid-pass when an operator pauses the campaign", async () => {
    db.tables.email_campaigns = [campaign({ min_gap_seconds: 1 })];
    const deliveries = db.deliveries;
    const push = deliveries.push.bind(deliveries);
    deliveries.push = (...items) => {
      db.tables.email_campaigns[0].status = "paused";
      return push(...items);
    };

    const summary = await dispatchDueCampaigns({ now: NOW, budgetMs: 5000 });

    expect(summary.messages).toBe(1);
    const row = db.tables.email_campaigns[0];
    expect(row.last_tick_note).toMatch(/stopped: the campaign is now paused/);
    expect(row.next_send_at).toBeNull();
  }, 10_000);

  it("stops mid-pass when the window closes, and records when it reopens", async () => {
    // 23:58:59.4 UTC with a window ending at 23:59: the first message goes,
    // the second would be due after the close.
    //
    // The wall clock is pinned to the same instant. A sent message is stamped
    // with `new Date()` and the next send is measured from that stamp, so on
    // the real clock this asserted a date that had already passed from
    // 13 Oct 2026 00:00 UTC onwards. Only `Date` is faked: the pass still
    // sleeps out its gaps on real timers, and the pinned clock advances with
    // them.
    const now = new Date("2026-10-12T23:58:59.400Z");
    vi.useFakeTimers({ toFake: ["Date"], now, shouldAdvanceTime: true });
    try {
      db.tables.email_campaigns = [campaign({ min_gap_seconds: 1 })];
      const summary = await dispatchDueCampaigns({ now, budgetMs: 5000 });

      expect(summary.messages).toBe(1);
      const row = db.tables.email_campaigns[0];
      expect(row.last_tick_note).toMatch(/outside the 00:00–23:59 window \(UTC\)/);
      // Tomorrow's 00:00 UTC opening.
      expect(row.next_send_at).toBe("2026-10-13T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});

describe("what a pass leaves behind", () => {
  it("records why it did not send and when it next will", async () => {
    // Monday 12 Oct 2026, 19:03 Sydney: the case that prompted this.
    db.tables.email_campaigns = [
      campaign({
        timezone: "Australia/Sydney",
        send_days: [1, 2, 3, 4, 5],
        window_start: "09:00:00",
        window_end: "17:00:00",
        min_gap_seconds: 60,
      }),
    ];
    await dispatchDueCampaigns({ now: new Date("2026-10-12T08:03:00Z") });

    expect(db.deliveries).toEqual([]);
    const row = db.tables.email_campaigns[0];
    expect(row.last_tick_note).toBe("outside the 09:00–17:00 window (Australia/Sydney)");
    expect(row.next_send_at).toBe("2026-10-12T22:00:00.000Z"); // Tue 09:00 Sydney
    expect(row.last_tick_at).toEqual(expect.any(String));
  });

  it("records a contact stranded as claimed by a pass that never finished as unconfirmed", async () => {
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    Object.assign(db.tables.email_campaign_recipients[0], { status: "claimed", claimed_at: stale });
    db.tables.email_campaign_messages.push({
      id: "msg-stranded",
      campaign_id: "camp-1",
      status: "sending",
      queued_at: stale,
    });

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(summary.stranded).toBe(1);
    // Never back to pending: the message may have left.
    expect(statuses()[0]).toBe("rcpt-1:unconfirmed");
    expect(db.tables.email_campaign_messages[0]).toMatchObject({
      id: "msg-stranded",
      status: "unconfirmed",
    });
    // The other three went out as usual.
    expect(summary.messages).toBe(3);
  });

  it("lets a campaign complete once a stranded claim is resolved", async () => {
    db.tables.email_campaign_recipients = recipients(1).map((row) => ({
      ...row,
      status: "claimed",
      claimed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    }));
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(summary.completed).toBe(1);
    expect(db.tables.email_campaigns[0].status).toBe("completed");
  });
});

describe("a campaign on an added Microsoft tenant", () => {
  const TENANT = "11111111-2222-4333-8444-555555555555";

  function addTenant(over: Row = {}) {
    db.tables.microsoft_tenants.push({
      id: TENANT,
      label: "Partner tenant",
      default_mailbox: "partner@partner.test",
      credentials_version: 2,
      removed_at: null,
      vault_secret_id: "vault-1",
      ...over,
    });
    db.vault.set(
      TENANT,
      JSON.stringify({
        tenantId: "partner-tenant",
        clientId: "partner-client",
        clientSecret: "partner-secret",
      }),
    );
  }

  beforeEach(async () => {
    const { forgetTenantConfig } = await import("@/server/microsoft-tenants.server");
    forgetTenantConfig();
  });

  it("sends with that tenant's credentials and records the tenant on every message", async () => {
    addTenant();
    db.tables.email_campaigns = [campaign({ tenant_id: TENANT, from_mailbox: null })];

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(summary.messages).toBe(4);
    expect(db.deliveries.map((d) => d.tenant)).toEqual(Array(4).fill("partner-tenant"));
    // No mailbox of its own: the tenant's default, not the deployment's.
    expect(db.deliveries.map((d) => d.mailbox)).toEqual(Array(4).fill("partner@partner.test"));
    expect(db.tables.email_campaign_messages.map((m) => m.tenant_id)).toEqual(
      Array(4).fill(TENANT),
    );
  });

  it("claims nothing when the tenant's credentials are refused, and the deployment's campaigns still send", async () => {
    addTenant();
    db.refusedTokens.add(`tenant:${TENANT}:v2`);
    db.tables.email_campaigns = [
      campaign({ tenant_id: TENANT }),
      campaign({ id: "camp-2", name: "Deployment campaign" }),
    ];
    db.tables.email_campaign_recipients.push(
      ...recipients(2).map((row) => ({ ...row, id: `other-${row.id}`, campaign_id: "camp-2" })),
    );

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(statuses().filter((s) => s.startsWith("rcpt-"))).toEqual([
      "rcpt-1:pending",
      "rcpt-2:pending",
      "rcpt-3:pending",
      "rcpt-4:pending",
    ]);
    expect(summary.skipped.join(" ")).toMatch(
      /October brochure: nothing was claimed: Microsoft rejected the application credentials for Partner tenant/,
    );
    expect(db.deliveries.map((d) => d.tenant)).toEqual(["deployment-tenant", "deployment-tenant"]);
  });

  it("claims nothing when the tenant was removed", async () => {
    addTenant({ removed_at: NOW.toISOString(), vault_secret_id: null });
    db.vault.clear();
    db.tables.email_campaigns = [campaign({ tenant_id: TENANT })];

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(db.deliveries).toEqual([]);
    expect(statuses().every((s) => s.endsWith(":pending"))).toBe(true);
    expect(summary.skipped.join(" ")).toMatch(/"Partner tenant" was removed/);
  });
});

describe("sending times and segments", () => {
  // Monday 12 Oct 2026, 09:05 UTC: five minutes into the 09:00 sending time.
  const AT_0905 = new Date("2026-10-12T09:05:00.000Z");
  const SLOT_0900 = "2026-10-12T09:00:00.000Z";

  /** The scenario in miniature: three states, two contacts to a message, one message each per time. */
  function bySegment(over: Row = {}): Row {
    return campaign({
      send_times: ["09:00:00", "13:00:00"],
      slot_grace_minutes: 30,
      max_messages_per_slot: null,
      segment_dimension: "state",
      segment_messages_per_slot: 1,
      recipients_per_message: 2,
      subject_template: "News for {{state}}",
      body_template: "<p>Hello {{state}}</p>",
      ...over,
    });
  }

  function stateRecipients(): Row[] {
    const states: [string, string][] = [
      ["NSW", "nsw"],
      ["New South Wales", "new south wales"],
      ["VIC", "vic"],
      ["QLD", "qld"],
      ["NSW", "nsw"],
      ["VIC", "vic"],
      ["QLD", "qld"],
      ["ACT", "act"],
    ];
    return states.map(([state, norm], i) => ({
      ...recipients(i + 1)[i],
      attributes: { state },
      attributes_norm: { state: norm },
    }));
  }

  function segments(over: Record<string, Row> = {}): Row[] {
    return [
      { id: "seg-nsw", label: "NSW", match_values: ["nsw", "new south wales"], position: 0 },
      { id: "seg-vic", label: "VIC", match_values: ["vic"], position: 1 },
      { id: "seg-qld", label: "QLD", match_values: ["qld"], position: 2 },
    ].map((row) => ({ campaign_id: "camp-1", enabled: true, ...row, ...over[row.id as string] }));
  }

  const bcc = (delivery: (typeof db.deliveries)[number]) =>
    ((delivery.message.bccRecipients ?? []) as { emailAddress: { address: string } }[]).map(
      (r) => r.emailAddress.address,
    );

  beforeEach(() => {
    db.tables.email_campaigns = [bySegment()];
    db.tables.email_campaign_recipients = stateRecipients();
    db.tables.email_campaign_segments = segments();
  });

  it("sends each segment one message at the sending time, every contact in it from that segment", async () => {
    const summary = await dispatchDueCampaigns({ now: AT_0905 });

    expect(summary).toMatchObject({ messages: 3, recipients: 6 });
    // Two to a message, never mixed: both spellings of NSW travel together.
    expect(db.deliveries.map(bcc)).toEqual([
      ["reader1@example.test", "reader2@example.test"],
      ["reader3@example.test", "reader6@example.test"],
      ["reader4@example.test", "reader7@example.test"],
    ]);
    // The segment column renders the segment's label, though the message is batched.
    expect(db.deliveries.map((d) => d.message.subject)).toEqual([
      "News for NSW",
      "News for VIC",
      "News for QLD",
    ]);
    expect(
      db.tables.email_campaign_messages.map((m) => [m.segment_id, m.segment_label, m.slot_at]),
    ).toEqual([
      ["seg-nsw", "NSW", SLOT_0900],
      ["seg-vic", "VIC", SLOT_0900],
      ["seg-qld", "QLD", SLOT_0900],
    ]);
    const row = db.tables.email_campaigns[0];
    expect(row.last_tick_note).toMatch(/everything the 09:00 sending time may send/);
    expect(row.next_send_at).toBe("2026-10-12T13:00:00.000Z");
  });

  it("sends nothing more in the same sending time, however many ticks arrive", async () => {
    await dispatchDueCampaigns({ now: AT_0905 });
    await dispatchDueCampaigns({ now: new Date("2026-10-12T09:12:00.000Z") });
    expect(db.deliveries).toHaveLength(3);
    expect(statuses().filter((s) => s.endsWith(":pending"))).toHaveLength(2);
  });

  it("picks up a sending time part-sent before a pause, without repeating a segment", async () => {
    db.tables.email_campaign_messages.push({
      id: "earlier",
      campaign_id: "camp-1",
      status: "sent",
      segment_id: "seg-nsw",
      segment_label: "NSW",
      slot_at: SLOT_0900,
      queued_at: new Date().toISOString(),
    });
    await dispatchDueCampaigns({ now: AT_0905 });
    expect(db.deliveries.map((d) => d.message.subject)).toEqual(["News for VIC", "News for QLD"]);
  });

  it("does not send between sending times, and names the next one", async () => {
    const summary = await dispatchDueCampaigns({ now: new Date("2026-10-12T10:00:00.000Z") });
    expect(summary.messages).toBe(0);
    expect(db.deliveries).toEqual([]);
    const row = db.tables.email_campaigns[0];
    expect(row.last_tick_note).toMatch(/between sending times \(09:00 and 13:00 UTC\)/);
    expect(row.next_send_at).toBe("2026-10-12T13:00:00.000Z");
  });

  it("caps a sending time with no segments at its own limit", async () => {
    db.tables.email_campaigns = [
      campaign({ send_times: ["09:00"], max_messages_per_slot: 2, segment_dimension: null }),
    ];
    db.tables.email_campaign_recipients = recipients(4);
    await dispatchDueCampaigns({ now: AT_0905 });
    expect(db.deliveries).toHaveLength(2);
    expect(db.tables.email_campaign_messages.every((m) => m.slot_at === SLOT_0900)).toBe(true);
    // The next is tomorrow's 09:00: there is only one sending time a day.
    expect(db.tables.email_campaigns[0].next_send_at).toBe("2026-10-13T09:00:00.000Z");
  });

  it("rotates segments message by message across a window", async () => {
    db.tables.email_campaigns = [
      bySegment({ send_times: [], recipients_per_message: 1, max_messages_per_run: 5 }),
    ];
    await dispatchDueCampaigns({ now: NOW });
    expect(db.deliveries.map((d) => d.message.subject)).toEqual([
      "News for NSW",
      "News for VIC",
      "News for QLD",
      "News for NSW",
      "News for VIC",
    ]);
  });

  it("gives a batched message the campaign's shared unsubscribe link, and one contact their own", async () => {
    const body = '<p>Hello {{state}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>';
    db.tables.email_campaigns = [bySegment({ body_template: body })];
    await dispatchDueCampaigns({ now: AT_0905 });

    // The link does not force one contact per message: two to a message, as set.
    expect(db.deliveries.map(bcc).map((line) => line.length)).toEqual([2, 2, 2]);
    for (const delivery of db.deliveries) {
      const content = String((delivery.message.body as { content: string }).content);
      expect(content).toMatch(/unsubscribe\?c=camptoken/);
      // Nobody's own link is put in front of the rest of a BCC line.
      expect(content).not.toMatch(/unsubscribe\?t=/);
    }

    // A message to one contact still carries that contact's one-click link.
    db.deliveries = [];
    db.tables.email_campaigns = [campaign({ body_template: body })];
    db.tables.email_campaign_recipients = recipients(1);
    await dispatchDueCampaigns({ now: NOW });
    const single = String((db.deliveries[0].message.body as { content: string }).content);
    expect(single).toMatch(/unsubscribe\?t=tok1/);
  });

  it("never sends a disabled segment or a contact in no segment", async () => {
    db.tables.email_campaign_segments = segments({ "seg-vic": { enabled: false } });
    db.tables.email_campaigns = [bySegment({ send_times: [], max_messages_per_run: 20 })];
    await dispatchDueCampaigns({ now: NOW });
    const sent = db.tables.email_campaign_recipients
      .filter((r) => r.status === "sent")
      .map((r) => (r.attributes_norm as Record<string, string>).state);
    expect(sent.sort()).toEqual(["new south wales", "nsw", "nsw", "qld", "qld"]);
  });

  it("holds contacts outside every enabled segment rather than completing over them", async () => {
    db.tables.email_campaigns = [bySegment({ send_times: [] })];
    await dispatchDueCampaigns({ now: NOW });
    const after = await dispatchDueCampaigns({ now: NOW });

    expect(after.completed).toBe(0);
    const row = db.tables.email_campaigns[0];
    expect(row.status).toBe("running");
    expect(row.last_tick_note).toMatch(
      /every enabled segment is finished; 1 waiting contact is outside them/,
    );
    expect(row.next_send_at).toBeNull();
    expect(statuses()).toContain("rcpt-8:pending"); // the ACT contact, untouched
  });
});

describe("protecting the sender", () => {
  /** Contacts sent before this tick, the sample a bounce rate is taken over. */
  function alreadySent(n: number, at = "2026-10-11T03:00:00.000Z"): Row[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `old-${i + 1}`,
      campaign_id: "camp-1",
      email: `earlier${i + 1}@example.test`,
      email_key: `earlier${i + 1}@example.test`,
      status: "sent",
      sent_at: at,
      position: 100 + i,
      attempts: 1,
      attributes: {},
      attributes_norm: {},
      unsubscribe_token: `old${i + 1}`,
    }));
  }
  /** The first `n` of those, bounced. */
  const bounced = (n: number, sentAt = "2026-10-11T03:00:00.000Z") =>
    Array.from({ length: n }, (_, i) => ({
      campaign_id: "camp-1",
      recipient_id: `old-${i + 1}`,
      email_key: `earlier${i + 1}@example.test`,
      sent_at: sentAt,
      bounced_at: "2026-10-11T04:00:00.000Z",
    }));

  it("pauses a campaign whose contacts are bouncing past its limit, and sends nothing more", async () => {
    db.tables.email_campaign_recipients.push(...alreadySent(60));
    db.tables.email_campaign_bounces = bounced(4);

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(db.deliveries).toEqual([]);
    expect(summary.paused).toBe(1);
    const row = db.tables.email_campaigns[0];
    expect(row.status).toBe("paused");
    expect(String(row.paused_reason)).toMatch(/4 of the 60 contacts .* hard-bounced \(6\.7%\)/);
    expect(db.audits[0]).toMatchObject({ action: "email_campaign_paused_by_dispatcher" });
    expect(statuses().filter((s) => s.startsWith("rcpt-"))).toEqual([
      "rcpt-1:pending",
      "rcpt-2:pending",
      "rcpt-3:pending",
      "rcpt-4:pending",
    ]);
  });

  it("counts only what was sent since the campaign was last started", async () => {
    db.tables.email_campaign_recipients.push(...alreadySent(60));
    db.tables.email_campaign_bounces = bounced(4);
    // Resumed after the list was cleaned: those bounces were the last run's.
    db.tables.email_campaigns = [campaign({ started_at: "2026-10-12T00:00:00.000Z" })];

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(summary).toMatchObject({ messages: 4, paused: 0 });
  });

  it("warns below the limit, and keeps sending", async () => {
    db.tables.email_campaign_recipients.push(...alreadySent(60));
    db.tables.email_campaign_bounces = bounced(2);

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(summary).toMatchObject({ messages: 4, paused: 0 });
    expect(db.tables.email_campaigns[0].last_tick_note).toMatch(
      /sent 4 messages; hard-bounce rate 3\.3% since it was started \(2 of 60\) — it pauses at 5%/,
    );
  });

  it("only warns when automatic pausing is switched off", async () => {
    db.tables.email_campaign_recipients.push(...alreadySent(60));
    db.tables.email_campaign_bounces = bounced(10);
    db.tables.email_campaigns = [campaign({ bounce_pause_percent: null })];

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(summary).toMatchObject({ messages: 4, paused: 0 });
    expect(db.tables.email_campaigns[0].last_tick_note).toMatch(/automatic pausing is off/);
  });

  const today = () => new Date().toISOString().slice(0, 10);
  const inPool = (inbox: number, junk: number) => {
    // Enrolled under a different spelling of the same address.
    db.tables.email_warmup_mailboxes = [
      { id: "wm-1", mailbox: "Sales@Aurixa.test", status: "active", timezone: "UTC" },
    ];
    db.tables.email_warmup_daily = [
      { mailbox_id: "wm-1", day: today(), inbox, junk, other: 0, missing: 0 },
    ];
  };

  it("pauses when the sending mailbox's own warmup mail is landing in spam", async () => {
    inPool(4, 8);

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(db.deliveries).toEqual([]);
    expect(summary.paused).toBe(1);
    expect(String(db.tables.email_campaigns[0].paused_reason)).toMatch(
      /sales@aurixa\.test's own warmup mail is landing in spam \(33% inbox placement/,
    );
    expect(statuses().every((s) => s.endsWith(":pending"))).toBe(true);
  });

  it("sends from a mailbox whose warmup mail is landing well, or when the guard is off", async () => {
    inPool(18, 2);
    expect(await dispatchDueCampaigns({ now: NOW })).toMatchObject({ messages: 4, paused: 0 });

    db.tables.email_campaign_recipients = recipients(4);
    db.tables.email_campaigns = [campaign({ warmup_guard: false })];
    inPool(4, 8);
    expect(await dispatchDueCampaigns({ now: NOW })).toMatchObject({ messages: 4, paused: 0 });
  });

  it("steps over contacts at a domain that takes no mail, and still fills the message", async () => {
    const list = recipients(6);
    for (const row of [list[1], list[3]]) {
      row.email = String(row.email).replace("example.test", "gone.test");
      row.email_key = row.email;
    }
    db.tables.email_campaign_recipients = list;
    db.tables.email_campaigns = [campaign({ recipients_per_message: 4 })];
    db.deadDomains.set("gone.test", "the domain does not exist");

    const summary = await dispatchDueCampaigns({ now: NOW });

    expect(summary).toMatchObject({ messages: 1, recipients: 4 });
    const bcc = (db.deliveries[0].message.bccRecipients as { emailAddress: { address: string } }[])
      .map((r) => r.emailAddress.address)
      .sort();
    expect(bcc).toEqual([
      "reader1@example.test",
      "reader3@example.test",
      "reader5@example.test",
      "reader6@example.test",
    ]);
    const stepped = db.tables.email_campaign_recipients.filter((r) => r.status === "suppressed");
    expect(stepped.map((r) => r.id)).toEqual(["rcpt-2", "rcpt-4"]);
    expect(stepped[0].suppressed_reason).toBe("gone.test takes no mail: the domain does not exist");
    expect(db.tables.email_campaigns[0].last_tick_note).toMatch(
      /stepped over 2 contacts at a domain that takes no mail \(gone\.test\)/,
    );
  });

  it("sends anyway when the domain check itself fails", async () => {
    db.domainCheckFails = true;
    const summary = await dispatchDueCampaigns({ now: NOW });
    expect(summary).toMatchObject({ messages: 4, recipients: 4, paused: 0 });
  });
});
