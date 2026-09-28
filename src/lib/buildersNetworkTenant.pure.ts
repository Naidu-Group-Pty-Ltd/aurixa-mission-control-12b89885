/**
 * The metering identity of one Builders Network organisation (extraction plan
 * §10, decided: PER BUILDER ORGANISATION).
 *
 * Approving an organisation ensures a Mission Control tenant keyed by this
 * reference with a NULL clone_id, so every spend the network later reports for
 * the organisation has a ledger of its own from the day it is approved.
 *
 * It lives in its own module because two paths approve an organisation — the
 * console's Approve button and a signed Builder Partner Agreement armed to
 * grant access — and both must key the same tenant. Two spellings of one key
 * is how a ledger splits in two.
 */
export function builderOrgTenantRef(organisationId: string): string {
  return `builders-network:${organisationId}`;
}
