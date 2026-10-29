// Who may book a strategic review, and which of their bookings is it. The
// access rule is Airtable's `Stage 3 Access (Application)` gate, recreated over
// Mission Control's record: the site shows the scheduler on its word, and the
// booking endpoint asks it again, so the two can never disagree.
import { describe, expect, it } from "vitest";
import { readBooking, type CalcomBooking } from "./calcom.pure";
import {
  REVIEW_REFUSAL_STATUS,
  accessFromLead,
  applicantsReview,
  bookingView,
  isApplicantsReview,
  type AccessLead,
} from "./strategicReview.pure";

const REF = "AX-7Q2M4L9XZ1";

describe("accessFromLead — Airtable's Stage 3 Access, over Mission Control's record", () => {
  // IF(OR({Application ID} = BLANK(), {Status} = "Declined"), "DENY", "GRANT"),
  // and Make scenario 9602082 also required a Business Readiness response.
  const lead: AccessLead = {
    application_id: REF,
    first_name: "Jane",
    last_name: "Citizen",
    email: "Jane@Citizen.com.au",
    entity_name: "Citizen Property Group",
    status: "new",
    airtable_status: null,
    stage2_completed_at: "2026-09-02T00:00:00.000Z",
    stage2_airtable_record_id: null,
  };

  it("grants an application that is not declined and whose questionnaire is in", () => {
    expect(accessFromLead(REF, [lead])).toEqual({
      granted: true,
      source: "mission_control",
      applicant: {
        applicationId: REF,
        firstName: "Jane",
        lastName: "Citizen",
        email: "jane@citizen.com.au",
        organisation: "Citizen Property Group",
      },
    });
  });

  it("counts a questionnaire the mirror read from Airtable", () => {
    expect(
      accessFromLead(REF, [
        { ...lead, stage2_completed_at: null, stage2_airtable_record_id: "recReadiness" },
      ]).granted,
    ).toBe(true);
  });

  it("refuses a declined application, wherever it was declined", () => {
    expect(accessFromLead(REF, [{ ...lead, status: "disqualified" }]).granted).toBe(false);
    expect(accessFromLead(REF, [{ ...lead, airtable_status: "Declined" }]).granted).toBe(false);
  });

  it("refuses an applicant with no questionnaire, and a reference it does not hold", () => {
    expect(accessFromLead(REF, [{ ...lead, stage2_completed_at: null }]).granted).toBe(false);
    expect(accessFromLead(REF, [{ ...lead, application_id: "AX-0000000000" }]).granted).toBe(false);
    expect(accessFromLead(REF, [{ ...lead, application_id: null }]).granted).toBe(false);
    expect(accessFromLead(REF, []).granted).toBe(false);
  });

  it("reads the newest application a reference names", () => {
    const declinedLater = { ...lead, status: "disqualified" };
    expect(accessFromLead(REF, [declinedLater, lead]).granted).toBe(false);
  });
});

const booking = (over: Record<string, unknown>): CalcomBooking =>
  readBooking({
    uid: "bk",
    status: "accepted",
    start: "2026-10-01T23:00:00.000Z",
    end: "2026-10-01T23:30:00.000Z",
    eventType: { id: 1, slug: "strategic-review" },
    attendees: [{ email: "jane@citizen.com.au" }],
    metadata: {},
    ...over,
  })!;

describe("which booking is the applicant's review", () => {
  const emails = ["jane@citizen.com.au"];

  it("is proved by the reference this path writes", () => {
    const b = booking({
      eventType: { id: 9, slug: "guided-demonstration" },
      attendees: [{ email: "someone@else.com" }],
      metadata: { applicationId: REF },
    });
    expect(isApplicantsReview(b, REF, emails)).toBe(true);
  });

  it("includes a review the voice agent booked under their address", () => {
    expect(
      isApplicantsReview(
        booking({ metadata: { source: "voice_agent", kind: "strategic_review" } }),
        REF,
        emails,
      ),
    ).toBe(true);
  });

  it("excludes another kind of session, another person, and a dead booking", () => {
    expect(
      isApplicantsReview(
        booking({ eventType: { id: 9, slug: "guided-demonstration" } }),
        REF,
        emails,
      ),
    ).toBe(false);
    expect(
      isApplicantsReview(booking({ attendees: [{ email: "other@x.com" }] }), REF, emails),
    ).toBe(false);
    expect(isApplicantsReview(booking({ status: "cancelled" }), REF, emails)).toBe(false);
  });

  it("returns the earliest when there are several", () => {
    const later = booking({ uid: "later", start: "2026-10-09T23:00:00.000Z" });
    const sooner = booking({ uid: "sooner", start: "2026-10-02T23:00:00.000Z" });
    expect(applicantsReview([later, sooner], REF, ["JANE@citizen.com.au"])?.uid).toBe("sooner");
    expect(applicantsReview([], REF, emails)).toBeNull();
  });

  it("shows the page the booking and nothing else", () => {
    expect(
      bookingView(
        booking({ meetingUrl: "https://app.cal.com/video/bk", metadata: { applicationId: REF } }),
      ),
    ).toEqual({
      uid: "bk",
      start: "2026-10-01T23:00:00.000Z",
      end: "2026-10-01T23:30:00.000Z",
      meetingUrl: "https://app.cal.com/video/bk",
    });
  });
});

describe("refusal statuses", () => {
  it("keep a refusal about the applicant apart from one about us", () => {
    expect(REVIEW_REFUSAL_STATUS.access_denied).toBe(403);
    expect(REVIEW_REFUSAL_STATUS.slot_unavailable).toBe(409);
    expect(REVIEW_REFUSAL_STATUS.already_booked).toBe(409);
    expect(REVIEW_REFUSAL_STATUS.access_unverifiable).toBe(503);
    expect(REVIEW_REFUSAL_STATUS.calendar_unavailable).toBe(503);
    expect(REVIEW_REFUSAL_STATUS.not_configured).toBe(503);
  });
});
