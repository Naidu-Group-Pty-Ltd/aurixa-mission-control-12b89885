// ADVERSARIAL PROBE — temporary. Measures claims rather than reading them.
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  claimed: [] as Record<string, unknown>[],
  suppressionRows: [] as { email_key: string }[],
  suppressionError: null as { message: string } | null,
  suppressionQueried: [] as string[][],
  settles: [] as { id: string; patch: Record<string, unknown> }[],
  settleError: null as { message: string } | null,
  notices: [] as Record<string, unknown>[],
  sent: [] as { mailbox: string; message: Record<string, unknown> }[],
  outcome: { kind: "sent", status: 202, requestId: "rq" } as Record<string, unknown>,
  graphConfigured: true,
  sweepError: null as { message: string } | null,
  sweepRows: [] as Record<string, unknown>[],
  sweepFilter: null as string | null,
  upserts: [] as Record<string, unknown>[][],
}));

vi.mock("@/server/graph-client", () => ({
  isGraphConfigured: () => state.graphConfigured,
  defaultMailbox: () => "hello@aurixasystems.com.au",
  sendMail: async (mailbox: string, message: Record<string, unknown>) => {
    state.sent.push({ mailbox, message });
    return state.outcome;
  },
}));

vi.mock("@/server/audit.server", () => ({
  notifyOperators: async (n: Record<string, unknown>) => {
    state.notices.push(n);
    return true;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: state.claimed, error: null }),
    from(table: string) {
      if (table === "waitlist_leads") {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.in = async () => ({
          data: [
            {
              id: "lead-1",
              email: "applicant@example.com",
              first_name: "Ada",
              last_name: "Lovelace",
              application_id: "AX-0000000001",
              created_at: "2026-09-22T00:00:00.000Z",
              submitted_at: "2026-09-22T00:00:00.000Z",
            },
          ],
        });
        builder.or = (filter: string) => {
          state.sweepFilter = filter;
          return builder;
        };
        builder.order = () => builder;
        builder.limit = async () => ({ data: state.sweepRows, error: state.sweepError });
        return builder;
      }
      if (table === "email_suppressions") {
        return {
          select: () => ({
            in: async (_col: string, keys: string[]) => {
              state.suppressionQueried.push(keys);
              return { data: state.suppressionRows, error: state.suppressionError };
            },
          }),
        };
      }
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: async (_c: string, id: string) => {
            state.settles.push({ id, patch });
            return { error: state.settleError };
          },
        }),
        upsert: (rows: Record<string, unknown>[]) => ({
          select: async () => {
            state.upserts.push(rows);
            return { data: rows.map((r, i) => ({ id: `n${i}`, status: r.status })), error: null };
          },
        }),
      };
    },
  },
}));

import { dispatchStageEmails, sweepMissingStageEmails } from "./lead-stage-emails.server";

const TEAM = ["admin", "rugesh", "lavan", "arvinraj", "mithrubanbupathy"].map(
  (n) => `${n}@aurixasystems.com.au`,
);
const wire = () =>
  ((state.sent[0]?.message.toRecipients as { emailAddress: { address: string } }[]) ?? []).map(
    (r) => r.emailAddress.address,
  );

beforeEach(() => {
  Object.assign(state, {
    claimed: [],
    suppressionRows: [],
    suppressionError: null,
    suppressionQueried: [],
    settles: [],
    settleError: null,
    notices: [],
    sent: [],
    outcome: { kind: "sent", status: 202, requestId: "rq" },
    graphConfigured: true,
    sweepError: null,
    sweepRows: [],
    sweepFilter: null,
    upserts: [],
  });
  process.env.MICROSOFT_MAILBOX_EMAIL = "hello@aurixasystems.com.au";
  process.env.LEAD_STAGE_INTERNAL_RECIPIENTS = TEAM.join(",");
  delete process.env.LEAD_STAGE_APPLICANT_MODE;
});

