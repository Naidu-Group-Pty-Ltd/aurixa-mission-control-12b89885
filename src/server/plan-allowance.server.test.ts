// The two pure decisions in the allowance path, both of which have already
// caused real bugs in their top-up equivalents: which workspace gets credited,
// and what counts as the same change happening twice.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { billingHintFromMetadata, planChangeRef } from "./plan-allowance.server";

describe("billingHintFromMetadata", () => {
  it("prefers the billing id checkout already resolved", () => {
    expect(billingHintFromMetadata({ billing_user_id: "bu_1", origin_user_id: "uid_2" })).toBe(
      "bu_1",
    );
  });

  it("falls back to the uid a storefront link carried", () => {
    // Checkout only auto-resolves a tenant for top-ups and setup packages, so
    // a seat plan usually arrives with billing_user_id empty. Losing the uid
    // here would leave the webhook guessing which of a clone's tenants to
    // credit — the same mistake that once sent top-ups to a second tenant the
    // dashboard never read.
    expect(
      billingHintFromMetadata({
        billing_user_id: "",
        origin_source: "storefront_uid",
        origin_user_id: "uid_2",
      }),
    ).toBe("uid_2");
  });

  it("ignores an origin id that is not an operator-assigned billing id", () => {
    // A handoff's origin_user_id is a person in the clone, not a billing id.
    expect(
      billingHintFromMetadata({ origin_source: "handoff", origin_user_id: "person_9" }),
    ).toBeNull();
  });

  it("is null rather than empty string when nothing is known", () => {
    expect(billingHintFromMetadata({})).toBeNull();
    expect(billingHintFromMetadata(null)).toBeNull();
    expect(billingHintFromMetadata({ billing_user_id: "" })).toBeNull();
  });
});

describe("planChangeRef", () => {
  it("is stable, so a redelivered webhook is the same change", () => {
    expect(planChangeRef("session", "cs_1", "plan_a")).toBe(
      planChangeRef("session", "cs_1", "plan_a"),
    );
  });

  it("separates a plan switch from a routine subscription update", () => {
    // Both arrive as customer.subscription.updated on the same subscription.
    // Only the one that changed plan should credit a new allowance, so the
    // plan is part of the key.
    expect(planChangeRef("subscription", "sub_1", "growth")).not.toBe(
      planChangeRef("subscription", "sub_1", "scale"),
    );
  });

  it("does not confuse a checkout with the subscription it created", () => {
    // Buying a plan fires both checkout.session.completed and
    // customer.subscription.updated. Sharing a key would make the second a
    // no-op replay of the first — which is fine — but sharing it ACROSS
    // different ids would suppress a genuine later change.
    expect(planChangeRef("session", "x", "p")).not.toBe(planChangeRef("subscription", "x", "p"));
  });
});

/**
 * A plan's monthly credits every period, whether or not Stripe recorded a
 * renewal (the owner's decision, 30 Oct 2026). Measured that day: each of the
 * 11 tenants holding a plan grant held one per plan, for its first period,
 * because the hourly issuer keyed the grant on an anchor only a Stripe renewal
 * moves. Each clause below was run on a copy of production with the live
 * functions (scratch Postgres, 30 Oct): the next hourly run grants ten
 * tenants and a second run none; renewal and hourly run land one grant in
 * either order, a day early, after month-end clamping, and at the same moment;
 * past_due, canceled and incomplete entitlements are skipped; a tenant with no
 * entitlement row is granted; a tenant three periods behind gets the current
 * one only; a tenant created on first call keeps the one grant provisioning
 * gave it for its first period (before this, the hourly run added a second:
 * ten tenants hold both), and one that has changed plan since still gets the
 * new plan's.
 */
