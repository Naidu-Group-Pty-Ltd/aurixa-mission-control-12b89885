/**
 * Creating the three Anthropic resources one clone federates through.
 *
 * Decisions are in `anthropicFederation.pure.ts`; signing is in
 * `anthropicOidc.server.ts`. This is the half that calls Anthropic's Admin API
 * and writes what it created.
 *
 * ## The credential this runs on is not an Admin key
 *
 * Anthropic is explicit: "Admin API keys are not accepted on these endpoints,
 * for reads or writes; use an `org:admin` OAuth token." So the service
 * account, issuer and rule endpoints need a token Mission Control obtains by
 * federating to ITSELF — through the one rule a person created in the Console,
 * because "granting a workload organization-admin access is a deliberate human
 * action, not something automation can bootstrap for itself."
 *
 * That bootstrap is also what makes this safe to run unattended: an OAuth
 * caller may only create or modify rules whose scope is `workspace:developer`
 * or `workspace:inference`. The automation cannot grant itself anything
 * larger, whatever it is asked to do.
 */

import {
  BOOTSTRAP_RULE_ENV,
  BOOTSTRAP_SERVICE_ACCOUNT_ENV,
  FEDERATED_STATUS,
  FEDERATION_ISSUER_ID,
  FEDERATION_ORG_ENV,
  FEDERATION_RULE_ID,
  SERVICE_ACCOUNT_ID,
  decideFederation,
  federationResourceName,
  federationRuleBody,
  federationSubject,
  refuseWildcardSubject,
} from "./anthropicFederation.pure";
import {
  bootstrapIssuerUrl,
  cloneIssuerUrl,
  jwksUrl,
  signBootstrapAssertion,
  signingKeyPresent,
} from "./anthropicOidc.server";
import { CloneSecretTargetError, resolveCloneSecretTarget } from "./cloneAllowedOrigins.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Db = SupabaseClient<Database>;

const ORG_API = "https://api.anthropic.com/v1/organizations";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 20_000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function bootstrapPresent(): boolean {
  return (
    FEDERATION_RULE_ID.test(env(BOOTSTRAP_RULE_ENV)) &&
    SERVICE_ACCOUNT_ID.test(env(BOOTSTRAP_SERVICE_ACCOUNT_ENV)) &&
    env(FEDERATION_ORG_ENV).length > 0
  );
}

