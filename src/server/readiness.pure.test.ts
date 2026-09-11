import { describe, it, expect } from "vitest";
import {
  judgeReadiness,
  CAPABILITIES,
  CLONE_PATH,
  PRESENCE_CAVEAT,
  type ConfigCheck,
} from "./readiness.pure";

/** Every credential name in the catalog, so a test can start from "all set". */
const ALL = new Set(CAPABILITIES.flatMap((c) => c.credentials.map((x) => x.name)));

const without = (...names: string[]) => {
  const s = new Set(ALL);
  for (const n of names) s.delete(n);
  return s;
};

const cfg = (over: Partial<ConfigCheck> = {}): ConfigCheck => ({
  label: "Zone bound",
  ok: true,
  detail: "Cloudflare zone is bound",
  remedy: "Settings → Domains",
  ...over,
});

const capability = (report: ReturnType<typeof judgeReadiness>, key: string) => {
  const c = report.capabilities.find((x) => x.key === key);
  if (!c) throw new Error(`no capability ${key}`);
  return c;
};

describe("judgeReadiness", () => {
  it("reports ready when nothing required or optional is missing", () => {
    const r = judgeReadiness({ present: ALL, config: {} });
    expect(r.blocked).toBe(0);
    expect(r.degraded).toBe(0);
    expect(r.cloneReady).toBe(true);
  });

  it("blocks a capability on a missing required credential, and names it", () => {
    const r = judgeReadiness({ present: without("VERCEL_API_TOKEN"), config: {} });
    const hosting = capability(r, "hosting");
    expect(hosting.verdict).toBe("blocked");
    expect(hosting.blockers).toHaveLength(1);
    expect(hosting.blockers[0]).toContain("VERCEL_API_TOKEN");
    expect(r.cloneReady).toBe(false);
  });

  /**
   * A missing optional credential is a real reduction in service and is NOT a
   * failure. Drawing the two the same way is how a readiness screen becomes a
   * wall of red that nobody reads.
   */
  it("degrades rather than blocks on a missing optional credential", () => {
    const r = judgeReadiness({ present: without("VERCEL_WEBHOOK_SECRET"), config: {} });
    const hosting = capability(r, "hosting");
    expect(hosting.verdict).toBe("degraded");
    expect(hosting.blockers).toEqual([]);
    expect(r.cloneReady).toBe(true);
  });

  it("blocks on a failed config check even when every credential is set", () => {
    // Cloudflare had its token question look answered while
    // `cloudflare_account_id` and `cloudflare_zone_id` were both NULL, so
    // nothing could write a DNS record. Credentials alone cannot see that.
    const r = judgeReadiness({
      present: ALL,
      config: { dns: [cfg({ ok: false, detail: "No Cloudflare zone is bound" })] },
    });
    const dns = capability(r, "dns");
    expect(dns.verdict).toBe("blocked");
    expect(dns.blockers[0]).toContain("No Cloudflare zone is bound");
    expect(dns.blockers[0]).toContain("Settings → Domains");
  });

  /**
   * `null` means this side cannot answer. Collapsing it either way is the
   * failure: `false` raises a false alarm, `true` hides a real gap.
   */
  it("reports an unanswerable config check as unknown, never as ready or blocked", () => {
    const r = judgeReadiness({ present: ALL, config: { dns: [cfg({ ok: null })] } });
    const dns = capability(r, "dns");
    expect(dns.verdict).toBe("unknown");
    expect(dns.blockers).toEqual([]);
  });

  it("lets a real blocker outrank an unknown", () => {
    const r = judgeReadiness({
      present: without("CLOUDFLARE_API_TOKEN"),
      config: { dns: [cfg({ ok: null })] },
    });
    expect(capability(r, "dns").verdict).toBe("blocked");
  });

  it("reports every blocker on a capability, not just the first", () => {
    const r = judgeReadiness({
      present: without("SB_MGMT_API_TOKEN", "SB_ORG_ID"),
      config: {},
    });
    expect(capability(r, "clone_backend").blockers).toHaveLength(2);
  });

  /**
   * A blocked Stripe is a real problem and is not a reason to tell somebody
   * they cannot clone. Conflating "something is wrong" with "the thing you
   * are about to do is impossible" is how the screen stops being read.
   */
  it("keeps cloneReady to the clone path", () => {
    const r = judgeReadiness({ present: without("STRIPE_SECRET_KEY"), config: {} });
    expect(r.blocked).toBe(1);
    expect(r.cloneReady).toBe(true);
  });

  it.each(CLONE_PATH)("blocks cloneReady when %s is blocked", (key) => {
    const spec = CAPABILITIES.find((c) => c.key === key);
    const required = spec?.credentials.find((c) => c.required);
    if (!required) throw new Error(`${key} has no required credential`);
    const r = judgeReadiness({ present: without(required.name), config: {} });
    expect(r.cloneReady).toBe(false);
  });

  it("never reports a credential as valid, only as set", () => {
    // Presence is all this can establish. A word like "ok" or "working" here
    // would be a green light that is true about the check and false about the
    // world — the exact shape this codebase keeps finding.
    const r = judgeReadiness({ present: ALL, config: {} });
    const states = new Set(r.capabilities.flatMap((c) => c.credentials.map((x) => x.state)));
    expect([...states]).toEqual(["set"]);
    expect(PRESENCE_CAVEAT).toContain("revoked");
  });

  /**
   * The caveat travels ON the report. It used to be exported to the card,
   * which is a VALUE import of `src/server/**` and is denied to the client
   * bundle — so the qualification either ships with the answer or a renderer
   * has to reach across a boundary the build refuses to let it cross.
   */
  it("carries the presence caveat on every report it returns", () => {
    for (const present of [ALL, without("VERCEL_API_TOKEN"), new Set<string>()]) {
      expect(judgeReadiness({ present, config: {} }).caveat).toBe(PRESENCE_CAVEAT);
    }
  });
});

