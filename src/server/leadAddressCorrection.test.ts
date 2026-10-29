// An applicant correcting the address they mistyped (docs/LEAD_EMAILS.md,
// "Address corrections").
//
// The website's confirmation screen posts the corrected application under the
// SAME reference. Mission Control answered it `duplicate` and changed nothing,
// so the Stage 1 email and the questionnaire link stayed with the mistyped
// address and the applicant never received them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADDRESS_CORRECTION_LIMIT,
  ADDRESS_CORRECTION_WINDOW_MS,
  correctedAddressOf,
  decideAddressCorrection,
} from "./leadAddressCorrection.pure";

const NOW = Date.parse("2026-10-29T06:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

const applied = (over: Record<string, unknown> = {}) => ({
  id: "lead-1",
  application_id: "AX-F86555B04D",
  email: "jordan@firm.con",
  first_name: "Jordan",
  last_name: "Lee",
  entity_name: "Firm Pty Ltd",
  stage: 1,
  status: "new",
  created_at: minutesAgo(4),
  submitted_at: minutesAgo(4),
  applicant_email_generation: 0,
  metadata: { channel: "website" } as Record<string, unknown>,
  ...over,
});

// The corrected application, posted from the applying browser a minute later.
const incoming = (
  over: Partial<{ email: string; submittedAt: string | null; verified: boolean }> = {},
) => ({
  email: "jordan@firm.com",
  submittedAt: minutesAgo(1),
  verified: true,
  ...over,
});

describe("decideAddressCorrection", () => {
  it("re-addresses the application just made, to the next generation", () => {
    expect(decideAddressCorrection(applied(), incoming(), NOW)).toEqual({
      kind: "correct",
      from: "jordan@firm.con",
      to: "jordan@firm.com",
      generation: 1,
    });
  });

  it("reads the same address in another case as the same application delivered twice", () => {
    expect(
      decideAddressCorrection(applied(), incoming({ email: " Jordan@Firm.con " }), NOW),
    ).toEqual({
      kind: "same_address",
    });
  });

  it("reads a late copy of the application it corrected as that application, not a correction back", () => {
    // The lead is at the corrected address; the original, mistyped, arrives late.
    const corrected = applied({
      email: "jordan@firm.com",
      submitted_at: minutesAgo(1),
      applicant_email_generation: 1,
    });
    expect(
      decideAddressCorrection(
        corrected,
        incoming({ email: "jordan@firm.con", submittedAt: minutesAgo(4) }),
        NOW,
      ),
    ).toEqual({ kind: "stale" });
  });

  it("refuses anybody but the browser that made the application", () => {
    expect(decideAddressCorrection(applied(), incoming({ verified: false }), NOW)).toMatchObject({
      kind: "refused",
      reason: "unverified",
    });
  });

  it("refuses once the applicant has reached the questionnaire", () => {
    for (const over of [
      { stage2_completed_at: minutesAgo(1) },
      { stage: 2 },
      { stage3_booked_at: minutesAgo(1) },
    ]) {
      expect(decideAddressCorrection(applied(over), incoming(), NOW)).toMatchObject({
        kind: "refused",
        reason: "questionnaire_reached",
      });
    }
  });

  it("refuses a declined application", () => {
    expect(
      decideAddressCorrection(applied({ status: "disqualified" }), incoming(), NOW),
    ).toMatchObject({
      kind: "refused",
      reason: "declined",
    });
  });

  it("refuses after the window, and without a creation time to measure it from", () => {
    const old = new Date(NOW - ADDRESS_CORRECTION_WINDOW_MS - 1).toISOString();
    expect(
      decideAddressCorrection(applied({ created_at: old, submitted_at: old }), incoming(), NOW),
    ).toMatchObject({ kind: "refused", reason: "window_closed" });
    expect(decideAddressCorrection(applied({ created_at: null }), incoming(), NOW)).toMatchObject({
      kind: "refused",
      reason: "window_closed",
    });
  });

  it("refuses past the limit", () => {
    expect(
      decideAddressCorrection(
        applied({ applicant_email_generation: ADDRESS_CORRECTION_LIMIT }),
        incoming(),
        NOW,
      ),
    ).toMatchObject({ kind: "refused", reason: "too_many_corrections" });
  });
});

describe("correctedAddressOf", () => {
  it("is the address the lead was last corrected to, and nothing for a lead never corrected", () => {
    expect(
      correctedAddressOf({
        email_corrections: [
          { from: "a@x.con", to: "a@x.co", generation: 1 },
          { from: "a@x.co", to: "a@x.com", generation: 2 },
        ],
      }),
    ).toEqual({ email: "a@x.com", generation: 2 });
    expect(correctedAddressOf({ channel: "website" })).toBeNull();
    expect(correctedAddressOf(null)).toBeNull();
  });
});

// ── The writes ──────────────────────────────────────────────────────────────

type Op = { table: string; action: string; values?: unknown; filters: unknown[][] };

const db = vi.hoisted(() => ({
  lead: null as Record<string, unknown> | null,
  // The lead as later reads find it: a correction that lost a race reads again.
  laterLeads: [] as Record<string, unknown>[],
  readError: null as { message: string } | null,
  updateError: null as { message: string; code?: string } | null,
  // How many rows each lead update matches, in turn: 0 is a correction that
  // lost a race. Past the list, 1.
  updatedRows: [] as number[],
  superseded: [] as { id: string }[],
  revoked: [] as { id: string }[],
  revokeError: null as { message: string } | null,
  ops: [] as Op[],
  audits: [] as Record<string, unknown>[],
  notices: [] as Record<string, unknown>[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const builder = (table: string, action: string, values?: unknown) => {
    const op: Op = { table, action, values, filters: [] };
    db.ops.push(op);
    const chain: Record<string, unknown> = {};
    for (const name of ["eq", "lt", "gt", "in"]) {
      chain[name] = (...args: unknown[]) => {
        op.filters.push([name, ...args]);
        return chain;
      };
    }
    chain.maybeSingle = async () => {
      const read = db.lead;
      if (db.laterLeads.length) db.lead = db.laterLeads.shift()!;
      return { data: read, error: db.readError };
    };
    chain.select = async () => {
      if (table === "waitlist_leads")
        return db.updateError
          ? { data: null, error: db.updateError }
          : {
              data: Array.from({ length: db.updatedRows.shift() ?? 1 }, () => ({ id: "lead-1" })),
              error: null,
            };
      if (table === "lead_stage_emails") return { data: db.superseded, error: null };
      return db.revokeError
        ? { data: null, error: db.revokeError }
        : { data: db.revoked, error: null };
    };
    return chain;
  };
  return {
    supabaseAdmin: {
      from: (table: string) => ({
        select: () => builder(table, "select"),
        update: (values: unknown) => builder(table, "update", values),
      }),
    },
  };
});
vi.mock("@/server/audit.server", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => void db.audits.push(entry),
  notifyOperators: async (notice: Record<string, unknown>) => void db.notices.push(notice),
}));

const { CORRECTION_TOKEN_KEY, mintCorrectionToken, resolveStageOneConflict } =
  await import("./lead-address-correction.server");
const TOKEN = mintCorrectionToken();
// A lead as Mission Control holds it: its 201 handed the browser TOKEN.
const held = (over: Record<string, unknown> = {}) =>
  applied({ metadata: { channel: "website", [CORRECTION_TOKEN_KEY]: TOKEN.sha256 }, ...over });
const resolve = (lead: ReturnType<typeof corrected>, over: Record<string, unknown> = {}) =>
  resolveStageOneConflict({
    lead,
    channel: "website",
    correctionToken: TOKEN.token,
    trusted: false,
    now: NOW,
    ...over,
  });

const corrected = (over: Record<string, unknown> = {}) =>
  ({
    application_id: "AX-F86555B04D",
    first_name: "Jordan",
    last_name: "Lee",
    email: "jordan@firm.com",
    mobile_number: null,
    entity_name: "Firm Pty Ltd",
    entity_classification: null,
    transaction_volume: null,
    tech_stack_bottlenecks: null,
    role: null,
    primary_areas: [],
    additional_notes: null,
    form_version: null,
    privacy_acknowledged: true,
    privacy_notice_version: null,
    marketing_consent: null,
    landing_page: null,
    referrer: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_term: null,
    utm_content: null,
    source: "AURIXA Contact Waitlist Page",
    page: "/contact",
    submitted_at: minutesAgo(0),
    ...over,
  }) as Parameters<typeof resolveStageOneConflict>[0]["lead"];

const op = (table: string, action = "update") =>
  db.ops.find((o) => o.table === table && o.action === action);

beforeEach(() => {
  db.lead = held();
  db.laterLeads = [];
  db.readError = null;
  db.updateError = null;
  db.updatedRows = [];
  db.superseded = [{ id: "row-a" }];
  db.revoked = [{ id: "link-a" }];
  db.revokeError = null;
  db.ops = [];
  db.audits = [];
  db.notices = [];
});

describe("resolveStageOneConflict", () => {
  it("re-addresses the lead, settles the waiting email, closes the old link, and says so", async () => {
    const result = await resolve(corrected());
    expect(result).toEqual({
      kind: "corrected",
      leadId: "lead-1",
      from: "jordan@firm.con",
      to: "jordan@firm.com",
      generation: 1,
      superseded: 1,
      linksRevoked: 1,
    });

    const lead = op("waitlist_leads")!;
    expect(lead.values).toMatchObject({ email: "jordan@firm.com", applicant_email_generation: 1 });
    // How the lead first reached us, and the key it was found by, stay.
    expect(lead.values).not.toHaveProperty("source");
    expect(lead.values).not.toHaveProperty("page");
    expect(lead.values).not.toHaveProperty("application_id");
    expect((lead.values as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      channel: "website",
      email_corrections: [{ from: "jordan@firm.con", to: "jordan@firm.com", generation: 1 }],
    });
    // Guarded on the generation it read: two racing corrections cannot both land.
    expect(lead.filters).toContainEqual(["eq", "applicant_email_generation", 0]);

    const ledger = op("lead_stage_emails")!;
    expect(ledger.values).toEqual({
      status: "skipped",
      reason: "superseded: the applicant corrected their address",
    });
    expect(ledger.filters).toEqual([
      ["eq", "lead_id", "lead-1"],
      ["eq", "audience", "applicant"],
      ["eq", "status", "pending"],
      ["lt", "generation", 1],
    ]);

    const links = op("lead_questionnaire_links")!;
    expect(links.filters).toContainEqual(["eq", "lead_id", "lead-1"]);
    expect(links.values).toEqual({ expires_at: new Date(NOW).toISOString() });

    expect(db.audits[0]).toMatchObject({
      action: "lead.address_corrected",
      entityId: "lead-1",
      metadata: { from: "jordan@firm.con", to: "jordan@firm.com", generation: 1 },
    });
    expect(db.notices[0]).toMatchObject({ kind: "lead_address_corrected", severity: "info" });
    expect(String(db.notices[0]?.body)).toContain("4 minutes after applying");
  });

  it("answers the same application delivered twice as a duplicate, and writes nothing", async () => {
    const result = await resolve(corrected({ email: "jordan@firm.con" }));
    expect(result).toEqual({ kind: "duplicate", leadId: "lead-1" });
    expect(db.ops.filter((o) => o.action === "update")).toHaveLength(0);
    expect(db.notices).toHaveLength(0);
  });

  it("refuses a correction it may not make, writes nothing, and tells the team where to reach them", async () => {
    db.lead = held({ stage2_completed_at: minutesAgo(1), stage: 2 });
    const result = await resolve(corrected());
    expect(result).toEqual({ kind: "refused", leadId: "lead-1", reason: "questionnaire_reached" });
    expect(db.ops.filter((o) => o.action === "update")).toHaveLength(0);
    expect(db.audits[0]).toMatchObject({ action: "lead.address_correction_refused" });
    expect(db.notices[0]).toMatchObject({
      kind: "lead_address_correction_refused",
      severity: "warning",
    });
    expect(String(db.notices[0]?.body)).toContain("reach them at jordan@firm.com");
  });

  it("never answers duplicate for a lead it could not read", async () => {
    db.readError = { message: "57014 statement timeout" };
    const result = await resolve(corrected());
    expect(result).toEqual({ kind: "unavailable", error: "57014 statement timeout" });
  });

  it("decides again when a racing correction moved the lead first", async () => {
    // The other correction won, to another address; this one is newer still.
    db.updatedRows = [0, 1];
    db.laterLeads = [
      held({ email: "jordan@firm.co", submitted_at: minutesAgo(1), applicant_email_generation: 1 }),
    ];
    const result = await resolve(corrected());
    expect(result).toMatchObject({
      kind: "corrected",
      from: "jordan@firm.co",
      to: "jordan@firm.com",
      generation: 2,
    });
    const updates = db.ops.filter((o) => o.table === "waitlist_leads" && o.action === "update");
    expect(
      updates.map((u) => u.filters.find((f) => f[1] === "applicant_email_generation")),
    ).toEqual([
      ["eq", "applicant_email_generation", 0],
      ["eq", "applicant_email_generation", 1],
    ]);
  });

  it("is a duplicate when the racing correction that won was to the same address", async () => {
    db.updatedRows = [0];
    db.laterLeads = [
      held({
        email: "jordan@firm.com",
        submitted_at: minutesAgo(0),
        applicant_email_generation: 1,
      }),
    ];
    expect(await resolve(corrected())).toEqual({ kind: "duplicate", leadId: "lead-1" });
    expect(op("lead_stage_emails")).toBeUndefined();
  });

  it("refuses, quietly, a correction from anybody but the applying browser", async () => {
    for (const correctionToken of [null, "not-the-token", mintCorrectionToken().token]) {
      db.ops = [];
      db.audits = [];
      db.notices = [];
      const result = await resolve(corrected(), { correctionToken });
      expect(result).toEqual({ kind: "refused", leadId: "lead-1", reason: "unverified" });
      expect(db.ops.filter((o) => o.action === "update")).toHaveLength(0);
      expect(db.audits).toEqual([
        expect.objectContaining({
          action: "lead.address_correction_refused",
          metadata: expect.objectContaining({ reason: "unverified" }),
        }),
      ]);
      // A notice per attempt would be a notice anybody holding a reference could raise.
      expect(db.notices).toHaveLength(0);
    }
  });

  it("takes the funnel's own secret-bearing delivery without a token", async () => {
    db.lead = applied();
    const result = await resolve(corrected(), { correctionToken: null, trusted: true });
    expect(result).toMatchObject({ kind: "corrected", generation: 1 });
  });

  it("answers a late copy of the application it corrected as a duplicate, and writes nothing", async () => {
    db.lead = held({
      email: "jordan@firm.com",
      submitted_at: minutesAgo(1),
      applicant_email_generation: 1,
    });
    const result = await resolve(
      corrected({ email: "jordan@firm.con", submitted_at: minutesAgo(4) }),
      {
        correctionToken: null,
        trusted: true,
      },
    );
    expect(result).toEqual({ kind: "duplicate", leadId: "lead-1" });
    expect(db.ops.filter((o) => o.action === "update")).toHaveLength(0);
  });

  it("keeps the token on the lead, so the same browser can correct again", async () => {
    await resolve(corrected());
    const lead = op("waitlist_leads")!;
    expect((lead.values as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      [CORRECTION_TOKEN_KEY]: TOKEN.sha256,
    });
  });

  it("says in the notice when the old link could not be closed, rather than that it was", async () => {
    db.revokeError = { message: "57014 statement timeout" };
    const result = await resolve(corrected());
    expect(result).toMatchObject({ kind: "corrected", linksRevoked: 0 });
    expect(db.notices[0]).toMatchObject({ severity: "warning" });
    expect(String(db.notices[0]?.body)).toContain("could NOT be closed");
    expect(db.audits[0]?.metadata).toMatchObject({ revoke_error: "57014 statement timeout" });
  });
});
