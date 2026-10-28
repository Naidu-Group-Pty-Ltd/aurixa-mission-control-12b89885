/**
 * Trial offers: named free-trial lengths (see `trial_offers` in its migration,
 * and `trialOffers.pure.ts` for the rules).
 *
 * Every write is the service role behind an admin server function; the table
 * grants operators read only. A failed read is carried as a failure, never as
 * "no offers", because a picker that silently lost its offers would provision
 * the default for somebody who was promised thirty days.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { asRow } from "@/lib/json-cast";
import type { TrialOfferSummary } from "@/lib/trialOffers.pure";
import { writeAuditLog } from "./audit.server";

export type TrialOfferRow = TrialOfferSummary & {
  notes: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

const COLUMNS =
  "id, code, label, trial_days, active, expires_at, notes, created_at, created_by, updated_at, updated_by";

/** PostgREST and Postgres both say "this table is not there yet" in their own words. */
function isSchemaPending(error: { code?: string | null } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

export async function listTrialOffers(): Promise<
  { ok: true; offers: TrialOfferRow[] } | { ok: false; error: string; schemaPending?: boolean }
> {
  const { data, error } = await supabaseAdmin
    .from("trial_offers")
    .select(COLUMNS)
    .order("created_at", { ascending: false });
  if (error) {
    return { ok: false, error: error.message, schemaPending: isSchemaPending(error) };
  }
  return { ok: true, offers: (data ?? []) as TrialOfferRow[] };
}

export async function readTrialOfferByCode(
  code: string,
): Promise<{ ok: true; offer: TrialOfferRow | null } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("trial_offers")
    .select(COLUMNS)
    .eq("code", code)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, offer: (data as TrialOfferRow | null) ?? null };
}

export async function createTrialOffer(input: {
  code: string;
  label: string;
  trialDays: number;
  expiresAt: string | null;
  notes: string | null;
  actorId: string;
}): Promise<{ ok: true; offer: TrialOfferRow } | { ok: false; error: string }> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("trial_offers")
    .insert(
      asRow<TablesInsert<"trial_offers">>({
        code: input.code,
        label: input.label,
        trial_days: input.trialDays,
        expires_at: input.expiresAt,
        notes: input.notes,
        active: true,
        created_by: input.actorId,
        updated_by: input.actorId,
        created_at: now,
        updated_at: now,
      }),
    )
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, error: "code_taken" };
    if (isSchemaPending(error)) return { ok: false, error: "schema_pending" };
    return { ok: false, error: error.message };
  }
  const offer = data as TrialOfferRow;
  await writeAuditLog({
    action: "trial_offer.created",
    entityType: "trial_offer",
    entityId: offer.id,
    actorUserId: input.actorId,
    metadata: { code: offer.code, label: offer.label, trial_days: offer.trial_days },
  });
  return { ok: true, offer };
}

export async function updateTrialOffer(input: {
  id: string;
  label?: string;
  trialDays?: number;
  active?: boolean;
  expiresAt?: string | null;
  notes?: string | null;
  actorId: string;
}): Promise<{ ok: true; offer: TrialOfferRow } | { ok: false; error: string }> {
  const patch: Record<string, unknown> = {
    updated_by: input.actorId,
    updated_at: new Date().toISOString(),
  };
  if (input.label !== undefined) patch.label = input.label;
  if (input.trialDays !== undefined) patch.trial_days = input.trialDays;
  if (input.active !== undefined) patch.active = input.active;
  if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt;
  if (input.notes !== undefined) patch.notes = input.notes;

  const { data, error } = await supabaseAdmin
    .from("trial_offers")
    .update(asRow<TablesUpdate<"trial_offers">>(patch))
    .eq("id", input.id)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "not_found" };
  const offer = data as TrialOfferRow;
  await writeAuditLog({
    action: "trial_offer.updated",
    entityType: "trial_offer",
    entityId: offer.id,
    actorUserId: input.actorId,
    metadata: {
      code: offer.code,
      changed: Object.keys(patch).filter((k) => !k.startsWith("updated_")),
    },
  });
  return { ok: true, offer };
}
