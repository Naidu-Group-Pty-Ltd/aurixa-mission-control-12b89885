import { describe, expect, it } from "vitest";

import {
  CRM_LINE_FEATURES,
  allCrmLineFunctionNames,
  crmLineCronJobsIn,
  crmLineCronReason,
  crmLineFeatureForPath,
  crmLineFunctionsIn,
  CRM_LINE_KEPT_PATTERNS,
  CRM_LINE_VARIANT_PATTERNS,
  crmLineKeptPattern,
  crmLineVariantFunctionNames,
  crmLineVariantPattern,
  crmLineWithheldFunctionNames,
  describeWithheldAcrossRegisters,
  isCrmLineWithheldFunction,
  isCrmLineWithheldPath,
  withheldClause,
  withheldLineFunctions,
} from "@/server/crmLineFeatures.pure";
import { PRIME_ONLY_FEATURES, isPrimeOnlyFunction } from "@/server/primeOnlyFeatures.pure";
import {
  approvableHeld,
  partitionCascadePaths,
  reportableHeld,
} from "@/server/cascade/syncExclusions.pure";
import { cascadeBackendWork } from "@/server/cascadeBackendWork.pure";
import {
  functionsToRestore,
  functionsToUndeploy,
  restoreOutcomeLeavesNothingRunnable,
} from "@/server/crmConversion.pure";

const GHL = "supabase/functions/send-ghl-message/index.ts";

describe("the CRM-line register", () => {
  it("withholds the GoHighLevel integration from the independent line and from nothing else", () => {
    expect(isCrmLineWithheldPath(GHL, "independent")).toBe(true);
    expect(isCrmLineWithheldPath(GHL, "dependent")).toBe(false);
    // Unknown or unrecorded withholds nothing: a register that guesses a
    // line would strip a dependent clone of its CRM.
    expect(isCrmLineWithheldPath(GHL, null)).toBe(false);
    expect(isCrmLineWithheldPath(GHL, undefined)).toBe(false);
    expect(isCrmLineWithheldPath(GHL, "hybrid")).toBe(false);
  });

  it("reaches every file under a withheld function and its named modules", () => {
    expect(
      crmLineFeatureForPath("supabase/functions/ghl-calendar/deno.json", "independent")?.key,
    ).toBe("ghl-integration");
    expect(
      isCrmLineWithheldPath("supabase/functions/_shared/ghlConversationStore.ts", "independent"),
    ).toBe(true);
  });

  it("leaves what the line carries: native storage, mixed modules and the crm-* routers", () => {
    for (const path of [
      "supabase/functions/crm-send-message/index.ts",
      "supabase/functions/_shared/ghl-account.ts",
      "supabase/functions/_shared/ghlConversationMap.pure.ts",
      "supabase/migrations/20250101000000_ghl_conversations.sql",
      "src/pages/Conversations.tsx",
    ]) {
      expect(isCrmLineWithheldPath(path, "independent")).toBe(false);
    }
  });

  it("shares no function with the prime-only register", () => {
    // One function answering to two registers would be undeployed on one
    // line's reasoning and restored on the other's.
    const primeOnly = new Set(PRIME_ONLY_FEATURES.flatMap((f) => f.functions));
    for (const fn of allCrmLineFunctionNames()) expect(primeOnly.has(fn)).toBe(false);
    for (const fn of allCrmLineFunctionNames()) expect(isPrimeOnlyFunction(fn)).toBe(false);
  });

  it("lists each function once and names only the independent line", () => {
    for (const f of CRM_LINE_FEATURES) {
      expect(new Set(f.functions).size).toBe(f.functions.length);
      expect(f.withheldFrom).toBe("independent");
    }
    expect(crmLineWithheldFunctionNames("independent")).toContain("send-ghl-message");
    expect(crmLineWithheldFunctionNames("dependent")).toEqual([]);
    expect(isCrmLineWithheldFunction("sync-ghl-conversations", "independent")).toBe(true);
    expect(isCrmLineWithheldFunction("crm-send-message", "independent")).toBe(false);
  });
});

