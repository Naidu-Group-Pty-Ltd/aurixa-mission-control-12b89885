/**
 * Setting a demo clone's staff account back to a password the operator holds.
 *
 * ## Why it exists
 *
 * Measured 31 Oct 2026: the tutorial demo's three accounts (its owner, an
 * admin and a user) could not be signed in to by anybody. Their passwords and
 * the owner's authenticator key had been sent once, in a file, and every
 * other copy deleted, as the tutorial programme requires. Nothing could set
 * them again:
 *
 * - the product's own reset (`admin-password-reset`) emails a one-time code,
 *   and a demo's accounts are `.example` addresses, which receive no mail;
 * - its user management needs an administrator who is already signed in;
 * - the owner's authenticator would refuse a new password anyway;
 * - Mission Control had no lever.
 *
 * The owner chose to build one rather than write to the clone's database by
 * hand.
 *
 * ## What it writes, and why exactly that
 *
 * What the product's own reset writes, to the one account named: a bcrypt
 * `password_hash` at cost 10, made by pgcrypto as the admin seed's is
 * (`seedProductAdminIdentity`) and read by the product's `_shared/password.ts`;
 * `failed_login_attempts` back to 0 and `locked_until` cleared, because a
 * reset that leaves the lock standing reads as a reset that failed; and every
 * `user_sessions` row of the account deleted, so a session opened before the
 * reset does not outlive it.
 *
 * Asked to, it also undoes the product's TOTP enrolment (`security-step-up`):
 * the `mfa_*` columns go back to never-enrolled, and the account's pending
 * enrolment challenges and passkeys are deleted. The account then signs in
 * with its password alone and enrols again through the product, which issues
 * a new key and new recovery codes.
 *
 * ## What it never does
 *
 * - Reach a clone that is not a demo (`demoCloneRefusal`), or the prime
 *   (`resolveCloneSecretTarget`, in the caller).
 * - Re-activate an account that is deactivated or deleted. That is the
 *   workspace's decision, and a reset is not the way round it.
 * - Keep the password. It reaches the clone inside one statement and is
 *   checked there against the hash it made. Mission Control never stores,
 *   logs, audits or returns it, and an error that quotes the statement is
 *   scrubbed of it ({@link scrubCredential}).
 */
import { sqlCredentialLiteral } from "./cloneAdminIdentity.pure";
import { demoCloneRefusal } from "./demoClone.pure";

/** Why this clone's accounts may not be reset from Mission Control, or null when they may. */
export function accountResetRefusal(clone: {
  billing_stripe_customer_id: string | null;
  entitled_plan_slug: string | null;
  tags: readonly string[] | null;
}): string | null {
  const refusal = demoCloneRefusal(clone);
  if (!refusal) return null;
  switch (refusal.reason) {
    case "stripe_customer":
      return (
        "This clone has a Stripe customer, so it is somebody's workspace: its people reset " +
        "their own accounts, never Mission Control."
      );
    case "entitled_plan":
      return (
        `This clone is entitled to the ${refusal.plan} plan, so it is somebody's workspace: ` +
        "its people reset their own accounts, never Mission Control."
      );
    case "not_tagged_demo":
      return (
        "Only a clone tagged demo may have its accounts reset from Mission Control. Tag it on " +
        "the clone page first if it is one."
      );
  }
}

/**
 * The product's own minimum (`_shared/passwordValidation.ts`). Its list of
 * common passwords is shorter than this throughout, so the length rule covers
 * it; its breach lookup is not repeated for a password generated at random.
 */
export const MIN_RESET_PASSWORD_LENGTH = 12;

/** bcrypt reads the first 72 bytes of a password and ignores the rest, without saying so. */
export const MAX_RESET_PASSWORD_BYTES = 72;

