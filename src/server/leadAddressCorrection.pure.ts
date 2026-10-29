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
 * A correction is accepted only while it can be nothing else:
 *
 *  - it comes from the browser that made the application. The reference is
 *    not a secret — it is printed in the Stage 1 email, which went to the
 *    mistyped address — so the 201 that accepted the application carried a
 *    one-time correction token, kept only as its hash, and the correction must
 *    present it (`correctionToken`). Anybody else is refused, quietly;
 *  - it is newer than the application it corrects. A late copy of the
 *    original is the same application, not a correction back to it;
 *  - the application is the one just made (within a day), the applicant has
 *    not reached the questionnaire — after that the address has been used to
 *    identify them — the lead is not declined, and it has not been corrected
 *    more than a few times. Past those the applicant is refused and the team
 *    is told, with the address the applicant gave, rather than an application
 *    somebody else is working being quietly re-addressed.
 */
import { emailKey } from "@/lib/email/emailAddress.pure";
import { hasReachedStage2, isDeclined, type GateSubject } from "@/lib/leadEmailGates.pure";

/** How long after applying the website's correction is honoured. */
export const ADDRESS_CORRECTION_WINDOW_MS = 24 * 3_600_000;

/** How many times one application's address may be corrected. */
export const ADDRESS_CORRECTION_LIMIT = 3;

/** Where the correction token's hash is kept: the lead's own metadata. */
export const CORRECTION_TOKEN_KEY = "correction_token_sha256";

/**
 * Metadata only Mission Control writes, which every other writer of the lead
 * keeps: the correction token's hash and the record of corrections. The
 * Airtable mirror replaces a lead's metadata with its own, and would otherwise
 * take the applicant's right to correct with it.
 */
export const MISSION_CONTROL_METADATA_KEYS = [CORRECTION_TOKEN_KEY, "email_corrections"] as const;

/** A correction token as a browser may send one: base64url, long enough to guess at nothing. */
export const CORRECTION_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,128}$/;

/** The reason an applicant email for an address no longer theirs is not sent. */
export const SUPERSEDED_REASON = "superseded: the applicant corrected their address";

export type CorrectionSubject = GateSubject & {
  created_at?: string | null;
  submitted_at?: string | null;
  stage?: number | null;
  applicant_email_generation?: number | null;
};

export type CorrectionRefusal =
  | "unverified"
  | "window_closed"
  | "questionnaire_reached"
  | "declined"
  | "too_many_corrections";

export type AddressCorrection =
  /** The same address: the same application delivered twice. */
  | { kind: "same_address" }
  /** Older than the application on record: a late copy, not a correction. */
  | { kind: "stale" }
  | { kind: "correct"; from: string; to: string; generation: number }
  | { kind: "refused"; reason: CorrectionRefusal; from: string; to: string };

/** What the team is told a refusal means, in the words of the record. */
export const REFUSAL_TEXT: Record<CorrectionRefusal, string> = {
  unverified: "it did not come from the browser that made the application",
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
  incoming: { email: string; submittedAt: string | null; verified: boolean },
  now: number,
): AddressCorrection {
  const from = (existing.email ?? "").trim();
  const to = incoming.email.trim();
  // One reading of an address, the sender's: `Jo@Firm` and `jo@firm` are the
  // same applicant, and a redelivery of the same application is not a change.
  if (emailKey(from) === emailKey(to)) return { kind: "same_address" };
  // The website stamps `submittedAt` on every submission, so a correction is
  // always the later of the two. A copy of the original that arrives after
  // the correction would otherwise re-address the lead back to the typo.
  const incomingAt = Date.parse(incoming.submittedAt ?? "");
  const onRecordAt = Date.parse(existing.submitted_at ?? "");
  if (Number.isFinite(incomingAt) && Number.isFinite(onRecordAt) && incomingAt <= onRecordAt) {
    return { kind: "stale" };
  }

  const refused = (reason: CorrectionRefusal): AddressCorrection => ({
    kind: "refused",
    reason,
    from,
    to,
  });
  if (!incoming.verified) return refused("unverified");
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

/**
 * The address a lead was last corrected to, from its own record
 * (`metadata.email_corrections`), for readers that must not put the mistyped
 * one back — the Airtable mirror holds the application as first made.
 */
export function correctedAddressOf(
  metadata: unknown,
): { email: string; generation: number } | null {
  const history = (metadata as { email_corrections?: unknown } | null)?.email_corrections;
  if (!Array.isArray(history) || history.length === 0) return null;
  const last = history[history.length - 1] as { to?: unknown; generation?: unknown };
  const email = typeof last?.to === "string" ? last.to.trim() : "";
  const generation = Number(last?.generation);
  if (!email || !Number.isInteger(generation) || generation < 1) return null;
  return { email, generation };
}
