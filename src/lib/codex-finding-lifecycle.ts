// The lifecycle of one Codex Security finding across repeated scans.
//
// `codex_findings` holds ONE row per (target, fingerprint). A target is Prime,
// a clone, or a pull request against either; PR scans read unmerged code and
// never touch the main record. These rules are applied inside Postgres by
// `codex_ingest_scan_findings` and `codex_finalize_scan`
// (supabase/migrations/20261018090000_codex_findings_canonical.sql), under row
// locks, so a triage made mid-scan cannot be overwritten. This module states
// the same rules in TypeScript so the UI can explain a state and the tests can
// pin the decisions — keep the two in step.
//
// The two failures they exist to prevent:
//  - absence mistaken for a fix. A scanner that crashed, a result batch that
//    never arrived, or an AI pass that simply phrased things differently all
//    look like "the finding is gone". Absence only counts when the finding's
//    own scanner ran cleanly and every batch arrived.
//  - a verdict nobody can change. Each finding has one current state, so a
//    reopen sticks, a closed fix PR returns the finding to `open`, and a
//    merged fix that did not work comes back instead of hiding for good.

import type { FindingState } from "./codex-finding-state";

export type { FindingState };

/** Scanners whose findings are credentials. Absence never resolves them. */
export const SECRET_SCANNERS: ReadonlySet<string> = new Set(["gitleaks", "gitleaks-history"]);

/** Scanners whose output varies run to run; one miss proves nothing. */
export const NONDETERMINISTIC_SCANNERS: ReadonlySet<string> = new Set(["codex"]);

/** Consecutive clean misses before the AI review's finding is resolved. */
export const NONDETERMINISTIC_MISS_THRESHOLD = 3;

export type ResolutionReason =
  | "absent"
  | "fixed"
  | "rotated"
  | "manual"
  | "pr_closed"
  | "pr_merged";

/** `prime`, `<clone id>`, or either suffixed with `:pr:<number>`. */
export function targetKeyFor(cloneId: string | null | undefined, prNumber?: number | null): string {
  return `${cloneId || "prime"}${prNumber != null ? `:pr:${prNumber}` : ""}`;
}

export type ReportedOutcome = {
  state: FindingState;
  event: "first_seen" | "regression" | "fix_ineffective" | null;
};

/**
 * A scan reported this finding. `previous` is its current state (undefined
 * when it has never been seen on this target).
 *
 *  - never seen                     → open
 *  - resolved                       → open, a regression — unless the
 *                                     resolution was `rotated`: a dead
 *                                     credential is still in git history and
 *                                     will be reported for ever
 *  - fix_merged, scan after merge   → open, the fix did not work
 *  - anything else                  → unchanged (verdicts and fixes in flight)
 */
export function onReported(
  previous: FindingState | undefined,
  ctx: { resolution?: string | null; mergedBeforeScan?: boolean } = {},
): ReportedOutcome {
  if (!previous) return { state: "open", event: "first_seen" };
  if (previous === "resolved") {
    return ctx.resolution === "rotated"
      ? { state: "resolved", event: null }
      : { state: "open", event: "regression" };
  }
  if (previous === "fix_merged" && ctx.mergedBeforeScan) {
    return { state: "open", event: "fix_ineffective" };
  }
  return { state: previous, event: null };
}

export type AbsentOutcome = {
  state: FindingState;
  resolution: ResolutionReason | null;
  event: "auto_resolved" | "fix_confirmed" | "fix_unconfirmed" | "absent_from_tree" | null;
};

/** How many consecutive clean misses resolve a finding from this scanner. */
export function absenceThreshold(scanner: string | null | undefined, prTarget = false): number {
  if (prTarget) return 1;
  if (scanner && SECRET_SCANNERS.has(scanner)) return Number.POSITIVE_INFINITY;
  if (scanner && NONDETERMINISTIC_SCANNERS.has(scanner)) return NONDETERMINISTIC_MISS_THRESHOLD;
  return 1;
}

/**
 * A complete scan whose scanner for this finding ran cleanly did not report
 * it. `missedScans` already includes this miss.
 */
