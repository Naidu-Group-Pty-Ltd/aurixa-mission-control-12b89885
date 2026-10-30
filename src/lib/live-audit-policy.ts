// Where, when and how the live audit runs, and who fixes what it finds.
// Pure: shared by the server, the hooks and the page.
//
// The live audit (docs/LIVE_AUDIT.md) drives Prime's deployed application in
// Chromium as a member of staff while Claude reads Prime's repository, for bug
// and error detection. Prime is its acid test: the owner decided on
// 29 Oct 2026 that it runs on Prime alone until it has been cycled through
// enough times to bolt onto the clones. That decision lives in
// `LIVE_AUDIT_TARGETS`, enforced where a run is queued, so no caller can route
// around it — the same shape as `codex-scan-policy.ts`.
//
// Every finding is fixed by Claude, whatever its severity: the fix travels
// through the Anthropic key Mission Control syncs into Prime's Actions secrets
// for the Claude Code fixes, and `codex-remediation.yml` version 5 refuses a
// live-audit defect that names any other engine.

export const LIVE_AUDIT_POLICY_SUMMARY =
  "The live audit runs on Prime only, a person's run or one a night. Clones receive what it leads to through the cascade.";

/** Targets the live audit may run against. Adding a clone id here is how it reaches the fleet. */
export const LIVE_AUDIT_TARGETS = ["prime"] as const;
export type LiveAuditTarget = (typeof LIVE_AUDIT_TARGETS)[number];

export const LIVE_AUDIT_KINDS = ["manual", "nightly", "verify"] as const;
export type LiveAuditKind = (typeof LIVE_AUDIT_KINDS)[number];

export const LIVE_AUDIT_MODES = ["live", "preview"] as const;
export type LiveAuditMode = (typeof LIVE_AUDIT_MODES)[number];

export type Verdict = { ok: true } | { ok: false; reason: string };

export function liveAuditRequestAllowed(input: {
  targetKey: string;
  kind: string;
  mode: string;
}): Verdict {
  if (!(LIVE_AUDIT_TARGETS as readonly string[]).includes(input.targetKey)) {
    return { ok: false, reason: "the live audit runs on Prime only while it is being proven" };
  }
  if (!(LIVE_AUDIT_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, reason: `unknown run kind ${input.kind}` };
  }
  if (!(LIVE_AUDIT_MODES as readonly string[]).includes(input.mode)) {
    return { ok: false, reason: `unknown mode ${input.mode}` };
  }
  return { ok: true };
}

// ── Severity and state ────────────────────────────────────────────────────

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export const FINDING_STATES = [
  "open",
  "triaging",
  "fix_queued",
  "fix_in_progress",
  "fix_pr_open",
  "fix_merged",
  "resolved",
  "dismissed",
  "false_positive",
] as const;
export type FindingState = (typeof FINDING_STATES)[number];

/** States a finding is still a live defect in. */
export const OPEN_STATES: readonly FindingState[] = [
  "open",
  "triaging",
  "fix_queued",
  "fix_in_progress",
  "fix_pr_open",
  "fix_merged",
];

export const STATE_LABEL: Record<FindingState, string> = {
  open: "Open",
  triaging: "Triaging",
  fix_queued: "Fix queued",
  fix_in_progress: "Claude is fixing",
  fix_pr_open: "Fix PR open",
  fix_merged: "Fix merged — awaiting confirmation",
  resolved: "Resolved",
  dismissed: "Dismissed",
  false_positive: "False positive",
};

/** What a person may move a finding to, from where. Fix states belong to the fix lane. */
const TRIAGE: Record<string, readonly FindingState[]> = {
  open: ["triaging", "dismissed", "false_positive", "resolved"],
  triaging: ["open", "dismissed", "false_positive", "resolved"],
  fix_queued: ["dismissed", "false_positive"],
  fix_in_progress: ["dismissed", "false_positive"],
  fix_pr_open: ["dismissed", "false_positive", "resolved"],
  fix_merged: ["resolved", "open"],
  resolved: ["open"],
  dismissed: ["open"],
  false_positive: ["open"],
};

export function triageTransition(
  from: string,
  to: string,
  reason: string | null | undefined,
): Verdict {
  const allowed = TRIAGE[from] ?? [];
  if (!(allowed as readonly string[]).includes(to)) {
    return { ok: false, reason: `a finding that is ${from} cannot be moved to ${to} by hand` };
  }
  if ((to === "dismissed" || to === "false_positive") && !(reason ?? "").trim()) {
    return { ok: false, reason: "dismissing a finding needs a reason, recorded in its history" };
  }
  return { ok: true };
}

// ── Models ────────────────────────────────────────────────────────────────

/** A model id Mission Control will pass on: a Claude model name, nothing else. */
export const CLAUDE_MODEL_ID = /^claude-[a-z0-9.-]{3,60}$/;

