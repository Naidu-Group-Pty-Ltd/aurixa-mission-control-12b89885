import { describe, expect, it } from "vitest";
import {
  FIELDS,
  preferredBooking,
  readStage2,
  readStage3,
  summariseStage2,
  type AirtableRecord,
  type Stage3Enrichment,
} from "./airtableLeadMapping.pure";
import { cleanLeadText, LEAD_MAX_TEXT_LENGTH } from "./lead-capture.server";

const clean = cleanLeadText;
const LONG = LEAD_MAX_TEXT_LENGTH;

/**
 * A `BRQ Detailed Responses` row in the shape the connector gateway returns
 * it: single selects as `{id, name}`, multi-selects as arrays of the same,
 * checkboxes present only when ticked.
 */
const brqRecord: AirtableRecord = {
  id: "recBRQ0000000001",
  createdTime: "2026-07-31T10:15:11.000Z",
  fields: {
    "Application ID": "AX-C94B1D8EC9",
    "Applicant Email": "Rugesh@NPCServices.com.au",
    "Submitted At": "2026-07-31T10:15:10.675Z",
    "Stage 2 Access Method": { id: "sel1", name: "Secure link (token)" },
    "Role (Corrected)": { id: "sel2", name: "Chief Executive Officer" },
    "Technology Purchase Authority": { id: "sel3", name: "I decide" },
    "Expected User Count": { id: "sel4", name: "11 - 25" },
    "Office/Entity Structure": { id: "sel5", name: "Single office" },
    "Operating Locations": [
      { id: "sel6", name: "New South Wales" },
      { id: "sel7", name: "Victoria" },
    ],
    "Current Systems Used": [{ id: "sel8", name: "Spreadsheets" }],
    "System Product Names (optional)": "Excel 365",
    "Top Operational Problems": [
      { id: "sel9", name: "Disconnected systems" },
      { id: "sel10", name: "Manual data entry" },
    ],
    "Weekly Admin Time": { id: "sel11", name: "10 - 20 hours" },
    "Workflow Causing Greatest Difficulty": "Chasing documents from three parties at once.",
    "Aurixa Capabilities Ranked (Top 5)": [
      { id: "sel12", name: "AI Voice Agents & Call Logging" },
      { id: "sel13", name: "Document automation" },
    ],
    "Systems to Integrate": [{ id: "sel14", name: "Existing Phone or VoIP System" }],
    "VoIP System Details": "3CX",
    "Data Migration Needed": { id: "sel15", name: "Yes - clients and documents" },
    "Approximate Records Migrated": 4200,
    "Documents Count Not Yet Known": true,
    "Implementation Start Preference": { id: "sel16", name: "Within 90 days" },
    "Security & Procurement Requirements": [{ id: "sel17", name: "MFA" }],
    "Next Step Preference": { id: "sel18", name: "Strategic review" },
    "Approved Investment Range": { id: "sel19", name: "$2,000 - $3,000 per month" },
    "Internal Project Sponsor Identified": { id: "sel20", name: "Yes" },
  },
};

describe("readStage2", () => {
  const mapped = readStage2(brqRecord, FIELDS.brq as never, clean, LONG);

  it("lifts the columns an operator filters on out of the answer blob", () => {
    expect(mapped).toMatchObject({
      stage2_user_count: "11 - 25",
      stage2_authority: "I decide",
      stage2_entity_structure: "Single office",
      stage2_admin_time: "10 - 20 hours",
      stage2_next_step: "Strategic review",
      stage2_investment: "$2,000 - $3,000 per month",
      stage2_timeline: "Within 90 days",
      stage2_access_mode: "Secure link (token)",
      stage2_completed_at: "2026-07-31T10:15:10.675Z",
      stage2_airtable_record_id: "recBRQ0000000001",
    });
  });

  it("unwraps every multi-select to a plain list", () => {
    expect(mapped.stage2_regions).toEqual(["New South Wales", "Victoria"]);
    expect(mapped.stage2_capabilities).toEqual([
      "AI Voice Agents & Call Logging",
      "Document automation",
    ]);
    expect(mapped.stage2_problems).toEqual(["Disconnected systems", "Manual data entry"]);
    expect(mapped.stage2_security).toEqual(["MFA"]);
  });

  it("keeps numbers and checkboxes, where zero and false both mean something", () => {
    expect(mapped.stage2_answers.migrationRecords).toBe(4200);
    expect(mapped.stage2_answers.migrationDocumentsNotKnown).toBe(true);
  });

  it("writes the answer set in the website's own key vocabulary", () => {
    // These are the keys `ReadinessSubmissionFields` uses on the browser path.
    // Both paths fill one column, so they have to agree or the same applicant
    // reads as two different people depending on which delivery arrived.
    expect(Object.keys(mapped.stage2_answers)).toEqual(
      expect.arrayContaining([
        "role",
        "authority",
        "userCount",
        "entityStructure",
        "adminTime",
        "difficultWorkflow",
        "phoneSystem",
        "migration",
        "timing",
        "nextStep",
        "investmentRange",
        "projectSponsor",
        "regions",
        "systems",
        "problems",
        "capabilities",
        "integrations",
        "security",
      ]),
    );
  });

  it("omits a question the record does not answer rather than writing a blank", () => {
    expect(mapped.stage2_answers).not.toHaveProperty("securityContext");
    expect(mapped.stage2_answers).not.toHaveProperty("customSystemName");
  });

  it("reads the older Business Readiness Responses shape through the same reader", () => {
    const legacy = readStage2(
      {
        id: "recLEGACY00000001",
        createdTime: "2026-07-01T00:00:00.000Z",
        fields: {
          "Application ID": "AX-0000000001",
          Role: "Director",
          "User Count": { id: "s", name: "2 - 10" },
          "Preferred Next Step": { id: "s", name: "Pricing" },
          "Budget Range": { id: "s", name: "Under $1,000" },
          "Submission Date": "2026-07-01",
          "Completion Status": { id: "s", name: "Complete" },
        },
      },
      FIELDS.legacyBrq as never,
      clean,
      LONG,
    );
    expect(legacy).toMatchObject({
      stage2_user_count: "2 - 10",
      stage2_next_step: "Pricing",
      stage2_investment: "Under $1,000",
      stage2_status: "Complete",
    });
    // A column the legacy table never had must not appear as an empty answer.
    expect(legacy.stage2_answers).not.toHaveProperty("projectSponsor");
  });
});

