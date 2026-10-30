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
        {
          already_closed: false,
          charge_id: "a",
          status: "closed",
          lines: 1,
          amount_cents: 120,
          currency: "AUD",
        },
        {
          already_closed: true,
          charge_id: "b",
          status: "below_threshold",
          amount_cents: 14,
          currency: "USD",
        },
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
    expect(closeResultFrom({ ok: false, error: "tenant_not_found" })).toEqual({
      ok: false,
      error: "tenant_not_found",
    });
    expect(closeResultFrom(null)).toEqual({ ok: false, error: "close_failed" });
  });
});

describe("the sweep and the invoice path", () => {
  const settlement = readFileSync("src/server/api-usage-settlement.server.ts", "utf8");

  it("invoices each currency's charge on its own", () => {
    const sweep = settlement.slice(
      settlement.indexOf("export async function sweepApiUsageSettlement"),
    );
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
    const branch = below.slice(
      0,
      below.indexOf('return { ok: true, skipped: true, reason: "below_threshold" };'),
    );
    expect(branch).toContain('status: "below_threshold"');
    expect(branch).not.toContain('status: "invoiced"');
    expect(branch).not.toContain("invoiced_at");
    expect(branch).not.toContain("invoiceItems.create");
    // A charge already below the threshold is left alone on the next sweep.
    expect(invoice).toContain('if (row.status === "below_threshold") {');
  });

  it("the migration lets the status exist and keys a charge by its currency", () => {
    const sql = readFileSync(
      "supabase/migrations/20261030090000_usage_charges_keep_currencies_apart.sql",
      "utf8",
    );
    expect(sql).toContain(
      "check (status in ('open', 'closed', 'invoiced', 'below_threshold', 'waived', 'failed'))",
    );
    expect(sql).toContain("unique (tenant_id, period_start, currency)");
    expect(sql).toContain("and r.currency = _currency");
    expect(sql).not.toMatch(/_currency\s*:=\s*_row\.currency/);
  });
});

/**
 * Usage is filed under the period it falls in (key audit R7, 30 Oct 2026). A
 * tenant's anchor moves only when Stripe renews, so ten of twelve still read
 * the day each was provisioned and every event since was filed under a period
 * that had already closed: about 16,000 Airtable requests for each of four
 * tenants that no charge could ever carry.
 */
describe("the period usage is filed under", () => {
  const sql = readFileSync(
    "supabase/migrations/20261030110000_usage_files_under_its_own_period.sql",
    "utf8",
  );
  const settlement = readFileSync("src/server/api-usage-settlement.server.ts", "utf8");
  const overview = readFileSync("src/lib/api-usage.functions.ts", "utf8");
  const record = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.record_api_usage_event"),
    sql.indexOf("$function$;"),
  );

  it("counts whole months from the anchor, and only before it falls back to the calendar month", () => {
    const fn = sql.slice(
      sql.indexOf("function public.api_usage_period_start"),
      sql.indexOf("function public.api_usage_period_end"),
    );
    expect(fn).toContain("if _anchor is null or _day < _anchor then");
    expect(fn).toContain("(_anchor + make_interval(months => _months))::date");
    // Counted from the anchor each time, never from the previous period, so a
    // 31st anchor gives 28 Feb and then 31 Mar rather than 28 Mar.
    expect(fn).toContain("(_anchor + make_interval(months => _months - 1))::date");
  });

  it("is how record_api_usage_event files an event, and its anchor-only reading is gone", () => {
    expect(record).toContain(
      "SELECT public.api_usage_period_start(t.current_period_start::date,_when) INTO _period",
    );
    expect(record).not.toContain(
      "COALESCE(t.current_period_start::date,date_trunc('month',_when)::date)",
    );
    expect(record).toContain("'tenant_not_found'");
  });

  it("re-files only what feeds a rollup, rebuilds both sides, and refuses to change a tenant's totals", () => {
    expect(sql).toContain(
      "lock table public.api_usage_events, public.api_usage_rollups in share row exclusive mode;",
    );
    expect(sql).toContain("and exists (select 1 from public.api_usage_rollups r");
    expect(sql).toContain(
      "select tenant_id, secret_name, from_period as period_start from r7_moves",
    );
    expect(sql).toContain("select tenant_id, secret_name, to_period from r7_moves");
    expect(sql).toContain("raise exception 'R7 re-file changed a tenant''s totals");
  });

  it("labels a charge with the one currency its lines are rated in, and that currency's cost", () => {
    expect(sql).toContain(
      "having count(*) = count(pr.currency) and count(distinct pr.currency) = 1",
    );
    expect(sql).toContain("'currency_relabelled_from', c.currency");
    expect(sql).toContain("and r.currency = l.rated_in");
  });

  it("ends a period where the tenant's next one starts", () => {
    const close = sql.slice(
      sql.indexOf("create or replace function public.close_api_usage_period"),
    );
    expect(close).toContain(
      "else public.api_usage_period_end(t.current_period_start::date, _period_start)",
    );
  });

  it("hands the sweep only periods before the current one with a currency still to settle", () => {
    const closable = sql.slice(sql.indexOf("function public.api_usage_closable_periods"));
    expect(closable).toContain(
      "r.period_start < public.api_usage_period_start(t.current_period_start::date, now())",
    );
    // `closed` is not finished: it is waiting to be invoiced, and a tenant
    // given a Stripe customer later must still be billed.
    expect(closable).toContain("c.status in ('invoiced', 'below_threshold', 'waived', 'failed')");
    expect(settlement).toContain('adminAny.rpc("api_usage_closable_periods", { _limit: limit })');
    expect(settlement).toContain("if (error) throw new Error(");
    expect(settlement).not.toContain("setUTCMonth");
  });

  it("shows each tenant's current period when the overview asks for none", () => {
    expect(sql).toContain(
      "WHERE r.period_start=COALESCE(_period_start,public.api_usage_period_start(t.current_period_start::date,now()))",
    );
    expect(sql).toContain(
      "_period:=COALESCE(_period_start,(SELECT public.api_usage_period_start(current_period_start::date,now())",
    );
    expect(overview).toContain("_period_start: data.period_start,");
    expect(overview).not.toContain("defaultPeriod()");
  });
});
