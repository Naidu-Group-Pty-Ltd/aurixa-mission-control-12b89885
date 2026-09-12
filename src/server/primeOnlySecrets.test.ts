import { describe, it, expect } from "vitest";
import {
  isPrimeOnlySecret,
  primeOnlyRefusal,
  prohibitedHoldings,
  PRIME_ONLY_SECRETS,
} from "./primeOnlySecrets.pure";
import { classifySecret } from "./prime-backend.server";
import { classRefusalFor } from "./cloneSecretForward.pure";

describe("the name that started this", () => {
  it("SB_MANAGEMENT_ACCESS_TOKEN is prime-only", () => {
    expect(isPrimeOnlySecret("SB_MANAGEMENT_ACCESS_TOKEN")).toBe(true);
  });

  it("is classified prime_only, not vendor", () => {
    // Before this change it fell through every set and landed on `vendor` —
    // the class that travels to every clone.
    expect(classifySecret("SB_MANAGEMENT_ACCESS_TOKEN")).toBe("prime_only");
  });

  it("is refused by the shared class-refusal both forward paths ask", () => {
    expect(classRefusalFor("prime_only")).toBeTruthy();
  });
});

describe("every management name is refused, whatever it is called", () => {
  for (const name of [...PRIME_ONLY_SECRETS]) {
    it(`${name} is prime-only`, () => {
      expect(isPrimeOnlySecret(name)).toBe(true);
      expect(classifySecret(name)).toBe("prime_only");
      expect(primeOnlyRefusal(name)).toContain("administrative control");
    });
  }

  it("catches a management name nobody has written yet", () => {
    // The exact list is a snapshot of today; the patterns are for tomorrow.
    expect(isPrimeOnlySecret("SB_ADMIN_API_TOKEN")).toBe(true);
    expect(isPrimeOnlySecret("SUPABASE_MGMT_ADMIN_KEY")).toBe(true);
    expect(isPrimeOnlySecret("SUPABASE_ORGANISATION_ID")).toBe(true);
    expect(isPrimeOnlySecret("SB_ORGANIZATION_ID")).toBe(true);
    // And does NOT reach for anything merely adjacent: a vendor key whose
    // name happens to carry "admin" is a tenant's to hold.
    expect(isPrimeOnlySecret("GHL_ADMIN_API_KEY")).toBe(false);
    expect(isPrimeOnlySecret("SB_REGION")).toBe(false);
    expect(isPrimeOnlySecret("SUPABASE_FUNCTIONS_URL")).toBe(false);
  });
});

describe("a clone's own platform values are never swept", () => {
  // This is the rule that stops the sweep taking a workspace off the air.
  for (const name of [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_URL",
    "SUPABASE_JWT_SECRET",
    "JWT_SECRET",
  ]) {
    it(`${name} is not prime-only`, () => {
      expect(isPrimeOnlySecret(name)).toBe(false);
      expect(primeOnlyRefusal(name)).toBeNull();
    });
  }

  it("a tenant's own vendor key is untouched", () => {
    for (const n of ["OPENAI_API_KEY", "GOHIGHLEVEL_API_KEY_NEW", "RESEND_API_KEY"]) {
      expect(isPrimeOnlySecret(n)).toBe(false);
    }
  });
});

describe("prohibitedHoldings reads what a project holds", () => {
  it("returns only the prohibited names, sorted and deduplicated", () => {
    const held = [
      "SUPABASE_URL",
      "OPENAI_API_KEY",
      "SB_MANAGEMENT_ACCESS_TOKEN",
      "SUPABASE_ACCESS_TOKEN",
      "SB_MANAGEMENT_ACCESS_TOKEN",
      "SUPABASE_SERVICE_ROLE_KEY",
    ];
    expect(prohibitedHoldings(held)).toEqual([
      "SB_MANAGEMENT_ACCESS_TOKEN",
      "SUPABASE_ACCESS_TOKEN",
    ]);
  });

  it("an empty project yields nothing to remove", () => {
    expect(prohibitedHoldings([])).toEqual([]);
  });

  it("the measured production reading is acted on", () => {
    // npc-client-dashboard, 12 Sep 2026: it held the name while Mission
    // Control's ledger recorded it `missing`.
    expect(prohibitedHoldings(["SB_MANAGEMENT_ACCESS_TOKEN", "MISSION_CONTROL_URL"])).toEqual([
      "SB_MANAGEMENT_ACCESS_TOKEN",
    ]);
  });

  it("rejects blank and whitespace names without matching them", () => {
    expect(prohibitedHoldings(["", "   "])).toEqual([]);
  });
});

describe("the duplicated platform list is kept honest", () => {
  it("covers every name prime-backend calls auto-injected", async () => {
    // The module header says this copy exists so the policy can stay pure,
    // and that a test asserts the two agree. This is that test: without it
    // the comment is a claim rather than a guarantee, and a name added to
    // AUTO_INJECTED_SECRETS would become sweepable.
    const { AUTO_INJECTED_SECRETS } = await import("./prime-backend.server");
    const { CLONE_OWN_PLATFORM_VALUES } = await import("./primeOnlySecrets.pure");
    for (const name of AUTO_INJECTED_SECRETS) {
      expect(
        CLONE_OWN_PLATFORM_VALUES.has(name),
        `${name} is auto-injected but the sweep does not protect it`,
      ).toBe(true);
    }
  });

  it("no protected platform value can be reached by a pattern", async () => {
    const { CLONE_OWN_PLATFORM_VALUES } = await import("./primeOnlySecrets.pure");
    for (const name of CLONE_OWN_PLATFORM_VALUES) {
      expect(isPrimeOnlySecret(name), `${name} must never be swept`).toBe(false);
    }
  });
});
