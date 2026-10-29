// The send gates, condition by condition against the Airtable formulas they
// recreate. Each formula is quoted as the 2026-08-18 export of base
// `apptyShYE0yzL4IGB` holds it (field ids resolved to names), so a later reader
// can check the port without the export.
import { describe, expect, it } from "vitest";
import {
  GATE_RULES,
  applicationReceivedGate,
  bookingConfirmationGate,
  countsAsBooked,
  heldReason,
  isDeclined,
  reviewInvitationGate,
  sendGate,
  type GateSubject,
} from "./leadEmailGates.pure";

const APPLIED: GateSubject = {
  email: "ada@example.test",
  application_id: "AX-7Q2M4L9XZ1",
  status: "new",
  airtable_status: null,
};
const QUESTIONNAIRE_IN: GateSubject = {
  ...APPLIED,
  stage2_completed_at: "2026-10-29T01:00:00.000Z",
};
const BOOKED: GateSubject = {
  ...QUESTIONNAIRE_IN,
  stage3_booked_at: "2026-10-29T02:00:00.000Z",
  stage3_session_start: "2026-11-03T02:00:00.000Z",
  stage3_status: "Requested",
};

describe("Stage 1 — Send Stage 2 Invite", () => {
  // IF(OR({Stage 2 Reached} = 1, {Status} = "Declined", {Application ID} = BLANK(),
  //       {Corporate Email} = BLANK()), "HOLD", "SEND")
  it("sends for an application with a reference and an email", () => {
    expect(applicationReceivedGate(APPLIED)).toEqual({ send: true });
  });

  it("holds, with Airtable's reasons, in Airtable's order", () => {
    expect(applicationReceivedGate(QUESTIONNAIRE_IN)).toEqual({
      send: false,
      reason: "Applicant already reached Stage 2",
    });
    expect(applicationReceivedGate({ ...APPLIED, status: "disqualified" })).toEqual({
      send: false,
      reason: "Application declined",
    });
    expect(applicationReceivedGate({ ...APPLIED, application_id: "  " })).toEqual({
      send: false,
      reason: "No Application ID on the record",
    });
    expect(applicationReceivedGate({ ...APPLIED, email: null })).toEqual({
      send: false,
      reason: "No corporate email to send to",
    });
    // The first condition that holds is the reason, as the nested IFs give it.
    expect(
      applicationReceivedGate({ ...QUESTIONNAIRE_IN, status: "disqualified", email: null }),
    ).toMatchObject({ reason: "Applicant already reached Stage 2" });
  });
});

describe("Stage 2 — Send Stage 3 Invite", () => {
  // IF(OR({Stage 3 Reached} = 1, {Stage 2 Reached} != 1, {Status} = "Declined",
  //       {Application ID} = BLANK(), {Corporate Email} = BLANK(),
  //       {Stage 3 Invite Count} >= 3), "HOLD", "SEND")
  it("sends once the questionnaire is in", () => {
    expect(reviewInvitationGate(QUESTIONNAIRE_IN)).toEqual({ send: true });
  });

  it("holds, with Airtable's reasons, in Airtable's order", () => {
    expect(reviewInvitationGate(BOOKED)).toMatchObject({
      reason: "Applicant already booked a strategic review",
    });
    expect(reviewInvitationGate(APPLIED)).toMatchObject({
      reason: "Applicant has not reached Stage 2 yet",
    });
    expect(
      reviewInvitationGate({ ...QUESTIONNAIRE_IN, airtable_status: "Declined" }),
    ).toMatchObject({
      reason: "Application declined",
    });
    expect(reviewInvitationGate({ ...QUESTIONNAIRE_IN, application_id: null })).toMatchObject({
      reason: "No Application ID on the record",
    });
    expect(reviewInvitationGate({ ...QUESTIONNAIRE_IN, email: "" })).toMatchObject({
      reason: "No corporate email to send to",
    });
    expect(reviewInvitationGate({ ...QUESTIONNAIRE_IN, stage3_invite_count: 3 })).toMatchObject({
      reason: "Invitation limit reached",
    });
    expect(reviewInvitationGate({ ...QUESTIONNAIRE_IN, stage3_invite_count: 2 })).toEqual({
      send: true,
    });
  });

  it("does not count a cancelled, missed or untimed booking as booked", () => {
    // Counts As Booked: IF(OR({Booking Status} = "Cancelled", {Booking Status} = "No Show",
    //                         {Requested Start (UTC)} = BLANK()), 0, 1)
    expect(countsAsBooked(BOOKED)).toBe(true);
    expect(countsAsBooked({ ...BOOKED, stage3_status: "Cancelled" })).toBe(false);
    expect(countsAsBooked({ ...BOOKED, stage3_cancelled_at: "2026-10-29T03:00:00.000Z" })).toBe(
      false,
    );
    expect(countsAsBooked({ ...BOOKED, stage3_status: "No Show" })).toBe(false);
    expect(countsAsBooked({ ...BOOKED, stage3_session_start: null })).toBe(false);
    expect(reviewInvitationGate({ ...BOOKED, stage3_status: "Cancelled" })).toEqual({ send: true });
  });
});

