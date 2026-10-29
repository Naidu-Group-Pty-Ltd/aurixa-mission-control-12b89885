// The free trial applicant's emails: what they say, and how they are drawn.
//
// Pure — no I/O, no clock but the one handed in — so the editor can render a
// live preview in the browser from the same code the dispatcher sends with.
//
// ## Where the copy came from
//
// Until 29 Oct 2026 these three emails were HTML inlined in Make.com scenarios
// 9389960 (module 19), 9590512 (module 3) and 9601915 (module 7). The layout
// below is that HTML, rebuilt as a function: the same tables, the same palette,
// the same Outlook-safe buttons. The defaults are that copy, with what was
// wrong in it fixed:
//
//   - "priority access" and "Waitlist" now say free trial;
//   - Stage 1's "Update the email address" pointed at an identifier nothing
//     defined, so it was a dead link; it now asks the applicant to reply;
//   - every template ended `</html>}}`, a stray `}}` after the document;
//   - merge values were spliced in without HTML escaping, so an organisation
//     called `Smith & Sons <Trading>` broke the paragraph it sat in;
//   - Stage 1's questionnaire link carried no reference, so the questionnaire
//     it opened did not know whose it was. Mission Control's link does
//     (`questionnaire_url`).
//
// ## How a template is written
//
// Every text field is plain text with `{{merge_fields}}`. Two marks only:
// `**bold**`, and a blank line between paragraphs in the message. Link fields
// take an `https://` or `mailto:` address, or a merge field that is one.
//
// **An element whose value comes out empty is left out**, never drawn blank: a
// details row with no value, a button with no link, a card with no title. That
// is what lets one template serve an applicant whose record holds less — a
// booking with no video link, a lead with no organisation.

import { escapeHtml, findTokens } from "@/lib/email/mergeTemplate.pure";

export type LeadStage = 1 | 2 | 3;
export const LEAD_STAGES: readonly LeadStage[] = [1, 2, 3];

export type EmailFact = { label: string; value: string };
export type EmailStep = { title: string; text: string };

export type LeadEmailContent = {
  /** The document's `<title>`. Some clients show it; nothing else does. */
  title: string;
  /** The inbox preview line. */
  preheader: string;
  /** The pill at the top right, e.g. APPLICATION RECEIVED. */
  badge: string;
  /** The small capitals above the heading. */
  eyebrow: string;
  heading: string;
  intro: string;
  greeting: string;
  /** Paragraphs, separated by a blank line. */
  paragraphs: string;
  card: {
    enabled: boolean;
    index: string;
    label: string;
    title: string;
    text: string;
    facts: EmailFact[];
  };
  primaryButton: { label: string; url: string };
  securityNote: {
    enabled: boolean;
    tagline: string;
    text: string;
    fallbackPrompt: string;
    fallbackLabel: string;
    fallbackUrl: string;
  };
  details: {
    enabled: boolean;
    label: string;
    title: string;
    rows: EmailFact[];
    notePrompt: string;
    noteLinkLabel: string;
    noteLinkUrl: string;
  };
  steps: { enabled: boolean; label: string; title: string; items: EmailStep[]; closing: string };
  secondaryButton: { enabled: boolean; prompt: string; label: string; url: string };
  footer: { tagline: string; badge: string; compliance: string };
};

export type LeadEmailTemplate = { subject: string; content: LeadEmailContent };

/** Who sends a stage's applicant email. */
export type LeadEmailSender = "make" | "mission_control";

export const STAGE_NAMES: Record<LeadStage, string> = {
  1: "Application received",
  2: "Questionnaire received",
  3: "Review confirmed",
};

/** What each stage's email is for, in one line, for the editor. */
export const STAGE_PURPOSE: Record<LeadStage, string> = {
  1: "Sent when the free trial application lands. Carries the secure questionnaire link.",
  2: "Sent when the Business Readiness Questionnaire is completed. Carries the strategic review link.",
  3: "Sent when the strategic review is booked. Confirms the time.",
};

/**
 * The Make modules that send each stage today, and how to stop them without
 * stopping what else the scenario does — it still writes the applicant to
 * Airtable. Read from the blueprints in the website repository
 * (docs/integrations/make/waitlist/). The console shows `steps` before a stage
 * is handed over.
 */
export const MAKE_EMAIL_MODULE: Record<
  LeadStage,
  { scenario: string; scenarioId: number; modules: string; steps: string[] }
> = {
  1: {
    scenario: "Aurixa Waitlist Stage 1",
    scenarioId: 9389960,
    modules: "19, 21 and 22",
    steps: [
      "Delete modules 19 and 21 (they create and send the email) and module 22 (it records that email in Airtable). Modules 1 to 6 stay: they still write the application to Airtable.",
    ],
  },
  2: {
    scenario: "Aurixa Waitlist Stage 2",
    scenarioId: 9590512,
    modules: "3 and 4",
    steps: [
      "Delete modules 3 and 4 (they create and send the email). Modules 1 and 2 stay: they still write the answers to Airtable.",
    ],
  },
  3: {
    scenario: "Aurixa Waitlist Stage 3",
    scenarioId: 9601915,
    modules: "7 and 8",
    steps: [
      "Delete modules 7 and 8 (they create and send the email) and connect module 4 straight to module 9, which marks the booking Confirmed in Airtable.",
      "On that new link, add the filter module 7 had: `Send Booking Confirmation` (from module 4) equal to SEND.",
      "In module 9, clear the Confirmation Message ID field — it read the deleted module 7.",
    ],
  },
};

// ── Merge fields ────────────────────────────────────────────────────────────

export type MergeField = {
  key: string;
  label: string;
  /** What the preview shows when it has no applicant to read. */
  sample: string;
  stages: readonly LeadStage[];
};

const ALL: readonly LeadStage[] = [1, 2, 3];

export const MERGE_FIELDS: readonly MergeField[] = [
  { key: "first_name", label: "Applicant's first name", sample: "Jordan", stages: ALL },
  { key: "last_name", label: "Applicant's last name", sample: "Avery", stages: ALL },
  { key: "full_name", label: "Applicant's full name", sample: "Jordan Avery", stages: ALL },
  {
    key: "organisation",
    label: 'Organisation ("your organisation" when none was given)',
    sample: "Avery Property Advisory",
    stages: ALL,
  },
  { key: "application_id", label: "Application reference", sample: "AX-7K2M9QX4TB", stages: ALL },
  {
    key: "work_email",
    label: "Applicant's work email",
    sample: "jordan@avery.example",
    stages: ALL,
  },
  {
    key: "support_email",
    label: "The address applicants write to (reply-to, else the sending mailbox)",
    sample: "admin@aurixasystems.com.au",
    stages: ALL,
  },
  {
    key: "trial_days",
    label: "The trial length in days (the applicant's trial offer, else the default)",
    sample: "14",
    stages: ALL,
  },
  {
    key: "questionnaire_url",
    label: "The applicant's secure questionnaire link",
    sample:
      "https://www.aurixasystems.com.au/questionnaire?ref=AX-7K2M9QX4TB&token=preview&expires=2026-11-19T00%3A00%3A00.000Z",
    stages: [1],
  },
  {
    key: "questionnaire_expires",
    label: "When the secure link stops working",
    sample: "Thursday 19 November 2026",
    stages: [1],
  },
  {
    key: "questionnaire_resume_url",
    label: "The questionnaire with the reference filled in (for an expired link)",
    sample: "https://www.aurixasystems.com.au/questionnaire?ref=AX-7K2M9QX4TB",
    stages: [1],
  },
  {
    key: "received_at",
    label: "When the application arrived",
    sample: "29 Oct 2026, 9:41 am",
    stages: [1],
  },
  {
    key: "booking_url",
    label: "The strategic review scheduler, with the reference",
    sample: "https://www.aurixasystems.com.au/schedule-strategic-review?ref=AX-7K2M9QX4TB",
    stages: [2, 3],
  },
  {
    key: "questionnaire_completed_at",
    label: "When the questionnaire was completed",
    sample: "29 Oct 2026, 9:55 am",
    stages: [2],
  },
  {
    key: "review_local_time",
    label: "The session time in the applicant's own time zone",
    sample: "Tuesday 3 November 2026, 10:00 am",
    stages: [3],
  },
  {
    key: "review_time_zone",
    label: "The applicant's time zone",
    sample: "Australia/Perth",
    stages: [3],
  },
  {
    key: "review_host_time",
    label: "The session time in Sydney",
    sample: "Tuesday 3 November 2026, 1:00 pm",
    stages: [3],
  },
  { key: "review_duration", label: "The session length in minutes", sample: "30", stages: [3] },
  {
    key: "meeting_url",
    label: "The video link (empty for a requested time)",
    sample: "https://app.cal.com/video/preview",
    stages: [3],
  },
  {
    key: "booked_at",
    label: "When the session was booked",
    sample: "29 Oct 2026, 10:02 am",
    stages: [3],
  },
];

