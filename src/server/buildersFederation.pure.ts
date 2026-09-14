/**
 * Builders Network federation — the pure rules.
 *
 * The Builder Portal is being extracted from the per-clone deployment to one
 * central platform at builders.aurixasystems.com.au (npc-property-dashbord
 * docs/builder-portal/45-network-extraction-plan.md, Phase 1). The network is
 * the SECOND relying party on the federation machinery Anthropic already
 * proved out — the same signing key, the same JWKS, the same `clone:<uuid>`
 * subject — because "the credential stops travelling; the call travels" has
 * now been paid for three times (listings broker, verification broker,
 * Anthropic federation), and a fourth bespoke trust system would only be a
 * fourth set of mistakes.
 *
 * What differs from the Anthropic flow, and why:
 *
 * - **The audience is ours.** Anthropic's assertion is exchanged at THEIR
 *   token endpoint, so `aud` is their URL. The Builders Network verifies the
 *   assertion itself, offline, against Mission Control's published JWKS — so
 *   `aud` is the network's own canonical origin, and an assertion minted for
 *   Anthropic can never be replayed at the network or vice versa. One signing
 *   key, two audiences, zero cross-acceptance.
 *
 * - **The assertion carries a profile.** Anthropic looks the subject up in
 *   its own rule table; the network has no such table on day one, so the
 *   claims carry what the network's registry needs — `clone_id`, `slug`,
 *   `display_name`, and the builders-relevant scopes — every one read from
 *   the authenticated clone's own row, never from the request body. The set
 *   is exactly the plan's and deliberately no wider: a claim added here is
 *   disclosed to the network on every mint, and a widening is never implicit.
 *
 * - **Registered claims always win.** The profile is merged UNDER
 *   `iss/sub/aud/iat/exp/jti`, so no caller-influenced value can ever
 *   override who the token says it is, who it is for, or when it dies.
 *   `mergeAssertionClaims` is the one implementation of that rule and the
 *   signer imports it rather than restating it.
 */

/** The one host the network lives on. Reserved as a slug by 20260914120000. */
export const BUILDERS_NETWORK_HOST = "builders.aurixasystems.com.au";

/**
 * The audience a builders assertion is bound to.
 *
 * The network refuses any `aud` that is not exactly this string. It is the
 * canonical origin rather than a made-up URN because an origin is the one
 * name both ends already agree on, and nothing else answers at it.
 */
export const BUILDERS_AUDIENCE = `https://${BUILDERS_NETWORK_HOST}`;

/** Marker header value for this endpoint's own answers. */
export const BUILDERS_IDENTITY_ENDPOINT = "builders-identity";

/**
 * Where the network verifies. The key set is the one the Anthropic flow
 * publishes — one signing key, one implementation — but the URL is the
 * network's own: a trust root must not die with a route named for a
 * different vendor.
 */
export const BUILDERS_JWKS_PATH = "/api/public/builders/jwks";

/**
 * The scopes the assertion discloses to the network.
 *
 * Only the `builders:` family travels: the network has no business learning
 * whether a workspace can rotate its key or read its token balance, and a
 * scope list is a capability map of the caller — the narrowest true statement
 * is the right one.
 */
export function buildersScopesOf(scopes: readonly string[]): string[] {
  return scopes.filter((s) => s.startsWith("builders:")).sort();
}

/**
 * The profile claims the plan names: {clone_id, slug, display_name, scopes}.
 *
 * `display_name` is omitted rather than sent null when the clone has no name
 * — an absent claim is "not stated", a null claim is a statement of nothing,
 * and only the first is true.
 */
export function buildersProfileClaims(input: {
  cloneId: string;
  slug: string;
  displayName: string | null;
  scopes: readonly string[];
}): Record<string, unknown> {
  return {
    clone_id: input.cloneId,
    slug: input.slug,
    ...(input.displayName ? { display_name: input.displayName } : {}),
    scopes: buildersScopesOf(input.scopes),
  };
}

/**
 * Registered claims win, always.
 *
 * Spread order IS the rule: the profile goes first so that a profile carrying
 * `sub`, `aud` or `exp` — by bug or by mischief — is overwritten by the
 * registered set, never the other way round. A test asserts it rather than
 * trusting the spread.
 */
export function mergeAssertionClaims(
  profile: Record<string, unknown>,
  registered: Record<string, unknown>,
): Record<string, unknown> {
  return { ...profile, ...registered };
}

/**
 * Refuse, never silently correct.
 *
 * The optional `clone_id` in the body is checked AGAINST the authenticated
 * key's clone and refused when it disagrees — answering for the right one
 * would make a misconfiguration permanent and invisible, which is the same
 * rule the Anthropic identity endpoint holds for `workspace_id`.
 */
export function buildersIdentityRefusal(input: {
  requestedCloneId: string | null | undefined;
  keyCloneId: string;
}): string | null {
  const requested = input.requestedCloneId?.trim().toLowerCase();
  if (!requested) return null;
  if (requested === input.keyCloneId.trim().toLowerCase()) return null;
  return (
    "This key belongs to a different workspace than the one the request names. " +
    "Nothing was minted: fix the caller's configuration rather than trusting a " +
    "silent correction."
  );
}
