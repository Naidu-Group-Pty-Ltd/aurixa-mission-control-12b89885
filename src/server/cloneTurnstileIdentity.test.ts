import { describe, it, expect } from "vitest";
import {
  backendHoldsAProject,
  canRotateSecret,
  decideTurnstileSweep,
  deriveWidgetDomains,
  deriveWidgetName,
  isPrimeSiteKey,
  secretLast4,
  turnstileReadiness,
  TURNSTILE_SWEEP_COOLDOWN_MS,
  type TurnstileIdentityRow,
} from "./cloneTurnstileIdentity.pure";

const row = (over: Partial<TurnstileIdentityRow> = {}): TurnstileIdentityRow => ({
  id: "t-1",
  clone_id: "c-1",
  site_key: null,
  widget_name: null,
  domains: [],
  mode: "managed",
  status: "unprovisioned",
  secret_last4: null,
  secret_written_at: null,
  fail_closed_at: null,
  site_key_published_at: null,
  last_error: null,
  ...over,
});

const CF = { cloudflareConfigured: true, accountConfigured: true };

describe("deriveWidgetDomains", () => {
  it("covers every host the login page is served from", () => {
    expect(
      deriveWidgetDomains({
        slug: "npc",
        subdomain_fqdn: "npc.aurixasystems.com.au",
        deploy_url: "https://npc-client.vercel.app",
      }),
    ).toEqual(["npc-client.vercel.app", "npc.aurixasystems.com.au"]);
  });

  it("keeps the provider origin — unlike email, a vercel.app host really serves the login page", () => {
    expect(
      deriveWidgetDomains({
        slug: "npc",
        subdomain_fqdn: null,
        deploy_url: "https://x.vercel.app",
      }),
    ).toEqual(["x.vercel.app"]);
  });

  it("returns nothing when the clone has no resolvable host — a widget with no domain issues nothing", () => {
    expect(deriveWidgetDomains({ slug: "npc", subdomain_fqdn: null, deploy_url: null })).toEqual(
      [],
    );
  });

  it("de-duplicates when both facts name the same host", () => {
    expect(
      deriveWidgetDomains({
        slug: "npc",
        subdomain_fqdn: "npc.example.com",
        deploy_url: "https://npc.example.com/auth",
      }),
    ).toEqual(["npc.example.com"]);
  });
});

describe("widget naming and secret handling", () => {
  it("names the widget after the clone", () => {
    expect(deriveWidgetName("npc-client-dashboard")).toBe("aurixa-clone-npc-client-dashboard");
    expect(deriveWidgetName("")).toBe("aurixa-clone-unnamed");
  });

  it("keeps only the last four characters of a secret", () => {
    expect(secretLast4("0x4AAAAAAsecretVALUE")).toBe("ALUE");
  });
});

describe("isPrimeSiteKey", () => {
  it("recognises the prime's own widget so a clone can never be handed it", () => {
    expect(isPrimeSiteKey("0x4AAAAAAChQyb0ZxBORhxWq", "0x4AAAAAAChQyb0ZxBORhxWq")).toBe(true);
  });

  it("is false for a clone's own key, and for unknown values", () => {
    expect(isPrimeSiteKey("0xCLONEKEY", "0x4AAAAAAChQyb0ZxBORhxWq")).toBe(false);
    expect(isPrimeSiteKey(null, "0x4AAAAAAChQyb0ZxBORhxWq")).toBe(false);
    expect(isPrimeSiteKey("0xCLONEKEY", null)).toBe(false);
  });
});

describe("turnstileReadiness", () => {
  it("opens on Cloudflare configuration before anything else", () => {
    const r = turnstileReadiness(null, { cloudflareConfigured: false, accountConfigured: false });
    expect(r.next).toBe("cloudflare");
    expect(r.live).toBe(false);
    expect(r.steps.filter((s) => s.state === "open")).toHaveLength(1);
  });

  it("distinguishes a missing token from a missing account id", () => {
    const noAccount = turnstileReadiness(null, {
      cloudflareConfigured: true,
      accountConfigured: false,
    });
    expect(noAccount.steps[0].detail).toMatch(/cloudflare_account_id/);
  });

  it("walks widget → secret → site key → fail-closed in order", () => {
    expect(turnstileReadiness(row(), CF).next).toBe("widget");
    expect(turnstileReadiness(row({ site_key: "0xK" }), CF).next).toBe("secret_written");
    expect(
      turnstileReadiness(row({ site_key: "0xK", secret_written_at: "2026-08-29T00:00:00Z" }), CF)
        .next,
    ).toBe("site_key_published");
    expect(
      turnstileReadiness(
        row({
          site_key: "0xK",
          secret_written_at: "2026-08-29T00:00:00Z",
          site_key_published_at: "2026-08-29T00:00:00Z",
        }),
        CF,
      ).next,
    ).toBe("fail_closed");
  });

  it("is live only once the clone also fails closed", () => {
    const r = turnstileReadiness(
      row({
        site_key: "0xK",
        domains: ["npc.example.com"],
        secret_last4: "ABCD",
        secret_written_at: "2026-08-29T00:00:00Z",
        site_key_published_at: "2026-08-29T00:00:00Z",
        fail_closed_at: "2026-08-29T00:00:00Z",
        status: "provisioned",
      }),
      CF,
    );
    expect(r.live).toBe(true);
    expect(r.next).toBeNull();
  });
});

