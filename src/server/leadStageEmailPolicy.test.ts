import { describe, expect, it } from "vitest";
import { emailKey } from "@/lib/email/emailAddress.pure";
import {
  applicantAlreadyEmailed,
  decideApplicant,
  decideInternal,
  hasReachedStage,
  nextStepUrlFor,
  readPolicy,
  resolveInternalRecipients,
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

describe("resolveInternalRecipients — who the team notification reaches", () => {
  const MAILBOX = "hello@aurixasystems.com.au";

  it("trims a leading space, which is a LIVE defect in the automation this replaces", () => {
    // Measured in the deployed Airtable automation `wflM9vUhBoHb0ZE8r`: four of
    // its five recipients carry a leading space and only the first is clean.
    // If that automation does not trim, four people have never received a lead
    // alert and no surface anywhere says so. This mailer trims, and this test
    // is what stops the same defect arriving here through an env var somebody
    // pasted out of the same place.
    const resolved = resolveInternalRecipients(
      ["clean@x.com", " spaced@x.com", "  double@x.com", "trailing@x.com  "],
      MAILBOX,
    );
    expect(resolved.recipients).toEqual([
      "clean@x.com",
      "spaced@x.com",
      "double@x.com",
      "trailing@x.com",
    ]);
    expect(resolved.dropped).toEqual([]);
    expect(resolved.source).toBe("configured");
  });

  it("collapses the same address written two ways, rather than mailing it twice", () => {
    const resolved = resolveInternalRecipients(["Bob@X.com", "bob@x.com", "<bob@x.com>"], MAILBOX);
    expect(resolved.recipients).toEqual(["Bob@X.com"]);
    expect(resolved.dropped).toHaveLength(2);
    expect(resolved.dropped.every((d) => d.reason.includes("already listed"))).toBe(true);
  });

  it("drops what cannot be an address and NAMES it, rather than handing it to Graph", () => {
    // Measured: Graph refuses the WHOLE message for one bad recipient, so a
    // single typo in this variable silences the notification for everybody on
    // it. Dropping it here costs one visible note; passing it on costs the send.
    const resolved = resolveInternalRecipients(
      ["good@x.com", "Rugesh Naidu", "also-good@x.com", "broken@nodomain"],
      MAILBOX,
    );
    expect(resolved.recipients).toEqual(["good@x.com", "also-good@x.com"]);
    expect(resolved.dropped.map((d) => d.value)).toEqual(["Rugesh Naidu", "broken@nodomain"]);
  });

  it("admits nothing the suppression register cannot key", () => {
    // The register is asked `emailKey(address)`. Anything admitted here that
    // `emailKey` rejects is invisible to it and would be mailed however many
    // times somebody asked us to stop — so the two must be ONE reading, and
    // this asserts that rather than promising it.
    const hostile = ["ok@x.com", "trailing-slash@x.com\\", 'quote"@x.com', "sp ace@x.com"];
    const resolved = resolveInternalRecipients(hostile, MAILBOX);
    for (const address of resolved.recipients) {
      expect(emailKey(address)).not.toBeNull();
    }
    expect(resolved.recipients).toEqual(["ok@x.com"]);
  });

  it("names the fallback rather than letting five collapse to one silently", () => {
    const resolved = resolveInternalRecipients([], MAILBOX);
    expect(resolved.recipients).toEqual([MAILBOX]);
    expect(resolved.source).toBe("mailbox_fallback");
  });

  it("answers `none` when there is nobody at all, and never invents a recipient", () => {
    expect(resolveInternalRecipients([], null)).toMatchObject({ recipients: [], source: "none" });
    // A mailbox that is not an address is not a fallback either.
    expect(resolveInternalRecipients([], "not-a-mailbox")).toMatchObject({
      recipients: [],
      source: "none",
    });
  });

  it("is idempotent, because dispatch re-runs it over an already-resolved list", () => {
    const once = resolveInternalRecipients(["a@x.com", " b@x.com"], MAILBOX);
    const twice = resolveInternalRecipients(once.recipients, MAILBOX);
    expect(twice.recipients).toEqual(once.recipients);
    expect(twice.source).toBe("configured");
  });

  it("reads the display-name form a pasted Outlook contact arrives in", () => {
    // The recipient list is split on comma/semicolon/newline and NOT on
    // whitespace, because whitespace shreds this into three tokens and makes
    // `unwrapAddress` unreachable.
    const p = policy({
      LEAD_STAGE_INTERNAL_RECIPIENTS: "Rugesh Naidu <rugesh@x.com>, admin@x.com",
    });
    expect(p.internalRecipients).toEqual(["rugesh@x.com", "admin@x.com"]);
    expect(p.internalRecipientsDropped).toEqual([]);
  });

  it("carries the resolution onto the policy, so a ledger row can record it", () => {
    const configured = policy({ LEAD_STAGE_INTERNAL_RECIPIENTS: "a@x.com, Rugesh Naidu" });
    expect(configured.internalRecipientSource).toBe("configured");
    expect(configured.internalRecipientsDropped).toHaveLength(1);
    expect(configured.internalRecipients).toEqual(["a@x.com"]);
    expect(policy().internalRecipientSource).toBe("mailbox_fallback");
  });
});
