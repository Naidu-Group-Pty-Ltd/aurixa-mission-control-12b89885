/**
 * Reaching Anthropic with no key at all.
 *
 * ## What this replaces
 *
 * Phase one gave each clone its own Anthropic workspace and left every clone
 * running on one organisation-wide key. That key is copied onto every tenant
 * project, and it can act in ANY workspace the organisation has — so a clone
 * could name another tenant's workspace in its header and spend on their line,
 * or reach the Files, Batches and Skills scoped to it. Narrower than the Didit
 * exposure this platform already closed, and the same class.
 *
 * Workload Identity Federation removes it. Mission Control registers as an
 * OIDC issuer, signs a short-lived assertion naming ONE clone, and Anthropic
 * exchanges that for an access token bound to that clone's own service account
 * and its own workspace. There is no `sk-ant-api…` string to mint, distribute
 * or rotate, and every resource it needs — service accounts, issuers, rules —
 * is creatable through the Admin API.
 *
 * ## Why the call is not brokered
 *
 * Mission Control sits on the TOKEN path, roughly once an hour per clone, and
 * never on the inference path. Model calls are the highest-volume vendor
 * traffic in this product, they stream, and they run against a ~150s edge
 * ceiling; putting a broker in front of every report generation would buy a
 * new failure domain and nothing else. Didit and Airtable are brokered because
 * their traffic is a handful of writes and a cached read. This is not that.
 *
 * ## Four rules
 *
 * **A subject is exact, never a prefix.** Anthropic's own documentation warns
 * that `subject_prefix` matches exactly *unless it ends in `*`* — and a
 * trailing wildcard on `clone:` would let any clone's assertion satisfy any
 * clone's rule. `federationSubject` produces a full uuid and
 * `refuseWildcardSubject` fails anything carrying one.
 *
 * **Two issuers, and the reason is not symmetry.** An OAuth caller cannot
 * update an issuer that backs a rule scoped above `workspace:developer`. One
 * shared issuer would therefore freeze every clone's rule behind the
 * organisation-admin rule that bootstraps all of this, and the only repair
 * would be in the Console. The bootstrap gets its own.
 *
 * **The bootstrap is one Console act and cannot be automated.** Anthropic
 * refuses to let a workload grant itself organisation-admin, deliberately. So
 * this module names what a person creates once and never pretends it can
 * create it — and the automation is self-limiting either way, because an OAuth
 * caller may only create rules at `workspace:developer` or
 * `workspace:inference`.
 *
 * **Withdrawing the key is part of establishing federation, and it has its own
 * status.** A clone that federates must hold NO `ANTHROPIC_API_KEY`, because
 * the prime prefers a key whenever one is present. `withheld` would have
 * worked mechanically and lied: it means a person deliberately removed the
 * credential, and `decideWorkspaceProvision` reads it as "this clone has no
 * Anthropic calls to attribute" — which is the opposite of true here.
 *
 * Pure: no network, no database, no Node globals.
 */

/** The ledger status a clone carries once it reaches Anthropic by federation. */
export const FEDERATED_STATUS = "federated";

/** A person took the credential off. Never undone on a schedule. */
export const WITHHELD_STATUS = "withheld";

/** PKCS8 PEM. Mission Control signs every clone assertion with it. */
export const FEDERATION_KEY_ENV = "ANTHROPIC_FEDERATION_PRIVATE_KEY";

/** The organisation every workspace, service account and rule belongs to. */
export const FEDERATION_ORG_ENV = "ANTHROPIC_ORGANIZATION_ID";

/**
 * The one Console-created rule, and the admin service account it targets.
 *
 * Named as configuration rather than derived, because Anthropic will not let
 * automation create them: "granting a workload organization-admin access is a
 * deliberate human action, not something automation can bootstrap for itself."
 */
export const BOOTSTRAP_RULE_ENV = "ANTHROPIC_BOOTSTRAP_RULE_ID";
export const BOOTSTRAP_SERVICE_ACCOUNT_ENV = "ANTHROPIC_BOOTSTRAP_SERVICE_ACCOUNT_ID";

