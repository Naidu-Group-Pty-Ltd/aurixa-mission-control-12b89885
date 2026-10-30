/**
 * What `close_api_usage_period` answers, read once, for the settlement sweep and
 * the Billing page's manual close.
 *
 * A period closes into one charge per currency (20261030090000), so a USD line
 * and an AUD line are never summed into one amount labelled with either. The
 * function's top-level fields are its first charge's, as it answered before it
 * closed per currency, so an answer without `charges` (the function before that
 * file) reads as the one charge it closed.
 *
 * Pure: no imports, no I/O.
 */

/** One currency's charge for a tenant-period, as `close_api_usage_period` closed it. */
export type ClosedCharge = {
  chargeId: string;
  currency: string;
  alreadyClosed: boolean;
  amountCents: number;
  lines: number;
};

export type CloseResult =
  | {
      ok: true;
      chargeId: string;
      alreadyClosed: boolean;
      amountCents: number;
      lines: number;
      /** One per currency the period's rollups hold, in currency order. */
      charges: ClosedCharge[];
    }
  | { ok: false; error: string };

type ClosedChargeAnswer = {
  charge_id?: string;
  currency?: string;
  already_closed?: boolean;
  amount_cents?: number;
  lines?: number;
};

/** What `close_api_usage_period` answered, read the same way before and after it closed per currency. */
export function closeResultFrom(data: unknown): CloseResult {
  const r = (data ?? {}) as ClosedChargeAnswer & {
    ok?: boolean;
    error?: string;
    charges?: ClosedChargeAnswer[];
  };
  if (!r.ok) return { ok: false, error: r.error ?? "close_failed" };
  const toCharge = (c: ClosedChargeAnswer): ClosedCharge => ({
    chargeId: c.charge_id as string,
    currency: c.currency ?? "AUD",
    alreadyClosed: Boolean(c.already_closed),
    amountCents: c.amount_cents ?? 0,
    lines: c.lines ?? 0,
  });
  // An answer with no `charges` is the function before 20261030090000: one
  // charge, the top-level one.
  const charges = Array.isArray(r.charges) && r.charges.length > 0 ? r.charges.map(toCharge) : [toCharge(r)];
  return {
    ok: true,
    chargeId: charges[0].chargeId,
    alreadyClosed: charges[0].alreadyClosed,
    amountCents: charges[0].amountCents,
    lines: charges[0].lines,
    charges,
  };
}
