// Who receives the team's lead alerts (Email → Lead emails → Team alerts).
//
// An admin act, audited and announced like the senders. The list is read the
// way the sender reads it, and refused WHOLE for one address it cannot send
// to: Graph refuses a whole message for one bad recipient, so a typo saved
// here would silence the alert for everybody on the list.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  upserts: [] as Record<string, unknown>[],
  upsertError: null as { message: string; code?: string } | null,
  audits: [] as Record<string, unknown>[],
  notices: [] as Record<string, unknown>[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.row, error: null }) }),
      }),
      upsert: async (values: Record<string, unknown>) => {
        state.upserts.push(values);
        return { error: state.upsertError };
      },
    }),
  },
}));
vi.mock("@/server/graph-client", () => ({
  defaultGraphConfig: () => null,
  sendMail: async () => ({ kind: "sent", status: 202, requestId: null }),
}));
vi.mock("@/server/microsoft-tenants.server", () => ({ graphConfigFor: async () => null }));
vi.mock("@/server/audit.server", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => void state.audits.push(entry),
  notifyOperators: async (notice: Record<string, unknown>) => void state.notices.push(notice),
}));

import { setLeadEmailTeamAlerts, TEAM_ALERT_RECIPIENT_LIMIT } from "./lead-emails.server";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const TEAM = [
  "admin@aurixasystems.com.au",
  "rugesh@aurixasystems.com.au",
  "lavan@aurixasystems.com.au",
  "arvinraj@aurixasystems.com.au",
  "mithrubanbupathy@aurixasystems.com.au",
];

beforeEach(() => {
  state.row = null;
  state.upserts = [];
  state.upsertError = null;
  state.audits = [];
  state.notices = [];
});

describe("setLeadEmailTeamAlerts", () => {
  it("saves the list and the stages, records who did it and what it replaced, and tells every operator", async () => {
    state.row = {
      id: true,
      internal_recipients: ["old@aurixasystems.com.au"],
      internal_stages: [1],
    };
    const result = await setLeadEmailTeamAlerts({
      recipients: TEAM,
      stages: [3, 1, 2],
      actorId: ACTOR,
    });

    expect(result).toEqual({ ok: true, recipients: TEAM });
    expect(state.upserts[0]).toMatchObject({
      id: true,
      internal_recipients: TEAM,
      internal_stages: [1, 2, 3],
      updated_by: ACTOR,
    });
    expect(state.audits[0]).toMatchObject({
      actorUserId: ACTOR,
      action: "lead_emails.team_alerts_set",
      metadata: {
        recipients: TEAM,
        stages: [1, 2, 3],
        previous_recipients: ["old@aurixasystems.com.au"],
        previous_stages: [1],
      },
    });
    expect(state.notices[0]).toMatchObject({ kind: "lead_email_team_alerts_changed" });
    expect(String(state.notices[0]?.body)).toContain("rugesh@aurixasystems.com.au");
  });

  it("trims what was pasted, unwraps a contact, and sends a repeat once", async () => {
    const result = await setLeadEmailTeamAlerts({
      recipients: [
        " admin@aurixasystems.com.au",
        "Rugesh Naidu <rugesh@aurixasystems.com.au>",
        "ADMIN@aurixasystems.com.au",
      ],
      stages: [1],
      actorId: ACTOR,
    });
    expect(result).toEqual({
      ok: true,
      recipients: ["admin@aurixasystems.com.au", "rugesh@aurixasystems.com.au"],
    });
  });

  it("refuses the whole list for one address it cannot send to, and names it", async () => {
    const result = await setLeadEmailTeamAlerts({
      recipients: ["admin@aurixasystems.com.au", "rugesh@aurixasystems"],
      stages: [1, 2, 3],
      actorId: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"rugesh@aurixasystems"');
    expect(state.upserts).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
    expect(state.notices).toHaveLength(0);
  });

  it("refuses more people than the column holds", async () => {
    const many = Array.from({ length: TEAM_ALERT_RECIPIENT_LIMIT + 1 }, (_, i) => `p${i}@x.com`);
    const result = await setLeadEmailTeamAlerts({ recipients: many, stages: [1], actorId: ACTOR });
    expect(result.ok).toBe(false);
    expect(state.upserts).toHaveLength(0);
  });

  it("stores an empty list as no list, so the environment decides again", async () => {
    const result = await setLeadEmailTeamAlerts({ recipients: ["  "], stages: [], actorId: ACTOR });
    expect(result).toEqual({ ok: true, recipients: [] });
    expect(state.upserts[0]).toMatchObject({ internal_recipients: null, internal_stages: [] });
    expect(String(state.notices[0]?.body)).toContain("no stage");
  });

  it("says the schema is pending rather than failing when the columns are not there yet", async () => {
    state.upsertError = {
      message: "Could not find the 'internal_recipients' column",
      code: "PGRST204",
    };
    const result = await setLeadEmailTeamAlerts({ recipients: TEAM, stages: [1], actorId: ACTOR });
    expect(result).toEqual({ ok: false, error: "schema_pending" });
    expect(state.audits).toHaveLength(0);
  });
});
