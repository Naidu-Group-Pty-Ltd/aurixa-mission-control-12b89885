import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_EMAIL_TEMPLATES,
  LEAD_STAGES,
  leadEmailContext,
  mergeFieldsFor,
  normaliseTemplate,
  renderInline,
  renderLeadEmail,
  renderUrl,
  sampleContext,
  templateProblems,
  templateWarnings,
  type LeadEmailTemplate,
} from "./leadEmailTemplates.pure";

const clone = (t: LeadEmailTemplate): LeadEmailTemplate => JSON.parse(JSON.stringify(t));

const LINKS = {
  siteUrl: "https://www.aurixasystems.com.au/",
  questionnaireUrl:
    "https://www.aurixasystems.com.au/questionnaire?ref=AX-7K2M9QX4TB&token=abcdefghijklmnopqrstuvwxyz012345&expires=2026-11-19T00%3A00%3A00.000Z",
  questionnaireExpiresAt: "2026-11-19T00:00:00.000Z",
  supportEmail: "admin@aurixasystems.com.au",
  trialDays: 14,
};

const LEAD = {
  application_id: "AX-7K2M9QX4TB",
  first_name: "Jordan",
  last_name: "Avery",
  email: "jordan@avery.example",
  entity_name: "Smith & Sons <Trading>",
  submitted_at: "2026-10-28T22:41:00.000Z",
  stage2_completed_at: "2026-10-28T23:00:00.000Z",
  stage3_booked_at: "2026-10-28T23:05:00.000Z",
  stage3_session_start: "2026-11-03T02:00:00.000Z",
  stage3_time_zone: "Australia/Perth",
  stage3_local_time: null,
  stage3_host_local_time: null,
  stage3_duration_minutes: 30,
  stage3_meeting_url: "https://app.cal.com/video/abc",
};

describe("the default templates", () => {
  it("are clean for every stage: no problems, no missing next-step link", () => {
    for (const stage of LEAD_STAGES) {
      expect(templateProblems(stage, DEFAULT_LEAD_EMAIL_TEMPLATES[stage])).toEqual([]);
      expect(templateWarnings(stage, DEFAULT_LEAD_EMAIL_TEMPLATES[stage])).toEqual([]);
    }
  });

  it("say free trial, never priority access or waitlist", () => {
    for (const stage of LEAD_STAGES) {
      const rendered = renderLeadEmail(DEFAULT_LEAD_EMAIL_TEMPLATES[stage], sampleContext(stage));
      const everything = `${rendered.subject}\n${rendered.html}\n${rendered.text}`;
      expect(everything).not.toMatch(/priority[ -]access|waitlist/i);
      expect(everything).toMatch(/free trial/i);
      // The stray `}}` Make appended after `</html>`.
      expect(rendered.html.trimEnd().endsWith("</html>")).toBe(true);
      expect(rendered.html).not.toContain("{{");
    }
  });

  it("Stage 1 carries the secure questionnaire link and the reference fallback", () => {
    const rendered = renderLeadEmail(
      DEFAULT_LEAD_EMAIL_TEMPLATES[1],
      leadEmailContext(LEAD, 1, LINKS),
    );
    expect(rendered.subject).toBe("Application received — your Aurixa Systems free trial");
    expect(rendered.html).toContain(
      'href="https://www.aurixasystems.com.au/questionnaire?ref=AX-7K2M9QX4TB&amp;token=abcdefghijklmnopqrstuvwxyz012345&amp;expires=2026-11-19T00%3A00%3A00.000Z"',
    );
    expect(rendered.html).toContain(
      'href="https://www.aurixasystems.com.au/questionnaire?ref=AX-7K2M9QX4TB"',
    );
    expect(rendered.html).toContain("Thursday 19 November 2026");
    // Make's "Update the email address" link pointed at nothing.
    expect(rendered.html).not.toContain("emailCorrectionUrl");
    expect(rendered.text).toContain("Reply to this email and we will correct it.");
  });

  it("Stage 2 and Stage 3 link to the scheduler with the reference", () => {
    for (const stage of [2, 3] as const) {
      const rendered = renderLeadEmail(
        DEFAULT_LEAD_EMAIL_TEMPLATES[stage],
        leadEmailContext(LEAD, stage, LINKS),
      );
      expect(rendered.html).toContain(
        'href="https://www.aurixasystems.com.au/schedule-strategic-review?ref=AX-7K2M9QX4TB"',
      );
      expect(rendered.html).toContain('href="mailto:admin@aurixasystems.com.au"');
    }
  });

  it("Stage 3 states the session in the applicant's zone and Sydney's, with the video link", () => {
    const rendered = renderLeadEmail(
      DEFAULT_LEAD_EMAIL_TEMPLATES[3],
      leadEmailContext(LEAD, 3, LINKS),
    );
    // 02:00 UTC is 10:00 in Perth and 13:00 in Sydney (AEDT) on 3 Nov 2026.
    expect(rendered.html).toMatch(/Tuesday 3 November 2026.{0,10}10:00/);
    expect(rendered.html).toMatch(/Tuesday 3 November 2026.{0,10}1:00/);
    expect(rendered.html).toContain("(Australia/Perth)");
    expect(rendered.html).toContain('href="https://app.cal.com/video/abc"');
  });

  it("leaves out the video button when a booking has no video link", () => {
    const rendered = renderLeadEmail(
      DEFAULT_LEAD_EMAIL_TEMPLATES[3],
      leadEmailContext({ ...LEAD, stage3_meeting_url: null }, 3, LINKS),
    );
    expect(rendered.html).not.toContain("Join The Session");
  });
});

