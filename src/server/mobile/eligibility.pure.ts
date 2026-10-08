/**
 * Who may activate a native app — Draft 02 §11, implemented once.
 *
 *   native_activation_eligible =
 *     cohort_enabled AND provisioning_verified
 *     AND server_now >= effective_trial_end
 *     AND qualifying_payment_verified
 *     AND required_subscription_current
 *     AND portal_licensed
 *     AND NOT suspended
 *
 * Four rules carry it.
 *
 * - **The clock is the SERVER's.** `now` is passed in by the caller from its
 *   own clock; a device never says what time it is here.
 * - **The trial is its own fourteen days**, measured from the trial-start
 *   event recorded on the gateway row plus any authorised extension hours. It
 *   is independent of the 72-hour activation gate and is never backfilled: a
 *   clone that has no trial-start event has no trial end and is `unknown`.
 * - **Unknown grants nothing.** A fact nobody could read (`null`) resolves to
 *   `unknown`, which is a refusal — never to the permissive side.
 * - **A legacy clone is let in only by evidence.** A clone born before the
 *   gateway with no gate row gets no retrial and no recharge: it needs a
 *   verified payment or an attributed exception, and the exception is the
 *   ONLY input that can stand in for the trial and the payment. It never
 *   stands in for the licence or a suspension.
 */

export const TRIAL_HOURS = 14 * 24;

export type EligibilityCode =
  | "ELIGIBLE"
  | "COHORT_DISABLED"
  | "PROVISIONING_UNVERIFIED"
  | "TRIAL_NOT_ENDED"
  | "PAYMENT_NOT_VERIFIED"
  | "ENTITLEMENT_UNAVAILABLE"
  | "PORTAL_NOT_LICENSED"
  | "SUSPENDED";

export type EligibilityFacts = {
  cohortEnabled: boolean | null;
  provisioningVerified: boolean | null;
  /** The trial-start event. Null = never recorded. */
  trialStartedAt: string | Date | null;
  /** Authorised extensions, in hours. Negative values are refused as unknown. */
  trialExtensionHours: number | null;
  /** Server-side "now". */
  now: string | Date;
  /** The activation payment (gate `paid_at` or an equivalent verified charge). */
  paymentVerified: boolean | null;
  /** Subscription current per Stripe; null = could not be read. */
  subscriptionCurrent: boolean | null;
  portalLicensed: boolean | null;
  suspended: boolean | null;
  legacyClone: boolean;
  /** An attributed operator exception (granted_by + reason enforced by the column). */
  exceptionGrantedAt: string | Date | null;
};

export type EligibilityVerdict = {
  outcome: "eligible" | "denied" | "unknown";
  code: EligibilityCode;
  /** ISO time the trial ends, where it can be computed. */
  effectiveTrialEnd: string | null;
  /** A sentence about the WORKSPACE, never about the person asking. */
  message: string;
};

function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function effectiveTrialEnd(
  trialStartedAt: string | Date | null,
  trialExtensionHours: number | null,
): string | null {
  const start = toMs(trialStartedAt);
  if (start === null) return null;
  const ext = trialExtensionHours ?? 0;
  if (!Number.isFinite(ext) || ext < 0) return null;
  return new Date(start + (TRIAL_HOURS + ext) * 3_600_000).toISOString();
}

const MESSAGES: Record<EligibilityCode, string> = {
  ELIGIBLE: "This workspace may activate the app.",
  COHORT_DISABLED: "Native apps are not yet enabled for this workspace.",
  PROVISIONING_UNVERIFIED: "This workspace has not finished being set up.",
  TRIAL_NOT_ENDED:
    "The app becomes available when this workspace's trial ends and its plan is active.",
  PAYMENT_NOT_VERIFIED: "This workspace's plan has not been paid for yet.",
  ENTITLEMENT_UNAVAILABLE: "This workspace's subscription could not be confirmed.",
  PORTAL_NOT_LICENSED: "This workspace is not licensed for this app.",
  SUSPENDED: "Access to this workspace's apps is suspended.",
};

function verdict(
  outcome: EligibilityVerdict["outcome"],
  code: EligibilityCode,
  trialEnd: string | null,
): EligibilityVerdict {
  return { outcome, code, effectiveTrialEnd: trialEnd, message: MESSAGES[code] };
}

/**
 * Order matters only for which reason is NAMED. Every condition is required,
 * so the order is chosen to name the thing an operator can act on first:
 * a suspension or a missing licence outranks a clock.
 */
export function assessNativeEligibility(facts: EligibilityFacts): EligibilityVerdict {
  const trialEnd = effectiveTrialEnd(facts.trialStartedAt, facts.trialExtensionHours);
  const now = toMs(facts.now);
  const hasException = toMs(facts.exceptionGrantedAt) !== null;

  if (facts.suspended === true) return verdict("denied", "SUSPENDED", trialEnd);
  if (facts.suspended === null) return verdict("unknown", "SUSPENDED", trialEnd);

  if (facts.cohortEnabled === false) return verdict("denied", "COHORT_DISABLED", trialEnd);
  if (facts.cohortEnabled === null) return verdict("unknown", "COHORT_DISABLED", trialEnd);

  if (facts.provisioningVerified === false)
    return verdict("denied", "PROVISIONING_UNVERIFIED", trialEnd);
  if (facts.provisioningVerified === null)
    return verdict("unknown", "PROVISIONING_UNVERIFIED", trialEnd);

  if (facts.portalLicensed === false) return verdict("denied", "PORTAL_NOT_LICENSED", trialEnd);
  if (facts.portalLicensed === null) return verdict("unknown", "PORTAL_NOT_LICENSED", trialEnd);

  if (now === null) return verdict("unknown", "TRIAL_NOT_ENDED", trialEnd);

  // The exception is the one stand-in for the trial and the payment.
  if (hasException) return verdict("eligible", "ELIGIBLE", trialEnd);

  if (facts.legacyClone) {
    // No retrial: a legacy clone has no trial clock to wait out, only
    // evidence of payment.
    if (facts.paymentVerified !== true) {
      return verdict(
        facts.paymentVerified === null ? "unknown" : "denied",
        "PAYMENT_NOT_VERIFIED",
        trialEnd,
      );
    }
  } else {
    if (trialEnd === null) return verdict("unknown", "TRIAL_NOT_ENDED", null);
    if (now < Date.parse(trialEnd)) return verdict("denied", "TRIAL_NOT_ENDED", trialEnd);
    if (facts.paymentVerified === false) return verdict("denied", "PAYMENT_NOT_VERIFIED", trialEnd);
    if (facts.paymentVerified === null) return verdict("unknown", "PAYMENT_NOT_VERIFIED", trialEnd);
  }

  if (facts.subscriptionCurrent === false)
    return verdict("denied", "ENTITLEMENT_UNAVAILABLE", trialEnd);
  if (facts.subscriptionCurrent === null)
    return verdict("unknown", "ENTITLEMENT_UNAVAILABLE", trialEnd);

  return verdict("eligible", "ELIGIBLE", trialEnd);
}

/** The wire code a refused claim answers with (Draft 02's stable vocabulary). */
export function claimErrorCodeFor(v: EligibilityVerdict): string | null {
  if (v.outcome === "eligible") return null;
  switch (v.code) {
    case "TRIAL_NOT_ENDED":
      return "TRIAL_NOT_ENDED";
    case "PAYMENT_NOT_VERIFIED":
      return "PAYMENT_NOT_VERIFIED";
    case "SUSPENDED":
      return "SESSION_REVOKED";
    default:
      return "ENTITLEMENT_UNAVAILABLE";
  }
}