export function onAbsent(
  previous: FindingState,
  ctx: {
    scanner: string | null | undefined;
    missedScans: number;
    prTarget?: boolean;
    /** fix_merged only: the same rule still fires in the same file. */
    sameRuleStillInFile?: boolean;
    /** fix_merged only: a remediation merged before this scan was created. */
    mergedBeforeScan?: boolean;
    /** Whether this is the first scan to notice the absence. */
    firstMiss?: boolean;
  },
): AbsentOutcome {
  const prTarget = !!ctx.prTarget;
  if (ctx.scanner && SECRET_SCANNERS.has(ctx.scanner) && !prTarget) {
    const verdict = previous === "dismissed" || previous === "false_positive";
    return {
      state: previous,
      resolution: null,
      event: ctx.firstMiss && !verdict ? "absent_from_tree" : null,
    };
  }
  if (ctx.missedScans < absenceThreshold(ctx.scanner, prTarget)) {
    return { state: previous, resolution: null, event: null };
  }
  switch (previous) {
    case "open":
    case "triaging":
    case "fix_drafted":
    case "pr_open":
      return { state: "resolved", resolution: "absent", event: "auto_resolved" };
    case "fix_merged":
      if (ctx.sameRuleStillInFile) {
        return { state: "resolved", resolution: "fixed", event: "fix_unconfirmed" };
      }
      return {
        state: "resolved",
        resolution: "fixed",
        event: ctx.mergedBeforeScan ? "fix_confirmed" : "auto_resolved",
      };
    default:
      // dismissed / false_positive keep the verdict; resolved stays resolved.
      return { state: previous, resolution: null, event: null };
  }
}

export type ScannerReport = {
  /** Current workflow (v2+): the step's real outcome. */
  status?: "ok" | "failed" | "skipped" | string;
  /** Legacy workflow: an `ok` flag a crashed scanner could leave true. */
  ok?: boolean;
  /** Legacy workflow: the AI pass was not attempted. */
  skipped?: boolean;
  count?: number;
  reason?: string;
  mode?: string;
  errors?: number;
};

export type ScanSummaryLike = {
  workflow_version?: number | string | null;
  scanners?: Record<string, ScannerReport> | null;
  total?: number | null;
  callback_failures?: number | null;
};

/** Scanners from the legacy workflow whose `ok` flag cannot be trusted. */
const LEGACY_UNTRUSTED = new Set(["osv-scanner", "codex"]);

/** The scanners whose silence about a finding may count as its absence. */
export function eligibleScanners(summary: ScanSummaryLike | null | undefined): string[] {
  const scanners = summary?.scanners ?? {};
  const version = Number(summary?.workflow_version ?? 1);
  return Object.entries(scanners)
    .filter(([name, report]) =>
      version >= 2 ? report?.status === "ok" : report?.ok === true && !LEGACY_UNTRUSTED.has(name),
    )
    .map(([name]) => name)
    .sort();
}

