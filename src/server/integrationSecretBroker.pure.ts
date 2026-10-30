/**
 * Writing a vendor key a tenant typed on its OWN Integrations page — and the
 * deny-list that decides what a tenant may never write.
 *
 * ## Why the call travels instead of the credential
 *
 * A workspace's Integrations page collects vendor credentials, and the runtime
 * reads them from the Supabase function environment (`Deno.env.get(…)`).
 * Writing that environment needs a Supabase MANAGEMENT token, which is a
 * personal access token scoped to an ACCOUNT rather than a project: it can
 * read and rewrite the secrets, database and settings of every project the
 * account owns — the prime's, and Mission Control's own. Supabase mints no
 * per-project variant.
 *
 * So it stays here, and the CALL travels. This is the third credential to take
 * that shape — Didit (`verificationBroker`) and Airtable (`listingsBroker`)
 * are the first two, for the same reason each time: a credential nothing can
 * narrow to one tenant does not get forwarded to tenants.
 *
 * ## The rule that makes it safe: the caller cannot name a project
 *
 * The endpoint takes `{ secrets: [{name, value}] }` and nothing else. WHICH
 * project is resolved from the presented key through `decideCloneSecretTarget`
 * — the project ref is that decision's RETURN VALUE, never an argument — and
 * that decision refuses Mission Control's own project, refuses the prime's,
 * and refuses when it cannot tell which is which.
 *
 * ## The rule that makes it safe twice: this deny-list is independent
 *
 * The prime already refuses these names before it sends anything
 * (`deploymentIdentitySecrets.pure.ts`). This module repeats the judgement
 * rather than trusting it, because a broker that trusts its caller's
 * validation is not a broker — the caller is a tenant's edge function, running
 * a bundle deployed from a repository a tenant can hold, and the whole point
 * of the boundary is that what arrives here is a REQUEST rather than an
 * instruction.
 *
 * The two lists are deliberately not shared code. They are in different
 * repositories that deploy independently, and a shared module would mean a
 * clone running last month's bundle could downgrade this side's judgement by
 * being old.
 *
 * That independence has a cost worth naming: nothing can compare the two lists
 * automatically, because neither repository can see the other's source. So
 * this list is judged on its own terms — it must be complete for THIS
 * boundary, whatever the prime happens to refuse — and it is pinned name by
 * name by `integrationSecretBroker.test.ts`, so a removal is a deliberate edit
 * to a test rather than a quiet deletion. The direction that matters is this
 * one being SMALLER than the prime's: a tenant holding a clone key can call
 * this endpoint directly, so the prime's refusals protect nothing here.
 *
 * ## What is refused
 *
 * Anything that decides who a deployment is: its Supabase project and keys, a
 * management token, its link to Mission Control, its hosting and repository
 * credentials, the secret half of its login widget, the platform's payment
 * account, and the internal signing family. Plus the Listings pipeline's
 * Airtable names, which are fleet-managed for a reason of their own.
 *
 * ## What is NOT refused, and why that is the point
 *
 * Every ordinary vendor key, INCLUDING one that supersedes a key the platform
 * forwarded. A workspace that brings its own OpenAI key must be able to, and
 * the platform must then stop being charged for it. A rule that blocked that
 * would be protecting the wrong side of the meter.
 */

import { crmLineSecretRefusal } from "./crmLineFeatures.pure";
import { primeOnlyRefusal } from "./primeOnlySecrets.pure";

/**
 * Exact names no tenant may set on its own project through this broker.
 *
 * A superset of the prime's own refusal list, and asserted to be one.
 */
export const FORBIDDEN_TENANT_SECRETS: ReadonlySet<string> = new Set([
  // The platform's own runtime, and the two management credentials that would
  // reach every project this organisation owns.
  "SUPABASE_ACCESS_TOKEN",
  "SB_MANAGEMENT_ACCESS_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_JWT_SECRET",
  // Who a workspace believes its billing authority is, what it trusts a call
  // from that authority by, and the key it presents to reach this endpoint.
  // A tenant that could rewrite these could point its own gate, seats and
  // token spend at a server it controls.
  "MISSION_CONTROL_URL",
  "MISSION_CONTROL_CLONE_API_KEY",
  "MISSION_CONTROL_WEBHOOK_SECRET",
  // The secret half of a login widget. A widget IS a (site key, secret) pair
  // and Mission Control mints one per clone; replacing the secret alone breaks
  // the pairing that keeps one tenant's CAPTCHA from satisfying another's.
  "TURNSTILE_SECRET_KEY",
  // Hosting and repository. Neither is a vendor integration; both act on the
  // deployment's own source and its production site.
  "VERCEL_API_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  // The platform's payment account, never the workspace's.
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  // The Listings pipeline's Airtable configuration. Fleet-managed: every
  // deployment reads the same shared intake table, and an Airtable personal
  // access token carries its whole base scope.
  "AIRTABLE_TOKEN",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_TABLE_NAME",
  "AIRTABLE_TABLE_ALLOWLIST",
  "AIRTABLE_TABLE_ALIASES",
  "AIRTABLE_IMAGE_LIBRARY_FIELD",
]);

