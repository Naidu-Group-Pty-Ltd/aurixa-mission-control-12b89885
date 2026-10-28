/**
 * A new clone's metering tenant is created, or adopted, on the plan it was sold
 * (D16).
 *
 * Measured 27 Oct 2026: nothing at provisioning created the tenant a clone
 * meters under. The first call that needed it did, through `ensureTenant`, on the
 * cheapest active plan, which is `free`, so NPC Test (sold `launch`) and
 * Preflight and the CRM (sold `scale`) all gate on `free`. These run against a
 * double that answers as PostgREST does (`testing/tenantFakes.ts`), and each
 * one that matters ends by asking the clone's first call, the real
 * `ensureTenant`, which plan it gets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATEMENT_TIMEOUT,
  createTenantFakeDb,
  type Row,
  type TenantFakeDb,
} from "./testing/tenantFakes";

const h = vi.hoisted(() => ({ db: null as unknown as TenantFakeDb }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => h.db.from(table),
    rpc: (name: string, args: Record<string, unknown>) => h.db.rpc(name, args),
  },
}));

import { ensureCloneMeteringTenant, resolveSoldPlan } from "./clone-metering-tenant.server";
import { ensureTenant } from "./clone-api-keys.server";

const CLONE = "6f1c2a4e-1d7b-4c43-9a1e-2f0d7c9b8a11";
const OTHER = "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b";
const BILLING_ID = "acme-advisory";
/** What a clone's token client names: `prime:<its Supabase project ref>`. */
const FIRST_CALL_REF = "prime:qvuwrvwzjyigptmnijyb";

// The six plans Mission Control's billing_plans holds, measured 27 Oct 2026.
const PLANS: Row[] = [
  { id: "plan-free", slug: "free", price_cents: 0, monthly_allowance: 100, is_active: true },
  {
    id: "plan-starter",
    slug: "starter",
    price_cents: 1900,
    monthly_allowance: 1000,
    is_active: true,
  },
  { id: "plan-pro", slug: "pro", price_cents: 9900, monthly_allowance: 10000, is_active: true },
  {
    id: "plan-launch",
    slug: "launch",
    price_cents: 69900,
    monthly_allowance: 7000,
    is_active: true,
  },
  {
    id: "plan-growth",
    slug: "growth",
    price_cents: 105500,
    monthly_allowance: 35000,
    is_active: true,
  },
  {
    id: "plan-scale",
    slug: "scale",
    price_cents: 221000,
    monthly_allowance: 75000,
    is_active: true,
  },
];
const LAUNCH = { id: "plan-launch", slug: "launch" };

type MeteringInput = Parameters<typeof ensureCloneMeteringTenant>[0];

const clone = (over: Partial<MeteringInput> = {}): MeteringInput => ({
  cloneId: CLONE,
  cloneName: "Acme Advisory",
  cloneSlug: "acme-advisory",
  billingUserId: BILLING_ID,
  billingStripeCustomerId: null,
  plan: LAUNCH,
  ...over,
});

const tenant = (over: Row): Row => ({
  id: "tenant-existing",
  clone_id: CLONE,
  external_ref: CLONE,
  billing_user_id: BILLING_ID,
  plan_id: "plan-free",
  plan_started_at: "2026-10-01T00:00:00.000Z",
  current_period_start: "2026-10-01T00:00:00.000Z",
  current_period_end: "2026-11-01T00:00:00.000Z",
  status: "active",
  ...over,
});

/** The plan the clone's first metered call reports, as the balance route reads it. */
async function planTheFirstCallReports(): Promise<{ tenantId: string; plan: string | null }> {
  const found = await ensureTenant(CLONE, FIRST_CALL_REF, "Prime");
  if (!found.ok) throw new Error(found.error);
  const { data } = await h.db
    .from("tenants")
    .select("id, billing_plans:plan_id(slug, name, monthly_allowance, overage_policy)")
    .eq("id", found.tenantId)
    .maybeSingle();
  return { tenantId: found.tenantId, plan: data?.billing_plans?.slug ?? null };
}

beforeEach(() => {
  h.db = createTenantFakeDb({
    billing_plans: PLANS,
    clones: [
      { id: CLONE, name: "Acme Advisory", slug: "acme-advisory", billing_user_id: BILLING_ID },
      { id: OTHER, name: "Other", slug: "other", billing_user_id: "other" },
    ],
  });
});

