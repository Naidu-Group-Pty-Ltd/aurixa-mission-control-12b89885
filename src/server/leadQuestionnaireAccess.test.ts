// The secure questionnaire link: what the Stage 1 email carries and what the
// website asks before it opens the questionnaire (docs/LEAD_EMAILS.md).
//
// The double HONOURS its filters. A version that answered every query with the
// same row could not tell "this token belongs to this applicant" from "some
// token exists", which is the only question the check is for.
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  leads: [] as Row[],
  links: [] as Row[],
  leadError: null as { message: string } | null,
  linkError: null as { message: string } | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  // select(...).eq().in().order().limit() / .maybeSingle(), each filter applied.
  const query = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const rows = () => (table === "waitlist_leads" ? db.leads : db.links);
    const error = () => (table === "waitlist_leads" ? db.leadError : db.linkError);
    const result = () => ({
      data: error() ? null : rows().filter((row) => filters.every((f) => f(row))),
      error: error(),
    });
    const chain = {
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return chain;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return chain;
      },
      order: () => chain,
      limit: async () => result(),
      maybeSingle: async () => {
        const read = result();
        return { data: read.data?.[0] ?? null, error: read.error };
      },
    };
    return chain;
  };
  return {
    supabaseAdmin: {
      from(table: string) {
        return {
          select: () => query(table),
          insert: async (row: Row) => {
            db.links.push({ id: `link-${db.links.length + 1}`, ...row });
            return { error: null };
          },
          update: (patch: Row) => ({
            eq: (_column: string, id: unknown) => {
              for (const link of db.links) if (link.id === id) Object.assign(link, patch);
              return Promise.resolve({ error: null });
            },
          }),
        };
      },
    },
  };
});

import { mintQuestionnaireLink, verifyQuestionnaireAccess } from "./lead-emails.server";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const LEAD = {
  id: "lead-1",
  application_id: "AX-0000000001",
  first_name: "Ada",
  last_name: "Lovelace",
  email: "Ada@Example.com",
  entity_name: "Analytical Engines",
  role: "director",
  entity_classification: "pty_ltd",
  transaction_volume: "1m_10m",
  stage2_completed_at: null,
  created_at: "2026-10-28T00:00:00.000Z",
};

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";

beforeEach(() => {
  db.leads = [{ ...LEAD }];
  db.links = [];
  db.leadError = null;
  db.linkError = null;
  process.env.AURIXA_WEBSITE_URL = "https://www.aurixasystems.com.au";
});

describe("minting", () => {
  it("puts the reference and a token in the link, and keeps only the token's hash", async () => {
    const minted = await mintQuestionnaireLink({
      leadId: "lead-1",
      applicationId: "AX-0000000001",
      now: NOW,
    });
    if (!minted.ok) throw new Error(minted.error);
    const url = new URL(minted.url);
    expect(url.origin + url.pathname).toBe("https://www.aurixasystems.com.au/questionnaire");
    expect(url.searchParams.get("ref")).toBe("AX-0000000001");
    expect(url.searchParams.get("expires")).toBe(minted.expiresAt);
    expect(Date.parse(minted.expiresAt) - NOW).toBe(21 * 86_400_000);

    const token = tokenOf(minted.url);
    expect(db.links[0]?.token_sha256).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(db.links)).not.toContain(token);
  });

  it("mints a new token every time", async () => {
    const a = await mintQuestionnaireLink({ leadId: "lead-1", applicationId: "AX-0000000001" });
    const b = await mintQuestionnaireLink({ leadId: "lead-1", applicationId: "AX-0000000001" });
    expect(a.ok && b.ok && tokenOf(a.url) !== tokenOf(b.url)).toBe(true);
  });
});