describe("the catalog", () => {
  it("covers every capability the clone path names", () => {
    for (const key of CLONE_PATH) {
      expect(CAPABILITIES.some((c) => c.key === key)).toBe(true);
    }
  });

  it("gives every credential a purpose an operator can act on", () => {
    for (const cap of CAPABILITIES) {
      for (const cred of cap.credentials) {
        expect(cred.purpose.length).toBeGreaterThan(15);
      }
    }
  });

  it("says what breaks for every capability", () => {
    for (const cap of CAPABILITIES) {
      expect(cap.consequence.length).toBeGreaterThan(15);
    }
  });

  it("uses each credential name once", () => {
    const names = CAPABILITIES.flatMap((c) => c.credentials.map((x) => x.name));
    expect(new Set(names).size).toBe(names.length);
  });
});

/*
 * Anthropic attribution.
 *
 * A separate capability from `models` on purpose, and the test that matters is
 * that they fail independently: every clone can be calling Claude perfectly
 * while the whole fleet's spend arrives as one undifferentiated figure, and a
 * report that collapsed the two would say "model routing is ready" and be
 * right about the wrong question.
 */
describe("the Anthropic attribution capability", () => {
  it("is its own capability, not folded into model routing", () => {
    const r = judgeReadiness({ present: ALL, config: {} });
    const attribution = capability(r, "anthropic_attribution");
    const models = capability(r, "models");
    expect(attribution.key).not.toBe(models.key);
    // They share no credential name, which is what makes them independent.
    const a = new Set(attribution.credentials.map((c) => c.name));
    for (const c of models.credentials) expect(a.has(c.name)).toBe(false);
  });

  /*
   * Phase 1 alone is a WORKING deployment: every clone gets its own workspace
   * and keeps the organisation key. Reporting that as blocked would send an
   * operator to fix something that is not broken.
   */
  it("is degraded rather than blocked when only the admin key is set", () => {
    const present = without(
      "ANTHROPIC_FEDERATION_PRIVATE_KEY",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_BOOTSTRAP_RULE_ID",
      "ANTHROPIC_BOOTSTRAP_SERVICE_ACCOUNT_ID",
    );
    const c = capability(judgeReadiness({ present, config: {} }), "anthropic_attribution");
    expect(c.verdict).toBe("degraded");
  });

  /*
   * Without the admin key there is no workspace, so there is no per-tenant
   * figure at all — which is the thing this capability exists to produce.
   */
  it("is blocked without the key that creates a workspace", () => {
    const c = capability(
      judgeReadiness({ present: without("ANTHROPIC_ADMIN_KEY"), config: {} }),
      "anthropic_attribution",
    );
    expect(c.verdict).toBe("blocked");
    expect(c.blockers.join(" ")).toContain("ANTHROPIC_ADMIN_KEY");
  });

  /*
   * The admin key manages the organisation and cannot make a model call; the
   * key a clone spends cannot manage the organisation. One name for both
   * invites setting the wrong one, and each fails in a way that reads like the
   * other — so the purpose has to say which is which.
   */
  it("says the admin key is not the key a clone spends", () => {
    const c = capability(judgeReadiness({ present: ALL, config: {} }), "anthropic_attribution");
    const admin = c.credentials.find((x) => x.name === "ANTHROPIC_ADMIN_KEY");
    expect(admin?.purpose).toMatch(/cannot make a model call/i);
  });

  /*
   * Configuration is not reachability, and a config check that could not be
   * read must never read as a failure — the module's own rule, applied to the
   * ledger this capability measures.
   */
  it("carries an unreadable ledger as unknown rather than as a fault", () => {
    const c = capability(
      judgeReadiness({
        present: ALL,
        config: {
          anthropic_attribution: [
            cfg({ label: "Per-clone workspaces", ok: null, detail: "could not be read" }),
          ],
        },
      }),
      "anthropic_attribution",
    );
    expect(c.verdict).toBe("unknown");
  });

  it("is blocked by a config check that failed, not only by a missing name", () => {
    const c = capability(
      judgeReadiness({
        present: ALL,
        config: {
          anthropic_attribution: [
            cfg({ label: "Federation bootstrap", ok: false, detail: "not configured" }),
          ],
        },
      }),
      "anthropic_attribution",
    );
    expect(c.verdict).toBe("blocked");
  });

  /*
   * The consequence line is what an operator reads to decide whether to care.
   * "Anything that calls a model fails" is the OTHER capability; this one
   * costs money quietly rather than failing loudly, and the wording has to
   * carry that difference.
   */
  it("names the consequence as a billing one rather than an outage", () => {
    const c = capability(judgeReadiness({ present: ALL, config: {} }), "anthropic_attribution");
    expect(c.consequence).toMatch(/recharge|spend|line/i);
    expect(c.consequence).not.toMatch(/\bfails\b/i);
  });
});