describe("summariseStage2", () => {
  it("renders a section only when the record answered something in it", () => {
    const summary = summariseStage2({ userCount: "11 - 25", capabilities: ["Voice"] });
    expect(summary).toContain("ORGANISATION");
    expect(summary).toContain("Users needing access: 11 - 25");
    expect(summary).toContain("WANTED");
    expect(summary).not.toContain("MIGRATION");
    expect(summary).not.toContain("SECURITY");
  });

  it("is null for an empty answer set rather than a page of headings", () => {
    expect(summariseStage2({})).toBeNull();
  });

  it("renders a boolean as a word, not as `true`", () => {
    const summary = summariseStage2({ migrationRecordsNotKnown: true });
    expect(summary).toContain("Record count not yet known: yes");
    expect(summary).not.toContain("true");
    expect(summariseStage2({ enterpriseSso: "Yes" })).toContain("Enterprise SSO required: Yes");
  });

  it("keeps an answer no section names, rather than dropping it silently", () => {
    // Measured before this changed: the section list named 34 keys while the
    // mapper writes 40, so `roleOther`, `authorityOther`,
    // `informationManagementOther` and `customSystemOwner` — the free-text box
    // an applicant types in when no option fitted — reached no summary, no
    // email and no page. They are named now; anything the vocabulary has not
    // caught up with lands in OTHER ANSWERS instead of disappearing.
    expect(summariseStage2({ roleOther: "Principal & licensee" })).toContain(
      "Role (in their words): Principal & licensee",
    );
    const future = summariseStage2({ someFieldAddedLater: "matters to them" });
    expect(future).toContain("OTHER ANSWERS");
    // Database vocabulary never reaches the operator.
    expect(future).toContain("Some field added later: matters to them");
    expect(future).not.toContain("someFieldAddedLater");
  });
});

describe("readStage3", () => {
  const booking = readStage3(
    {
      id: "recBOOK000000001",
      createdTime: "2026-07-31T10:16:41.000Z",
      fields: {
        "Application ID": "AX-C94B1D8EC9",
        "Booking Reference": "AX-C94B1D8EC9 · 6 Aug 11:00 am",
        "Requested Start (UTC)": "2026-08-06T01:00:00.000Z",
        "Requested End (UTC)": "2026-08-06T01:45:00.000Z",
        "Duration (Minutes)": 45,
        "Applicant Time Zone": "Australia/Perth",
        "Applicant Local Time": "6 Aug 2026, 9:00 am",
        "Aurixa Local Time": "6 Aug 2026, 11:00 am",
        "Context Notes": "Want to talk about the finance portal first.",
        "Booking Status": { id: "s", name: "Requested" },
        "Submitted At": "2026-07-31T10:16:41.000Z",
        "Confirmation Sent At": "2026-07-31T10:16:58.000Z",
      },
    },
    clean,
    LONG,
  );

  it("keeps the session in all three readings rather than re-deriving one", () => {
    expect(booking).toMatchObject({
      stage3_session_start: "2026-08-06T01:00:00.000Z",
      stage3_session_end: "2026-08-06T01:45:00.000Z",
      stage3_duration_minutes: 45,
      stage3_time_zone: "Australia/Perth",
      stage3_local_time: "6 Aug 2026, 9:00 am",
      stage3_host_local_time: "6 Aug 2026, 11:00 am",
    });
  });

  it("carries the applicant's own agenda and the confirmation receipt", () => {
    expect(booking.stage3_notes).toBe("Want to talk about the finance portal first.");
    expect(booking.stage3_confirmation_sent_at).toBe("2026-07-31T10:16:58.000Z");
  });
});

describe("preferredBooking", () => {
  const at = (start: string, status: string): Stage3Enrichment =>
    ({
      stage3_status: status,
      stage3_session_start: start,
      stage3_booked_at: start,
    }) as Stage3Enrichment;

  it("prefers a live booking over a cancelled one, whatever the times say", () => {
    const chosen = preferredBooking([
      at("2026-09-01T00:00:00.000Z", "Cancelled"),
      at("2026-08-01T00:00:00.000Z", "Requested"),
    ]);
    expect(chosen?.stage3_session_start).toBe("2026-08-01T00:00:00.000Z");
  });

  it("takes the latest of several live bookings — a reschedule supersedes", () => {
    const chosen = preferredBooking([
      at("2026-08-01T00:00:00.000Z", "Requested"),
      at("2026-08-20T00:00:00.000Z", "Confirmed"),
    ]);
    expect(chosen?.stage3_session_start).toBe("2026-08-20T00:00:00.000Z");
  });

  it("still answers when every booking is cancelled, rather than pretending there is none", () => {
    const chosen = preferredBooking([at("2026-08-01T00:00:00.000Z", "Cancelled")]);
    expect(chosen?.stage3_status).toBe("Cancelled");
  });

  it("is null when there are no bookings at all", () => {
    expect(preferredBooking([])).toBeNull();
  });
});
