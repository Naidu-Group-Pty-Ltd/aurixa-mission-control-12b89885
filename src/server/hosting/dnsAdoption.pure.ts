/**
 * What to do about a DNS record that already exists.
 *
 * `provision_subdomain` / `resync_subdomain` was idempotent against its OWN
 * bookkeeping and nothing else: it looked in `edge_dns_records`, updated the
 * record when it found one, and otherwise CREATED. So a record that exists at
 * Cloudflare but is untracked here — the normal state of anything set up by
 * hand, or by a run whose write to `edge_dns_records` did not land — sends the
 * job down the create branch, where Cloudflare refuses:
 *
 *   "An A, AAAA, or CNAME record with that host already exists."
 *
 * That is not a transient failure and retrying cannot fix it. Measured on the
 * one clone in the fleet: `resync_subdomain` failed SEVEN times over 21 hours
 * against `npc.aurixasystems.com.au` — a hostname that was resolving and
 * serving the whole time. The clone page showed a red Cloudflare job beside
 * the words "No edge provider attached", while Cloudflare was in fact carrying
 * the site's DNS.
 *
 * So the rule is the one the Turnstile identity already follows: **create, or
 * ADOPT what is already there.** Existing infrastructure is a thing to
 * reconcile with, not an error.
 *
 * The refusal case is the point of the module. Cloudflare permits several
 * records for one host, and picking one of them to overwrite is how a resync
 * silently repoints somebody's site. Two or more candidates is a question for
 * a person.
 */

/** The record types that collide on a hostname; a TXT beside a CNAME does not. */
export const ADDRESS_RECORD_TYPES = ["A", "AAAA", "CNAME"] as const;
export type AddressRecordType = (typeof ADDRESS_RECORD_TYPES)[number];

export type ZoneRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
};

export type DesiredRecord = {
  type: AddressRecordType;
  name: string;
  content: string;
  proxied: boolean;
};

export type DnsRecordAction =
  /** We already own this record id. Update it in place, as before. */
  | { kind: "update"; recordId: string }
  /**
   * It exists at the provider and we do not track it. Take it over.
   * `needsWrite` is false when it already says exactly what we want — there is
   * nothing to change, and a write would spend a rate-limited call to no end.
   */
  | { kind: "adopt"; recordId: string; needsWrite: boolean }
  | { kind: "create" }
  | { kind: "refuse"; reason: string };

export function decideDnsRecordAction(input: {
  /** `external_record_id` from `edge_dns_records`, when we have one. */
  trackedRecordId?: string | null;
  /** Every record the zone holds under this exact name. */
  zoneRecords: ZoneRecord[];
  desired: DesiredRecord;
}): DnsRecordAction {
  if (input.trackedRecordId) {
    return { kind: "update", recordId: input.trackedRecordId };
  }

  const name = input.desired.name.toLowerCase();
  const colliding = input.zoneRecords.filter(
    (r) =>
      r.name.toLowerCase() === name &&
      (ADDRESS_RECORD_TYPES as readonly string[]).includes(r.type.toUpperCase()),
  );

  if (colliding.length === 0) return { kind: "create" };

  if (colliding.length > 1) {
    return {
      kind: "refuse",
      reason:
        `${colliding.length} address records already exist for ${input.desired.name} ` +
        `(${colliding.map((r) => `${r.type} -> ${r.content}`).join(", ")}). ` +
        "Refusing to guess which one this clone owns — remove the ones that are not " +
        "this deployment's, then re-run.",
    };
  }

  const found = colliding[0];
  const matches =
    found.type.toUpperCase() === input.desired.type &&
    found.content.toLowerCase() === input.desired.content.toLowerCase() &&
    found.proxied === input.desired.proxied;

  return { kind: "adopt", recordId: found.id, needsWrite: !matches };
}