describe("canRotateSecret", () => {
  it("refuses with a reason when there is no widget", () => {
    const v = canRotateSecret(row());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no Turnstile widget/);
  });

  it("refuses a revoked widget rather than resurrecting it implicitly", () => {
    const v = canRotateSecret(row({ site_key: "0xK", status: "revoked" }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/revoked/);
  });

  it("permits rotation for a live widget", () => {
    expect(canRotateSecret(row({ site_key: "0xK", status: "provisioned" })).ok).toBe(true);
  });
});

describe("decideTurnstileSweep", () => {
  const NOW = Date.parse("2026-08-29T12:00:00Z");
  const facts = (over: Partial<Parameters<typeof decideTurnstileSweep>[0]> = {}) => ({
    hasProject: true,
    backendReady: true,
    identity: null,
    wantedDomains: ["npc.aurixasystems.com.au"],
    now: NOW,
    ...over,
  });

  const complete = (over: Partial<TurnstileIdentityRow> = {}) =>
    row({
      site_key: "0xK",
      status: "provisioned",
      secret_written_at: "2026-08-29T10:00:00Z",
      site_key_published_at: "2026-08-29T10:00:00Z",
      domains: ["npc.aurixasystems.com.au"],
      ...over,
    });

  it("provisions a clone that has no widget", () => {
    const v = decideTurnstileSweep(facts());
    expect(v).toMatchObject({ act: true, action: "provision" });
  });

  it("leaves a revoked identity alone — that was an operator decision", () => {
    const v = decideTurnstileSweep(facts({ identity: row({ status: "revoked" }) }));
    expect(v).toEqual({ act: false, reason: "revoked" });
  });

  it("waits for somewhere to put the secret", () => {
    // The secret is written to the clone's own Supabase project, so without a
    // ready backend there is nothing to write it to.
    expect(decideTurnstileSweep(facts({ backendReady: false }))).toEqual({
      act: false,
      reason: "backend_not_ready",
    });
  });

  /**
   * A clone with no hosting project is NOT mid-pipeline, and treating it as
   * though it were is what left most of this fleet with no CAPTCHA of its own.
   *
   * This rule used to refuse outright, justified as "the drain will mint its
   * widget when it reaches `syncing_env`". That case opens
   * `if (!row.project_id) return`, and provisioning writes the deployment row
   * as `not_requested` for `manual` and `none`, and `pending_platform` when no
   * Vercel token is configured. A deployment in any of those three states
   * never advances — so the drain never minted, and this sweep refused the
   * same clone every ten minutes for ever, naming a step that was never
   * coming. Every clone in this fleet is served manually.
   */
  it("mints for a clone that will never have a hosting project", () => {
    expect(decideTurnstileSweep(facts({ hasProject: false }))).toMatchObject({
      act: true,
      action: "provision",
    });
  });

  /**
   * Publishing is the one step that genuinely needs a project, so it is the
   * one step that waits for one — and it WAITS rather than retrying, or a
   * manual clone would re-attempt an impossible publish on every pass and bury
   * the identities that can still be advanced.
   */
  it("holds the site-key publish, and only the publish, for a hosting project", () => {
    expect(
      decideTurnstileSweep(
        facts({ hasProject: false, identity: complete({ site_key_published_at: null }) }),
      ),
    ).toEqual({ act: false, reason: "no_hosting_project_to_publish_to" });

    // With a project, the same identity is acted on.
    expect(
      decideTurnstileSweep(
        facts({ hasProject: true, identity: complete({ site_key_published_at: null }) }),
      ),
    ).toMatchObject({ act: true, action: "provision" });
  });

  /**
   * A widget with no domain issues no token anywhere — `provisionTurnstile-
   * Identity` refuses it by name — so refusing here saves a Cloudflare round
   * trip rather than changing the outcome. Asked on the MINT path only: an
   * already-complete identity whose hostnames went away reads `complete`, not
   * drift.
   */
  it("will not mint a widget scoped to nothing", () => {
    expect(decideTurnstileSweep(facts({ wantedDomains: [] }))).toEqual({
      act: false,
      reason: "no_hostname_yet",
    });
  });

  it("ROTATES a widget whose secret never reached the clone", () => {
    // Cloudflare returns a secret on create and rotate only, so adopting an
    // existing widget yields nothing to deliver. Provisioning again would
    // report success and leave the clone exactly as broken.
    const v = decideTurnstileSweep(
      facts({ identity: row({ site_key: "0xK", status: "provisioned" }) }),
    );
    expect(v).toMatchObject({ act: true, action: "rotate" });
  });

  it("never rotates a secret that WAS delivered", () => {
    const v = decideTurnstileSweep(facts({ identity: complete() }));
    expect(v).toEqual({ act: false, reason: "complete" });
  });

  it("publishes a site key that was minted but never published", () => {
    const v = decideTurnstileSweep(facts({ identity: complete({ site_key_published_at: null }) }));
    expect(v).toMatchObject({ act: true, action: "provision" });
  });

  it("refreshes when the clone's hostnames have changed", () => {
    const v = decideTurnstileSweep(
      facts({
        identity: complete({ domains: ["old.aurixasystems.com.au"] }),
        wantedDomains: ["npc.aurixasystems.com.au", "npc.example.com"],
      }),
    );
    expect(v).toMatchObject({ act: true, action: "refresh" });
  });

  it("does not call it drift when the lists differ only in order", () => {
    const v = decideTurnstileSweep(
      facts({
        identity: complete({ domains: ["b.example.com", "a.example.com"] }),
        wantedDomains: ["a.example.com", "b.example.com"],
      }),
    );
    expect(v).toEqual({ act: false, reason: "complete" });
  });

  it("holds off on a recent failure instead of retrying every pass", () => {
    const v = decideTurnstileSweep(
      facts({
        identity: row({ last_error: "boom", updated_at: "2026-08-29T11:50:00Z" }),
      }),
    );
    expect(v).toEqual({ act: false, reason: "cooling_off" });
  });

  it("retries once the cooling-off window has passed", () => {
    const v = decideTurnstileSweep(
      facts({
        identity: row({
          last_error: "boom",
          updated_at: new Date(NOW - TURNSTILE_SWEEP_COOLDOWN_MS - 1000).toISOString(),
        }),
      }),
    );
    expect(v).toMatchObject({ act: true, action: "provision" });
  });

  it("a clone with no resolvable hostname is complete rather than churning", () => {
    // deriveWidgetDomains returns [] and provisioning would refuse; treating
    // that as drift would retry it every ten minutes for ever.
    const v = decideTurnstileSweep(facts({ identity: complete(), wantedDomains: [] }));
    expect(v).toEqual({ act: false, reason: "complete" });
  });
});