async function timed(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/*
 * One organisation-admin token at a time, cached until it is nearly spent.
 *
 * Each acquisition signs a fresh assertion carrying a new `jti`, and Anthropic
 * accepts one of those exactly once — so a reconcile sweep that obtained a
 * token per clone would have every request after the first refused
 * `jti_reused`, and the sweep would look like an Anthropic outage.
 */
let adminToken: { value: string; expiresAt: number } | null = null;
let adminInFlight: Promise<string> | null = null;

/** Test seam. Never called in production. */
export function resetAnthropicAdminToken(): void {
  adminToken = null;
  adminInFlight = null;
}

async function mintAdminToken(): Promise<string> {
  if (!bootstrapPresent()) {
    throw new Error(
      `Mission Control cannot obtain an Anthropic organisation-admin token: set ` +
        `${BOOTSTRAP_RULE_ENV}, ${BOOTSTRAP_SERVICE_ACCOUNT_ENV} and ${FEDERATION_ORG_ENV}. ` +
        "The rule itself is created once by a person in the Claude Console — Anthropic does not " +
        "let automation grant itself organisation-admin access.",
    );
  }

  const assertion = await signBootstrapAssertion({ audience: TOKEN_URL });
  const res = await timed(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
      federation_rule_id: env(BOOTSTRAP_RULE_ENV),
      organization_id: env(FEDERATION_ORG_ENV),
      service_account_id: env(BOOTSTRAP_SERVICE_ACCOUNT_ENV),
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Anthropic refused Mission Control's organisation-admin token exchange (${res.status}): ` +
        `${(await res.text().catch(() => "")).slice(0, 400)}`,
    );
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  const value = (body.access_token ?? "").trim();
  if (!value) throw new Error("Anthropic returned no organisation-admin access token");

  // The answer's own lifetime, never the rule's: Anthropic bounds a minted
  // token at twice the assertion's remaining life, so it is routinely shorter
  // than configured and a cache that believed the configuration would serve an
  // expired token.
  const lifetimeMs = Math.max(60, Number(body.expires_in) || 0) * 1000;
  adminToken = { value, expiresAt: Date.now() + lifetimeMs };
  return value;
}

async function adminAuth(): Promise<string> {
  if (adminToken && Date.now() < adminToken.expiresAt - 60_000) return adminToken.value;
  if (adminInFlight) return adminInFlight;
  adminInFlight = mintAdminToken().finally(() => {
    adminInFlight = null;
  });
  return adminInFlight;
}

async function orgFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await adminAuth();
  return timed(`${ORG_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function refuse(res: Response, what: string): Promise<never> {
  throw new Error(
    `Anthropic refused to ${what} (${res.status}): ${(await res.text().catch(() => "")).slice(0, 400)}`,
  );
}

/** Find an existing resource by name, so a retry never creates a second one. */
async function findByName(
  collection: "service_accounts" | "federation_issuers" | "federation_rules",
  name: string,
): Promise<{ id: string } | null> {
  let page: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (page) query.set("page", page);
    const res = await orgFetch(`/${collection}?${query.toString()}`, { method: "GET" });
    if (!res.ok) await refuse(res, `list ${collection.replace(/_/g, " ")}`);
    const body = (await res.json()) as {
      data?: Array<{ id?: string; name?: string }>;
      next_page?: string | null;
    };
    const hit = (body.data ?? []).find((r) => r?.name === name && typeof r?.id === "string");
    if (hit?.id) return { id: hit.id };
    page = body.next_page ?? null;
    if (!page) break;
  }
  return null;
}

/**
 * The issuer clone assertions are signed under, created once and reused.
 *
 * Distinct from the bootstrap issuer on purpose: Anthropic blocks an OAuth
 * caller from updating an issuer that backs a rule above workspace scope, so
 * one shared issuer would make every clone rule unmanageable through this API.
 */
export async function ensureCloneIssuer(): Promise<string> {
  const name = "aurixa-clones";
  const existing = await findByName("federation_issuers", name);
  if (existing) return existing.id;

  const res = await orgFetch("/federation_issuers", {
    method: "POST",
    body: JSON.stringify({
      name,
      issuer_url: cloneIssuerUrl(),
      // Explicit rather than discovery: Anthropic then fetches exactly one URL
      // and compares `issuer_url` as a string, so nothing has to serve a
      // `/.well-known/` path.
      jwks: { type: "explicit_url", url: jwksUrl() },
    }),
  });
  if (!res.ok) await refuse(res, "register the clone federation issuer");
  const body = (await res.json()) as { id?: string };
  if (!body.id || !FEDERATION_ISSUER_ID.test(body.id)) {
    throw new Error("Anthropic registered the clone issuer but returned no usable issuer id");
  }
  return body.id;
}

async function ensureServiceAccount(name: string): Promise<string> {
  const existing = await findByName("service_accounts", name);
  if (existing) return existing.id;

  const res = await orgFetch("/service_accounts", {
    method: "POST",
    // `developer`, never `admin`. An admin service account is what the
    // bootstrap rule targets and what an OAuth caller may not create rules
    // for; a clone's identity has no business at organisation scope.
    body: JSON.stringify({ name, organization_role: "developer" }),
  });
  if (!res.ok) await refuse(res, `create the service account "${name}"`);
  const body = (await res.json()) as { id?: string };
  if (!body.id || !SERVICE_ACCOUNT_ID.test(body.id)) {
    throw new Error(`Anthropic created "${name}" but returned no usable service account id`);
  }
  return body.id;
}

/**
 * Put the service account in the clone's workspace.
 *
 * Anthropic checks at exchange time "that the federation rule's workspace
 * matches one of the service account's workspace memberships" — so without
 * this the rule is created and every exchange fails, which reads like a bad
 * rule rather than a missing membership.
 */
async function addToWorkspace(serviceAccountId: string, workspaceId: string): Promise<void> {
  const res = await orgFetch(`/service_accounts/${serviceAccountId}/workspaces`, {
    method: "POST",
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  // A membership that already exists is success, not a fault: this runs again
  // on every reconcile pass for a clone whose earlier run got this far.
  if (!res.ok && res.status !== 409) {
    await refuse(res, `add ${serviceAccountId} to workspace ${workspaceId}`);
  }
}

async function ensureRule(input: {
  name: string;
  issuerId: string;
  subject: string;
  serviceAccountId: string;
  workspaceId: string;
}): Promise<string> {
  const existing = await findByName("federation_rules", input.name);
  if (existing) return existing.id;

  const res = await orgFetch("/federation_rules", {
    method: "POST",
    body: JSON.stringify(federationRuleBody(input)),
  });
  if (!res.ok) await refuse(res, `create the federation rule "${input.name}"`);
  const body = (await res.json()) as { id?: string };
  if (!body.id || !FEDERATION_RULE_ID.test(body.id)) {
    throw new Error(`Anthropic created "${input.name}" but returned no usable rule id`);
  }
  return body.id;
}

export type FederationOutcome = {
  cloneId: string;
  federated: boolean;
  ruleId?: string;
  serviceAccountId?: string;
  reason?: string;
  detail?: string;
  actionable?: boolean;
};

/**
 * Federate one clone, and withdraw the key it no longer needs.
 *
 * Never throws. The order is load-bearing: every Anthropic resource is created
 * and recorded BEFORE the key is withdrawn, because the prime prefers a key
 * whenever one is present — so a clone keeps working on the organisation key
 * until the moment federation is proven to exist, and a run that fails halfway
 * leaves a working deployment rather than one that can reach nothing.
 */
export async function federateClone(
  supabase: Db,
  cloneId: string,
): Promise<FederationOutcome> {
  let target: { cloneId: string; cloneName: string; projectRef: string };
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    if (e instanceof CloneSecretTargetError) {
      return { cloneId, federated: false, reason: e.reason, detail: e.message, actionable: false };
    }
    return { cloneId, federated: false, reason: "unreadable", detail: msg(e), actionable: true };
  }

  const identity = await supabase
    .from("clone_anthropic_identity")
    .select("workspace_id, workspace_name, service_account_id, federation_rule_id")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (identity.error) {
    return {
      cloneId,
      federated: false,
      reason: "unreadable",
      detail: `the recorded Anthropic identity could not be read: ${identity.error.message}`,
      actionable: true,
    };
  }

  const keyRow = await supabase
    .from("clone_backend_secrets")
    .select("status")
    .eq("clone_id", cloneId)
    .eq("name", "ANTHROPIC_API_KEY")
    .maybeSingle();
  if (keyRow.error) {
    return {
      cloneId,
      federated: false,
      reason: "unreadable",
      detail: `the Anthropic key's ledger row could not be read: ${keyRow.error.message}`,
      actionable: true,
    };
  }

  const verdict = decideFederation({
    workspaceId: identity.data?.workspace_id ?? null,
    federationRuleId: identity.data?.federation_rule_id ?? null,
    anthropicKeyStatus: keyRow.data?.status ?? null,
    signingKeyPresent: signingKeyPresent(),
    bootstrapPresent: bootstrapPresent(),
  });

  if (!verdict.act) {
    return {
      cloneId,
      federated: false,
      reason: verdict.reason,
      detail: verdict.message,
      actionable: verdict.actionable,
      ...(identity.data?.federation_rule_id ? { ruleId: identity.data.federation_rule_id } : {}),
    };
  }

  const workspaceId = identity.data!.workspace_id as string;
  const workspaceName = (identity.data!.workspace_name as string) || target.cloneName;
  const subject = federationSubject(cloneId);

  // Enforced here as well as produced: a wildcard subject would let one
  // clone's assertion satisfy another clone's rule, which is the entire
  // boundary this creates.
  const wildcard = refuseWildcardSubject(subject);
  if (wildcard) {
    return { cloneId, federated: false, reason: "bad_subject", detail: wildcard, actionable: true };
  }

  let issuerId: string;
  let serviceAccountId: string;
  let ruleId: string;
  try {
    issuerId = await ensureCloneIssuer();
    serviceAccountId = await ensureServiceAccount(federationResourceName("sa", workspaceName));
    await addToWorkspace(serviceAccountId, workspaceId);
    ruleId = await ensureRule({
      name: federationResourceName("rule", workspaceName),
      issuerId,
      subject,
      serviceAccountId,
      workspaceId,
    });
  } catch (e) {
    return { cloneId, federated: false, reason: "vendor_failed", detail: msg(e), actionable: true };
  }

  const { error: recordError } = await supabase
    .from("clone_anthropic_identity")
    .update({
      service_account_id: serviceAccountId,
      federation_rule_id: ruleId,
      federation_issuer_id: issuerId,
      federated_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("clone_id", cloneId);

  if (recordError) {
    /*
     * The resources exist at Anthropic and this row does not name them. The
     * key is NOT withdrawn — the clone goes on working on it — and the next
     * pass finds the same resources by name rather than creating more. That is
     * the whole reason every `ensure*` above looks before it creates.
     */
    return {
      cloneId,
      federated: false,
      ruleId,
      serviceAccountId,
      reason: "ledger_failed",
      detail:
        `Anthropic federation exists for this clone and could not be recorded: ` +
        `${recordError.message}. Its key is untouched, so nothing has stopped working.`,
      actionable: true,
    };
  }

  /*
   * Only now does the key go. `withdrawAnthropicKey` marks it `federated`
   * rather than `withheld`: mechanically the fleet sweep treats both the same
   * way and removes the value, but `withheld` means a PERSON deliberately
   * removed the credential, and `decideWorkspaceProvision` reads that as "this
   * clone has no Anthropic calls to attribute" — the opposite of true here.
   */
  /*
   * Prove the clone can USE federation before taking away what it has.
   *
   * A clone running a backend that predates the federation client has no
   * federated path at all: removing `ANTHROPIC_API_KEY` leaves it with
   * nothing, and its model calls stop. Nothing above this line can tell —
   * creating a rule at the vendor says nothing about what the tenant's project
   * is running.
   *
   * The probe answers precisely that question. It cannot prove the federated
   * ROUTE while the key is still present (a key present always wins, by
   * design), and it does not need to: an answer carrying a `reach` at all is
   * proof the deployed build carries `anthropicCredential.ts`, which is the
   * thing in doubt. The route itself is proved by the reachability sweep once
   * the key is gone.
   *
   * It fails CLOSED. An unreachable clone, a clone with no Mission Control
   * link, or a backend that answers a plain "ok" all leave the key in place:
   * withdrawing a working credential on evidence nobody could gather is the
   * destructive direction, and a clone left on the organisation key is the
   * state it is in today.
   */
  const { runCloneAnthropicSelftest } = await import("./anthropicSelftest.server");
  const probe = await runCloneAnthropicSelftest(cloneId);

  /*
   * `probe.ok` and `probe.reach.ok` are different questions, and only the
   * first was asked here.
   *
   * The outer flag says a READING came back — which proves the deployed build
   * carries the federation client, the thing this guard was written for. It
   * says nothing about whether the clone can currently reach Anthropic. A
   * clone whose credential has already drifted answers `ok: true` with a
   * reading of `ok: false`, and the key went anyway: the ledger was then
   * stamped `federated`, which puts the name in the fleet sweep's removal set,
   * so any key that returned would be taken off again. A clone that can
   * neither federate nor keep a key is broken permanently.
   *
   * Withdrawal now needs the clone to be reaching Anthropic right now — on
   * whatever route it is using. That is the honest precondition for taking a
   * working credential away, and it fails closed on a clone that is already
   * in trouble rather than finishing it off.
   */
  if (!probe.ok || !probe.reach.ok) {
    return {
      cloneId,
      federated: false,
      ruleId,
      serviceAccountId,
      reason: "client_unproved",
      detail: !probe.ok
        ? probe.reason === "no_probe_in_answer"
          ? "This clone's backend predates the federation client, so removing its Anthropic key " +
            "would leave it unable to reach Anthropic at all. Its resources are created and " +
            "recorded; deploy the current edge functions to it and the next pass withdraws the key."
          : `This clone could not be asked whether it carries the federation client (${probe.reason}), ` +
            "so its Anthropic key is untouched and nothing has stopped working."
        : "This clone cannot currently reach Anthropic at all" +
          (probe.reach.why ? `: ${probe.reach.why}` : "") +
          ". Its Anthropic key is untouched — taking a credential from a deployment that is " +
          "already failing cannot repair it, and would leave it unable to hold one at all.",
      actionable: true,
    };
  }

  const withdrawn = await withdrawAnthropicKey(supabase, cloneId, target.projectRef);
  if (withdrawn) {
    return {
      cloneId,
      federated: false,
      ruleId,
      serviceAccountId,
      reason: "withdraw_failed",
      detail: withdrawn,
      actionable: true,
    };
  }

  return {
    cloneId,
    federated: true,
    ruleId,
    serviceAccountId,
    detail:
      `This clone now reaches Anthropic with no static key: a five-minute assertion naming it ` +
      `alone, exchanged for a token bound to workspace ${workspaceId}.`,
  };
}

/** Remove the key from the project and mark the ledger. Returns an error, or null. */
async function withdrawAnthropicKey(
  supabase: Db,
  cloneId: string,
  projectRef: string,
): Promise<string | null> {
  try {
    const { deleteCloneSecretValues } = await import("./backend-provisioning.server");
    const removed = await deleteCloneSecretValues(projectRef, ["ANTHROPIC_API_KEY"]);
    if (!removed.ok) {
      return `the Anthropic key could not be removed from the project: ${removed.error}`;
    }
  } catch (e) {
    return `the Anthropic key could not be removed from the project: ${msg(e)}`;
  }

  const { error } = await supabase
    .from("clone_backend_secrets")
    .upsert(
      {
        clone_id: cloneId,
        name: "ANTHROPIC_API_KEY",
        status: FEDERATED_STATUS,
        last_set_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "clone_id,name" },
    );

  /*
   * The key is off the project and the ledger does not say so. That is the
   * dangerous half: the fleet sweep forwards any name not marked, so the key
   * would be back within thirty minutes and this clone would silently stop
   * federating. Reported as actionable rather than swallowed.
   */
  return error
    ? `the Anthropic key was removed from the project and the ledger could not be marked ` +
        `${FEDERATED_STATUS}: ${error.message}. The fleet sweep will put the key back within ` +
        "thirty minutes, so this clone will stop federating until the row is corrected."
    : null;
}

/** Federate every clone that has a workspace and no rule yet. */
export async function reconcileAnthropicFederation(
  supabase: Db,
): Promise<{ considered: number; federated: number; outcomes: FederationOutcome[] }> {
  /*
   * Every identity, not just the ones with no rule.
   *
   * Filtering on a null rule means a clone whose resources were created and
   * whose KEY WITHDRAWAL then failed is never looked at again — it is not a
   * candidate, and `decideFederation` never gets the chance to refuse or
   * retry. Refusals are ordinary here, exactly as in the workspace reconcile:
   * a clone whose tenant supplied its own key refuses on every pass for ever,
   * and that is the correct answer rather than a backlog.
   */
  const { data, error } = await supabase
    .from("clone_anthropic_identity")
    .select("clone_id");
  if (error) throw new Error(`Could not list clones to federate: ${error.message}`);

  const outcomes: FederationOutcome[] = [];
  for (const row of (data ?? []) as Array<{ clone_id: string }>) {
    outcomes.push(await federateClone(supabase, row.clone_id));
  }

  return {
    considered: outcomes.length,
    federated: outcomes.filter((o) => o.federated).length,
    outcomes,
  };
}
