// What the website's Stage 3 scheduler is told when it asks whether an
// applicant may open it. The page reads exactly this shape — the one the Make
// scenario "Aurixa Stage 3 Access" answered with — so the field names are the
// contract: `aurixa-systems` src/lib/strategicReviewAccess.ts, parseAccessDecision.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./testing/bookingFakes";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, limited: false }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => h.db.from(table) },
}));
vi.mock("@/server/token-rate-limit.server", () => ({
  checkPublicRateLimit: async () =>
    h.limited ? { ok: false, retry_after_seconds: 30 } : { ok: true },
}));

import { Route } from "@/routes/api.public.storefront.strategic-review-access";

const REF = "AX-7Q2M4L9XZ1";
const LEAD = {
  id: "lead_1",
  application_id: REF,
  first_name: "Jane",
  last_name: "Citizen",
  email: "Jane@Citizen.com.au",
  entity_name: "Citizen Property Group",
  status: "new",
  airtable_status: null,
  stage2_completed_at: "2026-09-02T00:00:00.000Z",
  stage2_airtable_record_id: null,
  created_at: "2026-09-01T00:00:00.000Z",
};

type Handler = (ctx: { request: Request }) => Promise<Response>;
const post = async (body: unknown) => {
  const handlers = (Route.options as unknown as { server: { handlers: { POST: Handler } } }).server
    .handlers;
  const response = await handlers.POST({
    request: new Request(
      "https://mission-control.test/api/public/storefront/strategic-review-access",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://www.aurixasystems.com.au" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
  });
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  h.db = createFakeDb({ waitlist_leads: [{ ...LEAD }] });
  h.limited = false;
});

describe("POST /api/public/storefront/strategic-review-access", () => {
  it("admits a granted applicant with the details the page fills in", async () => {
    expect(await post({ applicationId: "ax 7q2m4l9xz1" })).toEqual({
      status: 200,
      body: {
        ok: true,
        applicant: {
          applicationId: REF,
          firstName: "Jane",
          lastName: "Citizen",
          workEmail: "jane@citizen.com.au",
          organisationName: "Citizen Property Group",
        },
      },
    });
  });

  it("refuses, without saying why, an application the gate does not grant", async () => {
    h.db.tables.waitlist_leads = [{ ...LEAD, status: "disqualified" }];
    expect(await post({ applicationId: REF })).toEqual({
      status: 200,
      body: { ok: false, reason: "not_granted" },
    });
    expect(await post({ applicationId: "not a reference" })).toEqual({
      status: 200,
      body: { ok: false, reason: "invalid_reference" },
    });
  });

  it("answers 503 when the record cannot be read — never a refusal", async () => {
    h.db.failReads.add("waitlist_leads");
    expect(await post({ applicationId: REF })).toEqual({
      status: 503,
      body: { ok: false, reason: "unavailable" },
    });
  });

  it("is rate limited, and refuses a body that is not JSON", async () => {
    expect((await post("{not json")).status).toBe(400);
    h.limited = true;
    expect((await post({ applicationId: REF })).status).toBe(429);
  });
});
