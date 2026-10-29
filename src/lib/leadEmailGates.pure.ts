// The send gates: whether an applicant's email may go, and if not, why.
//
// Until Mission Control sent the applicant's emails, these rules lived in the
// Airtable base `apptyShYE0yzL4IGB` (NPC Emails) as formula fields, and the
// Make scenarios filtered on them after re-reading the record twenty seconds
// after the event. The formulas are recreated here condition for condition, in
// Airtable's own order, with Airtable's own hold reasons — read from the
// 2026-08-18 schema export in
// `npc-property-dashbord/docs/integrations/airtable/npc-emails/schema/base-schema.source.json`:
//
//   Stage 1 email  ← `Aurixa Waitlist.Send Stage 2 Invite`
//                    (+ `Stage 2 Invite Hold Reason`)
//   Stage 2 email  ← `Aurixa Waitlist.Send Stage 3 Invite`
//                    (+ `Stage 3 Invite Hold Reason`) — the Stage 2 email IS the
//                    strategic review invitation: it carries the booking link
//                    `Stage 3 Booking URL` builds
//   Stage 3 email  ← `Strategic Review Bookings.Send Booking Confirmation`
//                    (+ `Booking Confirmation Hold Reason`)
//
// Airtable's inputs, and what stands for each here:
//
//   {Stage 2 Reached}            a questionnaire is in: `stage2_completed_at`
//   {Status} = "Declined"        the lead is Disqualified on the Leads page, or
//                                the mirror read Declined from Airtable
//   {Application ID}             `application_id`
//   {Corporate Email}            `email`
//   {Stage 3 Reached}            a booking that counts (`Counts As Booked`): booked,
//                                with a time, not cancelled, not a no-show
//   {Stage 3 Invite Count}       `stage3_invite_count`, as Make recorded it
//   {Confirmation Message ID}    `stage3_confirmation_sent_at` — Make's receipt.
//                                Mission Control's own send is its ledger row,
//                                which is unique per applicant and stage
//   {Booking Status} = Cancelled `stage3_cancelled_at` (Cal.com told Mission
//                                Control), or the status read as cancelled
//   {Requested Start (UTC)}      `stage3_session_start`
//
// Pure: the dispatcher, the policy and the console read the same rules.

export type GateStage = 1 | 2 | 3;

export type GateSubject = {
  email?: string | null;
  application_id?: string | null;
  /** Mission Control's own lead status: `disqualified` is Airtable's Declined. */
  status?: string | null;
  /** Airtable's `Status`, as the mirror last read it. */
  airtable_status?: string | null;
  stage2_completed_at?: string | null;
  stage3_booked_at?: string | null;
  stage3_session_start?: string | null;
  stage3_status?: string | null;
  stage3_cancelled_at?: string | null;
  stage3_confirmation_sent_at?: string | null;
  stage3_invite_count?: number | null;
};

export type GateVerdict = { send: true } | { send: false; reason: string };

/** Airtable's `Stage 3 Invite Count >= 3`. */
export const STAGE3_INVITE_LIMIT = 3;

const present = (value: unknown) =>
  typeof value === "string" ? value.trim() !== "" : value != null;

/** `{Status} = "Declined"`. Declining an applicant is now Disqualified on the Leads page. */
export function isDeclined(lead: GateSubject): boolean {
  return (
    (lead.status ?? "").trim().toLowerCase() === "disqualified" ||
    (lead.airtable_status ?? "").trim().toLowerCase() === "declined"
  );
}

/** `{Stage 2 Reached} = 1`: a questionnaire response exists. */
export function hasReachedStage2(lead: GateSubject): boolean {
  return present(lead.stage2_completed_at);
}

/** `{Booking Status} = "Cancelled"`, from Cal.com or from Airtable. */
export function isBookingCancelled(lead: GateSubject): boolean {
  return present(lead.stage3_cancelled_at) || /^cancel/i.test((lead.stage3_status ?? "").trim());
}

/**
 * `Counts As Booked` → `{Stage 3 Reached}`: a booking with a time that was not
 * cancelled and not missed.
 */
