/**
 * Handing a working operator login for a clone to somebody who needs one.
 *
 * Two people need it and neither can get it today: the team auditing a fresh
 * clone before it goes out, and the client it is handed to.
 *
 * ## Why this ISSUES rather than reveals
 *
 * There is nothing to reveal. `queued_admin_password_enc` is the only place a
 * clone's admin password is ever written down, and every terminal outcome
 * clears it — success, exhaustion, the ceiling, a failed decrypt. That is
 * deliberate and stays: a live credential must not sit at rest on a row nobody
 * is working, and the alternative — keeping every tenant's admin password
 * recoverable for ever — is a far larger standing risk than the inconvenience
 * it removes.
 *
 * The retry hook already mints a fresh password and shows it to nobody, so a
 * clone provisioned by the agreement flow has an admin account whose password
 * has never existed outside the process that set it.
 *
 * So the honest act is to MINT one, write it to the clone, verify it, and show
 * it exactly once. That serves an audit and a handoff equally, and it can be
 * repeated whenever either is needed.
 *
 * ## The rules
 *
 * **Issuing is a rotation, and it is named as one before the click.** Anyone
 * holding the previous password loses it the moment this runs — including a
 * client who was handed one last week. A panel that called this "reveal" would
 * be describing a read while performing a write.
 *
 * **The plaintext is never stored.** It is returned to the one request that
 * asked and exists nowhere else; the audit row records THAT credentials were
 * issued, by whom and when, and never what they were.
 *
 * **An issue that cannot be verified is a failure, not a credential.** The
 * write goes through the same path provisioning uses, which reads the stored
 * hash back before reporting success — because a password handed to a client
 * that does not work is worse than telling them it could not be set.
 *
 * ## Why this sits in `lib/` and not beside its server module
 *
 * The build denies any client import matching `**\/server\/**`, by PATH and
 * not by content, so a pure module there is unimportable from a component
 * however free of server dependencies it is. Every other `@/server/*.pure`
 * import in this repository is from an `api.*` or `hooks.*` route, which never
 * enters the client bundle — this is the first one a rendered panel needed, and
 * it failed the build rather than the typecheck, after 4,032 modules had
 * transformed. `clonePaymentGate.pure.ts` is the precedent: a rule both a card
 * and a server handler read lives in `lib/`, and the `.server.ts` beside it
 * imports it from there.
 */

/** What Mission Control knows about a clone before anything is issued. */
export type CloneAccessInputs = {
  /** The clone's Supabase project, absent until the backend is provisioned. */
  readonly projectRef: string | null;
  /** The account provisioning seeded, absent on rows written before it recorded one. */
  readonly adminEmail: string | null;
  /** `clone_backends.status`. */
  readonly backendStatus: string | null;
  /** From the audit trail, never from a stored credential. */
  readonly lastIssuedAt: string | null;
  readonly lastIssuedBy: string | null;
};

export type CloneAccessState =
  /** No backend yet, so there is no database to write an operator into. */
  | { readonly kind: "no_backend"; readonly reason: string }
  /** A backend exists but nothing records which account to issue against. */
  | { readonly kind: "no_admin_email"; readonly reason: string }
  /** Ready. `rotates` is true once somebody already holds a credential. */
  | {
      readonly kind: "ready";
      readonly adminEmail: string;
      readonly rotates: boolean;
      readonly lastIssuedAt: string | null;
      readonly lastIssuedBy: string | null;
    };

/**
 * A backend that has not finished is still worth issuing against — the schema
 * and the admin account are written long before the last stage — so this
 * refuses only what genuinely has nowhere to write.
 */
export function readCloneAccessState(inputs: CloneAccessInputs): CloneAccessState {
  if (!inputs.projectRef) {
    return {
      kind: "no_backend",
      reason:
        "This clone has no Supabase project yet, so there is no database to create an operator in. " +
        "Provision the backend first.",
    };
  }
  const email = inputs.adminEmail?.trim();
  if (!email) {
    return {
      kind: "no_admin_email",
      reason:
        "No administrator address is recorded for this clone, so there is no account to issue against. " +
        "Set one on the clone, then issue credentials.",
    };
  }
  return {
    kind: "ready",
    adminEmail: email.toLowerCase(),
    rotates: Boolean(inputs.lastIssuedAt),
    lastIssuedAt: inputs.lastIssuedAt,
    lastIssuedBy: inputs.lastIssuedBy,
  };
}

/**
 * What the operator must be told BEFORE they press the button.
 *
 * Written for the two people this exists for: somebody auditing the clone, and
 * somebody about to hand it to a client. The rotation warning is the load
 * bearing half — the same act that gets you in locks out whoever had it.
 */
export function issueConfirmation(state: CloneAccessState): string | null {
  if (state.kind !== "ready") return null;
  const base =
    "A new password will be set on this clone's administrator account and shown to you once. " +
    "It is not stored anywhere and cannot be shown again.";
  return state.rotates
    ? `${base} This REPLACES the credentials issued previously — anyone still using them, including a client, will be locked out until you send them the new password.`
    : base;
}

/** Whether the panel offers the act at all. */
export function canIssue(state: CloneAccessState): boolean {
  return state.kind === "ready";
}