describe("the plan allowance every period (20261030220000)", () => {
  const sql = readFileSync(
    "supabase/migrations/20261030220000_plan_allowance_every_period.sql",
    "utf8",
  );
  const issue = sql.slice(
    sql.indexOf("create or replace function public.issue_plan_allowance("),
    sql.indexOf("create or replace function public.issue_due_plan_allowances()"),
  );
  const hourly = issue.slice(issue.indexOf("  else\n"), issue.indexOf("  _ref := "));
  const driver = sql.slice(
    sql.indexOf("create or replace function public.issue_due_plan_allowances()"),
    sql.indexOf("revoke all on function"),
  );

  it("credits the current period, counted on from the anchor, and never an earlier one", () => {
    expect(hourly).toContain("_from := public.api_usage_period_start(_anchor, now());");
    // The rule that only periods after the feature shipped are issued reads
    // the computed period's start, and the driver no longer reads the anchor.
    expect(hourly).toContain("if _from < date '2026-07-28' then");
    expect(driver).not.toContain("2026-07-28");
    expect(driver).toContain("_result := public.issue_plan_allowance(_t.id, null);");
    expect(driver.match(/issue_plan_allowance\(/g)).toHaveLength(1);
  });

  it("lets a renewal and the hourly run land one grant in a period, in either order or at once", () => {
    // Any grant of the plan whose period start falls inside the computed
    // period is that period's, whatever its ref.
    expect(issue).toContain("and l.metadata->>'plan_id' = _tenant.plan_id::text");
    expect(issue).toContain(
      "and coalesce((l.metadata->>'period_start')::timestamptz, l.created_at)::date >= _from",
    );
    expect(issue).toContain(
      "and coalesce((l.metadata->>'period_start')::timestamptz, l.created_at)::date < _to)",
    );
    // A renewal and the hourly run are serialised per tenant, the lock taken
    // before the tenant (and so the renewal's new anchor) is read.
    expect(issue.indexOf("perform pg_advisory_xact_lock(")).toBeLessThan(
      issue.indexOf("select * into _tenant from public.tenants"),
    );
    // Month-end clamping: wait for Stripe's recorded period, then label the
    // grant where Stripe's next one starts, so a late renewal finds its ref.
    expect(hourly).toContain("if _recorded > _from and _recorded < _to then");
    expect(hourly).toContain("'recorded_period_running'");
    expect(hourly).toContain("_start := _tenant.current_period_end;");
  });

  it("skips a tenant whose subscription is not live, and grants one with no entitlement row", () => {
    expect(hourly).toContain("where e.clone_id = _tenant.clone_id and e.status <> 'active') then");
    expect(hourly).toContain("'subscription_not_live'");
    // The guard looks for a row that is not live. A tenant with no row at
    // all is not skipped, and the webhook's own paths are not guarded here.
    expect(hourly).not.toMatch(/not exists \(select 1 from public\.clone_seat_entitlements/);
    expect(issue.slice(0, issue.indexOf("  else\n"))).not.toContain("clone_seat_entitlements");
    expect(driver).toContain("where status = 'active'");
  });

  it("counts the first month provisioning grants as that period's, while the plan is unchanged", () => {
    // ensureTenant gives a tenant it creates its plan's allowance at once,
    // through grant_tokens, under this reason and with no plan or period.
    const provisioning = readFileSync("src/server/clone-api-keys.server.ts", "utf8");
    expect(provisioning).toContain('_reason: "auto_provisioned_monthly_allowance",');
    expect(issue).toContain("or (l.reason = 'auto_provisioned_monthly_allowance'");
    expect(issue).toContain(
      "and l.created_at >= coalesce(_tenant.plan_started_at, _tenant.created_at) - interval '10 seconds'",
    );
    expect(issue).toContain("and l.created_at::date >= _from");
    expect(issue).toContain("and l.created_at::date < _to))");
    // And the migration refuses to finish without it.
    expect(sql).toContain("position('auto_provisioned_monthly_allowance' in p.prosrc) = 0");
  });

  it("runs for service_role only", () => {
    expect(sql).toContain(
      "revoke all on function public.issue_plan_allowance(uuid, timestamptz) from public, anon, authenticated;",
    );
    expect(sql).toContain(
      "revoke all on function public.issue_due_plan_allowances() from public, anon, authenticated;",
    );
  });
});
