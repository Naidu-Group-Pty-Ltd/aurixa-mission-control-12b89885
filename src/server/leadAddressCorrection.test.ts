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
  applicant_email_generation: 0,
  metadata: { channel: "website" },
  ...over,
});

describe("decideAddressCorrection", () => {
  it("re-addresses the application just made, to the next generation", () => {
    expect(decideAddressCorrection(applied(), "jordan@firm.com", NOW)).toEqual({
      kind: "correct",
      from: "jordan@firm.con",
      to: "jordan@firm.com",
      generation: 1,
    });
  });

  it("reads the same address in another case as the same application delivered twice", () => {
    expect(decideAddressCorrection(applied(), " Jordan@Firm.con ", NOW)).toEqual({
      kind: "same_address",
    });
  });

  it("refuses once the applicant has reached the questionnaire", () => {
    for (const over of [
      { stage2_completed_at: minutesAgo(1) },
      { stage: 2 },
      { stage3_booked_at: minutesAgo(1) },
    ]) {
      expect(decideAddressCorrection(applied(over), "jordan@firm.com", NOW)).toMatchObject({
        kind: "refused",
        reason: "questionnaire_reached",
      });
    }
  });

  it("refuses a declined application", () => {
    expect(
      decideAddressCorrection(applied({ status: "disqualified" }), "jordan@firm.com", NOW),
    ).toMatchObject({ kind: "refused", reason: "declined" });
  });

  it("refuses after the window, and without a creation time to measure it from", () => {
    const old = new Date(NOW - ADDRESS_CORRECTION_WINDOW_MS - 1).toISOString();
    expect(
      decideAddressCorrection(applied({ created_at: old }), "jordan@firm.com", NOW),
    ).toMatchObject({ kind: "refused", reason: "window_closed" });
    expect(
      decideAddressCorrection(applied({ created_at: null }), "jordan@firm.com", NOW),
    ).toMatchObject({ kind: "refused", reason: "window_closed" });
  });

  it("refuses past the limit", () => {
    expect(
      decideAddressCorrection(
        applied({ applicant_email_generation: ADDRESS_CORRECTION_LIMIT }),
        "jordan@firm.com",
        NOW,
      ),
    ).toMatchObject({ kind: "refused", reason: "too_many_corrections" });
  });
});

// ── The writes ──────────────────────────────────────────────────────────────

type Op = { table: string; action: string; values?: unknown; filters: unknown[][] };

const db = vi.hoisted(() => ({
  lead: null as Record<string, unknown> | null,
  readError: null as { message: string } | null,
  updateError: null as { message: string; code?: string } | null,
  // How many rows the lead update matched: 0 is a correction that lost a race.
  updatedRows: 1,
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
    chain.maybeSingle = async () => ({ data: db.lead, error: db.readError });
    chain.select = async () => {
      if (table === "waitlist_leads")
        return db.updateError
          ? { data: null, error: db.updateError }
          : { data: Array.from({ length: db.updatedRows }, () => ({ id: "lead-1" })), error: null };
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

const { resolveStageOneConflict } = await import("./lead-address-correction.server");

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
  db.lead = applied();
  db.readError = null;
  db.updateError = null;
  db.updatedRows = 1;
  db.superseded = [{ id: "row-a" }];
  db.revoked = [{ id: "link-a" }];
  db.revokeError = null;
  db.ops = [];
  db.audits = [];
  db.notices = [];
});

describe("resolveStageOneConflict", () => {
  it("re-addresses the lead, settles the waiting email, closes the old link, and says so", async () => {
    const result = await resolveStageOneConflict({
      lead: corrected(),
      channel: "website",
      now: NOW,
    });
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
    const result = await resolveStageOneConflict({
      lead: corrected({ email: "jordan@firm.con" }),
      channel: "website",
      now: NOW,
    });
    expect(result).toEqual({ kind: "duplicate", leadId: "lead-1" });
    expect(db.ops.filter((o) => o.action === "update")).toHaveLength(0);
    expect(db.notices).toHaveLength(0);
  });

  it("refuses a correction it may not make, writes nothing, and tells the team where to reach them", async () => {
    db.lead = applied({ stage2_completed_at: minutesAgo(1), stage: 2 });
    const result = await resolveStageOneConflict({
      lead: corrected(),
      channel: "website",
      now: NOW,
    });
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
    const result = await resolveStageOneConflict({
      lead: corrected(),
      channel: "website",
      now: NOW,
    });
    expect(result).toEqual({ kind: "unavailable", error: "57014 statement timeout" });
  });

  it("is a duplicate when a racing correction moved the lead first", async () => {
    db.updatedRows = 0;
    const result = await resolveStageOneConflict({
      lead: corrected(),
      channel: "website",
      now: NOW,
    });
    expect(result).toEqual({ kind: "duplicate", leadId: "lead-1" });
    expect(op("lead_stage_emails")).toBeUndefined();
    expect(db.notices).toHaveLength(0);
  });

  it("says in the notice when the old link could not be closed, rather than that it was", async () => {
    db.revokeError = { message: "57014 statement timeout" };
    const result = await resolveStageOneConflict({
      lead: corrected(),
      channel: "website",
      now: NOW,
    });
    expect(result).toMatchObject({ kind: "corrected", linksRevoked: 0 });
    expect(db.notices[0]).toMatchObject({ severity: "warning" });
    expect(String(db.notices[0]?.body)).toContain("could NOT be closed");
    expect(db.audits[0]?.metadata).toMatchObject({ revoke_error: "57014 statement timeout" });
  });
});
