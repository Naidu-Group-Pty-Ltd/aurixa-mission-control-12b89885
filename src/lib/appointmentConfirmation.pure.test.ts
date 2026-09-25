// What a booked appointment says, and to whom. All pure — no mailbox, no
// Supabase. The rule these pin is that an absent address is an ordinary
// outcome that still reaches an operator, because that is the state every
// voice-created contact is in.
import { describe, expect, it } from "vitest";
import {
  formatAppointmentWhen,
  operatorBookingNotice,
  planConfirmationEmail,
  type AppointmentConfirmationInput,
} from "./appointmentConfirmation.pure";

// 2026-09-18T03:00:00Z is Friday 18 September, 1:00 pm in Sydney — September
// is AEST (UTC+10), DST starts on the first Sunday in October, so this instant
// is unambiguous.
const STARTS_AT = "2026-09-18T03:00:00Z";

const base: AppointmentConfirmationInput = {
  sessionLabel: "strategic review",
  startsAt: STARTS_AT,
  timezone: "Australia/Sydney",
  firstName: "Jane",
  fullName: "Jane Citizen",
  email: "jane@example.com",
  graphConfigured: true,
  mailbox: "hello@aurixasystems.com.au",
};

describe("formatAppointmentWhen", () => {
  it("reads the instant in the appointment's own zone", () => {
    const when = formatAppointmentWhen(STARTS_AT, "Australia/Sydney");
    expect(when).toContain("Friday");
    expect(when).toContain("18");
    expect(when).toContain("September");
    expect(when).toContain("1:00");
  });

  it("returns null rather than throwing on a zone Intl does not know", () => {
    // A RangeError here would take down a booking that has already been
    // written, which is the one thing this must never do.
    expect(formatAppointmentWhen(STARTS_AT, "Not/AZone")).toBeNull();
  });

  it("returns null on an unreadable timestamp", () => {
    expect(formatAppointmentWhen("not a date", "Australia/Sydney")).toBeNull();
  });
});

describe("planConfirmationEmail", () => {
  it("composes the message when there is an address and a mailbox", () => {
    const plan = planConfirmationEmail(base);
    expect(plan.send).toBe(true);
    if (!plan.send) throw new Error("unreachable");
    expect(plan.to).toBe("jane@example.com");
    expect(plan.mailbox).toBe("hello@aurixasystems.com.au");
    expect(plan.subject).toContain("strategic review");
    expect(plan.subject).toContain("Friday");
    expect(plan.text).toContain("Hi Jane,");
    expect(plan.html).toContain("<strong>");
  });

  it("says the invitation comes separately rather than being one", () => {
    // Cal.com sends the invitation for a booking it holds, and a tracker
    // booking has none, so this email must never read as the invitation — this
    // is the same sentence the agent speaks on the call.
    const plan = planConfirmationEmail(base);
    if (!plan.send) throw new Error("unreachable");
    expect(plan.text).toContain("calendar invitation follows separately");
    expect(plan.html).toContain("calendar invitation follows separately");
  });

  it("keeps the three refusals apart", () => {
    expect(planConfirmationEmail({ ...base, email: null })).toEqual({
      send: false,
      reason: "no_email",
    });
    expect(planConfirmationEmail({ ...base, email: "   " })).toEqual({
      send: false,
      reason: "no_email",
    });
    expect(planConfirmationEmail({ ...base, graphConfigured: false })).toEqual({
      send: false,
      reason: "not_configured",
    });
    expect(planConfirmationEmail({ ...base, mailbox: null })).toEqual({
      send: false,
      reason: "not_configured",
    });
    expect(planConfirmationEmail({ ...base, timezone: "Not/AZone" })).toEqual({
      send: false,
      reason: "unreadable_time",
    });
  });

  it("escapes the HTML body and leaves the text body alone", () => {
    const plan = planConfirmationEmail({ ...base, firstName: "Jane & Co <script>" });
    if (!plan.send) throw new Error("unreachable");
    expect(plan.html).toContain("Jane &amp; Co");
    expect(plan.html).not.toContain("<script>");
    expect(plan.text).toContain("Jane & Co <script>");
  });

  it("degrades a missing first name to a greeting rather than a dangling comma", () => {
    const plan = planConfirmationEmail({ ...base, firstName: "  " });
    if (!plan.send) throw new Error("unreachable");
    expect(plan.text).toContain("Hi there,");
    expect(plan.text).not.toContain("Hi ,");
  });

  it("carries the video link Cal.com issued, in both bodies", () => {
    const url = "https://app.cal.com/video/abc123";
    const plan = planConfirmationEmail({ ...base, meetingUrl: url });
    if (!plan.send) throw new Error("unreachable");
    expect(plan.text).toContain(`Join the video call: ${url}`);
    expect(plan.html).toContain(`<a href="${url}">${url}</a>`);
    // The invitation sentence survives: the link is an addition, not a
    // replacement for the invitation Cal.com sends.
    expect(plan.text).toContain("calendar invitation follows separately");
  });

  it("says nothing about a link when there is none, rather than an empty line", () => {
    for (const meetingUrl of [undefined, null, "", "   "]) {
      const plan = planConfirmationEmail({ ...base, meetingUrl });
      if (!plan.send) throw new Error("unreachable");
      expect(plan.text).not.toContain("Join the video call");
      expect(plan.html).not.toContain("href");
    }
  });

  it("refuses a link that is not http(s), because it is written into an href", () => {
    for (const meetingUrl of ["javascript:alert(1)", "data:text/html,x", 'https://x" onclick="y']) {
      const plan = planConfirmationEmail({ ...base, meetingUrl });
      if (!plan.send) throw new Error("unreachable");
      expect(plan.html).not.toContain("href");
      expect(plan.text).not.toContain("Join the video call");
    }
  });

  it("names an unmapped appointment kind generically instead of leaving a hole", () => {
    const plan = planConfirmationEmail({ ...base, sessionLabel: null });
    if (!plan.send) throw new Error("unreachable");
    expect(plan.subject).toContain("session");
    expect(plan.subject).not.toContain("{{");
  });
});

