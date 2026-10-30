/**
 * What a handoff must decide about the credentials Aurixa pays for.
 *
 * `DEFAULT_ROTATION_PLAN` covers Lovable, Stripe, Cloudflare and GitHub, and
 * nothing else. A clone also holds the vendor keys Mission Control forwarded
 * to it, keys minted on Aurixa's own vendor accounts for it, and the key that
 * links it to Mission Control. Handed to its client as it stands, the client
 * keeps spending Aurixa's accounts (key audit S4, 29 Oct 2026).
 *
 * The owner decided D6 on 30 Oct 2026: keep and bill them. A platform key
 * keeps running after handover and its usage is billed through the usage
 * forwarder, live since 09:00 that day; a key is withdrawn only when the
 * client brings its own value for it. The forwarder reports through the
 * clone's Mission Control link, so the link is never withdrawn by default:
 * billing the keys depends on it.
 *
 * So the plan's default is to keep. It still names every such key, read from
 * the clone's own ledger, so the handover records what Aurixa goes on paying
 * for, and nothing here deletes or rotates a value. Each row is bookkeeping
 * and closes on the operator's evidence (the `other` target's rule): skipped,
 * recording that the key is kept and billed, or, where the client has
 * supplied its own value, what replaced Aurixa's and how Aurixa's was
 * withdrawn.
 *
 * Pure: no imports, no I/O.
 */

/** The ledger statuses whose value Aurixa supplied, and so must account for at handover. */
export const PLATFORM_PAID_STATUSES = ["inherited", "minted", "federated"] as const;
export type PlatformPaidStatus = (typeof PLATFORM_PAID_STATUSES)[number];

/** The clone's link to Mission Control, by the name its ledger records it under. */
export const MISSION_CONTROL_LINK_SECRET = "MISSION_CONTROL_CLONE_API_KEY";

/** The owner's decision every platform row states, in one place. */
export const D6_KEEP_AND_BILL =
  "owner decision D6, 30 Oct 2026: platform keys keep running after handover and their usage is billed through the usage forwarder";

export type PlannedRotation = {
  target: "other";
  key_ref: string;
  hint: string;
};

/** What closes a platform row by default: the key is kept, so the row is skipped, and says so. */
const KEPT =
  "By default it stays: mark this row skipped, with evidence that the key is kept and billed under D6.";

const HINTS: Record<PlatformPaidStatus, (name: string) => string> = {
  inherited: (name) =>
    `${name} is Aurixa's key, forwarded by Mission Control. It stays after handover (${D6_KEEP_AND_BILL}). It is withdrawn only when the client supplies its own value for ${name}: set theirs on the client's project, which replaces Aurixa's, and record that as evidence. ${KEPT}`,
  minted: (name) =>
    `${name} was minted for this clone on Aurixa's own vendor account. It stays after handover (${D6_KEEP_AND_BILL}). It is withdrawn only when the client supplies its own value for ${name}: set theirs on the client's project, then revoke the minted key at the vendor, and record both as evidence. ${KEPT}`,
  federated: (name) =>
    `${name} is a credential Mission Control issues for this clone. It stays after handover (${D6_KEEP_AND_BILL}). It is withdrawn only when the client supplies its own value for ${name}: set theirs on the client's project, then end the federation, and record both as evidence. ${KEPT}`,
};

const LINK_HINT = `The key that links this clone to Mission Control: usage reports, entitlements and the activation gate read it, and the usage forwarder that bills the platform keys after handover reports through it (${D6_KEEP_AND_BILL}). It is never withdrawn by default, and the client bringing its own keys does not withdraw it. Mark this row skipped, with evidence that the link is kept; withdrawing it is a separate decision to stop metering this clone.`;

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
