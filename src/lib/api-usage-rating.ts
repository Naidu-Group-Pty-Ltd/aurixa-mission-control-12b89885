/**
 * Rating rules for piggybacked third-party API keys.
 *
 * A clone provisioned by Mission Control boots with the prime's own vendor keys
 * forwarded into its Supabase project. Every call it then makes on one of those
 * keys is billed to *our* vendor account, so it has to be attributable and
 * rechargeable. A clone that supplies its own key costs us nothing and must
 * provably cost the tenant nothing too.
 *
 * The rules live here, pure, because they decide money. `record_api_usage_event`
 * applies the same rules inside the ingest transaction (it has to — the
 * billability lookup and the rollup upsert must be atomic); this module is what
 * pins them to tests, and what the ingest route and settlement share for
 * validation, normalisation and the micros→cents conversion.
 */

/** What one unit of a provider is. Must match the SQL `unit` CHECK. */
export const USAGE_UNITS = [
  "request",
  "token",
  "email",
  "minute",
  "document",
  "page",
  "render",
  "verification",
  "message",
  "lookup",
] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/**
 * Why an event was or was not charged. Every event carries one, including the
 * free ones — "we didn't charge you" is only credible if it says why.
 */
export type BillingReason =
  /** The clone is running on our forwarded key. Billable. */
  | "inherited"
  /**
   * The clone holds no key and Mission Control made the vendor call FOR it,
   * on the prime's credential. Billable, for exactly the reason `inherited`
   * is: the prime's money was spent serving this tenant.
   *
   * A separate code rather than a reuse of `inherited`, because the two are
   * different facts about where the credential was — one travelled to the
   * clone, the other never left here — and an operator reading the ledger to
   * answer "which tenants hold our keys?" must not be told a brokered tenant
   * does.
   */
  | "brokered"
  /**
   * The prime's credential was spent and the money is deliberately NOT
   * recharged, because the tenant is charged for the same work in tokens.
   *
   * Didit is the case: Aurixa pays USD 0.30 for a complete identity
   * verification and the workspace pays 5 tokens for a consumed attempt and 5
   * more for a verified identity. Cost is still recorded, so the margin report
   * keeps reading the real spend; only the charge goes.
   *
   * Not `not_billable`, which produces the same numbers and says the wrong
   * thing: that one means platform overhead rather than tenant usage — a
   * shared infra key, our own webhook secret, a free-tier service. This is
   * genuine, per-customer, per-tenant usage of a paid vendor, priced
   * elsewhere. The next person to read a zero here has to be told which, or
   * they will conclude the meter is broken and "fix" it into a double charge.
   */
  | "absorbed"
  /** The clone supplied its own key. Metered for insight, charged at nothing. */
  | "byok"
  /** No key on the clone at all, or no clone (the prime's own tenant). */
  | "no_key"
  /** We have no record of lending this clone this key — never charge on a guess. */
  | "unknown_secret"
  /** Catalogued, but flagged as platform overhead rather than tenant usage. */
  | "not_billable"
  /** The vendor call failed. Metered; charging for nothing delivered is indefensible. */
  | "error_call"
  /** The secret is not in the rate catalog yet. Surfaced so an operator prices it. */
  | "rate_missing";

export const BILLING_REASONS: BillingReason[] = [
  "inherited",
  "brokered",
  "absorbed",
  "byok",
  "no_key",
  "unknown_secret",
  "not_billable",
  "error_call",
  "rate_missing",
];

/**
 * `clone_backend_secrets.status`, as the COLUMN spells it.
 *
 * This must stay the column's full vocabulary and not a convenient subset: a
 * status the union omits still arrives at runtime, falls past every named
 * branch and is rated by the `else`. That is how `withheld` came to be rated
 * `no_key` — the fall-through happened to be the safe answer before the
 * broker existed, and became a silent revenue loss the moment it did.
 */
