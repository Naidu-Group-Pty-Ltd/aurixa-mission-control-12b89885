// What the Airtable automations told the team, and what must survive retiring
// them.
//
// Mission Control becomes the SOLE internal notifier, so anything the live
// automation carried and this email does not is a fact the team silently stops
// receiving. Nothing reports that — the automation is switched off by a person
// in a browser and no test anywhere would notice.
//
// The two live emails, measured from the exports in
// `npc-property-dashbord/docs/integrations/airtable/npc-emails/automations/`
// and resolved through that export's own `migration/id-references.json`, which
// crosswalks every `fld…` the templates reference to its column and table:
//
//   Stage 1  `wflM9vUhBoHb0ZE8r` "Aurixa Lead Capture"        DEPLOYED, FIRES
//            "New Lead Received" — 12 fields, all `Aurixa Waitlist`
//   Stage 2  `wflh1IWRe0okzxeTK` "Notify Aurixa Team…"        DEPLOYED, DOES
//            NOT FIRE (bound to `Business Readiness Responses`, while the live
//            Make scenario writes `BRQ Detailed Responses`)
//            "New Business Readiness Questionnaire Submitted" — 9 fields
//   Stage 3  nothing, anywhere.
//
// Stage 2 is included even though it does not fire: it is what somebody
// intended the team to receive, and it is the list to check against if that
// automation is ever repaired rather than retired.
import { describe, expect, it } from "vitest";
import { composeStageEmail, type StageEmailLead } from "./leadStageEmail.pure";

/**
 * A lead carrying a value in every field the two automations read, so an
 * omission shows up as an absent VALUE rather than as an absent label.
 */
const FULL: StageEmailLead = {
  application_id: "AX-PARITY0001",
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@analytical.example",
  mobile_number: "+61400111222",
  entity_name: "Analytical Engines Pty Ltd",
  entity_classification: "mortgage_broking",
  transaction_volume: "76_to_150",
  role: "Managing Director",
  primary_areas: ["disconnected_systems", "manual_data_entry"],
  tech_stack_bottlenecks: "Three systems, none of which talk.",
  additional_notes: "Prefer a morning session.",
  source: "AURIXA Contact Waitlist Page",
  page: "/contact",
  submitted_at: "2026-09-22T00:10:00.000Z",
  stage2_completed_at: "2026-09-22T01:00:00.000Z",
  stage2_next_step: "Strategic review",
  stage2_authority: "Sole decision maker",
  stage2_timeline: "Within 90 days",
  stage2_user_count: "11 - 25",
  stage2_problems: ["Disconnected systems", "Manual double entry"],
  stage2_capabilities: ["AI Voice Agents & Call Logging", "Document automation"],
};

const bodyOf = (stage: 1 | 2) => {
  const { subject, text } = composeStageEmail({
    lead: FULL,
    stage,
    audience: "internal",
    consoleUrl: "https://mission-control.aurixasystems.com.au",
  });
  return `${subject}\n${text}`;
};

/** [what the automation's own label called it, the value that must survive] */
const STAGE_1_FIELDS: [string, string][] = [
  ["First Name", "Ada"],
  ["Last Name", "Lovelace"],
  ["Role", "Managing Director"],
  ["Email", "ada@analytical.example"],
  ["Mobile Number", "+61400111222"],
  ["Company Name", "Analytical Engines Pty Ltd"],
  ["Company Type", "Mortgage broking"],
  ["Annual Income (Annual Transactional Value)", "76 to 150"],
  ["Technology Bottlenecks", "Three systems, none of which talk."],
  ["Operational Issues (Primary Areas to Improve)", "Disconnected systems"],
  ["Additional Notes", "Prefer a morning session."],
  ["Application ID", "AX-PARITY0001"],
];

const STAGE_2_FIELDS: [string, string][] = [
  ["Applicant Name", "Ada"],
  ["Organization", "Analytical Engines Pty Ltd"],
  ["Role", "Managing Director"],
  ["Decision Authority", "Sole decision maker"],
  ["Implementation Timeline", "Within 90 days"],
  ["User Count", "11 - 25"],
  ["Top Operational Problems", "Disconnected systems"],
  ["Required Capabilities", "AI Voice Agents & Call Logging"],
  ["Preferred Next Step", "Strategic review"],
];

describe("parity with the Airtable team notification this replaces", () => {
  it.each(STAGE_1_FIELDS)(
    "Stage 1 still carries what `New Lead Received` carried: %s",
    (_label, value) => {
      expect(bodyOf(1)).toContain(value);
    },
  );

  it.each(STAGE_2_FIELDS)(
    "Stage 2 still carries what the BRQ notification intended: %s",
    (_label, value) => {
      expect(bodyOf(2)).toContain(value);
    },
  );

  it("carries what the automations never could", () => {
    // Parity is the floor, not the ceiling. These are facts the Airtable
    // email had no way to reach — the attribution the website captured, and a
    // link straight to the record — and they are the reason the cutover is an
    // improvement rather than a lateral move.
    const body = bodyOf(1);
    for (const extra of [
      "AURIXA Contact Waitlist Page",
      "mission-control.aurixasystems.com.au/leads?q=AX-PARITY0001",
    ]) {
      expect(body).toContain(extra);
    }
  });

  it("prints the applicant's address exactly as the record holds it", () => {
    // Found by this parity check: `humanise` capitalised any value with no
    // capital and no space, which is true of `mortgage_broking` and equally
    // true of an email address — so every internal email at every stage
    // rendered `Ada@analytical.example`, and an operator copying it out got a
    // string that is not what the record holds. A humaniser turns database
    // vocabulary into words; it has no business in an identifier's slot.
    const body = bodyOf(1);
    expect(body).toContain("ada@analytical.example");
    expect(body).not.toContain("Ada@analytical.example");
  });

  it("still renders database vocabulary as words, which is why humanise exists", () => {
    const body = bodyOf(1);
    expect(body).toContain("Mortgage broking");
    expect(body).not.toContain("mortgage_broking");
  });

  it("covers Stage 3, which no automation has ever covered at all", () => {
    // The gap the cutover closes rather than preserves: a booked strategic
    // review told nobody.
    const { subject } = composeStageEmail({
      lead: { ...FULL, stage3_booked_at: "2026-09-22T02:00:00.000Z" },
      stage: 3,
      audience: "internal",
      consoleUrl: "https://mission-control.aurixasystems.com.au",
    });
    expect(subject).toContain("Review booked");
  });
});
