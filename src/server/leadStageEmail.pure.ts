// What a priority-access stage email says. Pure: no I/O, no clients, no dates
// read from the machine except the ones handed in.
//
// Two audiences, three stages, six messages. They are composed here rather than
// in the dispatcher so the wording can be asserted by a test and so the same
// applicant cannot be described one way in the team's email and another on the
// console — `summariseStage2` is shared with the Airtable mapper for exactly
// that reason.
//
// ## The rule this module exists to keep
//
// **It states what the record holds and nothing else.** No score, no grade, no
// "strong fit", no priority class. The funnel collects the applicant's own
// answers; an opinion about them is `crm.fit`'s to form, with its own evidence
// and its own audit trail. An email that arrives already carrying a verdict is
// how a verdict nobody can defend ends up in a sales conversation.
//
// A field the record does not hold is OMITTED, never rendered as "N/A" or
// "not provided". A row of dashes reads as a broken template; an absent row
// reads as what it is.

/** The palette the applicant already sees, taken from the live Stage 1 email. */
const INK = {
  shell: "#061326",
  hero: "#030b18",
  border: "#173a5d",
  rule: "#1b4268",
  blue: "#0b74ad",
  gold: "#dfb665",
  text: "#dce8f5",
  muted: "#8fa8c2",
  heading: "#ffffff",
} as const;

export type LeadStage = 1 | 2 | 3;
export type StageAudience = "internal" | "applicant";

/** Every field the composer may read. A superset of what any one stage uses. */
export type StageEmailLead = {
  id?: string;
  application_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  mobile_number?: string | null;
  entity_name?: string | null;
  entity_classification?: string | null;
  transaction_volume?: string | null;
  role?: string | null;
  primary_areas?: string[] | null;
  tech_stack_bottlenecks?: string | null;
  additional_notes?: string | null;
  source?: string | null;
  page?: string | null;
  submitted_at?: string | null;
  created_at?: string | null;
  landing_page?: string | null;
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  marketing_consent?: boolean | null;

  stage?: number | null;
  stage2_status?: string | null;
  stage2_completed_at?: string | null;
  stage2_next_step?: string | null;
  stage2_investment?: string | null;
  stage2_timeline?: string | null;
  stage2_user_count?: string | null;
  stage2_authority?: string | null;
  stage2_entity_structure?: string | null;
  stage2_admin_time?: string | null;
  stage2_migration?: string | null;
  stage2_regions?: string[] | null;
  stage2_systems?: string[] | null;
  stage2_problems?: string[] | null;
  stage2_capabilities?: string[] | null;
  stage2_integrations?: string[] | null;
  stage2_security?: string[] | null;
  stage2_difficult_workflow?: string | null;
  stage2_summary?: string | null;

  stage3_status?: string | null;
  stage3_booked_at?: string | null;
  stage3_session_start?: string | null;
  stage3_session_end?: string | null;
  stage3_time_zone?: string | null;
  stage3_local_time?: string | null;
  stage3_host_local_time?: string | null;
  stage3_duration_minutes?: number | null;
  stage3_notes?: string | null;
  stage3_booking_reference?: string | null;
};

export type ComposedEmail = {
  subject: string;
  html: string;
  /** The same message as text, for the ledger preview and for a plain client. */
  text: string;
};

// ── Small helpers ──────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A slug rendered for a human. Labels are Airtable's; slugs are the form's.
 *
 * **Underscores only.** A hyphen is a real character in real values here —
 * `AX-C94B1D8EC9` is an application reference an operator retypes off this
 * email, and `11 - 25` and `$2,000 - $3,000 per month` are option labels the
 * form wrote. De-slugging on `[_-]` turned the reference into `AX C94B1D8EC9`,
 * which is not the reference.
 *
 * Anything already carrying a capital or a space is an author's own wording
 * and is returned untouched.
 */
/**
 * A database token, rendered as words. Anything that is not one is untouched.
 *
 * The bound is `DATABASE_TOKEN` and it is the whole of the rule. An earlier
 * version transformed any value with no capital and no space, which is true of
 * `mortgage_broking` and equally true of `ada@analytical.example` — so the
 * applicant's own email address was CAPITALISED on every internal email at
 * every stage, and an operator copying it out of one got `Ada@…`. An address
 * is an identifier, not prose, and a humaniser has no business in that slot.
 *
 * `76_to_150` and `disconnected_systems` are tokens and still become "76 to
 * 150" and "Disconnected systems": database vocabulary never reaches the
 * operator. `+61400111222`, `Australia/Perth`, `AX-C94B1D8EC9` and any address
 * are not tokens and are rendered exactly as the record holds them.
 */
