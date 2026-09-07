import { describe, it, expect } from "vitest";
import {
  planCloneSecrets,
  deriveDeploymentConfig,
  cloneCanonicalOrigin,
  cloneWebAuthnOrigins,
  DERIVED_DEPLOYMENT_CONFIG_NAMES,
  type CloneOrigins,
} from "./backend-provisioning.server";
import {
  classifySecret,
  DEPLOYMENT_CONFIG_SECRETS,
  TENANT_SCOPED_SECRETS,
  TENANT_SCOPED_REMEDY,
} from "./prime-backend.server";
import { ownedSecretEnvNames } from "./cloneOwnedSecrets.pure";
import { MISSION_CONTROL_LINK_ENV_NAMES } from "./missionControlLink.pure";

const gen = () => "GENERATED";

/** NPC Test as it stood on 6 Sep 2026: domain allocated, deployment failed, provider origin live. */
const NPC_TEST: CloneOrigins = {
  siteUrl: "https://npc-test-76b3b3.vercel.app",
  canonicalOrigin: "https://npc-test.aurixasystems.com.au",
  additionalRedirectUrls: [
    "https://npc-test-76b3b3.vercel.app",
    "https://npc-test.aurixasystems.com.au",
    "https://lovable.dev/projects/abc",
  ],
};

