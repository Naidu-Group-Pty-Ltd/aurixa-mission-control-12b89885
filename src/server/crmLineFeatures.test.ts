import { describe, expect, it } from "vitest";

import {
  CRM_LINE_FEATURES,
  allCrmLineFunctionNames,
  crmLineCronJobsIn,
  crmLineCronReason,
  crmLineFeatureForPath,
  crmLineFunctionsIn,
  CRM_LINE_VARIANT_PATTERNS,
  crmLineVariantPattern,
  crmLineWithheldFunctionNames,
  describeWithheldAcrossRegisters,
  isCrmLineWithheldFunction,
  isCrmLineWithheldPath,
  withheldClause,
  withheldLineFunctions,
} from "@/server/crmLineFeatures.pure";
import { PRIME_ONLY_FEATURES, isPrimeOnlyFunction } from "@/server/primeOnlyFeatures.pure";
import { partitionCascadePaths } from "@/server/cascade/syncExclusions.pure";
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
    ).toEqual(["send-ghl-message", "sync-ghl-pipelines"]);
    // Nothing to restore the other way, and never what is already live.
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
    ).toEqual([]);
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
