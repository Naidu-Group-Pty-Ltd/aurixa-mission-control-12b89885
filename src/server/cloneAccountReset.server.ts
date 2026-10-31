/**
 * Resetting a demo clone's staff account from Mission Control.
 *
 * The rules, and why, are `cloneAccountReset.pure.ts`'s. This reads the facts
 * they need, refuses before anything is written, and runs the reset as one
 * statement on the clone through the Management API, the route the admin
 * seed takes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  accountIdentifierRefusal,
  accountResetMissLine,
  accountResetRefusal,
  buildAccountResetSql,
  readAccountResetOutcome,
  resetPasswordRefusal,
  scrubCredential,
  type AccountResetRequest,
} from "./cloneAccountReset.pure";
import { resolveCloneSecretTarget } from "./cloneAllowedOrigins.server";

type Db = SupabaseClient<Database>;

export type AccountResetEligibility =
  | { eligible: true; projectRef: string }
  | { eligible: false; reason: string };

export type AccountResetResult =
  | {
      ok: true;
      account: string;
      /** True when the account has no authenticator now, null when the clone could not say. */
      authenticatorClear: boolean | null;
      sessionsEnded: number;
    }
  | { ok: false; error: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Whether this clone's accounts may be reset, and where the reset would go.
 *
 * A demo only (`accountResetRefusal`), and never the prime or anything else
 * `resolveCloneSecretTarget` refuses for a clone-scoped write.
 */
export async function readAccountResetEligibility(
  supabase: Db,
  cloneId: string,
): Promise<AccountResetEligibility> {
  const { data: clone, error } = await supabase
    .from("clones")
    .select("billing_stripe_customer_id, entitled_plan_slug, tags")
    .eq("id", cloneId)
    .maybeSingle();
  if (error)
    return { eligible: false, reason: `Could not read clone ${cloneId}: ${error.message}` };
  if (!clone) return { eligible: false, reason: `Clone ${cloneId} not found` };
  const refusal = accountResetRefusal(clone);
  if (refusal) return { eligible: false, reason: refusal };
  try {
    const { projectRef } = await resolveCloneSecretTarget(supabase, cloneId);
    return { eligible: true, projectRef };
  } catch (e) {
    return {
      eligible: false,
      reason: `This clone's accounts cannot be reset from here: ${msg(e)}`,
    };
  }
}

/**
 * Set a demo clone's staff account to the operator's password, and clear its
 * authenticator when asked. The password is never stored, logged or returned;
 * every error that leaves here is scrubbed of it.
 */
export async function resetCloneDemoAccount(
  supabase: Db,
  cloneId: string,
  req: AccountResetRequest,
): Promise<AccountResetResult> {
  const account = req.account.trim().toLowerCase();
  const badAccount = accountIdentifierRefusal(account);
  if (badAccount) return { ok: false, error: badAccount };
  const badPassword = resetPasswordRefusal(req.password);
  if (badPassword) return { ok: false, error: badPassword };

  const eligibility = await readAccountResetEligibility(supabase, cloneId);
  if (!eligibility.eligible) return { ok: false, error: eligibility.reason };

  const { runSqlOnProject } = await import("./backend-provisioning.server");
  let rows: unknown;
  try {
    rows = await runSqlOnProject(eligibility.projectRef, buildAccountResetSql({ ...req, account }));
  } catch (e) {
    return { ok: false, error: `The reset did not run: ${scrubCredential(msg(e), req.password)}` };
  }

  const outcome = readAccountResetOutcome(rows);
  if (!outcome.done) return { ok: false, error: accountResetMissLine(outcome.why, account) };
  if (!outcome.passwordVerifies) {
    return {
      ok: false,
      error:
        `The password of ${account} was written but does not verify against the stored hash, ` +
        "so signing in with it would fail. Reset it again.",
    };
  }
  if (req.clearAuthenticator && outcome.authenticatorClear !== true) {
    return {
      ok: false,
      error:
        `The password of ${account} is set and verifies, but its authenticator is still ` +
        "enrolled, so signing in still asks for its code.",
    };
  }
  return {
    ok: true,
    account,
    authenticatorClear: outcome.authenticatorClear,
    sessionsEnded: outcome.sessionsEnded,
  };
}