export function mergeFieldsFor(stage: LeadStage): MergeField[] {
  return MERGE_FIELDS.filter((field) => field.stages.includes(stage));
}

export function sampleContext(stage: LeadStage): Record<string, string> {
  return Object.fromEntries(mergeFieldsFor(stage).map((field) => [field.key, field.sample]));
}

// ── Defaults ────────────────────────────────────────────────────────────────

const FOOTER = {
  tagline: "Structured intelligence for confident property decisions.",
  badge: "SECURE APPLICATION WORKFLOW",
  compliance:
    "This message was sent in connection with your Aurixa Systems free trial application. Please do not share secure application links with third parties.",
};

const PATHWAY =
  "**platform discovery session**, **guided demonstration** or **enterprise requirements consultation**";

export const DEFAULT_LEAD_EMAIL_TEMPLATES: Record<LeadStage, LeadEmailTemplate> = {
  1: {
    subject: "Application received — your Aurixa Systems free trial",
    content: {
      title: "Aurixa Systems — Free Trial Application Received",
      preheader:
        "Your Aurixa Systems free trial application has been received. Complete the secure Business Readiness Questionnaire to continue.",
      badge: "APPLICATION RECEIVED",
      eyebrow: "CONFIRMATION",
      heading: "Your application is in.",
      intro:
        "One focused questionnaire now gives our team the context required to recommend the right Aurixa pathway for your organisation.",
      greeting: "Thank you, {{first_name}}.",
      paragraphs: [
        "Your free trial application for **{{organisation}}** has been successfully received.",
        "The next step is to complete our **Business Readiness Questionnaire**. It allows us to understand your workflows, technology environment and preferred Aurixa modules before your application is reviewed.",
        "Your free trial starts the day your workspace goes live.",
      ].join("\n\n"),
      card: {
        enabled: true,
        index: "01",
        label: "YOUR NEXT STEP",
        title: "Complete the readiness questionnaire",
        text: "A concise, secure assessment tailored to your organisation. Most applicants complete it in approximately 6–8 minutes.",
        facts: [
          { label: "DURATION", value: "6–8 minutes" },
          { label: "ACCESS", value: "Private & secure" },
          { label: "PURPOSE", value: "Tailored review" },
        ],
      },
      primaryButton: {
        label: "Complete Business Readiness Questionnaire",
        url: "{{questionnaire_url}}",
      },
      securityNote: {
        enabled: true,
        tagline: "SECURE • UNIQUE • TIME-LIMITED",
        text: "This link is unique to your application and stays open until {{questionnaire_expires}}. Please do not forward it.",
        fallbackPrompt: "Link expired, or opened on another device?",
        fallbackLabel: "Continue with your Application ID",
        fallbackUrl: "{{questionnaire_resume_url}}",
      },
      details: {
        enabled: true,
        label: "APPLICATION DETAILS",
        title: "Your submission record",
        rows: [
          { label: "APPLICATION ID", value: "{{application_id}}" },
          { label: "WORK EMAIL", value: "{{work_email}}" },
          { label: "REVIEW TIMEFRAME", value: "Within 2 business days of the questionnaire" },
        ],
        notePrompt: "Not the correct work email? Reply to this email and we will correct it.",
        noteLinkLabel: "",
        noteLinkUrl: "",
      },
      steps: {
        enabled: true,
        label: "WHAT HAPPENS NEXT",
        title: "A clear path from application to conversation",
        items: [
          { title: "Questionnaire", text: "Share your current operating context." },
          { title: "Assessment", text: "Our team reviews readiness and fit." },
          { title: "Recommendation", text: "We confirm the right next session." },
        ],
        closing: `Once completed, our team will assess your application and advise whether the appropriate next step is a ${PATHWAY}.`,
      },
      secondaryButton: {
        enabled: true,
        prompt: "Having trouble opening the primary button? Use the direct secure link below.",
        label: "Open Secure Questionnaire",
        url: "{{questionnaire_url}}",
      },
      footer: FOOTER,
    },
  },
  2: {
    subject: "Questionnaire Received — Aurixa Systems Strategic Review",
    content: {
      title: "Aurixa Systems — Business Readiness Questionnaire Received",
      preheader:
        "Your Business Readiness Questionnaire has been received. Choose a time for your Aurixa strategic review to continue.",
      badge: "QUESTIONNAIRE RECEIVED",
      eyebrow: "CONFIRMATION",
      heading: "Your assessment is complete.",
      intro:
        "Your responses are with our team. The final step is to choose a time for the strategic review that closes out your application.",
      greeting: "Thank you, {{first_name}}.",
      paragraphs: [
        "Your Business Readiness Questionnaire for **{{organisation}}** has been received in full.",
        "The next step is to schedule your strategic review. Booking now gives our team time to prepare against your responses and bring specific recommendations to the session.",
      ].join("\n\n"),
      card: {
        enabled: true,
        index: "03",
        label: "YOUR NEXT STEP",
        title: "Schedule your strategic review",
        text: "A focused session with the Aurixa team at a time you choose. Live availability, shown in your own time zone.",
        facts: [
          { label: "DURATION", value: "30 minutes" },
          { label: "FORMAT", value: "Private session" },
          { label: "PURPOSE", value: "Tailored recommendation" },
        ],
      },
      primaryButton: { label: "Book Your Strategic Review", url: "{{booking_url}}" },
      securityNote: {
        enabled: true,
        tagline: "SECURE • PERSONALISED • LIVE AVAILABILITY",
        text: "This link carries your application reference so the session is matched to your submission. Please do not forward it.",
        fallbackPrompt: "Opening this on another device?",
        fallbackLabel: "Continue with your Application ID",
        fallbackUrl: "{{booking_url}}",
      },
      details: {
        enabled: true,
        label: "APPLICATION DETAILS",
        title: "Your submission record",
        rows: [
          { label: "APPLICATION ID", value: "{{application_id}}" },
          { label: "WORK EMAIL", value: "{{work_email}}" },
          { label: "BOOKING WINDOW", value: "Next 45 days" },
        ],
        notePrompt: "Need to correct something in your responses?",
        noteLinkLabel: "Contact the Aurixa team",
        noteLinkUrl: "mailto:{{support_email}}",
      },
      steps: {
        enabled: true,
        label: "WHAT HAPPENS NEXT",
        title: "A clear path from assessment to recommendation",
        items: [
          { title: "Strategic review", text: "A focused session at a time you choose." },
          { title: "Deep dive", text: "We work through your responses together." },
          { title: "Recommendation", text: "You receive a tailored Aurixa pathway." },
        ],
        closing: `Your responses are now recorded against your application. In the review we confirm whether the right pathway is a ${PATHWAY}.`,
      },
      secondaryButton: {
        enabled: true,
        prompt: "Having trouble opening the primary button? Use the direct booking link below.",
        label: "Open Booking Page",
        url: "{{booking_url}}",
      },
      footer: FOOTER,
    },
  },
  3: {
    subject: "Strategic Review Confirmed — Aurixa Systems",
    content: {
      title: "Aurixa Systems — Strategic Review Confirmed",
      preheader:
        "Your Aurixa strategic review is confirmed. The time, the reference and what to expect are all below.",
      badge: "REVIEW CONFIRMED",
      eyebrow: "CONFIRMATION",
      heading: "Your session is confirmed.",
      intro:
        "The final stage of your free trial application is booked. Everything you need for the session is below.",
      greeting: "Thank you, {{first_name}}.",
      paragraphs: [
        "Your strategic review for **{{organisation}}** is confirmed.",
        "We have you down for **{{review_local_time}}** in your own time zone. A calendar invitation with the meeting link follows separately.",
      ].join("\n\n"),
      card: {
        enabled: true,
        index: "03",
        label: "YOUR SESSION",
        title: "Your confirmed strategic review",
        text: "A focused session with the Aurixa team, working through the responses you gave at Stage 2 and the pathway that fits them.",
        facts: [
          { label: "DURATION", value: "{{review_duration}} minutes" },
          { label: "FORMAT", value: "Private session" },
          { label: "REFERENCE", value: "{{application_id}}" },
        ],
      },
      primaryButton: { label: "Change Or Rebook Your Session", url: "{{booking_url}}" },
      securityNote: {
        enabled: true,
        tagline: "SECURE • PERSONALISED • NO EXPIRY",
        text: "This link carries your application reference, so it opens your booking rather than a blank form. It does not expire. Please do not forward it.",
        fallbackPrompt: "Booking from another device?",
        fallbackLabel: "Continue with your Application ID",
        fallbackUrl: "{{booking_url}}",
      },
      details: {
        enabled: true,
        label: "SESSION DETAILS",
        title: "Your confirmed session",
        rows: [
          { label: "YOUR LOCAL TIME", value: "{{review_local_time}} ({{review_time_zone}})" },
          { label: "AURIXA TIME (SYDNEY)", value: "{{review_host_time}}" },
          { label: "APPLICATION ID", value: "{{application_id}}" },
        ],
        notePrompt: "Need a different time, or cannot make it?",
        noteLinkLabel: "Contact the Aurixa team",
        noteLinkUrl: "mailto:{{support_email}}",
      },
      steps: {
        enabled: true,
        label: "WHAT HAPPENS NEXT",
        title: "A clear path from booking to recommendation",
        items: [
          { title: "Calendar invite", text: "An invitation arrives with the meeting link." },
          { title: "The session", text: "We work through your responses together." },
          { title: "Recommendation", text: "You receive a tailored Aurixa pathway." },
        ],
        closing: `Your responses are already with the team preparing for this session. In the review we confirm whether the right pathway is a ${PATHWAY}.`,
      },
      secondaryButton: {
        enabled: true,
        prompt: "Your video link, for the day of the session.",
        label: "Join The Session",
        url: "{{meeting_url}}",
      },
      footer: FOOTER,
    },
  },
};