describe("the website's check", () => {
  const mint = async () => {
    const minted = await mintQuestionnaireLink({
      leadId: "lead-1",
      applicationId: "AX-0000000001",
      now: NOW,
    });
    if (!minted.ok) throw new Error(minted.error);
    return tokenOf(minted.url);
  };

  it("opens for the link the email carried, and says who the applicant is", async () => {
    const token = await mint();
    const access = await verifyQuestionnaireAccess({
      applicationId: "ax-0000000001",
      token,
      now: NOW + 1000,
    });
    expect(access).toEqual({
      ok: true,
      via: "link",
      applicant: {
        applicationId: "AX-0000000001",
        firstName: "Ada",
        lastName: "Lovelace",
        workEmail: "Ada@Example.com",
        organisationName: "Analytical Engines",
        role: "director",
        organisationType: "pty_ltd",
        annualVolume: "1m_10m",
      },
    });
    expect(db.links[0]?.last_used_at).toBe(new Date(NOW + 1000).toISOString());
  });

  it("refuses a token that was never minted", async () => {
    await mint();
    const access = await verifyQuestionnaireAccess({
      applicationId: "AX-0000000001",
      token: "a".repeat(43),
      now: NOW,
    });
    expect(access).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  it("refuses another applicant's token under this reference", async () => {
    db.leads.push({ ...LEAD, id: "lead-2", application_id: "AX-0000000002" });
    const other = await mintQuestionnaireLink({
      leadId: "lead-2",
      applicationId: "AX-0000000002",
      now: NOW,
    });
    if (!other.ok) throw new Error(other.error);
    const access = await verifyQuestionnaireAccess({
      applicationId: "AX-0000000001",
      token: tokenOf(other.url),
      now: NOW,
    });
    expect(access).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  it("refuses an expired link, naming the reference so the page can offer the other way in", async () => {
    const token = await mint();
    const access = await verifyQuestionnaireAccess({
      applicationId: "AX-0000000001",
      token,
      now: NOW + 22 * 86_400_000,
    });
    expect(access).toEqual({ ok: false, reason: "expired", applicationId: "AX-0000000001" });
  });

  it("opens for the reference with the work email the application gave, in any case", async () => {
    const access = await verifyQuestionnaireAccess({
      applicationId: "AX-0000000001",
      workEmail: "  ada@example.COM ",
    });
    expect(access).toMatchObject({ ok: true, via: "reference" });
  });

  it("answers a wrong email exactly as it answers an unknown reference", async () => {
    const wrongEmail = await verifyQuestionnaireAccess({
      applicationId: "AX-0000000001",
      workEmail: "someone@else.com",
    });
    const unknown = await verifyQuestionnaireAccess({
      applicationId: "AX-0000000099",
      workEmail: "ada@example.com",
    });
    expect(wrongEmail).toEqual({ ok: false, reason: "invalid_reference" });
    expect(unknown).toEqual(wrongEmail);
  });

  it("asks for a token or an email — a reference alone opens nothing", async () => {
    expect(await verifyQuestionnaireAccess({ applicationId: "AX-0000000001" })).toEqual({
      ok: false,
      reason: "invalid_reference",
    });
  });

  it("refuses a malformed reference or token before asking the database", async () => {
    db.leadError = { message: "should not be asked" };
    expect(
      await verifyQuestionnaireAccess({ applicationId: "not a reference", token: "x" }),
    ).toMatchObject({
      reason: "invalid_reference",
    });
    db.leadError = null;
    expect(
      await verifyQuestionnaireAccess({
        applicationId: "AX-0000000001",
        token: "has spaces in it!",
      }),
    ).toMatchObject({ reason: "invalid_token" });
  });

  it("says the questionnaire is already done rather than opening it twice", async () => {
    const token = await mint();
    db.leads[0]!.stage2_completed_at = "2026-10-28T12:00:00.000Z";
    const access = await verifyQuestionnaireAccess({
      applicationId: "AX-0000000001",
      token,
      now: NOW,
    });
    expect(access).toEqual({
      ok: false,
      reason: "already_completed",
      applicationId: "AX-0000000001",
      completedAt: "2026-10-28T12:00:00.000Z",
    });
  });

  it("is unavailable, not a refusal, when the database cannot be read", async () => {
    const token = await mint();
    db.leadError = { message: "57014 statement timeout" };
    expect(await verifyQuestionnaireAccess({ applicationId: "AX-0000000001", token })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    db.leadError = null;
    db.linkError = { message: "57014 statement timeout" };
    expect(await verifyQuestionnaireAccess({ applicationId: "AX-0000000001", token })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
