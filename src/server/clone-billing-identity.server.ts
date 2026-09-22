/**
 * Reading the control plane for a billing identity, and writing one.
 *
 * The rule lives in `cloneBillingIdentity.pure.ts`; this is the half that
 * knows which tables hold what. Two exact lookups, both partial-unique-indexed,
 * so each answers at most one row — and the pure module matches on the id each
 * row states rather than trusting this file to have filtered correctly.
 *
 * ## Nothing here reads through the caller's client
 *
 * The lookup is a SAFETY check — its whole job is to find the row that would
 * be shadowed — and RLS FILTERS rather than erroring, so a read the caller
 * cannot see returns `{ data: null, error: null }`: "nobody holds it", which
 * is precisely the answer that lets a shadowing id be written. Both `clones`
 * and `tenants` do grant operators SELECT today, so the caller's client would
 * work; that is a fact about this week's policies and not a property of the
 * check. Every function below therefore defaults to `supabaseAdmin`, and the
 * `db` parameter exists for the test double — no production call site passes
 * one, asserted by `check-hosting-env-policy.mjs`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  assessCloneBillingId,
  deriveCloneBillingId,
  type BillingIdHolder,
  type CloneBillingIdVerdict,
} from "@/server/cloneBillingIdentity.pure";

type Db = SupabaseClient<Database>;

/**
 * Every row in the control plane carrying this id.
 *
 * A read that FAILED is not an id nobody holds. The lookups throw rather than
 * returning an empty set, because "nothing holds it" is precisely the answer
 * that lets a shadowing id be written.
 */
export async function billingIdHolders(
  billingId: string,
  db: Db = supabaseAdmin as Db,
): Promise<BillingIdHolder[]> {
  const dbAny = db as Db;
  const [cloneRes, tenantRes] = await Promise.all([
    dbAny
      .from("clones")
      .select("id, name, slug, billing_user_id")
      .eq("billing_user_id", billingId)
      .maybeSingle(),
    dbAny
      .from("tenants")
      .select("id, display_name, external_ref, clone_id, billing_user_id")
      .eq("billing_user_id", billingId)
      .maybeSingle(),
  ]);

  if (cloneRes.error) throw new Error(`clones lookup failed: ${cloneRes.error.message}`);
  if (tenantRes.error) throw new Error(`tenants lookup failed: ${tenantRes.error.message}`);

  const holders: BillingIdHolder[] = [];
  if (cloneRes.data) {
    holders.push({
      kind: "clone",
      billingId: cloneRes.data.billing_user_id,
      cloneId: cloneRes.data.id,
      label: cloneRes.data.name ?? cloneRes.data.slug ?? null,
    });
  }
  if (tenantRes.data) {
    holders.push({
      kind: "tenant",
      billingId: tenantRes.data.billing_user_id,
      tenantId: tenantRes.data.id,
      cloneId: tenantRes.data.clone_id ?? null,
      label: tenantRes.data.display_name ?? tenantRes.data.external_ref ?? null,
    });
  }
  return holders;
}

/** Judge one candidate id against what the control plane currently holds. */
export async function checkCloneBillingId(
  value: string | null | undefined,
  forCloneId: string | null,
  db: Db = supabaseAdmin as Db,
): Promise<CloneBillingIdVerdict> {
  const shape = assessCloneBillingId(value, { forCloneId });
  // Shape and the reserved id are settled without a round trip; only a
  // well-formed candidate is worth asking the database about.
  if (!shape.ok) return shape;
  const holders = await billingIdHolders(shape.billingId, db);
  return assessCloneBillingId(shape.billingId, { forCloneId, holders });
}

export type ResolvedCloneBillingId = {
  /** The id to store, or null when none could be. */
  billingId: string | null;
  source: "operator" | "derived" | "none";
  /** Present whenever `billingId` is null, or when an operator's choice was
   *  refused and the derivation stood in for it. */
  note: string | null;
};

