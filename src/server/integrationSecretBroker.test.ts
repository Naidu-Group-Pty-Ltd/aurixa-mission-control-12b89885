import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FORBIDDEN_TENANT_PREFIXES,
  FORBIDDEN_TENANT_SECRETS,
  MAX_SECRETS_PER_WRITE,
  MAX_SECRET_VALUE_LENGTH,
  planIntegrationSecretWrite,
  refusalHeaders,
  relayHeaders,
  tenantSecretRefusal,
} from "./integrationSecretBroker.pure";
import { CLONE_API_SCOPES, DEFAULT_SCOPES } from "@/lib/clone-api-scopes";

/**
 * The deny-list, pinned name by name.
 *
 * Neither repository can see the other's source, so nothing can compare this
 * list with the prime's automatically. This is the substitute: a removal has
 * to be an edit to this array, in a diff a reviewer reads, rather than one
 * line vanishing from a Set nobody is looking at.
 */
const PINNED = [
  "SUPABASE_ACCESS_TOKEN",
  "SB_MANAGEMENT_ACCESS_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_JWT_SECRET",
  "MISSION_CONTROL_URL",
  "MISSION_CONTROL_CLONE_API_KEY",
  "MISSION_CONTROL_WEBHOOK_SECRET",
  "TURNSTILE_SECRET_KEY",
  "VERCEL_API_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "AIRTABLE_TOKEN",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_TABLE_NAME",
  "AIRTABLE_TABLE_ALLOWLIST",
  "AIRTABLE_TABLE_ALIASES",
  "AIRTABLE_IMAGE_LIBRARY_FIELD",
];

describe("what a tenant may never set on its own project", () => {
  it("refuses every pinned name", () => {
    for (const name of PINNED) {
      expect(tenantSecretRefusal(name), `${name} must be refused`).not.toBeNull();
    }
  });

  it("has no name outside the pinned list", () => {
    // The other direction. A name added here without being written down above
    // is a refusal nobody reviewed, and a refusal nobody reviewed is how an
    // ordinary vendor key becomes unsettable with no explanation.
    expect([...FORBIDDEN_TENANT_SECRETS].sort()).toEqual([...PINNED].sort());
  });

  it("refuses the whole internal signing family by prefix", () => {
    expect(FORBIDDEN_TENANT_PREFIXES).toContain("INTERNAL_");
    expect(tenantSecretRefusal("INTERNAL_FUNCTION_SECRET")).not.toBeNull();
    expect(tenantSecretRefusal("INTERNAL_ANYTHING_AT_ALL")).not.toBeNull();
  });

  it("permits an ordinary vendor key, including one that supersedes ours", () => {
    // Superseding is the POINT. A workspace that brings its own OpenAI key
    // must be able to, and the platform must then stop being charged for it.
    // A rule that blocked this would be protecting the wrong side of the
    // meter.
    for (const name of [
      "GOHIGHLEVEL_API_KEY",
      "GOHIGHLEVEL_LOCATION_ID",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "RESEND_API_KEY",
      "DOMAIN_API_KEY",
    ]) {
      expect(tenantSecretRefusal(name), `${name} must be writable`).toBeNull();
    }
  });

  it("refuses a name that is not a Supabase secret name at all", () => {
    for (const bad of ["", "lowercase", "9LEADING", "HAS-DASH", "AB", "X".repeat(60)]) {
      expect(tenantSecretRefusal(bad), `${JSON.stringify(bad)} must be refused`).not.toBeNull();
    }
  });

  it("says what it refuses in the operator's terms, not the database's", () => {
    const reason = tenantSecretRefusal("MISSION_CONTROL_URL")!;
    expect(reason).toContain("MISSION_CONTROL_URL");
    expect(reason).toMatch(/identity/i);
    // And it says what IS permitted, so the message is not a dead end.
    expect(reason).toMatch(/vendor keys are yours to set/i);
  });
});

