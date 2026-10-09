import { describe, expect, it } from "vitest";
import {
  channelOfSourceWord,
  classifyLeadChannel,
  summariseLeadChannels,
} from "../marketingEngine";

/**
 * Which channel gets the credit for a lead decides every cost per attributed
 * lead on the page. These cases pin the rank of the evidence, which IS the
 * rule — above all that a gclid alone never makes a lead a YouTube lead.
 */
describe("lead channel classification", () => {
  it("takes TikTok’s click id as definitive, wherever it appears", () => {
    expect(classifyLeadChannel({ ttclid: "E.C.P.abc" })).toMatchObject({
      channel: "tiktok",
      evidence: "ttclid",
    });
    expect(
      classifyLeadChannel({
        landing_page_url: "https://npc.example/guide?ttclid=E.C.P.abc&utm_source=facebook",
      }),
    ).toMatchObject({ channel: "tiktok", evidence: "ttclid" });
  });

  it("lets a YouTube UTM outrank Google’s click id, because a YouTube ad click carries a gclid", () => {
    const lead = {
      utm_source: "youtube",
      utm_medium: "cpv",
      gclid: "Cj0KCQ",
      utm_campaign: "Spring launch",
    };
    expect(classifyLeadChannel(lead)).toEqual({
      channel: "youtube",
      evidence: "utm_source",
      campaign: "Spring launch",
      paid: true,
    });
  });

  it("never reads a gclid alone as YouTube", () => {
    expect(classifyLeadChannel({ gclid: "Cj0KCQ" })).toMatchObject({
      channel: "google_ads",
      evidence: "gclid",
    });
    expect(
      classifyLeadChannel({ landing_page: "https://aurixa.example/?gbraid=abc" }),
    ).toMatchObject({ channel: "google_ads" });
  });

  it("reads the referrer for organic YouTube and TikTok traffic", () => {
    expect(classifyLeadChannel({ referrer_url: "https://www.youtube.com/" })).toMatchObject({
      channel: "youtube",
      evidence: "referrer",
    });
    expect(classifyLeadChannel({ referrer: "https://m.youtube.com/watch?v=x" })).toMatchObject({
      channel: "youtube",
    });
    expect(classifyLeadChannel({ referrer: "https://www.tiktok.com/@npc" })).toMatchObject({
      channel: "tiktok",
      evidence: "referrer",
    });
  });

  it("credits Meta for fbclid, an enriched Meta campaign, or a Meta UTM", () => {
    expect(classifyLeadChannel({ fbclid: "IwAR0" })).toMatchObject({
      channel: "meta",
      evidence: "fbclid",
    });
    expect(classifyLeadChannel({ meta_campaign_id: "120200" })).toMatchObject({
      channel: "meta",
      evidence: "meta_campaign",
    });
    expect(classifyLeadChannel({ utm_source: "ig" })).toMatchObject({
      channel: "meta",
      evidence: "utm_source",
    });
    expect(classifyLeadChannel({ utm_source: "Facebook Lead Ads" })).toMatchObject({
      channel: "meta",
    });
  });

  it("matches short tokens whole, never inside another word", () => {
    expect(channelOfSourceWord("big-partner")).toBeNull();
    expect(channelOfSourceWord("tt")).toBe("tiktok");
    expect(channelOfSourceWord("yt")).toBe("youtube");
    expect(channelOfSourceWord("google", "organic")).toBe("organic_search");
    expect(channelOfSourceWord("google", "cpc")).toBe("google_ads");
  });

  it("places search engines, LinkedIn and email by referrer, and the site’s own host as direct", () => {
    expect(classifyLeadChannel({ referrer: "https://www.google.com.au/" })).toMatchObject({
      channel: "organic_search",
    });
    expect(classifyLeadChannel({ referrer: "https://www.linkedin.com/feed/" })).toMatchObject({
      channel: "linkedin",
    });
    expect(
      classifyLeadChannel({
        referrer: "https://partner.example/blog",
        landing_page: "https://aurixa.example/",
      }),
    ).toMatchObject({ channel: "referral" });
    expect(
      classifyLeadChannel({
        referrer: "https://aurixa.example/pricing",
        landing_page: "https://aurixa.example/signup",
      }),
    ).toMatchObject({ channel: "direct" });
  });

  it("falls back to the CRM’s own words, then to direct, then to unknown", () => {
    expect(classifyLeadChannel({ ghl_attribution_source: "TikTok Lead Form" })).toMatchObject({
      channel: "tiktok",
      evidence: "crm_source",
    });
    expect(classifyLeadChannel({ ghl_attribution_source: "Organic Search" })).toMatchObject({
      channel: "organic_search",
    });
    expect(classifyLeadChannel({ landing_page_url: "https://npc.example/" })).toMatchObject({
      channel: "direct",
      evidence: "landing_page_only",
    });
    expect(classifyLeadChannel({})).toEqual({
      channel: "unknown",
      evidence: "none",
      campaign: null,
      paid: null,
    });
  });

  it("says a click was paid only where an ad click id or the medium says so", () => {
    expect(classifyLeadChannel({ ttclid: "x" }).paid).toBe(true);
    expect(classifyLeadChannel({ gclid: "x" }).paid).toBe(true);
    // Facebook stamps fbclid on organic link clicks too.
    expect(classifyLeadChannel({ fbclid: "x" }).paid).toBeNull();
    expect(classifyLeadChannel({ fbclid: "x", utm_medium: "paid_social" }).paid).toBe(true);
    expect(classifyLeadChannel({ utm_source: "youtube", utm_medium: "organic" }).paid).toBe(false);
    expect(classifyLeadChannel({ referrer: "https://www.youtube.com/" }).paid).toBe(false);
    expect(classifyLeadChannel({ utm_source: "youtube" }).paid).toBeNull();
  });

  it("counts leads inside a range by channel and campaign, skipping undated ones", () => {
    const leads = [
      { utm_source: "youtube", utm_campaign: "A", created_at: "2026-10-02T01:00:00Z" },
      { utm_source: "youtube", utm_campaign: "A", created_at: "2026-10-03T01:00:00Z" },
      { utm_source: "youtube", utm_campaign: "B", created_at: "2026-10-03T01:00:00Z" },
      { ttclid: "x", created_at: "2026-10-04T01:00:00Z" },
      { utm_source: "youtube", created_at: "2026-08-01T00:00:00Z" },
      { utm_source: "youtube", created_at: null },
    ];
    const s = summariseLeadChannels(leads, {
      range: { since: "2026-10-01", until: "2026-10-07" },
      timeZone: "Australia/Sydney",
      dateOf: (l) => l.created_at,
    });
    expect(s.total).toBe(4);
    expect(s.byChannel.youtube).toBe(3);
    expect(s.byChannel.tiktok).toBe(1);
    expect(s.campaigns.youtube).toEqual([
      { campaign: "A", leads: 2 },
      { campaign: "B", leads: 1 },
    ]);
    expect(s.byEvidence.utm_source).toBe(3);
    expect(s.paidByChannel.tiktok).toBe(1);
    expect(s.paidByChannel.youtube).toBe(0);
    expect(s.organicByChannel.youtube).toBe(0);
  });
});
