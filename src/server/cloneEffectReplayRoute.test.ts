// What /hooks/clone-effect-replay does with what it is asked. The replay
// itself is `migrationEffectReplay.server.test.ts`'s; this drives the real
// route handler and its real cron auth, and pins that a malformed option is
// refused before anything runs. Read leniently, a clone's name in `cloneId`
// became no filter at all, and an invocation meant for one clone replayed
// across every ready clone, with writes on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reconcile: vi.fn(async (_db: unknown, opts: { dryRun?: boolean; cloneId?: string }) => ({
    dryRun: Boolean(opts.dryRun),
    runs: [],
    refused: [],
    pausedAt: null,
  })),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/server/audit.server", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/server/githubUsageMeter", () => ({ beginGithubLane: vi.fn() }));
vi.mock("@/server/githubAllowance.server", () => ({ readGitHubRemaining: async () => 5000 }));
vi.mock("@/server/cascade/githubBudget.pure", () => ({ decideSpend: () => ({ proceed: true }) }));
vi.mock("@/server/migrationEffectReplay.server", () => ({
  reconcileCloneEffectReplays: h.reconcile,
  effectSweepIsNoteworthy: () => false,
}));

import { Route } from "@/routes/hooks.clone-effect-replay";

/** A value for this test only: the real `verifyCronAuth` compares the header with it. */
const SECRET = "test-only-cron-secret";
const CLONE = "11111111-1111-4111-8111-111111111111";

type Handler = (ctx: { request: Request }) => Promise<Response>;
const post = async (body: string | undefined, auth = `Bearer ${SECRET}`) => {
  const handlers = (Route.options as unknown as { server: { handlers: { POST: Handler } } }).server
    .handlers;
  const response = await handlers.POST({
    request: new Request("https://mission-control.test/hooks/clone-effect-replay", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      ...(body === undefined ? {} : { body }),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  h.reconcile.mockClear();
});
afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

describe("POST /hooks/clone-effect-replay", () => {
  it("refuses a caller without the cron secret, and runs nothing", async () => {
    expect((await post("{}", "Bearer not-the-secret")).status).toBe(401);
    expect((await post("{}", "")).status).toBe(401);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("refuses a cloneId that is not a clone's id, rather than running on every clone", async () => {
    for (const cloneId of [
      "orrimere", // a clone's name
      CLONE.slice(0, 35), // a UUID missing a character
      `${CLONE}0`,
      "------------------------------------", // 36 characters of the old pattern's alphabet
      42,
      null,
    ]) {
      const res = await post(JSON.stringify({ cloneId }));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("cloneId must be a clone's id");
    }
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("refuses a dryRun that is not a boolean, rather than running for real", async () => {
    for (const dryRun of ["true", 1, "yes", null]) {
      const res = await post(JSON.stringify({ dryRun, cloneId: CLONE }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("dryRun must be true or false");
    }
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a JSON object, rather than reading it as no options", async () => {
    for (const body of ['{"dryRun": true', "[]", '"dryRun"', "null", "true"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("the body must be a JSON object, or empty");
    }
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("passes a dry run and one clone through as given", async () => {
    const res = await post(JSON.stringify({ dryRun: true, cloneId: CLONE }));
    expect(res.status).toBe(200);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcile.mock.calls[0][1]).toMatchObject({ dryRun: true, cloneId: CLONE });
  });

  it("takes an omitted option's default: an empty body is every ready clone, for real", async () => {
    for (const body of [undefined, "", "  ", "{}"]) {
      expect((await post(body)).status).toBe(200);
    }
    expect(h.reconcile).toHaveBeenCalledTimes(4);
    for (const [, opts] of h.reconcile.mock.calls) {
      expect(opts).toMatchObject({ dryRun: false, cloneId: undefined });
    }
  });
});