describe("P1 — the do-not-send register is queried on the STORED list, not the sent one", () => {
  it("emails a re-resolved recipient who IS on the register, and raises nothing", async () => {
    // The row was raised before the list was configured: it stores the mailbox.
    state.claimed = [
      {
        id: "row-1",
        lead_id: "lead-1",
        stage: 1,
        audience: "internal",
        recipients: ["hello@aurixasystems.com.au"],
        reason: null,
        attempts: 1,
      },
    ];
    // rugesh@ is on the do-not-send register.
    state.suppressionRows = [];
    const r = await dispatchStageEmails();
    console.log("P1 suppression query keys:", JSON.stringify(state.suppressionQueried));
    console.log("P1 addresses on the wire:", JSON.stringify(wire()));
    console.log("P1 result:", JSON.stringify(r));
    expect(state.suppressionQueried[0]).toEqual(["hello@aurixasystems.com.au"]);
    expect(wire()).toEqual(TEAM);
  });
});

describe("P2 — a settle that fails after the send", () => {
  it("leaves the message on the wire, the row unsettled, and nobody told", async () => {
    state.claimed = [
      { id: "row-1", lead_id: "lead-1", stage: 1, audience: "internal", recipients: TEAM, reason: null, attempts: 1 },
    ];
    state.settleError = { message: "canceling statement due to statement timeout" };
    const r = await dispatchStageEmails();
    console.log("P2 messages on the wire:", state.sent.length);
    console.log("P2 settle attempted with status:", state.settles[0]?.patch.status);
    console.log("P2 notices raised:", state.notices.length);
    console.log("P2 result:", JSON.stringify(r));
    expect(state.sent.length).toBe(1);
    expect(state.settles[0]?.patch.status).toBe("sent");
    expect(state.notices.length).toBe(0);
    expect(r.sent).toBe(1);
  });
});

describe("P3 — an unconfigured mailer", () => {
  it("returns a readiness but raises no notice", async () => {
    state.graphConfigured = false;
    state.claimed = [{ id: "row-1", lead_id: "lead-1", stage: 1, audience: "internal", recipients: TEAM, reason: null, attempts: 1 }];
    const r = await dispatchStageEmails();
    console.log("P3 result:", JSON.stringify(r));
    console.log("P3 notices raised:", state.notices.length);
    expect(state.notices.length).toBe(0);
    expect(r.note).toContain("not configured");
  });
  it("no mailbox: same shape", async () => {
    delete process.env.MICROSOFT_MAILBOX_EMAIL;
    vi.stubEnv("MICROSOFT_MAILBOX_EMAIL", "");
    const r = await dispatchStageEmails();
    console.log("P3b result note:", r.note, "notices:", state.notices.length);
    vi.unstubAllEnvs();
  });
});

describe("P4 — the sweep, the backstop that asks the database", () => {
  it("prints the filter it composes", async () => {
    state.sweepRows = [];
    await sweepMissingStageEmails();
    console.log("P4 sweep filter:", state.sweepFilter);
    expect(state.sweepFilter).toContain("created_at.gte.");
  });
  it("a refused read reports success and tells nobody", async () => {
    state.sweepError = { message: '"failed to parse logic tree ((created_at.gte.2026...))" (line 1, column 12)' };
    const out = await sweepMissingStageEmails();
    console.log("P4 sweep result on a refused read:", JSON.stringify(out));
    console.log("P4 notices raised:", state.notices.length);
    expect(out).toEqual({ queued: 0, skipped: 0, existing: 0 });
    expect(state.notices.length).toBe(0);
  });
});

describe("P5 — a throttled send", () => {
  it("is counted as failed and returned to pending with no attempts ceiling", async () => {
    state.claimed = [{ id: "row-1", lead_id: "lead-1", stage: 1, audience: "internal", recipients: TEAM, reason: null, attempts: 941 }];
    state.outcome = { kind: "throttled" };
    const r = await dispatchStageEmails();
    console.log("P5 settle patch:", JSON.stringify(state.settles[0]?.patch));
    console.log("P5 result:", JSON.stringify(r));
    expect(state.settles[0]?.patch.status).toBe("pending");
    expect(r.failed).toBe(1);
  });
});
