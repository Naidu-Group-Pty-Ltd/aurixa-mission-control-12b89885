/**
 * A new clone's metering tenant, created or adopted on the plan it was sold
 * (D16).
 *
 * The plan a clone gates on is the one its balance response reports,
 * `tenant.billing_plans.slug`, and that is the metering tenant's
 * `tenants.plan_id`. Nothing at provisioning used to create that tenant. The
 * first call that needed it did, through `ensureTenant`, on the cheapest
 * active plan, which is `free` (price 0, 100 credits a month). Measured
 * 27 Oct 2026: NPC Test was sold `launch`, Preflight and the CRM `scale`, and
 * all three meter on `free`. The owner decided on 27 Oct that those three stay
 * on `free` until launch, so this runs for a clone being provisioned and for
 * nothing else.
 *
 * The rules, decided in `cloneMeteringTenant.pure.ts`:
 *
 *  - the tenant is keyed by the clone's id and carries its billing id, which is
 *    how the clone's first call (`prime:<project ref>`) finds it. A clone with
 *    none is given one first, by the deployment worker's rule;
 *  - a tenant the clone already has is adopted. Its plan is set only when it
 *    has none or holds `free`. A different paid plan is never overwritten, and
 *    the outcome says so;
 *  - a sold slug `billing_plans` does not hold is refused by name. A clone is
 *    never put on `free` in its place;
 *  - a read or a write that fails is an error, never "no tenant" or "no plan".
 *
 * Reads and writes go through the service-role client, as `ensureTenant`'s do:
 * a tenant is a billing record, and a read the caller's role cannot see would
 * answer "nobody holds it". The `db` parameter is the test double's.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { ensureCloneBillingIdForDeployment } from "./clone-billing-identity.server";
import {
  FREE_PLAN_SLUG,
  decideTenantPlan,
  meteringTenantRow,
  planColumns,
  type SoldPlan,
} from "./cloneMeteringTenant.pure";

type Db = SupabaseClient<Database>;

/** What a tenant is read with: enough to adopt it, and its plan's slug. */
const TENANT_COLUMNS = "id, clone_id, plan_id, billing_plans:plan_id(slug)";

type TenantRead = {
  id: string;
  clone_id: string | null;
  plan_id: string | null;
  billing_plans: { slug: string } | null;
};

export type SoldPlanResolution = { ok: true; plan: SoldPlan | null } | { ok: false; error: string };

/**
 * The billing plan a clone is being sold, by slug.
 *
 * No slug is no plan: the wizard can provision a clone without a tier, and
 * its tenant then holds none. A slug is checked against `billing_plans` before
 * anything is created, and refused when it names nothing or a retired plan.
 */
export async function resolveSoldPlan(
  planSlug: string | null | undefined,
  db: Db = supabaseAdmin as Db,
): Promise<SoldPlanResolution> {
  const slug = typeof planSlug === "string" ? planSlug.trim() : "";
  if (!slug) return { ok: true, plan: null };

  const { data, error } = await db
    .from("billing_plans")
    .select("id, slug, is_active")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    return { ok: false, error: `The billing plan "${slug}" could not be read: ${error.message}` };
  }
  if (!data) {
    return {
      ok: false,
      error:
        `No billing plan is named "${slug}". A clone sold "${slug}" is never put on ` +
        `"${FREE_PLAN_SLUG}" in its place: add the plan to billing_plans, or provision on one ` +
        `that exists.`,
    };
  }
  if (!data.is_active) {
    return {
      ok: false,
      error: `The billing plan "${slug}" is not active, so a clone cannot be sold it.`,
    };
  }
  return { ok: true, plan: { id: data.id, slug: data.slug } };
}

export type MeteringTenantOutcome =
  | {
      ok: true;
      tenantId: string;
      /**
       * `created`: a new tenant, on the sold plan. `set`: an adopted tenant
       * that had no plan, or `free`, now holds the sold one. `kept`: an
       * adopted tenant already right, or nothing was sold to put on it.
       */
      action: "created" | "set" | "kept";
      /** The plan the tenant holds now. */
      planSlug: string | null;
    }
  | {
      ok: true;
      tenantId: string;
      /** An adopted tenant holds a different paid plan. Not overwritten. */
      action: "conflict";
      /** The plan the clone was sold. */
      planSlug: string;
      /** The plan the tenant holds, and keeps. */
      heldPlanSlug: string;
    }
  | { ok: false; error: string };

/**
 * Create or adopt the tenant a new clone meters under, on `plan`.
 *
 * `plan` is `resolveSoldPlan`'s answer: null when nothing was sold.
 */
export async function ensureCloneMeteringTenant(
  input: {
    cloneId: string;
    cloneName: string | null;
    /** What a missing billing id is derived from. */
    cloneSlug: string;
    billingUserId: string | null;
    billingStripeCustomerId: string | null;
    plan: SoldPlan | null;
  },
  db: Db = supabaseAdmin as Db,
): Promise<MeteringTenantOutcome> {
  const { cloneId, plan } = input;
  const identity = await billingIdentityOf(input);
  if (!identity.ok) return identity;
  const { billingUserId } = identity;

  const found = await findCloneTenant(db, cloneId, billingUserId);
  if (!found.ok) return found;
  if (found.tenant) return adopt(db, found.tenant, plan);

  const { data, error } = await db
    .from("tenants")
    .insert(
      meteringTenantRow({
        cloneId,
        cloneName: input.cloneName,
        billingUserId,
        billingStripeCustomerId: input.billingStripeCustomerId,
        plan,
        now: new Date().toISOString(),
      }),
    )
    .select("id")
    .single();
  if (!error && data) {
    return { ok: true, tenantId: data.id, action: "created", planSlug: plan?.slug ?? null };
  }

  // A concurrent request created it between the read and the insert: adopt
  // that one rather than report the race as a fault.
  if (error?.code === "23505") {
    const raced = await findCloneTenant(db, cloneId, billingUserId);
    if (!raced.ok) return raced;
    if (raced.tenant) return adopt(db, raced.tenant, plan);
  }
  return {
    ok: false,
    error: `The tenant could not be created: ${error?.message ?? "the insert returned no row"}`,
  };
}