describe("rendering", () => {
  it("escapes the applicant's own values, and the template's own words", () => {
    const rendered = renderLeadEmail(
      DEFAULT_LEAD_EMAIL_TEMPLATES[1],
      leadEmailContext(LEAD, 1, LINKS),
    );
    expect(rendered.html).toContain("Smith &amp; Sons &lt;Trading&gt;");
    expect(rendered.html).not.toContain("<Trading>");
    expect(renderInline("Tom & <b>Jerry</b>", {})).toBe("Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;");
  });

  it("reads **bold** from the template, never from a value", () => {
    expect(renderInline("Hello **{{name}}**", { name: "Ada" })).toBe(
      'Hello <strong style="color:#f4f8fc;">Ada</strong>',
    );
    expect(renderInline("Hello {{name}}", { name: "**Ada**" })).toBe("Hello **Ada**");
    expect(renderInline("an ** unmatched mark", {})).toBe("an ** unmatched mark");
  });

  it("tidies what an empty value leaves behind", () => {
    expect(renderInline("Thank you, {{first_name}}.", { first_name: "" })).toBe("Thank you.");
    expect(renderInline("At 9am ({{zone}})", { zone: "" })).toBe("At 9am");
  });

  it("uses a link field whole, and encodes a value merged into the middle of one", () => {
    expect(renderUrl("{{url}}", { url: "https://a.example/x?y=1" })).toBe(
      "https://a.example/x?y=1",
    );
    expect(renderUrl("https://a.example/q?ref={{ref}}", { ref: "A B&C" })).toBe(
      "https://a.example/q?ref=A%20B%26C",
    );
    expect(renderUrl("mailto:{{to}}", { to: "a@b.example" })).toBe("mailto:a@b.example");
  });

  it("refuses anything that is not a web or mail link", () => {
    expect(renderUrl("javascript:alert(1)", {})).toBe("");
    expect(renderUrl("{{url}}", { url: "javascript:alert(1)" })).toBe("");
    expect(renderUrl("{{url}}", { url: "" })).toBe("");
    expect(renderUrl("/relative", {})).toBe("");
  });

  it("leaves out a details row whose value is empty, rather than drawing it blank", () => {
    const template = clone(DEFAULT_LEAD_EMAIL_TEMPLATES[1]);
    template.content.details.rows.push({ label: "NOTHING HERE", value: "{{missing}}" });
    const rendered = renderLeadEmail(template, leadEmailContext(LEAD, 1, LINKS));
    expect(rendered.html).not.toContain("NOTHING HERE");
  });

  it("leaves out a whole section that is switched off", () => {
    const template = clone(DEFAULT_LEAD_EMAIL_TEMPLATES[1]);
    template.content.steps.enabled = false;
    template.content.card.enabled = false;
    const rendered = renderLeadEmail(template, leadEmailContext(LEAD, 1, LINKS));
    expect(rendered.html).not.toContain("WHAT HAPPENS NEXT");
    expect(rendered.html).not.toContain("YOUR NEXT STEP");
    expect(rendered.html).toContain("Your application is in.");
  });

  it("writes a text version with the links spelled out", () => {
    const rendered = renderLeadEmail(
      DEFAULT_LEAD_EMAIL_TEMPLATES[1],
      leadEmailContext(LEAD, 1, LINKS),
    );
    expect(rendered.text).toContain(
      `Complete Business Readiness Questionnaire: ${LINKS.questionnaireUrl}`,
    );
    expect(rendered.text).not.toContain("**");
  });
});

