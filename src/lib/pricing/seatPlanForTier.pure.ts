/**
 * Which `seat_plans` row is a catalogue tier?
 *
 * ## Slugs alone are ambiguous, and getting it wrong charges the wrong price
 *
 * The catalogue reuses existing rows rather than minting new ones, so Stripe
 * products and subscription history stay attached to something:
 * `professional` becomes **Growth**, and `growth` becomes **Scale**
 * (`aurixa-catalog.ts`, `replacesSlug`).
 *
 * That means a row called `growth` exists both before and after the cutover
 * and means DIFFERENT tiers in each — the Scale row at $2,015 beforehand, the
 * Growth row at $860 afterwards. A naive `WHERE slug = tier.slug` therefore
 * quotes a customer $860 and charges them $2,015, which is the specific harm
 * this module exists to prevent.
 *
 * `stripe-catalog-sync.server.ts` reasons the same way for the RENAME path and
 * says so in its own comment; this is the read-only half, for a caller that
 * needs the row a tier is served by right now. `seatPlanForTier.pure.test.ts`
 * runs both against the pre-cutover and post-cutover catalogues.
 */
import { TIERS, type Tier } from "./aurixa-catalog";

export type SeatPlanLike = {
  slug: string;
  price_cents?: number | null;
};

/**
 * The rule, stated once:
 *
 * A tier whose replaced row is GONE while its own slug is PRESENT has already
 * been renamed, so it settles on its own slug and no other tier may claim it.
 * Every remaining tier then takes the row it replaces, if that row is still
 * free, and otherwise its own.
 */
export function seatPlanSlugForTier(
  tierSlug: string,
  rows: readonly SeatPlanLike[],
): string | null {
  const present = new Set(rows.map((r) => r.slug));

  const settled = new Set<string>();
  for (const t of TIERS) {
    const replaces = t.replacesSlug ?? t.slug;
    if (replaces !== t.slug && !present.has(replaces) && present.has(t.slug)) {
      settled.add(t.slug);
    }
  }

  const tier: Tier | undefined = TIERS.find((t) => t.slug === tierSlug);
  if (!tier) {
    // Not a catalogue tier at all — a legacy or hand-written plan slug. Its own
    // row, if it has one, is the only honest answer.
    return present.has(tierSlug) ? tierSlug : null;
  }

  const replaces = tier.replacesSlug ?? tier.slug;
  if (present.has(replaces) && !settled.has(replaces)) return replaces;
  if (present.has(tier.slug)) return tier.slug;
  return null;
}

export type SeatPlanMatch<R extends SeatPlanLike> =
  | { ok: true; row: R }
  | { ok: false; reason: "no_row" | "price_mismatch"; row?: R; rowCents?: number | null };

/**
 * Resolve the row AND check it costs what the customer was quoted.
 *
 * The price assertion is not belt-and-braces, it is the actual guarantee: the
 * settling rule above is inference about a cutover this process cannot observe
 * directly, and the cost of inferring wrong is a customer charged more than
 * twice what they agreed to. A row whose price disagrees with the quote is
 * refused, and the caller sends the buyer to the pricing page — where a person
 * chooses, and sees the number before paying it.
 *
 * `quotedCents` null means nothing was quoted, so there is nothing to check.
 */
export function seatPlanForTier<R extends SeatPlanLike>(
  tierSlug: string,
  rows: readonly R[],
  quotedCents: number | null | undefined,
): SeatPlanMatch<R> {
  const slug = seatPlanSlugForTier(tierSlug, rows);
  if (!slug) return { ok: false, reason: "no_row" };
  const row = rows.find((r) => r.slug === slug);
  if (!row) return { ok: false, reason: "no_row" };

  if (quotedCents !== null && quotedCents !== undefined && Number.isFinite(quotedCents)) {
    const rowCents = row.price_cents;
    if (typeof rowCents === "number" && rowCents !== quotedCents) {
      return { ok: false, reason: "price_mismatch", row, rowCents };
    }
  }
  return { ok: true, row };
}