// ── Normalising what the database or the editor holds ──────────────────────

export const LIMITS = {
  subject: 200,
  short: 300,
  text: 2000,
  paragraphs: 6000,
  url: 1000,
  facts: 6,
  rows: 8,
  steps: 4,
} as const;

const str = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function facts(value: unknown, fallback: EmailFact[], max: number): EmailFact[] {
  if (!Array.isArray(value)) return fallback.map((fact) => ({ ...fact }));
  return value.slice(0, max).map((entry) => {
    const o = obj(entry);
    return { label: str(o.label, LIMITS.short), value: str(o.value, LIMITS.short) };
  });
}

function steps(value: unknown, fallback: EmailStep[]): EmailStep[] {
  if (!Array.isArray(value)) return fallback.map((step) => ({ ...step }));
  return value.slice(0, LIMITS.steps).map((entry) => {
    const o = obj(entry);
    return { title: str(o.title, LIMITS.short), text: str(o.text, LIMITS.text) };
  });
}

/**
 * A template in the full shape, whatever it was handed.
 *
 * A key the stored row does not have — one this file added after the row was
 * saved — takes the stage's default, so a template edited before a new section
 * existed still renders that section as it ships.
 */
export function normaliseTemplate(stage: LeadStage, raw: unknown): LeadEmailTemplate {
  const d = DEFAULT_LEAD_EMAIL_TEMPLATES[stage];
  const input = obj(raw);
  const c = obj(input.content);
  const has = (o: Record<string, unknown>, key: string) =>
    Object.prototype.hasOwnProperty.call(o, key);
  const text = (o: Record<string, unknown>, key: string, fallback: string, max: number) =>
    has(o, key) ? str(o[key], max) : fallback;

  const card = obj(c.card);
  const primary = obj(c.primaryButton);
  const note = obj(c.securityNote);
  const details = obj(c.details);
  const stepsIn = obj(c.steps);
  const secondary = obj(c.secondaryButton);
  const footer = obj(c.footer);
  const dc = d.content;

  return {
    subject: text(input, "subject", d.subject, LIMITS.subject),
    content: {
      title: text(c, "title", dc.title, LIMITS.short),
      preheader: text(c, "preheader", dc.preheader, LIMITS.short),
      badge: text(c, "badge", dc.badge, LIMITS.short),
      eyebrow: text(c, "eyebrow", dc.eyebrow, LIMITS.short),
      heading: text(c, "heading", dc.heading, LIMITS.short),
      intro: text(c, "intro", dc.intro, LIMITS.text),
      greeting: text(c, "greeting", dc.greeting, LIMITS.short),
      paragraphs: text(c, "paragraphs", dc.paragraphs, LIMITS.paragraphs),
      card: {
        enabled: bool(card.enabled, dc.card.enabled),
        index: text(card, "index", dc.card.index, 8),
        label: text(card, "label", dc.card.label, LIMITS.short),
        title: text(card, "title", dc.card.title, LIMITS.short),
        text: text(card, "text", dc.card.text, LIMITS.text),
        facts: has(card, "facts")
          ? facts(card.facts, [], LIMITS.facts)
          : facts(undefined, dc.card.facts, LIMITS.facts),
      },
      primaryButton: {
        label: text(primary, "label", dc.primaryButton.label, LIMITS.short),
        url: text(primary, "url", dc.primaryButton.url, LIMITS.url),
      },
      securityNote: {
        enabled: bool(note.enabled, dc.securityNote.enabled),
        tagline: text(note, "tagline", dc.securityNote.tagline, LIMITS.short),
        text: text(note, "text", dc.securityNote.text, LIMITS.text),
        fallbackPrompt: text(note, "fallbackPrompt", dc.securityNote.fallbackPrompt, LIMITS.short),
        fallbackLabel: text(note, "fallbackLabel", dc.securityNote.fallbackLabel, LIMITS.short),
        fallbackUrl: text(note, "fallbackUrl", dc.securityNote.fallbackUrl, LIMITS.url),
      },
      details: {
        enabled: bool(details.enabled, dc.details.enabled),
        label: text(details, "label", dc.details.label, LIMITS.short),
        title: text(details, "title", dc.details.title, LIMITS.short),
        rows: has(details, "rows")
          ? facts(details.rows, [], LIMITS.rows)
          : facts(undefined, dc.details.rows, LIMITS.rows),
        notePrompt: text(details, "notePrompt", dc.details.notePrompt, LIMITS.text),
        noteLinkLabel: text(details, "noteLinkLabel", dc.details.noteLinkLabel, LIMITS.short),
        noteLinkUrl: text(details, "noteLinkUrl", dc.details.noteLinkUrl, LIMITS.url),
      },
      steps: {
        enabled: bool(stepsIn.enabled, dc.steps.enabled),
        label: text(stepsIn, "label", dc.steps.label, LIMITS.short),
        title: text(stepsIn, "title", dc.steps.title, LIMITS.short),
        items: has(stepsIn, "items") ? steps(stepsIn.items, []) : steps(undefined, dc.steps.items),
        closing: text(stepsIn, "closing", dc.steps.closing, LIMITS.text),
      },
      secondaryButton: {
        enabled: bool(secondary.enabled, dc.secondaryButton.enabled),
        prompt: text(secondary, "prompt", dc.secondaryButton.prompt, LIMITS.text),
        label: text(secondary, "label", dc.secondaryButton.label, LIMITS.short),
        url: text(secondary, "url", dc.secondaryButton.url, LIMITS.url),
      },
      footer: {
        tagline: text(footer, "tagline", dc.footer.tagline, LIMITS.short),
        badge: text(footer, "badge", dc.footer.badge, LIMITS.short),
        compliance: text(footer, "compliance", dc.footer.compliance, LIMITS.text),
      },
    },
  };
}

