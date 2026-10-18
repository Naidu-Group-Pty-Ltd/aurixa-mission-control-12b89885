// Who has approved a Codex remediation, for which commit — one rule, read by
// the review panel, the two-key merge, and the self-healing queue alike.
//
// An approval is for the PR head it was given on. Approvals recorded before
// approvals carried a commit (head_sha null) or for an older head no longer
// count once a head is known: a push after approval needs approving again.

export type ApprovalRecord = {
  decision: string;
  reviewer_id: string;
  /** undefined: the column does not exist (unmigrated); null: not recorded. */
  head_sha?: string | null;
};

/**
 * Distinct approvers, excluding the requester, whose approval names `headSha`.
 * With no head to compare against, every approval counts — the old rule.
 */
export function approvalsAtHead(
  reviews: ApprovalRecord[],
  requestedBy: string | null,
  headSha: string | null,
): { count: number; stale: number } {
  const current = new Set<string>();
  const stale = new Set<string>();
  for (const r of reviews) {
    if (r.decision !== "approve" || r.reviewer_id === requestedBy) continue;
    if (!headSha || r.head_sha === undefined || r.head_sha === headSha) current.add(r.reviewer_id);
    else stale.add(r.reviewer_id);
  }
  for (const id of current) stale.delete(id);
  return { count: current.size, stale: stale.size };
}
