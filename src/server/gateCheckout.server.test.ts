// The activation checkout, run against a fake Supabase seeded with the rows
// Mission Control held on 28 Oct 2026: NPC Test's gate, armed on 16 Sep at the
// Launch price of the day ($699), and the catalogue's rows as repriced on
// 27 Sep ($999). Stripe and the tenant resolution are the only doubles.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  checkouts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" = "select";
    let values: Row | Row[] | undefined;
    const rowsOf = () => (h.tables[table] ??= []);
    const result = (): { data: unknown; error: { message: string; code?: string } | null } => {
      if (h.failing.has(`${table}:${op}`)) {
        return { data: null, error: { message: `${table} ${op} failed` } };
      }
      if (op === "insert") {
        const incoming = Array.isArray(values) ? values : [values as Row];
        rowsOf().push(...incoming.map((v) => ({ ...v })));
        return { data: null, error: null };
      }
      const rows = rowsOf().filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of rows) Object.assign(r, values);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (v: Row | Row[]) => ((op = "insert"), (values = v), b),
      update: (v: Row) => ((op = "update"), (values = v), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      // PostgREST's answer: no row is `null` with no error, two rows are an error.
      maybeSingle: async () => {
        const r = result();
        if (r.error || !Array.isArray(r.data)) return r;
        if (r.data.length > 1) {
          return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
        }
        return { data: r.data[0] ?? null, error: null };
      },
      then: (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, bad),
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("@/server/audit.server", () => ({
  writeAuditLog: vi.fn(async () => {}),
  notifyOperators: vi.fn(async () => true),
}));

vi.mock("@/server/billing-tenant.server", () => ({
  resolveCloneBillingTenant: vi.fn(async () => ({ ok: true, tenantId: "tenant-npc-test" })),
}));

// Stripe. What reached it is the assertion; a session is all it answers.
vi.mock("@/server/checkout.server", () => ({
  startCheckoutCore: vi.fn(async (input: Record<string, unknown>) => {
    h.checkouts.push(input);
    return {
      ok: true,
      url: "https://checkout.stripe.com/c/pay/cs_test_gate",
      sessionId: "cs_test_gate",
    };
  }),
}));

import { gatePricingUrl, mintGateActivationCheckout } from "./gateCheckout.server";
import { assertGateOpen, gateLockedBody, gateQuote } from "./payment-gate.server";
import { seatPlanForTier } from "@/lib/pricing/seatPlanForTier.pure";

const NPC_TEST = "7e2c004d-5a56-4d9f-bdae-09d28885d234";
const PRICING = "https://www.aurixasystems.com.au/pricing";

/** `seat_plans` as Mission Control held it on 28 Oct 2026. */
const SEAT_PLANS: Row[] = [
  {
    id: "plan-launch",
    slug: "launch",
    name: "Launch",
    is_active: true,
    price_cents: 99900,
    currency: "AUD",
    stripe_price_id: "price_launch",
  },
  {
    id: "plan-growth",
    slug: "growth",
    name: "Growth",
    is_active: true,
    price_cents: 139900,
    currency: "AUD",
    stripe_price_id: "price_growth",
  },
  {
    id: "plan-scale",
    slug: "scale",
    name: "Scale",
    is_active: true,
    price_cents: 269900,
    currency: "AUD",
    stripe_price_id: "price_scale",
  },
  {
    id: "plan-enterprise",
    slug: "enterprise",
    name: "Enterprise",
    is_active: true,
    price_cents: 1750000,
    currency: "AUD",
    stripe_price_id: "price_enterprise",
  },
];

/** NPC Test's gate as it stood: armed on 16 Sep, past its deadline, unpaid. */
function npcTestGate(over: Row = {}): Row {
  return {
    id: "gate-npc-test",
    clone_id: NPC_TEST,
    plan_slug: "launch",
    plan_name: "Launch",
    amount_due_cents: 69900,
    currency: "AUD",
    grace_hours: 72,
    armed_at: "2026-09-16T18:35:48.613Z",
    locks_at: "2026-09-19T18:35:48.613Z",
    paid_at: null,
    manual_override: null,
    trial_extensions: [],
    ...over,
  };
}

beforeEach(() => {
  vi.stubEnv("PUBLIC_PRICING_SITE_URL", "");
  h.failing.clear();
  h.checkouts.length = 0;
  h.tables = {
    clone_payment_gates: [npcTestGate()],
    clone_payment_gate_events: [],
    seat_plans: SEAT_PLANS.map((r) => ({ ...r })),
    clones: [
      {
        id: NPC_TEST,
        name: "NPC Test",
        slug: "npc-test-76b3b3",
        billing_user_id: "npc-test-76b3b3",
        deploy_url: "https://npc-test.aurixasystems.com.au",
      },
    ],
  };
});

describe("a gate quotes its plan's price today", () => {
  it("quotes $999 for a Launch gate stamped $699 at arming", async () => {
    const quote = await gateQuote(npcTestGate() as never);
    expect(quote).toEqual({ planName: "Launch", amountDueCents: 99900, currency: "AUD" });
  });

  it("the stamp was what refused the row, and today's quote is what the row costs", () => {
    const active = SEAT_PLANS.filter((r) => r.is_active) as Array<{
      slug: string;
      price_cents: number;
    }>;
    expect(seatPlanForTier("launch", active, 69900)).toMatchObject({
      ok: false,
      reason: "price_mismatch",
      rowCents: 99900,
    });
    expect(seatPlanForTier("launch", active, 99900)).toMatchObject({ ok: true });
  });

  it("the guard's 402 states the same figure", async () => {
    const guard = await assertGateOpen(NPC_TEST);
    expect(guard.open).toBe(false);
    if (guard.open) return;
    expect(gateLockedBody(guard)).toMatchObject({
      error: "workspace_locked",
      plan_slug: "launch",
      amount_due_cents: 99900,
      currency: "AUD",
    });
  });
});

describe("the activation checkout", () => {
  it("mints a gate armed before the repricing, at today's price", async () => {
    const result = await mintGateActivationCheckout({
      cloneId: NPC_TEST,
      returnUrl: "https://npc-test.aurixasystems.com.au/dashboard",
      origin: "clone_cta",
    });
    expect(result).toEqual({
      ok: true,
      url: "https://checkout.stripe.com/c/pay/cs_test_gate",
      sessionId: "cs_test_gate",
    });
    expect(h.checkouts).toHaveLength(1);
    expect(h.checkouts[0]).toMatchObject({
      mode: "seat_plan",
      itemId: "plan-launch",
      cloneId: NPC_TEST,
      tenantId: "tenant-npc-test",
    });
    expect(h.tables.clone_payment_gate_events.map((e) => e.kind)).toEqual(["checkout_started"]);
  });

  it("still refuses a row that costs something other than the quote", async () => {
    // The catalogue says $999 and the Stripe-facing row was never synced.
    const launch = h.tables.seat_plans.find((r) => r.slug === "launch")!;
    launch.price_cents = 69900;
    const result = await mintGateActivationCheckout({ cloneId: NPC_TEST, origin: "clone_cta" });
    expect(result).toMatchObject({
      ok: false,
      error: "plan_not_purchasable",
      detail: "price_mismatch",
      status: 409,
    });
    expect(h.checkouts).toEqual([]);
  });

  it("refuses a plan nothing can price, rather than charge a price nobody was shown", async () => {
    h.tables.clone_payment_gates = [npcTestGate({ plan_slug: "retired-plan", plan_name: null })];
    const result = await mintGateActivationCheckout({ cloneId: NPC_TEST, origin: "clone_cta" });
    expect(result).toMatchObject({ ok: false, error: "plan_not_purchasable", detail: "no_quote" });
    expect(h.checkouts).toEqual([]);
  });
});

describe("every way out names the workspace", () => {
  it("a refusal's pricing page is scoped to the workspace's billing id", async () => {
    h.tables.clone_payment_gates = [npcTestGate({ paid_at: "2026-10-28T17:00:00Z" })];
    const result = await mintGateActivationCheckout({ cloneId: NPC_TEST, origin: "clone_cta" });
    expect(result).toMatchObject({
      ok: false,
      error: "already_paid",
      pricingUrl: `${PRICING}?uid=npc-test-76b3b3`,
    });
  });

  it("so is the one a failed gate read hands back", async () => {
    h.failing.add("clone_payment_gates:select");
    const result = await mintGateActivationCheckout({ cloneId: NPC_TEST, origin: "clone_cta" });
    expect(result).toMatchObject({
      ok: false,
      error: "gate_read_failed",
      status: 503,
      pricingUrl: `${PRICING}?uid=npc-test-76b3b3`,
    });
  });

  it("an operator's lock still offers no way to buy", async () => {
    h.tables.clone_payment_gates = [npcTestGate({ manual_override: "locked" })];
    const result = await mintGateActivationCheckout({ cloneId: NPC_TEST, origin: "clone_cta" });
    expect(result).toMatchObject({ ok: false, error: "operator_locked", pricingUrl: null });
  });

  it("a workspace with no billing id gets the browse-only page, never another tenant's", () => {
    expect(gatePricingUrl("npc-test-76b3b3")).toBe(`${PRICING}?uid=npc-test-76b3b3`);
    expect(gatePricingUrl(null)).toBe(PRICING);
    expect(gatePricingUrl("   ")).toBe(PRICING);
  });
});