describe("resolveSoldPlan", () => {
  it("names the plan a clone is sold by its slug", async () => {
    expect(await resolveSoldPlan("launch")).toEqual({ ok: true, plan: LAUNCH });
  });

  it("reads no slug as no plan", async () => {
    for (const slug of [undefined, null, "", "   "]) {
      expect(await resolveSoldPlan(slug)).toEqual({ ok: true, plan: null });
    }
  });

  it("refuses a slug billing_plans does not hold, and never puts free in its place", async () => {
    const r = await resolveSoldPlan("enterprise");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('No billing plan is named "enterprise"');
    expect(r.error).toContain('never put on "free"');
  });

  it("refuses a retired plan", async () => {
    h.db.tables.billing_plans.find((p) => p.slug === "launch")!.is_active = false;
    const r = await resolveSoldPlan("launch");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("is not active") });
  });

  it("answers a failed read as an error, never as no plan", async () => {
    h.db.failures.set("billing_plans.select", STATEMENT_TIMEOUT);
    const r = await resolveSoldPlan("launch");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("statement timeout") });
  });
});

describe("a new clone's metering tenant", () => {
  it("is created on the plan it was sold, and the clone's first call reports that plan", async () => {
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({
      ok: true,
      tenantId: expect.any(String),
      action: "created",
      planSlug: "launch",
    });

    expect(h.db.tables.tenants).toHaveLength(1);
    expect(h.db.tables.tenants[0]).toMatchObject({
      clone_id: CLONE,
      external_ref: CLONE,
      display_name: "Acme Advisory",
      billing_user_id: BILLING_ID,
      plan_id: "plan-launch",
      plan_started_at: expect.any(String),
      status: "active",
    });

    const first = await planTheFirstCallReports();
    expect(first).toEqual({ tenantId: r.ok ? r.tenantId : "", plan: "launch" });
    // Adopted, not duplicated: one tenant, one balance.
    expect(h.db.tables.tenants).toHaveLength(1);
  });

  it("starts no billing period and issues no allowance: those arrive with the payment", async () => {
    await ensureCloneMeteringTenant(clone({ plan: { id: "plan-scale", slug: "scale" } }));
    expect(h.db.tables.tenants[0]).toMatchObject({
      current_period_start: null,
      current_period_end: null,
    });
    // The hourly issuer passes over a tenant whose period has not started.
    expect(h.db.tables.token_ledger).toEqual([]);
    expect(h.db.rpcs).toEqual([]);
  });

  it("holds no plan when none was sold, and is still never free", async () => {
    const r = await ensureCloneMeteringTenant(clone({ plan: null }));
    expect(r).toMatchObject({ ok: true, action: "created", planSlug: null });
    expect(h.db.tables.tenants[0].plan_id).toBeNull();
    expect((await planTheFirstCallReports()).plan).toBeNull();
  });

  it("fails on a failed read rather than reading it as no tenant", async () => {
    h.db.failures.set("tenants.select", STATEMENT_TIMEOUT);
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: false, error: expect.stringContaining("statement timeout") });
    expect(h.db.writes).toEqual([]);
  });

  it("fails on a failed insert", async () => {
    h.db.failures.set("tenants.insert", STATEMENT_TIMEOUT);
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: false, error: expect.stringContaining("could not be created") });
  });

  it("adopts the tenant a concurrent call created between its read and its insert", async () => {
    let raced = false;
    h.db.beforeWrite = (table, op) => {
      if (raced || table !== "tenants" || op !== "insert") return;
      raced = true;
      // The clone's first call, landing first, on the lazy path's plan.
      h.db.tables.tenants.push(tenant({ id: "tenant-raced", external_ref: FIRST_CALL_REF }));
    };
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: true, tenantId: "tenant-raced", action: "set", planSlug: "launch" });
    expect(h.db.tables.tenants).toHaveLength(1);
    expect((await planTheFirstCallReports()).plan).toBe("launch");
  });
});

