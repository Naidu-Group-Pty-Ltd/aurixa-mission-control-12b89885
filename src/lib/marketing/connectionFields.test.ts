import { describe, expect, it } from "vitest";
import {
  MARKETING_SOURCES,
  SOURCE_DEFINITIONS,
  isMarketingSource,
  missingFields,
  validateSubmission,
} from "./connectionFields.pure";

describe("marketing connection fields", () => {
  it("describes every source the migration's CHECK admits, and no other", () => {
    expect([...MARKETING_SOURCES].sort()).toEqual([
      "google_ads",
      "meta_ads",
      "tiktok_ads",
      "youtube_analytics",
      "youtube_data",
    ]);
    for (const s of MARKETING_SOURCES) expect(SOURCE_DEFINITIONS[s].source).toBe(s);
    expect(isMarketingSource("meta_ads")).toBe(true);
    expect(isMarketingSource("linkedin_ads")).toBe(false);
  });

  it("never treats an account identifier as a credential, or a credential as a setting", () => {
    // A credential stored in clear would be returned to a browser; an id
    // stored encrypted could never be shown back to the operator.
    const credentialWords = /token|secret|key$/;
    for (const s of MARKETING_SOURCES) {
      for (const f of SOURCE_DEFINITIONS[s].fields) {
        if (credentialWords.test(f.key)) expect(f.secret, `${s}.${f.key}`).toBe(true);
        if (/_id$/.test(f.key)) expect(f.secret, `${s}.${f.key}`).toBe(false);
      }
    }
  });

  it("counts a stored credential as present, so a later save may leave it blank", () => {
    expect(
      missingFields(
        "tiktok_ads",
        { advertiser_id: "7000000000000000001" },
        new Set(["access_token"]),
      ),
    ).toEqual([]);
    expect(
      missingFields("tiktok_ads", { advertiser_id: "7000000000000000001" }, new Set()),
    ).toEqual(["access_token"]);
    expect(missingFields("tiktok_ads", {}, new Set(["access_token"]))).toEqual(["advertiser_id"]);
  });

  it("refuses an unknown field rather than dropping it", () => {
    const r = validateSubmission("meta_ads", {
      settings: { ad_acount_id: "act_123456" },
      secrets: {},
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a credential sent as a setting, and a setting sent as a credential", () => {
    expect(
      validateSubmission("meta_ads", {
        settings: { access_token: "EAAB" + "x".repeat(40) },
        secrets: {},
      }).ok,
    ).toBe(false);
    expect(
      validateSubmission("meta_ads", { settings: {}, secrets: { ad_account_id: "act_1234567" } })
        .ok,
    ).toBe(false);
  });

  it("holds an identifier to its pattern and says what it should look like", () => {
    const bad = validateSubmission("youtube_data", {
      settings: { channel_id: "npcservices" },
      secrets: {},
    });
    expect(bad).toEqual({
      ok: false,
      error: "Channel id: a channel id starts with UC and is 24 characters long",
    });
    const good = validateSubmission("youtube_data", {
      settings: { channel_id: "UC1234567890123456789012" },
      secrets: {},
    });
    expect(good.ok).toBe(true);
    expect(
      validateSubmission("google_ads", { settings: { customer_id: "123-456-7890" }, secrets: {} })
        .ok,
    ).toBe(true);
    expect(
      validateSubmission("google_ads", { settings: { customer_id: "1234" }, secrets: {} }).ok,
    ).toBe(false);
  });

  it("keeps a blank credential out of the submission, so the stored one survives", () => {
    const r = validateSubmission("tiktok_ads", {
      settings: { advertiser_id: "7000000000000000001" },
      secrets: { access_token: "  " },
    });
    expect(r).toEqual({
      ok: true,
      settings: { advertiser_id: "7000000000000000001" },
      secrets: {},
    });
  });

  it("refuses a credential that cannot be one", () => {
    expect(
      validateSubmission("tiktok_ads", { settings: {}, secrets: { access_token: "abc" } }).ok,
    ).toBe(false);
    expect(
      validateSubmission("tiktok_ads", {
        settings: {},
        secrets: { access_token: "abcd efgh ijkl" },
      }).ok,
    ).toBe(false);
  });
});
