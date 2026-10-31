// Resetting a demo clone's staff account: the operator surface over
// `src/server/cloneAccountReset.server.ts`. Admin-only, as every other write of
// a clone credential is (`setCloneBackendSecret`, `retryBackendProvisioning`,
// the CAPTCHA test pair). The password is passed through, never kept: it is
// not in the audit row, the result or any log.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const requireCloneId = (input: { cloneId: string }) => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

type ResetInput = {
  cloneId: string;
  account: string;
  password: string;
  clearAuthenticator: boolean;
};

const requireResetInput = (input: ResetInput): ResetInput => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  if (typeof input.account !== "string" || typeof input.password !== "string") {
    throw new Error("account and password are required");
  }
  return {
    cloneId: input.cloneId,
    account: input.account,
    password: input.password,
    clearAuthenticator: input.clearAuthenticator === true,
  };
};

/** Whether the panel may offer the reset on this clone, and if not, why. */
export const getCloneAccountResetEligibility = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { readAccountResetEligibility } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/clone-account-reset.server"
    );
    const res = await readAccountResetEligibility(context.supabase, data.cloneId);
    return res.eligible
      ? { eligible: true as const, reason: null }
      : { eligible: false as const, reason: res.reason };
  });

/**
 * Set a demo clone's staff account to the operator's password, ending its
 * sessions, and clear its authenticator when asked. Refused for the prime and
 * for anything a customer signs in to — see `accountResetRefusal`.
 */
export const resetCloneDemoAccountFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireResetInput)
  .handler(async ({ data, context }) => {
    const { resetCloneDemoAccount } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/clone-account-reset.server"
    );
    const res = await resetCloneDemoAccount(context.supabase, data.cloneId, {
      account: data.account,
      password: data.password,
      clearAuthenticator: data.clearAuthenticator,
    });
    // The account, what was asked and what happened. Never the password.
    const { error: auditError } = await context.supabase.from("audit_log").insert({
      action: "clone_account.reset",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        account: data.account.trim().toLowerCase(),
        clear_authenticator: data.clearAuthenticator,
        ok: res.ok,
        authenticator_clear: res.ok ? res.authenticatorClear : null,
        sessions_ended: res.ok ? res.sessionsEnded : null,
        error: res.ok ? null : res.error,
      },
    });
    if (auditError) {
      console.error("[clone-account-reset] audit row not recorded:", auditError.message);
    }
    return res;
  });
