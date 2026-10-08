/**
 * A gateway grant: one principal's right to one portal app of one clone.
 *
 *   issuable ──issue link──▶ active ──first claim──▶ device_bound
 *       │                       │                         │
 *       └───────────────────────┴──────── revoke ─────────┴──▶ revoked (terminal)
 *
 * - `issuable` is how birth leaves the seeded superadmin's grant: it exists,
 *   so the clone is never an orphan, and nothing has been sent.
 * - `active` means a link is out and unclaimed.
 * - `device_bound` means one installation holds it. A second installation is
 *   refused (`ALREADY_CLAIMED`) until an operator re-issues, which unbinds.
 * - `revoked` is terminal. A new grant is a new row, so history is kept.
 */

import type { EligibilityVerdict } from "./eligibility.pure";
import { claimErrorCodeFor } from "./eligibility.pure";
import type { TicketState } from "./tickets.pure";
import type { MobilePortal } from "./portals.pure";
import { PORTAL_APPS } from "./portals.pure";

export const GRANT_STATUSES = ["issuable", "active", "device_bound", "revoked"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export type GrantAction = "issue_link" | "claim" | "reissue" | "revoke";

const TRANSITIONS: Record<GrantStatus, Partial<Record<GrantAction, GrantStatus>>> = {
  issuable: { issue_link: "active", revoke: "revoked" },
  active: { issue_link: "active", claim: "device_bound", revoke: "revoked" },
  device_bound: { claim: "device_bound", reissue: "active", revoke: "revoked" },
  revoked: {},
};

export function nextGrantStatus(from: GrantStatus, action: GrantAction): GrantStatus | null {
  return TRANSITIONS[from][action] ?? null;
}

export type ClaimGrant = {
  status: GrantStatus;
  portal: MobilePortal;
  device_install_id: string | null;
  device_thumbprint: string | null;
};

export type ClaimInput = {
  grant: ClaimGrant | null;
  ticket: TicketState | "missing";
  requestedPortal: MobilePortal;
  installId: string;
  deviceThumbprint: string;
  eligibility: EligibilityVerdict;
  gatewayStatus: "active" | "suspended" | "revoked" | null;
  seatAvailable: boolean | null;
};

export type ClaimDecision =
  | { ok: true; bindsDevice: boolean }
  | { ok: false; status: number; code: string; message: string };

function refuse(status: number, code: string, message: string): ClaimDecision {
  return { ok: false, status, code, message };
}

/**
 * Every check that does not need the database. The caller has already spent
 * the ticket atomically (or found it spent), read the grant, the gateway and
 * the eligibility facts; this decides what the answer is.
 *
 * Refusals never say whether a grant exists for a different person: an
 * unknown grant and a missing ticket read the same.
 */
export function decideClaim(input: ClaimInput): ClaimDecision {
  const { grant } = input;
  if (!grant || input.ticket === "missing") {
    return refuse(401, "AUTH_REQUIRED", "This access link is not valid.");
  }
  if (grant.status === "revoked")
    return refuse(403, "GRANT_REVOKED", "This access has been withdrawn.");
  if (input.gatewayStatus !== "active") {
    return refuse(403, "SESSION_REVOKED", "Access to this workspace's apps is suspended.");
  }
  if (grant.portal !== input.requestedPortal) {
    return refuse(409, "CONTEXT_MISMATCH", "This link is for a different app.");
  }
  if (input.ticket === "expired")
    return refuse(410, "INVITE_EXPIRED", "This access link has expired.");

  const boundHere =
    grant.status === "device_bound" &&
    grant.device_install_id === input.installId &&
    grant.device_thumbprint === input.deviceThumbprint;

  if (input.ticket === "used")
    return refuse(409, "TICKET_USED", "This access link has already been used.");
  if (input.ticket === "used_by_this_install" && !boundHere && grant.status === "device_bound") {
    return refuse(409, "TICKET_USED", "This access link has already been used.");
  }
  if (grant.status === "device_bound" && !boundHere) {
    return refuse(409, "ALREADY_CLAIMED", "This access is already in use on another device.");
  }
  if (grant.status === "issuable")
    return refuse(401, "AUTH_REQUIRED", "This access link is not valid.");

  if (!PORTAL_APPS[grant.portal].nativeSessionReady) {
    return refuse(503, "VERSION_INCOMPATIBLE", "This app is not available for this workspace yet.");
  }

  const code = claimErrorCodeFor(input.eligibility);
  if (code) return refuse(403, code, input.eligibility.message);

  if (!boundHere) {
    if (input.seatAvailable === false)
      return refuse(403, "SEAT_LIMIT", "This workspace has no free device seat.");
    if (input.seatAvailable === null) {
      return refuse(
        503,
        "ENTITLEMENT_UNAVAILABLE",
        "This workspace's seats could not be confirmed.",
      );
    }
  }
  return { ok: true, bindsDevice: !boundHere };
}
