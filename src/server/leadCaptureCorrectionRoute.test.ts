// What the website is told when a Stage 1 application arrives under a
// reference Mission Control already holds: the same application again, or the
// applicant correcting their address from the confirmation screen
// (docs/LEAD_EMAILS.md, "Address corrections"). `aurixa-systems`
// src/lib/leads.ts submitApplication reads only `response.ok`, so a refused
// correction must not be a 2xx — the page would say the email is on its way.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  conflict: { kind: "duplicate", leadId: null } as Record<string, unknown>,
  enqueued: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
          }),
        }),
      }),
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { id: "lead-1" }, error: null }) }),
      }),
    }),
  },
}));
vi.mock("@/server/lead-address-correction.server", () => ({
  resolveStageOneConflict: async () => h.conflict,
}));
vi.mock("@/server/lead-stage-emails.server", () => ({
  enqueueStageEmails: async ({ leadId }: { leadId: string }) => {
    h.enqueued.push(leadId);
    return { queued: 1, skipped: 0, existing: 0 };
  },
}));

process.env.LEAD_CAPTURE_SECRET = "test-secret";
const { Route } = await import("@/routes/api.public.leads.capture");

type Handler = (ctx: { request: Request }) => Promise<Response>;
const post = async () => {
  const handlers = (Route.options as unknown as { server: { handlers: { POST: Handler } } }).server
    .handlers;
  const response = await handlers.POST({
    request: new Request("https://mission-control.test/api/public/leads/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-lead-capture-secret": "test-secret" },
      body: JSON.stringify({
        applicationId: "AX-F86555B04D",
        directiveFirstName: "Jordan",
        directiveLastName: "Lee",
        corporateEmail: "jordan@firm.com",
        entityName: "Firm Pty Ltd",
        source: "AURIXA Contact Waitlist Page",
        page: "/contact",
        submittedAt: "2026-10-29T06:00:00.000Z",
      }),
    }),
  });
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  h.enqueued = [];
});

describe("POST /api/public/leads/capture — a reference already held", () => {
  it("answers a corrected address as accepted, and owes the Stage 1 email again", async () => {
    h.conflict = { kind: "corrected", leadId: "lead-1", from: "a", to: "b", generation: 1 };
    expect(await post()).toEqual({
      status: 200,
      body: { ok: true, lead_id: "lead-1", stage: 1, duplicate: false, corrected: true },
    });
    expect(h.enqueued).toEqual(["lead-1"]);
  });

  it("answers the same application again as a duplicate, owing nothing new", async () => {
    h.conflict = { kind: "duplicate", leadId: "lead-1" };
    expect(await post()).toEqual({
      status: 200,
      body: { ok: true, duplicate: true, lead_id: "lead-1" },
    });
    expect(h.enqueued).toEqual([]);
  });

  it("does not tell the website a refused correction landed", async () => {
    h.conflict = { kind: "refused", leadId: "lead-1", reason: "questionnaire_reached" };
    expect(await post()).toEqual({
      status: 409,
      body: { ok: false, error: "correction_refused", reason: "questionnaire_reached" },
    });
    expect(h.enqueued).toEqual([]);
  });

  it("answers a conflict it could not resolve as unavailable, never as a duplicate", async () => {
    h.conflict = { kind: "unavailable", error: "57014 statement timeout" };
    expect(await post()).toEqual({ status: 503, body: { ok: false, error: "storage_failed" } });
  });
});
