/**
 * What step 5h has to do for one clone, decided without the database.
 *
 * `ensureCloneMobileGateway` reads the clone's gateway row, its subscriptions
 * and its live superadmin grant, hands them here, and performs exactly what
 * comes back. The same function runs at birth and from the reconcile sweep, so
 * a clone born before the gateway existed converges through the identical
 * decision — there is no second path that "injects" the machinery.
 *
 * Four rules carry it.
 *
 * - **The credential is minted where it is delivered.** Its plaintext exists
 *   once, at mint. A row whose credential was recorded as delivered to THIS
 *   project is reused; a row delivered to another project, or never stamped as
 *   delivered, is re-minted, because nothing can prove the clone holds it.
 * - **A revoked gateway stays revoked.** Nothing here revives it; an operator
 *   does that on purpose.
 * - **A subscription follows the licence, and the channel is the operator's.**
 *   A row that exists keeps its channel; only `enabled` is brought into line.
 * - **The superadmin grant is keyed by email.** Provisioning knows the admin's
 *   email at birth and `clone_backends.admin_email` remembers it for the sweep,
 *   so birth and reconcile write the same row. The clone resolves the email to
 *   its own user at exchange time.
 */

import type { MobilePortal } from "./portals.pure";
import { MOBILE_PORTALS } from "./portals.pure";

export type ExistingGateway = {
  status: "active" | "suspended" | "revoked";
  delivered_project_ref: string | null;
  delivered_env_at: string | null;
  licensed_portals: string[];
};

export type ExistingSubscription = { portal: string; enabled: boolean };

export type GatewayPlan = {
  /** Write the row for the first time. */
  createRow: boolean;
  /** Mint a new `mmc_` and deliver it. */
  mintCredential: boolean;
  /** The portals the row should record. */
  licensedPortals: MobilePortal[];
  updateLicences: boolean;
  /** Subscriptions to insert (absent rows) and to flip (`enabled` wrong). */
  insertSubscriptions: Array<{ portal: MobilePortal; enabled: boolean }>;
  updateSubscriptions: Array<{ portal: MobilePortal; enabled: boolean }>;
  /** Mint the seeded superadmin's Command Centre grant. */
  createSuperadminGrant: boolean;
  /** Nothing writes past the row: the gateway is revoked. */
  frozen: boolean;
  why: string[];
};

export function principalRefForEmail(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

export function planCloneMobileGateway(input: {
  projectRef: string;
  gateway: ExistingGateway | null;
  subscriptions: readonly ExistingSubscription[];
  licensedPortals: readonly MobilePortal[];
  hasLiveSuperadminGrant: boolean;
  adminEmail: string | null;
}): GatewayPlan {
  const why: string[] = [];
  const licensed = MOBILE_PORTALS.filter((p) => input.licensedPortals.includes(p));
  const g = input.gateway;

  if (g?.status === "revoked") {
    return {
      createRow: false,
      mintCredential: false,
      licensedPortals: licensed,
      updateLicences: false,
      insertSubscriptions: [],
      updateSubscriptions: [],
      createSuperadminGrant: false,
      frozen: true,
      why: ["gateway revoked — left as an operator set it"],
    };
  }

  const createRow = g === null;
  let mintCredential = false;
  if (createRow) {
    mintCredential = true;
    why.push("no gateway row — created with a new credential");
  } else if (g.delivered_project_ref !== input.projectRef) {
    mintCredential = true;
    why.push(
      g.delivered_project_ref
        ? `credential delivered to ${g.delivered_project_ref}, not ${input.projectRef} — re-minted`
        : "credential never recorded against a project — re-minted",
    );
  } else if (!g.delivered_env_at) {
    mintCredential = true;
    why.push("credential minted but never stamped delivered — re-minted");
  }

  const current = new Set(g?.licensed_portals ?? []);
  const updateLicences =
    !createRow && (current.size !== licensed.length || licensed.some((p) => !current.has(p)));
  if (updateLicences) why.push(`licences now ${licensed.join(", ")}`);

  const byPortal = new Map(input.subscriptions.map((s) => [s.portal, s.enabled]));
  const insertSubscriptions: GatewayPlan["insertSubscriptions"] = [];
  const updateSubscriptions: GatewayPlan["updateSubscriptions"] = [];
  for (const portal of MOBILE_PORTALS) {
    const enabled = licensed.includes(portal);
    if (!byPortal.has(portal)) insertSubscriptions.push({ portal, enabled });
    else if (byPortal.get(portal) !== enabled) updateSubscriptions.push({ portal, enabled });
  }
  if (insertSubscriptions.length) why.push(`${insertSubscriptions.length} subscriptions created`);
  if (updateSubscriptions.length)
    why.push(`${updateSubscriptions.length} subscriptions brought in line`);

  const adminEmail = input.adminEmail?.trim() ?? "";
  const createSuperadminGrant = !input.hasLiveSuperadminGrant && adminEmail.includes("@");
  if (createSuperadminGrant) why.push("superadmin Command Centre grant created (issuable)");
  else if (!input.hasLiveSuperadminGrant)
    why.push("no admin email recorded — superadmin grant waits");

  if (why.length === 0) why.push("already converged");

  return {
    createRow,
    mintCredential,
    licensedPortals: licensed,
    updateLicences,
    insertSubscriptions,
    updateSubscriptions,
    createSuperadminGrant,
    frozen: false,
    why,
  };
}

/** True when the plan changes nothing the clone or Mission Control holds. */
export function planIsNoop(p: GatewayPlan): boolean {
  return (
    !p.createRow &&
    !p.mintCredential &&
    !p.updateLicences &&
    p.insertSubscriptions.length === 0 &&
    p.updateSubscriptions.length === 0 &&
    !p.createSuperadminGrant
  );
}

/** The function-environment names a clone's gateway connection is written under. */
export const ENV_MOBILE_CREDENTIAL = "MISSION_CONTROL_MOBILE_CREDENTIAL";
export const ENV_MOBILE_GATEWAY_ID = "MISSION_CONTROL_MOBILE_GATEWAY_ID";
export const ENV_MOBILE_ISSUER = "MISSION_CONTROL_MOBILE_ISSUER";
export const ENV_MOBILE_JWKS_URL = "MISSION_CONTROL_MOBILE_JWKS_URL";
export const ENV_MOBILE_GATEWAY_ORIGIN = "MOBILE_GATEWAY_ORIGIN";

export const MOBILE_GATEWAY_ENV_NAMES = [
  ENV_MOBILE_CREDENTIAL,
  ENV_MOBILE_GATEWAY_ID,
  ENV_MOBILE_ISSUER,
  ENV_MOBILE_JWKS_URL,
  ENV_MOBILE_GATEWAY_ORIGIN,
] as const;

export const GATEWAY_ID_PREFIX = "mgw_";
