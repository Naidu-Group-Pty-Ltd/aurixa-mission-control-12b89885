/**
 * The facts a claim is judged on, projected from the rows the gateway reads.
 *
 * One rule carries it: **a read that failed is not a row that is absent.**
 * Every fact a failed read would have supplied is `null`, which the
 * eligibility rule treats as "unknown" and refuses — so a database fault can
 * never read as "this workspace has paid" or "this workspace has a free seat".
 */
import type { EligibilityFacts } from "./eligibility.pure";
import type { MobilePortal } from "./portals.pure";

export type GatewayFactsRow = {
  status: string;
  cohort_enabled: boolean;
  licensed_portals: string[];
  trial_started_at: string;
  trial_extension_hours: number;
  legacy_clone: boolean;
  exception_granted_at: string | null;
};

export type Read<T> = { ok: true; row: T | null } | { ok: false };

export type GateFactsInput = {
  /** `paid_at` is set. */
  paid: boolean;
  /** The resolver says locked. */
  locked: boolean;
};

export function eligibilityFactsFrom(input: {
  gateway: Read<GatewayFactsRow>;
  backendStatus: Read<{ status: string }>;
  gate: Read<GateFactsInput>;
  portal: MobilePortal;
  now: Date;
}): EligibilityFacts {
  const gw = input.gateway.ok ? input.gateway.row : undefined;
  const known = gw !== undefined && gw !== null;
  const backend = input.backendStatus.ok ? input.backendStatus.row : undefined;

  let paymentVerified: boolean | null = null;
  let subscriptionCurrent: boolean | null = null;
  if (input.gate.ok) {
    if (input.gate.row) {
      paymentVerified = input.gate.row.paid;
      subscriptionCurrent = !input.gate.row.locked;
    } else {
      // No gate row: a clone provisioned before gating, or onto no paid plan.
      // Nothing records a payment, so nothing verifies one — such a clone
      // needs an operator exception. Nothing locks it either.
      paymentVerified = false;
      subscriptionCurrent = true;
    }
  }

  return {
    cohortEnabled: known ? gw.cohort_enabled : null,
    provisioningVerified:
      backend === undefined ? null : backend === null ? false : backend.status === "ready",
    trialStartedAt: known ? gw.trial_started_at : null,
    trialExtensionHours: known ? gw.trial_extension_hours : null,
    now: input.now,
    paymentVerified,
    subscriptionCurrent,
    portalLicensed: known ? gw.licensed_portals.includes(input.portal) : null,
    suspended: known ? gw.status !== "active" : null,
    legacyClone: known ? gw.legacy_clone : false,
    exceptionGrantedAt: known ? gw.exception_granted_at : null,
  };
}

/**
 * Whether one more device may be bound. No seat entitlement means seats are
 * not metered for this clone; an entitlement with a plan caps bound devices at
 * the plan's seat limit; a read that failed is unknown.
 */
export function seatAvailableFrom(input: {
  entitlement: Read<{ seat_limit: number | null }>;
  boundDevices: number | null;
}): boolean | null {
  if (!input.entitlement.ok) return null;
  const ent = input.entitlement.row;
  if (!ent || ent.seat_limit === null || ent.seat_limit <= 0) return true;
  if (input.boundDevices === null) return null;
  return input.boundDevices < ent.seat_limit;
}
