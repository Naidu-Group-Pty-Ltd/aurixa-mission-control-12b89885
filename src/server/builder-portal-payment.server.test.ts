/**
 * The writes behind the Builder Portal payment link, against a recording fake
 * of the database: which rows each update is conditional on is the whole of
 * the race safety here, and a pure test cannot see it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Query = {
  table: string;
  op: "select" | "update";
  payload?: Record<string, unknown>;
  filters: unknown[][];
};
type Result = { data: unknown; error: { message: string; code?: string } | null };

const h = vi.hoisted(() => ({
  queries: [] as Query[],
  respond: (_q: Query): Result => ({ data: null, error: null }),
  audits: [] as Array<{ action: string; metadata?: Record<string, unknown> }>,
  notes: [] as Array<{ title: string; severity: string; body: string }>,
  stripeStatus: "active",
  mailed: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const q: Query = { table, op: "select", filters: [] };
    h.queries.push(q);
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        q.filters.push([name, ...args]);
        return b;
      };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (payload: Record<string, unknown>) => {
        q.op = "update";
        q.payload = payload;
        return b;
      },
      eq: record("eq"),
      is: record("is"),
      not: record("not"),
      filter: record("filter"),
      lt: record("lt"),
      ilike: record("ilike"),
      limit: record("limit"),
      maybeSingle: () => Promise.resolve(h.respond(q)),
      then: (ok: (r: Result) => unknown, fail: (e: unknown) => unknown) =>
        Promise.resolve(h.respond(q)).then(ok, fail),
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("@/server/audit.server", () => ({
  writeAuditLog: async (entry: { action: string; metadata?: Record<string, unknown> }) => {
    h.audits.push(entry);
  },
  notifyOperators: async (n: { title: string; severity: string; body: string }) => {
    h.notes.push(n);
    return true;
  },
}));

vi.mock("@/server/stripe.server", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => ({ id, status: h.stripeStatus }),
    },
  }),
}));

vi.mock("@/server/graph-client", () => ({
  isGraphConfigured: () => true,
  defaultMailbox: () => "accounts@aurixa.test",
  sendMail: async () => {
    h.mailed++;
    return { kind: "sent" };
  },
}));

import type Stripe from "stripe";
import {
  recordBuilderPortalCheckout,
  sendBuilderPortalPaymentLink,
  setBuilderPortalPaymentLinkEnabled,
  sweepBuilderPortalPaymentLinks,
} from "./builder-portal-payment.server";

const ID = "0b6f3a52-6d3e-4a8e-9f55-1c2d3e4f5a6b";

function agreement(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    document_kind: "builder_partner",
    status: "signed",
    offer_reference: "AUR-BPA-20260930-ABCDEF",
    client_name: "Sam Builder",
    client_email: "sam@examplehomes.test",
    client_org: "Example Homes",
    signed_record_path: "builder-partner/signed/a.pdf",
    portal_payment_link_enabled: true,
    portal_payment_link_status: null,
    portal_payment_link_attempts: 0,
    portal_payment_link_attempted_at: null,
    portal_payment_link_sent_at: null,
    portal_payment_link_sent_to: null,
    portal_payment_link_detail: null,
    portal_subscription_id: null,
    portal_subscription_status: null,
    portal_subscription_customer_id: null,
    portal_checkout_session_id: null,
    portal_subscription_started_at: null,
    portal_subscription_updated_at: null,
    ...over,
  };
}

/** Reads answer with `row`; every update writes one row. */
function serve(row: Record<string, unknown>) {
  h.respond = (q) =>
    q.op === "update" ? { data: [{ id: ID }], error: null } : { data: row, error: null };
}

function updates(): Query[] {
  return h.queries.filter((q) => q.op === "update");
}

function session(over: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_new",
    client_reference_id: `bpa_${ID}`,
    subscription: "sub_new",
    customer: "cus_1",
    amount_total: 69900,
    currency: "aud",
    ...over,
  } as Stripe.Checkout.Session;
}

beforeEach(() => {
  h.queries = [];
  h.audits = [];
  h.notes = [];
  h.stripeStatus = "active";
  h.mailed = 0;
  serve(agreement());
});

