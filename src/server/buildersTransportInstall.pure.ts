/**
 * Installing a Builders Network connection's transport on the clone that owns
 * it — the hand-off both sides describe and neither performs.
 *
 * ## The gap this closes
 *
 * A connection needs the SAME symmetric secret on both sides: the network
 * signs its deliveries to `builder-network-inbound` with it, and the clone
 * signs its outbound events with it. The network mints that secret when a
 * connection is accepted, keeps it RLS-closed, and hands it out exactly once,
 * from `provision_transport`, under a comment naming who is meant to catch it:
 *
 *   > Returned ONCE, for MC to install in the clone's
 *   > builder_network_connections row alongside this URL.
 *
 * Mission Control never wrote that catcher. Read across the three
 * repositories, the act had three different owners and no implementation:
 * the clone's own mirror migration attributes it to "Mission Control's
 * provisioning machinery"; Mission Control's trust-anchor migration says the
 * opposite in as many words ("the trust anchor and nothing else … operator
 * visibility only, never authoritative"); and the extraction plan says the
 * secret is "minted by the clone at connection time". The clone reads
 * `builder_network_connections` in four places and writes it in none —
 * `builderNetwork.ts` says so outright: "Nothing here invents a connection."
 *
 * So the table is empty on every deployment, the outbox drains nothing, the
 * inbound door refuses by name, and Builder Stock is empty on a clone while
 * the network holds 1,066 items for it. Not a misconfiguration: a row nobody
 * can create.
 *
 * ## The rules this module exists to hold
 *
 * **A one-shot secret is not requested until there is somewhere to put it.**
 * `provision_transport` stamps `hmac_provisioned_at` and refuses a second
 * call, so a secret taken and then dropped is GONE — the only recovery is
 * `rotate_transport`, which invalidates whatever the clone already had. The
 * clone is therefore proved writable BEFORE the network is asked, and the
 * order is a property of this module rather than a habit of its caller.
 *
 * **The secret never travels to a browser.** It is fetched and installed
 * inside one server act; every reading this module produces for an operator
 * is a status, and `redactInstallOutcome` is what the route returns.
 *
 * **A spent secret says so.** If the install fails after the network has
 * handed the secret over, the answer names the rotation remedy rather than
 * reporting a generic failure — because the difference decides whether the
 * operator may simply press the button again.
 */

/** Why an install may not be attempted at all. */
export type InstallRefusal =
  | { reason: "unknown_connection"; message: string }
  | { reason: "no_clone_on_connection"; message: string }
  | { reason: "clone_backend_missing"; message: string }
  | { reason: "clone_backend_not_ready"; message: string; status: string }
  | { reason: "clone_credentials_incomplete"; message: string }
  | { reason: "clone_unwritable"; message: string; detail: string }
  | { reason: "connection_revoked"; message: string };

/** What the caller knows about the clone side before anything is spent. */
export interface CloneTarget {
  cloneId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  status: string | null;
}

/**
 * Judge the clone side before the network is asked for anything.
 *
 * Every refusal here costs nothing and is fully recoverable. That is the
 * point: once `provision_transport` answers, the secret is spent whatever
 * happens next.
 */
export function refuseBeforeSpending(input: {
  connection: { clone_id: string | null; state: string | null } | null;
  backend: {
    supabase_url: string | null;
    service_role_key: string | null;
    status: string | null;
  } | null;
}): InstallRefusal | null {
  if (!input.connection) {
    return {
      reason: "unknown_connection",
      message:
        "This connection is not in Mission Control's shadow ledger, so there is no way to tell " +
        "which workspace it belongs to. Mint the connection from this console first.",
    };
  }
  if (input.connection.state === "revoked") {
    return {
      reason: "connection_revoked",
      message:
        "This connection is revoked, and revocation is terminal — there is no un-revoke. " +
        "Reconnecting is a new connection.",
    };
  }
  if (!input.connection.clone_id) {
    return {
      reason: "no_clone_on_connection",
      message: "The shadow ledger holds no workspace for this connection.",
    };
  }
  if (!input.backend) {
    return {
      reason: "clone_backend_missing",
      message:
        "This workspace has no backend on record, so Mission Control holds no credentials for it.",
    };
  }
  if (input.backend.status !== "ready") {
    return {
      reason: "clone_backend_not_ready",
      status: input.backend.status ?? "unknown",
      message:
        `This workspace's backend is "${input.backend.status ?? "unknown"}" rather than ready. ` +
        "Finish provisioning it before connecting it to the network.",
    };
  }
  if (!input.backend.supabase_url || !input.backend.service_role_key) {
    return {
      reason: "clone_credentials_incomplete",
      message:
        "Mission Control holds an incomplete credential set for this workspace, so it cannot " +
        "write the connection row.",
    };
  }
  return null;
}

