// Turning a subscription into spendable credits.
//
// Every tier includes a monthly allowance — Launch 7,000, Growth 35,000,
// Scale 75,000 — and until now buying one granted none of them. The seat-plan
// branch of the webhook wrote `clone_seat_entitlements` and stopped; nothing
// ever set `tenants.plan_id`, which is the column the allowance issuer and its
// hourly cron both read. So a workspace could pay for Scale and have a balance
// of zero.
//
// This is the bridge. It resolves which workspace a subscription belongs to,
// moves it onto the matching billing plan, and credits the allowance — all
// inside one SECURITY DEFINER function so the move and the grant cannot come
// apart, and keyed on the Stripe object that caused it so a redelivered
// webhook credits once.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveCloneBillingTenant } from "@/server/billing-tenant.server";

const adminAny = supabaseAdmin;

export type PlanChangeOutcome = {
  ok: boolean;
  /** Credits actually added. Zero when this period was already credited. */
  creditsGranted?: number;
  eventId?: string;
  fromPlan?: string | null;
  toPlan?: string | null;
  /** True when a replayed webhook found the change already applied. */
  idempotent?: boolean;
  /** Why nothing happened, when nothing happened. */
  skipped?: string;
  error?: string;
};

/**
 * Which workspace does this subscription belong to?
 *
 * Deliberately the same resolution a top-up uses, because it has to reach the
 * same answer. A clone meters against one tenant and can easily have others;
 * crediting a different one is invisible at checkout — Stripe takes the money,
 * a ledger row lands, and the balance the dashboard reads never moves. That
 * exact bug has already been fixed once for top-ups, and inventing a second
 * resolution here would reintroduce it for subscriptions.
 */
export async function tenantForSubscription(args: {
  tenantId?: string | null;
  cloneId?: string | null;
  billingUserId?: string | null;
}): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  if (args.tenantId) return { ok: true, tenantId: args.tenantId };
  if (!args.cloneId) return { ok: false, error: "tenant_or_clone_required" };

  const { data: clone } = await adminAny
    .from("clones")
    .select("id, name, slug")
    .eq("id", args.cloneId)
    .maybeSingle();
  if (!clone) return { ok: false, error: "clone_not_found" };

  const resolved = await resolveCloneBillingTenant(clone.id, {
    billingUserId: args.billingUserId ?? null,
    fallbackExternalRef: `clone:${clone.slug ?? clone.id}`,
    fallbackDisplayName: clone.name,
  });
  return resolved.ok
    ? { ok: true, tenantId: resolved.tenantId }
    : { ok: false, error: resolved.error };
}

/**
 * The seat plan's slug, which is also its billing plan's slug.
 *
 * The two tables are bridged by name rather than by a foreign key: they
 * already share launch/growth/scale, and a column pointing one at the other
 * would be a second thing to keep in step for no extra information.
 */
export async function seatPlanSlug(seatPlanId: string): Promise<string | null> {
  const { data } = await adminAny
    .from("seat_plans")
    .select("slug")
    .eq("id", seatPlanId)
    .maybeSingle();
  return (data?.slug as string | undefined) ?? null;
}

/**
 * Applies a plan change and credits its allowance.
 *
 * `sourceRef` is the Stripe object that caused it — a checkout session or a
 * subscription id plus the plan. It is the idempotency key, so a webhook
 * delivered three times moves the workspace once and grants once.
 *
 * Never throws. A subscription that is otherwise recorded correctly must not
 * be failed because the allowance could not be granted; the caller logs the
 * reason and the hourly issuer picks the workspace up once its plan is set.
 */
export async function grantPlanAllowance(args: {
  tenantId?: string | null;
  cloneId?: string | null;
  billingUserId?: string | null;
  seatPlanId: string;
  sourceRef: string;
}): Promise<PlanChangeOutcome> {
  try {
    const slug = await seatPlanSlug(args.seatPlanId);
    if (!slug) return { ok: false, error: "seat_plan_not_found" };

    const tenant = await tenantForSubscription(args);
    if (tenant.ok !== true) return { ok: false, error: tenant.error };

    const { data, error } = await adminAny.rpc("apply_seat_plan_change", {
      _tenant_id: tenant.tenantId,
      _plan_slug: slug,
      _source_ref: args.sourceRef,
    });
    if (error) return { ok: false, error: error.message };

    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok === false) return { ok: false, error: String(r.error ?? "apply_failed") };

    return {
      ok: true,
      creditsGranted: Number(r.credits_granted ?? 0),
      eventId: typeof r.event_id === "string" ? r.event_id : undefined,
      fromPlan: (r.from_plan as string | null) ?? null,
      toPlan: (r.to_plan as string | null) ?? slug,
      idempotent: r.idempotent === true,
      skipped: typeof r.skipped === "string" ? r.skipped : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Moves a workspace's billing period forward and issues the new month's
 * allowance.
 *
 * The hourly issuer credits every period counted on from the anchor, whether
 * or not Stripe renewed (20261030220000, the owner's decision of 30 Oct 2026).
 * A renewal still issues at once, so credits a customer has just paid for are
 * spendable straight away, and issue_plan_allowance makes the two one grant:
 * a plan has one grant per period, whichever arrives first.
 *
 * Refuses to move the period backwards, because Stripe redelivers and events
 * can arrive out of order; rewinding would re-issue a month already credited.
 */
export async function advanceBillingPeriod(args: {
  tenantId: string;
  periodStart: Date;
  periodEnd?: Date | null;
}): Promise<{ ok: boolean; issued?: unknown; error?: string }> {
  try {
    const { data, error } = await adminAny.rpc("advance_tenant_billing_period", {
      _tenant_id: args.tenantId,
      _period_start: args.periodStart.toISOString(),
      _period_end: args.periodEnd ? args.periodEnd.toISOString() : undefined,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, issued: data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The best billing-id hint the session metadata carries.
 *
 * `billing_user_id` is only stamped when checkout already knew the tenant, and
 * for a seat plan it usually did not — checkout auto-resolves a tenant for
 * top-ups and setup packages, not subscriptions. But a purchase that arrived
 * through a `?uid=` link still carries that uid in the attribution block, and
 * an operator-assigned billing id is the strongest signal there is for picking
 * the right workspace out of a clone's tenants. Losing it here would fall back
 * to guessing by ledger activity.
 */
export function billingHintFromMetadata(
  md: Record<string, string | undefined> | null | undefined,
): string | null {
  const m = md ?? {};
  if (m.billing_user_id) return m.billing_user_id;
  if (m.origin_source === "storefront_uid" && m.origin_user_id) return m.origin_user_id;
  return null;
}

/** Stable idempotency key for a plan change caused by a Stripe object. */
export function planChangeRef(
  kind: "session" | "subscription",
  id: string,
  planId: string,
): string {
  return `${kind}:${id}:${planId}`;
}