describe("planning one write", () => {
  const ok = { name: "GOHIGHLEVEL_API_KEY", value: "  pit-abc  " };

  it("trims the value and keeps the order it arrived in", () => {
    const plan = planIntegrationSecretWrite({
      secrets: [ok, { name: "GOHIGHLEVEL_LOCATION_ID", value: "loc_1" }],
    });
    expect(plan.fatal).toBeNull();
    expect(plan.write).toEqual([
      { name: "GOHIGHLEVEL_API_KEY", value: "pit-abc" },
      { name: "GOHIGHLEVEL_LOCATION_ID", value: "loc_1" },
    ]);
    expect(plan.refused).toEqual([]);
  });

  it("writes the permitted half of a mixed request and reports the rest", () => {
    // Partial is a real outcome: a card carrying four vendor fields and one
    // refused name should write the four. What must never happen is a refused
    // name landing quietly.
    const plan = planIntegrationSecretWrite({
      secrets: [ok, { name: "MISSION_CONTROL_URL", value: "https://evil.test" }],
    });
    expect(plan.write.map((s) => s.name)).toEqual(["GOHIGHLEVEL_API_KEY"]);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0].name).toBe("MISSION_CONTROL_URL");
  });

  it("refuses an empty value rather than skipping it", () => {
    // Skipping would be silent. Writing it would be worse: the Management API
    // stores an empty string, and a vendor key set to "" reads as configured
    // at every surface that checks presence.
    const plan = planIntegrationSecretWrite({
      secrets: [{ name: "GOHIGHLEVEL_API_KEY", value: "   " }],
    });
    expect(plan.write).toEqual([]);
    expect(plan.refused[0].reason).toMatch(/no value/);
  });

  it("refuses one name sent twice, because nothing here can say which was meant", () => {
    const plan = planIntegrationSecretWrite({
      secrets: [ok, { name: "GOHIGHLEVEL_API_KEY", value: "pit-other" }],
    });
    expect(plan.write).toEqual([{ name: "GOHIGHLEVEL_API_KEY", value: "pit-abc" }]);
    expect(plan.refused[0].reason).toMatch(/twice/);
  });

  it("refuses an over-long value", () => {
    const plan = planIntegrationSecretWrite({
      secrets: [{ name: "GOHIGHLEVEL_API_KEY", value: "x".repeat(MAX_SECRET_VALUE_LENGTH + 1) }],
    });
    expect(plan.write).toEqual([]);
    expect(plan.refused[0].reason).toContain(String(MAX_SECRET_VALUE_LENGTH));
  });

  it("is fatal on a body that is not a list of secrets", () => {
    for (const body of [null, {}, { secrets: [] }, { secrets: "GOHIGHLEVEL_API_KEY" }]) {
      expect(planIntegrationSecretWrite(body).fatal, JSON.stringify(body)).not.toBeNull();
    }
  });

  it("is fatal past the per-request ceiling", () => {
    const secrets = Array.from({ length: MAX_SECRETS_PER_WRITE + 1 }, (_, i) => ({
      name: `VENDOR_KEY_${i}`,
      value: "v",
    }));
    expect(planIntegrationSecretWrite({ secrets }).fatal).toContain(String(MAX_SECRETS_PER_WRITE));
  });

  it("survives entries that are not objects at all", () => {
    // The body crosses a trust boundary; a `.name` on a number must not throw
    // and take the whole request down as a 500.
    const plan = planIntegrationSecretWrite({ secrets: [1, "x", null, { name: 5, value: 6 }] });
    expect(plan.fatal).toBeNull();
    expect(plan.write).toEqual([]);
    expect(plan.refused).toHaveLength(4);
  });
});

describe("who answered", () => {
  it("marks a refusal as Mission Control's own", () => {
    const h = new Headers(refusalHeaders("unauthorized"));
    expect(h.get("x-mission-control-refusal")).toBe("unauthorized");
    expect(h.get("x-mission-control-endpoint")).toBe("integrations.secrets");
  });

  it("marks a relayed answer as ours to relay, without claiming the refusal", () => {
    // The absence of the refusal header is what identifies an answer as the
    // Management API's; the presence of the endpoint header is what says the
    // request reached Mission Control at all. Two questions, two headers.
    const h = new Headers(relayHeaders());
    expect(h.get("x-mission-control-refusal")).toBeNull();
    expect(h.get("x-mission-control-endpoint")).toBe("integrations.secrets");
  });
});

describe("the scope, and the endpoint that requires it", () => {
  it("integrations:write exists and is on by default", () => {
    const scope = CLONE_API_SCOPES.find((s) => s.value === "integrations:write");
    expect(scope, "integrations:write must be in the catalogue").toBeDefined();
    // Off by default would be the `clones:rotate` defect again: an endpoint
    // that requires a scope no issued key carries is unreachable from the day
    // it ships, and nothing reports that.
    expect(DEFAULT_SCOPES).toContain("integrations:write");
  });

  it("reaches the keys that predate it, because the link engine widens on defaults", () => {
    // The `clones:rotate` defect, avoided: a scope required by an endpoint and
    // carried by no issued key makes that endpoint unreachable from the day it
    // ships, silently. Every clone's Mission Control link key was minted
    // before `integrations:write` existed, so the thing that has to happen is
    // `planMissionControlLink`'s scope grant — a union onto the current
    // defaults, on the key the engine itself owns, with the value unchanged
    // and nothing re-delivered.
    const plan = readFileSync("src/server/missionControlLink.pure.ts", "utf8");
    expect(plan).toContain("grantScopes");
    expect(plan).toContain("facts.defaultScopes.filter");
    // And the widening is performed, not merely planned.
    const server = readFileSync("src/server/cloneMissionControlLink.server.ts", "utf8");
    expect(server).toContain("for (const grant of plan.grantScopes)");
  });

  it("the endpoint requires it, and resolves the project from the key alone", () => {
    const route = readFileSync("src/routes/api.public.integrations.secrets.ts", "utf8");
    expect(route).toContain('"integrations:write"');
    // The one rule that makes the whole thing safe: the caller cannot name a
    // project. The ref is the return value of `resolveCloneSecretTarget`,
    // which refuses Mission Control's own project, refuses the prime's, and
    // refuses when it cannot tell.
    expect(route).toContain("resolveCloneSecretTarget");
    expect(route).not.toMatch(/project_?[Rr]ef\s*[:=]\s*(body|parsed|request)/);
  });

  it("a prime-scoped key cannot reach it", () => {
    // No fallback to the prime's own project. The prime holds its own
    // management token and writes directly, so a fallback here would be a
    // route by which a key could write the prime's environment.
    const route = readFileSync("src/routes/api.public.integrations.secrets.ts", "utf8");
    expect(route).toContain("not_a_clone_key");
  });
});