/**
 * The models offered on the settings page. The owner chooses; until they do,
 * the audit runs on the default and every run records that it was the default.
 */
export const LIVE_AUDIT_MODELS = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    note: "The default: deep code reading and judgement.",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    note: "Faster and cheaper per run; strong at agentic browsing.",
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    note: "The cheapest; for frequent, shallow runs.",
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    note: "Anthropic's most capable model, at the highest price.",
  },
] as const;
export const DEFAULT_AUDIT_MODEL = "claude-opus-5-5";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

// ── What a run is sent ────────────────────────────────────────────────────

export type LiveAuditSettingsRow = {
  /**
   * Whether Claude may be used at all: reading the code, exploring, judging
   * and fixing. Off until a person turns it on (migration 20261030161700):
   * Mission Control's org-scoped ANTHROPIC_API_KEY is configured for Codex,
   * and its presence is not the owner's consent to spend it here.
   */
  claude_enabled: boolean;
  audit_model: string | null;
  effort_scope: string;
  effort_explore: string;
  effort_triage: string;
  budget_usd: number;
  max_pages: number;
  max_journeys: number;
  max_steps: number;
  time_budget_minutes: number;
  viewports: string[];
  screenshots: string;
  guard_allow_functions: string[];
  guard_block_functions: string[];
};

/**
 * The `settings` dispatch input, in the runner's own vocabulary
 * (.github/live-audit/lib/config.mjs on Prime). The runner clamps every number
 * again: Mission Control chooses, the runner bounds.
 */
export function runSettingsFor(
  s: LiveAuditSettingsRow,
  input: { kind: LiveAuditKind; focusRoutes?: string[]; focusFingerprints?: string[] },
): Record<string, unknown> {
  const focus =
    (input.focusRoutes?.length ?? 0) || (input.focusFingerprints?.length ?? 0)
      ? { routes: input.focusRoutes ?? [], fingerprints: input.focusFingerprints ?? [] }
      : null;
  return {
    kind: input.kind,
    // The runner's own off switch (lib/config.mjs on Prime): no Anthropic call
    // is made, whatever key the workflow holds; it crawls and judges from the
    // browser alone, and says Claude was off.
    ...(s.claude_enabled ? {} : { ai: "off" }),
    ...(s.audit_model && CLAUDE_MODEL_ID.test(s.audit_model) ? { audit_model: s.audit_model } : {}),
    effort: { scope: s.effort_scope, explore: s.effort_explore, triage: s.effort_triage },
    budget_usd: Number(s.budget_usd),
    max_pages: s.max_pages,
    max_journeys: s.max_journeys,
    max_steps: s.max_steps,
    time_budget_minutes: s.time_budget_minutes,
    viewports: s.viewports,
    screenshots: s.screenshots,
    guard: { allow_functions: s.guard_allow_functions, block_functions: s.guard_block_functions },
    ...(focus ? { focus } : {}),
  };
}

// ── Fixes ─────────────────────────────────────────────────────────────────

/** Every live-audit fix is written by Claude Code. */
export const LIVE_AUDIT_FIX_ENGINE = "claude_code" as const;

/** Automatic attempts that did not merge, per finding, before it waits for a person. */
export const AUTOFIX_MAX_ATTEMPTS = 2;

export type FixCandidate = {
  id: string;
  state: string;
  severity: string;
  category: string;
  confidence: number | null;
  fix_attempts: number;
  last_fix_at: string | null;
  first_seen_at: string;
  deterministic: boolean;
  reproduced: boolean | null;
};

/** Whether a finding may have a fix drafted now. */
export function fixEligibility(
  f: FixCandidate,
  ctx: {
    source: "operator" | "autofix";
    minConfidence: number;
    /** The live audit's "Use Claude" setting. */
    claudeEnabled: boolean;
    keyPresent: boolean;
    now?: number;
  },
): Verdict {
  if (!ctx.claudeEnabled) {
    return {
      ok: false,
      reason:
        'Claude is off for the live audit, so no fix is drafted. Turn on "Use Claude" under Settings once ' +
        "the live audit's Anthropic key is provisioned.",
    };
  }
  if (!ctx.keyPresent) {
    return {
      ok: false,
      reason:
        "Waiting on the Anthropic key: live-audit fixes are written by Claude Code with the ANTHROPIC_API_KEY " +
        "Mission Control syncs into Prime's Actions secrets, and Mission Control holds none yet.",
    };
  }
  if (!["open", "triaging"].includes(f.state)) {
    return {
      ok: false,
      reason: `the finding is ${STATE_LABEL[f.state as FindingState] ?? f.state}`,
    };
  }
  if (f.category === "environment") {
    return {
      ok: false,
      reason: "an artefact of the audit's own environment is not a defect to fix",
    };
  }
  if (ctx.source === "autofix") {
    if ((f.confidence ?? 0) < ctx.minConfidence) {
      return {
        ok: false,
        reason: `confidence ${f.confidence ?? 0} is below the automatic-fix threshold ${ctx.minConfidence}`,
      };
    }
    if (!f.deterministic && f.reproduced !== true) {
      return { ok: false, reason: "found by the explore agent and not reproduced by replay" };
    }
    const now = ctx.now ?? Date.now();
    const recent = f.last_fix_at ? now - Date.parse(f.last_fix_at) < 30 * 86_400_000 : false;
    if (recent && f.fix_attempts >= AUTOFIX_MAX_ATTEMPTS) {
      return {
        ok: false,
        reason: `${AUTOFIX_MAX_ATTEMPTS} automatic fixes in 30 days did not merge; it waits for a person`,
      };
    }
  }
  return { ok: true };
}

