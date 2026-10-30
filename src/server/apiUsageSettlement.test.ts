import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { closeResultFrom } from "./apiUsageSettlement.pure";

/**
 * A period closes into one charge per currency, and a charge under the
 * invoicing threshold says so (key audit R6, 29 Oct 2026). Three tenants' 8 Sep
 * periods held AUD (Airtable) and USD (Didit) rollups, and each closed as one
 * charge labelled with the last rollup's currency; all four charges that
 * existed read `invoiced` though none reached Stripe.
 */
describe("closeResultFrom", () => {
  it("reads every currency's charge, with the first one's fields on top", () => {
    const r = closeResultFrom({
      ok: true,
      already_closed: false,
      charge_id: "a",
      status: "closed",
      lines: 1,
      amount_cents: 120,
      currency: "AUD",
      charges: [
        { already_closed: false, charge_id: "a", status: "closed", lines: 1, amount_cents: 120, currency: "AUD" },
        { already_closed: true, charge_id: "b", status: "below_threshold", amount_cents: 14, currency: "USD" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      chargeId: "a",
      alreadyClosed: false,
      amountCents: 120,
      lines: 1,
      charges: [
        { chargeId: "a", currency: "AUD", alreadyClosed: false, amountCents: 120, lines: 1 },
        { chargeId: "b", currency: "USD", alreadyClosed: true, amountCents: 14, lines: 0 },
      ],
    });
  });

  it("reads the function before it closed per currency as the one charge it closed", () => {
    const r = closeResultFrom({
      ok: true,
      already_closed: true,
      charge_id: "only",
      status: "invoiced",
      amount_cents: 300,
    });
    expect(r.ok && r.charges).toEqual([
      { chargeId: "only", currency: "AUD", alreadyClosed: true, amountCents: 300, lines: 0 },
    ]);
  });

  it("passes a refusal through", () => {
    expect(closeResultFrom({ ok: false, error: "tenant_not_found" })).toEqual({ ok: false, error: "tenant_not_found" });
    expect(closeResultFrom(null)).toEqual({ ok: false, error: "close_failed" });
  });
});

describe("the sweep and the invoice path", () => {
  const settlement = readFileSync("src/server/api-usage-settlement.server.ts", "utf8");

  it("invoices each currency's charge on its own", () => {
    const sweep = settlement.slice(settlement.indexOf("export async function sweepApiUsageSettlement"));
    expect(sweep).toContain("for (const charge of closed.charges) {");
    expect(sweep).toContain("await invoiceClosedCharge(charge.chargeId)");
    expect(sweep).not.toContain("invoiceClosedCharge(closed.chargeId)");
  });

  it("never adds an AUD cent to a USD cent", () => {
    expect(settlement).toContain("totalCentsByCurrency[charge.currency]");
    expect(settlement).not.toMatch(/\btotalCents\s*\+=/);
  });

  it("marks a charge under the threshold below_threshold, never invoiced, and sends nothing", () => {
    const invoice = settlement.slice(
      settlement.indexOf("export async function invoiceClosedCharge"),
      settlement.indexOf("export type SweepResult"),
    );
    const below = invoice.slice(invoice.indexOf("if (row.amount_cents < MIN_INVOICEABLE_CENTS)"));
    const branch = below.slice(0, below.indexOf("return { ok: true, skipped: true, reason: \"below_threshold\" };"));
    expect(branch).toContain('status: "below_threshold"');
    expect(branch).not.toContain('status: "invoiced"');
    expect(branch).not.toContain("invoiced_at");
    expect(branch).not.toContain("invoiceItems.create");
    // A charge already below the threshold is left alone on the next sweep.
    expect(invoice).toContain('if (row.status === "below_threshold") {');
  });

  it("the migration lets the status exist and keys a charge by its currency", () => {
    const sql = readFileSync("supabase/migrations/20261030090000_usage_charges_keep_currencies_apart.sql", "utf8");
    expect(sql).toContain("check (status in ('open', 'closed', 'invoiced', 'below_threshold', 'waived', 'failed'))");
    expect(sql).toContain("unique (tenant_id, period_start, currency)");
    expect(sql).toContain("and r.currency = _currency");
    expect(sql).not.toMatch(/_currency\s*:=\s*_row\.currency/);
  });
});
