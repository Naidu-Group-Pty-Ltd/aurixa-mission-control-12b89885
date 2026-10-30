import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  describeGiftCampaignExpiry,
  rollUpGiftCampaigns,
  type GiftLedgerRow,
} from "./giftCampaigns.pure";

/** One ledger row as `bulkGiftTokens` writes it, newest first as the list reads them. */
const row = (over: Partial<GiftLedgerRow> = {}): GiftLedgerRow => ({
  source_ref: "promo:abc:123",
  tokens: 1000,
  reason: "Promotional grant",
  metadata: { campaign_name: "October launch bonus", granted_by: "Ops" },
  created_at: "2026-10-29T01:00:00+00:00",
  expires_at: "2026-11-30T12:59:00+00:00",
  ...over,
});

const single = (rows: GiftLedgerRow[]) => {
  const campaigns = rollUpGiftCampaigns(rows);
  expect(campaigns).toHaveLength(1);
  return campaigns[0];
};

/*
 * Every row of a campaign carries the expiry it was granted with, and the
 * list of past campaigns never read it back: an operator who set one could
 * not see it anywhere afterwards.
 */
describe("a campaign's expiry is read back", () => {
  it("as the one instant its rows share", () => {
    const c = single([row(), row(), row()]);
    expect(c.expiry).toEqual({ kind: "at", expiresAt: "2026-11-30T12:59:00+00:00" });
  });

  it("as no expiry when none was set", () => {
    const c = single([row({ expires_at: null }), row({ expires_at: null })]);
    expect(c.expiry).toEqual({ kind: "none" });
  });

  it("comparing instants, not their spellings", () => {
    const c = single([row(), row({ expires_at: "2026-11-30T12:59:00.000Z" })]);
    expect(c.expiry.kind).toBe("at");
  });

  /*
   * One request writes every row, so a disagreement means the ledger was
   * changed afterwards. Showing one row's value would state, about the whole
   * campaign, a date some of its grants do not have.
   */
  it("as a disagreement, with its spread, when the rows differ", () => {
    const c = single([
      row({ expires_at: "2026-12-31T12:59:00+00:00" }),
      row(),
      row({ expires_at: "2026-11-01T00:00:00+00:00" }),
    ]);
    expect(c.expiry).toEqual({
      kind: "mixed",
      earliest: "2026-11-01T00:00:00+00:00",
      latest: "2026-12-31T12:59:00+00:00",
      neverExpire: 0,
    });
  });

  it("counts the grants that never expire beside the ones that do", () => {
    const c = single([row(), row({ expires_at: null }), row()]);
    expect(c.expiry).toEqual({
      kind: "mixed",
      earliest: "2026-11-30T12:59:00+00:00",
      latest: "2026-11-30T12:59:00+00:00",
      neverExpire: 1,
    });
  });

  it("keeps each campaign's expiry to its own rows", () => {
    const campaigns = rollUpGiftCampaigns([
      row({ source_ref: "promo:new:1", expires_at: null }),
      row({ source_ref: "promo:old:2" }),
    ]);
    expect(campaigns.map((c) => [c.campaignId, c.expiry.kind])).toEqual([
      ["promo:new:1", "none"],
      ["promo:old:2", "at"],
    ]);
  });
});

describe("the rest of the roll-up is unchanged", () => {
  it("counts tenants and tokens, and takes the name, date and operator from the newest row", () => {
    const c = single([
      row({ tokens: 500, created_at: "2026-10-29T02:00:00+00:00" }),
      row({ tokens: 500, metadata: { campaign_name: "older name", granted_by: "Someone" } }),
    ]);
    expect(c).toMatchObject({
      campaignId: "promo:abc:123",
      campaignName: "October launch bonus",
      reason: "Promotional grant",
      tenants: 2,
      totalTokens: 1000,
      tokensPerTenant: 500,
      createdAt: "2026-10-29T02:00:00+00:00",
      grantedBy: "Ops",
    });
  });

  it("falls back to the reason for a campaign with no recorded name", () => {
    expect(single([row({ metadata: {} })]).campaignName).toBe("Promotional grant");
    expect(single([row({ metadata: {} })]).grantedBy).toBeNull();
  });
});

describe("describeGiftCampaignExpiry", () => {
  const format = (iso: string) => `<${iso.slice(0, 10)}>`;

  it("states a shared expiry and its absence", () => {
    expect(
      describeGiftCampaignExpiry({ kind: "at", expiresAt: "2026-11-30T12:59:00Z" }, format),
    ).toBe("expires <2026-11-30>");
    expect(describeGiftCampaignExpiry({ kind: "none" }, format)).toBe("no expiry");
  });

  it("says a disagreement is one rather than picking a date", () => {
    expect(
      describeGiftCampaignExpiry(
        {
          kind: "mixed",
          earliest: "2026-11-01T00:00:00Z",
          latest: "2026-12-31T00:00:00Z",
          neverExpire: 0,
        },
        format,
      ),
    ).toBe("expiry differs between its grants: they expire between <2026-11-01> and <2026-12-31>");
    expect(
      describeGiftCampaignExpiry(
        {
          kind: "mixed",
          earliest: "2026-11-30T00:00:00Z",
          latest: "2026-11-30T00:00:00Z",
          neverExpire: 2,
        },
        format,
      ),
    ).toBe("expiry differs between its grants: 2 have no expiry, the rest expire <2026-11-30>");
  });
});

/*
 * A roll-up nothing reads and a field nothing renders are not shipped. Read as
 * source because this repository's vitest has no DOM.
 */
describe("the expiry reaches the page", () => {
  const fn = readFileSync("src/lib/gift-tokens.functions.ts", "utf8");
  const page = readFileSync("src/routes/settings.gift-tokens.tsx", "utf8");

  it("is read with the campaign rows and rolled up by this module", () => {
    const list = fn.slice(fn.indexOf("export const listGiftCampaigns"));
    expect(list).toMatch(/\.select\("[^"]*\bexpires_at\b[^"]*"\)/);
    expect(list).toContain("rollUpGiftCampaigns(");
  });

  it("is stated on every past campaign", () => {
    expect(page).toContain("describeGiftCampaignExpiry(c.expiry,");
  });
});