/**
 * The billing id the tenant is created with, and a missing one healed first.
 *
 * The tenant is found by it: the clone's first call adopts the tenant holding
 * its billing id, and a tenant without one is invisible to that call, which
 * would create a second on `free` beside it. Provisioning's own resolution
 * never throws, so a control plane it could not read inserts the clone with
 * none; the deployment worker heals that, but only once the clone builds,
 * after the backend that waits for this tenant. So the heal runs here too,
 * through the worker's own function: only a missing id is derived (from the
 * slug), the write is conditional on the column still being NULL, and an id
 * the rule refuses is reported rather than replaced.
 *
 * That function reads through its own default, the service role, never this
 * module's `db`: its lookup is a safety check (`check-hosting-env-policy.mjs`).
 */
async function billingIdentityOf(input: {
  cloneId: string;
  cloneSlug: string;
  billingUserId: string | null;
}): Promise<{ ok: true; billingUserId: string } | { ok: false; error: string }> {
  if (input.billingUserId) return { ok: true, billingUserId: input.billingUserId };
  const healed = await ensureCloneBillingIdForDeployment({
    cloneId: input.cloneId,
    slug: input.cloneSlug,
    current: input.billingUserId,
  });
  if (healed.billingId) return { ok: true, billingUserId: healed.billingId };
  return {
    ok: false,
    error:
      `Clone ${input.cloneId} has no billing identity, and the tenant it meters under is ` +
      `found by it. ${healed.note ?? "None could be given to it."} Give the clone a billing ` +
      `identity on its page, then provision again.`,
  };
}

/**
 * The tenant this clone already has, if any: the one keyed by its id, else the
 * one holding its billing id. A holder that belongs to another clone is
 * refused, because adopting it would meter this clone against somebody else's
 * balance.
 */
async function findCloneTenant(
  db: Db,
  cloneId: string,
  billingUserId: string,
): Promise<{ ok: true; tenant: TenantRead | null } | { ok: false; error: string }> {
  const byRef = await db
    .from("tenants")
    .select(TENANT_COLUMNS)
    .eq("clone_id", cloneId)
    .eq("external_ref", cloneId)
    .maybeSingle();
  if (byRef.error) {
    return { ok: false, error: `The clone's tenant could not be read: ${byRef.error.message}` };
  }
  if (byRef.data) return { ok: true, tenant: byRef.data as TenantRead };

  const byBillingId = await db
    .from("tenants")
    .select(TENANT_COLUMNS)
    .eq("billing_user_id", billingUserId)
    .maybeSingle();
  if (byBillingId.error) {
    return {
      ok: false,
      error: `The tenant holding billing id "${billingUserId}" could not be read: ${byBillingId.error.message}`,
    };
  }
  const holder = byBillingId.data as TenantRead | null;
  if (!holder) return { ok: true, tenant: null };
  if (holder.clone_id !== cloneId) {
    return {
      ok: false,
      error:
        `Billing id "${billingUserId}" belongs to tenant ${holder.id} of ` +
        `${holder.clone_id ? `clone ${holder.clone_id}` : "no clone"}. Give this clone a ` +
        `distinct billing identity, then provision again.`,
    };
  }
  return { ok: true, tenant: holder };
}

/** Put the sold plan on a tenant the clone already has, where the rules allow it. */
async function adopt(
  db: Db,
  tenant: TenantRead,
  plan: SoldPlan | null,
): Promise<MeteringTenantOutcome> {
  const heldSlug = tenant.billing_plans?.slug ?? null;
  // A plan id the join cannot name is a plan nobody can judge. Replacing it
  // could overwrite a paid plan; keeping it quietly could keep `free`.
  if (tenant.plan_id && !heldSlug) {
    return {
      ok: false,
      error: `Tenant ${tenant.id} holds plan ${tenant.plan_id}, which billing_plans does not name.`,
    };
  }

  const decision = decideTenantPlan({ planId: tenant.plan_id, planSlug: heldSlug }, plan);
  if (decision.action === "keep") {
    return { ok: true, tenantId: tenant.id, action: "kept", planSlug: heldSlug };
  }
  if (decision.action === "conflict") {
    return {
      ok: true,
      tenantId: tenant.id,
      action: "conflict",
      planSlug: decision.soldPlanSlug,
      heldPlanSlug: decision.heldPlanSlug,
    };
  }

  // Compare-and-set on the plan it was read with, so a plan somebody set in
  // the meantime (a Stripe webhook, an operator) is not overwritten. `is` for
  // a tenant read with no plan, because `eq` can never match a NULL.
  const { data, error } = await db
    .from("tenants")
    .update(planColumns(decision.plan, new Date().toISOString()))
    .eq("id", tenant.id)
    .filter("plan_id", tenant.plan_id ? "eq" : "is", tenant.plan_id)
    .select("id");
  if (error) {
    return {
      ok: false,
      error: `Tenant ${tenant.id} could not be put on "${decision.plan.slug}": ${error.message}`,
    };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        `Tenant ${tenant.id}'s plan changed while it was being read. Provision again to ` +
        `decide on the plan it holds now.`,
    };
  }
  return { ok: true, tenantId: tenant.id, action: "set", planSlug: decision.plan.slug };
}
