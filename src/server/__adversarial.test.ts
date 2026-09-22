import { describe, it, expect } from "vitest";
import {
  readPolicy,
  decideApplicant,
  decideInternal,
  applicantAlreadyEmailed,
  stageOccurredAt,
  hasReachedStage,
} from "./leadStageEmailPolicy.pure";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;

const CUTOVER = {
  MICROSOFT_MAILBOX_EMAIL: "admin@aurixasystems.com.au",
  LEAD_STAGE_INTERNAL_RECIPIENTS:
    "admin@a.test, rugesh@a.test, lavan@a.test, arvinraj@a.test, mithru@a.test",
  LEAD_STAGE_INTERNAL_STAGES: "2,3",
};

describe("R1: grace-period verdict is skip (terminal row)", () => {
  it("stage1 applicant, Make receipt ABSENT, at t=0 and at t=+6h", () => {
    const p = readPolicy(CUTOVER as never);
    const lead = {
      email: "a@x.test",
      created_at: ago(0),
      submitted_at: ago(0),
      stage1_email_message_id: null,
    };
    const t0 = decideApplicant(lead, 1, p, NOW);
    const later = decideApplicant(
      { ...lead, created_at: ago(6 * HOUR), submitted_at: ago(6 * HOUR) },
      1, p, NOW,
    );
    console.log("[R1] t=0   :", JSON.stringify(t0));
    console.log("[R1] t=+6h :", JSON.stringify(later));
    expect(t0.verdict).toBe("skip");
    // If the row were re-evaluated later it WOULD send — proving the row, not
    // the policy, is what cancels the obligation.
    expect(later.verdict).toBe("send");
  });
});

describe("R1b: stage-2 applicant is a PERMANENT skip in auto mode", () => {
  it("null receipt -> skip whose own reason names an unreachable remedy", () => {
    const p = readPolicy(CUTOVER as never);
    const lead = { email: "a@x.test", created_at: ago(2*HOUR), stage2_completed_at: ago(2*HOUR) };
    const auto = decideApplicant(lead, 2, p, NOW);
    console.log("[R1b] auto   :", JSON.stringify(auto));
    expect(auto.verdict).toBe("skip");
    expect(applicantAlreadyEmailed(lead, 2)).toBeNull();
    const always = decideApplicant(
      lead, 2, readPolicy({ ...CUTOVER, LEAD_STAGE_APPLICANT_MODE: "always" } as never), NOW,
    );
    console.log("[R1b] always :", JSON.stringify(always));
    expect(always.verdict).toBe("send");
  });
});

describe("R5: unset recipients -> SEND to one address", () => {
  it("mailbox_fallback still yields verdict send", () => {
    const configured = readPolicy(CUTOVER as never);
    const unset = readPolicy({ MICROSOFT_MAILBOX_EMAIL: "admin@aurixasystems.com.au" } as never);
    console.log("[R5] configured:", configured.internalRecipients.length, configured.internalRecipientSource);
    console.log("[R5] unset     :", unset.internalRecipients.length, unset.internalRecipientSource, JSON.stringify(unset.internalRecipients));
    const lead = { email: "a@x.test", created_at: ago(HOUR), stage2_completed_at: ago(HOUR) };
    const d = decideInternal(lead, 2, unset, NOW);
    console.log("[R5] verdict   :", JSON.stringify(d));
    expect(unset.internalRecipientSource).toBe("mailbox_fallback");
    expect(d.verdict).toBe("send");
  });
});

describe("NEW-A: LEAD_STAGE_INTERNAL_STAGES fails OPEN to 1,2,3", () => {
  it("an unparseable value silently restores stage 1", () => {
    const good = readPolicy({ ...CUTOVER } as never);
    const typo = readPolicy({ ...CUTOVER, LEAD_STAGE_INTERNAL_STAGES: "stage2,stage3" } as never);
    const spaced = readPolicy({ ...CUTOVER, LEAD_STAGE_INTERNAL_STAGES: "2 ,3" } as never);
    console.log("[NEW-A] '2,3'          ->", [...good.internalStages].sort());
    console.log("[NEW-A] 'stage2,stage3'->", [...typo.internalStages].sort());
    console.log("[NEW-A] '2 ,3'         ->", [...spaced.internalStages].sort());
    expect([...good.internalStages].sort()).toEqual([2, 3]);
    expect([...typo.internalStages].sort()).toEqual([1, 2, 3]);
    const lead = { email: "a@x.test", created_at: ago(HOUR), submitted_at: ago(HOUR) };
    const d = decideInternal(lead, 1, typo, NOW);
    console.log("[NEW-A] stage1 internal under typo:", JSON.stringify(d));
    expect(d.verdict).toBe("send"); // duplicates the live Airtable automation
  });
});

describe("R6: isTooOld reachability", () => {
  it("stage 2/3 are closed by hasReachedStage; stage 1 is the open one", () => {
    const p = readPolicy(CUTOVER as never);
    const bad = { email: "a@x.test", created_at: "31/12/2024", submitted_at: "31/12/2024" };
    console.log("[R6] Date.parse('31/12/2024') =", Date.parse("31/12/2024"));
    const s1 = decideApplicant(bad, 1, p, NOW);
    console.log("[R6] stage1 applicant, unparseable:", JSON.stringify(s1));
    const s2 = decideInternal({ email: "a@x.test", stage2_completed_at: "31/12/2024" }, 2, p, NOW);
    console.log("[R6] stage2 internal, unparseable :", JSON.stringify(s2));
    console.log("[R6] stageOccurredAt(null lead,1) :", stageOccurredAt({}, 1));
    console.log("[R6] hasReachedStage({},2)        :", hasReachedStage({}, 2));
    expect(s2.verdict).toBe("send"); // NOT closed by the column type
  });
});
