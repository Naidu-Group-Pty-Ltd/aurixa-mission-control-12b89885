// The callbacks Prime's runner sends, as it sends them, accepted or refused.
// The bodies below are the runner's own shapes (run.mjs on Prime): a change to
// either side that breaks the other fails here first.
import { describe, expect, it } from "vitest";
import {
  LiveAuditFindingSchema,
  RunCallbackSchema,
  coveredTemplates,
  runWasComplete,
} from "./live-audit-contract";

const RUN = "3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const base = {
  run_id: RUN,
  runner_version: 1,
  workflow_run_id: 42,
  workflow_run_url: "https://github.com/o/r/actions/runs/42",
  sent_at: "2026-10-30T00:00:00Z",
};

const finding = {
  fingerprint: "a".repeat(64),
  detector: "page_error",
  category: "crash",
  severity: "high",
  title: "Clients page throws on Edit",
  description: "An uncaught TypeError.",
  route: "/clients/123",
  route_template: "/clients/:id",
  repro_steps: [{ action: "navigate", path: "/clients/123" }],
  evidence: { console: ["TypeError"] },
  suspected_files: [{ path: "src/x.tsx", line: 4, reason: "maps undefined" }],
  fix_hint: null,
  confidence: 0.9,
  occurrences: 2,
  deterministic: true,
  reproduced: true,
  judged_by: "claude",
};

describe("what the runner reports", () => {
  it("accepts every event the runner sends", () => {
    const events = [
      {
        ...base,
        event: "run.started",
        mode: "live",
        kind: "manual",
        target_origin: "https://command-centre.npcservices.com.au",
        sha: "b".repeat(40),
        auth: { state: "signed_in", detail: null, user: "audit", role: "admin" },
        anthropic: { available: true, model: "claude-opus-5-5", model_source: "default" },
        knowledge: { routes: 120 },
      },
      { ...base, event: "run.context" },
      { ...base, event: "run.progress", phase: "crawl", status: "done", visited: 40 },
      { ...base, event: "run.findings", batch: { index: 0, count: 1 }, findings: [finding] },
      {
        ...base,
        event: "run.completed",
        summary: { complete: true, coverage: { templates_covered: ["/clients/:id"] } },
      },
      { ...base, event: "run.failed", phase: "crawl", error: "boom" },
    ];
    for (const e of events) expect(RunCallbackSchema.safeParse(e).success, e.event).toBe(true);
  });

  it("accepts the workflow's own failure report, which carries no runner version", () => {
    // The `if: failure()` step in live-audit.yml, before the runner existed.
    const body = {
      run_id: RUN,
      event: "run.failed",
      phase: "workflow",
      error: "The workflow failed",
      workflow_run_id: 42,
      workflow_run_url: base.workflow_run_url,
    };
    expect(RunCallbackSchema.safeParse(body).success).toBe(true);
  });

  it("keeps the progress detail it does not name", () => {
    const parsed = RunCallbackSchema.parse({
      ...base,
      event: "run.progress",
      phase: "explore",
      journeys: 3,
    });
    expect(parsed).toMatchObject({ journeys: 3 });
  });

  it("refuses what it does not know", () => {
    expect(RunCallbackSchema.safeParse({ ...base, event: "run.deleted" }).success).toBe(false);
    expect(
      RunCallbackSchema.safeParse({ ...base, run_id: "not-a-uuid", event: "run.context" }).success,
    ).toBe(false);
    expect(
      RunCallbackSchema.safeParse({
        ...base,
        event: "run.findings",
        batch: { index: 0, count: 1 },
        findings: Array(51).fill(finding),
      }).success,
    ).toBe(false);
  });
});

describe("a finding", () => {
  it("is fingerprinted, and its severity and steps are bounded", () => {
    expect(LiveAuditFindingSchema.safeParse(finding).success).toBe(true);
    expect(LiveAuditFindingSchema.safeParse({ ...finding, fingerprint: "xyz" }).success).toBe(
      false,
    );
    expect(LiveAuditFindingSchema.safeParse({ ...finding, severity: "urgent" }).success).toBe(
      false,
    );
    expect(
      LiveAuditFindingSchema.safeParse({
        ...finding,
        repro_steps: [{ action: "delete-account", path: "/" }],
      }).success,
    ).toBe(false);
  });

  it("carries a screenshot only as a bounded jpeg or png", () => {
    expect(
      LiveAuditFindingSchema.safeParse({
        ...finding,
        screenshot: { mime: "image/jpeg", data: "AAAA" },
      }).success,
    ).toBe(true);
    expect(
      LiveAuditFindingSchema.safeParse({
        ...finding,
        screenshot: { mime: "image/svg+xml", data: "AAAA" },
      }).success,
    ).toBe(false);
    expect(
      LiveAuditFindingSchema.safeParse({
        ...finding,
        screenshot: { mime: "image/png", data: "A".repeat(820_001) },
      }).success,
    ).toBe(false);
  });
});

describe("resolving by absence rests on what the runner said it covered", () => {
  it("is complete only when the runner says exactly true", () => {
    expect(runWasComplete({ complete: true })).toBe(true);
    expect(runWasComplete({ complete: "true" })).toBe(false);
    expect(runWasComplete({})).toBe(false);
    expect(runWasComplete(null)).toBe(false);
  });

  it("covers only templates it names, once each", () => {
    expect(
      coveredTemplates({
        coverage: { templates_covered: ["/a", "/a", "/b/:id", "", "x", 5, null] },
      }),
    ).toEqual(["/a", "/b/:id"]);
    expect(coveredTemplates({ coverage: { templates_covered: "/a" } })).toEqual([]);
    expect(coveredTemplates(undefined)).toEqual([]);
  });
});
