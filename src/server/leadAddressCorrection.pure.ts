/**
 * Whether a Stage 1 application that arrives again, under the same reference
 * and a different address, is the applicant correcting a mistyped email
 * (docs/LEAD_EMAILS.md, "Address corrections").
 *
 * The website's confirmation screen says where the Stage 1 email went and
 * offers "Not the right email address? Correct it". The corrected application
 * is posted under the SAME reference, so the applicant is not entered twice.
 * Mission Control answered that post `duplicate` and changed nothing: the
 * acknowledgement and the questionnaire link had gone to the mistyped address,
 * and the applicant was never sent them at the one they meant.
 *
 * A correction is accepted only while it can be nothing else. The application
 * is the one just made (within a day), the applicant has not reached the
 * questionnaire — after that the address has been used to identify them — the
 * lead is not declined, and it has not been corrected more than a few times.
 * Anything else is refused, and the team is told, rather than quietly
 * re-addressing an application somebody else is working.
 */
import { emailKey } from "@/lib/email/emailAddress.pure";
import { hasReachedStage2, isDeclined, type GateSubject } from "@/lib/leadEmailGates.pure";

/** How long after applying the website's correction is honoured. */
export const ADDRESS_CORRECTION_WINDOW_MS = 24 * 3_600_000;

/** How many times one application's address may be corrected. */
export const ADDRESS_CORRECTION_LIMIT = 3;

/** The reason an applicant email for an address no longer theirs is not sent. */
export const SUPERSEDED_REASON = "superseded: the applicant corrected their address";

export type CorrectionSubject = GateSubject & {
  created_at?: string | null;
  stage?: number | null;
  applicant_email_generation?: number | null;
};

export type CorrectionRefusal =
  | "window_closed"
  | "questionnaire_reached"
  | "declined"
  | "too_many_corrections";

export type AddressCorrection =
  /** The same address: the same application delivered twice. */
  | { kind: "same_address" }
  | { kind: "correct"; from: string; to: string; generation: number }
  | { kind: "refused"; reason: CorrectionRefusal; from: string; to: string };

/** What the team is told a refusal means, in the words of the record. */
export const REFUSAL_TEXT: Record<CorrectionRefusal, string> = {
  window_closed: "the application was made more than a day ago",
  questionnaire_reached: "the applicant has already reached the questionnaire",
  declined: "the application is declined",
  too_many_corrections: `the address has already been corrected ${ADDRESS_CORRECTION_LIMIT} times`,
};

/** The address generation a lead's applicant emails are for. Absent is 0. */
export function addressGeneration(
  lead: { applicant_email_generation?: unknown } | Record<string, unknown>,
): number {
  const n = Number(
    (lead as { applicant_email_generation?: unknown }).applicant_email_generation ?? 0,
  );
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function decideAddressCorrection(
  existing: CorrectionSubject,
  incomingEmail: string,
  now: number,
): AddressCorrection {
  const from = (existing.email ?? "").trim();
  const to = incomingEmail.trim();
  // One reading of an address, the sender's: `Jo@Firm` and `jo@firm` are the
  // same applicant, and a redelivery of the same application is not a change.
  if (emailKey(from) === emailKey(to)) return { kind: "same_address" };

  const refused = (reason: CorrectionRefusal): AddressCorrection => ({
    kind: "refused",
    reason,
    from,
    to,
  });
  if (isDeclined(existing)) return refused("declined");
  if (
    hasReachedStage2(existing) ||
    Boolean(existing.stage3_booked_at) ||
    Number(existing.stage ?? 1) >= 2
  ) {
    return refused("questionnaire_reached");
  }
  const applied = Date.parse(existing.created_at ?? "");
  // An application with no readable creation time cannot be shown to be the
  // one just made, so it is not re-addressed.
  if (!Number.isFinite(applied) || now - applied > ADDRESS_CORRECTION_WINDOW_MS) {
    return refused("window_closed");
  }
  const generation = addressGeneration(existing);
  if (generation >= ADDRESS_CORRECTION_LIMIT) return refused("too_many_corrections");
  return { kind: "correct", from, to, generation: generation + 1 };
}
