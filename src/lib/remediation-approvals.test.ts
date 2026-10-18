import { describe, expect, it } from "vitest";
import { approvalsAtHead } from "./remediation-approvals";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

describe("approvalsAtHead", () => {
  it("counts distinct approvers other than the requester", () => {
    const reviews = [
      { decision: "approve", reviewer_id: "u1", head_sha: HEAD },
      { decision: "approve", reviewer_id: "u1", head_sha: HEAD },
      { decision: "approve", reviewer_id: "requester", head_sha: HEAD },
      { decision: "reject", reviewer_id: "u3", head_sha: HEAD },
      { decision: "approve", reviewer_id: "u2", head_sha: HEAD },
    ];
    expect(approvalsAtHead(reviews, "requester", HEAD)).toEqual({ count: 2, stale: 0 });
  });

  it("does not count an approval given before a new commit", () => {
    const reviews = [
      { decision: "approve", reviewer_id: "u1", head_sha: OLD },
      { decision: "approve", reviewer_id: "u2", head_sha: HEAD },
    ];
    expect(approvalsAtHead(reviews, null, HEAD)).toEqual({ count: 1, stale: 1 });
  });

  it("treats a re-approval at the new head as current, not stale", () => {
    const reviews = [
      { decision: "approve", reviewer_id: "u1", head_sha: OLD },
      { decision: "approve", reviewer_id: "u1", head_sha: HEAD },
    ];
    expect(approvalsAtHead(reviews, null, HEAD)).toEqual({ count: 1, stale: 0 });
  });

  it("does not count an approval that recorded no commit once a head is known", () => {
    expect(
      approvalsAtHead([{ decision: "approve", reviewer_id: "u1", head_sha: null }], null, HEAD),
    ).toEqual({
      count: 0,
      stale: 1,
    });
  });

  it("keeps the old rule where commits are not tracked yet", () => {
    // Unmigrated database: no head_sha column at all.
    expect(approvalsAtHead([{ decision: "approve", reviewer_id: "u1" }], null, HEAD).count).toBe(1);
    // No head known for the remediation.
    expect(
      approvalsAtHead([{ decision: "approve", reviewer_id: "u1", head_sha: OLD }], null, null)
        .count,
    ).toBe(1);
  });
});
