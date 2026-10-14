// The shared unsubscribe link a message to several contacts carries. Anybody
// holding the email can open it, so two properties are what make it safe, and
// both are tested here against an in-memory database:
//
//   - it removes an address only if THIS campaign sent to it;
//   - it answers the same whether it did or not.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failUpsert: false,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query implements PromiseLike<unknown> {
    private filters: ((row: Row) => boolean)[] = [];
    private op: "select" | "update" | "upsert" = "select";
    private patch: Row = {};
    private one = false;
    constructor(private readonly table: string) {}
    private rows() {
      return (db.tables[this.table] ??= []);
    }
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    maybeSingle() {
      this.one = true;
      return this;
    }
    update(patch: Row) {
      this.op = "update";
      this.patch = patch;
      return this;
    }
    upsert(row: Row) {
      this.op = "upsert";
      this.patch = row;
      return this;
    }
    private run() {
      if (this.op === "upsert") {
        if (db.failUpsert) return { error: { message: "write refused" } };
        const rows = this.rows();
        const at = rows.findIndex((r) => r.email_key === this.patch.email_key);
        if (at >= 0) rows[at] = { ...rows[at], ...this.patch };
        else rows.push({ ...this.patch });
        return { error: null };
      }
      const matching = this.rows().filter((row) => this.filters.every((f) => f(row)));
      if (this.op === "update") {
        for (const row of matching) Object.assign(row, this.patch);
        return { data: matching, error: null };
      }
      return { data: this.one ? (matching[0] ?? null) : matching, error: null };
    }
    then<A, B>(
      resolve?: ((value: unknown) => A | PromiseLike<A>) | null,
      reject?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return Promise.resolve()
        .then(() => this.run())
        .then(resolve, reject);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table) } };
});

const { campaignForLink, readLinkToken, unsubscribeThroughCampaign } =
  await import("./email-unsubscribe.server");

const CAMPAIGN_TOKEN = "a".repeat(64);

beforeEach(() => {
  db.failUpsert = false;
  db.tables = {
    email_campaigns: [
      { id: "camp-npc", unsubscribe_token: CAMPAIGN_TOKEN },
      { id: "camp-other", unsubscribe_token: "b".repeat(64) },
    ],
    email_campaign_recipients: [
      {
        campaign_id: "camp-npc",
        email: "Bob@Agency.com.au",
        email_key: "bob@agency.com.au",
        status: "sent",
      },
      // The same person, still waiting in another campaign.
      {
        campaign_id: "camp-other",
        email: "bob@agency.com.au",
        email_key: "bob@agency.com.au",
        status: "pending",
      },
      // Somebody only the OTHER campaign has.
      {
        campaign_id: "camp-other",
        email: "eve@elsewhere.com",
        email_key: "eve@elsewhere.com",
        status: "pending",
      },
    ],
    email_suppressions: [],
  };
});

describe("the shared unsubscribe link", () => {
  it("finds the campaign its token names, and reads only token-shaped values", async () => {
    expect(await campaignForLink(CAMPAIGN_TOKEN)).toMatchObject({ id: "camp-npc" });
    expect(await campaignForLink("c".repeat(64))).toBeNull();
    expect(readLinkToken(` ${"A".repeat(64)} `)).toBe("a".repeat(64));
    expect(readLinkToken("not-a-token")).toBeNull();
    expect(readLinkToken(null)).toBeNull();
  });

  it("removes an address the campaign sent to, however it is typed, from every campaign", async () => {
    const outcome = await unsubscribeThroughCampaign("camp-npc", "  BOB@agency.com.au ");

    expect(outcome).toEqual({ kind: "accepted", address: "bob@agency.com.au" });
    expect(db.tables.email_suppressions).toEqual([
      expect.objectContaining({
        email_key: "bob@agency.com.au",
        reason: "unsubscribed",
        source: "unsubscribe_link",
        campaign_id: "camp-npc",
      }),
    ]);
    // Their pending send in the other campaign stops too.
    expect(db.tables.email_campaign_recipients[1]).toMatchObject({ status: "suppressed" });
  });

  it("removes nobody the campaign did not send to, and says the same thing", async () => {
    // Eve is on another campaign's list: this campaign's link cannot remove her.
    expect(await unsubscribeThroughCampaign("camp-npc", "eve@elsewhere.com")).toEqual({
      kind: "accepted",
      address: "eve@elsewhere.com",
    });
    expect(await unsubscribeThroughCampaign("camp-npc", "stranger@nowhere.com")).toEqual({
      kind: "accepted",
      address: "stranger@nowhere.com",
    });
    expect(db.tables.email_suppressions).toEqual([]);
    expect(db.tables.email_campaign_recipients[2]).toMatchObject({ status: "pending" });
  });

  it("asks again for something that is not an address", async () => {
    expect(await unsubscribeThroughCampaign("camp-npc", "bob at agency")).toEqual({
      kind: "invalid_address",
    });
    expect(db.tables.email_suppressions).toEqual([]);
  });

  it("does not say an address was removed when the register refused the write", async () => {
    db.failUpsert = true;
    expect(await unsubscribeThroughCampaign("camp-npc", "bob@agency.com.au")).toEqual({
      kind: "failed",
    });
    expect(db.tables.email_campaign_recipients[1]).toMatchObject({ status: "pending" });
  });
});