export type CloneSecretStatus =
  | "inherited"
  | "set"
  | "missing"
  | "failed"
  | "authorised_no_value"
  | "withheld";

/**
 * The piggyback rule, in one place.
 *
 * `null` for the secret status means we have no row: provisioning never lent
 * this clone this key. That is not the same as "missing" (we tried and nothing
 * landed) and neither is billable — but they are distinct on the dashboard,
 * because `unknown_secret` at volume means the reporter is sending a name the
 * provisioner does not know, which is a bug to fix, not spend to collect.
 */
export function resolveBillingReason(args: {
  cloneId: string | null;
  secretStatus: CloneSecretStatus | null;
  rateExists: boolean;
  rateIsBillable: boolean;
  callStatus: "success" | "error";
  /**
   * Mission Control made this vendor call itself, on the prime's credential,
   * on the clone's behalf.
   *
   * Asserted by the broker, never inferred, and never accepted from a clone
   * (`normalizeEvent` strips it) — the broker is the only party that KNOWS,
   * because it is the party that made the call. The status column is a
   * second, independent route to the same answer and neither is trusted to
   * cover the other: a ledger row can lag a withdrawal, and a brokered call
   * can be made for a clone whose row says something else entirely.
   */
  brokered?: boolean;
  /**
   * The vendor's money is the platform's to absorb, because the tenant is
   * charged for the same work in another currency (tokens).
   *
   * A property of the RATE row (`api_provider_rates.absorbed`), never of the
   * call — which is why it is asked here, after the route is known, and
   * replaces only the two reasons in which our credential was actually spent.
   * A tenant's own key on an absorbed vendor is still `byok`: it spent their
   * money and there is nothing for us to absorb.
   */
  rateAbsorbed?: boolean;
}): BillingReason {
  if (!args.rateExists) return "rate_missing";
  if (!args.rateIsBillable) return "not_billable";
  // A tenant with no clone is the prime itself — our project, our key.
  if (args.cloneId === null) return "no_key";
  // Only a call that actually succeeded on our credential reaches a charge.
  // Asked BEFORE the route, so a failed brokered call is `error_call` exactly
  // as a failed inherited one is — we do not charge for nothing delivered,
  // whichever side of the broker the credential sat on.
  const spentOurs =
    args.brokered === true || args.secretStatus === "withheld" || args.secretStatus === "inherited";
  if (spentOurs && args.callStatus === "error") return "error_call";
  // Asked after `error_call` and before the two charging reasons, exactly as
  // the SQL orders it — `record_api_usage_event` and this function are two
  // implementations of one rule and a difference in order is a difference in
  // answer.
  if (args.rateAbsorbed === true && spentOurs) return "absorbed";
  if (args.brokered === true) return "brokered";
  if (args.secretStatus === null) return "unknown_secret";
  if (args.secretStatus === "set") return "byok";
  // The clone was deliberately stripped of the forwarded key, which is
  // precisely the state in which the CALL travels instead of the credential.
  // Before the broker this fell through to `no_key` and was right; after it,
  // it is the one status that guarantees the prime paid.
  if (args.secretStatus === "withheld") return "brokered";
  if (args.secretStatus !== "inherited") return "no_key";
  return "inherited";
}

/**
 * Both routes charge, because both spend the prime's money on a tenant's
 * behalf. What differs is where the credential was, which is what the two
 * codes record.
 */
export function isBillable(reason: BillingReason): boolean {
  return reason === "inherited" || reason === "brokered";
}

/**
 * Reasons whose vendor COST is still recorded, charged or not.
 *
 * Four of the eight. `absorbed` is here and deliberately not in `isBillable`:
 * the money was really spent and the margin report must keep saying so, while
 * the tenant is charged for that work in tokens instead. `error_call` and
 * `not_billable` were already in this set for their own reasons — we paid for
 * a call that failed, and we pay for our own overhead.
 *
 * Mirrors the second `IF _reason IN(...)` in `record_api_usage_event`. Two
 * implementations of one rule; `api-usage-rating.test.ts` holds them together.
 */
