import { describe, expect, it } from "vitest";
import {
  AUDIT_ACCOUNT,
  AUTOFIX_MAX_ATTEMPTS,
  CLAUDE_MODEL_ID,
  DEFAULT_AUDIT_MODEL,
  LIVE_AUDIT_MODELS,
  autofixQueue,
  fixBranchName,
  fixEligibility,
  liveAuditRequestAllowed,
  renderFixEvidence,
  runSettingsFor,
  triageTransition,
  type FixCandidate,
  type LiveAuditSettingsRow,
} from "./live-audit-policy";

const NOW = Date.parse("2026-10-30T00:00:00Z");

const candidate = (over: Partial<FixCandidate> = {}): FixCandidate => ({
  id: "f1",
  state: "open",
  severity: "high",
  category: "crash",
  confidence: 0.9,
  fix_attempts: 0,
  last_fix_at: null,
  first_seen_at: "2026-10-01T00:00:00Z",
  deterministic: true,
  reproduced: null,
  ...over,
});

const settings: LiveAuditSettingsRow = {
  claude_enabled: true,
  audit_account: null,
  audit_model: null,
  effort_scope: "high",
  effort_explore: "medium",
  effort_triage: "high",
  budget_usd: 15,
  max_pages: 60,
  max_journeys: 8,
  max_steps: 25,
  time_budget_minutes: 70,
  viewports: ["desktop"],
  screenshots: "issues",
  guard_allow_functions: [],
  guard_block_functions: ["send-invoice"],
};

describe("where the live audit runs", () => {
  it("runs on Prime and nowhere else while it is being proven", () => {
    expect(liveAuditRequestAllowed({ targetKey: "prime", kind: "manual", mode: "live" })).toEqual({
      ok: true,
    });
    const clone = liveAuditRequestAllowed({ targetKey: "clone-123", kind: "manual", mode: "live" });
    expect(clone.ok).toBe(false);
    expect(clone.ok === false && clone.reason).toMatch(/Prime only/);
  });

  it("refuses kinds and modes it does not know", () => {
    expect(liveAuditRequestAllowed({ targetKey: "prime", kind: "hourly", mode: "live" }).ok).toBe(
      false,
    );
    expect(
      liveAuditRequestAllowed({ targetKey: "prime", kind: "manual", mode: "staging" }).ok,
    ).toBe(false);
  });
});

describe("triage by hand", () => {
  it("needs a reason to dismiss, and records none for a reopen", () => {
    expect(triageTransition("open", "dismissed", "").ok).toBe(false);
    expect(triageTransition("open", "dismissed", "  ").ok).toBe(false);
    expect(triageTransition("open", "dismissed", "known, tracked in the CRM backlog").ok).toBe(
      true,
    );
    expect(triageTransition("open", "false_positive", null).ok).toBe(false);
    expect(triageTransition("dismissed", "open", null).ok).toBe(true);
  });

  it("leaves the fix states to the fix lane", () => {
    expect(triageTransition("open", "fix_queued", null).ok).toBe(false);
    expect(triageTransition("fix_queued", "open", null).ok).toBe(false);
    expect(triageTransition("fix_merged", "open", null).ok).toBe(true);
  });
});

describe("models", () => {
  it("offers Claude models only, with the default first", () => {
    expect(LIVE_AUDIT_MODELS[0].id).toBe(DEFAULT_AUDIT_MODEL);
    for (const m of LIVE_AUDIT_MODELS) expect(m.id).toMatch(CLAUDE_MODEL_ID);
    expect(CLAUDE_MODEL_ID.test("gpt-5")).toBe(false);
    expect(CLAUDE_MODEL_ID.test("claude-x; rm -rf /")).toBe(false);
  });
});