const DATABASE_TOKEN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function humanise(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!DATABASE_TOKEN.test(trimmed)) return trimmed;
  const spaced = trimmed.replace(/_+/g, " ").trim();
  if (!spaced) return trimmed;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function fullName(lead: StageEmailLead): string {
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim();
  return name || lead.email || "an applicant";
}

/**
 * A timestamp in Aurixa's own time zone, always with the zone named.
 *
 * `en-AU` and `Australia/Sydney` are both explicit. An email is read on
 * somebody else's machine, and a date formatted to the SERVER's default locale
 * is the defect `AU_LOCALE` was created for in the property dashboard — there
 * it printed `8/29/2029` to an Australian reporting entity.
 */
export function auDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

type Row = { label: string; value: string };

/** Drops every row with nothing to say, so no email prints an empty cell. */
function rows(entries: (readonly [string, unknown])[]): Row[] {
  const out: Row[] = [];
  for (const [label, raw] of entries) {
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Array.isArray(raw)
      ? raw
          .filter(Boolean)
          .map((item) => humanise(String(item)))
          .join(" · ")
      : typeof raw === "boolean"
        ? raw
          ? "Yes"
          : "No"
        : humanise(String(raw));
    if (!value) continue;
    out.push({ label, value });
  }
  return out;
}

// ── The shell ──────────────────────────────────────────────────────────────

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "rows"; heading: string; rows: Row[] }
  | { kind: "prose"; heading: string; text: string }
  | { kind: "cta"; label: string; href: string };

function renderBlockHtml(block: Block): string {
  switch (block.kind) {
    case "paragraph":
      return `<p style="margin:0 0 16px 0; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:24px; color:${INK.text};">${escapeHtml(block.text)}</p>`;
    case "rows": {
      if (block.rows.length === 0) return "";
      const cells = block.rows
        .map(
          (row) =>
            `<tr><td style="padding:7px 0; border-bottom:1px solid ${INK.rule}; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:0.7px; text-transform:uppercase; color:${INK.muted}; width:42%; vertical-align:top;">${escapeHtml(row.label)}</td><td style="padding:7px 0 7px 14px; border-bottom:1px solid ${INK.rule}; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:21px; color:${INK.text}; vertical-align:top;">${escapeHtml(row.value)}</td></tr>`,
        )
        .join("");
      return `<div style="margin:0 0 22px 0;"><div style="font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:1.3px; text-transform:uppercase; color:${INK.gold}; margin:0 0 8px 0;">${escapeHtml(block.heading)}</div><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="width:100%; border-collapse:collapse;">${cells}</table></div>`;
    }
    case "prose": {
      if (!block.text.trim()) return "";
      const body = escapeHtml(block.text)
        .split(/\n{2,}/)
        .map(
          (para) =>
            `<p style="margin:0 0 12px 0; font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:22px; color:${INK.text}; white-space:pre-wrap;">${para.replace(/\n/g, "<br>")}</p>`,
        )
        .join("");
      return `<div style="margin:0 0 22px 0;"><div style="font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:1.3px; text-transform:uppercase; color:${INK.gold}; margin:0 0 8px 0;">${escapeHtml(block.heading)}</div>${body}</div>`;
    }
    case "cta":
      return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:0 0 22px 0;"><tr><td bgcolor="${INK.blue}" style="background-color:${INK.blue}; padding:14px 26px;"><a href="${escapeHtml(block.href)}" style="font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:bold; letter-spacing:0.4px; color:#ffffff; text-decoration:none; display:inline-block;">${escapeHtml(block.label)}</a></td></tr></table>`;
  }
}

function renderBlockText(block: Block): string {
  switch (block.kind) {
    case "paragraph":
      return block.text;
    case "rows":
      return block.rows.length
        ? `${block.heading}\n${block.rows.map((r) => `  ${r.label}: ${r.value}`).join("\n")}`
        : "";
    case "prose":
      return block.text.trim() ? `${block.heading}\n${block.text}` : "";
    case "cta":
      return `${block.label}: ${block.href}`;
  }
}

/**
 * The Aurixa email shell: a dark navy card under the three-colour energy rail,
 * table-based and inline-styled because that is what survives Outlook.
 *
 * No remote image. The live Make emails hotlink a logo off the marketing site,
 * and a blocked image is the ordinary case in a corporate client — so the
 * wordmark here is set in type, which renders the same everywhere and costs
 * nothing when images are off.
 */
