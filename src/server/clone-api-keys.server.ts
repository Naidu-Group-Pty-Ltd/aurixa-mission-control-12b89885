import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRow } from "@/lib/json-cast";
import type { TablesUpdate } from "@/integrations/supabase/types";

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  // Format: mck_<24 base32-ish chars>. Prefix = first 12 chars (incl mck_).
  const bytes = crypto.randomBytes(24).toString("base64url");
  const raw = `mck_${bytes}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

export type ResolvedKey = {
  id: string;
  clone_id: string | null;
  scopes: string[];
  label: string | null;
  key_prefix: string | null;
  first_used_at: string | null;
};

/**
 * Look up an API key by its plaintext form, validating that it exists,
 * is not revoked, and has the required scope. Updates last_used_at on hit.
 */
// Re-export the shared scope catalog so server code has a single import path.
export { CLONE_API_SCOPES, DEFAULT_SCOPES, SCOPE_VALUES } from "@/lib/clone-api-scopes";
export type { CloneApiScope } from "@/lib/clone-api-scopes";

export async function resolveCloneApiKey(
  rawKey: string | null,
  requiredScope: string | string[],
): Promise<ResolvedKey | null> {
  if (!rawKey || typeof rawKey !== "string" || !rawKey.startsWith("mck_")) {
    return null;
  }
  const hash = hashApiKey(rawKey);
  const { data, error } = await supabaseAdmin
    .from("clone_api_keys")
    .select("id, clone_id, scopes, revoked_at, label, key_prefix, first_used_at")
    .eq("key_hash", hash)
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at) return null;
  const scopes = (data.scopes as string[]) ?? [];
  const required = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
  // Any-of: at least one required scope must be present.
  if (!required.some((s) => scopes.includes(s))) return null;
  // best-effort last_used_at update
  await supabaseAdmin
    .from("clone_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  return {
    id: data.id,
    clone_id: data.clone_id,
    scopes,
    label: data.label ?? null,
    key_prefix: data.key_prefix ?? null,
    first_used_at: data.first_used_at ?? null,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The tenant already holding this clone's billing id, when it is THIS clone's.
 * `null` means "nobody holds it — provision". A holder belonging to another
 * clone is refused rather than adopted or duplicated: crediting it would move
 * one workspace's purchases into another's balance.
 */
async function adoptCloneBillingHolder(
  cloneId: string | null,
  billingUserId: string | null,
): Promise<
  { ok: true; tenantId: string; billingUserId: string } | { ok: false; error: string } | null
> {
  if (!cloneId || !billingUserId) return null;
  const holder = await supabaseAdmin
    .from("tenants")
    .select("id, clone_id")
    .eq("billing_user_id", billingUserId)
    .maybeSingle();
  // A lookup that FAILED is not "nobody holds it": provisioning on the strength
  // of it is exactly the duplicate this guards against.
  if (holder.error) return { ok: false, error: holder.error.message };
  if (!holder.data) return null;
  if (holder.data.clone_id === cloneId) {
    return { ok: true, tenantId: holder.data.id, billingUserId };
  }
  return {
    ok: false,
    error:
      `billing id "${billingUserId}" belongs to a tenant of another clone ` +
      `(${holder.data.clone_id ?? "none"}); set a distinct billing id on this clone.`,
  };
}

/**
 * Ensure a tenant row exists for (clone_id, external_ref). Assigns the
 * default active billing plan if none is set, and returns the tenant id.
 */
export async function ensureTenant(
  cloneId: string | null,
  externalRef: string,
  displayName?: string | null,
): Promise<
  { ok: true; tenantId: string; billingUserId: string | null } | { ok: false; error: string }
> {
  // Cast: the billing_* tracking columns are newer than the generated DB types.
  const dbAny = supabaseAdmin;

  // Operator-assigned billing/tracking identity lives on the clone; copy it
  // onto the clone's tenant so checkout can stamp it into Stripe metadata and
  // the purchases ledger (and so ?uid= resolves once a tenant exists).
  let cloneBillingUserId: string | null = null;
  let cloneBillingStripeCustomerId: string | null = null;
  if (cloneId) {
    const { data: clone } = await dbAny
      .from("clones")
      .select("billing_user_id, billing_stripe_customer_id")
      .eq("id", cloneId)
      .maybeSingle();
    cloneBillingUserId = clone?.billing_user_id ?? null;
    cloneBillingStripeCustomerId = clone?.billing_stripe_customer_id ?? null;
  }

  let q = dbAny
    .from("tenants")
    .select("id, plan_id, billing_user_id")
    .eq("external_ref", externalRef);
  q = cloneId == null ? q.is("clone_id", null) : q.eq("clone_id", cloneId);
  const existing = await q.maybeSingle();
  if (existing.error) return { ok: false, error: existing.error.message };

  if (existing.data) {
    const patch: Record<string, unknown> = {};
    if (displayName && displayName.length > 0) patch.display_name = displayName;
    // Backfill the tracking id if the clone has one and the tenant does not.
    const backfillingBillingId = Boolean(cloneBillingUserId && !existing.data.billing_user_id);
    if (backfillingBillingId) {
      patch.billing_user_id = cloneBillingUserId;
      if (cloneBillingStripeCustomerId) {
        patch.billing_stripe_customer_id = cloneBillingStripeCustomerId;
      }
    }
    if (Object.keys(patch).length > 0) {
      const { error: patchErr } = await dbAny
        .from("tenants")
        .update(asRow<TablesUpdate<"tenants">>(patch))
        .eq("id", existing.data.id);
      /*
        The error used to be discarded, and this write has a failure that is
        both EXPECTED and worth telling apart from a fault.

        `tenants_billing_user_id_uidx` is unique across the whole table, while
        a clone can legitimately have several tenants — `npc-client-dashboard`
        has two, one carrying 47 ledger rows. So the first call here claims the
        id and the second gets 23505. That is the healthy state reached from
        both directions, not a problem: the id is a RANKING HINT
        (`rankTenantCandidates`, +8) and the decisive signals are ledger
        activity and the `prime:` external_ref, which already pick the same row.

        Anything else is a real database fault on a write that decides which
        workspace a purchase credits, and it must not read as success.
      */
      if (patchErr) {
        if (patchErr.code === "23505") {
          console.info(
            `[ensureTenant] billing id "${cloneBillingUserId}" already belongs to another ` +
              `tenant of this clone; tenant ${existing.data.id} keeps none. This is the ` +
              `expected outcome for a clone with more than one tenant.`,
          );
        } else {
          console.error(
            `[ensureTenant] could not update tenant ${existing.data.id}: ${patchErr.message}`,
          );
        }
      }
    }
    return {
      ok: true,
      tenantId: existing.data.id,
      // Unchanged by the outcome above, deliberately. The caller turns this
      // into a `?uid=` purchase link, and `startUidCheckout` resolves a uid
      // against `clones` BEFORE `tenants` — so the clone's own id routes
      // through `resolveCloneBillingTenant`, which picks this clone's metering
      // tenant by ledger activity whatever any single tenant row carries. A
      // stamp this row could not take does not make the clone's id less true.
      billingUserId: existing.data.billing_user_id ?? cloneBillingUserId ?? null,
    };
  }

  /*
    A clone that already has a tenant holding its billing id meters through
    THAT tenant, whatever external_ref the caller names.

    A clone's token client asks for `prime:<its project ref>`, and provisioning
    creates the clone's tenant under the clone's id and stamps the clone's
    billing id on it. `tenants_billing_user_id_uidx` is unique across the whole
    table, so inserting a second tenant carrying the same id is 23505 every
    time. Measured 3 Oct 2026: NPC Test, Preflight Property Group and NPC CRM
    Independent had no `prime:` tenant at all, and every reserve and balance
    call they made answered 500. Only NPC Client Dashboard metered, because its
    `prime:` tenant predates its billing id.

    Adopting is also what keeps the money in one place. A clone with one tenant
    has every purchase credited to it (`resolveCloneBillingTenant`), so a
    second, empty `prime:` tenant would have split spending from top-ups — the
    defect `billing-tenant.server.ts` exists to heal.
  */
  const adopted = await adoptCloneBillingHolder(cloneId, cloneBillingUserId);
  if (adopted) return adopted;

  // Auto-provision tenant on cheapest active plan
  const plan = await supabaseAdmin
    .from("billing_plans")
    .select("id, monthly_allowance")
    .eq("is_active", true)
    .order("price_cents", { ascending: true })
    .limit(1)
    .maybeSingle();

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const insert = await dbAny
    .from("tenants")
    .insert({
      clone_id: cloneId,
      external_ref: externalRef,
      display_name: displayName ?? null,
      billing_user_id: cloneBillingUserId,
      billing_stripe_customer_id: cloneBillingStripeCustomerId,
      plan_id: plan.data?.id ?? null,
      plan_started_at: plan.data ? now.toISOString() : null,
      current_period_start: plan.data ? now.toISOString() : null,
      current_period_end: plan.data ? periodEnd.toISOString() : null,
      status: "active",
    })
    .select("id")
    .single();
  if (insert.error) {
    // Another request created the holder between the lookup above and this
    // insert. Adopt it rather than report the race as a fault.
    if (insert.error.code === "23505") {
      const raced = await adoptCloneBillingHolder(cloneId, cloneBillingUserId);
      if (raced) return raced;
    }
    return { ok: false, error: insert.error.message };
  }

  // Seed monthly allowance via grant if plan has one
  const allowance = plan.data?.monthly_allowance ?? 0;
  if (allowance > 0) {
    await supabaseAdmin.rpc("grant_tokens", {
      _tenant_id: insert.data.id,
      _tokens: allowance,
      _reason: "auto_provisioned_monthly_allowance",
      _expires_at: periodEnd.toISOString(),
    });
  }

  return { ok: true, tenantId: insert.data.id, billingUserId: cloneBillingUserId };
}