export function countsAsBooked(lead: GateSubject): boolean {
  if (!present(lead.stage3_booked_at) || !present(lead.stage3_session_start)) return false;
  if (isBookingCancelled(lead)) return false;
  return !/^no[\s_-]?show/i.test((lead.stage3_status ?? "").trim());
}

const hold = (reason: string): GateVerdict => ({ send: false, reason });
const SEND: GateVerdict = { send: true };

/** `Send Stage 2 Invite` — the Stage 1 email, with the questionnaire link. */
export function applicationReceivedGate(lead: GateSubject): GateVerdict {
  if (hasReachedStage2(lead)) return hold("Applicant already reached Stage 2");
  if (isDeclined(lead)) return hold("Application declined");
  if (!present(lead.application_id)) return hold("No Application ID on the record");
  if (!present(lead.email)) return hold("No corporate email to send to");
  return SEND;
}

/** `Send Stage 3 Invite` — the Stage 2 email, with the strategic review link. */
export function reviewInvitationGate(lead: GateSubject): GateVerdict {
  if (countsAsBooked(lead)) return hold("Applicant already booked a strategic review");
  if (!hasReachedStage2(lead)) return hold("Applicant has not reached Stage 2 yet");
  if (isDeclined(lead)) return hold("Application declined");
  if (!present(lead.application_id)) return hold("No Application ID on the record");
  if (!present(lead.email)) return hold("No corporate email to send to");
  if ((lead.stage3_invite_count ?? 0) >= STAGE3_INVITE_LIMIT)
    return hold("Invitation limit reached");
  return SEND;
}

/** `Send Booking Confirmation` — the Stage 3 email. */
export function bookingConfirmationGate(lead: GateSubject): GateVerdict {
  if (present(lead.stage3_confirmation_sent_at)) return hold("Confirmation already sent");
  if (isBookingCancelled(lead)) return hold("Booking cancelled");
  if (!present(lead.email)) return hold("No applicant email to send to");
  if (!present(lead.stage3_session_start)) return hold("No requested time on the booking");
  return SEND;
}

export function sendGate(lead: GateSubject, stage: GateStage): GateVerdict {
  return stage === 1
    ? applicationReceivedGate(lead)
    : stage === 2
      ? reviewInvitationGate(lead)
      : bookingConfirmationGate(lead);
}

/** What the ledger records for a held email: the gate's reason, said as such. */
export const heldReason = (reason: string) => `held by the send gate: ${reason}`;

/**
 * Each gate's conditions, in order, for Email → Lead emails. The first that
 * holds is the reason recorded.
 */
export const GATE_RULES: Record<
  GateStage,
  { airtable: string; holds: { reason: string; when: string }[] }
> = {
  1: {
    airtable: "Send Stage 2 Invite",
    holds: [
      {
        reason: "Applicant already reached Stage 2",
        when: "The questionnaire is already in — an invitation to it is the wrong email.",
      },
      { reason: "Application declined", when: "The lead is Disqualified on the Leads page." },
      { reason: "No Application ID on the record", when: "The questionnaire link needs it." },
      { reason: "No corporate email to send to", when: "There is nobody to send it to." },
    ],
  },
  2: {
    airtable: "Send Stage 3 Invite",
    holds: [
      {
        reason: "Applicant already booked a strategic review",
        when: "A booking with a time, not cancelled and not missed, is already in.",
      },
      { reason: "Applicant has not reached Stage 2 yet", when: "No questionnaire is in." },
      { reason: "Application declined", when: "The lead is Disqualified on the Leads page." },
      { reason: "No Application ID on the record", when: "The booking link needs it." },
      { reason: "No corporate email to send to", when: "There is nobody to send it to." },
      {
        reason: "Invitation limit reached",
        when: `Make had already invited them ${STAGE3_INVITE_LIMIT} times.`,
      },
    ],
  },
  3: {
    airtable: "Send Booking Confirmation",
    holds: [
      { reason: "Confirmation already sent", when: "Make already confirmed this booking." },
      {
        reason: "Booking cancelled",
        when: "Cal.com reported the booking cancelled, or its status reads Cancelled.",
      },
      { reason: "No applicant email to send to", when: "There is nobody to send it to." },
      { reason: "No requested time on the booking", when: "There is no time to confirm." },
    ],
  },
};