describe("what a run is sent", () => {
  it("omits the model until the owner chooses, so the runner records the default", () => {
    const out = runSettingsFor(settings, { kind: "manual" });
    expect(out).not.toHaveProperty("audit_model");
    expect(out).toMatchObject({
      kind: "manual",
      effort: { scope: "high", explore: "medium", triage: "high" },
      budget_usd: 15,
      guard: { allow_functions: [], block_functions: ["send-invoice"] },
    });
    expect(out).not.toHaveProperty("focus");
  });

  it("passes a chosen Claude model, never anything else", () => {
    expect(
      runSettingsFor({ ...settings, audit_model: "claude-sonnet-5-5" }, { kind: "nightly" }),
    ).toMatchObject({
      audit_model: "claude-sonnet-5-5",
    });
    expect(
      runSettingsFor({ ...settings, audit_model: "not-a-model" }, { kind: "nightly" }),
    ).not.toHaveProperty("audit_model");
  });

  it("names the audit account by its username, and nothing that is not one", () => {
    expect(runSettingsFor(settings, { kind: "manual" })).not.toHaveProperty("audit_account");
    expect(
      runSettingsFor({ ...settings, audit_account: "live.audit" }, { kind: "manual" }),
    ).toMatchObject({ audit_account: "live.audit" });
    for (const bad of ["", "x", "live audit", "a'; drop", "a".repeat(81)]) {
      expect(AUDIT_ACCOUNT.test(bad)).toBe(false);
      expect(
        runSettingsFor({ ...settings, audit_account: bad }, { kind: "manual" }),
      ).not.toHaveProperty("audit_account");
    }
  });

  it("carries a verification run's focus", () => {
    const out = runSettingsFor(settings, {
      kind: "verify",
      focusRoutes: ["/clients"],
      focusFingerprints: ["a".repeat(64)],
    });
    expect(out.focus).toEqual({ routes: ["/clients"], fingerprints: ["a".repeat(64)] });
  });
});

describe("Claude runs only when a person turns it on", () => {
  it("sends every run with Claude off until Use Claude is on, whatever model is chosen", () => {
    const off = runSettingsFor(
      { ...settings, claude_enabled: false, audit_model: "claude-opus-5-5" },
      { kind: "nightly" },
    );
    // The runner's own off switch (lib/config.mjs on Prime): no Anthropic call.
    expect(off).toMatchObject({ ai: "off" });
    expect(runSettingsFor(settings, { kind: "manual" })).not.toHaveProperty("ai");
  });

  it("drafts no fix while it is off, though Mission Control holds a key, and says why", () => {
    const v = fixEligibility(candidate(), {
      source: "operator",
      minConfidence: 0.7,
      claudeEnabled: false,
      keyPresent: true,
    });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/Claude is off for the live audit/);
    expect(v.ok === false && v.reason).toMatch(/Use Claude/);
  });
});

describe("fixes are Claude's, and wait on the Anthropic key", () => {
  it("dispatches nothing until the key is configured, and says so", () => {
    const v = fixEligibility(candidate(), {
      source: "operator",
      minConfidence: 0.7,
      claudeEnabled: true,
      keyPresent: false,
    });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/Waiting on the Anthropic key/);
  });

  it("lets a person fix any open defect, whatever its severity or confidence", () => {
    for (const severity of ["critical", "high", "medium", "low", "info"]) {
      expect(
        fixEligibility(candidate({ severity, confidence: 0.1, deterministic: false }), {
          source: "operator",
          minConfidence: 0.7,
          claudeEnabled: true,
          keyPresent: true,
        }).ok,
      ).toBe(true);
    }
  });

  it("never fixes the audit's own environment, or a finding already being fixed", () => {
    const ctx = {
      source: "operator" as const,
      minConfidence: 0.7,
      claudeEnabled: true,
      keyPresent: true,
    };
    expect(fixEligibility(candidate({ category: "environment" }), ctx).ok).toBe(false);
    expect(fixEligibility(candidate({ state: "fix_pr_open" }), ctx).ok).toBe(false);
    expect(fixEligibility(candidate({ state: "dismissed" }), ctx).ok).toBe(false);
  });

  it("holds automatic fixes to confidence, reproduction and a retry limit", () => {
    const ctx = {
      source: "autofix" as const,
      minConfidence: 0.7,
      claudeEnabled: true,
      keyPresent: true,
      now: NOW,
    };
    expect(fixEligibility(candidate({ confidence: 0.5 }), ctx).ok).toBe(false);
    expect(fixEligibility(candidate({ deterministic: false, reproduced: false }), ctx).ok).toBe(
      false,
    );
    expect(fixEligibility(candidate({ deterministic: false, reproduced: true }), ctx).ok).toBe(
      true,
    );
    const tried = candidate({
      fix_attempts: AUTOFIX_MAX_ATTEMPTS,
      last_fix_at: "2026-10-20T00:00:00Z",
    });
    expect(fixEligibility(tried, ctx).ok).toBe(false);
    // A month later it may be tried again.
    expect(fixEligibility({ ...tried, last_fix_at: "2026-09-01T00:00:00Z" }, ctx).ok).toBe(true);
  });

  it("queues the worst, surest, oldest first, up to the limit", () => {
    const queue = autofixQueue(
      [
        candidate({ id: "medium", severity: "medium" }),
        candidate({ id: "critical-unsure", severity: "critical", confidence: 0.75 }),
        candidate({ id: "critical-sure", severity: "critical", confidence: 0.95 }),
        candidate({ id: "noise", severity: "critical", category: "environment" }),
        candidate({ id: "high-new", severity: "high", first_seen_at: "2026-10-20T00:00:00Z" }),
        candidate({ id: "high-old", severity: "high", first_seen_at: "2026-09-20T00:00:00Z" }),
      ],
      { max: 4, minConfidence: 0.7, claudeEnabled: true, keyPresent: true, now: NOW },
    );
    expect(queue.map((f) => f.id)).toEqual([
      "critical-sure",
      "critical-unsure",
      "high-old",
      "high-new",
    ]);
    expect(
      autofixQueue([candidate()], {
        max: 3,
        minConfidence: 0.7,
        claudeEnabled: true,
        keyPresent: false,
      }),
    ).toEqual([]);
    // And none while Claude is off, though the key is there.
    expect(
      autofixQueue([candidate()], {
        max: 3,
        minConfidence: 0.7,
        claudeEnabled: false,
        keyPresent: true,
      }),
    ).toEqual([]);
  });
});

