// Pure auto-vs-human policy for a single self-healing action. Mirrors the
// shape of `assessBlastRadius` in blast-radius.ts: plain inputs in, a
// decision with reasons out, so the ingest endpoint, the drain, and the
// approvals UI all read from one rulebook and it can be unit tested
// without a database.
//
// The contract this encodes: P2 and below flow through self-remediation;
// P0/P1 never execute unattended; and even below P2, an action that could
// destroy value (destructive SQL, an unverified patch, a diff too large to
// trust) is parked for human validation instead of executed.

import type { SqlRiskAssessment } from "./destructive-sql";
import type { TicketPriority } from "./ticket-classification";
import { priorityAtOrBelow } from "./ticket-classification";

export const REMEDIATION_ACTION_TYPES = [
  "pr_merge",
  "sql_migration",
  "edge_function_deploy",
  "monitor_recovery",
  "rescan",
  "manual",
] as const;
export type RemediationActionType = (typeof REMEDIATION_ACTION_TYPES)[number];

/** Auto-merge diff ceilings — a patch bigger than this is not "non-destructive". */
export const AUTO_MERGE_MAX_FILES = 10;
export const AUTO_MERGE_MAX_LINES = 400;

export type RemediationPolicyInput = {
  actionType: RemediationActionType;
  priority: TicketPriority;
  /** pr_merge: outcome of the remediation workflow's verification step. */
  verified?: boolean | null;
  /** pr_merge: gitleaks result on the patched tree. */
  secretsClean?: boolean | null;
  filesChanged?: number | null;
  linesChanged?: number | null;
  /** sql_migration: destructiveness assessment of every pending statement. */
  sqlAssessment?: SqlRiskAssessment | null;
  /**
   * sql_migration: the caller is planning a run the lane will gate itself.
   *
   * `executeSqlMigration` loads every PENDING migration's body immediately
   * before applying it, assesses each one, and parks the whole batch on the
   * first destructive statement or the first body it cannot read. That check
   * is strictly stronger than one taken at plan time — it reads the SQL that
   * is about to run rather than the SQL that was pending when somebody
   * queued the work, and those differ whenever the prime moves in between.
   *
   * So this is a statement about WHERE the assessment happens, never about
   * whether it happens. It exists as a flag rather than as the default
   * because turning the default around would widen auto-execution for the
   * ticket path too, which asks for this decision in a different context.
   */
  sqlAssessedByLane?: boolean;
};

export type RemediationPolicyDecision = {
  autoExecute: boolean;
  requiresHuman: boolean;
  reasons: string[];
};

function human(reasons: string[]): RemediationPolicyDecision {
  return { autoExecute: false, requiresHuman: true, reasons };
}

function auto(reasons: string[]): RemediationPolicyDecision {
  return { autoExecute: true, requiresHuman: false, reasons };
}

export function decideRemediation(input: RemediationPolicyInput): RemediationPolicyDecision {
  // Read-only actions are always safe to run, whatever the priority — they
  // gather the evidence a human (or a later action) needs.
  if (input.actionType === "monitor_recovery" || input.actionType === "rescan") {
    return auto([`${input.actionType} is read-only`]);
  }

  if (!priorityAtOrBelow(input.priority, "P2")) {
    return human([`${input.priority} incidents never execute unattended`]);
  }

  if (input.actionType === "manual") {
    return human(["action is explicitly manual"]);
  }

  if (input.actionType === "pr_merge") {
    const reasons: string[] = [];
    if (input.verified !== true) {
      return human(["remediation PR has no passing verification"]);
    }
    if (input.secretsClean === false) {
      return human(["secret scan on the patched tree did not come back clean"]);
    }
    const files = input.filesChanged ?? null;
    const lines = input.linesChanged ?? null;
    if (files == null || lines == null) {
      return human(["patch size unknown — cannot bound the blast radius"]);
    }
    if (files > AUTO_MERGE_MAX_FILES) {
      return human([`patch touches ${files} files (> ${AUTO_MERGE_MAX_FILES})`]);
    }
    if (lines > AUTO_MERGE_MAX_LINES) {
      return human([`patch changes ${lines} lines (> ${AUTO_MERGE_MAX_LINES})`]);
    }
    reasons.push(`verified patch within auto-merge bounds (${files} files, ${lines} lines)`);
    return auto(reasons);
  }

  if (input.actionType === "sql_migration") {
    // A supplied assessment is read FIRST and can still refuse. Reading the
    // deferral first would let a caller that has already been told the SQL is
    // destructive hand the batch to the lane anyway.
    if (!input.sqlAssessment) {
      if (input.sqlAssessedByLane) {
        return auto([
          "every pending statement is assessed by the lane immediately before it applies; " +
            "a destructive one parks the batch",
        ]);
      }
      return human(["pending SQL was not assessed for destructiveness"]);
    }
    if (input.sqlAssessment.destructive) {
      return human(
        input.sqlAssessment.findings.map((f) => `destructive SQL: ${f.reason}`).slice(0, 10),
      );
    }
    return auto([`${input.sqlAssessment.statementCount} pending statement(s), none destructive`]);
  }

  // edge_function_deploy: redeploying code that already exists on the prime
  // is non-destructive by construction — worst case is the same broken
  // function it replaces.
  return auto(["redeploy of prime-reviewed function bundles"]);
}
