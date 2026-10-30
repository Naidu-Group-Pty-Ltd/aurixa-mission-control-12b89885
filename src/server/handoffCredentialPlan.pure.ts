/**
 * What a handoff must decide about the credentials Aurixa pays for.
 *
 * `DEFAULT_ROTATION_PLAN` covers Lovable, Stripe, Cloudflare and GitHub, and
 * nothing else. A clone also holds the vendor keys Mission Control forwarded
 * to it, keys minted on Aurixa's own vendor accounts for it, and the key that
 * links it to Mission Control. Handed to its client as it stands, the client
 * keeps spending Aurixa's accounts (key audit S4, 29 Oct 2026).
 *
 * Withdrawing them or keeping them under the billing agreement is the owner's
 * decision (D6), so nothing here deletes a value. Planning a handoff adds one
 * row per such name, read from the clone's own ledger, and a row closes only
 * with the operator's evidence of what was done (the `other` target's rule).
 *
 * Pure: no imports, no I/O.
 */

/** The ledger statuses whose value Aurixa supplied, and so must account for at handover. */
export const PLATFORM_PAID_STATUSES = ["inherited", "minted", "federated"] as const;
export type PlatformPaidStatus = (typeof PLATFORM_PAID_STATUSES)[number];

/** The clone's link to Mission Control, by the name its ledger records it under. */
export const MISSION_CONTROL_LINK_SECRET = "MISSION_CONTROL_CLONE_API_KEY";

export type PlannedRotation = {
  target: "other";
  key_ref: string;
  hint: string;
};

const HINTS: Record<PlatformPaidStatus, (name: string) => string> = {
  inherited: (name) =>
    `${name} is Aurixa's key, forwarded by Mission Control. Before handover, either withdraw it from the client's project, or keep forwarding it and keep billing its usage under the agreement (owner decision D6). Record which as evidence.`,
  minted: (name) =>
    `${name} was minted for this clone on Aurixa's own vendor account. Revoke it at the vendor, or move the client to their own account (owner decision D6). Record which as evidence.`,
  federated: (name) =>
    `${name} is a credential Mission Control issues for this clone. End the federation at handover, or keep it under the agreement (owner decision D6). Record which as evidence.`,
};

const LINK_HINT =
  "The key that links this clone to Mission Control: usage reports, entitlements and the activation gate read it. Revoke it once Mission Control stops metering this clone, or keep it while the agreement bills usage (owner decision D6). Record which as evidence.";

function isPlatformPaid(status: string): status is PlatformPaidStatus {
  return (PLATFORM_PAID_STATUSES as readonly string[]).includes(status);
}

/**
 * One row for each name the clone's ledger records as Aurixa's, in name order,
 * plus the Mission Control link whatever its status. A name whose value the
 * client brought (`set`) or that never reached the clone (`withheld`,
 * `authorised_no_value`) is not Aurixa's to account for.
 */
export function platformCredentialRotations(
  ledger: ReadonlyArray<{ name: string; status: string }>,
): PlannedRotation[] {
  const rows: PlannedRotation[] = [];
  const names = new Set<string>();
  for (const entry of [...ledger].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === MISSION_CONTROL_LINK_SECRET || names.has(entry.name)) continue;
    if (!isPlatformPaid(entry.status)) continue;
    names.add(entry.name);
    rows.push({ target: "other", key_ref: `platform.${entry.name}`, hint: HINTS[entry.status](entry.name) });
  }
  rows.push({ target: "other", key_ref: `platform.${MISSION_CONTROL_LINK_SECRET}`, hint: LINK_HINT });
  return rows;
}