describe("crons on the independent line", () => {
  it("catches a job by its name", () => {
    expect(
      crmLineCronReason(
        { jobname: "import-clients-from-ghl-6h", command: "select 1" },
        "independent",
      ),
    ).toMatch(/does not run import-clients-from-ghl-6h/);
  });

  it("catches a renamed job by the function it invokes", () => {
    const command = "select public.cron_invoke_signed_function('sync-ghl-pipelines', '{}'::jsonb)";
    expect(crmLineCronReason({ jobname: "nightly-thing", command }, "independent")).toMatch(
      /sync-ghl-pipelines/,
    );
    const url =
      "select net.http_post(url := 'https://x.supabase.co/functions/v1/sync-ghl-conversations')";
    expect(crmLineCronReason({ jobname: "x", command: url }, "independent")).toMatch(
      /calls sync-ghl-conversations/,
    );
  });

  it("leaves every job alone on the dependent line and on an unrecorded one", () => {
    const job = { jobname: "sync-ghl-pipelines-hourly", command: "" };
    expect(crmLineCronReason(job, "dependent")).toBeNull();
    expect(crmLineCronReason(job, null)).toBeNull();
    expect(
      crmLineCronJobsIn([job, { jobname: "other", command: "" }], "independent").map((h) => h.job),
    ).toEqual([job]);
  });

  it("does not catch a job that only mentions GoHighLevel in passing", () => {
    expect(
      crmLineCronReason(
        { jobname: "finance-portal-reminders-hourly", command: "select 'ghl'" },
        "independent",
      ),
    ).toBeNull();
  });
});

describe("what a tree holds", () => {
  it("names the line's functions a tree lacks", () => {
    const tree = ["supabase/functions/send-ghl-message/index.ts", "src/a.ts"];
    const lacks = withheldLineFunctions(tree, "independent");
    expect(lacks).not.toContain("send-ghl-message");
    expect(lacks).toContain("sync-ghl-conversations");
    expect(withheldLineFunctions(tree, "dependent")).toEqual([]);
  });

  it("picks the withheld slugs out of a live list", () => {
    expect(
      crmLineFunctionsIn(["crm-send-message", "send-ghl-message"], "independent").map(
        (h) => h.slug,
      ),
    ).toEqual(["send-ghl-message"]);
  });
});

describe("how a withheld share is described", () => {
  it("keeps the prime-only sentence byte-identical when no line name is present", () => {
    expect(withheldClause(["loose-fn"])).toBe("loose-fn, which the prime keeps for itself");
  });

  it("never says the prime keeps the GoHighLevel integration for itself", () => {
    const s = withheldClause(["send-ghl-message"]);
    expect(s).toMatch(/withheld from the independent CRM line/);
    expect(s).not.toMatch(/prime keeps/);
    expect(describeWithheldAcrossRegisters(["send-ghl-message", "loose-fn"])).toMatch(
      /loose-fn; the GoHighLevel integration/,
    );
  });
});

describe("the cascade honours the line", () => {
  it("holds a line path on write and lets it be deleted", () => {
    const write = partitionCascadePaths([GHL, "src/a.ts"], [], { crmMode: "independent" });
    expect(write.held.map((h) => h.path)).toEqual([GHL]);
    expect(write.held[0].pattern).toBe("(crm-line: ghl-integration)");
    const del = partitionCascadePaths([GHL], [], { purpose: "delete", crmMode: "independent" });
    expect(del.held).toEqual([]);
  });

  it("writes the same path to a dependent clone", () => {
    expect(partitionCascadePaths([GHL], [], { crmMode: "dependent" }).held).toEqual([]);
  });

  it("owes no redeploy for a withheld function", () => {
    expect(cascadeBackendWork([GHL], { crmMode: "independent" }).staleFunctions).toEqual([]);
    expect(cascadeBackendWork([GHL], { crmMode: "dependent" }).staleFunctions).toEqual([
      "send-ghl-message",
    ]);
  });
});