export function recordsVendorCost(reason: BillingReason): boolean {
  return (
    reason === "inherited" ||
    reason === "brokered" ||
    reason === "absorbed" ||
    reason === "error_call" ||
    reason === "not_billable"
  );
}

// ─── Money ───────────────────────────────────────────────────────────────────
//
// Rates are carried in micros (1e-6 of a currency unit) because per-token
// prices sit far below a cent: AUD 0.0000006 per Gemini Flash input token
// rounds to zero cents and would meter as free forever. Micros become cents
// exactly once, on the settled total — never per line, or a thousand sub-cent
// calls would each round to nothing and bill as zero.

export const MICROS_PER_CENT = 10_000;

/** Round to the 6dp the `numeric(18,6)` columns hold, so TS and SQL agree. */
export function roundMicros(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function rateEvent(quantity: number, resaleMicrosPerUnit: number): number {
  const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  const rate =
    Number.isFinite(resaleMicrosPerUnit) && resaleMicrosPerUnit > 0 ? resaleMicrosPerUnit : 0;
  return roundMicros(qty * rate);
}

/** Half-up, matching the SQL `FLOOR(x / 10000 + 0.5)`. */
export function microsToCents(micros: number): number {
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.floor(micros / MICROS_PER_CENT + 0.5);
}

export function formatMicros(micros: number, currency = "AUD"): string {
  const amount = (Number.isFinite(micros) ? micros : 0) / (MICROS_PER_CENT * 100);
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    // Sub-cent totals are common on a young tenant; showing "$0.00" for real
    // spend reads as a broken meter, so keep four places until it matters.
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(amount) < 0.01 && amount !== 0 ? 4 : 2,
  }).format(amount);
}

// ─── Settlement ──────────────────────────────────────────────────────────────

export type RollupLine = {
  secret_name: string;
  provider: string;
  display_name?: string | null;
  unit: string;
  billable_quantity: number;
  byok_quantity: number;
  /** Free units this provider forgives per tenant per period. */
  included_free_units: number;
  resale_micros_per_unit: number;
};

export type SettledLine = {
  secret_name: string;
  provider: string;
  display_name: string;
  unit: string;
  billable_quantity: number;
  free_units_applied: number;
  charged_quantity: number;
  rate_micros_per_unit: number;
  amount_micros: number;
  byok_quantity: number;
};

/**
 * Apply each provider's free allowance and rate the remainder.
 *
 * The allowance is per tenant per period, which is why it is applied here and
 * not at ingest: forgiving it per event would forgive it once per call.
 *
 * A line with nothing billable is still kept when the tenant's own key covered
 * work, because that saving is the whole argument for bringing your own key and
 * it belongs on the statement.
 */
export function settleLines(lines: RollupLine[]): {
  lines: SettledLine[];
  totalMicros: number;
  totalCents: number;
} {
  const settled: SettledLine[] = [];
  let total = 0;

  for (const line of lines) {
    const billable = Math.max(line.billable_quantity ?? 0, 0);
    const free = Math.min(Math.max(line.included_free_units ?? 0, 0), billable);
    const charged = Math.max(billable - free, 0);
    const rate = Math.max(line.resale_micros_per_unit ?? 0, 0);
    const amount = roundMicros(charged * rate);
    const byok = Math.max(line.byok_quantity ?? 0, 0);

    total += amount;

    if (charged > 0 || byok > 0) {
      settled.push({
        secret_name: line.secret_name,
        provider: line.provider,
        display_name: line.display_name || line.secret_name,
        unit: line.unit,
        billable_quantity: billable,
        free_units_applied: free,
        charged_quantity: charged,
        rate_micros_per_unit: rate,
        amount_micros: amount,
        byok_quantity: byok,
      });
    }
  }

  const totalMicros = roundMicros(total);
  return { lines: settled, totalMicros, totalCents: microsToCents(totalMicros) };
}