describe("recording the subscription a checkout created", () => {
  it("records the first, conditional on there being none", async () => {
    await recordBuilderPortalCheckout(session());
    const [write] = updates();
    expect(write.payload).toMatchObject({
      portal_subscription_id: "sub_new",
      portal_subscription_status: "active",
    });
    expect(write.payload).toHaveProperty("portal_subscription_started_at");
    expect(write.filters).toContainEqual(["is", "portal_subscription_id", null]);
    expect(h.audits.map((a) => a.action)).toEqual(["agreement.portal_subscription_started"]);
  });

  it("replaces a cancelled subscription, conditional on the one it read", async () => {
    serve(agreement({ portal_subscription_id: "sub_old", portal_subscription_status: "canceled" }));
    await recordBuilderPortalCheckout(session());
    const [write] = updates();
    expect(write.payload).toMatchObject({
      portal_subscription_id: "sub_new",
      portal_subscription_status: "active",
      portal_checkout_session_id: "cs_test_new",
    });
    expect(write.payload).toHaveProperty("portal_subscription_started_at");
    expect(write.filters).toContainEqual(["eq", "portal_subscription_id", "sub_old"]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: "agreement.portal_subscription_replaced",
      metadata: { previous_subscription_id: "sub_old", previous_status: "canceled" },
    });
    expect(h.notes[0].title).toContain("restarted");
  });

  it("writes nothing over a live subscription and tells a person", async () => {
    serve(agreement({ portal_subscription_id: "sub_old", portal_subscription_status: "active" }));
    await recordBuilderPortalCheckout(session());
    expect(updates()).toHaveLength(0);
    expect(h.notes[0]).toMatchObject({ severity: "error" });
    expect(h.notes[0].title).toContain("Second Builder Portal subscription");
  });

  it("retries when another record won the race to replace", async () => {
    let reads = 0;
    h.respond = (q) => {
      if (q.op === "update") return { data: [], error: null };
      reads++;
      return {
        data: agreement(
          reads === 1
            ? { portal_subscription_id: "sub_old", portal_subscription_status: "canceled" }
            : { portal_subscription_id: "sub_other", portal_subscription_status: "active" },
        ),
        error: null,
      };
    };
    await expect(recordBuilderPortalCheckout(session())).rejects.toThrow(/retrying/);
    expect(h.audits).toHaveLength(0);
  });
});

describe("a builder billed separately", () => {
  it("is never emailed the link, even from the button", async () => {
    serve(agreement({ portal_payment_link_enabled: false }));
    for (const trigger of ["signature", "sweep", "manual"] as const) {
      const r = await sendBuilderPortalPaymentLink(ID, { trigger, actorUserId: null });
      expect(r).toMatchObject({ outcome: "skipped", reason: "billed_separately" });
    }
    expect(updates()).toHaveLength(0);
    expect(h.mailed).toBe(0);
  });

  it("cannot be switched off between the read and the claim", async () => {
    await sendBuilderPortalPaymentLink(ID, { trigger: "signature", actorUserId: null });
    const claim = updates()[0];
    expect(claim.payload).toMatchObject({ portal_payment_link_status: "sending" });
    expect(claim.filters).toContainEqual(["eq", "portal_payment_link_enabled", true]);
  });

  it("is not read by the sweep's owed and retry queries", async () => {
    h.respond = () => ({ data: [], error: null });
    await sweepBuilderPortalPaymentLinks();
    const reads = h.queries.filter((q) => q.op === "select");
    expect(reads).toHaveLength(3);
    const [owed, retry, stale] = reads;
    expect(owed.filters).toContainEqual(["eq", "portal_payment_link_enabled", true]);
    expect(retry.filters).toContainEqual(["eq", "portal_payment_link_enabled", true]);
    // A claim gone stale is still settled as unconfirmed, whatever the switch.
    expect(stale.filters).not.toContainEqual(["eq", "portal_payment_link_enabled", true]);
  });
});

describe("the switch", () => {
  it("is saved conditional on what was read, and audited", async () => {
    await setBuilderPortalPaymentLinkEnabled({
      actorUserId: "admin-1",
      agreementId: ID,
      enabled: false,
    });
    const [write] = updates();
    expect(write.payload).toEqual({ portal_payment_link_enabled: false });
    expect(write.filters).toContainEqual(["eq", "portal_payment_link_enabled", true]);
    expect(write.filters).toContainEqual(["filter", "portal_payment_link_status", "is", null]);
    expect(h.audits.map((a) => a.action)).toEqual(["agreement.portal_payment_link_disabled"]);
  });

  it("does nothing when it already says so", async () => {
    await setBuilderPortalPaymentLinkEnabled({
      actorUserId: "admin-1",
      agreementId: ID,
      enabled: true,
    });
    expect(updates()).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("will not move while a send is in flight", async () => {
    serve(
      agreement({
        portal_payment_link_status: "sending",
        portal_payment_link_attempted_at: new Date().toISOString(),
      }),
    );
    await expect(
      setBuilderPortalPaymentLinkEnabled({
        actorUserId: "admin-1",
        agreementId: ID,
        enabled: false,
      }),
    ).rejects.toThrow(/being sent/);
    expect(updates()).toHaveLength(0);
  });

  it("asks to be tried again when a send claimed the row first", async () => {
    h.respond = (q) =>
      q.op === "update" ? { data: [], error: null } : { data: agreement(), error: null };
    await expect(
      setBuilderPortalPaymentLinkEnabled({
        actorUserId: "admin-1",
        agreementId: ID,
        enabled: false,
      }),
    ).rejects.toThrow(/changed a moment ago/);
    expect(h.audits).toHaveLength(0);
  });
});