/**
 * The identity a clone should be created with.
 *
 * An operator's choice is preferred and REFUSED rather than repaired — a
 * mistyped id that silently becomes a different one is how a workspace ends
 * up billing somewhere nobody chose. When it is refused, the slug's derivation
 * stands in, because a clone with no identity is a clone whose customers
 * cannot buy anything: `/api/public/tokens/packs` answers a credential-less
 * link and the clone's own bundle falls through to the prime's built-in uid.
 *
 * Never throws. Provisioning a clone must not fail because the control plane
 * could not be read for a tracking id; the note says what happened and the
 * clone can be given one afterwards.
 */
export async function resolveCloneBillingIdForProvisioning(
  input: { requested?: string | null; slug: string; cloneId?: string | null },
  db: Db = supabaseAdmin as Db,
): Promise<ResolvedCloneBillingId> {
  const forCloneId = input.cloneId ?? null;
  const notes: string[] = [];

  const requested = typeof input.requested === "string" ? input.requested.trim() : "";
  if (requested) {
    try {
      const verdict = await checkCloneBillingId(requested, forCloneId, db);
      if (verdict.ok) return { billingId: verdict.billingId, source: "operator", note: null };
      notes.push(`The billing identity given was not used — ${verdict.message}`);
    } catch (err) {
      notes.push(
        `The billing identity given could not be checked: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // An unreadable control plane is not a free pass to write the operator's
      // value unchecked: the one refusal that matters (shadowing a tenant) is
      // exactly what the read would have found.
      return { billingId: null, source: "none", note: notes.join(" ") };
    }
  }

  const derived = deriveCloneBillingId(input.slug);
  if (!derived) {
    notes.push(`No billing identity could be derived from the slug "${input.slug}".`);
    return { billingId: null, source: "none", note: notes.join(" ") };
  }

  try {
    const verdict = await checkCloneBillingId(derived, forCloneId, db);
    if (verdict.ok) {
      return {
        billingId: verdict.billingId,
        source: "derived",
        note: notes.length ? notes.join(" ") : null,
      };
    }
    notes.push(`The identity derived from the slug was not used — ${verdict.message}`);
  } catch (err) {
    notes.push(
      `The derived billing identity could not be checked: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { billingId: null, source: "none", note: notes.join(" ") };
}

/**
 * Give an existing clone a billing identity, or change the one it has.
 *
 * The "assign later" the provisioning wizard's help text has always promised
 * and no surface ever provided.
 *
 * ## Why this also asks for a rebuild
 *
 * The id lives in two places and they are delivered differently. Server-side
 * resolution reads the column, so a write here takes effect on the next
 * request. The clone's OWN bundle reads `VITE_AURIXA_BILLING_UID`, which Vite
 * inlines at BUILD time — so until the clone rebuilds, its offline fallback
 * still carries whatever it was built with, which for a clone that has never
 * had one is the prime's built-in `npc-prime`.
 *
 * `requestEnvResync` rather than a plain redeploy, for the reason its own
 * header records: `deploying` SKIPS `syncing_env`, so a rebuild requested any
 * other way emits a byte-identical bundle. Best-effort: the column write is
 * the act and it is what every server-side path reads; a rebuild that could
 * not be queued leaves the pre-existing staleness rather than adding to it,
 * and is reported rather than swallowed.
 */
export async function setCloneBillingId(
  cloneId: string,
  value: string | null | undefined,
  db: Db = supabaseAdmin as Db,
): Promise<
  { ok: true; billingId: string; rebuild: string } | { ok: false; error: string; reason?: string }
> {
  let verdict: CloneBillingIdVerdict;
  try {
    verdict = await checkCloneBillingId(value, cloneId, db);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!verdict.ok) return { ok: false, error: verdict.message, reason: verdict.reason };

  const { error } = await (db as Db)
    .from("clones")
    .update({ billing_user_id: verdict.billingId })
    .eq("id", cloneId);
  if (error) return { ok: false, error: error.message };

  let rebuild = "not requested";
  try {
    const { requestEnvResync } = await import("./hosting/redeploy.server");
    const asked = await requestEnvResync({
      cloneId,
      reason: `billing identity set to ${verdict.billingId}`,
    });
    rebuild = asked.queued
      ? "environment re-sync queued — takes effect on the clone's next deployment"
      : `environment re-sync not queued (${asked.reason}); this clone's bundle keeps the identity it was built with`;
  } catch (err) {
    rebuild = `environment re-sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return { ok: true, billingId: verdict.billingId, rebuild };
}