describe("Stage 3 — Send Booking Confirmation", () => {
  // IF(OR({Confirmation Message ID} != BLANK(), {Booking Status} = "Cancelled",
  //       {Applicant Email} = BLANK(), {Requested Start (UTC)} = BLANK()), "HOLD", "SEND")
  it("sends for a booking with a time", () => {
    expect(bookingConfirmationGate(BOOKED)).toEqual({ send: true });
  });

  it("holds, with Airtable's reasons, in Airtable's order", () => {
    expect(
      bookingConfirmationGate({
        ...BOOKED,
        stage3_confirmation_sent_at: "2026-10-29T02:01:00.000Z",
      }),
    ).toMatchObject({ reason: "Confirmation already sent" });
    expect(bookingConfirmationGate({ ...BOOKED, stage3_status: "Cancelled" })).toMatchObject({
      reason: "Booking cancelled",
    });
    expect(
      bookingConfirmationGate({ ...BOOKED, stage3_cancelled_at: "2026-10-29T02:00:30.000Z" }),
    ).toMatchObject({ reason: "Booking cancelled" });
    expect(bookingConfirmationGate({ ...BOOKED, email: null })).toMatchObject({
      reason: "No applicant email to send to",
    });
    expect(bookingConfirmationGate({ ...BOOKED, stage3_session_start: null })).toMatchObject({
      reason: "No requested time on the booking",
    });
  });

  it("is not held by a decline — Airtable's booking gate never read it", () => {
    expect(bookingConfirmationGate({ ...BOOKED, status: "disqualified" })).toEqual({ send: true });
  });
});

describe("the shared pieces", () => {
  it("reads Declined from either Mission Control or Airtable", () => {
    expect(isDeclined({ status: "disqualified" })).toBe(true);
    expect(isDeclined({ airtable_status: "Declined" })).toBe(true);
    expect(isDeclined({ status: "qualified", airtable_status: "Invited" })).toBe(false);
  });

  it("routes each stage to its gate", () => {
    expect(sendGate(QUESTIONNAIRE_IN, 1)).toMatchObject({ send: false });
    expect(sendGate(QUESTIONNAIRE_IN, 2)).toEqual({ send: true });
    expect(sendGate(BOOKED, 3)).toEqual({ send: true });
  });

  it("lists, for the console, every reason each gate can give, in its order", () => {
    // One authority: the console's list is the reasons the gates return.
    expect(GATE_RULES[1].holds.map((h) => h.reason)).toEqual([
      "Applicant already reached Stage 2",
      "Application declined",
      "No Application ID on the record",
      "No corporate email to send to",
    ]);
    expect(GATE_RULES[2].holds).toHaveLength(6);
    expect(GATE_RULES[3].holds.map((h) => h.reason)).toEqual([
      "Confirmation already sent",
      "Booking cancelled",
      "No applicant email to send to",
      "No requested time on the booking",
    ]);
    expect(heldReason("Booking cancelled")).toBe("held by the send gate: Booking cancelled");
  });
});