/** Where Mission Control publishes the keys Anthropic verifies assertions against. */
export const JWKS_PATH = "/api/public/anthropic/jwks";

/** The `iss` a clone's assertion carries, and the issuer registered for it. */
export const CLONE_ISSUER_PATH = "/api/public/anthropic";

/**
 * The bootstrap issuer, deliberately distinct.
 *
 * Both are Mission Control and both verify against the same JWKS. They are two
 * registered issuers because Anthropic locks an issuer that backs an
 * `org:admin` rule against OAuth edits — so sharing one would make every
 * clone's rule unmanageable through the very API this uses to create them.
 */
export const BOOTSTRAP_ISSUER_PATH = "/api/public/anthropic/bootstrap";

/** The subject the bootstrap assertion carries. One workload, one exact string. */
export const BOOTSTRAP_SUBJECT = "mission-control:bootstrap";

/**
 * The scope a clone's rule grants.
 *
 * `workspace:developer` is the documented default and grants what a workspace
 * API key grants. Anthropic also publishes `workspace:inference`; if it proves
 * sufficient for the Messages API it is the narrower choice and this is the
 * one line that changes. It is stated here rather than inline so that decision
 * has somewhere to be recorded.
 */
export const CLONE_OAUTH_SCOPE = "workspace:developer";

/** Assertion lifetime. Short, because its only job is to be exchanged at once. */
export const ASSERTION_LIFETIME_SECONDS = 300;

/**
 * How long a minted Anthropic token lives.
 *
 * Anthropic bounds it at the lesser of this and twice the assertion's
 * remaining life, so the assertion's 300s is what actually decides it — this
 * is a ceiling rather than a promise, and the clone reads `expires_in` from the
 * answer rather than believing either number.
 */
export const TOKEN_LIFETIME_SECONDS = 3600;

export const SERVICE_ACCOUNT_ID = /^svac_[A-Za-z0-9]{1,64}$/;
export const FEDERATION_RULE_ID = /^fdrl_[A-Za-z0-9]{1,64}$/;
export const FEDERATION_ISSUER_ID = /^fdis_[A-Za-z0-9]{1,64}$/;

/**
 * The subject one clone's assertions carry.
 *
 * A full uuid, and never a prefix anything else could sit under. The rule that
 * matches it is an exact match, so this string IS the boundary between one
 * tenant and another.
 */
export function federationSubject(cloneId: string): string {
  return `clone:${cloneId.trim().toLowerCase()}`;
}

/**
 * Why a subject may not be used, or null.
 *
 * Anthropic's own warning, enforced: "`subject_prefix` is an exact match unless
 * it ends in `*`. A trailing wildcard such as `repo:my-org/my-repo:*` also
 * matches pull_request runs…". Here a trailing `*` would let any clone's
 * assertion satisfy any clone's rule, which is the whole boundary gone.
 */
export function refuseWildcardSubject(subject: string): string | null {
  if (subject.includes("*")) {
    return (
      "A federation subject may not contain a wildcard. Anthropic matches " +
      "`subject_prefix` exactly unless it ends in `*`, and a wildcard here would let one " +
      "clone's assertion satisfy another clone's rule."
    );
  }
  if (!/^clone:[0-9a-f-]{36}$/.test(subject)) {
    return `A federation subject must name one clone exactly; "${subject}" does not.`;
  }
  return null;
}

/**
 * The name a federation resource carries at the vendor.
 *
 * Anthropic constrains these: "Resource names must match `^[a-z0-9-]+$`, be 1
 * to 255 characters, and be unique within an organization for each resource
 * type." The kind is part of the name so a service account and a rule for the
 * same clone are distinguishable in a list, and the clone slug matches the one
 * its workspace carries so one clone reads as one clone across every object.
 */
