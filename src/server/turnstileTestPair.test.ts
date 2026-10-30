/**
 * Cloudflare's always-pass test pair, for a demo clone and never a customer's.
 *
 * Measured 30 Oct 2026 on `tutorial-demo-orrimere-c158c7`: headed Chromium on
 * Xvfb could not pass the managed check — it asked a person to tick it and did
 * not accept the tick — so the tutorial recorder could not sign in, and
 * Mission Control had no supported way to put a clone on the pair Cloudflare
 * publishes for exactly that. These drive the switch, the keep and the restore
 * through doubles that record what reached the host, the clone and Cloudflare,
 * and in what order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canRotateSecret,
  decideTurnstileSweep,
  isTestSiteKey,
  testPairRefusal,
  turnstileReadiness,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_TEST_SITE_KEY,
  type TurnstileIdentityRow,
} from "./cloneTurnstileIdentity.pure";

const CLONE = "7978f15b-59b8-4cc1-a588-303b144a978a";
const REAL = "0x4AAAAAAREALKEY";
const DEMO = { billing_stripe_customer_id: null, entitled_plan_slug: null, tags: ["demo"] };

const identity = (over: Partial<TurnstileIdentityRow> = {}): TurnstileIdentityRow => ({
  id: "i1",
  clone_id: CLONE,
  site_key: REAL,
  widget_name: "aurixa-clone-tutorial-demo",
  domains: ["tutorial-demo.aurixasystems.com.au"],
  mode: "managed",
  status: "provisioned",
  secret_last4: "abcd",
  secret_written_at: "2026-10-30T02:26:03Z",
  fail_closed_at: "2026-10-30T02:26:03Z",
  site_key_published_at: "2026-10-30T02:26:03Z",
  last_error: null,
  ...over,
});

describe("who may use the test pair", () => {
  it("a clone tagged demo, with no plan and no Stripe customer", () => {
    expect(testPairRefusal(DEMO)).toBeNull();
  });

  it("never a clone somebody pays for or is entitled to", () => {
    expect(testPairRefusal({ ...DEMO, billing_stripe_customer_id: "cus_1" })).toMatch(/Stripe/);
    expect(testPairRefusal({ ...DEMO, entitled_plan_slug: "scale" })).toMatch(/scale plan/);
  });

  it("never a clone its operator has not marked a demo", () => {
    expect(testPairRefusal({ ...DEMO, tags: ["internal"] })).toMatch(/tagged demo/);
    expect(testPairRefusal({ ...DEMO, tags: null })).toMatch(/tagged demo/);
  });
});

describe("the pair, once chosen, is left alone", () => {
  const pair = identity({ site_key: TURNSTILE_TEST_SITE_KEY, domains: [] });

  it("is recognised by its site key", () => {
    expect(isTestSiteKey(TURNSTILE_TEST_SITE_KEY)).toBe(true);
    expect(isTestSiteKey(REAL)).toBe(false);
    expect(isTestSiteKey(null)).toBe(false);
  });

  it("the sweep never replaces it, whatever else it would have done", () => {
    for (const id of [
      pair,
      { ...pair, site_key_published_at: null },
      { ...pair, secret_written_at: null },
    ]) {
      expect(
        decideTurnstileSweep({
          hasProject: true,
          backendReady: true,
          identity: id,
          wantedDomains: ["tutorial-demo.aurixasystems.com.au"],
          now: Date.parse("2026-10-30T05:00:00Z"),
        }),
      ).toEqual({ act: false, reason: "test_pair" });
    }
  });

  it("has no secret to rotate", () => {
    expect(canRotateSecret(pair)).toEqual({
      ok: false,
      reason: expect.stringMatching(/test pair/),
    });
  });

  it("the panel says the clone has no check", () => {
    const r = turnstileReadiness(pair, { cloudflareConfigured: true, accountConfigured: true });
    expect(r.testPair).toBe(true);
    expect(r.steps.find((s) => s.id === "widget")?.detail).toMatch(/every sign-in passes/);
    expect(
      turnstileReadiness(identity(), { cloudflareConfigured: true, accountConfigured: true })
        .testPair,
    ).toBe(false);
  });
});

/* ── The I/O ──────────────────────────────────────────────────────────── */

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    clone: null as Row | null,
    identity: null as Row | null,
    deployment: { project_id: "prj_1", team_id: "team_1" } as Row | null,
    log: [] as string[],
    secretWriteFails: false,
  };
  const single = (pick: () => Row | null) => ({
    eq: () => ({ maybeSingle: async () => ({ data: pick(), error: null }) }),
  });
  const client = {
    from: (table: string) => ({
      select: () => {
        if (table === "clones") return single(() => state.clone);
        if (table === "clone_turnstile_identities") return single(() => state.identity);
        if (table === "clone_deployments") return single(() => state.deployment);
        if (table === "platform_hosting_config") {
          return single(() => ({ cloudflare_account_id: "acct_1" }));
        }
        throw new Error(`unexpected select on ${table}`);
      },
      upsert: async (row: Row) => {
        if (table === "clone_turnstile_identities") {
          state.identity = { ...(state.identity ?? {}), ...row };
        }
        return { error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
  return { state, client };
});

vi.mock("./cloneAllowedOrigins.server", () => ({
  resolveCloneSecretTarget: vi.fn(async () => ({ projectRef: "cloneref" })),
  CloneSecretTargetError: class extends Error {},
}));
vi.mock("./backend-provisioning.server", () => ({
  setCloneSecretValue: vi.fn(async (_ref: string, name: string, value: string) => {
    if (h.state.secretWriteFails && name === "TURNSTILE_SECRET_KEY") {
      return { ok: false, error: "the project refused the write" };
    }
    h.state.log.push(`secret ${name}=${name === "TURNSTILE_SECRET_KEY" ? value.slice(-4) : value}`);
    return { ok: true, written: [name] };
  }),
}));
vi.mock("./hosting/vercel-client", () => ({
  isVercelConfigured: () => true,
  vercelApi: {
    upsertEnv: vi.fn(async (_project: string, vars: Array<{ key: string; value: string }>) => {
      for (const v of vars) h.state.log.push(`env ${v.key}=${v.value}`);
    }),
  },
}));
vi.mock("./cloudflare/client", () => ({
  cloudflareApi: {
    deleteTurnstileWidget: vi.fn(async (_acct: string, key: string) => {
      h.state.log.push(`cloudflare delete ${key}`);
    }),
    getTurnstileWidget: vi.fn(async () => {
      throw new Error("the test pair has no widget at Cloudflare");
    }),
    createTurnstileWidget: vi.fn(async () => {
      h.state.log.push("cloudflare create");
      return { sitekey: "0x4AAAAAANEWKEY", secret: "0xNEWSECRETnew1" };
    }),
  },
}));
vi.mock("./hosting/redeploy.server", () => ({
  requestEnvResync: vi.fn(async (input: { reason: string }) => {
    h.state.log.push(`rebuild: ${input.reason}`);
    return { queued: true, from: "live" };
  }),
}));

describe("switchToTurnstileTestPair", () => {
  beforeEach(() => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
    h.state.clone = {
      slug: "tutorial-demo-orrimere-c158c7",
      subdomain_fqdn: "tutorial-demo.aurixasystems.com.au",
      deploy_url: null,
      ...DEMO,
    };
    h.state.identity = { ...identity() };
    h.state.log = [];
    h.state.secretWriteFails = false;
  });
  afterEach(() => vi.unstubAllEnvs());

  const sw = async () => {
    const { switchToTurnstileTestPair } = await import("./turnstile-identity.server");
    return switchToTurnstileTestPair(h.client as never, CLONE, "operator-1");
  };

  it("publishes the test key, then writes the test secret, then deletes the real widget, then rebuilds", async () => {
    const res = await sw();
    expect(res.ok).toBe(true);
    expect(h.state.log).toEqual([
      `env VITE_TURNSTILE_SITE_KEY=${TURNSTILE_TEST_SITE_KEY}`,
      `secret TURNSTILE_SECRET_KEY=${TURNSTILE_TEST_SECRET.slice(-4)}`,
      "secret REQUIRE_TURNSTILE=true",
      `cloudflare delete ${REAL}`,
      "rebuild: Turnstile test pair published",
    ]);
    expect(h.state.identity).toMatchObject({
      site_key: TURNSTILE_TEST_SITE_KEY,
      status: "provisioned",
      secret_last4: TURNSTILE_TEST_SECRET.slice(-4),
    });
    expect(res.ok && res.readiness.testPair).toBe(true);
  });

  it("refuses a clone somebody is entitled to, and touches nothing", async () => {
    h.state.clone = { ...h.state.clone, entitled_plan_slug: "launch" };
    const res = await sw();
    expect(res.ok).toBe(false);
    expect(h.state.log).toEqual([]);
    expect(h.state.identity).toMatchObject({ site_key: REAL });
  });

  it("puts the real key back when the test secret cannot be written", async () => {
    // Never the test widget drawn against the real secret: nobody could sign in.
    h.state.secretWriteFails = true;
    const res = await sw();
    expect(res.ok).toBe(false);
    expect(h.state.log).toEqual([
      `env VITE_TURNSTILE_SITE_KEY=${TURNSTILE_TEST_SITE_KEY}`,
      `env VITE_TURNSTILE_SITE_KEY=${REAL}`,
    ]);
    expect(h.state.identity).toMatchObject({
      site_key: REAL,
      last_error: expect.stringMatching(/not applied/),
    });
  });

  it("refuses before touching anything when the secret has nowhere it may go (the prime)", async () => {
    const { resolveCloneSecretTarget } = await import("./cloneAllowedOrigins.server");
    vi.mocked(resolveCloneSecretTarget).mockRejectedValueOnce(
      new Error("target_is_prime: refusing to write the prime's project"),
    );
    const res = await sw();
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.error).toMatch(/target_is_prime/);
    expect(h.state.log).toEqual([]);
    expect(h.state.identity).toMatchObject({ site_key: REAL });
  });

  it("returns a clone that had no widget to having none when the secret cannot be written", async () => {
    h.state.identity = null;
    h.state.secretWriteFails = true;
    const res = await sw();
    expect(res.ok).toBe(false);
    expect(h.state.log).toEqual([`env VITE_TURNSTILE_SITE_KEY=${TURNSTILE_TEST_SITE_KEY}`]);
    expect(h.state.identity).toMatchObject({
      site_key: null,
      site_key_published_at: null,
      status: "unprovisioned",
    });
  });

  it("keeps the pair when the drain asks for the clone's key, with no vendor call", async () => {
    h.state.identity = { ...identity({ site_key: TURNSTILE_TEST_SITE_KEY }) };
    const { provisionTurnstileIdentity } = await import("./turnstile-identity.server");
    const res = await provisionTurnstileIdentity(h.client as never, CLONE, { mode: "provision" });
    expect(res.ok && res.row?.site_key).toBe(TURNSTILE_TEST_SITE_KEY);
    expect(h.state.log).toEqual([]);
    const refresh = await provisionTurnstileIdentity(h.client as never, CLONE, { mode: "refresh" });
    expect(refresh.ok).toBe(false);
  });

  it("restores a real widget, publishing its key before its secret, and rebuilds", async () => {
    h.state.identity = { ...identity({ site_key: TURNSTILE_TEST_SITE_KEY, secret_last4: "00AA" }) };
    const { restoreTurnstileWidget } = await import("./turnstile-identity.server");
    const res = await restoreTurnstileWidget(h.client as never, CLONE, "operator-1");
    expect(res.ok).toBe(true);
    expect(h.state.log).toEqual([
      "cloudflare create",
      "env VITE_TURNSTILE_SITE_KEY=0x4AAAAAANEWKEY",
      "secret TURNSTILE_SECRET_KEY=new1",
      "secret REQUIRE_TURNSTILE=true",
      "rebuild: Turnstile widget restored",
    ]);
    expect(h.state.identity).toMatchObject({ site_key: "0x4AAAAAANEWKEY", status: "provisioned" });
  });
});
