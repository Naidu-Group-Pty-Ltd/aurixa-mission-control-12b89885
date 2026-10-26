/**
 * The credentials a CRM line never holds, and every route that could put one there.
 *
 * Withholding the GoHighLevel functions, crons and files left the credentials
 * free to travel, and on the independent line a credential was the switch
 * (H2 in `docs/audits/2026-10-10-crm-independent-pages.md`). These pin the
 * register, the decision each writer asks, and — by reading the source,
 * because the writers talk to a live Management API — that every writer asks
 * it before it writes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRM_LINE_VARIANT_PATTERNS,
  crmLinePinnedSecrets,
  crmLineSecretRefusal,
  crmLineSecretTransition,
  crmLineVariantFunctionNames,
  crmLineVariantPattern,
  crmLineWithheldSecretNames,
} from "./crmLineFeatures.pure";
import { ownedFunctionSlugs } from "./cloneOwnedFunctions.pure";
import {
  decideFleetForward,
  decideForward,
  namesToWrite,
  planCloneForwards,
  planFleetForwards,
  fleetNamesToWrite,
} from "./cloneSecretForward.pure";
import { planIntegrationSecretWrite, withCrmLineRefusals } from "./integrationSecretBroker.pure";

const GHL_PAIR = ["GOHIGHLEVEL_API_KEY", "GOHIGHLEVEL_LOCATION_ID"];
const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("the register", () => {
  it("withholds every GoHighLevel credential the prime reads from the independent line", () => {
    const names = crmLineWithheldSecretNames("independent");
    for (const name of [
      ...GHL_PAIR,
      "GOHIGHLEVEL_API_KEY_NEW",
      "GOHIGHLEVEL_LOCATION_ID_NEW",
      "GHL_WEBHOOK_SECRET",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("withholds nothing from the dependent line or an unrecorded one", () => {
    // The dependent line requires GoHighLevel; a register that guessed a line
    // would strip a dependent clone of the keys its CRM runs on.
    expect(crmLineWithheldSecretNames("dependent")).toEqual([]);
    expect(crmLineWithheldSecretNames(null)).toEqual([]);
    expect(crmLineWithheldSecretNames("hybrid")).toEqual([]);
    expect(crmLineSecretRefusal("GOHIGHLEVEL_API_KEY", "dependent")).toBeUndefined();
  });

  it("refuses in words that name the line and the remedy, and refuses nothing else", () => {
    const why = crmLineSecretRefusal("GOHIGHLEVEL_API_KEY", "independent");
    expect(why).toContain("independent CRM line");
    expect(why).toContain("Convert the clone to the dependent line");
    expect(crmLineSecretRefusal("RESEND_API_KEY", "independent")).toBeUndefined();
  });

  it("pins the native provider on the independent line alone", () => {
    expect(crmLinePinnedSecrets("independent")).toEqual({ CRM_PROVIDER: "native" });
    expect(crmLinePinnedSecrets("dependent")).toEqual({});
    expect(crmLinePinnedSecrets(null)).toEqual({});
  });
});

describe("a per-clone forward", () => {
  const facts = (name: string, crmMode: string | null) => ({
    name,
    secretClass: "vendor" as const,
    fleetInherit: null,
    presentInEnv: true,
    crmMode,
  });

  it("refuses a GoHighLevel credential to the independent line, and forwards it to the dependent one", () => {
    for (const name of GHL_PAIR) {
      expect(decideForward(facts(name, "independent")).act).toBe("refuse");
      expect(decideForward(facts(name, "dependent")).act).toBe("forward");
    }
  });

  it("still refuses on class first", () => {
    const out = decideForward({
      ...facts("JWT_SECRET", "independent"),
      secretClass: "tenant_scoped",
    });
    expect(out.act).toBe("refuse");
    expect((out as { why: string }).why).toContain("OWN credential");
  });

  it("refuses ahead of fleet policy, so no fleet row can carry one onto the line", () => {
    const out = decideForward({
      ...facts("GOHIGHLEVEL_API_KEY", "independent"),
      fleetInherit: true,
    });
    expect(out.act).toBe("refuse");
  });

  it("carries the line into provisioning's plan too", () => {
    const plan = (crmMode: string | null) =>
      namesToWrite(
        planCloneForwards({
          authorised: [...GHL_PAIR, "OPENAI_API_KEY"],
          fleet: new Map(),
          classOf: () => "vendor",
          envHas: () => true,
          crmMode,
        }),
      );
    expect(plan("independent")).toEqual(["OPENAI_API_KEY"]);
    expect(plan("dependent")).toEqual([...GHL_PAIR, "OPENAI_API_KEY"]);
  });
});

describe("the fleet sweep", () => {
  const facts = (crmMode: string | null) => ({
    name: "GOHIGHLEVEL_API_KEY",
    secretClass: "vendor" as const,
    inherit: true,
    presentInEnv: true,
    settledOnClone: false,
    withheldOnClone: false,
    crmMode,
  });

  it("never forwards a line's withheld credential, even where fleet policy inherits it", () => {
    expect(decideFleetForward(facts("independent")).act).toBe("refuse");
    expect(decideFleetForward(facts("dependent")).act).toBe("forward");
  });

  it("plans the same way", () => {
    const write = (crmMode: string | null) =>
      fleetNamesToWrite(
        planFleetForwards({
          fleet: new Map([
            ["GOHIGHLEVEL_API_KEY", true],
            ["OPENAI_API_KEY", true],
          ]),
          classOf: () => "vendor",
          envHas: () => true,
          settled: new Set(),
          crmMode,
        }),
      );
    expect(write("independent")).toEqual(["OPENAI_API_KEY"]);
    expect(write("dependent")).toEqual(["GOHIGHLEVEL_API_KEY", "OPENAI_API_KEY"]);
  });
});

describe("the tenant Integrations broker", () => {
  const plan = planIntegrationSecretWrite({
    secrets: [
      { name: "GOHIGHLEVEL_API_KEY", value: "a" },
      { name: "RESEND_API_KEY", value: "b" },
      { name: "SUPABASE_SERVICE_ROLE_KEY", value: "c" },
    ],
  });

  it("moves a line's withheld name from the write to the refusals", () => {
    const out = withCrmLineRefusals(plan, "independent");
    expect(out.write.map((w) => w.name)).toEqual(["RESEND_API_KEY"]);
    expect(out.refused.map((r) => r.name)).toEqual([
      "SUPABASE_SERVICE_ROLE_KEY",
      "GOHIGHLEVEL_API_KEY",
    ]);
  });

  it("changes nothing on the dependent line", () => {
    expect(withCrmLineRefusals(plan, "dependent")).toEqual(plan);
  });
});

describe("a conversion's environment", () => {
  it("joining the independent line removes the observed credentials and pins the provider", () => {
    const out = crmLineSecretTransition({
      fromMode: "dependent",
      toMode: "independent",
      present: [...GHL_PAIR, "RESEND_API_KEY"],
    });
    expect(out.remove).toEqual([...GHL_PAIR].sort());
    expect(out.withhold).toEqual([...GHL_PAIR].sort());
    expect(out.pin).toEqual({ CRM_PROVIDER: "native" });
    expect(out.forgetWithheld).toEqual([]);
    expect(out.forgetAny).toEqual([]);
  });

  it("removes nothing it did not observe", () => {
    // `listProjectSecretNames` answers [] for a failed read as for an empty
    // project, so an empty observation must remove nothing.
    const out = crmLineSecretTransition({
      fromMode: "dependent",
      toMode: "independent",
      present: [],
    });
    expect(out.remove).toEqual([]);
  });

  it("leaving it removes the pin and forgets the line's withheld record", () => {
    const out = crmLineSecretTransition({
      fromMode: "independent",
      toMode: "dependent",
      present: ["CRM_PROVIDER", "RESEND_API_KEY"],
    });
    expect(out.remove).toEqual(["CRM_PROVIDER"]);
    expect(out.withhold).toEqual([]);
    expect(out.pin).toEqual({});
    // Left behind, these `withheld` rows would make the dependent clone's
    // fleet sweep take off the GoHighLevel keys its CRM needs.
    expect(out.forgetWithheld).toEqual([...crmLineWithheldSecretNames("independent")].sort());
    expect(out.forgetAny).toEqual(["CRM_PROVIDER"]);
  });
});

describe("every writer asks the line before it writes", () => {
  it("the per-clone forward reads the clone's line and passes it", () => {
    const src = read("src/server/cloneSecretForward.server.ts");
    expect(src).toContain('.select("crm_mode")');
    expect(src).toContain("crmMode: clone.data?.crm_mode ?? null");
  });

  it("the fleet sweep refuses and removes the line's names", () => {
    const src = read("src/server/fleetSecretForward.server.ts");
    expect(src).toMatch(
      /for \(const name of crmLineWithheldSecretNames\(crmMode\)\) withheldNames\.add\(name\)/,
    );
    const plan = src.indexOf("planFleetForwards({");
    expect(src.indexOf("crmMode,", plan)).toBeGreaterThan(plan);
  });

  it("provisioning leaves them out of both sets, and the operator's set refuses them", () => {
    const src = read("src/lib/backend-provisioning.functions.ts");
    expect(src).toContain("if (crmLineSecretRefusal(row.name, crmMode)) continue;");
    const plan = src.indexOf("planCloneForwards({");
    expect(src.indexOf("crmMode,", plan)).toBeGreaterThan(plan);
    const setter = src.indexOf("export const setCloneBackendSecret");
    const refusal = src.indexOf("crmLineSecretRefusal(data.name", setter);
    const write = src.indexOf("setCloneSecretValue(projectRef, data.name", setter);
    expect(refusal).toBeGreaterThan(setter);
    expect(write).toBeGreaterThan(refusal);
  });

  it("the broker writes only the line-filtered plan", () => {
    const src = read("src/routes/api.public.integrations.secrets.ts");
    const filter = src.indexOf("withCrmLineRefusals(plan");
    const write = src.indexOf("setCloneSecretValues(target.projectRef, linePlan.write)");
    expect(filter).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(filter);
    expect(src.slice(filter)).not.toMatch(/\bplan\.(write|refused)/);
  });

  it("a conversion makes the environment follow the line", () => {
    const src = read("src/server/crmConversion.server.ts");
    const finish = src.indexOf("export async function finaliseConversion");
    expect(src.indexOf("await convertLineSecrets(", finish)).toBeGreaterThan(finish);
  });
});

describe("the head's own copies from the audit", () => {
  it("are held as the line's variants", () => {
    for (const path of [
      "supabase/functions/vapi-call-webhook/index.ts",
      "supabase/functions/cleanup-call-log-names/index.ts",
      "src/components/call-logs/CleanupContactNames.tsx",
      "src/pages/Integrations.tsx",
      "supabase/functions/update-integration-secret/index.ts",
      "supabase/functions/_shared/clients/noteWords.pure.ts",
      "supabase/functions/manage-lead-magnets/index.ts",
      "src/components/clients/ActiveClientCard.tsx",
    ]) {
      expect(CRM_LINE_VARIANT_PATTERNS.independent, path).toContain(path);
      expect(crmLineVariantPattern(path, "independent"), path).toBe(path);
      expect(crmLineVariantPattern(path, "dependent"), path).toBeNull();
    }
    // The native booking is held whole since #121: its specs are the line's too.
    for (const path of [
      "supabase/functions/portal-book-appointment/index.ts",
      "supabase/functions/portal-book-appointment/calendar-id-refusal.test.ts",
    ]) {
      expect(crmLineVariantPattern(path, "independent"), path).toBe(
        "supabase/functions/portal-book-appointment/**",
      );
      expect(crmLineVariantPattern(path, "dependent"), path).toBeNull();
    }
  });
});

describe("the line's own functions are deployed from the clone's tree", () => {
  it("are named by the variant patterns, never by `_shared`", () => {
    const names = crmLineVariantFunctionNames("independent");
    for (const slug of [
      "vapi-call-webhook",
      "cleanup-call-log-names",
      "portal-book-appointment",
      "update-integration-secret",
      "manage-automation-settings",
      "manage-lead-magnets",
      "request-lead-magnet",
      "finance-portal-client-comms",
      "ai-dashboard-agent",
      "crm-calendar",
    ]) {
      expect(names, slug).toContain(slug);
    }
    expect(names.some((n) => n.startsWith("_"))).toBe(false);
    expect(crmLineVariantFunctionNames("dependent")).toEqual([]);
    expect(crmLineVariantFunctionNames(null)).toEqual([]);
  });

  it("are owned by the clone-tree lane, and only on that line", () => {
    const declared = ["vapi-call-webhook", "healthcheck-ping", "crm-calendar"];
    const prime = ["vapi-call-webhook", "healthcheck-ping"];
    expect(ownedFunctionSlugs(declared, prime, crmLineVariantFunctionNames("independent"))).toEqual(
      ["crm-calendar", "vapi-call-webhook"],
    );
    expect(ownedFunctionSlugs(declared, prime, crmLineVariantFunctionNames("dependent"))).toEqual([
      "crm-calendar",
    ]);
  });

  it("are skipped by the prime-tree lane and by provisioning's prime bundles", () => {
    const lane = read("src/server/self-healing.server.ts");
    expect(lane).toContain("...crmLineVariantFunctionNames(cloneCrmMode)");
    const prov = read("src/lib/backend-provisioning.functions.ts");
    expect(prov).toContain("!lineVariants.has(fn.slug)");
    const owned = read("src/server/cloneOwnedFunctions.server.ts");
    expect(owned).toContain("crmLineVariantFunctionNames(c.crm_mode ?? null)");
  });
});