describe("classification — what may never be copied from the prime", () => {
  it("names that carry the prime's hostname are deployment config", () => {
    for (const n of ["PUBLIC_APP_URL", "WEB_PUSH_ALLOWED_HOST", "WEBAUTHN_RP_ID", "WEBAUTHN_RP_ORIGINS", "WEBAUTHN_RP_NAME", "MISSION_CONTROL_URL", "MISSION_CONTROL_AGENCY_NAME", "AML_PROVIDER_MODE"]) {
      expect(classifySecret(n)).toBe("deployment_config");
    }
  });

  it("the clone's own identities and its Mission Control credential are tenant-scoped", () => {
    for (const n of ["REQUIRE_TURNSTILE", "RESEND_FROM_EMAIL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "FINANCE_PORTAL_CRON_SECRET", "MARKET_INGESTION_CRON_SECRET", "MISSION_CONTROL_CLONE_API_KEY", "MISSION_CONTROL_WEBHOOK_SECRET"]) {
      expect(classifySecret(n)).toBe("tenant_scoped");
      expect(TENANT_SCOPED_REMEDY[n]).toBeTruthy();
    }
  });

  it("the reset pepper is identity: a random one is valid, the prime's would be shared", () => {
    expect(classifySecret("RESET_TOKEN_PEPPER")).toBe("identity");
  });

  it("every derived name is classified deployment config, so it can never be inherited", () => {
    for (const n of DERIVED_DEPLOYMENT_CONFIG_NAMES) expect(DEPLOYMENT_CONFIG_SECRETS.has(n)).toBe(true);
  });

  it("every owned or linked name has a class that refuses the prime's value", () => {
    for (const n of [...ownedSecretEnvNames(), ...MISSION_CONTROL_LINK_ENV_NAMES]) {
      expect(["identity", "tenant_scoped", "deployment_config"]).toContain(classifySecret(n));
    }
    // ...and a VAPID key can never be minted by the generic generator, which
    // would produce a string web-push refuses.
    expect(TENANT_SCOPED_SECRETS.has("VAPID_PUBLIC_KEY")).toBe(true);
    expect(TENANT_SCOPED_SECRETS.has("VAPID_PRIVATE_KEY")).toBe(true);
  });

  it("REQUIRE_TURNSTILE is never copied: the prime's `true` on a clone with no widget refuses every login", () => {
    const { toWrite, results } = planCloneSecrets(["REQUIRE_TURNSTILE"], { REQUIRE_TURNSTILE: "true" }, gen);
    expect(toWrite).toHaveLength(0);
    expect(results.get("REQUIRE_TURNSTILE")?.status).toBe("tenant_scoped_pending");
  });
});

describe("derived deployment config — this clone's own hostnames and name", () => {
  const facts = { displayName: "NPC Test", missionControlOrigin: "https://mission-control.aurixasystems.com.au" };

  it("prefers the allocated hostname over the provider's for the public URL", () => {
    // The invite email links to where the tenant WILL live, and a passkey
    // relying party bound to a vercel host dies the moment the domain is live.
    expect(cloneCanonicalOrigin(NPC_TEST)).toBe("https://npc-test.aurixasystems.com.au");
    expect(cloneCanonicalOrigin({ siteUrl: "https://x.vercel.app" })).toBe("https://x.vercel.app");
    expect(cloneCanonicalOrigin({ siteUrl: "localhost" })).toBeNull();
  });

  it("derives the whole set from the canonical origin and the name", () => {
    expect(deriveDeploymentConfig(NPC_TEST, facts)).toEqual({
      ALLOWED_ORIGINS: "https://npc-test-76b3b3.vercel.app,https://npc-test.aurixasystems.com.au,https://lovable.dev",
      PUBLIC_APP_URL: "https://npc-test.aurixasystems.com.au",
      APP_URL: "https://npc-test.aurixasystems.com.au",
      APP_BASE_URL: "https://npc-test.aurixasystems.com.au",
      WEB_PUSH_ALLOWED_HOST: "npc-test.aurixasystems.com.au",
      WEBAUTHN_RP_ID: "npc-test.aurixasystems.com.au",
      WEBAUTHN_RP_ORIGINS: "https://npc-test.aurixasystems.com.au",
      WEBAUTHN_RP_NAME: "NPC Test",
      MISSION_CONTROL_URL: "https://mission-control.aurixasystems.com.au",
      MISSION_CONTROL_AGENCY_NAME: "NPC Test",
      // RFC 8292 admits an `https:` contact URI as well as a `mailto:`, and
      // the clone's own origin is one — derivable with nothing to ask anybody,
      // where an address for each tenant would be a question.
      VAPID_SUBJECT_EMAIL: "https://npc-test.aurixasystems.com.au",
      AML_PROVIDER_MODE: "live",
    });
  });

  it("the WebAuthn origins are only the relying party's own host and subdomains", () => {
    // A browser refuses a credential whose relying party is not a registrable
    // suffix of the page's host, so the vercel host cannot be listed.
    expect(
      cloneWebAuthnOrigins({
        canonicalOrigin: "https://clone.example.com",
        additionalRedirectUrls: ["https://app.clone.example.com", "https://clone.vercel.app", "https://notclone.example.com"],
      }),
    ).toBe("https://clone.example.com,https://app.clone.example.com");
    expect(cloneWebAuthnOrigins({})).toBeNull();
  });

  it("excludes what a caller says it owns", () => {
    const out = deriveDeploymentConfig(NPC_TEST, facts, { exclude: new Set(["ALLOWED_ORIGINS"]) });
    expect(out.ALLOWED_ORIGINS).toBeUndefined();
    expect(out.PUBLIC_APP_URL).toBeDefined();
  });

  it("derives nothing it cannot honestly derive", () => {
    // No origin, no name: only the constant posture survives.
    expect(deriveDeploymentConfig(null, {})).toEqual({ AML_PROVIDER_MODE: "live" });
  });

  it("the batch writes derived values and records them derived", () => {
    const { toWrite, results } = planCloneSecrets(
      ["PUBLIC_APP_URL", "WEBAUTHN_RP_NAME", "MISSION_CONTROL_URL"],
      { PUBLIC_APP_URL: "https://command-centre.npcservices.com.au" },
      gen,
      NPC_TEST,
      undefined,
      undefined,
      undefined,
      facts,
    );
    expect(toWrite).toEqual([
      { name: "PUBLIC_APP_URL", value: "https://npc-test.aurixasystems.com.au" },
      { name: "WEBAUTHN_RP_NAME", value: "NPC Test" },
      { name: "MISSION_CONTROL_URL", value: "https://mission-control.aurixasystems.com.au" },
    ]);
    expect(results.get("PUBLIC_APP_URL")?.status).toBe("derived");
    // The prime's value was offered and refused.
    expect(toWrite.some((w) => w.value.includes("npcservices"))).toBe(false);
  });
});

describe("settled names — written by another step, read here", () => {
  it("records a settled name `set` at the time that step wrote it, and writes nothing", () => {
    const { toWrite, results } = planCloneSecrets(
      ["TURNSTILE_SECRET_KEY", "REQUIRE_TURNSTILE", "RESEND_API_KEY"],
      { RESEND_API_KEY: "the-primes-key" },
      gen,
      null,
      new Set(["RESEND_API_KEY"]),
      undefined,
      new Set(["RESEND_API_KEY"]),
      {
        settled: new Map([
          ["TURNSTILE_SECRET_KEY", "2026-09-03T15:50:24.773Z"],
          ["REQUIRE_TURNSTILE", "2026-09-03T15:50:25.503Z"],
          ["RESEND_API_KEY", "2026-09-03T16:00:25.588Z"],
        ]),
      },
    );
    expect(toWrite).toHaveLength(0);
    expect(results.get("TURNSTILE_SECRET_KEY")).toEqual({
      name: "TURNSTILE_SECRET_KEY",
      status: "set",
      success: true,
      settledAt: "2026-09-03T15:50:24.773Z",
    });
    expect(results.get("REQUIRE_TURNSTILE")?.status).toBe("set");
    expect(results.get("RESEND_API_KEY")?.status).toBe("set");
  });

  it("an unsettled identity name still reads as it did", () => {
    const { results } = planCloneSecrets(["TURNSTILE_SECRET_KEY"], {}, gen, null, undefined, undefined, undefined, {
      settled: new Map(),
    });
    expect(results.get("TURNSTILE_SECRET_KEY")?.status).toBe("tenant_scoped_pending");
  });
});

describe("the owned and linked values reach the batch as this clone's own", () => {
  it("a tenant-scoped name decided by its step is written and recorded derived", () => {
    const { toWrite, results } = planCloneSecrets(
      ["VAPID_PUBLIC_KEY", "MISSION_CONTROL_CLONE_API_KEY"],
      { VAPID_PUBLIC_KEY: "the-primes-key" },
      gen,
      null,
      undefined,
      { VAPID_PUBLIC_KEY: "B" + "k".repeat(86), MISSION_CONTROL_CLONE_API_KEY: "mck_this-clones-own" },
    );
    expect(toWrite.map((w) => w.value)).toEqual(["B" + "k".repeat(86), "mck_this-clones-own"]);
    expect(results.get("VAPID_PUBLIC_KEY")?.status).toBe("derived");
  });

  it("an undecided VAPID key is pending, never a random string web-push would refuse", () => {
    const { toWrite, results } = planCloneSecrets(["VAPID_PRIVATE_KEY"], { VAPID_PRIVATE_KEY: "x" }, gen);
    expect(toWrite).toHaveLength(0);
    expect(results.get("VAPID_PRIVATE_KEY")?.status).toBe("tenant_scoped_pending");
  });

  it("an undecided reset pepper is still minted, because a random one is valid", () => {
    const { toWrite } = planCloneSecrets(["RESET_TOKEN_PEPPER"], { RESET_TOKEN_PEPPER: "the-primes" }, gen);
    expect(toWrite).toEqual([{ name: "RESET_TOKEN_PEPPER", value: "GENERATED" }]);
  });
});
