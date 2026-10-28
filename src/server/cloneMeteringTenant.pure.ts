/**
 * The tenant a new clone meters under, and the plan it holds (D16).
 *
 * A clone gates on its balance response, and the plan that response reports
 * is its metering tenant's: `tenants.plan_id`, read as
 * `tenant.billing_plans.slug`. Until this, nothing at provisioning created
 * that tenant. The first call that needed it did, through `ensureTenant`,
 * on the cheapest active plan, which is `free`. Measured 27 Oct 2026: NPC
 * Test, Preflight and the CRM were each sold `launch` or `scale` and meter
 * on `free`, under a tenant that path created for each of them (8 Sep for
 * two of them, 19 Sep for the CRM, within two hours of the clone).
 *
 * The decisions, with no database in them. `clone-metering-tenant.server.ts`
 * does the reading and writing.
 */

/** The plan the lazy path gives a tenant nobody chose a plan for. */
export const FREE_PLAN_SLUG = "free";

/** A billing plan a clone was sold, as `billing_plans` holds it. */
export type SoldPlan = { id: string; slug: string };

/** What a tenant found for the clone holds now. */
export type HeldPlan = {
  planId: string | null;
  /** The slug of `planId`, or null when the tenant has no plan. */
  planSlug: string | null;
};

export type PlanDecision =
  /** Already right, or nothing was sold to put on it. No write. */
  | { action: "keep" }
  /** Unset or `free`: put the sold plan on it. */
  | { action: "set"; plan: SoldPlan }
  /** A different paid plan. Never overwritten; reported instead. */
  | { action: "conflict"; soldPlanSlug: string; heldPlanSlug: string };

/**
 * Whether a tenant the clone already has takes the plan it was sold.
 *
 * Only an empty plan or `free` is replaced: those are the lazy path's
 * defaults, not anybody's decision. A different paid plan was somebody's
 * decision, a Stripe subscription's or an operator's, and provisioning does
 * not get to undo it.
 */
export function decideTenantPlan(held: HeldPlan, sold: SoldPlan | null): PlanDecision {
  if (!sold) return { action: "keep" };
  if (held.planId === sold.id) return { action: "keep" };
  if (held.planId === null || held.planSlug === FREE_PLAN_SLUG) {
    return { action: "set", plan: sold };
  }
  return {
    action: "conflict",
    soldPlanSlug: sold.slug,
    heldPlanSlug: held.planSlug ?? held.planId,
  };
}

/**
 * The plan columns a tenant takes when it is put on the plan it was sold.
 *
 * No billing period starts here, and so no allowance is issued. A tier's
 * credits are a subscription's: `apply_seat_plan_change` starts the period
 * when the activation payment lands and issues the allowance once, under the
 * same `plan:<id>:<period start>` ref the hourly issuer uses. A period
 * started at provisioning would be credited by that issuer within the hour,
 * and the payment, starting another period on a later day, would credit the
 * month again. The issuer passes over a tenant whose period has not started.
 */
export function planColumns(
  plan: SoldPlan | null,
  now: string,
): {
  plan_id: string | null;
  plan_started_at: string | null;
  current_period_start: null;
  current_period_end: null;
} {
  return {
    plan_id: plan?.id ?? null,
    plan_started_at: plan ? now : null,
    current_period_start: null,
    current_period_end: null,
  };
}

/**
 * The row a new clone's metering tenant is created with.
 *
 * Keyed by the clone's own id, the shape every engine clone's tenant already
 * has, because the ref a clone meters under (`prime:<project ref>`) does not
 * exist yet: its project is created later by the backend drain. The billing
 * id is what joins the two. `ensureTenant` adopts the tenant holding a
 * clone's billing id whatever ref the clone's first call names, so the
 * balance answers with this row and its plan.
 */
export function meteringTenantRow(input: {
  cloneId: string;
  cloneName: string | null;
  billingUserId: string;
  billingStripeCustomerId: string | null;
  plan: SoldPlan | null;
  now: string;
}) {
  return {
    clone_id: input.cloneId,
    external_ref: input.cloneId,
    display_name: input.cloneName,
    billing_user_id: input.billingUserId,
    billing_stripe_customer_id: input.billingStripeCustomerId,
    status: "active" as const,
    ...planColumns(input.plan, input.now),
  };
}