/**
 * Prefixes whose whole class is refused.
 *
 * `INTERNAL_` is the internal signing family — the secret that makes a
 * scheduled invocation trustworthy. A divergence in one of those silently
 * refused 17,174 scheduled screening invocations on the prime; letting a
 * settings page write one would make that a supported action.
 */
export const FORBIDDEN_TENANT_PREFIXES: readonly string[] = ["INTERNAL_"];

/**
 * A Supabase secret name.
 *
 * The same shape the prime's endpoint enforces, checked again here for the
 * independence reason above. Upper snake case, starting with a letter — which
 * is also what the Management API accepts.
 */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,50}$/;

/** The largest value one secret may carry. Mirrors the prime's own ceiling. */
export const MAX_SECRET_VALUE_LENGTH = 2000;

/**
 * The most names one request may carry.
 *
 * The largest integration card in the prime's registry declares five
 * credential fields, so this is a real bound with room rather than a
 * formality — and it stops the endpoint being a way to push an unbounded body
 * at the Management API on the platform's token.
 */
export const MAX_SECRETS_PER_WRITE = 25;

export type SecretRefusal = { name: string; reason: string };

export type IntegrationSecretPlan = {
  /** The entries that may be written, in the order they arrived. */
  write: Array<{ name: string; value: string }>;
  /** Everything refused, with the reason in the operator's terms. */
  refused: SecretRefusal[];
  /** Set when the request itself is unusable, rather than its contents. */
  fatal: string | null;
};

/** Why this name may not be written by a tenant, or null when it may. */
export function tenantSecretRefusal(name: string): string | null {
  if (!SECRET_NAME.test(name)) {
    return `${JSON.stringify(name)} is not a Supabase secret name.`;
  }
  // A credential no tenant's project may hold, whoever writes it: the sweep
  // removes it within the half hour, so writing it here would only make a
  // Save that undoes itself. Asked before the deny-list so the reason given
  // is the name's own.
  const controlPlane = primeOnlyRefusal(name);
  if (controlPlane) return controlPlane;
  const forbidden =
    FORBIDDEN_TENANT_SECRETS.has(name) || FORBIDDEN_TENANT_PREFIXES.some((p) => name.startsWith(p));
  if (!forbidden) return null;
  return (
    `${name} is part of a deployment's own identity — its Supabase project, its link to Mission ` +
    `Control, its hosting, its login widget's secret half, or the fleet's shared Listings ` +
    `configuration — rather than a vendor integration. It is set when the workspace is ` +
    `provisioned and Mission Control will not change it from a settings page. Vendor keys are ` +
    `yours to set, including ones that supersede a key the platform provided.`
  );
}

/**
 * Decide what to write from what was sent.
 *
 * Partial is a real outcome and deliberately so: a card carrying four vendor
 * fields and one refused name should write the four. What must never happen is
 * a refused name landing quietly, which is why every refusal is returned to
 * the caller rather than dropped.
 */
export function planIntegrationSecretWrite(body: unknown): IntegrationSecretPlan {
  const empty: IntegrationSecretPlan = { write: [], refused: [], fatal: null };

  const secrets = (body as { secrets?: unknown } | null)?.secrets;
  if (!Array.isArray(secrets) || secrets.length === 0) {
    return {
      ...empty,
      fatal: "Body must be { secrets: [{ name, value }, …] } with at least one entry.",
    };
  }
  if (secrets.length > MAX_SECRETS_PER_WRITE) {
    return {
      ...empty,
      fatal: `${secrets.length} secrets were sent; at most ${MAX_SECRETS_PER_WRITE} may be written at once.`,
    };
  }

  const write: Array<{ name: string; value: string }> = [];
  const refused: SecretRefusal[] = [];
  const seen = new Set<string>();

  for (const entry of secrets) {
    // `entry` crosses a trust boundary, so it may be null, a number or a
    // string. Reading `.name` off null throws, and a throw here would take a
    // whole legitimate request down as a 500 over one malformed element.
    const row = (typeof entry === "object" && entry !== null ? entry : {}) as {
      name?: unknown;
      value?: unknown;
    };
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const value = typeof row.value === "string" ? row.value.trim() : "";

    const refusal = tenantSecretRefusal(name);
    if (refusal) {
      refused.push({ name: name || "(unnamed)", reason: refusal });
      continue;
    }
    if (!value) {
      // Refused rather than skipped. An empty value is not a deletion here —
      // the Management API would write an empty string, and a vendor key set
      // to "" reads as configured at every surface that checks presence.
      refused.push({ name, reason: `${name} was sent with no value.` });
      continue;
    }
    if (value.length > MAX_SECRET_VALUE_LENGTH) {
      refused.push({
        name,
        reason: `${name} is ${value.length} characters; the ceiling is ${MAX_SECRET_VALUE_LENGTH}.`,
      });
      continue;
    }
    if (seen.has(name)) {
      // Two values for one name in one request. Refusing the second is the
      // only answer that cannot be wrong, because nothing here can say which
      // the operator meant and the Management API would silently take one.
      refused.push({ name, reason: `${name} was sent twice in one request.` });
      continue;
    }

    seen.add(name);
    write.push({ name, value });
  }

  return { write, refused, fatal: null };
}