describe("operatorBookingNotice", () => {
  it("names the booking and says the email went", () => {
    const plan = planConfirmationEmail(base);
    const notice = operatorBookingNotice(base, plan);
    expect(notice.title).toBe("Jane Citizen booked a strategic review");
    expect(notice.body).toContain("jane@example.com");
    expect(notice.body).toContain("Friday");
  });

  it("is produced when no email could go, and says which absence it was", () => {
    // This is the case that matters: crm_contacts.email is null on every
    // contact the voice path created, so for those bookings this notice IS the
    // confirmation channel.
    const input = { ...base, email: null };
    const notice = operatorBookingNotice(input, planConfirmationEmail(input));
    expect(notice.title).toBe("Jane Citizen booked a strategic review");
    expect(notice.body).toContain("No email address is on record");

    const unconfigured = { ...base, graphConfigured: false };
    expect(operatorBookingNotice(unconfigured, planConfirmationEmail(unconfigured)).body).toContain(
      "no mailbox configured",
    );
  });

  it("falls back through the names rather than reading as a broken row", () => {
    const anonymous = { ...base, fullName: "  ", firstName: "  " };
    expect(operatorBookingNotice(anonymous, planConfirmationEmail(anonymous)).title).toBe(
      "An unnamed contact booked a strategic review",
    );
  });

  it("hands the operator the video link where there is one", () => {
    const input = { ...base, meetingUrl: "https://app.cal.com/video/abc123" };
    const notice = operatorBookingNotice(input, planConfirmationEmail(input));
    expect(notice.body).toContain("Video call: https://app.cal.com/video/abc123");
    expect(operatorBookingNotice(base, planConfirmationEmail(base)).body).not.toContain(
      "Video call",
    );
  });

  it("still reports the email outcome when the time cannot be read", () => {
    const input = { ...base, timezone: "Not/AZone" };
    const notice = operatorBookingNotice(input, planConfirmationEmail(input));
    expect(notice.body).toContain("could not be read");
  });
});