export function federationResourceName(
  kind: "sa" | "rule",
  workspaceName: string,
  max = 255,
): string {
  const slug = `${workspaceName}-${kind}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const named = slug || `aurixa-${kind}`;
  return named.length <= max ? named : named.slice(0, max).replace(/-+$/, "");
}

export type FederationVerdict =
  | { act: true }
  | {
      act: false;
      reason:
        | "already_federated"
        | "no_workspace"
        | "no_bootstrap"
        | "no_signing_key"
        | "tenant_supplied"
        | "withheld";
      message: string;
      /** False where nothing an operator does on this deployment would change it. */
      actionable: boolean;
    };

/**
 * Whether to federate this clone, from facts already read.
 *
 * The order is the guarantee. A tenant's own key outranks everything — the
 * same permanent stand-down `decideLlmKeyMint` and `decideWorkspaceProvision`
 * take first, and for the same reason: federating past it would put Aurixa
 * back on the hook for calls the tenant believes are theirs.
 */
export function decideFederation(input: {
  /** `clone_anthropic_identity.workspace_id`, or null where phase one has not run. */
  workspaceId: string | null;
  /** `clone_anthropic_identity.federation_rule_id`, or null. */
  federationRuleId: string | null;
  /** `clone_backend_secrets.status` for ANTHROPIC_API_KEY, or null. */
  anthropicKeyStatus: string | null;
  /** Whether Mission Control holds a signing key for assertions. */
  signingKeyPresent: boolean;
  /** Whether the Console-created bootstrap rule and service account are named. */
  bootstrapPresent: boolean;
}): FederationVerdict {
  if (input.anthropicKeyStatus === "set") {
    return {
      act: false,
      reason: "tenant_supplied",
      message:
        "This workspace supplied its own Anthropic key, so it is charged nothing for Anthropic " +
        "and reaches its own organisation. Federating would replace that with Aurixa's account.",
      actionable: false,
    };
  }

  /*
   * A rule is not the finish line — the KEY being gone is.
   *
   * Federation is two acts: create the resources and record them, then remove
   * the organisation key and mark the ledger `federated`. The second fails on
   * its own, and a guard that reads only the rule treats that half-done state
   * as complete: no later pass retries, the fleet sweep forwards the
   * organisation key straight back (the status is still `inherited`, so it is
   * not in the removal set), and every surface reports the clone as federated
   * while it runs on a key that can act in any workspace the organisation has.
   *
   * So the rule plus an unfinished withdrawal means ACT — `federateClone`
   * finds its existing resources rather than making new ones and goes to the
   * withdrawal it did not complete.
   */
  /*
   * `withheld` is written only by an explicit withdrawal, and federating past
   * it would hand the clone its Anthropic calls back — undoing a person's
   * decision on a schedule, with no signal but a row changing state. The same
   * stand-down `decideWorkspaceProvision` already takes, for the same reason.
   *
   * It matters MORE here than it did before the retry rule: while a rule alone
   * settled the question, a withheld clone that had got as far as a rule was
   * refused by accident. Now that an unfinished withdrawal is a reason to act,
   * nothing but this stops the next sweep from completing it.
   */
  if (input.anthropicKeyStatus === WITHHELD_STATUS) {
    return {
      act: false,
      reason: "withheld",
      message:
        "Anthropic was deliberately withheld from this clone. Federating it would give it " +
        "Anthropic calls again, which is the decision somebody made in the other direction.",
      actionable: false,
    };
  }

  if (input.federationRuleId && input.anthropicKeyStatus === FEDERATED_STATUS) {
    return {
      act: false,
      reason: "already_federated",
      message: `This clone already federates through rule ${input.federationRuleId}.`,
      actionable: false,
    };
  }

  /*
   * Phase one first, and not merely as ordering. A federation rule is created
   * IN a workspace and a service account must be a member of it — so without
   * one there is nothing to bind a rule to, and a rule bound to the default
   * workspace would federate this clone into the very undifferentiated line
   * the workspace exists to leave behind.
   */
  if (!input.workspaceId) {
    return {
      act: false,
      reason: "no_workspace",
      message:
        "This clone has no Anthropic workspace yet, so there is nothing for a federation rule to " +
        "bind to. The workspace step runs first and the reconcile sweep will reach it.",
      actionable: false,
    };
  }

  if (!input.signingKeyPresent) {
    return {
      act: false,
      reason: "no_signing_key",
      message:
        `Mission Control holds no ${FEDERATION_KEY_ENV}, so it cannot sign the assertion a clone ` +
        "exchanges for an Anthropic token. Until then every clone keeps the organisation key and " +
        "its own workspace header, which is exactly how it works today.",
      actionable: true,
    };
  }

  if (!input.bootstrapPresent) {
    return {
      act: false,
      reason: "no_bootstrap",
      message:
        `Mission Control holds no ${BOOTSTRAP_RULE_ENV} and ${BOOTSTRAP_SERVICE_ACCOUNT_ENV}. ` +
        "Anthropic will not let automation grant itself organisation-admin access, so that rule " +
        "is created once by a person in the Claude Console and named here. Nothing is broken " +
        "until it is.",
      actionable: true,
    };
  }

  return { act: true };
}

/** The claims one clone's assertion carries. */
export interface IdentityClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

/**
 * Build the assertion payload.
 *
 * `jti` is present and fresh on every call, deliberately. Anthropic treats an
 * assertion carrying one as single-use, which is replay protection worth
 * having — and it is why the clone's own credential module runs at most one
 * exchange at a time: a fan-out that exchanged once per concurrent section
 * would have every attempt after the first refused `jti_reused`, and the
 * failure would read like an outage.
 */
export function identityClaims(input: {
  issuer: string;
  subject: string;
  audience: string;
  nowSeconds: number;
  jti: string;
  lifetimeSeconds?: number;
}): IdentityClaims {
  return {
    iss: input.issuer,
    sub: input.subject,
    aud: input.audience,
    iat: input.nowSeconds,
    exp: input.nowSeconds + (input.lifetimeSeconds ?? ASSERTION_LIFETIME_SECONDS),
    jti: input.jti,
  };
}

/** The body that creates one clone's federation rule. */
export function federationRuleBody(input: {
  name: string;
  issuerId: string;
  subject: string;
  serviceAccountId: string;
  workspaceId: string;
}): Record<string, unknown> {
  return {
    name: input.name,
    issuer_id: input.issuerId,
    // Exact. `refuseWildcardSubject` has already rejected anything that is not.
    match: { subject_prefix: input.subject },
    target: { type: "service_account", service_account_id: input.serviceAccountId },
    workspace_id: input.workspaceId,
    oauth_scope: CLONE_OAUTH_SCOPE,
    token_lifetime_seconds: TOKEN_LIFETIME_SECONDS,
  };
}

/**
 * Whether an identity request may be answered for this clone.
 *
 * The endpoint authenticates the caller as a clone before this is reached;
 * this is the second question — whether the clone it authenticated as is the
 * one whose workspace it asked for. Asking it separately is what stops an
 * authenticated clone naming somebody else's workspace.
 */
export function identityRefusal(input: {
  requestedWorkspaceId: string | null | undefined;
  cloneWorkspaceId: string | null;
  federationRuleId: string | null;
  serviceAccountId: string | null;
}): string | null {
  if (!input.cloneWorkspaceId || !input.federationRuleId || !input.serviceAccountId) {
    return (
      "This deployment does not federate to Anthropic: Mission Control holds no federation rule " +
      "for it. It should be reaching Anthropic with the key it already has."
    );
  }

  const requested = (input.requestedWorkspaceId ?? "").trim();
  if (requested && requested !== input.cloneWorkspaceId) {
    /*
     * Refused rather than quietly answered for the right workspace. A clone
     * asking for a workspace that is not its own is either misconfigured or
     * probing, and both deserve to be told rather than silently corrected —
     * a silent correction makes the misconfiguration permanent and invisible.
     */
    return "A deployment may only ask for its own Anthropic workspace.";
  }

  return null;
}