describe("a conversion moves the integration with the clone", () => {
  const primeDeclared = ["send-ghl-message", "sync-ghl-pipelines", "crm-send-message"];

  it("undeploys the integration when joining the independent line", () => {
    expect(
      functionsToUndeploy({
        retired: [],
        live: ["send-ghl-message", "crm-send-message"],
        primeDeclared,
        toMode: "independent",
      }),
    ).toEqual(["send-ghl-message"]);
  });

  it("undeploys only retired, non-prime functions when joining the dependent line", () => {
    expect(
      functionsToUndeploy({
        retired: ["crm-only"],
        live: ["crm-only", "send-ghl-message"],
        primeDeclared,
        toMode: "dependent",
      }),
    ).toEqual(["crm-only"]);
  });

  it("restores what the independent line withheld when joining the dependent line", () => {
    expect(
      functionsToRestore({
        fromMode: "independent",
        toMode: "dependent",
        live: ["crm-send-message"],
        primeDeclared,
      }),
      // This fixture has the prime declare `crm-send-message`, which the
      // independent line keeps as its own: leaving the line restores the
      // prime's copy of it too, live or not.
    ).toEqual(["crm-send-message", "send-ghl-message", "sync-ghl-pipelines"]);
    // Nothing to restore the other way, and never a withheld function already live.
    expect(
      functionsToRestore({ fromMode: "dependent", toMode: "independent", live: [], primeDeclared }),
    ).toEqual([]);
    expect(
      functionsToRestore({
        fromMode: "independent",
        toMode: "dependent",
        live: ["send-ghl-message", "sync-ghl-pipelines"],
        primeDeclared,
      }),
    ).toEqual(["crm-send-message"]);
  });

  it("puts the prime's copy back over the line's own copy of a shared function", () => {
    // Live, `vapi-call-webhook` is the independent line's copy, built from the
    // clone's tree; nothing else replaces it once the clone is dependent.
    expect(
      functionsToRestore({
        fromMode: "independent",
        toMode: "dependent",
        live: ["vapi-call-webhook", "manage-automation-settings"],
        primeDeclared: ["vapi-call-webhook", "manage-automation-settings", "healthcheck-ping"],
      }),
    ).toEqual(["manage-automation-settings", "vapi-call-webhook"]);
  });

  it("counts a restore folded into a parked run as nothing runnable", () => {
    // "already queued" reads as success until its tail: the drain never takes
    // a run parked for a human, so the functions stay absent indefinitely.
    expect(
      restoreOutcomeLeavesNothingRunnable(
        "already queued in run abc — BLOCKED: that run is parked for a human (since 2026-09-29T10:00) and the drain will never take it",
      ),
    ).toBe(true);
    expect(restoreOutcomeLeavesNothingRunnable("not planned: boom")).toBe(true);
    expect(restoreOutcomeLeavesNothingRunnable("not planned — could not read open runs: x")).toBe(
      true,
    );
    expect(restoreOutcomeLeavesNothingRunnable("queued run abc")).toBe(false);
    expect(restoreOutcomeLeavesNothingRunnable("already queued in run abc")).toBe(false);
    expect(restoreOutcomeLeavesNothingRunnable(null)).toBe(false);
  });
});

