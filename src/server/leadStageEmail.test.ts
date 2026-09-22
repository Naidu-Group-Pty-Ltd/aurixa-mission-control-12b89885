import { describe, expect, it } from "vitest";
import { auDateTime, composeStageEmail, type StageEmailLead } from "./leadStageEmail.pure";

const CONSOLE = "https://mission-control.aurixasystems.com.au";

const lead: StageEmailLead = {
  application_id: "AX-C94B1D8EC9",
  first_name: "Rugesh",
  last_name: "Naidu",
  email: "rugesh@npcservices.com.au",
  mobile_number: "+61400000000",
  entity_name: "Naidu Property Consulting Services",
  entity_classification: "property_advisory",
  transaction_volume: "26_to_75",
  role: "Chief Executive Officer",
  primary_areas: ["disconnected_systems", "document_management"],
  tech_stack_bottlenecks: "Three systems, none of which talk.",
  source: "AURIXA Contact Waitlist Page",
  page: "/contact",
  submitted_at: "2026-09-22T00:10:00.000Z",
  utm_source: "linkedin",
  marketing_consent: true,
  stage2_completed_at: "2026-09-22T01:00:00.000Z",
  stage2_next_step: "Strategic review",
  stage2_investment: "$2,000 - $3,000 per month",
  stage2_timeline: "Within 90 days",
  stage2_user_count: "11 - 25",
  stage2_capabilities: ["AI Voice Agents & Call Logging", "Document automation"],
  stage2_problems: ["Disconnected systems"],
  stage2_difficult_workflow: "Chasing documents from three parties at once.",
  stage3_booked_at: "2026-09-22T02:00:00.000Z",
  stage3_session_start: "2026-09-29T01:00:00.000Z",
  stage3_host_local_time: "29 Sep 2026, 11:00 am",
  stage3_local_time: "29 Sep 2026, 9:00 am",
  stage3_time_zone: "Australia/Perth",
  stage3_duration_minutes: 45,
  stage3_notes: "Finance portal first.",
};

const internal = (stage: 1 | 2 | 3, over: Partial<StageEmailLead> = {}) =>
  composeStageEmail({
    lead: { ...lead, ...over },
    stage,
    audience: "internal",
    consoleUrl: CONSOLE,
  });

const applicant = (stage: 1 | 2 | 3, next?: string | null) =>
  composeStageEmail({
    lead,
    stage,
    audience: "applicant",
    consoleUrl: CONSOLE,
    nextStepUrl: next,
  });

/**
 * A verdict, written as the forms in which one is ASSERTED.
 *
 * The first version of this guard scanned for the bare words — `score`,
 * `grade`, `rating` — and failed on the email's own closing sentence, which
 * says Mission Control "has not scored, ranked or interpreted them". A
 * sentence forbidding a verdict is the guarantee working, and rewording it to
 * satisfy a regex would have deleted the guarantee to keep the guard. So the
 * guard matches a verdict where it is CLAIMED: a label carrying a value, a
 * verb carrying one, a mark out of a total, or fit stated as an adjective.
 */
const VERDICT_FORMS = [
  ["a labelled verdict", /\b(score|grade|rating|priority|fit|tier|band)\b\s*[:=]/i],
  [
    "a verdict asserted by verb",
    /\b(scored|graded|rated|ranked)\s+(?:at\s+)?(?:\d|an?\b|high|low|strong|weak|poor)/i,
  ],
  ["a mark out of a total", /\b\d{1,3}\s*(?:\/\s*\d{1,3}\b|out of\s+\d{1,3}\b)/i],
  [
    "fit stated as an adjective",
    /\b(strong|good|poor|weak|excellent|high|low)[\s-]+(fit|quality|priority|potential)\b/i,
  ],
  [
    "a qualification claim",
    /\b(qualified|unqualified|hot|cold|warm)\s+(lead|prospect|applicant)\b/i,
  ],
  ["a tier or class", /\b(tier|class)\s+[a-z0-9]\b/i],
] as const;

const verdictIn = (body: string): string | null =>
  VERDICT_FORMS.find(([, pattern]) => pattern.test(body))?.[0] ?? null;

