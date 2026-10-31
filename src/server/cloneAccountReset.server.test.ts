/**
 * The account reset's I/O (`cloneAccountReset.server.ts`): nothing reaches the
 * clone unless it is a demo with a backend that is not the prime, and nothing
 * that leaves carries the password.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    clone: {
      billing_stripe_customer_id: null as string | null,
      entitled_plan_slug: null as string | null,
      tags: ["demo"] as string[] | null,
    } as Record<string, unknown> | null,
    cloneError: null as null | { message: string },
  };
  const client = {
    from: (_table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: state.clone, error: state.cloneError }),
      };
      return chain;
    },
  };
  return {
    state,
    client,
    runSqlOnProject: vi.fn(),
    resolveCloneSecretTarget: vi.fn(),
  };
});

vi.mock("./backend-provisioning.server", () => ({ runSqlOnProject: h.runSqlOnProject }));
vi.mock("./cloneAllowedOrigins.server", () => ({
  resolveCloneSecretTarget: h.resolveCloneSecretTarget,
}));

const PASSWORD = "N3w-pass'word-xyz";
const reset = async (over: Partial<{ account: string; password: string; clear: boolean }> = {}) => {
  const { resetCloneDemoAccount } = await import("./cloneAccountReset.server");
  return resetCloneDemoAccount(h.client as never, "clone-1", {
    account: over.account ?? "Alex.Morgan",
    password: over.password ?? PASSWORD,
    clearAuthenticator: over.clear ?? true,
  });
};

beforeEach(() => {
  h.state.clone = { billing_stripe_customer_id: null, entitled_plan_slug: null, tags: ["demo"] };
  h.state.cloneError = null;
  h.runSqlOnProject.mockReset();
  h.resolveCloneSecretTarget.mockReset();
  h.resolveCloneSecretTarget.mockResolvedValue({ projectRef: "demoref" });
  h.runSqlOnProject.mockResolvedValue([
    {
      outcome: "reset",
      password_verifies: "true",
      authenticator_clear: "true",
      sessions_ended: "2",
    },
  ]);
});

describe("resetCloneDemoAccount", () => {
  it("resets a demo's account on its own backend, in one statement", async () => {
    const res = await reset();
    expect(res).toEqual({
      ok: true,
      account: "alex.morgan",
      authenticatorClear: true,
      sessionsEnded: 2,
    });
    expect(h.runSqlOnProject).toHaveBeenCalledTimes(1);
    const [ref, sql] = h.runSqlOnProject.mock.calls[0] as [string, string];
    expect(ref).toBe("demoref");
    expect(sql).toContain("lower(username) = 'alex.morgan'");
    expect(sql).toContain("mfa_secret_encrypted");
  });

  it("never reaches a clone somebody signs in to", async () => {
    h.state.clone = {
      billing_stripe_customer_id: null,
      entitled_plan_slug: "growth",
      tags: ["demo"],
    };
    const res = await reset();
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/growth plan/) });
    expect(h.runSqlOnProject).not.toHaveBeenCalled();
  });

  it("never reaches the prime, or any backend a clone-scoped write may not reach", async () => {
    h.resolveCloneSecretTarget.mockRejectedValue(new Error("refused: that is the prime"));
    const res = await reset();
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/prime/) });
    expect(h.runSqlOnProject).not.toHaveBeenCalled();
  });

  it("refuses a password the product would refuse before reading anything", async () => {
    const res = await reset({ password: "short" });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/at least 12/) });
    expect(h.resolveCloneSecretTarget).not.toHaveBeenCalled();
    expect(h.runSqlOnProject).not.toHaveBeenCalled();
  });

  it("withholds the password from a failed statement's error", async () => {
    h.runSqlOnProject.mockRejectedValue(
      new Error("SQL execution failed on demoref: 400 — near crypt('N3w-pass''word-xyz'"),
    );
    const res = await reset();
    expect(res.ok).toBe(false);
    const error = res.ok ? "" : res.error;
    expect(error).toMatch(/did not run/);
    expect(error).not.toContain("N3w-pass");
  });

  it("says which account was not found, and changed nothing", async () => {
    h.runSqlOnProject.mockResolvedValue([{ outcome: "no_account" }]);
    expect(await reset({ account: "nobody" })).toEqual({
      ok: false,
      error: expect.stringMatching(/No account on this clone answers to nobody/),
    });
  });

  it("does not call a password set that does not verify", async () => {
    h.runSqlOnProject.mockResolvedValue([
      {
        outcome: "reset",
        password_verifies: "false",
        authenticator_clear: "true",
        sessions_ended: "0",
      },
    ]);
    expect(await reset()).toEqual({ ok: false, error: expect.stringMatching(/does not verify/) });
  });

  it("says so when the authenticator asked to be cleared is still enrolled", async () => {
    h.runSqlOnProject.mockResolvedValue([
      {
        outcome: "reset",
        password_verifies: "true",
        authenticator_clear: "false",
        sessions_ended: "1",
      },
    ]);
    expect(await reset()).toEqual({
      ok: false,
      error: expect.stringMatching(/set and verifies, but its authenticator is still enrolled/),
    });
  });

  it("leaves the authenticator alone when not asked, and says what it found", async () => {
    h.runSqlOnProject.mockResolvedValue([
      {
        outcome: "reset",
        password_verifies: "true",
        authenticator_clear: "false",
        sessions_ended: "1",
      },
    ]);
    const res = await reset({ clear: false });
    expect(res).toEqual({
      ok: true,
      account: "alex.morgan",
      authenticatorClear: false,
      sessionsEnded: 1,
    });
    const [, sql] = h.runSqlOnProject.mock.calls[0] as [string, string];
    expect(sql).not.toContain("mfa_secret_encrypted");
  });
});

describe("readAccountResetEligibility", () => {
  it("says why a clone is refused, and where an eligible one's reset would go", async () => {
    const { readAccountResetEligibility } = await import("./cloneAccountReset.server");
    expect(await readAccountResetEligibility(h.client as never, "clone-1")).toEqual({
      eligible: true,
      projectRef: "demoref",
    });
    h.state.clone = { billing_stripe_customer_id: null, entitled_plan_slug: null, tags: [] };
    expect(await readAccountResetEligibility(h.client as never, "clone-1")).toEqual({
      eligible: false,
      reason: expect.stringMatching(/tagged demo/),
    });
  });

  it("reads a failed clone read as a refusal that says so, never as eligible", async () => {
    const { readAccountResetEligibility } = await import("./cloneAccountReset.server");
    h.state.cloneError = { message: "permission denied" };
    expect(await readAccountResetEligibility(h.client as never, "clone-1")).toEqual({
      eligible: false,
      reason: expect.stringMatching(/Could not read clone clone-1: permission denied/),
    });
  });
});