/** Why this password may not be set, or null when it may. */
export function resetPasswordRefusal(password: string): string | null {
  if (/[\\\r\n\0]/.test(password)) {
    return (
      "The password may not contain a backslash, a line break or a NUL: it reaches the clone " +
      "inside one SQL statement."
    );
  }
  if (password.length < MIN_RESET_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_RESET_PASSWORD_LENGTH} characters, as the product requires.`;
  }
  if (new TextEncoder().encode(password).length > MAX_RESET_PASSWORD_BYTES) {
    return `The password must be at most ${MAX_RESET_PASSWORD_BYTES} bytes: bcrypt ignores everything after that.`;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((c) => c.test(password));
  if (classes.length < 2) {
    return (
      "The password must mix at least two of lowercase, uppercase, digits and symbols, as the " +
      "product requires."
    );
  }
  return null;
}

/** A staff account is named by its username or its email, as the product's sign-in takes either. */
export function accountIdentifierRefusal(account: string): string | null {
  const name = account.trim();
  if (!name) return "Name the account: its username or its email.";
  if (!/^[A-Za-z0-9._%+@-]{1,254}$/.test(name)) {
    return "An account is named by its username or its email: letters, digits and . _ % + @ - only.";
  }
  return null;
}

export type AccountResetRequest = {
  readonly account: string;
  readonly password: string;
  readonly clearAuthenticator: boolean;
};

/*
 * Undoes `security-step-up`'s enrolment. The columns are read from the table
 * rather than assumed, because a clone a few migrations behind its prime may
 * lack one of them, and an update naming a missing column fails the reset.
 */
const CLEAR_AUTHENTICATOR = `
  select string_agg(
           format('%I = %s', column_name,
                  case when column_name = 'mfa_required' then 'false' else 'null' end),
           ', ')
    into v_set
    from information_schema.columns
   where table_schema = 'public' and table_name = 'custom_users'
     and column_name in ('mfa_enrolled_at', 'mfa_method', 'mfa_secret_encrypted',
                         'mfa_recovery_codes_hash', 'mfa_last_verified_at',
                         'mfa_last_totp_counter', 'mfa_required');
  if v_set is not null then
    execute format('update public.custom_users set %s where id = %L', v_set, v_id);
  end if;
  if to_regclass('public.mfa_totp_enrollment_challenges') is not null then
    delete from public.mfa_totp_enrollment_challenges where user_id = v_id;
  end if;
  if to_regclass('public.mfa_webauthn_challenges') is not null then
    delete from public.mfa_webauthn_challenges where user_id = v_id;
  end if;
  if to_regclass('public.user_webauthn_credentials') is not null then
    delete from public.user_webauthn_credentials where user_id = v_id;
  end if;
`;

/**
 * The reset, as one statement for the clone.
 *
 * Every decision is made on the clone, in one transaction, so nothing is half
 * done: the account is found by username or email among the accounts not
 * deleted, refused unless exactly one answers and it is active, then written.
 * What happened is left in settings that the closing select reads back,
 * because a block cannot return rows. Each run sets every setting before
 * reading any, so a pooled connection that ran an earlier reset is never read
 * as this one.
 */
export function buildAccountResetSql(req: AccountResetRequest): string {
  const account = sqlCredentialLiteral(req.account.trim().toLowerCase());
  const password = sqlCredentialLiteral(req.password);
  return `
do $reset$
declare
  v_ids uuid[];
  v_id uuid;
  v_active boolean;
  v_sessions integer := 0;
  v_set text;
begin
  perform set_config('aurixa.account_reset', 'no_identity_store', false);
  perform set_config('aurixa.account_reset_verifies', '', false);
  perform set_config('aurixa.account_reset_authenticator_clear', '', false);
  perform set_config('aurixa.account_reset_sessions', '0', false);
  if to_regclass('public.custom_users') is null then
    return;
  end if;

  select array_agg(id) into v_ids
    from public.custom_users
   where (lower(username) = ${account} or lower(email) = ${account})
     and deleted_at is null;
  if v_ids is null then
    perform set_config('aurixa.account_reset', 'no_account', false);
    return;
  end if;
  if cardinality(v_ids) > 1 then
    perform set_config('aurixa.account_reset', 'ambiguous', false);
    return;
  end if;
  v_id := v_ids[1];

  select is_active into v_active from public.custom_users where id = v_id;
  if v_active is distinct from true then
    perform set_config('aurixa.account_reset', 'inactive', false);
    return;
  end if;

  update public.custom_users
     set password_hash = extensions.crypt(${password}, extensions.gen_salt('bf', 10)),
         failed_login_attempts = 0,
         locked_until = null,
         updated_at = now()
   where id = v_id;
${req.clearAuthenticator ? CLEAR_AUTHENTICATOR : ""}
  if to_regclass('public.user_sessions') is not null then
    delete from public.user_sessions where user_id = v_id;
    get diagnostics v_sessions = row_count;
  end if;

  perform set_config('aurixa.account_reset_verifies',
    (select (password_hash = extensions.crypt(${password}, password_hash))::text
       from public.custom_users where id = v_id), false);
  perform set_config('aurixa.account_reset_authenticator_clear',
    (select ((to_jsonb(u) ->> 'mfa_enrolled_at') is null)::text
       from public.custom_users u where id = v_id), false);
  perform set_config('aurixa.account_reset_sessions', v_sessions::text, false);
  perform set_config('aurixa.account_reset', 'reset', false);
end
$reset$;
select current_setting('aurixa.account_reset', true) as outcome,
       current_setting('aurixa.account_reset_verifies', true) as password_verifies,
       current_setting('aurixa.account_reset_authenticator_clear', true) as authenticator_clear,
       current_setting('aurixa.account_reset_sessions', true) as sessions_ended
`.trim();
}

/** Why no account was reset. */
export type AccountResetMiss = "no_identity_store" | "no_account" | "ambiguous" | "inactive";

export type AccountResetOutcome =
  | {
      readonly done: true;
      readonly passwordVerifies: boolean;
      /** True when the account has no authenticator now, null when the clone could not say. */
      readonly authenticatorClear: boolean | null;
      readonly sessionsEnded: number;
    }
  | { readonly done: false; readonly why: AccountResetMiss | "unreadable" };

/** What the closing select says happened. Anything it does not say is `unreadable`, never "nothing". */
export function readAccountResetOutcome(rows: unknown): AccountResetOutcome {
  const row = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null | undefined;
  const outcome = row?.outcome;
  if (outcome === "reset") {
    const sessions = Number(row?.sessions_ended);
    const clear = row?.authenticator_clear;
    return {
      done: true,
      passwordVerifies: row?.password_verifies === "true",
      authenticatorClear: clear === "true" ? true : clear === "false" ? false : null,
      sessionsEnded: Number.isInteger(sessions) && sessions >= 0 ? sessions : 0,
    };
  }
  if (
    outcome === "no_identity_store" ||
    outcome === "no_account" ||
    outcome === "ambiguous" ||
    outcome === "inactive"
  ) {
    return { done: false, why: outcome };
  }
  return { done: false, why: "unreadable" };
}

/** The operator's line for a reset that did not happen, or may not have. */
export function accountResetMissLine(
  why: AccountResetMiss | "unreadable",
  account: string,
): string {
  switch (why) {
    case "no_identity_store":
      return "This clone has no custom_users table, so it has no staff accounts to reset.";
    case "no_account":
      return `No account on this clone answers to ${account}, by username or by email. Deleted accounts are not counted.`;
    case "ambiguous":
      return `More than one account on this clone answers to ${account}. Name it by its email instead.`;
    case "inactive":
      return `The account ${account} is deactivated. Reactivate it in the workspace first; a reset does not.`;
    case "unreadable":
      return (
        "The clone ran the reset but did not say what it did, so it is unconfirmed: the " +
        "password may or may not have changed. Sign in with it before relying on it."
      );
  }
}

/**
 * The text of an error, with the password taken out.
 *
 * A failed statement's error can quote the statement, which holds the
 * password in a SQL literal, with its quotes doubled. Both spellings are
 * replaced before the text reaches a log, the audit row or the operator.
 */
export function scrubCredential(text: string, password: string): string {
  if (!password) return text;
  let out = text;
  for (const form of new Set([password, password.replace(/'/g, "''")])) {
    out = out.split(form).join("[password withheld]");
  }
  return out;
}