/** What the HTML READS as. A tag and an attribute are not the message. */
const visibleText = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("internal stage email", () => {
  it("names the applicant and the stage in the subject, so an inbox sorts", () => {
    expect(internal(1).subject).toBe(
      "[Aurixa] New application — Rugesh Naidu — Naidu Property Consulting Services",
    );
    expect(internal(2).subject).toContain("Questionnaire complete");
    expect(internal(3).subject).toContain("Review booked");
  });

  it("carries the whole Stage 2 answer set at Stage 2 — this is the qualification", () => {
    const { html, text } = internal(2);
    for (const expected of [
      "Strategic review",
      "$2,000 - $3,000 per month",
      "Within 90 days",
      "11 - 25",
      "AI Voice Agents &amp; Call Logging",
    ]) {
      expect(html).toContain(expected);
    }
    expect(text).toContain("Chasing documents from three parties at once.");
  });

  it("carries the questionnaire forward into the Stage 3 email", () => {
    // A review is the first conversation; arriving at it without having read
    // what they told you is the failure the funnel exists to prevent.
    const { text } = internal(3);
    expect(text).toContain("From their questionnaire");
    expect(text).toContain("$2,000 - $3,000 per month");
  });

  it("states the session in Aurixa's own time zone, named", () => {
    expect(internal(3).text).toContain("29 Sep 2026, 11:00 am");
  });

  it("deep-links the console at the applicant's own reference", () => {
    expect(internal(1).html).toContain(`${CONSOLE}/leads?q=AX-C94B1D8EC9`);
  });

  it("omits a row the record has nothing for, rather than printing a dash", () => {
    const thin = internal(1, {
      mobile_number: null,
      entity_name: null,
      tech_stack_bottlenecks: null,
      utm_source: null,
      transaction_volume: null,
    });
    expect(thin.text).not.toContain("Mobile");
    expect(thin.text).not.toContain("N/A");
    expect(thin.text).not.toMatch(/:\s*—/);
    expect(thin.html).not.toContain("N/A");
  });

  it("states no verdict about the applicant, at any stage", () => {
    // The funnel collects the applicant's answers. An opinion about them is
    // `crm.fit`'s, with its own evidence — an email that arrives carrying one
    // is a verdict nobody can defend.
    for (const stage of [1, 2, 3] as const) {
      const { subject, text, html } = internal(stage);
      expect(verdictIn(`${subject}\n${text}`)).toBeNull();
      expect(verdictIn(visibleText(html))).toBeNull();
    }
  });

  it("keeps the sentence that DISCLAIMS a verdict, which the guard must not read as one", () => {
    // The email closes by saying Mission Control has not scored or ranked the
    // answers. That sentence IS the guarantee, so a guard that fails on it is
    // one answered by deleting the guarantee to keep the guard.
    expect(internal(2).text).toContain("has not scored, ranked or interpreted");
    expect(verdictIn(internal(2).text)).toBeNull();
  });

  it("the guard is not vacuous — it fires on a verdict actually asserted", () => {
    for (const planted of [
      "Fit score: 82",
      "Overall grade: B+",
      "Scored 74 against the qualification model",
      "This one rates 82/100 on readiness",
      "A strong fit for the Scale tier",
      "Qualified lead — book immediately",
      "Priority tier 1",
    ]) {
      expect(verdictIn(planted)).not.toBeNull();
    }
  });

  it("escapes the applicant's own text rather than trusting it", () => {
    const hostile = internal(1, {
      entity_name: '<script>alert("x")</script>',
      tech_stack_bottlenecks: "5 > 3 && 2 < 4",
    });
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&lt;script&gt;");
    expect(hostile.html).toContain("5 &gt; 3 &amp;&amp; 2 &lt; 4");
  });
});

describe("applicant stage email", () => {
  it("greets by first name and states the reference", () => {
    const { html, text } = applicant(1);
    expect(text).toContain("Hello Rugesh,");
    expect(html).toContain("AX-C94B1D8EC9");
  });

  it("draws a button only when there is somewhere to send them", () => {
    expect(applicant(1, "https://aurixasystems.com.au/questionnaire").html).toContain(
      "Open the questionnaire",
    );
    // A dead control is worse than no control: with no URL the email says the
    // link will follow rather than rendering a button that goes nowhere.
    const none = applicant(1, null);
    expect(none.html).not.toContain("Open the questionnaire");
    expect(none.text).toContain("will email you a secure link");
  });

  it("tells the applicant their own local time at Stage 3", () => {
    const { text } = applicant(3);
    expect(text).toContain("29 Sep 2026, 9:00 am");
    expect(text).toContain("Australia/Perth");
  });

  it("never shows an applicant anything internal", () => {
    for (const stage of [1, 2, 3] as const) {
      const body = applicant(stage).html;
      expect(body).not.toContain("mission-control");
      expect(body).not.toContain("Mission Control");
      expect(body).not.toContain("linkedin");
      expect(body).not.toContain("Marketing consent");
      expect(body).not.toContain("How they found us");
    }
  });

  it("does not quote their questionnaire answers back at them", () => {
    // The applicant wrote them; repeating the whole set reads as a transcript
    // and gives a partner-forwarded email more than it needs to carry.
    expect(applicant(2).text).not.toContain("Chasing documents");
    expect(applicant(2).text).not.toContain("$2,000 - $3,000 per month");
  });
});

describe("auDateTime", () => {
  it("formats in en-AU and Australia/Sydney, both stated explicitly", () => {
    // The AU_LOCALE defect: a formatter with no locale takes the reader's
    // machine, and an edge function has none.
    const formatted = auDateTime("2026-09-29T01:00:00.000Z");
    // `en-AU` medium renders September as "Sept" — that is the locale, not a bug.
    expect(formatted).toMatch(/29 Sept?\.? 2026/);
    expect(formatted).toMatch(/11:00/);
  });

  it("is null for an absent or unparseable instant, never `Invalid Date`", () => {
    expect(auDateTime(null)).toBeNull();
    expect(auDateTime("")).toBeNull();
    expect(auDateTime("not a date")).toBeNull();
  });
});
