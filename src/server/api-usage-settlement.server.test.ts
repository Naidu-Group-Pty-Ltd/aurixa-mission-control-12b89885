// The settlement sweep against a fake Supabase that answers as supabase-js
// does: every query resolves to `{ data, error }`, a failed one to
// `{ data: null, error: { message, code, details, hint } }`, and nothing
// throws. The database's own answers (which periods are closable, what a
// close returns for a charge already closed) are the ones measured on a copy
// of production on 30 Oct 2026.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type PostgrestError = {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
};

const h = vi.hoisted(() => ({
  charges: [] as Row[],
  tenants: [] as Row[],
  stripeCalls: [] as Row[],
  /** A table whose reads fail, and how. */
  failingRead: new Map<string, PostgrestError>(),
}));

vi.mock("@/server/stripe.server", () => ({
  getStripe: () => ({
    invoiceItems: {
      create: async (args: Row, opts: Row) => {
        h.stripeCalls.push({ ...args, idempotencyKey: opts.idempotencyKey });
        return { id: `ii_${h.stripeCalls.length}` };
      },
    },
  }),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let values: Row = {};
    const rows = () =>
      table === "api_usage_charges" ? h.charges : table === "tenants" ? h.tenants : [];
    const run = (): { data: Row[] | null; error: PostgrestError | null } => {
      const failure = op === "select" ? h.failingRead.get(table) : undefined;
      if (failure) return { data: null, error: failure };
      if (op === "insert") return { data: null, error: null };
      const hit = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, values);
        return { data: null, error: null };
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const q = {
      select: () => q,
      update: (v: Row) => ((op = "update"), (values = v), q),
      insert: (v: Row) => ((op = "insert"), (values = v), q),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      gt: () => q,
      order: () => q,
      maybeSingle: async () => {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return q;
  }
  async function rpc(fn: string, args: Row) {
    if (fn === "api_usage_closable_periods") {
      // A charge left `closed` is not finished, so its period comes back.
      const open = h.charges.filter(
        (c) => !["invoiced", "below_threshold", "waived", "failed"].includes(String(c.status)),
      );
      return {
        data: open.map((c) => ({ tenant_id: c.tenant_id, period_start: c.period_start })),
        error: null,
      };
    }
    if (fn === "close_api_usage_period") {
      // A currency already closed is answered as it stands, never recomputed.
      const c = h.charges.find(
        (x) => x.tenant_id === args._tenant_id && x.period_start === args._period_start,
      )!;
      const entry = {
        already_closed: true,
        charge_id: c.id,
        status: c.status,
        amount_cents: c.amount_cents,
        currency: c.currency,
      };
      return { data: { ...entry, ok: true, charges: [entry] }, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fn}`, code: "PGRST202" } };
  }
  return { supabaseAdmin: { from, rpc } };
});

import { sweepApiUsageSettlement } from "./api-usage-settlement.server";

/** The CRM's October charge as the 19 Nov sweep would close it (57 cents). */
function crmCharge(): Row {
  return {
    id: "charge-crm-oct",
    tenant_id: "tenant-crm",
    clone_id: null,
    period_start: "2026-10-19",
    period_end: "2026-11-19",
    currency: "AUD",
    amount_cents: 57,
    amount_micros: 568700,
    cost_micros: 1.5,
    status: "closed",
    stripe_invoice_item_id: null,
    last_error: null,
    metadata: {},
  };
}

beforeEach(() => {
  h.stripeCalls.length = 0;
  h.failingRead.clear();
  h.charges.splice(0, h.charges.length, crmCharge());
  h.tenants.splice(0, h.tenants.length, {
    id: "tenant-crm",
    display_name: null,
    external_ref: "e97f18ab",
    stripe_customer_id: null,
    billing_stripe_customer_id: null,
  });
});

describe("a charge for a tenant the sweep cannot bill yet", () => {
  it("records a failed tenant read as what it is, sends nothing, and keeps the charge held", async () => {
    h.failingRead.set("tenants", {
      message: "canceling statement due to statement timeout",
      code: "57014",
      details: null,
      hint: null,
    });

    const run = await sweepApiUsageSettlement();

    expect(run.failed).toBe(1);
    expect(run.errors[0].error).toBe(
      "AUD: tenant_read_failed: canceling statement due to statement timeout",
    );
    expect(h.stripeCalls).toHaveLength(0);
    expect(h.charges[0]).toMatchObject({
      status: "closed",
      last_error: "tenant_read_failed: canceling statement due to statement timeout",
    });
    expect(h.charges[0].last_error).not.toBe("no_stripe_customer");
  });

  it("is read again by the next sweep, and invoiced once the read answers", async () => {
    h.failingRead.set("tenants", {
      message: "canceling statement due to statement timeout",
      code: "57014",
      details: null,
      hint: null,
    });
    await sweepApiUsageSettlement();

    h.failingRead.clear();
    h.tenants[0].billing_stripe_customer_id = "cus_crm";
    const run = await sweepApiUsageSettlement();

    expect(run.invoiced).toBe(1);
    expect(h.stripeCalls).toEqual([
      expect.objectContaining({
        customer: "cus_crm",
        amount: 57,
        currency: "aud",
        idempotencyKey: "api-usage-charge-charge-crm-oct",
      }),
    ]);
    expect(h.charges[0]).toMatchObject({ status: "invoiced", last_error: null });
  });

  it("holds a tenant with no Stripe customer as owed, and bills it when it has one", async () => {
    const first = await sweepApiUsageSettlement();
    const second = await sweepApiUsageSettlement();

    expect([first.errors[0].error, second.errors[0].error]).toEqual([
      "AUD: no_stripe_customer",
      "AUD: no_stripe_customer",
    ]);
    expect(h.stripeCalls).toHaveLength(0);
    expect(h.charges[0]).toMatchObject({ status: "closed", last_error: "no_stripe_customer" });

    h.tenants[0].stripe_customer_id = "cus_crm";
    const third = await sweepApiUsageSettlement();
    const fourth = await sweepApiUsageSettlement();

    expect(third.totalCentsByCurrency).toEqual({ AUD: 57 });
    expect(h.stripeCalls).toHaveLength(1);
    expect(fourth).toMatchObject({ invoiced: 0, failed: 0, closed: 0, alreadyClosed: 0 });
  });
});
