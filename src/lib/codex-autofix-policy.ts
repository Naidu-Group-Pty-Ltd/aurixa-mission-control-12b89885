// Which Codex Security findings Mission Control fixes by itself, and which
// engine writes each fix. Pure; codex-autofix.server.ts dispatches the fixes
// after the nightly Prime scan, and self-healing.server.ts merges them.
//
// The rule, set by the platform owner (October 2026): P0 and P1 findings —
// critical and high — are fixed by Claude, P2 and below by Codex, info (P4)
// included, and every fix PR merges with no person in the loop once its
// automated checks pass (remediation-policy.ts `decideFixMerge`). The merge
// lands on Prime and the cascade delivers it to the clones. Info findings
// come last in the night's order, so they use what the limit leaves.
//
// Not fixed automatically:
//   - anything gitleaks reported, at any severity. A committed credential
//     (critical to medium) has to be rotated: deleting it from the code does not
//     make it safe — the scan alert asks a person to rotate it — and replacing
//     it with an unset environment variable passes every check and breaks the
//     app at runtime, on Prime and then the fleet. An info-level hit is a
//     value graded as not secret (a public anon key, a publishable key, an id)
//     that the app needs where it is: "fixing" it is the same breakage;
//   - findings seen only on a pull request (none are raised any more: scans
//     run nightly on Prime), and anything a person has already decided or is
//     looking at (`triaging`).

import { severityToPriority, type TicketPriority } from "./ticket-classification";
import { SECRET_SCANNERS } from "./codex-finding-lifecycle";

export type FixEngine = "claude_code" | "codex_cli";

export const FIX_ENGINES: readonly FixEngine[] = ["claude_code", "codex_cli"];

export const FIX_ENGINE_LABEL: Record<FixEngine, string> = {
  claude_code: "Claude",
  codex_cli: "Codex",
};

/** How the workflow's `finding.engine` field names each engine. */
export const WORKFLOW_ENGINE: Record<FixEngine, "claude" | "codex"> = {
  claude_code: "claude",
  codex_cli: "codex",
};

export function isFixEngine(value: unknown): value is FixEngine {
  return FIX_ENGINES.includes(value as FixEngine);
}

/**
 * The engine that writes the fix for a finding of this severity: Claude for
 * P0/P1, Codex for P2, P3 and info (P4). Null for a severity it cannot place
 * — which `severityToPriority` would also call P4.
 */
export function fixEngineFor(severity: string | null | undefined): FixEngine | null {
  const priority = severityToPriority(severity ?? "");
  if (priority === "P0" || priority === "P1") return "claude_code";
  if (priority === "P2" || priority === "P3") return "codex_cli";
  return severity === "info" ? "codex_cli" : null;
}

/** Automatic attempts at one finding that ended without a merge, before it is left for a person. */
export const AUTOFIX_MAX_ATTEMPTS = 2;
/** Fixes dispatched after one nightly scan, by default (`prime_config.codex_autofix_max_per_night`). */
export const AUTOFIX_DEFAULT_PER_NIGHT = 10;
export const AUTOFIX_MAX_PER_NIGHT_LIMIT = 50;

export type AutofixFinding = {
  id: string;
  severity: string;
  state: string;
  scanner?: string | null;
  first_seen_at?: string | null;
  clone_id?: string | null;
  pr_number?: number | null;
};

export type AutofixPick = AutofixFinding & { engine: FixEngine; priority: TicketPriority };

export type AutofixSkip = { id: string; reason: string };

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Why a finding is not fixed automatically, or null when it is eligible. */
export function autofixIneligibility(f: AutofixFinding): string | null {
  if (f.clone_id) return "clone finding — clones are fixed by the cascade from Prime";
  if (f.pr_number != null) return "pull request finding";
  if (f.state !== "open") return `finding is ${f.state}`;
  if (f.scanner && SECRET_SCANNERS.has(f.scanner)) {
    return f.severity === "info"
      ? "a value graded as not secret — the app needs it where it is"
      : "committed credential — rotate it; a code change cannot make it safe";
  }
  if (!fixEngineFor(f.severity)) return `${f.severity} findings are not fixed automatically`;
  return null;
}

/**
 * The findings to fix tonight, worst first and then oldest first, within the
 * nightly limit. A finding with a fix already in flight is skipped, as is one
 * whose automatic fixes have failed `AUTOFIX_MAX_ATTEMPTS` times: the same
 * prompt against the same code tends to fail the same way, and each attempt
 * costs a run.
 */
export function selectAutofixCandidates(input: {
  findings: AutofixFinding[];
  limit: number;
  inFlight: ReadonlySet<string>;
  failedAttempts: ReadonlyMap<string, number>;
}): { picks: AutofixPick[]; skipped: AutofixSkip[] } {
  const skipped: AutofixSkip[] = [];
  const eligible: AutofixPick[] = [];
  for (const f of input.findings) {
    const why = autofixIneligibility(f);
    if (why) {
      skipped.push({ id: f.id, reason: why });
      continue;
    }
    if (input.inFlight.has(f.id)) {
      skipped.push({ id: f.id, reason: "a fix is already in flight" });
      continue;
    }
    const attempts = input.failedAttempts.get(f.id) ?? 0;
    if (attempts >= AUTOFIX_MAX_ATTEMPTS) {
      skipped.push({ id: f.id, reason: `${attempts} automatic fixes did not merge` });
      continue;
    }
    eligible.push({
      ...f,
      engine: fixEngineFor(f.severity) as FixEngine,
      priority: severityToPriority(f.severity),
    });
  }
  eligible.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      String(a.first_seen_at ?? "").localeCompare(String(b.first_seen_at ?? "")),
  );
  const limit = Math.max(0, Math.min(AUTOFIX_MAX_PER_NIGHT_LIMIT, Math.floor(input.limit)));
  for (const f of eligible.slice(limit)) skipped.push({ id: f.id, reason: "over tonight's limit" });
  return { picks: eligible.slice(0, limit), skipped };
}

export function parseAutofixLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTOFIX_DEFAULT_PER_NIGHT;
  return Math.max(0, Math.min(AUTOFIX_MAX_PER_NIGHT_LIMIT, Math.floor(n)));
}