/**
 * Three of this fleet's four clones sit at `failed` and all three work.
 *
 * They stopped at the same late incremental migration and were already live,
 * serving, armed and holding a URL and an anon key. Gating the sweep on
 * `status === "ready"` therefore named a fact about the provisioning RUN
 * where the operation needs a fact about the PROJECT — and a clone that
 * failed before it was armed could never be armed at all.
 */
describe("backendHoldsAProject", () => {
  it("accepts a backend that ended failed but holds a project", () => {
    // The measured state of NPC Test, Preflight and NPC Client Dashboard.
    expect(backendHoldsAProject({ status: "failed", supabase_project_ref: "a".repeat(20) })).toBe(
      true,
    );
  });

  it("accepts a ready backend, as before", () => {
    expect(backendHoldsAProject({ status: "ready", supabase_project_ref: "a".repeat(20) })).toBe(
      true,
    );
  });

  it("refuses a run that is still moving", () => {
    // The project may not answer yet, and a clone that is not serving has
    // nothing to gain from a CAPTCHA and something to lose from a half-armed
    // one.
    for (const status of ["provisioning", "migrating", "pending", "queued"]) {
      expect(backendHoldsAProject({ status, supabase_project_ref: "a".repeat(20) })).toBe(false);
    }
  });

  it("refuses a backend with no project, whatever it claims", () => {
    expect(backendHoldsAProject({ status: "ready", supabase_project_ref: null })).toBe(false);
    expect(backendHoldsAProject({ status: "failed", supabase_project_ref: "" })).toBe(false);
    expect(backendHoldsAProject(null)).toBe(false);
  });
});