describe("a clone provisioning left with no billing identity", () => {
  // Provisioning's resolution never throws: a control plane it could not read
  // inserts the clone with none. The tenant is found by it, so it is healed
  // first, by the deployment worker's own rule.
  const unidentified = () => clone({ billingUserId: null });
  const cloneRow = () => h.db.tables.clones.find((c) => c.id === CLONE)!;

  beforeEach(() => {
    cloneRow().billing_user_id = null;
  });

  it("is given one from its slug, and its first call finds the tenant on the sold plan", async () => {
    const r = await ensureCloneMeteringTenant(unidentified());
    expect(r).toMatchObject({ ok: true, action: "created", planSlug: "launch" });
    // On the clone, where the first call reads it, and on the tenant it finds.
    expect(cloneRow().billing_user_id).toBe(BILLING_ID);
    expect(h.db.tables.tenants).toEqual([
      expect.objectContaining({ billing_user_id: BILLING_ID, plan_id: "plan-launch" }),
    ]);
    expect(await planTheFirstCallReports()).toEqual({
      tenantId: r.ok ? r.tenantId : "",
      plan: "launch",
    });
    expect(h.db.tables.tenants).toHaveLength(1);
  });

  it("publishes the identity an operator recorded while it ran, not its own", async () => {
    h.db.beforeWrite = (table, op) => {
      if (table === "clones" && op === "update") cloneRow().billing_user_id = "acme-chosen";
    };
    const r = await ensureCloneMeteringTenant(unidentified());
    expect(r).toMatchObject({ ok: true, action: "created" });
    expect(cloneRow().billing_user_id).toBe("acme-chosen");
    expect(h.db.tables.tenants[0].billing_user_id).toBe("acme-chosen");
  });

  it("is refused when the slug's identity is another tenant's, and nothing is written", async () => {
    h.db.tables.tenants.push(tenant({ clone_id: OTHER, external_ref: OTHER }));
    const r = await ensureCloneMeteringTenant(unidentified());
    expect(r).toEqual({ ok: false, error: expect.stringContaining("no billing identity") });
    expect(r.ok ? "" : r.error).toContain("not used");
    expect(h.db.writes).toEqual([]);
    expect(cloneRow().billing_user_id).toBeNull();
  });

  it("fails on a failed read rather than reading it as an id nobody holds", async () => {
    h.db.failures.set("tenants.select", STATEMENT_TIMEOUT);
    const r = await ensureCloneMeteringTenant(unidentified());
    expect(r).toEqual({ ok: false, error: expect.stringContaining("statement timeout") });
    expect(h.db.writes).toEqual([]);
  });

  it("fails when the identity could not be recorded, and creates no tenant", async () => {
    h.db.failures.set("clones.update", STATEMENT_TIMEOUT);
    const r = await ensureCloneMeteringTenant(unidentified());
    expect(r).toEqual({ ok: false, error: expect.stringContaining("could not be recorded") });
    expect(h.db.tables.tenants).toEqual([]);
  });
});