describe("the evidence a fix is given", () => {
  const finding = {
    route: "/clients/123",
    route_template: "/clients/:id",
    detector: "page_error",
    repro_steps: [
      { action: "navigate", path: "/clients/123" },
      { action: "click", path: "/clients/123", role: "button", name: "Edit" },
      { action: "fill", path: "/clients/123", role: "textbox", name: "Email", value: "a@b" },
    ],
    evidence: {
      console: ["TypeError: cannot read properties of undefined (reading 'map')"],
      stack: "at ClientCard (src/components/ClientCard.tsx:42:7)",
      requests: ["GET rest:clients 500"],
      notes: ['viewport: "desktop"'],
    },
    suspected_files: [
      { path: "src/components/ClientCard.tsx", line: 42, reason: "maps an optional list" },
    ],
    fix_hint: "Default the list to [] before mapping.",
    reproduced: true,
    deterministic: false,
  };

  it("says how to reach it, what was seen and where the code is", () => {
    const text = renderFixEvidence(finding);
    expect(text).toContain("Page: /clients/123 (route /clients/:id)");
    expect(text).toContain("reproduced by replaying");
    expect(text).toContain('2. click the button "Edit"');
    expect(text).toContain('3. fill the textbox "Email" with "a@b"');
    expect(text).toContain("TypeError: cannot read properties of undefined");
    expect(text).toContain("src/components/ClientCard.tsx:42 — maps an optional list");
    expect(text).toContain("Also observed:");
    expect(text).toContain("Suggested direction: Default the list");
  });

  it("stays inside what the workflow keeps", () => {
    const long = renderFixEvidence({
      ...finding,
      evidence: { console: Array(5).fill("x".repeat(5000)), stack: "y".repeat(9000) },
    });
    expect(long.length).toBeLessThanOrEqual(6000);
  });
});

describe("fix branches", () => {
  it("match the branch the remediation workflow accepts", () => {
    const branch = fixBranchName(
      "Clients page: crash on Edit!",
      "abcdef0123456789".repeat(4),
      "a1b2c3",
    );
    expect(branch).toBe("live-audit/fix-clients-page-crash-on-edit-abcdef01-a1b2c3");
    expect(branch).toMatch(/^(codex|live-audit)\/fix-[A-Za-z0-9._-]{1,180}$/);
    expect(fixBranchName("!!!", "0".repeat(64), "zz")).toBe("live-audit/fix-defect-00000000-zz");
  });
});
