// What Prime's live-audit runner promises Mission Control, and what Mission
// Control accepts from it.
//
// The runner lives on Prime (.github/live-audit/, run by
// .github/workflows/live-audit.yml); neither repository can import the
// other's code, so the contract is stated here and checked on every callback.
// The runner sends `runner_version` with each one, and the workflow declares
// `WORKFLOW_VERSION`, which engine health reads from Prime's copy of the file
// the way it reads the Codex workflows' (`declaredWorkflowVersion`).
//
// Runner version 1 is the first: knowledge, scope, crawl, explore, triage and
// report; findings fingerprinted per (detector, route template, evidence
// shape); a summary that says whether the run was complete and which page
// templates it covered — the only basis on which a finding may be resolved by
// its absence.
import { z } from "zod";

export const LIVE_AUDIT_WORKFLOW_FILE = "live-audit.yml";
export const LIVE_AUDIT_WORKFLOW_VERSION = 1;
export const LIVE_AUDIT_RUNNER_VERSION = 1;
/** The remediation workflow that first fixes a live-audit defect (`kind: "bug"`). */
export const REMEDIATION_VERSION_FOR_DEFECTS = 5;

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);

export const ReproStepSchema = z.object({
  action: z.enum([
    "navigate",
    "click",
    "fill",
    "select",
    "press",
    "scroll",
    "back",
    "hover",
    "wait",
  ]),
  path: z.string().max(500),
  role: z.string().max(60).optional(),
  name: z.string().max(200).optional(),
  value: z.string().max(200).optional(),
  key: z.string().max(40).optional(),
  direction: z.enum(["up", "down"]).optional(),
});

export const LiveAuditFindingSchema = z.object({
  fingerprint,
  detector: z.string().min(1).max(60),
  category: z.string().min(1).max(40),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  title: z.string().min(1).max(300),
  description: z.string().max(6000).nullable().optional(),
  route: z.string().max(500).nullable().optional(),
  route_template: z.string().max(300).nullable().optional(),
  repro_steps: z.array(ReproStepSchema).max(40).default([]),
  evidence: z.record(z.any()).default({}),
  suspected_files: z
    .array(
      z.object({
        path: z.string().max(300),
        line: z.number().int().positive().nullable().optional(),
        reason: z.string().max(600).optional(),
      }),
    )
    .max(10)
    .default([]),
  fix_hint: z.string().max(800).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  occurrences: z.number().int().min(1).max(100_000).default(1),
  deterministic: z.boolean().default(false),
  reproduced: z.boolean().nullable().optional(),
  judged_by: z.string().max(20).nullable().optional(),
  screenshot: z
    .object({
      mime: z.enum(["image/jpeg", "image/png"]),
      // ~600 KB of image, as base64.
      data: z.string().max(820_000),
    })
    .optional(),
});
export type LiveAuditFinding = z.infer<typeof LiveAuditFindingSchema>;

const common = {
  run_id: z.string().uuid(),
  runner_version: z.number().int().min(0).optional(),
  workflow_run_id: z.number().int().nullable().optional(),
  workflow_run_url: z.string().url().max(500).nullable().optional(),
  sent_at: z.string().max(40).optional(),
};

export const RunCallbackSchema = z.discriminatedUnion("event", [
  z.object({
    ...common,
    event: z.literal("run.started"),
    mode: z.enum(["live", "preview"]).optional(),
    kind: z.string().max(20).optional(),
    target_origin: z.string().max(300).optional(),
    sha: z.string().max(64).nullable().optional(),
    auth: z
      .object({
        state: z.string().max(40),
        detail: z.string().max(500).nullable().optional(),
        user: z.string().max(120).nullable().optional(),
        role: z.string().max(60).nullable().optional(),
      })
      .optional(),
    anthropic: z.record(z.any()).optional(),
    knowledge: z.record(z.any()).optional(),
  }),
  z.object({ ...common, event: z.literal("run.context") }),
  z
    .object({
      ...common,
      event: z.literal("run.progress"),
      phase: z.string().max(40),
      status: z.string().max(40).optional(),
    })
    .passthrough(),
  z.object({
    ...common,
    event: z.literal("run.findings"),
    batch: z.object({ index: z.number().int().min(0), count: z.number().int().min(1) }),
    findings: z.array(LiveAuditFindingSchema).max(50),
  }),
  z.object({
    ...common,
    event: z.literal("run.completed"),
    summary: z.record(z.any()),
  }),
  z.object({
    ...common,
    event: z.literal("run.failed"),
    phase: z.string().max(40).optional(),
    error: z.string().max(4000).optional(),
    summary: z.record(z.any()).optional(),
  }),
]);
export type RunCallback = z.infer<typeof RunCallbackSchema>;

/** The templates a complete run covered, from its summary. Anything malformed is none. */
export function coveredTemplates(summary: unknown): string[] {
  const list = (summary as { coverage?: { templates_covered?: unknown } } | null)?.coverage
    ?.templates_covered;
  return Array.isArray(list)
    ? [
        ...new Set(
          list.filter(
            (t): t is string => typeof t === "string" && t.startsWith("/") && t.length <= 300,
          ),
        ),
      ].slice(0, 1000)
    : [];
}

/** Whether the runner said its run was complete. Only a literal `true` is. */
export function runWasComplete(summary: unknown): boolean {
  return (summary as { complete?: unknown } | null)?.complete === true;
}
