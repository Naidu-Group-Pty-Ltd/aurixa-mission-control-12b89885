// What the website is told when a Stage 1 application arrives under a
// reference Mission Control already holds: the same application again, or the
// applicant correcting their address from the confirmation screen
// (docs/LEAD_EMAILS.md, "Address corrections"). `aurixa-systems`
// src/lib/leads.ts submitApplication reads only `response.ok`, so a refused
// correction must not be a 2xx — the page would say the email is on its way.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  conflict: { kind: "duplicate", leadId: null } as Record<string, unknown>,
  conflictInput: null as Record<string, unknown> | null,
  enqueued: [] as string[],
  // A first application lands; one under a held reference conflicts.
  held: true,
  inserted: [] as Record<string, unknown>[],
  limited: false,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            h.inserted.push(row);
            return h.held
              ? {
                  data: null,
                  error: {
                    code: "23505",
                    message: "duplicate key value violates unique constraint",
                  },
                }
              : { data: { id: "lead-new" }, error: null };
          },
        }),
      }),
      select: () => {
        // The insert-counting rate limits: nothing counted.
        const counted = { count: 0, error: null };
        const window = {
          contains: async () => counted,
          then: (resolve: (v: unknown) => void) => resolve(counted),
        };
        return {
          eq: () => ({ maybeSingle: async () => ({ data: { id: "lead-1" }, error: null }) }),
          gte: () => window,
        };
      },
    }),
  },
}));
vi.mock("@/server/lead-address-correction.server", () => ({
  CORRECTION_TOKEN_KEY: "correction_token_sha256",
  correctionTokenFor: (presented: unknown) =>
    typeof presented === "string"
      ? { sha256: "b".repeat(64), issued: null }
      : { sha256: "a".repeat(64), issued: "tok_for_the_browser" },
  resolveStageOneConflict: async (input: Record<string, unknown>) => {
    h.conflictInput = input;
    return h.conflict;
  },
}));
vi.mock("@/server/token-rate-limit.server", () => ({
  checkPublicRateLimit: async () => (h.limited ? { ok: false } : { ok: true }),
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
const post = async (extra: Record<string, unknown> = {}, trusted = true) => {
  const handlers = (Route.options as unknown as { server: { handlers: { POST: Handler } } }).server
    .handlers;
  const response = await handlers.POST({
    request: new Request("https://mission-control.test/api/public/leads/capture", {
      method: "POST",
      headers: trusted
        ? { "Content-Type": "application/json", "x-lead-capture-secret": "test-secret" }
        : { "Content-Type": "application/json", Origin: "https://www.aurixasystems.com.au" },
      body: JSON.stringify({
        ...extra,
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
  h.held = true;
  h.inserted = [];
  h.conflictInput = null;
  h.limited = false;
});

describe("POST /api/public/leads/capture — a new application", () => {
  it("keeps the hash of the token the browser generated, and hands nothing back", async () => {
    h.held = false;
    const { status, body } = await post({ correctionToken: "generated_in_the_browser_0123" });
    expect(status).toBe(201);
    expect(body).not.toHaveProperty("correction_token");
    const metadata = h.inserted[0]?.metadata as Record<string, unknown>;
    expect(metadata.correction_token_sha256).toBe("b".repeat(64));
    expect(JSON.stringify(h.inserted)).not.toContain("generated_in_the_browser_0123");
  });

  it("hands a browser that sent no token one, and keeps only its hash", async () => {
    h.held = false;
    const { status, body } = await post();
    expect(status).toBe(201);
    expect(body).toMatchObject({
      ok: true,
      lead_id: "lead-new",
      correction_token: "tok_for_the_browser",
    });
    const metadata = h.inserted[0]?.metadata as Record<string, unknown>;
    expect(metadata.correction_token_sha256).toBe("a".repeat(64));
    expect(JSON.stringify(h.inserted)).not.toContain("tok_for_the_browser");
  });
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

  it("passes on the token the browser sent back, and whether the request is the funnel's own", async () => {
    h.conflict = { kind: "duplicate", leadId: "lead-1" };
    await post({ correctionToken: "tok_for_the_browser" });
    expect(h.conflictInput).toMatchObject({
      correctionToken: "tok_for_the_browser",
      trusted: true,
    });
  });

  it("limits how often a browser may post a reference it holds", async () => {
    h.limited = true;
    expect(await post({}, false)).toEqual({
      status: 429,
      body: { ok: false, error: "rate_limited" },
    });
    expect(h.conflictInput).toBeNull();
  });

  it("answers a conflict it could not resolve as unavailable, never as a duplicate", async () => {
    h.conflict = { kind: "unavailable", error: "57014 statement timeout" };
    expect(await post()).toEqual({ status: 503, body: { ok: false, error: "storage_failed" } });
  });
});
