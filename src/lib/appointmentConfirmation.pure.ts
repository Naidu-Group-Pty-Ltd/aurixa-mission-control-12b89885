/**
 * What a booked appointment says, and to whom.
 *
 * ## Why this exists
 *
 * A booking used to tell nobody. `onAppointmentScheduled` advanced the journey
 * stage and queued the confirmation and reminder CALLS, and that was all — no
 * email, no operator notification. Meanwhile every booking agent's prompt
 * promises the caller that "the team confirms by email, usually within one
 * business day, and the calendar invitation follows separately". That sentence
 * was true only while a person happened to be watching the tracker.
 *
 * ## The rules it holds
 *
 * **An absent address is not a failure.** `crm_contacts.email` is null on
 * every contact the voice path ever created, because `resolve_contact`
 * declared an `email` parameter and never read it. Those rows are not going to
 * fill in retrospectively, so "no email" is an ordinary outcome that must
 * still leave the operator notified — the notice is what makes the promise
 * keepable by hand.
 *
 * **Nothing here decides that a message was sent.** It composes and it
 * refuses; the caller owns the send and its four-way outcome. Keeping the two
 * apart is what makes this testable without a mailbox.
 *
 * **The prose never claims more than the platform does.** It confirms what was
 * booked and says the invitation follows separately — the same wording the
 * agent already spoke — rather than presenting itself as the invitation, which
 * nothing here creates.
 */
import { renderTemplate } from "@/lib/email/mergeTemplate.pure";

export type AppointmentConfirmationInput = {
  /** `SESSION_LABEL[kind]`, e.g. "strategic review". Null for an unmapped kind. */
  sessionLabel: string | null;
  /** ISO timestamp from `crm_appointments.starts_at`. */
  startsAt: string;
  /** IANA zone from `crm_appointments.timezone`. */
  timezone: string;
  firstName: string;
  fullName: string;
  /** `crm_contacts.email`, which is null for most voice-created contacts. */
  email: string | null;
  /** `isGraphConfigured()` — the credential, not the mailbox. */
  graphConfigured: boolean;
  /** `defaultMailbox()` — the address the send would come from. */
  mailbox: string | null;
};

export type ConfirmationPlan =
  | { send: false; reason: "no_email" | "not_configured" | "unreadable_time" }
  | {
      send: true;
      to: string;
      subject: string;
      text: string;
      html: string;
      mailbox: string;
    };

/** The generic name used when an appointment kind has no label of its own. */
const FALLBACK_LABEL = "session";

/**
 * The appointment's time as a person in that zone would say it.
 *
 * Returns null on an unparseable timestamp or an unknown zone rather than
 * throwing — a bad zone must not take down the booking that already succeeded,
 * and `Intl` throws a RangeError on a zone it does not know.
 */
export function formatAppointmentWhen(startsAt: string, timezone: string): string | null {
  const when = new Date(startsAt);
  if (Number.isNaN(when.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(when);
  } catch {
    return null;
  }
}

const SUBJECT = "Your {{session}} is booked — {{when}}";

const TEXT_BODY = [
  "Hi {{firstName}},",
  "",
  "Your {{session}} is booked for {{when}} ({{timezone}}).",
  "",
  "The calendar invitation follows separately from this email. If the time no",
  "longer suits, reply to this message and we will move it.",
  "",
  "Aurixa Systems",
].join("\n");

const HTML_BODY = [
  "<p>Hi {{firstName}},</p>",
  "<p>Your {{session}} is booked for <strong>{{when}}</strong> ({{timezone}}).</p>",
  "<p>The calendar invitation follows separately from this email. If the time no",
  "longer suits, reply to this message and we will move it.</p>",
  "<p>Aurixa Systems</p>",
].join("\n");

/**
 * Whether to email the caller, and what to send.
 *
 * The three refusals are kept apart because they send an operator to different
 * places: `no_email` is a record that never captured one, `not_configured` is
 * this deployment's Graph credential or mailbox, and `unreadable_time` is a
 * row whose `starts_at` or `timezone` cannot be read — which is worth seeing
 * rather than papering over with a raw ISO string.
 */
export function planConfirmationEmail(input: AppointmentConfirmationInput): ConfirmationPlan {
  const to = (input.email ?? "").trim();
  if (!to) return { send: false, reason: "no_email" };
  if (!input.graphConfigured || !input.mailbox) return { send: false, reason: "not_configured" };

  const when = formatAppointmentWhen(input.startsAt, input.timezone);
  if (!when) return { send: false, reason: "unreadable_time" };

  const session = input.sessionLabel ?? FALLBACK_LABEL;
  // `firstName` can be empty on a contact created from a name the caller never
  // gave; "Hi ," reads as a broken template, so the greeting degrades to the
  // one word rather than to a dangling comma.
  const firstName = input.firstName.trim() || "there";
  const context = { session, when, timezone: input.timezone, firstName };

  return {
    send: true,
    to,
    mailbox: input.mailbox,
    // The subject is plain text in the wire format, so it is rendered unescaped
    // on both paths; only the HTML body escapes.
    subject: renderTemplate(SUBJECT, context, { html: false }),
    text: renderTemplate(TEXT_BODY, context, { html: false }),
    html: renderTemplate(HTML_BODY, context, { html: true }),
  };
}

export type OperatorNotice = { title: string; body: string };

/**
 * What the operators are told, which is ALWAYS — including, and especially,
 * when no email could go.
 *
 * The body names the email outcome, because the operator is the fallback for
 * the promise the agent made on the call. A notice that said only "booked"
 * would leave them no way to know whether the customer has heard anything.
 */
export function operatorBookingNotice(
  input: AppointmentConfirmationInput,
  plan: ConfirmationPlan,
): OperatorNotice {
  const session = input.sessionLabel ?? FALLBACK_LABEL;
  const who = input.fullName.trim() || input.firstName.trim() || "An unnamed contact";
  const when = formatAppointmentWhen(input.startsAt, input.timezone);

  const emailLine = plan.send
    ? `A confirmation email was addressed to ${plan.to}.`
    : plan.reason === "no_email"
      ? "No email address is on record, so nobody has written to them yet."
      : plan.reason === "not_configured"
        ? "No confirmation email was sent: this deployment has no mailbox configured."
        : "No confirmation email was sent: the appointment time could not be read.";

  return {
    title: `${who} booked a ${session}`,
    body: when ? `${when} (${input.timezone}). ${emailLine}` : emailLine,
  };
}