describe("checking a template", () => {
  it("names a merge field the stage cannot fill, and where it is", () => {
    const template = clone(DEFAULT_LEAD_EMAIL_TEMPLATES[2]);
    template.content.greeting = "Hi {{firstname}} — your link: {{questionnaire_url}}";
    const problems = templateProblems(2, template);
    expect(problems.join("\n")).toContain("{{firstname}}");
    // Stage 2 has no questionnaire link to give.
    expect(problems.join("\n")).toContain("{{questionnaire_url}}");
    expect(problems.join("\n")).toContain("Greeting");
  });

  it("refuses a link field that is not a link", () => {
    const template = clone(DEFAULT_LEAD_EMAIL_TEMPLATES[1]);
    template.content.primaryButton.url = "www.aurixasystems.com.au";
    expect(templateProblems(1, template).join("\n")).toContain("Primary button link is not a link");
  });

  it("refuses an empty subject, heading, message or compliance line", () => {
    const template = clone(DEFAULT_LEAD_EMAIL_TEMPLATES[3]);
    template.subject = " ";
    template.content.heading = "";
    template.content.paragraphs = "";
    template.content.footer.compliance = "";
    expect(templateProblems(3, template)).toHaveLength(4);
  });

  it("warns when the next step's link is missing, without refusing", () => {
    const template = clone(DEFAULT_LEAD_EMAIL_TEMPLATES[1]);
    template.content.primaryButton.url = "https://www.aurixasystems.com.au/questionnaire";
    template.content.secondaryButton.url = "https://www.aurixasystems.com.au/questionnaire";
    expect(templateProblems(1, template)).toEqual([]);
    expect(templateWarnings(1, template)).toHaveLength(1);
  });

  it("offers each stage only the fields it can fill", () => {
    const keys = (stage: 1 | 2 | 3) => mergeFieldsFor(stage).map((field) => field.key);
    expect(keys(1)).toContain("questionnaire_url");
    expect(keys(2)).not.toContain("questionnaire_url");
    expect(keys(3)).toContain("meeting_url");
    expect(keys(1)).not.toContain("booking_url");
  });
});

describe("normalising a stored template", () => {
  it("fills a section the stored row predates from the default", () => {
    const stored = { subject: "Edited", content: { heading: "Edited heading" } };
    const template = normaliseTemplate(1, stored);
    expect(template.subject).toBe("Edited");
    expect(template.content.heading).toBe("Edited heading");
    expect(template.content.card).toEqual(DEFAULT_LEAD_EMAIL_TEMPLATES[1].content.card);
  });

  it("keeps a list the editor emptied, rather than restoring the default", () => {
    const stored = clone(DEFAULT_LEAD_EMAIL_TEMPLATES[2]);
    stored.content.card.facts = [];
    expect(normaliseTemplate(2, stored).content.card.facts).toEqual([]);
  });

  it("drops what is not text and caps what is too long", () => {
    const template = normaliseTemplate(1, {
      subject: 42,
      content: { heading: "x".repeat(5000), card: { facts: [{ label: 1, value: null }] } },
    });
    expect(template.subject).toBe("");
    expect(template.content.heading.length).toBe(300);
    expect(template.content.card.facts).toEqual([{ label: "", value: "" }]);
  });

  it("round-trips a default unchanged", () => {
    for (const stage of LEAD_STAGES) {
      expect(normaliseTemplate(stage, DEFAULT_LEAD_EMAIL_TEMPLATES[stage])).toEqual(
        DEFAULT_LEAD_EMAIL_TEMPLATES[stage],
      );
    }
  });
});

describe("the applicant as merge values", () => {
  it("falls back to 'your organisation' and builds the links from the site's origin", () => {
    const context = leadEmailContext({ ...LEAD, entity_name: null }, 2, LINKS);
    expect(context.organisation).toBe("your organisation");
    expect(context.booking_url).toBe(
      "https://www.aurixasystems.com.au/schedule-strategic-review?ref=AX-7K2M9QX4TB",
    );
  });

  it("uses the deployment's own scheduler when it names one, keeping the reference", () => {
    const own = leadEmailContext(LEAD, 3, {
      ...LINKS,
      bookingUrl: "https://book.example/review?utm_source=email",
    });
    expect(own.booking_url).toBe("https://book.example/review?utm_source=email&ref=AX-7K2M9QX4TB");
    const noReference = leadEmailContext({ ...LEAD, application_id: null }, 2, LINKS);
    expect(noReference.booking_url).toBe(
      "https://www.aurixasystems.com.au/schedule-strategic-review",
    );
  });

  it("prefers the time the scheduler showed the applicant over one it computes", () => {
    const context = leadEmailContext(
      { ...LEAD, stage3_local_time: "Tue 3 Nov, 10:00 am (AWST)" },
      3,
      LINKS,
    );
    expect(context.review_local_time).toBe("Tue 3 Nov, 10:00 am (AWST)");
  });

  it("gives no link a reference it does not have", () => {
    const context = leadEmailContext({ ...LEAD, application_id: null }, 1, LINKS);
    expect(context.questionnaire_resume_url).toBe("https://www.aurixasystems.com.au/questionnaire");
  });
});
