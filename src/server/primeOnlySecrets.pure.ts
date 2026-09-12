/**
 * The credentials that may never sit on a tenant's project, whoever put them
 * there.
 *
 * ## What this fixes
 *
 * On 12 Sep 2026 the clone `npc-client-dashboard` held a value under
 * `SB_MANAGEMENT_ACCESS_TOKEN`. It was dead — the Management API answers
 * `JWT could not be decoded` when the bearer is neither a PAT nor a JWT — but
 * its PRESENCE was enough to break the deployment: the prime's
 * `resolveIntegrationSecretRoute` chooses its route on `if (token &&
 * projectRef)`, so every Integrations save took the direct path and
 * dead-ended on a 401, with the operator told to "rotate it", which is advice
 * no tenant can act on.
 *
 * Four things were wrong at once, and each would have been enough:
 *
 * 1. **The name was not classified.** `classifySecret` knew nothing of
 *    `SB_MANAGEMENT_ACCESS_TOKEN`, so it fell through to `vendor` — the class
 *    that TRAVELS. `SUPABASE_ACCESS_TOKEN` escaped only by accident, caught
 *    by the `SUPABASE_` prefix meant for auto-injected values.
 * 2. **The only defence was a data row.** `prime_secret_forwards` carried
 *    `SB_MGMT_API_TOKEN` and `SB_ORG_ID` with `inherit = false` and the prose
 *    "Prime-only Supabase management token — do not forward". Those are
 *    Mission Control's OWN environment names. The name the prime's edge
 *    function actually reads — `SB_MANAGEMENT_ACCESS_TOKEN` — was in no row
 *    at all, and a row is deletable by anyone with the page open.
 * 3. **The ledger recorded intent, never fact.** `clone_backend_secrets` read
 *    `status: missing`, `last_set_at: null` for that name on all three clones
 *    while the project held a value. Mission Control never set it, so Mission
 *    Control could not see it — and `decideCloneWithhold` cannot withdraw
 *    what it does not know exists.
 * 4. **The remedy did not scale.** Removing it meant a person opening one
 *    project's Secrets page. That is once per clone, for ever.
 *
 * ## The rule
 *
 * **A management credential is refused by CLASS, in code, and removed by
 * EFFECT, on a sweep.** Not by a data row, not by a ledger entry, and not by
 * anybody remembering.
 *
 * A Supabase personal access token is scoped to an ACCOUNT, not a project:
 * it reaches every project in every organisation that account belongs to,
 * with full administrative rights. On this fleet that is the prime, Mission
 * Control's own backend and every other tenant. There is no narrowing scope
 * to mint — which is exactly why the platform brokers the CALL instead of
 * forwarding the credential, and why no clone may hold one under any name.
 *
 * ## What is deliberately NOT here
 *
 * Ordinary vendor keys, including ones a tenant supplies to supersede a
 * forwarded fleet key. Superseding is the product. A rule that swept those
 * away would be protecting the wrong side.
 *
 * Nor the clone's own platform values — `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
 * `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`. Those are the clone's own
 * project's, auto-injected by Supabase, and removing one takes the workspace
 * off the air. `AUTO_INJECTED_SECRETS` names them and this module defers to
 * it rather than re-spelling the list, because two copies is how one of them
 * comes to be swept.
 *
 * Pure: no network, no Deno, no Supabase client, so the contract tests import
 * it directly.
 */

/**
 * Supabase's own auto-injected project values. A clone MUST hold these — they
 * are its own project's — and nothing here may ever name one.
 *
 * Duplicated from `prime-backend.server.ts` deliberately: this module is pure
 * and that one reaches the network, so importing it here would drag a fetch
 * surface into the contract tests. `primeOnlySecrets.test.ts` asserts the two
 * lists agree, which is the guard that makes the copy safe.
 */
export const CLONE_OWN_PLATFORM_VALUES: ReadonlySet<string> = new Set([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_JWT_SECRET",
  "JWT_SECRET",
]);

/**
 * Exact names that grant administrative control over Supabase projects or
 * organisations.
 *
 * Listed rather than inferred wherever a pattern would be a guess. The
 * patterns below carry the classes that are genuinely open-ended.
 *
 * Every name here has been observed in this fleet's code or configuration:
 * `SB_MANAGEMENT_ACCESS_TOKEN` is what the prime's `update-integration-secret`
 * reads; `SUPABASE_ACCESS_TOKEN` is its documented legacy twin and what the
 * Supabase CLI expects; `SB_MGMT_API_TOKEN` and `SB_ORG_ID` are Mission
 * Control's own, already marked `inherit = false` in `prime_secret_forwards`
 * and repeated here so the refusal survives that row being deleted.
 */
export const PRIME_ONLY_SECRETS: ReadonlySet<string> = new Set([
  "SB_MANAGEMENT_ACCESS_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "SB_MGMT_API_TOKEN",
  "SB_ORG_ID",
  "SB_ORG_PROJECT_SOFT_LIMIT",
  "SUPABASE_MANAGEMENT_API_TOKEN",
  "SUPABASE_PERSONAL_ACCESS_TOKEN",
]);

/**
 * Open-ended classes, matched on the whole name.
 *
 * A Supabase PAT is minted with the literal prefix `sbp_`, and a name
 * containing both a Supabase marker and a management/admin marker is one
 * whatever it is called. The point of a pattern here is the name NOBODY has
 * written yet: the exact-name list above is a snapshot of today, and this
 * platform has already paid once for a defence that only covered what was
 * currently reachable.
 */
export const PRIME_ONLY_PATTERNS: readonly RegExp[] = [
  /^(SB|SUPABASE)_.*(MANAGEMENT|MGMT|ADMIN)_.*(TOKEN|KEY)$/,
  /^(SB|SUPABASE)_(ORG|ORGANISATION|ORGANIZATION)_ID$/,
];

/**
 * Is this a credential only the prime's control plane may hold?
 *
 * The clone's own platform values are checked FIRST and always win. A rule
 * that could name `SUPABASE_SERVICE_ROLE_KEY` would take every clone off the
 * air on its first pass, and the pattern above is close enough to that name
 * that the ordering is load-bearing rather than tidy.
 */
export function isPrimeOnlySecret(name: string): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  if (CLONE_OWN_PLATFORM_VALUES.has(n)) return false;
  if (PRIME_ONLY_SECRETS.has(n)) return true;
  return PRIME_ONLY_PATTERNS.some((rx) => rx.test(n));
}

/** Why a name is refused, in the words an operator reads. Null when it is allowed. */
export function primeOnlyRefusal(name: string): string | null {
  if (!isPrimeOnlySecret(name)) return null;
  return (
    `${name} grants administrative control over Supabase projects. A Supabase personal access ` +
    `token is scoped to an ACCOUNT rather than a project, so a copy on this workspace would ` +
    `reach the prime, Mission Control and every other tenant — and Supabase publishes no way to ` +
    `narrow one. Mission Control holds it and makes the call instead. It is never forwarded, and ` +
    `it is removed from any workspace found holding it.`
  );
}

/**
 * What a project is holding that it must not.
 *
 * Takes the names the project ACTUALLY holds — read from the Management API,
 * never from Mission Control's ledger, because the ledger records what
 * Mission Control intended and this whole module exists because those two
 * disagreed.
 *
 * Returns them sorted so a report reads the same twice and a test can pin it.
 */
export function prohibitedHoldings(heldNames: readonly string[]): string[] {
  return [...new Set(heldNames.filter((n) => isPrimeOnlySecret(n)))].sort();
}