// ─── Ingest validation ───────────────────────────────────────────────────────

export type ReportedEvent = {
  secret_name: string;
  quantity: number;
  idempotency_key: string;
  model?: string | null;
  feature?: string | null;
  status?: "success" | "error";
  occurred_at?: string | null;
  metadata?: Record<string, unknown>;
};

export type NormalizedEvent = ReportedEvent & {
  status: "success" | "error";
  occurred_at: string;
  metadata: Record<string, unknown>;
};

/** Secret names are env-var names; anything else is a caller bug, not usage. */
const SECRET_NAME_RX = /^[A-Z_][A-Z0-9_]*$/;

/** Wide enough for a month of one tenant's tokens, tight enough to catch a
 *  reporter that sends bytes where it meant tokens. */
export const MAX_QUANTITY = 1_000_000_000;

/** How far back a batch may backdate an event. Longer than any retry window,
 *  short enough that a clock-skewed clone cannot rewrite a settled period. */
export const MAX_BACKDATE_DAYS = 35;

export type NormalizeResult = { ok: true; event: NormalizedEvent } | { ok: false; error: string };

export function normalizeEvent(raw: unknown, now = new Date()): NormalizeResult {
  const e = raw as ReportedEvent;
  if (!e || typeof e !== "object") return { ok: false, error: "not_an_object" };

  const name = typeof e.secret_name === "string" ? e.secret_name.trim() : "";
  if (!name) return { ok: false, error: "missing_secret_name" };
  if (!SECRET_NAME_RX.test(name)) return { ok: false, error: `invalid_secret_name: ${name}` };

  const key = typeof e.idempotency_key === "string" ? e.idempotency_key.trim() : "";
  if (!key) return { ok: false, error: "missing_idempotency_key" };
  if (key.length > 200) return { ok: false, error: "idempotency_key_too_long" };

  const qty = e.quantity;
  if (typeof qty !== "number" || !Number.isFinite(qty)) {
    return { ok: false, error: `invalid_quantity: ${name}` };
  }
  if (qty < 0) return { ok: false, error: `negative_quantity: ${name}` };
  if (qty > MAX_QUANTITY) return { ok: false, error: `quantity_out_of_range: ${name}` };

  const status = e.status === "error" ? "error" : "success";

  let occurred = now;
  if (e.occurred_at) {
    const parsed = new Date(e.occurred_at);
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: `invalid_occurred_at: ${name}` };
    const ageDays = (now.getTime() - parsed.getTime()) / 86_400_000;
    if (ageDays > MAX_BACKDATE_DAYS) return { ok: false, error: `occurred_at_too_old: ${name}` };
    // A clone clock running fast must not book usage into a future period.
    occurred = parsed.getTime() > now.getTime() ? now : parsed;
  }

  return {
    ok: true,
    event: {
      secret_name: name,
      quantity: qty,
      idempotency_key: key,
      model: typeof e.model === "string" ? e.model.slice(0, 120) : null,
      feature: typeof e.feature === "string" ? e.feature.slice(0, 120) : null,
      status,
      occurred_at: occurred.toISOString(),
      metadata: stripReservedMetadata(e.metadata),
    },
  };
}

/**
 * Keys a REPORTER may not assert about its own usage.
 *
 * `brokered` is a billing decision, and the only party entitled to make it is
 * the one that made the vendor call — Mission Control's broker, which writes
 * the event directly rather than through this endpoint. Accepting it here
 * would let a clone rate its own traffic. That a clone could only ever use it
 * to charge ITSELF more is not the point: an input to the money rule must
 * come from the party that knows, or the rule is decorative.
 */
const RESERVED_METADATA_KEYS = ["brokered"] as const;

export function stripReservedMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of RESERVED_METADATA_KEYS) delete out[key];
  return out;
}