describe("a tenant the clone already has", () => {
  it("takes the sold plan when it holds free, and its free period ends", async () => {
    h.db.tables.tenants.push(tenant({}));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: true, tenantId: "tenant-existing", action: "set", planSlug: "launch" });
    expect(h.db.tables.tenants).toHaveLength(1);
    expect(h.db.tables.tenants[0]).toMatchObject({
      plan_id: "plan-launch",
      current_period_start: null,
      current_period_end: null,
    });
    expect((await planTheFirstCallReports()).plan).toBe("launch");
  });

  it("takes it when it holds no plan", async () => {
    h.db.tables.tenants.push(tenant({ plan_id: null }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toMatchObject({ ok: true, action: "set", planSlug: "launch" });
  });

  it("is found by the clone's billing id under the ref its first call used", async () => {
    h.db.tables.tenants.push(tenant({ external_ref: FIRST_CALL_REF }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toMatchObject({ ok: true, tenantId: "tenant-existing", action: "set" });
    expect(h.db.tables.tenants).toHaveLength(1);
  });

  it("is left alone when it already holds the sold plan", async () => {
    h.db.tables.tenants.push(tenant({ plan_id: "plan-launch" }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({
      ok: true,
      tenantId: "tenant-existing",
      action: "kept",
      planSlug: "launch",
    });
    expect(h.db.writes).toEqual([]);
  });

  it("keeps a different paid plan and reports it, never overwriting it", async () => {
    h.db.tables.tenants.push(tenant({ plan_id: "plan-growth" }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({
      ok: true,
      tenantId: "tenant-existing",
      action: "conflict",
      planSlug: "launch",
      heldPlanSlug: "growth",
    });
    expect(h.db.writes).toEqual([]);
    expect(h.db.tables.tenants[0].plan_id).toBe("plan-growth");
  });

  it("is not overwritten when its plan changes between the read and the write", async () => {
    h.db.tables.tenants.push(tenant({}));
    h.db.beforeWrite = (table, op) => {
      // A Stripe webhook moving it to Growth in the meantime.
      if (table === "tenants" && op === "update") h.db.tables.tenants[0].plan_id = "plan-growth";
    };
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining("changed while it was being read"),
    });
    expect(h.db.tables.tenants[0].plan_id).toBe("plan-growth");
  });

  it("is refused when another clone's tenant holds the billing id", async () => {
    h.db.tables.tenants.push(tenant({ clone_id: OTHER, external_ref: OTHER }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: false, error: expect.stringContaining(`clone ${OTHER}`) });
    expect(h.db.writes).toEqual([]);
  });

  it("is refused when it holds a plan billing_plans cannot name", async () => {
    h.db.tables.tenants.push(tenant({ plan_id: "plan-retired-and-deleted" }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: false, error: expect.stringContaining("does not name") });
    expect(h.db.writes).toEqual([]);
  });

  it("keeps whatever it holds when nothing was sold", async () => {
    h.db.tables.tenants.push(tenant({}));
    const r = await ensureCloneMeteringTenant(clone({ plan: null }));
    expect(r).toEqual({ ok: true, tenantId: "tenant-existing", action: "kept", planSlug: "free" });
    expect(h.db.writes).toEqual([]);
  });
});

describe("a tenant keyed by the clone and its billing identity (Codex, #385)", () => {
  // The clone's first call finds a tenant keyed by the clone through the
  // clone's billing id alone. An attempt that made the tenant, then an
  // operator's new id on the clone, then a retry: the retry used to adopt the
  // tenant whatever id it carried.
  it("is refused when it carries an id the clone no longer has, and nothing is written", async () => {
    h.db.tables.tenants.push(tenant({ billing_user_id: "acme-advisory-old" }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining('carries billing id "acme-advisory-old"'),
    });
    expect(h.db.writes).toEqual([]);
    // What the refusal prevents: the first call passes that tenant over and
    // makes a second one on free.
    const first = await planTheFirstCallReports();
    expect(first.tenantId).not.toBe("tenant-existing");
    expect(first.plan).toBe("free");
  });

  it("is given the clone's id when it has none, and the first call adopts it on the sold plan", async () => {
    h.db.tables.tenants.push(tenant({ billing_user_id: null }));
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: true, tenantId: "tenant-existing", action: "set", planSlug: "launch" });
    expect(h.db.tables.tenants).toHaveLength(1);
    expect(h.db.tables.tenants[0].billing_user_id).toBe(BILLING_ID);
    expect(await planTheFirstCallReports()).toEqual({
      tenantId: "tenant-existing",
      plan: "launch",
    });
  });

  it("gives way to the tenant holding the clone's id, which is the one the first call adopts", async () => {
    h.db.tables.tenants.push(
      tenant({ id: "tenant-keyed", billing_user_id: "acme-advisory-old" }),
      tenant({ id: "tenant-holder", external_ref: FIRST_CALL_REF }),
    );
    const r = await ensureCloneMeteringTenant(clone());
    expect(r).toEqual({ ok: true, tenantId: "tenant-holder", action: "set", planSlug: "launch" });
    expect(await planTheFirstCallReports()).toEqual({
      tenantId: "tenant-holder",
      plan: "launch",
    });
  });
});

describe("before this, the clone's first call chose the plan", () => {
  it("and chose free: the lazy path's own answer for a clone with no tenant", async () => {
    // The state every engine clone was provisioned into. Pinned so the test
    // above it is a change of behaviour rather than a description of one.
    expect((await planTheFirstCallReports()).plan).toBe("free");
  });
});
