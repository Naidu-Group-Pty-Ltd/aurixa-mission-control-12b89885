import { describe, it, expect } from "vitest";
import {
  canRotateSecret,
  deriveWidgetDomains,
  deriveWidgetName,
  isPrimeSiteKey,
  secretLast4,
  turnstileReadiness,
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
