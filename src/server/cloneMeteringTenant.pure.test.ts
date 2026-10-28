import { describe, expect, it } from "vitest";
import {
  FREE_PLAN_SLUG,
  decideTenantPlan,
  meteringTenantRow,
  planColumns,
} from "./cloneMeteringTenant.pure";

const LAUNCH = { id: "plan-launch", slug: "launch" };

describe("decideTenantPlan", () => {
  it("puts the sold plan on a tenant with none", () => {
    expect(decideTenantPlan({ planId: null, planSlug: null }, LAUNCH)).toEqual({
      action: "set",
      plan: LAUNCH,
    });
  });

  it("puts it on a tenant holding free, the lazy path's default", () => {
    expect(decideTenantPlan({ planId: "plan-free", planSlug: FREE_PLAN_SLUG }, LAUNCH)).toEqual({
      action: "set",
      plan: LAUNCH,
    });
  });

  it("leaves a tenant already on the sold plan", () => {
    expect(decideTenantPlan({ planId: "plan-launch", planSlug: "launch" }, LAUNCH)).toEqual({
      action: "keep",
    });
  });

  it("never replaces a different paid plan, and names both", () => {
    for (const held of ["growth", "scale", "starter", "pro"]) {
      expect(decideTenantPlan({ planId: `plan-${held}`, planSlug: held }, LAUNCH)).toEqual({
        action: "conflict",
        soldPlanSlug: "launch",
        heldPlanSlug: held,
      });
    }
  });

  it("changes nothing when nothing was sold", () => {
    expect(decideTenantPlan({ planId: "plan-free", planSlug: "free" }, null)).toEqual({
      action: "keep",
    });
    expect(decideTenantPlan({ planId: null, planSlug: null }, null)).toEqual({ action: "keep" });
  });
});

describe("planColumns", () => {
  it("starts the plan and no billing period", () => {
    expect(planColumns(LAUNCH, "2026-10-28T00:00:00.000Z")).toEqual({
      plan_id: "plan-launch",
      plan_started_at: "2026-10-28T00:00:00.000Z",
      current_period_start: null,
      current_period_end: null,
    });
  });

  it("holds no plan when none was sold", () => {
    expect(planColumns(null, "2026-10-28T00:00:00.000Z")).toEqual({
      plan_id: null,
      plan_started_at: null,
      current_period_start: null,
      current_period_end: null,
    });
  });
});

describe("meteringTenantRow", () => {
  it("is keyed by the clone's id and carries its billing id", () => {
    expect(
      meteringTenantRow({
        cloneId: "clone-1",
        cloneName: "Acme Advisory",
        billingUserId: "acme-advisory",
        billingStripeCustomerId: "cus_123",
        plan: LAUNCH,
        now: "2026-10-28T00:00:00.000Z",
      }),
    ).toEqual({
      clone_id: "clone-1",
      external_ref: "clone-1",
      display_name: "Acme Advisory",
      billing_user_id: "acme-advisory",
      billing_stripe_customer_id: "cus_123",
      status: "active",
      plan_id: "plan-launch",
      plan_started_at: "2026-10-28T00:00:00.000Z",
      current_period_start: null,
      current_period_end: null,
    });
  });
});