describe("the independent line's own copies", () => {
  const AGENT = "supabase/functions/ai-dashboard-agent/index.ts";
  const PROVIDER = "src/lib/crm/crmProvider.ts";

  it("names them for the independent line alone", () => {
    expect(crmLineVariantPattern(AGENT, "independent")).toBe(AGENT);
    expect(crmLineVariantPattern(PROVIDER, "independent")).toBe("src/lib/crm/**");
    expect(crmLineVariantPattern(AGENT, "dependent")).toBeNull();
    expect(crmLineVariantPattern(AGENT, null)).toBeNull();
    expect(crmLineVariantPattern("src/pages/Dashboard.tsx", "independent")).toBeNull();
  });

  it("holds the four files the prime@f0ea76e cascade would have reverted", () => {
    // Head #64 proposed the prime's copy of exactly these four, and nothing
    // else. Each must resolve to a row of its own, not to a broader glob.
    for (const path of [
      "src/pages/CallLogs.tsx",
      "src/components/finance-portal/ClientCommsInboxTab.tsx",
      "supabase/functions/request-lead-magnet/index.ts",
      "supabase/functions/finance-portal-client-comms/index.ts",
    ]) {
      expect(crmLineVariantPattern(path, "independent"), path).toBe(path);
      expect(crmLineVariantPattern(path, "dependent"), path).toBeNull();
    }
  });

  it("holds what the prime@22b7e00 cascade wrote over, or carried after the line declined it", () => {
    // #121 delivered the prime's copy of the first two over the line's own and
    // the last three the hand sync at prime@641d101 had left out: 49 red tests.
    const PIN_RATCHET = "src/lib/security/__tests__/supabaseJsVersionPins.spec.ts";
    expect(crmLineVariantPattern(PIN_RATCHET, "independent")).toBe(PIN_RATCHET);
    expect(crmLineVariantPattern(PIN_RATCHET, "dependent")).toBeNull();
    for (const spec of [
      "preview-session-booking.test.ts",
      "booking-emails.test.ts",
      "configured-calendar-and-times.test.ts",
      "email-outcome-and-appointments.test.ts",
      // Already the line's before; still held, now by the function's glob.
      "calendar-id-refusal.test.ts",
      "index.ts",
    ]) {
      const path = `supabase/functions/portal-book-appointment/${spec}`;
      expect(crmLineVariantPattern(path, "independent"), path).toBe(
        "supabase/functions/portal-book-appointment/**",
      );
      expect(crmLineVariantPattern(path, "dependent"), path).toBeNull();
    }
    // A function of the same name prefix is not caught by the glob.
    expect(
      crmLineVariantPattern(
        "supabase/functions/portal-book-appointment-v2/index.ts",
        "independent",
      ),
    ).toBeNull();
    // The function is still deployed from the line's own tree, once.
    expect(
      crmLineVariantFunctionNames("independent").filter((n) => n === "portal-book-appointment"),
    ).toEqual(["portal-book-appointment"]);
  });

  it("does not list a path the line withholds outright", () => {
    // A withheld feature is `protected`; listing it here too would read as a
    // hold an operator could release.
    for (const pattern of CRM_LINE_VARIANT_PATTERNS.independent ?? []) {
      expect(isCrmLineWithheldPath(pattern, "independent"), pattern).toBe(false);
    }
  });

  it("holds them, releasably, only on a delivery from outside the line", () => {
    const fromPrime = partitionCascadePaths([AGENT, PROVIDER, "src/a.ts"], [], {
      crmMode: "independent",
      fromAnotherLine: true,
    });
    expect(fromPrime.write).toEqual(["src/a.ts"]);
    expect(fromPrime.held.map((h) => [h.path, h.reason])).toEqual([
      [AGENT, "manual_reconcile"],
      [PROVIDER, "manual_reconcile"],
    ]);

    // The head's child reads the head, and must receive the head's copy.
    const fromParent = partitionCascadePaths([AGENT, PROVIDER], [], { crmMode: "independent" });
    expect(fromParent.held).toEqual([]);

    // A dependent clone reading the prime has nothing of the kind.
    const dependent = partitionCascadePaths([AGENT], [], {
      crmMode: "dependent",
      fromAnotherLine: true,
    });
    expect(dependent.held).toEqual([]);
  });

  it("never lets the line's own copies cross to a sibling on another line", () => {
    // A lateral exchange from the independent head to a dependent sibling:
    // the destination's register knows nothing of these paths, so the
    // ORIGIN's register has to hold them, and an operator may not release it.
    const p = partitionCascadePaths([AGENT, PROVIDER, "src/a.ts"], [], {
      crmMode: "dependent",
      fromAnotherLine: true,
      originCrmMode: "independent",
    });
    expect(p.write).toEqual(["src/a.ts"]);
    expect(p.held.map((h) => [h.path, h.reason])).toEqual([
      [AGENT, "protected"],
      [PROVIDER, "protected"],
    ]);
    expect(p.held[0]?.pattern).toMatch(/^\(crm-line variant of independent: /);

    // Same line on both sides: nothing of the origin's is held.
    const same = partitionCascadePaths([AGENT], [], {
      crmMode: "independent",
      originCrmMode: "independent",
    });
    expect(same.held).toEqual([]);
  });

  it("never downgrades a recorded protected row", () => {
    const p = partitionCascadePaths(
      [AGENT],
      [{ pattern: AGENT, reason: "protected", note: "operator" }],
      { crmMode: "independent", fromAnotherLine: true },
    );
    expect(p.held).toEqual([
      { path: AGENT, pattern: AGENT, reason: "protected", note: "operator" },
    ]);
  });

  it("holds nothing when the delivery deletes", () => {
    const p = partitionCascadePaths([AGENT], [], {
      purpose: "delete",
      crmMode: "independent",
      fromAnotherLine: true,
    });
    expect(p.held).toEqual([]);
  });
});

describe("the trees the independent line keeps as its own", () => {
  const RULE =
    ".claude/rules/billing/014-the-activation-gate-a-clone-may-be-locked-until-it-pays.md";
  const AGENT_SPEC = "src/lib/agent/__tests__/marketNews.spec.tsx";
  const IMPORT_SPEC = "src/lib/clients/__tests__/clientImportRecords.spec.ts";

  it("names the three the owner chose, for the independent line alone", () => {
    expect(crmLineKeptPattern(RULE, "independent")).toBe(".claude/**");
    expect(crmLineKeptPattern(AGENT_SPEC, "independent")).toBe("src/lib/agent/__tests__/**");
    expect(crmLineKeptPattern(IMPORT_SPEC, "independent")).toBe(IMPORT_SPEC);
    for (const mode of ["dependent", null, undefined]) {
      expect(crmLineKeptPattern(RULE, mode), String(mode)).toBeNull();
    }
    // The two specs the owner let through follow the prime.
    expect(crmLineKeptPattern("src/lib/buildVersion.test.ts", "independent")).toBeNull();
    expect(
      crmLineKeptPattern("src/lib/pricing/__tests__/planEntitlements.spec.ts", "independent"),
    ).toBeNull();
    // Neither the agent's own code nor the line's index is a kept tree.
    expect(crmLineKeptPattern("src/lib/agent/parityRegister.ts", "independent")).toBeNull();
    expect(crmLineKeptPattern("CLAUDE.md", "independent")).toBeNull();
  });

  it("holds a write from outside the line silently, with nothing to approve", () => {
    const fromPrime = partitionCascadePaths([RULE, AGENT_SPEC, IMPORT_SPEC, "src/a.ts"], [], {
      crmMode: "independent",
      fromAnotherLine: true,
    });
    expect(fromPrime.write).toEqual(["src/a.ts"]);
    expect(fromPrime.held.map((h) => [h.path, h.reason, h.pattern])).toEqual([
      [RULE, "protected", "(crm-line kept: .claude/**)"],
      [AGENT_SPEC, "protected", "(crm-line kept: src/lib/agent/__tests__/**)"],
      [IMPORT_SPEC, "protected", `(crm-line kept: ${IMPORT_SPEC})`],
    ]);
    expect(reportableHeld(fromPrime.held)).toEqual([]);
    expect(approvableHeld(fromPrime.held)).toEqual([]);

    // The head's child reads the head, and receives the head's own copies.
    const fromParent = partitionCascadePaths([RULE, AGENT_SPEC], [], { crmMode: "independent" });
    expect(fromParent.held).toEqual([]);

    // A dependent clone reading the prime keeps nothing of the kind.
    const dependent = partitionCascadePaths([RULE], [], {
      crmMode: "dependent",
      fromAnotherLine: true,
    });
    expect(dependent.held).toEqual([]);
  });

  it("lets a released kept spec past the kept rule, and past nothing else", () => {
    // `keptSpecRelease.pure.ts`: a kept spec left behind by the file it tests,
    // whose prime copy needs nothing the line lacks, travels on evidence.
    const released = new Set([AGENT_SPEC]);
    const carried = partitionCascadePaths([RULE, AGENT_SPEC], [], {
      crmMode: "independent",
      fromAnotherLine: true,
      travelsPastKept: released,
    });
    expect(carried.write).toEqual([AGENT_SPEC]);
    expect(carried.held.map((h) => h.path)).toEqual([RULE]);

    // Only the kept rule steps aside: a protected row on the same path holds it.
    const rowHeld = partitionCascadePaths(
      [AGENT_SPEC],
      [{ pattern: "src/lib/agent/__tests__/**", reason: "protected", note: "the clone's own" }],
      { crmMode: "independent", fromAnotherLine: true, travelsPastKept: released },
    );
    expect(rowHeld.write).toEqual([]);
    expect(rowHeld.held.map((h) => [h.path, h.pattern])).toEqual([
      [AGENT_SPEC, "src/lib/agent/__tests__/**"],
    ]);
  });

  it("holds a deletion from outside the line too, and none in a conversion", () => {
    const fromPrime = partitionCascadePaths([RULE, "src/gone.ts"], [], {
      purpose: "delete",
      crmMode: "independent",
      fromAnotherLine: true,
    });
    expect(fromPrime.write).toEqual(["src/gone.ts"]);
    expect(fromPrime.held.map((h) => [h.path, h.pattern])).toEqual([
      [RULE, "(crm-line kept: .claude/**)"],
    ]);

    // A conversion takes the other line's copy of everything it carries.
    const conversion = partitionCascadePaths([RULE], [], {
      purpose: "delete",
      crmMode: "independent",
    });
    expect(conversion.held).toEqual([]);
  });

  it("swallows no variant, which has to stay a decision", () => {
    for (const pattern of CRM_LINE_VARIANT_PATTERNS.independent ?? []) {
      expect(crmLineKeptPattern(pattern, "independent"), pattern).toBeNull();
    }
    for (const pattern of CRM_LINE_KEPT_PATTERNS.independent ?? []) {
      expect(isCrmLineWithheldPath(pattern, "independent"), pattern).toBe(false);
    }
  });
});
