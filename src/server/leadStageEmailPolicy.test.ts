import { describe, expect, it } from "vitest";
import {
  applicantAlreadyEmailed,
  decideApplicant,
  decideInternal,
  hasReachedStage,
  nextStepUrlFor,
  readPolicy,
  stageOccurredAt,
  type StageEmailEnv,
  type StageEmailSubject,
} from "./leadStageEmailPolicy.pure";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function policy(env: StageEmailEnv = {}) {
  return readPolicy({ MICROSOFT_MAILBOX_EMAIL: "hello@aurixasystems.com.au", ...env });
}

const lead = (over: Partial<StageEmailSubject> = {}): StageEmailSubject => ({
  email: "applicant@firm.com.au",
  created_at: minutesAgo(5),
  submitted_at: minutesAgo(5),
  ...over,
});

describe("readPolicy", () => {
  it("falls back to the sending mailbox when no internal recipients are named", () => {
    // A deployment that configured a mailbox and forgot the recipient list
    // should still be told about its leads, in the inbox it already watches.
    expect(policy().internalRecipients).toEqual(["hello@aurixasystems.com.au"]);
  });

  it("takes an explicit recipient list over the mailbox", () => {
    const p = policy({ LEAD_STAGE_INTERNAL_RECIPIENTS: "a@x.com, b@x.com" });
    expect(p.internalRecipients).toEqual(["a@x.com", "b@x.com"]);
  });

  it("defaults the applicant send to the backstop, never to unconditional", () => {
    expect(policy().applicantMode).toBe("auto");
  });

  it("treats an explicitly empty stage list as off, not as the default", () => {
    expect([...policy({ LEAD_STAGE_INTERNAL_STAGES: "" }).internalStages]).toEqual([]);
    expect([...policy({ LEAD_STAGE_INTERNAL_STAGES: "none" }).internalStages]).toEqual([]);
    // An unparseable value is somebody's typo, not a decision to switch it off.
    expect([...policy({ LEAD_STAGE_INTERNAL_STAGES: "nonsense" }).internalStages]).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("hasReachedStage", () => {
  it("reads the stage's own timestamp, never the `stage` column", () => {
    // `stage` is the FURTHEST stage reached. An applicant who booked a review
    // without completing the questionnaire has stage 3 and no Stage 2 event —
    // emailing them "your questionnaire has been received" is the failure this
    // prevents.
    const booked = lead({ stage: 3, stage3_booked_at: minutesAgo(2) });
    expect(hasReachedStage(booked, 1)).toBe(true);
    expect(hasReachedStage(booked, 2)).toBe(false);
    expect(hasReachedStage(booked, 3)).toBe(true);
  });

  it("dates each stage from its own event", () => {
    const l = lead({ stage2_completed_at: hoursAgo(2), stage3_booked_at: hoursAgo(1) });
    expect(stageOccurredAt(l, 2)).toBe(hoursAgo(2));
    expect(stageOccurredAt(l, 3)).toBe(hoursAgo(1));
  });
});

describe("decideInternal", () => {
  it("sends for a stage the applicant has reached", () => {
    expect(decideInternal(lead(), 1, policy(), NOW)).toEqual({ verdict: "send" });
  });

  it("raises no obligation at all for a stage nobody reached", () => {
    expect(decideInternal(lead(), 2, policy(), NOW)).toMatchObject({ verdict: "none" });
  });

  it("raises no obligation for an event outside the window", () => {
    // The single most important guard here: without it, the first tick after
    // this ships mails every historical applicant in the table.
    const old = lead({ created_at: hoursAgo(200), submitted_at: hoursAgo(200) });
    expect(decideInternal(old, 1, policy(), NOW)).toMatchObject({ verdict: "none" });
  });

  it("records a reason rather than going silent when nobody is configured", () => {
    const p = readPolicy({});
    const decision = decideInternal(lead(), 1, p, NOW);
    expect(decision.verdict).toBe("skip");
    expect(decision).toMatchObject({ reason: expect.stringContaining("LEAD_STAGE_INTERNAL_RECIPIENTS") });
  });

  it("is switchable off per stage, and says so", () => {
    const p = policy({ LEAD_STAGE_INTERNAL_STAGES: "2,3" });
    expect(decideInternal(lead(), 1, p, NOW)).toMatchObject({
      verdict: "skip",
      reason: expect.stringContaining("stage 1"),
    });
  });
});

describe("applicantAlreadyEmailed", () => {
  it("reads the workflow's own receipt at the two stages that leave one", () => {
    expect(applicantAlreadyEmailed(lead({ stage1_email_message_id: "AAMk..." }), 1)).toBe(true);
    expect(applicantAlreadyEmailed(lead(), 1)).toBe(false);
    expect(applicantAlreadyEmailed(lead({ stage3_confirmation_sent_at: hoursAgo(1) }), 3)).toBe(
      true,
    );
    expect(applicantAlreadyEmailed(lead(), 3)).toBe(false);
  });

  it("answers `null` at Stage 2, because the scenario writes no receipt", () => {
    // Not `false`. Collapsing "we cannot tell" into "nobody sent" is what
    // produces two `Questionnaire Received` emails four minutes apart.
    expect(applicantAlreadyEmailed(lead({ stage2_completed_at: hoursAgo(1) }), 2)).toBeNull();
  });
});

describe("decideApplicant — the backstop", () => {
  const settled = policy({ LEAD_STAGE_APPLICANT_GRACE_MINUTES: "45" });

  it("does not send when the workflow's receipt says it already did", () => {
    const l = lead({ created_at: hoursAgo(3), submitted_at: hoursAgo(3), stage1_email_message_id: "AAMk..." });
    expect(decideApplicant(l, 1, settled, NOW)).toMatchObject({
      verdict: "skip",
      reason: expect.stringContaining("already emailed"),
    });
  });

  it("sends once the grace period is up and no receipt exists", () => {
    const l = lead({ created_at: hoursAgo(3), submitted_at: hoursAgo(3) });
    expect(decideApplicant(l, 1, settled, NOW)).toEqual({ verdict: "send" });
  });

  it("waits out the grace period before overtaking a delivery still in flight", () => {
    const l = lead({ created_at: minutesAgo(5), submitted_at: minutesAgo(5) });
    expect(decideApplicant(l, 1, settled, NOW)).toMatchObject({
      verdict: "skip",
      reason: expect.stringContaining("waiting"),
    });
  });

  it("will not guess at Stage 2, and names the switch that settles it", () => {
    const l = lead({ stage2_completed_at: hoursAgo(5) });
    const decision = decideApplicant(l, 2, settled, NOW);
    expect(decision).toMatchObject({
      verdict: "skip",
      reason: expect.stringContaining("LEAD_STAGE_APPLICANT_MODE=always"),
    });
  });

  it("sends at Stage 2 once an operator has taken ownership of it", () => {
    const p = policy({ LEAD_STAGE_APPLICANT_MODE: "always" });
    const l = lead({ stage2_completed_at: minutesAgo(1) });
    // `always` does not wait: it is not a backstop, it is the owner.
    expect(decideApplicant(l, 2, p, NOW)).toEqual({ verdict: "send" });
  });

  it("is switchable off entirely", () => {
    const p = policy({ LEAD_STAGE_APPLICANT_MODE: "off" });
    const l = lead({ created_at: hoursAgo(3), submitted_at: hoursAgo(3) });
    expect(decideApplicant(l, 1, p, NOW)).toMatchObject({ verdict: "skip" });
  });

  it("raises nothing for an applicant with no address", () => {
    expect(decideApplicant(lead({ email: null }), 1, settled, NOW)).toMatchObject({
      verdict: "none",
    });
  });

  it("never reaches back past the window, whatever the mode", () => {
    const ancient = lead({ created_at: hoursAgo(500), submitted_at: hoursAgo(500) });
    const p = policy({ LEAD_STAGE_APPLICANT_MODE: "always" });
    expect(decideApplicant(ancient, 1, p, NOW)).toMatchObject({ verdict: "none" });
  });
});

describe("nextStepUrlFor", () => {
  it("offers no button when the destination is not configured", () => {
    expect(nextStepUrlFor(1, policy())).toBeNull();
    expect(nextStepUrlFor(2, policy())).toBeNull();
  });

  it("points each stage at its own next step", () => {
    const p = policy({
      AURIXA_QUESTIONNAIRE_URL: "https://aurixasystems.com.au/questionnaire",
      AURIXA_REVIEW_BOOKING_URL: "https://aurixasystems.com.au/schedule-strategic-review",
    });
    expect(nextStepUrlFor(1, p)).toContain("/questionnaire");
    expect(nextStepUrlFor(2, p)).toContain("/schedule-strategic-review");
    // Stage 3 is the end of the funnel — there is nothing to click.
    expect(nextStepUrlFor(3, p)).toBeNull();
  });
});