export function templatesEqual(a: LeadEmailTemplate, b: LeadEmailTemplate): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Checking a template before it is saved ──────────────────────────────────

/** Every text field and every link field, with where it sits, for checking. */
function fieldsOf(template: LeadEmailTemplate): { where: string; value: string; link: boolean }[] {
  const c = template.content;
  const out: { where: string; value: string; link: boolean }[] = [
    { where: "Subject", value: template.subject, link: false },
    { where: "Preview line", value: c.preheader, link: false },
    { where: "Title", value: c.title, link: false },
    { where: "Badge", value: c.badge, link: false },
    { where: "Eyebrow", value: c.eyebrow, link: false },
    { where: "Heading", value: c.heading, link: false },
    { where: "Introduction", value: c.intro, link: false },
    { where: "Greeting", value: c.greeting, link: false },
    { where: "Message", value: c.paragraphs, link: false },
    { where: "Primary button", value: c.primaryButton.label, link: false },
    { where: "Primary button link", value: c.primaryButton.url, link: true },
    { where: "Footer", value: c.footer.tagline, link: false },
    { where: "Footer badge", value: c.footer.badge, link: false },
    { where: "Compliance line", value: c.footer.compliance, link: false },
  ];
  if (c.card.enabled) {
    out.push(
      { where: "Next-step card", value: c.card.index, link: false },
      { where: "Next-step card", value: c.card.label, link: false },
      { where: "Next-step card", value: c.card.title, link: false },
      { where: "Next-step card", value: c.card.text, link: false },
      ...c.card.facts.flatMap((fact) => [
        { where: "Next-step card fact", value: fact.label, link: false },
        { where: "Next-step card fact", value: fact.value, link: false },
      ]),
    );
  }
  if (c.securityNote.enabled) {
    out.push(
      { where: "Link note", value: c.securityNote.tagline, link: false },
      { where: "Link note", value: c.securityNote.text, link: false },
      { where: "Link note", value: c.securityNote.fallbackPrompt, link: false },
      { where: "Link note", value: c.securityNote.fallbackLabel, link: false },
      { where: "Link note fallback link", value: c.securityNote.fallbackUrl, link: true },
    );
  }
  if (c.details.enabled) {
    out.push(
      { where: "Details", value: c.details.label, link: false },
      { where: "Details", value: c.details.title, link: false },
      ...c.details.rows.flatMap((row) => [
        { where: "Details row", value: row.label, link: false },
        { where: "Details row", value: row.value, link: false },
      ]),
      { where: "Details note", value: c.details.notePrompt, link: false },
      { where: "Details note", value: c.details.noteLinkLabel, link: false },
      { where: "Details note link", value: c.details.noteLinkUrl, link: true },
    );
  }
  if (c.steps.enabled) {
    out.push(
      { where: "What happens next", value: c.steps.label, link: false },
      { where: "What happens next", value: c.steps.title, link: false },
      ...c.steps.items.flatMap((step) => [
        { where: "Step", value: step.title, link: false },
        { where: "Step", value: step.text, link: false },
      ]),
      { where: "What happens next", value: c.steps.closing, link: false },
    );
  }
  if (c.secondaryButton.enabled) {
    out.push(
      { where: "Second button", value: c.secondaryButton.prompt, link: false },
      { where: "Second button", value: c.secondaryButton.label, link: false },
      { where: "Second button link", value: c.secondaryButton.url, link: true },
    );
  }
  return out;
}

/**
 * What stops a template being saved, in words for the editor. Empty is good.
 *
 * Every rule here is one whose breach the applicant would see: a merge field
 * nothing can fill renders as a gap, a link that is not one is a dead button,
 * an empty subject is an email that reads as spam.
 */
export function templateProblems(stage: LeadStage, template: LeadEmailTemplate): string[] {
  const problems: string[] = [];
  const known = new Set(mergeFieldsFor(stage).map((field) => field.key));
  const c = template.content;

  if (!template.subject.trim()) problems.push("The subject is empty.");
  if (!c.heading.trim()) problems.push("The heading is empty.");
  if (!c.paragraphs.trim()) problems.push("The message is empty.");
  if (!c.footer.compliance.trim()) {
    problems.push("The compliance line is empty. It says why the applicant is receiving this.");
  }

  const unknown = new Map<string, Set<string>>();
  for (const field of fieldsOf(template)) {
    for (const token of findTokens(field.value)) {
      if (known.has(token)) continue;
      if (!unknown.has(token)) unknown.set(token, new Set());
      unknown.get(token)!.add(field.where);
    }
  }
  for (const [token, where] of unknown) {
    problems.push(
      `{{${token}}} is not a field this email can fill (${[...where].join(", ")}). It would show as a gap.`,
    );
  }

  for (const field of fieldsOf(template)) {
    if (!field.link || !field.value.trim()) continue;
    const sample = renderUrl(field.value, sampleContext(stage));
    if (!sample) {
      problems.push(
        `${field.where} is not a link. Use an https:// or mailto: address, or a link field such as {{${stage === 1 ? "questionnaire_url" : "booking_url"}}}.`,
      );
    }
  }

  if (template.content.primaryButton.url.trim() && !template.content.primaryButton.label.trim()) {
    problems.push("The primary button has a link but no label.");
  }
  return problems;
}

/**
 * What is worth knowing before saving but does not stop it: the link the
 * applicant needs to take the next step, missing from the email.
 */