function shell(input: {
  preheader: string;
  eyebrow: string;
  title: string;
  blocks: Block[];
  footnote?: string;
}): string {
  const body = input.blocks.map(renderBlockHtml).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="dark light"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0; padding:0; background-color:#04101f;">
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; color:transparent;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="width:100%; background-color:#04101f;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="640" border="0" cellspacing="0" cellpadding="0" bgcolor="${INK.shell}" style="width:640px; max-width:640px; background-color:${INK.shell}; border:1px solid ${INK.border};">
  <tr><td style="padding:0; font-size:0; line-height:0;">
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
      <td width="34%" height="4" bgcolor="${INK.blue}" style="width:34%; height:4px; font-size:0; line-height:0;">&nbsp;</td>
      <td width="32%" height="4" bgcolor="${INK.gold}" style="width:32%; height:4px; font-size:0; line-height:0;">&nbsp;</td>
      <td width="34%" height="4" bgcolor="${INK.blue}" style="width:34%; height:4px; font-size:0; line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="${INK.hero}" style="padding:30px 34px 26px 34px; background-color:${INK.hero};">
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:13px; letter-spacing:3.4px; text-transform:uppercase; color:${INK.gold}; margin:0 0 14px 0;">Aurixa&nbsp;Systems</div>
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:1.6px; text-transform:uppercase; color:${INK.muted}; margin:0 0 8px 0;">${escapeHtml(input.eyebrow)}</div>
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:26px; line-height:33px; font-weight:bold; color:${INK.heading};">${escapeHtml(input.title)}</div>
  </td></tr>
  <tr><td style="padding:28px 34px 8px 34px;">${body}</td></tr>
  ${
    input.footnote
      ? `<tr><td style="padding:0 34px 26px 34px; border-top:1px solid ${INK.rule};"><p style="margin:16px 0 0 0; font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:19px; color:${INK.muted};">${escapeHtml(input.footnote)}</p></td></tr>`
      : ""
  }
</table>
</td></tr></table>
</body></html>`;
}

function plain(input: { title: string; blocks: Block[]; footnote?: string }): string {
  const parts = [
    "AURIXA SYSTEMS",
    input.title,
    "",
    ...input.blocks.map(renderBlockText).filter(Boolean),
  ];
  if (input.footnote) parts.push("", input.footnote);
  return parts
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── The applicant's own identity block, shared by every internal email ──────

function applicantRows(lead: StageEmailLead): Row[] {
  return rows([
    ["Name", fullName(lead)],
    ["Organisation", lead.entity_name],
    ["Role", lead.role],
    ["Email", lead.email],
    ["Mobile", lead.mobile_number],
    ["Organisation type", lead.entity_classification],
    ["Annual client / transaction volume", lead.transaction_volume],
    ["Application reference", lead.application_id],
  ]);
}

function attributionRows(lead: StageEmailLead): Row[] {
  return rows([
    ["Source", [lead.source, lead.page].filter(Boolean).join(" · ")],
    ["Campaign", [lead.utm_source, lead.utm_medium, lead.utm_campaign].filter(Boolean).join(" / ")],
    ["Landing page", lead.landing_page],
    ["Referrer", lead.referrer],
    ["Marketing consent", lead.marketing_consent],
  ]);
}

// ── Composition ────────────────────────────────────────────────────────────

export type ComposeInput = {
  lead: StageEmailLead;
  stage: LeadStage;
  audience: StageAudience;
  /** Mission Control's own origin, for the deep link on internal mail. */
  consoleUrl: string;
  /** Where an applicant continues. Omitted blocks render no dead button. */
  nextStepUrl?: string | null;
};

export function composeStageEmail(input: ComposeInput): ComposedEmail {
  return input.audience === "internal" ? composeInternal(input) : composeApplicant(input);
}

const STAGE_EYEBROW: Record<LeadStage, string> = {
  1: "Stage 1 · Priority access application",
  2: "Stage 2 · Business readiness questionnaire",
  3: "Stage 3 · Strategic review",
};

function composeInternal({ lead, stage, consoleUrl }: ComposeInput): ComposedEmail {
  const who = fullName(lead);
  const org = lead.entity_name ? ` — ${lead.entity_name}` : "";
  const leadLink = `${consoleUrl.replace(/\/+$/, "")}/leads${
    lead.application_id ? `?q=${encodeURIComponent(lead.application_id)}` : ""
  }`;

  const blocks: Block[] = [];
  let title: string;
  let subject: string;

  if (stage === 1) {
    title = "A new priority access application";
    subject = `[Aurixa] New application — ${who}${org}`;
    blocks.push({
      kind: "paragraph",
      text: `${who} applied for priority access${lead.entity_name ? ` on behalf of ${lead.entity_name}` : ""}. Nothing is owed yet — this is the record that they have asked.`,
    });
  } else if (stage === 2) {
    title = "Readiness questionnaire completed";
    subject = `[Aurixa] Questionnaire complete — ${who}${org}`;
    blocks.push({
      kind: "paragraph",
      text: `${who} has completed the Business Readiness Questionnaire. Their own answers are below in full; this is the most substantial account of their operation the funnel collects.`,
    });
  } else {
    title = "Strategic review booked";
    subject = `[Aurixa] Review booked — ${who}${org}`;
    const when = lead.stage3_host_local_time ?? auDateTime(lead.stage3_session_start);
    blocks.push({
      kind: "paragraph",
      text: when
        ? `${who} has booked a strategic review for ${when} (Australia/Sydney).`
        : `${who} has requested a strategic review.`,
    });
  }

  blocks.push({ kind: "rows", heading: "Applicant", rows: applicantRows(lead) });

  if (stage === 1) {
    blocks.push({
      kind: "rows",
      heading: "What they asked for",
      rows: rows([
        ["Priority areas to improve", lead.primary_areas],
        ["Submitted", auDateTime(lead.submitted_at ?? lead.created_at)],
      ]),
    });
    if (lead.tech_stack_bottlenecks) {
      blocks.push({
        kind: "prose",
        heading: "Current bottlenecks, in their words",
        text: lead.tech_stack_bottlenecks,
      });
    }
    if (lead.additional_notes) {
      blocks.push({ kind: "prose", heading: "Anything else", text: lead.additional_notes });
    }
  }

  if (stage === 2) {
    blocks.push({
      kind: "rows",
      heading: "Commercial signals",
      rows: rows([
        ["Preferred next step", lead.stage2_next_step],
        ["Approved investment range", lead.stage2_investment],
        ["Implementation start", lead.stage2_timeline],
        ["Users needing access", lead.stage2_user_count],
        ["Purchase authority", lead.stage2_authority],
        ["Completed", auDateTime(lead.stage2_completed_at)],
      ]),
    });
    blocks.push({
      kind: "rows",
      heading: "Operation",
      rows: rows([
        ["Office / entity structure", lead.stage2_entity_structure],
        ["Operating locations", lead.stage2_regions],
        ["Systems in use", lead.stage2_systems],
        ["Weekly admin time", lead.stage2_admin_time],
        ["Biggest problems", lead.stage2_problems],
        ["Capabilities wanted (ranked)", lead.stage2_capabilities],
        ["Systems to integrate", lead.stage2_integrations],
        ["Data migration", lead.stage2_migration],
        ["Security & procurement", lead.stage2_security],
      ]),
    });
    if (lead.stage2_difficult_workflow) {
      blocks.push({
        kind: "prose",
        heading: "The workflow causing them the most difficulty",
        text: lead.stage2_difficult_workflow,
      });
    }
  }

  if (stage === 3) {
    blocks.push({
      kind: "rows",
      heading: "The session",
      rows: rows([
        ["Aurixa local time", lead.stage3_host_local_time ?? auDateTime(lead.stage3_session_start)],
        ["Applicant local time", lead.stage3_local_time],
        ["Applicant time zone", lead.stage3_time_zone],
        [
          "Duration",
          lead.stage3_duration_minutes ? `${lead.stage3_duration_minutes} minutes` : null,
        ],
        ["Booking status", lead.stage3_status],
        ["Booking reference", lead.stage3_booking_reference],
        ["Requested", auDateTime(lead.stage3_booked_at)],
      ]),
    });
    if (lead.stage3_notes) {
      blocks.push({ kind: "prose", heading: "What they want to cover", text: lead.stage3_notes });
    }
    // A review is the first conversation, so the qualification travels with it.
    blocks.push({
      kind: "rows",
      heading: "From their questionnaire",
      rows: rows([
        ["Preferred next step", lead.stage2_next_step],
        ["Approved investment range", lead.stage2_investment],
        ["Implementation start", lead.stage2_timeline],
        ["Users needing access", lead.stage2_user_count],
        ["Capabilities wanted (ranked)", lead.stage2_capabilities],
      ]),
    });
  }

  blocks.push({ kind: "rows", heading: "How they found us", rows: attributionRows(lead) });
  blocks.push({ kind: "cta", label: "Open in Mission Control", href: leadLink });

  const footnote =
    "Sent by Aurixa Mission Control because this applicant reached a new stage of the priority-access funnel. Every figure above is the applicant's own answer — Mission Control has not scored, ranked or interpreted them.";

  return {
    subject,
    html: shell({
      preheader: `${who}${org} — ${STAGE_EYEBROW[stage]}`,
      eyebrow: STAGE_EYEBROW[stage],
      title,
      blocks,
      footnote,
    }),
    text: plain({ title, blocks, footnote }),
  };
}

function composeApplicant({ lead, stage, nextStepUrl }: ComposeInput): ComposedEmail {
  const firstName = (lead.first_name ?? "").trim();
  const greeting = firstName ? `Hello ${firstName},` : "Hello,";
  const blocks: Block[] = [];
  let title: string;
  let subject: string;
  let preheader: string;

  if (stage === 1) {
    title = "Your application has been received";
    subject = "Application received — Aurixa Systems priority access";
    preheader = "We have your priority access application. Here is what happens next.";
    blocks.push({ kind: "paragraph", text: greeting });
    blocks.push({
      kind: "paragraph",
      text: "Thank you for applying for priority access to Aurixa Systems. Your application has been received and is with our team for review.",
    });
    blocks.push({
      kind: "rows",
      heading: "Your application",
      rows: rows([
        ["Reference", lead.application_id],
        ["Organisation", lead.entity_name],
        ["Received", auDateTime(lead.submitted_at ?? lead.created_at)],
      ]),
    });
    blocks.push({
      kind: "paragraph",
      text: "The next step is the Business Readiness Questionnaire. It takes about ten minutes and is what lets us tell you precisely how Aurixa would fit your operation, rather than in general terms.",
    });
    if (nextStepUrl) {
      blocks.push({ kind: "cta", label: "Open the questionnaire", href: nextStepUrl });
    } else {
      blocks.push({
        kind: "paragraph",
        text: "We will email you a secure link to the questionnaire shortly.",
      });
    }
  } else if (stage === 2) {
    title = "Your questionnaire has been received";
    subject = "Questionnaire received — Aurixa Systems strategic review";
    preheader =
      "Your Business Readiness Questionnaire is in. The next step is your strategic review.";
    blocks.push({ kind: "paragraph", text: greeting });
    blocks.push({
      kind: "paragraph",
      text: "Thank you for completing the Business Readiness Questionnaire. Your answers have been recorded against your application and are now with our team.",
    });
    blocks.push({
      kind: "rows",
      heading: "Your application",
      rows: rows([
        ["Reference", lead.application_id],
        ["Organisation", lead.entity_name],
        ["Questionnaire completed", auDateTime(lead.stage2_completed_at)],
      ]),
    });
    blocks.push({
      kind: "paragraph",
      text: "The next step is a strategic review: a working session about your own operation, not a demonstration. We will come to it having read what you told us.",
    });
    if (nextStepUrl) {
      blocks.push({ kind: "cta", label: "Book your strategic review", href: nextStepUrl });
    } else {
      blocks.push({
        kind: "paragraph",
        text: "We will be in touch with times for your strategic review.",
      });
    }
  } else {
    title = "Your strategic review is confirmed";
    subject = "Strategic review confirmed — Aurixa Systems";
    preheader = "Your strategic review is in the diary. Here are the details.";
    const local = lead.stage3_local_time ?? auDateTime(lead.stage3_session_start);
    blocks.push({ kind: "paragraph", text: greeting });
    blocks.push({
      kind: "paragraph",
      text: local
        ? `Your strategic review is confirmed for ${local}${lead.stage3_time_zone ? ` (${lead.stage3_time_zone})` : ""}.`
        : "Your strategic review request has been received and is confirmed.",
    });
    blocks.push({
      kind: "rows",
      heading: "Your session",
      rows: rows([
        ["Your local time", lead.stage3_local_time],
        ["Time zone", lead.stage3_time_zone],
        ["Aurixa local time (Australia/Sydney)", lead.stage3_host_local_time],
        [
          "Duration",
          lead.stage3_duration_minutes ? `${lead.stage3_duration_minutes} minutes` : null,
        ],
        ["Reference", lead.application_id],
      ]),
    });
    blocks.push({
      kind: "paragraph",
      text: "We will send the meeting link separately. If you need to move the session, reply to this email and we will rearrange it.",
    });
  }

  const footnote =
    "Aurixa Systems · This message relates to your priority access application. Reply to this email if anything above is wrong and we will correct it.";

  return {
    subject,
    html: shell({ preheader, eyebrow: STAGE_EYEBROW[stage], title, blocks, footnote }),
    text: plain({ title, blocks, footnote }),
  };
}