/**
 * What the ledger records a name this broker wrote as.
 *
 * ## Why not always `set` (key audit R3, 29 Oct 2026)
 *
 * `set` is the status a tenant's own key has, and it is what stops a call
 * being recharged: `resolve_api_key_billability` rates it `byok`. Every name
 * this endpoint wrote was recorded `set`, so two writes that changed nobody's
 * money turned a platform-paid key into a free one for good:
 *
 * - **A save that changed nothing.** The page re-posting a value the project
 *   already holds (`unchanged`) re-stamped an `inherited` or `minted` row
 *   `set`. Nobody brought a key; the record says somebody did.
 * - **The platform's own value.** A tenant pasting the key the platform
 *   forwarded to it (or an operator re-entering it) is still the platform's
 *   money on every call. The audit's direction: compare the posted value with
 *   the platform's own before calling it the tenant's.
 *
 * ## The rules
 *
 * 1. Unchanged, and recorded as Aurixa's money (`inherited`, `minted`,
 *    `federated`): the record stands. Nothing was written.
 * 2. Unchanged, and the record could not be read: left as it is. Guessing in
 *    either direction moves money on no evidence.
 * 3. The value is Mission Control's own value for the name: `inherited`.
 * 4. Anything else is the tenant's own key: `set`. Superseding a key the
 *    platform provided is the product, and stops its recharge.
 *
 * `null` means "write no row". Pure: the caller compares the value (in
 * constant time) and reads the existing row.
 */
export type IntegrationLedgerStatus = "set" | "inherited" | "minted" | "federated";

const PLATFORM_MONEY: ReadonlySet<string> = new Set(["inherited", "minted", "federated"]);

export function integrationLedgerStatus(facts: {
  /** The project already held exactly this value, so nothing was sent. */
  unchanged: boolean;
  /** The ledger's status for the name before this write: null for no row, undefined when unreadable. */
  existing: string | null | undefined;
  /** The posted value is Mission Control's own value for this name. */
  isPlatformValue: boolean;
}): IntegrationLedgerStatus | null {
  if (facts.unchanged) {
    if (facts.existing === undefined) return null;
    if (facts.existing !== null && PLATFORM_MONEY.has(facts.existing)) {
      return facts.existing as IntegrationLedgerStatus;
    }
  }
  return facts.isPlatformValue ? "inherited" : "set";
}

/**
 * Take out of a plan every name the calling clone's CRM line never holds.
 *
 * Separate from `planIntegrationSecretWrite` because the plan is decided from
 * the body alone, before the caller's clone is resolved, and the line is a
 * fact about the clone. The head of the independent line already refuses
 * these names on its own write endpoint; this is Mission Control's half,
 * which holds for a deployment running an older copy of that endpoint.
 */
export function withCrmLineRefusals(
  plan: IntegrationSecretPlan,
  crmMode: string | null | undefined,
): IntegrationSecretPlan {
  const write: IntegrationSecretPlan["write"] = [];
  const refused = [...plan.refused];
  for (const entry of plan.write) {
    const why = crmLineSecretRefusal(entry.name, crmMode);
    if (why) refused.push({ name: entry.name, reason: why });
    else write.push(entry);
  }
  return { ...plan, write, refused };
}

/** The header that names Mission Control as the one who said no. */
export const REFUSAL_HEADER = "x-mission-control-refusal";

/**
 * A POSITIVE marker that an answer came from here at all.
 *
 * The refusal header answers "did Mission Control refuse this, or did the
 * Management API?". It cannot answer the question one step out — did the
 * request reach Mission Control? — because it is absent on a relayed failure
 * and equally absent on a 404 from whatever other host a clone's
 * `MISSION_CONTROL_URL` happens to name. A clone spent a morning reporting
 * `airtable_404` under exactly that fault before the listings broker grew this
 * header; it is on every answer here from the first deploy for the same
 * reason.
 */
export const ENDPOINT_HEADER = "x-mission-control-endpoint";
export const INTEGRATIONS_ENDPOINT = "integrations.secrets";

export function relayHeaders(): HeadersInit {
  return { "Content-Type": "application/json", [ENDPOINT_HEADER]: INTEGRATIONS_ENDPOINT };
}

export function refusalHeaders(error: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    [REFUSAL_HEADER]: error,
    [ENDPOINT_HEADER]: INTEGRATIONS_ENDPOINT,
  };
}