export function templateWarnings(stage: LeadStage, template: LeadEmailTemplate): string[] {
  const all = fieldsOf(template)
    .map((field) => field.value)
    .join("\n");
  const warnings: string[] = [];
  if (stage === 1 && !all.includes("{{questionnaire_url}}")) {
    warnings.push(
      "Nothing in this email uses {{questionnaire_url}}, so the applicant has no link to the questionnaire.",
    );
  }
  if (stage === 2 && !all.includes("{{booking_url}}")) {
    warnings.push(
      "Nothing in this email uses {{booking_url}}, so the applicant has no way to book.",
    );
  }
  return warnings;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
export type MergeContext = Record<string, string | null | undefined>;

/** Merge into plain text: a subject, a preview line, the text version. */
export function renderPlain(template: string, context: MergeContext): string {
  return tidy(
    String(template ?? "")
      .replace(/\*\*/g, "")
      .replace(TOKEN, (_whole, name: string) => String(context[name] ?? "")),
  );
}

/**
 * Merge into HTML-safe text. The template is plain text, so its own words are
 * escaped as well as the values merged into it; `**bold**` is read from the
 * template before merging, so a value cannot make itself bold.
 */
export function renderInline(template: string, context: MergeContext, strong = STRONG): string {
  const parts = String(template ?? "").split("**");
  // An unmatched `**` is text, not the start of a bold run that never ends.
  if (parts.length % 2 === 0) parts[parts.length - 2] += `**${parts.pop()}`;
  const html = parts
    .map((part, index) => {
      const merged = part
        .split(TOKEN)
        .map((piece, i) =>
          i % 2 === 1 ? escapeHtml(String(context[piece] ?? "")) : escapeHtml(piece),
        )
        .join("");
      return index % 2 === 1 && merged.trim()
        ? `<strong style="${strong}">${merged}</strong>`
        : merged;
    })
    .join("");
  return tidy(html);
}

/**
 * Merge into a link, or nothing.
 *
 * A field that IS one merge field takes the value whole — `{{questionnaire_url}}`
 * is already a link. A value merged into the middle of a web link is encoded,
 * so a reference cannot break the query string. What comes out must be an
 * `https://`, `http://` or `mailto:` link, or the element is left out.
 */
export function renderUrl(template: string, context: MergeContext): string {
  const raw = String(template ?? "").trim();
  if (!raw) return "";
  const whole = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/.exec(raw);
  const mailto = /^mailto:/i.test(raw);
  const merged = whole
    ? String(context[whole[1]] ?? "").trim()
    : raw.replace(TOKEN, (_w, name: string) => {
        const value = String(context[name] ?? "").trim();
        return mailto ? value : encodeURIComponent(value);
      });
  if (/^https?:\/\/[^\s"'<>]+$/i.test(merged)) return merged;
  if (/^mailto:[^@\s"'<>]+@[^@\s"'<>]+$/i.test(merged)) return merged;
  return "";
}

/** "Thank you, ." → "Thank you." and "()" → "" — what an empty value leaves. */
function tidy(text: string): string {
  return text
    .replace(/\s*\(\s*\)/g, "")
    .replace(/[ \t]*,[ \t]*([.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export type RenderedLeadEmail = { subject: string; html: string; text: string };

/** One template, one applicant: the email as it will be sent. */
export function renderLeadEmail(
  template: LeadEmailTemplate,
  context: MergeContext,
): RenderedLeadEmail {
  const c = template.content;
  const p = (value: string) => renderInline(value, context);
  const plain = (value: string) => renderPlain(value, context);

  const paragraphs = c.paragraphs
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

  const factsOut = (list: EmailFact[]) =>
    list
      .map((fact) => ({ label: p(fact.label), value: p(fact.value) }))
      .filter((fact) => fact.label && fact.value);

  const card =
    c.card.enabled && plain(c.card.title)
      ? {
          index: p(c.card.index),
          label: p(c.card.label),
          title: p(c.card.title),
          text: p(c.card.text),
          facts: factsOut(c.card.facts),
        }
      : null;

  const primaryUrl = renderUrl(c.primaryButton.url, context);
  const primary =
    primaryUrl && plain(c.primaryButton.label)
      ? { label: p(c.primaryButton.label), plain: plain(c.primaryButton.label), url: primaryUrl }
      : null;

  const fallbackUrl = renderUrl(c.securityNote.fallbackUrl, context);
  const note =
    c.securityNote.enabled && (plain(c.securityNote.tagline) || plain(c.securityNote.text))
      ? {
          tagline: p(c.securityNote.tagline),
          text: p(c.securityNote.text),
          fallback:
            fallbackUrl && plain(c.securityNote.fallbackLabel)
              ? {
                  prompt: p(c.securityNote.fallbackPrompt),
                  label: p(c.securityNote.fallbackLabel),
                  url: fallbackUrl,
                }
              : null,
        }
      : null;

  const rows = factsOut(c.details.rows);
  const noteUrl = renderUrl(c.details.noteLinkUrl, context);
  const details =
    c.details.enabled && rows.length
      ? {
          label: p(c.details.label),
          title: p(c.details.title),
          rows,
          note:
            plain(c.details.notePrompt) || (noteUrl && plain(c.details.noteLinkLabel))
              ? {
                  prompt: p(c.details.notePrompt),
                  link:
                    noteUrl && plain(c.details.noteLinkLabel)
                      ? { label: p(c.details.noteLinkLabel), url: noteUrl }
                      : null,
                }
              : null,
        }
      : null;

  const items = c.steps.items
    .map((step) => ({ title: p(step.title), text: p(step.text) }))
    .filter((step) => step.title);
  const stepsOut =
    c.steps.enabled && items.length
      ? { label: p(c.steps.label), title: p(c.steps.title), items, closing: p(c.steps.closing) }
      : null;

  const secondaryUrl = renderUrl(c.secondaryButton.url, context);
  const secondary =
    c.secondaryButton.enabled && secondaryUrl && plain(c.secondaryButton.label)
      ? {
          prompt: p(c.secondaryButton.prompt),
          label: p(c.secondaryButton.label),
          plain: plain(c.secondaryButton.label),
          url: secondaryUrl,
        }
      : null;

  const html = brandedLayout({
    title: p(c.title),
    preheader: p(c.preheader),
    badge: p(c.badge),
    eyebrow: p(c.eyebrow),
    heading: p(c.heading),
    intro: p(c.intro),
    greeting: p(c.greeting),
    paragraphs: paragraphs.map((block) => p(block)).filter(Boolean),
    card,
    primary,
    note,
    details,
    steps: stepsOut,
    secondary,
    footer: {
      tagline: p(c.footer.tagline),
      badge: p(c.footer.badge),
      compliance: p(c.footer.compliance),
    },
  });

  const lines: string[] = [];
  const add = (value: string) => {
    const line = value.trim();
    if (line) lines.push(line);
  };
  add(plain(c.heading));
  add(plain(c.intro));
  add(plain(c.greeting));
  paragraphs.forEach((block) => add(plain(block)));
  if (card) {
    add(`${plain(c.card.label)}: ${plain(c.card.title)}`);
    add(plain(c.card.text));
  }
  if (primary) add(`${primary.plain}: ${primary.url}`);
  if (note) {
    add(plain(c.securityNote.text));
    if (note.fallback) add(`${plain(c.securityNote.fallbackPrompt)} ${note.fallback.url}`);
  }
  if (details) {
    add(plain(c.details.title));
    c.details.rows.forEach((row) => {
      const value = plain(row.value);
      if (value) add(`${plain(row.label)}: ${value}`);
    });
    if (details.note) add([plain(c.details.notePrompt), details.note.link?.url ?? ""].join(" "));
  }
  if (stepsOut) add(plain(c.steps.closing));
  if (secondary) add(`${secondary.plain}: ${secondary.url}`);
  add(plain(c.footer.compliance));

  return { subject: plain(template.subject), html, text: lines.join("\n\n") };
}

// ── The layout ──────────────────────────────────────────────────────────────
//
// The Aurixa Systems website's design, as an email: its navy surfaces, the
// hairline-bordered square panels of its forms and scheduler, Playfair Display
// headings over Inter, gold monospace eyebrows, and its two calls to action —
// the teal gradient of "Start your free trial" and the gold-outlined button of
// the scheduler. Every value is read off the website (src/index.css and the
// pages it styles in aurixa-systems), not chosen here.
//
// Kept table-based with inline styles and Outlook VML buttons, because that is
// what renders the same in Outlook, Gmail and Apple Mail. The webfonts load
// where a client allows (Apple Mail, iOS); everywhere else the stacks fall back
// to Georgia and Helvetica, which keep the same contrast of serif over sans.

const SANS = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const MONO = "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";
const STRONG = "color:#ffffff; font-weight:600;";

/** The website's palette (aurixa-systems src/index.css, and its pages as drawn). */
const COLOR = {
  page: "#0a192f", // --color-marketing-page
  card: "#041022", // the scheduler's panel
  panel: "#10243e", // the application form's panel
  panelLine: "#283b52",
  recessed: "#030b17", // an input
  line: "#1d2736", // a divider
  heading: "#ffffff",
  text: "#b6c0d4",
  label: "#9ca3b8",
  faint: "#6f7d93",
  gold: "#d7b35f", // eyebrows
  goldChip: "#c89b3c", // --color-prism-magenta, the site's gold
  goldLight: "#f5d17a", // --color-prism-gold
  goldLine: "#816831", // the scheduler button's border
  blue: "#0b74ad", // the scheduler panel's top line
  cyan: "#00a8b5", // --color-prism-cyan
  cyanSoft: "#5edde8",
} as const;

const FONTS =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:ital,wght@0,400;0,500;1,400&display=swap";

type Layout = {
  title: string;
  preheader: string;
  badge: string;
  eyebrow: string;
  heading: string;
  intro: string;
  greeting: string;
  paragraphs: string[];
  card: { index: string; label: string; title: string; text: string; facts: EmailFact[] } | null;
  primary: { label: string; plain: string; url: string } | null;
  note: {
    tagline: string;
    text: string;
    fallback: { prompt: string; label: string; url: string } | null;
  } | null;
  details: {
    label: string;
    title: string;
    rows: EmailFact[];
    note: { prompt: string; link: { label: string; url: string } | null } | null;
  } | null;
  steps: { label: string; title: string; items: EmailStep[]; closing: string } | null;
  secondary: { prompt: string; label: string; plain: string; url: string } | null;
  footer: { tagline: string; badge: string; compliance: string };
};

const attr = (value: string) => escapeHtml(value);

const CSS = `
    :root { color-scheme: light; supported-color-schemes: light; }
    html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; min-width: 100% !important; background-color: ${COLOR.page}; }
    * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
    table, td { border-collapse: collapse !important; mso-table-lspace: 0pt !important; mso-table-rspace: 0pt !important; }
    table { border-spacing: 0 !important; }
    img { display: block; border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a { text-decoration: none; }
    a[x-apple-data-detectors], .unstyle-auto-detected-links a, .aBn { color: inherit !important; text-decoration: none !important; border-bottom: 0 !important; cursor: default !important; }
    .preheader { display: none !important; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; overflow: hidden; mso-hide: all; }
    @media only screen and (max-width: 640px) {
      .email-shell { width: 100% !important; max-width: 100% !important; }
      .outer-pad { padding: 0 !important; }
      .mobile-pad { padding-left: 22px !important; padding-right: 22px !important; }
      .hero-pad { padding-top: 26px !important; padding-bottom: 32px !important; }
      .brand-meta { display: none !important; }
      .brand-logo { width: 190px !important; max-width: 190px !important; height: auto !important; }
      .cta-primary-table, .cta-secondary-table { width: 100% !important; max-width: 100% !important; }
      .hero-title { font-size: 32px !important; line-height: 38px !important; }
      .hero-subtitle { font-size: 15px !important; line-height: 24px !important; }
      .next-step-index, .next-step-content { display: block !important; width: 100% !important; box-sizing: border-box !important; }
      .next-step-index { padding: 22px 22px 0 22px !important; }
      .next-step-content { padding: 12px 22px 22px 22px !important; }
      .meta-column { display: block !important; width: 100% !important; box-sizing: border-box !important; border-right: 0 !important; border-bottom: 1px solid ${COLOR.line} !important; }
      .meta-column-last { border-bottom: 0 !important; }
      .cta-mobile { display: block !important; width: auto !important; min-width: 0 !important; padding: 17px 14px !important; }
      .cta-secondary-mobile { display: block !important; width: auto !important; min-width: 0 !important; padding: 14px 14px !important; }
      .detail-label, .detail-value { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: left !important; }
      .detail-label { padding-bottom: 2px !important; }
      .detail-value { padding-top: 0 !important; }
      .step-column { display: block !important; width: 100% !important; box-sizing: border-box !important; padding-left: 0 !important; padding-right: 0 !important; padding-bottom: 12px !important; }
      .footer-right { display: none !important; }
    }`;

const spacer = (px: number) =>
  `<div style="height:${px}px; line-height:${px}px; font-size:1px;">&nbsp;</div>`;
const row = (inner: string, style: string, extra = "") =>
  `<tr><td bgcolor="${COLOR.card}"${extra} class="mobile-pad" style="${style} background-color:${COLOR.card};">${inner}</td></tr>`;

/** An application reference reads as one, in the website's monospace gold. */
const isReference = (value: string) => /^AX-[A-Z0-9]{10}$/.test(value.trim());
const valueStyle = (value: string) =>
  isReference(value)
    ? `font-family:${MONO}; font-size:14px; line-height:21px; font-weight:600; letter-spacing:0.6px; color:${COLOR.goldLight};`
    : `font-family:${SANS}; font-size:14px; line-height:21px; font-weight:500; color:${COLOR.heading};`;

/** A gold monospace label, the website's eyebrow: "STAGE 03 · STRATEGIC REVIEW". */
const eyebrowText = (text: string, color: string = COLOR.gold, size = 11) =>
  `<div style="font-family:${MONO}; font-size:${size}px; line-height:${size + 6}px; font-weight:700; letter-spacing:2.4px; text-transform:uppercase; color:${color};">${text}</div>`;

/** A hairline across the panel, with the gold-then-blue tick the website rules end in. */
const hairline = () =>
  `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td height="1" bgcolor="${COLOR.line}" style="height:1px; background-color:${COLOR.line}; font-size:0; line-height:0;">&nbsp;</td><td width="56" height="1" bgcolor="${COLOR.gold}" style="width:56px; height:1px; background-color:${COLOR.gold}; font-size:0; line-height:0;">&nbsp;</td><td width="28" height="1" bgcolor="${COLOR.blue}" style="width:28px; height:1px; background-color:${COLOR.blue}; font-size:0; line-height:0;">&nbsp;</td></tr></table>`;

function cardBlock(card: NonNullable<Layout["card"]>): string {
  const facts = card.facts
    .map((fact, i) => {
      const last = i === card.facts.length - 1;
      const width = (100 / card.facts.length).toFixed(2);
      return `<td width="${width}%" valign="top" class="meta-column${last ? " meta-column-last" : ""}" style="width:${width}%; padding:14px 16px;${last ? "" : ` border-right:1px solid ${COLOR.line};`}">${eyebrowText(fact.label, COLOR.label, 10)}<div style="padding-top:6px; ${valueStyle(fact.value)}">${fact.value}</div></td>`;
    })
    .join("");
  return row(
    `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${COLOR.panel}" style="width:100%; background-color:${COLOR.panel}; border:1px solid ${COLOR.panelLine};">
<tr>
<td width="76" valign="top" class="next-step-index" style="width:76px; padding:26px 0 24px 26px;">${
      card.index
        ? `<div style="font-family:${SERIF}; font-size:34px; line-height:36px; font-style:italic; font-weight:400; color:${COLOR.gold};">${card.index}</div>`
        : "&nbsp;"
    }</td>
<td valign="top" class="next-step-content" style="padding:26px 26px 24px 8px;">${
      card.label ? `${eyebrowText(card.label)}${spacer(9)}` : ""
    }<div style="font-family:${SERIF}; font-size:23px; line-height:30px; font-weight:400; color:${COLOR.heading};">${card.title}</div>${
      card.text
        ? `${spacer(9)}<div style="font-family:${SANS}; font-size:14px; line-height:23px; color:${COLOR.text};">${card.text}</div>`
        : ""
    }</td>
</tr>${
      card.facts.length
        ? `<tr><td colspan="2" style="padding:0 20px 20px 20px;"><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${COLOR.recessed}" style="width:100%; background-color:${COLOR.recessed}; border:1px solid ${COLOR.line};"><tr>${facts}</tr></table></td></tr>`
        : ""
    }
</table>`,
    "padding:30px 44px 0 44px;",
  );
}

/** The website's primary call to action: the teal gradient of "Start your free trial". */
function primaryBlock(primary: NonNullable<Layout["primary"]>): string {
  const href = attr(primary.url);
  return `<tr><td bgcolor="${COLOR.card}" align="center" class="mobile-pad" style="padding:34px 44px 14px 44px; background-color:${COLOR.card};">
<table role="presentation" width="512" border="0" cellspacing="0" cellpadding="0" class="cta-primary-table" style="width:512px; max-width:512px;"><tr><td align="center">
<!--[if mso]><v:rect href="${href}" style="height:58px; v-text-anchor:middle; width:512px;" strokeweight="1px" strokecolor="#0e6870" fillcolor="#025966"><w:anchorlock/><center style="font-family:Arial, sans-serif; font-size:13px; font-weight:bold; letter-spacing:2px; color:#ffffff;">${primary.label} &#8250;</center></v:rect><![endif]-->
<!--[if !mso]><!-- --><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#025966" style="width:100%; background-color:#025966; background-image:linear-gradient(100deg,#052939 0%,#025966 55%,#29665c 82%,#6d6332 100%); border:1px solid #0e6870; box-shadow:0 10px 30px rgba(0,168,181,0.16);"><tr><td align="center"><a href="${href}" target="_blank" role="button" aria-label="${attr(primary.plain)}" class="cta-mobile" style="display:block; padding:19px 24px; font-family:${SANS}; font-size:12px; line-height:18px; font-weight:600; letter-spacing:2.6px; text-transform:uppercase; color:#ffffff; text-align:center; text-decoration:none;">${primary.label}&nbsp;&nbsp;&#8250;</a></td></tr></table><!--<![endif]-->
</td></tr></table></td></tr>`;
}

function noteBlock(note: NonNullable<Layout["note"]>, afterPrimary: boolean): string {
  return `<tr><td bgcolor="${COLOR.card}" align="center" class="mobile-pad" style="padding:${afterPrimary ? 4 : 30}px 44px 32px 44px; background-color:${COLOR.card}; text-align:center;">${
    note.tagline ? eyebrowText(note.tagline, COLOR.cyanSoft, 10) : ""
  }${
    note.text
      ? `<div style="padding-top:8px; font-family:${SANS}; font-size:12px; line-height:19px; color:${COLOR.label};">${note.text}</div>`
      : ""
  }${
    note.fallback
      ? `<div style="padding-top:9px; font-family:${SANS}; font-size:12px; line-height:19px; color:${COLOR.label};">${note.fallback.prompt} <a href="${attr(note.fallback.url)}" target="_blank" style="font-weight:600; color:${COLOR.goldLight}; text-decoration:underline;">${note.fallback.label}</a></div>`
      : ""
  }</td></tr>`;
}

function divider(): string {
  return row(hairline(), "padding:0 44px;");
}

function sectionHeading(label: string, title: string, top: number): string {
  return row(
    `${label ? `${eyebrowText(label)}${spacer(10)}` : ""}${
      title
        ? `<div style="font-family:${SERIF}; font-size:25px; line-height:32px; font-weight:400; color:${COLOR.heading};">${title}</div>`
        : ""
    }`,
    `padding:${top}px 44px 0 44px;`,
  );
}

function detailsBlock(details: NonNullable<Layout["details"]>): string {
  const rows = details.rows
    .map((entry, i) => {
      const last = i === details.rows.length - 1;
      const border = last ? "" : ` border-bottom:1px solid ${COLOR.line};`;
      return `<tr><td width="40%" class="detail-label" style="width:40%; padding:16px 18px;${border}">${eyebrowText(entry.label, COLOR.label, 10)}</td><td width="60%" align="right" class="detail-value" style="width:60%; padding:16px 18px;${border} ${valueStyle(entry.value)} word-break:break-word;">${entry.value}</td></tr>`;
    })
    .join("");
  return [
    sectionHeading(details.label, details.title, 32),
    row(
      `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${COLOR.recessed}" style="width:100%; background-color:${COLOR.recessed}; border:1px solid ${COLOR.panelLine};">${rows}</table>`,
      "padding:18px 44px 0 44px;",
    ),
    details.note
      ? row(
          `<div style="font-family:${SANS}; font-size:12px; line-height:19px; color:${COLOR.label};">${details.note.prompt}${
            details.note.link
              ? ` <a href="${attr(details.note.link.url)}" target="_blank" style="font-weight:600; color:${COLOR.goldLight}; text-decoration:underline;">${details.note.link.label}</a>`
              : ""
          }</div>`,
          "padding:14px 44px 0 44px;",
        )
      : "",
  ].join("\n");
}

function stepsBlock(steps: NonNullable<Layout["steps"]>): string {
  const accents = [COLOR.cyan, COLOR.gold, COLOR.cyan, COLOR.gold];
  const width = (100 / steps.items.length).toFixed(2);
  const columns = steps.items
    .map((step, i) => {
      const pad =
        i === 0
          ? "padding-right:7px;"
          : i === steps.items.length - 1
            ? "padding-left:7px;"
            : "padding-left:4px; padding-right:4px;";
      return `<td width="${width}%" valign="top" class="step-column" style="width:${width}%; ${pad}"><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${COLOR.panel}" style="width:100%; background-color:${COLOR.panel}; border:1px solid ${COLOR.panelLine};"><tr><td height="2" bgcolor="${accents[i]}" style="height:2px; background-color:${accents[i]}; font-size:0; line-height:0;">&nbsp;</td></tr><tr><td style="padding:16px 16px 18px 16px;"><div style="font-family:${MONO}; font-size:11px; line-height:16px; font-weight:700; letter-spacing:2px; color:${COLOR.gold};">${String(i + 1).padStart(2, "0")}</div><div style="padding-top:8px; font-family:${SERIF}; font-size:17px; line-height:22px; font-weight:400; color:${COLOR.heading};">${step.title}</div>${
        step.text
          ? `<div style="padding-top:6px; font-family:${SANS}; font-size:12px; line-height:19px; color:${COLOR.text};">${step.text}</div>`
          : ""
      }</td></tr></table></td>`;
    })
    .join("");
  return [
    sectionHeading(steps.label, steps.title, 36),
    row(
      `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>${columns}</tr></table>`,
      "padding:20px 44px 0 44px;",
    ),
    steps.closing
      ? row(
          `<div style="font-family:${SANS}; font-size:14px; line-height:24px; color:${COLOR.text};">${steps.closing}</div>`,
          "padding:24px 44px 0 44px;",
        )
      : "",
  ].join("\n");
}

/** The scheduler's button: dark, gold-bordered, a gold monospace label. */
function secondaryBlock(secondary: NonNullable<Layout["secondary"]>): string {
  const href = attr(secondary.url);
  return row(
    `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${COLOR.panel}" style="width:100%; background-color:${COLOR.panel}; border:1px solid ${COLOR.panelLine};"><tr><td align="center" style="padding:22px 22px 24px 22px;">${
      secondary.prompt
        ? `<div style="font-family:${SANS}; font-size:13px; line-height:20px; color:${COLOR.text}; text-align:center;">${secondary.prompt}</div>${spacer(14)}`
        : ""
    }<table role="presentation" width="360" border="0" cellspacing="0" cellpadding="0" class="cta-secondary-table" style="width:360px; max-width:360px;"><tr><td align="center">
<!--[if mso]><v:rect href="${href}" style="height:46px; v-text-anchor:middle; width:360px;" strokeweight="1px" strokecolor="${COLOR.goldLine}" fillcolor="#171d21"><w:anchorlock/><center style="font-family:'Courier New', monospace; font-size:12px; font-weight:bold; letter-spacing:2px; color:${COLOR.goldLight};">${secondary.label} &#8250;</center></v:rect><![endif]-->
<!--[if !mso]><!-- --><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#171d21" style="width:100%; background-color:#171d21; border:1px solid ${COLOR.goldLine};"><tr><td align="center"><a href="${href}" target="_blank" role="button" aria-label="${attr(secondary.plain)}" class="cta-secondary-mobile" style="display:block; padding:14px 18px; font-family:${MONO}; font-size:11px; line-height:17px; font-weight:700; letter-spacing:2.2px; text-transform:uppercase; color:${COLOR.goldLight}; text-align:center; text-decoration:none;">${secondary.label}&nbsp;&nbsp;&#8250;</a></td></tr></table><!--<![endif]-->
</td></tr></table></td></tr></table>`,
    "padding:32px 44px 40px 44px;",
  );
}

/** The lockup, as an email can draw it (aurixa-systems public/brand/email). */
export const EMAIL_LOCKUP_URL =
  "https://www.aurixasystems.com.au/brand/email/aurixa-lockup-480.png";

function brandedLayout(l: Layout): string {
  const body: string[] = [];
  body.push(
    row(
      `${l.greeting ? `<div style="font-family:${SERIF}; font-size:21px; line-height:29px; font-weight:400; color:${COLOR.heading};">${l.greeting}</div>` : ""}${l.paragraphs
        .map(
          (para, i) =>
            `${i === 0 ? (l.greeting ? spacer(16) : "") : spacer(14)}<div style="font-family:${SANS}; font-size:15px; line-height:26px; color:${COLOR.text};">${para}</div>`,
        )
        .join("")}`,
      "padding:32px 44px 0 44px;",
    ),
  );
  if (l.card) body.push(cardBlock(l.card));
  if (l.primary) body.push(primaryBlock(l.primary));
  if (l.note) body.push(noteBlock(l.note, Boolean(l.primary)));
  if (!l.note) body.push(row(spacer(32), "padding:0 44px;"));
  if (l.details || l.steps) body.push(divider());
  if (l.details) body.push(detailsBlock(l.details));
  if (l.steps) body.push(stepsBlock(l.steps));
  body.push(l.secondary ? secondaryBlock(l.secondary) : row(spacer(40), "padding:0 44px;"));

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="x-ua-compatible" content="ie=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${l.title}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->
<!--[if !mso]><!--><link rel="stylesheet" href="${FONTS}"><!--<![endif]-->
<style>${CSS}
</style>
<!--[if mso]><style>body, table, td, div, p, a, span { font-family: Arial, sans-serif !important; }</style><![endif]-->
</head>
<body style="margin:0; padding:0; background-color:${COLOR.page};">
<div class="preheader">${l.preheader}</div>
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${"&nbsp;&zwnj;".repeat(13)}</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${COLOR.page}" style="width:100%; background-color:${COLOR.page};"><tr><td align="center" class="outer-pad" style="padding:36px 14px; background-color:${COLOR.page};">
<table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" class="email-shell" bgcolor="${COLOR.card}" style="width:600px; max-width:600px; background-color:${COLOR.card}; border:1px solid ${COLOR.panelLine};">
<tr><td style="padding:0; font-size:0; line-height:0;"><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td width="34%" height="2" bgcolor="${COLOR.blue}" style="width:34%; height:2px; background-color:${COLOR.blue}; font-size:0; line-height:0;">&nbsp;</td><td width="32%" height="2" bgcolor="#dfb665" style="width:32%; height:2px; background-color:#dfb665; font-size:0; line-height:0;">&nbsp;</td><td width="34%" height="2" bgcolor="${COLOR.blue}" style="width:34%; height:2px; background-color:${COLOR.blue}; font-size:0; line-height:0;">&nbsp;</td></tr></table></td></tr>
<tr><td bgcolor="${COLOR.card}" class="mobile-pad hero-pad" style="padding:30px 44px 40px 44px; background-color:${COLOR.card}; background-image:radial-gradient(ellipse at 88% 0%, rgba(0,168,181,0.13) 0%, rgba(0,168,181,0) 46%), linear-gradient(180deg,#071a33 0%,${COLOR.card} 100%);">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td valign="middle"><img src="${EMAIL_LOCKUP_URL}" width="220" height="70" class="brand-logo" alt="Aurixa Systems" style="display:block; width:220px; max-width:220px; height:auto; border:0;"></td>${
    l.badge
      ? `<td align="right" valign="middle" class="brand-meta"><table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr><td style="padding:6px 10px; border:1px solid rgba(200,155,60,0.4); background-color:rgba(200,155,60,0.1); font-family:${MONO}; font-size:10px; line-height:14px; font-weight:700; letter-spacing:1.8px; text-transform:uppercase; color:${COLOR.goldChip};">${l.badge}</td></tr></table></td>`
      : ""
  }</tr></table>
${spacer(34)}${l.eyebrow ? `${eyebrowText(l.eyebrow)}${spacer(14)}` : ""}<div class="hero-title" style="font-family:${SERIF}; font-size:40px; line-height:46px; font-weight:400; letter-spacing:-0.6px; color:${COLOR.heading};">${l.heading}</div>${
    l.intro
      ? `${spacer(16)}<div class="hero-subtitle" style="max-width:500px; font-family:${SANS}; font-size:16px; line-height:27px; color:${COLOR.text};">${l.intro}</div>`
      : ""
  }${spacer(30)}${hairline()}
</td></tr>
${body.join("\n")}
<tr><td bgcolor="${COLOR.recessed}" class="mobile-pad" style="padding:24px 44px; background-color:${COLOR.recessed}; border-top:1px solid ${COLOR.line};"><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td valign="middle"><div style="font-family:${SERIF}; font-size:15px; line-height:20px; font-weight:400; color:${COLOR.heading};">Aurixa Systems</div>${l.footer.tagline ? `<div style="padding-top:3px; font-family:${SANS}; font-size:12px; line-height:18px; color:${COLOR.label};">${l.footer.tagline}</div>` : ""}</td>${
    l.footer.badge
      ? `<td align="right" valign="middle" class="footer-right" style="white-space:nowrap;">${eyebrowText(l.footer.badge, COLOR.cyanSoft, 9)}</td>`
      : ""
  }</tr></table></td></tr>
</table>
${
  l.footer.compliance
    ? `<table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" class="email-shell" style="width:600px; max-width:600px;"><tr><td align="center" class="mobile-pad" style="padding:18px 24px 0 24px; font-family:${SANS}; font-size:11px; line-height:17px; color:${COLOR.faint};">${l.footer.compliance}</td></tr></table>`
    : ""
}
</td></tr></table>
</body>
</html>`;
}

// ── The applicant, as merge values ─────────────────────────────────────────

/** The lead fields an applicant email reads. */
export type LeadEmailSubject = {
  application_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  entity_name?: string | null;
  submitted_at?: string | null;
  created_at?: string | null;
  stage2_completed_at?: string | null;
  stage3_booked_at?: string | null;
  stage3_session_start?: string | null;
  stage3_time_zone?: string | null;
  stage3_local_time?: string | null;
  stage3_host_local_time?: string | null;
  stage3_duration_minutes?: number | null;
  stage3_meeting_url?: string | null;
};

export type LeadEmailLinks = {
  /** The website's origin, e.g. https://www.aurixasystems.com.au */
  siteUrl: string;
  /** The strategic review scheduler, if not `/schedule-strategic-review` on the site. */
  bookingUrl?: string | null;
  /** The secure questionnaire link, minted for this send. Stage 1 only. */
  questionnaireUrl?: string | null;
  questionnaireExpiresAt?: string | null;
  supportEmail: string;
  trialDays: number;
};

const SYDNEY = "Australia/Sydney";

function formatInstant(iso: string | null | undefined, timeZone: string, withTime = true): string {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone,
      weekday: withTime ? undefined : "long",
      day: "numeric",
      month: withTime ? "short" : "long",
      year: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

function sessionTime(iso: string | null | undefined, timeZone: string): string {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

const isZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Everything a template may name, for one applicant at one stage. */
export function leadEmailContext(
  lead: LeadEmailSubject,
  stage: LeadStage,
  links: LeadEmailLinks,
): Record<string, string> {
  const site = links.siteUrl.replace(/\/+$/, "");
  const reference = (lead.application_id ?? "").trim();
  const first = (lead.first_name ?? "").trim();
  const last = (lead.last_name ?? "").trim();
  const refQuery = reference ? `?ref=${encodeURIComponent(reference)}` : "";

  const context: Record<string, string> = {
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(" "),
    organisation: (lead.entity_name ?? "").trim() || "your organisation",
    application_id: reference,
    work_email: (lead.email ?? "").trim(),
    support_email: links.supportEmail,
    trial_days: String(links.trialDays),
  };

  if (stage === 1) {
    context.questionnaire_url = links.questionnaireUrl ?? "";
    context.questionnaire_expires = formatInstant(links.questionnaireExpiresAt, SYDNEY, false);
    context.questionnaire_resume_url = `${site}/questionnaire${refQuery}`;
    context.received_at = formatInstant(lead.submitted_at ?? lead.created_at, SYDNEY);
  }
  if (stage === 2 || stage === 3) {
    const scheduler = (links.bookingUrl ?? "").trim() || `${site}/schedule-strategic-review`;
    context.booking_url = reference
      ? `${scheduler}${scheduler.includes("?") ? "&" : "?"}ref=${encodeURIComponent(reference)}`
      : scheduler;
  }
  if (stage === 2) {
    context.questionnaire_completed_at = formatInstant(lead.stage2_completed_at, SYDNEY);
  }
  if (stage === 3) {
    const zone = (lead.stage3_time_zone ?? "").trim();
    context.review_time_zone = zone;
    context.review_local_time =
      (lead.stage3_local_time ?? "").trim() ||
      sessionTime(lead.stage3_session_start, zone && isZone(zone) ? zone : SYDNEY);
    context.review_host_time =
      (lead.stage3_host_local_time ?? "").trim() || sessionTime(lead.stage3_session_start, SYDNEY);
    context.review_duration = String(lead.stage3_duration_minutes ?? 30);
    context.meeting_url = (lead.stage3_meeting_url ?? "").trim();
    context.booked_at = formatInstant(lead.stage3_booked_at, SYDNEY);
  }
  return context;
}