/** Automatic fixes for a run: worst first, surest first, oldest first. */
export function autofixQueue<T extends FixCandidate>(
  findings: T[],
  ctx: {
    max: number;
    minConfidence: number;
    claudeEnabled: boolean;
    keyPresent: boolean;
    now?: number;
  },
): T[] {
  return findings
    .filter((f) => fixEligibility(f, { ...ctx, source: "autofix" }).ok)
    .sort(
      (a, b) =>
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        a.first_seen_at.localeCompare(b.first_seen_at),
    )
    .slice(0, Math.max(0, ctx.max));
}

type EvidenceFinding = {
  route: string | null;
  route_template: string | null;
  detector: string;
  repro_steps: unknown;
  evidence: unknown;
  suspected_files: unknown;
  fix_hint: string | null;
  reproduced: boolean | null;
  deterministic: boolean;
};

/**
 * What the fix agent is told the audit saw: how a user reaches the defect,
 * what the console and the network said, and where the code is. Rendered as
 * plain text the remediation workflow appends to the prompt as data. Bounded
 * to the 6,000 characters the workflow keeps.
 */
export function renderFixEvidence(f: EvidenceFinding): string {
  const lines: string[] = [];
  lines.push(
    `Page: ${f.route ?? "?"} (route ${f.route_template ?? "?"}), found by the ${f.detector} detector.`,
  );
  lines.push(
    f.deterministic
      ? "It recurs every time the page is opened."
      : f.reproduced
        ? "It was reproduced by replaying the steps in a fresh browser."
        : "It was seen while the audit explored; replay did not confirm it, so it may depend on timing or data.",
  );
  const steps = Array.isArray(f.repro_steps)
    ? (f.repro_steps as Array<Record<string, unknown>>)
    : [];
  if (steps.length) {
    lines.push("", "Steps to reproduce:");
    steps.slice(0, 20).forEach((s, i) => {
      const what =
        s.action === "navigate"
          ? `open ${String(s.path ?? "")}`
          : `${String(s.action ?? "")} the ${String(s.role ?? "element")} "${String(s.name ?? "")}"${s.value ? ` with "${String(s.value)}"` : ""}${s.key ? ` (${String(s.key)})` : ""}`;
      lines.push(`  ${i + 1}. ${what}`);
    });
  }
  const ev = (f.evidence && typeof f.evidence === "object" ? f.evidence : {}) as Record<
    string,
    unknown
  >;
  const list = (v: unknown) =>
    (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []) as string[];
  if (list(ev.console).length)
    lines.push(
      "",
      "Console:",
      ...list(ev.console)
        .slice(0, 5)
        .map((c) => `  ${c.slice(0, 600)}`),
    );
  if (typeof ev.stack === "string" && ev.stack) lines.push("", "Stack:", ev.stack.slice(0, 1200));
  if (list(ev.requests).length)
    lines.push(
      "",
      "Requests:",
      ...list(ev.requests)
        .slice(0, 5)
        .map((r) => `  ${r.slice(0, 300)}`),
    );
  if (list(ev.notes).length)
    lines.push(
      "",
      "Also observed:",
      ...list(ev.notes)
        .slice(0, 4)
        .map((n) => `  ${n.slice(0, 300)}`),
    );
  const files = Array.isArray(f.suspected_files)
    ? (f.suspected_files as Array<Record<string, unknown>>)
    : [];
  if (files.length) {
    lines.push("", "Where the audit's reading of the code points:");
    for (const file of files.slice(0, 6)) {
      lines.push(
        `  ${String(file.path ?? "")}${file.line ? `:${String(file.line)}` : ""} — ${String(file.reason ?? "")}`.slice(
          0,
          400,
        ),
      );
    }
  }
  if (f.fix_hint) lines.push("", `Suggested direction: ${f.fix_hint}`);
  return lines.join("\n").slice(0, 6000);
}

/** A branch name for one fix attempt. */
export function fixBranchName(title: string, fingerprint: string, nonce: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `live-audit/fix-${slug || "defect"}-${fingerprint.slice(0, 8)}-${nonce.replace(/[^a-z0-9]/gi, "").slice(0, 6)}`;
}
