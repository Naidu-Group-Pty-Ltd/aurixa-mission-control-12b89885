/**
 * Which functions a clone serves anonymously, whatever the prime declares.
 *
 * Issue #15: Prime's `verify_jwt` flag is snapshot verbatim, but a clone's
 * JWT audience differs from the prime's — an edge function shipped with
 * `verify_jwt=true` on the prime will 401 external callers hitting the
 * clone's URL because their token was minted against a different project.
 *
 * Any function that is intended to be reached anonymously (webhooks,
 * public hooks, cron callbacks, health probes) MUST be deployed with
 * `verify_jwt=false` on every clone regardless of the prime's setting.
 * We detect those by slug convention: it is the same convention used by
 * `/api/public/*` server routes and by Supabase's own function templates.
 *
 * Pure, and in a module of its own, because two places must agree on it: the
 * deploy that sends the flag (`deployEdgeFunction`) and the bundle digest that
 * records what was sent (`functionBundleDigest.pure.ts`). A digest over the
 * prime's flag alone would not change when this list does, and the deploy
 * ledger would then vouch for a copy deployed with the old answer.
 */

const ANON_FUNCTION_SLUG_PATTERNS: RegExp[] = [
  /^hooks?[-_]/i, // hook-*, hooks-*
  /^webhooks?[-_]?/i, // webhook*, webhooks-*
  /[-_]webhooks?$/i, // *-webhook, *-webhooks
  /^public[-_]/i, // public-*
  /^cron[-_]/i, // cron-*
  /^health(check)?$/i, // health, healthcheck
  /^stripe[-_]webhook/i,
  /^github[-_]webhook/i,
];

export function shouldForceAnonymousFunction(slug: string): boolean {
  return ANON_FUNCTION_SLUG_PATTERNS.some((rx) => rx.test(slug));
}

/** The `verify_jwt` a clone is actually sent for a function, and why it differs. */
export function deployedVerifyJwt(
  slug: string,
  primeVerifyJwt: boolean,
): { readonly verifyJwt: boolean; readonly overrideReason: string | null } {
  const forceAnon = shouldForceAnonymousFunction(slug) && primeVerifyJwt === true;
  return {
    verifyJwt: forceAnon ? false : primeVerifyJwt,
    overrideReason: forceAnon
      ? `slug "${slug}" matches an anonymous-webhook pattern; prime had verify_jwt=true, deployed as false on this clone`
      : null,
  };
}