/** Scanners that did not run cleanly, for "this scan was degraded" banners. */
export function degradedScanners(
  summary: ScanSummaryLike | null | undefined,
): Array<{ name: string; reason: string }> {
  const scanners = summary?.scanners ?? {};
  const version = Number(summary?.workflow_version ?? 1);
  return Object.entries(scanners)
    .filter(([, report]) =>
      version >= 2 ? report?.status === "failed" : report?.ok === false && !report?.skipped,
    )
    .map(([name, report]) => ({ name, reason: report?.reason || "did not run" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every batch arrived and no callback was dropped. */
export function isScanComplete(input: {
  expected?: number | null;
  observed: number;
  callbackFailures?: number | null;
}): boolean {
  if ((input.callbackFailures ?? 0) > 0) return false;
  return input.expected == null || input.observed >= input.expected;
}

// ── Manual triage ────────────────────────────────────────────────────────

export type TriageState = "open" | "triaging" | "dismissed" | "false_positive" | "resolved";

export const TRIAGE_STATES: readonly TriageState[] = [
  "open",
  "triaging",
  "dismissed",
  "false_positive",
  "resolved",
];

export type TriageRequest = {
  from: FindingState;
  to: TriageState;
  reason?: string | null;
  resolution?: ResolutionReason | null;
  scanner?: string | null;
};

/**
 * Whether an operator may move a finding from `from` to `to`, and what must
 * accompany it. Verdicts need a reason — "accepted risk" with no reason is
 * not a decision anyone can review. A credential can only be resolved as
 * `rotated`: deleting it from the files does not make it safe.
 */
export function validateTriage(
  req: TriageRequest,
): { ok: true; resolution: ResolutionReason | null } | { ok: false; error: string } {
  if (req.from === req.to) return { ok: false, error: `Finding is already ${req.to}` };
  if (req.from === "fix_drafted" || req.from === "pr_open") {
    if (req.to !== "open" && req.to !== "dismissed" && req.to !== "false_positive") {
      return {
        ok: false,
        error: "A fix is in flight — close or merge its PR, or reopen/dismiss the finding",
      };
    }
  }
  const reason = (req.reason ?? "").trim();
  const needsReason =
    req.to === "dismissed" || req.to === "false_positive" || req.to === "resolved";
  if (needsReason && reason.length < 3) {
    return { ok: false, error: "Give a reason — it is recorded with the decision" };
  }
  if (req.to !== "resolved") return { ok: true, resolution: null };

  const isSecret = !!req.scanner && SECRET_SCANNERS.has(req.scanner);
  const resolution = req.resolution ?? (isSecret ? "rotated" : "manual");
  if (isSecret && resolution !== "rotated") {
    return {
      ok: false,
      error: "A committed credential can only be resolved once it has been rotated",
    };
  }
  if (!["rotated", "manual", "fixed"].includes(resolution)) {
    return { ok: false, error: `Resolution "${resolution}" is set by scans, not by hand` };
  }
  return { ok: true, resolution };
}

// ── State changes from intake partners ───────────────────────────────────

/**
 * The words partner systems (pentest portals, ticketing tools) use for a
 * finding's status, mapped onto the states a person may set. Anything else
 * is refused rather than ignored: an unknown word used to be dropped
 * silently, so the partner believed a finding closed that was still open.
 */
const INTAKE_STATE_SYNONYMS: Record<string, TriageState> = {
  open: "open",
  new: "open",
  reopen: "open",
  reopened: "open",
  triaging: "triaging",
  triage: "triaging",
  acknowledged: "triaging",
  investigating: "triaging",
  in_progress: "triaging",
  resolved: "resolved",
  fixed: "resolved",
  remediated: "resolved",
  closed: "resolved",
  done: "resolved",
  rotated: "resolved",
  dismissed: "dismissed",
  accepted: "dismissed",
  accepted_risk: "dismissed",
  risk_accepted: "dismissed",
  wont_fix: "dismissed",
  wontfix: "dismissed",
  false_positive: "false_positive",
  not_an_issue: "false_positive",
  invalid: "false_positive",
};

const intakeKey = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/** A partner's status word as a state a person may set, or null if it is not one. */
export function resolveIntakeState(raw: string): TriageState | null {
  return INTAKE_STATE_SYNONYMS[intakeKey(raw)] ?? null;
}

/**
 * How a partner's "resolved" is recorded. Only the word `rotated` says a
 * committed credential was rotated — "fixed" or "closed" from a pentest portal
 * says nothing about the key, so for a credential it is refused by the triage
 * rules (which accept nothing but `rotated` for one) rather than recorded as a
 * rotation nobody claimed.
 */
export function intakeResolution(raw: string): ResolutionReason {
  return intakeKey(raw) === "rotated" ? "rotated" : "manual";
}

/**
 * The reason recorded for a partner's verdict. Partners rarely send one, and a
 * verdict needs one: when they do not, the record at least says who decided.
 */
export function intakeReason(
  sourceName: string,
  state: TriageState,
  reason?: string | null,
): string {
  const given = (reason ?? "").trim();
  return given.length >= 3
    ? given
    : `Marked ${state.replace("_", " ")} by ${sourceName} through the intake API.`;
}

/** Plain-language meaning of each state, for tooltips and the explainer. */
export const STATE_MEANING: Record<FindingState, string> = {
  open: "Reported and not yet decided on.",
  triaging: "Someone is looking at it.",
  fix_drafted: "A fix PR is being written.",
  pr_open: "A fix PR is open and waiting for review.",
  fix_merged: "A fix merged; the next full scan will confirm it or reopen the finding.",
  resolved: "Gone from the code, fixed, or (for a credential) rotated.",
  dismissed: "Accepted risk — decided not to fix, with a recorded reason.",
  false_positive: "Not a real issue, with a recorded reason.",
};