/**
 * The row installed on the clone.
 *
 * `state` is `active` because `provision_transport` answers only on an active
 * connection — the network has already accepted. `accepted_at` records when
 * this workspace learned of it, which is what the clone's own surfaces read;
 * the network keeps the authoritative acceptance time.
 */
export function cloneConnectionRow(input: {
  networkConnectionId: string;
  hmacSecret: string;
  networkInboundUrl: string;
  builderOrgLabel: string | null;
  scopes: string[] | null;
  now: string;
}): Record<string, unknown> {
  return {
    network_connection_id: input.networkConnectionId,
    builder_org_label: input.builderOrgLabel,
    state: "active",
    scopes: input.scopes ?? [],
    outbound_hmac_secret: input.hmacSecret,
    network_inbound_url: input.networkInboundUrl,
    accepted_at: input.now,
    updated_at: input.now,
  };
}

/**
 * What the network's answer to `provision_transport` has to carry for the
 * install to be worth attempting.
 *
 * A body missing either half is a protocol disagreement, not a transient
 * fault, so it is named rather than retried.
 */
export function readTransportGrant(
  body: Record<string, unknown>,
): { ok: true; secret: string; inboundUrl: string } | { ok: false; message: string } {
  const secret = typeof body.hmac_secret === "string" ? body.hmac_secret.trim() : "";
  const inboundUrl =
    typeof body.network_inbound_url === "string" ? body.network_inbound_url.trim() : "";
  if (!secret) {
    return {
      ok: false,
      message: "The network provisioned transport without returning a secret.",
    };
  }
  if (!/^https:\/\//.test(inboundUrl)) {
    return {
      ok: false,
      message: "The network returned no https inbound URL to deliver to.",
    };
  }
  return { ok: true, secret, inboundUrl };
}

/**
 * The reading for an install that failed AFTER the secret was handed over.
 *
 * This is the one failure an operator must not simply retry: the secret is
 * spent, `provision_transport` will answer `transport_already_provisioned`,
 * and only a rotation issues a usable one again.
 */
export function spentSecretRemedy(detail: string): string {
  return (
    `The network handed over the transport secret and this workspace could not be written: ${detail}. ` +
    "That secret is spent — provisioning answers only once — so pressing this again will be " +
    "refused. Use Rotate transport, which issues a new secret and installs it."
  );
}

/** An outcome safe to return to a browser: never the secret, ever. */
export type InstallOutcome =
  | { ok: true; cloneId: string; networkConnectionId: string; rotated: boolean }
  | { ok: false; error: string; remedy?: string };

/**
 * Strip anything credential-shaped from an outcome before it leaves the
 * server. Cheap insurance: the module above never puts a secret in an
 * outcome, and this is what keeps that true when somebody adds a field.
 */
export function redactInstallOutcome(outcome: InstallOutcome): InstallOutcome {
  if (outcome.ok) {
    return {
      ok: true,
      cloneId: outcome.cloneId,
      networkConnectionId: outcome.networkConnectionId,
      rotated: outcome.rotated,
    };
  }
  return outcome.remedy
    ? { ok: false, error: outcome.error, remedy: outcome.remedy }
    : { ok: false, error: outcome.error };
}
