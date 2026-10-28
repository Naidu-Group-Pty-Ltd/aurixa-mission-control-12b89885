/**
 * The free trial an agreement provisions its workspace with
 * (`client_agreements.trial_days` / `trial_offer_code`, migration
 * 20261028160000_fourteen_day_free_trial.sql).
 *
 * Read and written apart from the rest of the row, on purpose. Code ships
 * separately from migrations here, and a column named in the agreements
 * list's SELECT before it exists fails the whole list. Kept apart, the only
 * thing that waits on the migration is the trial itself: before it applies an
 * agreement reads as "platform default", which is exactly what every
 * agreement provisioned until now was given.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

export type AgreementTrial = { trialDays: number | null; trialOfferCode: string | null };

/** Postgres's "no such column" and PostgREST's schema-cache miss for one. */
function isColumnPending(error: { code?: string | null } | null): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

export async function readAgreementTrial(
  client: Client,
  agreementId: string,
): Promise<({ ok: true; schemaPending: boolean } & AgreementTrial) | { ok: false; error: string }> {
  const { data, error } = await client
    .from("client_agreements")
    .select("trial_days, trial_offer_code")
    .eq("id", agreementId)
    .maybeSingle();
  if (error) {
    if (isColumnPending(error)) {
      return { ok: true, schemaPending: true, trialDays: null, trialOfferCode: null };
    }
    return { ok: false, error: error.message };
  }
  const row = (data ?? {}) as { trial_days?: number | null; trial_offer_code?: string | null };
  return {
    ok: true,
    schemaPending: false,
    trialDays: typeof row.trial_days === "number" ? row.trial_days : null,
    trialOfferCode: row.trial_offer_code ?? null,
  };
}

/**
 * Write an agreement's trial. A default (null days) written before the
 * migration has applied is a no-op that succeeds — there is nothing to record
 * — while a custom trial is refused as `schema_pending`, because accepting it
 * would provision the default for somebody who was promised more.
 */
export async function writeAgreementTrial(
  client: Client,
  agreementId: string,
  trial: AgreementTrial,
): Promise<{ ok: true } | { ok: false; error: "schema_pending" | string }> {
  const { error } = await client
    .from("client_agreements")
    .update({ trial_days: trial.trialDays, trial_offer_code: trial.trialOfferCode })
    .eq("id", agreementId);
  if (!error) return { ok: true };
  if (isColumnPending(error)) {
    return trial.trialDays === null ? { ok: true } : { ok: false, error: "schema_pending" };
  }
  return { ok: false, error: error.message };
}
