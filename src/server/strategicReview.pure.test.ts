// Who may book a strategic review, and which of their bookings is it. The
// access rule must be the live Make gate's rule exactly — the site shows the
// scheduler on that gate's word, and a Mission Control that disagreed would
// either refuse somebody the page just admitted or admit somebody it refused.
import { describe, expect, it } from "vitest";
import { readBooking, type CalcomBooking } from "./calcom.pure";
import {
  REVIEW_REFUSAL_STATUS,
  STAGE3_ACCESS_TABLES,
  accessFromAirtable,
  accessFromMirror,
  applicantsReview,
  bookingView,
  formulaSafeReference,
  isApplicantsReview,
  stageThreeAccessFormulas,
  type MirroredLead,
} from "./strategicReview.pure";

const REF = "AX-7Q2M4L9XZ1";

describe("the access formulas", () => {
  it("are the live gate's, character for character", () => {
    // Make scenario 9602082, modules 2 and 3.
    expect(stageThreeAccessFormulas(REF)).toEqual({
      waitlist:
        "AND({Application ID Key} = 'AX-7Q2M4L9XZ1', {Stage 3 Access (Application)} = 'GRANT')",
      readiness: "UPPER(TRIM({Application ID})) = 'AX-7Q2M4L9XZ1'",
    });
    expect(STAGE3_ACCESS_TABLES).toEqual({
      waitlist: "tblHzGiB591W3GpoZ",
      readiness: "tblB1t18q6aUTNI0g",
    });
  });

  it("cannot be broken out of", () => {
    // The gate's own cleaning: anything but A-Z, 0-9 and a hyphen is dropped,
    // so a quote — and with it an injected clause — cannot survive.
    expect(formulaSafeReference("ax-7q2m')OR(TRUE()")).toBe("AX-7Q2MORTRUE");
    const formulas = stageThreeAccessFormulas("x' , TRUE()) OR ('");
    expect(formulas.waitlist.match(/'/g)).toHaveLength(4);
    expect(formulas.readiness.match(/'/g)).toHaveLength(2);
  });
});

const waitlistRecord = {
  id: "rec1",
  createdTime: "2026-09-01T00:00:00.000Z",
  fields: {
    "Application ID Key": REF,
    "First Name": "Jane",
    "Last Name": "Citizen",
    "Corporate Email": "Jane@Citizen.com.au",
    "Entity Name": "Citizen Property Group",
  },
};
const readinessRecord = { id: "rec2", createdTime: "2026-09-02T00:00:00.000Z", fields: {} };

describe("accessFromAirtable", () => {
  it("grants only when both records exist, as the live gate does", () => {
    expect(accessFromAirtable(REF, [waitlistRecord], [readinessRecord])).toEqual({
      granted: true,
      source: "airtable",
      applicant: {
        applicationId: REF,
        firstName: "Jane",
        lastName: "Citizen",
        email: "jane@citizen.com.au",
        organisation: "Citizen Property Group",
      },
    });
    expect(accessFromAirtable(REF, [waitlistRecord], [])).toEqual({
      granted: false,
      source: "airtable",
    });
    expect(accessFromAirtable(REF, [], [readinessRecord])).toEqual({
      granted: false,
      source: "airtable",
    });
  });

  it("tolerates a lookup field that arrives as a list", () => {
    const verdict = accessFromAirtable(
      REF,
      [
        {
          ...waitlistRecord,
          fields: { ...waitlistRecord.fields, "Entity Name": ["Citizen Pty Ltd"] },
        },
      ],
      [readinessRecord],
    );
    expect(verdict.granted && verdict.applicant.organisation).toBe("Citizen Pty Ltd");
  });
});

describe("accessFromMirror", () => {
  const lead: MirroredLead = {
    application_id: REF,
    first_name: "Jane",
    last_name: "Citizen",
    email: "jane@citizen.com.au",
    entity_name: null,
    stage3_access_state: "GRANT",
    stage2_completed_at: "2026-09-02T00:00:00.000Z",
    stage2_airtable_record_id: null,
  };

  it("grants on the same two facts", () => {
    expect(accessFromMirror(REF, [lead]).granted).toBe(true);
    expect(
      accessFromMirror(REF, [
        { ...lead, stage2_completed_at: null, stage2_airtable_record_id: "recX" },
      ]).granted,
    ).toBe(true);
  });

  it("never admits somebody Airtable never granted", () => {
    expect(accessFromMirror(REF, [{ ...lead, stage3_access_state: null }]).granted).toBe(false);
    expect(accessFromMirror(REF, [{ ...lead, stage3_access_state: "DENY" }]).granted).toBe(false);
    expect(accessFromMirror(REF, [{ ...lead, stage2_completed_at: null }]).granted).toBe(false);
    expect(accessFromMirror(REF, [{ ...lead, application_id: "AX-0000000000" }]).granted).toBe(
      false,
    );
    expect(accessFromMirror(REF, []).granted).toBe(false);
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
