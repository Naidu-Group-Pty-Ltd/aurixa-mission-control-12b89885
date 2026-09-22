/**
 * Where a customer buys, and where a customer lands afterwards.
 *
 * Mission Control is an internal tool for the Aurixa team. A buyer who clicked
 * Buy on the Aurixa Systems pricing page must finish on that same website —
 * the thank-you page, the declined page and the card-saved page are all the
 * STOREFRONT'S. What travels back to Mission Control is the money and the
 * record: Stripe's `api/public/stripe/webhook` finalises every purchase
 * server-side, the receipt endpoints answer the storefront's polling, and the
 * operator notifications fire from here. None of that needs the customer to
 * see this application, and three routes used to send them into it anyway.
 *
 * The rule those three broke: **a customer-facing redirect is composed from
 * the storefront base and nothing else.** They each read
 * `PUBLIC_PRICING_SITE_URL` and fell back to Mission Control's own origin when
 * it was unset, so an unconfigured deployment served a page titled "Payment
 * received — Mission Control" to a paying customer, and the top-up CTA fell
 * back to `/billing/topup`, which is behind an OPERATOR sign-in — a buyer with
 * no Mission Control account could not even read it. `PUBLIC_PRICING_SITE_URL`
 * survives as an OVERRIDE (a staging storefront, a rebrand); it is no longer a
 * switch that decides whether the customer sees an internal tool.
 * `storefrontPricingBase()` in billing-handoffs.server.ts resolves it and
 * already answers the public URL when it is unset, which is what makes the
 * fallbacks removable rather than merely wrong.
 *
 * `storefrontReturnPaths.spec.ts` asserts no `api.public.*` route can name
 * `PUBLIC_APP_URL` or compose a Mission Control billing path again.
 */

/**
 * Customer-facing pricing page on the Aurixa Systems website. Mission Control
 * no longer serves a customer /pricing route — every user-centric purchase
 * surface lives on the storefront. PUBLIC_PRICING_SITE_URL overrides this
 * per deployment (server-side); this constant is the last-resort fallback and
 * the client-side link target. Mirrors AURIXA_PRICING_URL in the prime repo.
 */
export const DEFAULT_STOREFRONT_PRICING_URL = "https://www.aurixasystems.com.au/pricing";

/**
 * The storefront's own return pages, as the website routes them
 * (`/pricing/success`, `/pricing/cancel`, `/pricing/card-saved` in
 * aurixa-systems' App.tsx). A CLOSED set: a redirect may name one of these
 * three and nothing else, so a new destination is a decision made here rather
 * than a string typed into a route handler.
 */
export const STOREFRONT_RETURN_PAGES = {
  success: "success",
  cancel: "cancel",
  cardSaved: "card-saved",
} as const;

export type StorefrontReturnPage = keyof typeof STOREFRONT_RETURN_PAGES;

/**
 * The credential the purchase was scoped to, travelling back in the redirect
 * so the receipt endpoint can re-check it against the Stripe session before
 * returning any purchase data. Exactly one of the two, which the callers'
 * zod schemas already refine.
 */
export type PurchaseCredential =
  | { h: string; uid?: null | undefined }
  | { h?: null | undefined; uid: string };

/** One trailing-slash rule, so three composers cannot disagree about `//`. */
export function normaliseStorefrontBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * `h=<token>` or `uid=<billing_user_id>`. Throws rather than emitting
 * `uid=undefined`: every caller's schema guarantees one is present, and a
 * malformed credential in a Stripe redirect is a receipt nobody can read.
 */
export function purchaseCredentialQuery(cred: PurchaseCredential): string {
  if (cred.h) return `h=${encodeURIComponent(cred.h)}`;
  if (cred.uid) return `uid=${encodeURIComponent(cred.uid)}`;
  throw new Error("purchaseCredentialQuery: exactly one of h or uid is required");
}

/**
 * Where Stripe sends the buyer when a session finishes. `extraQuery` is
 * appended verbatim — `session_id={CHECKOUT_SESSION_ID}` is a placeholder
 * Stripe substitutes literally, so it must not be percent-encoded.
 */
export function storefrontReturnUrl(
  pricingBase: string,
  page: StorefrontReturnPage,
  cred: PurchaseCredential,
  extraQuery = "",
): string {
  const query = [purchaseCredentialQuery(cred), extraQuery].filter(Boolean).join("&");
  return `${normaliseStorefrontBase(pricingBase)}/${STOREFRONT_RETURN_PAGES[page]}?${query}`;
}

/**
 * Where a buyer goes to START a purchase: the storefront's pricing page,
 * carrying the credential that scopes it. This is what an out-of-tokens
 * banner or a top-up CTA links to.
 */
export function storefrontPurchaseUrl(pricingBase: string, cred: PurchaseCredential): string {
  return `${normaliseStorefrontBase(pricingBase)}?${purchaseCredentialQuery(cred)}`;
}

/**
 * The top-up CTA a command centre is handed when no handoff was minted.
 *
 * Three readings, and the third is why this is a named function rather than a
 * ternary in a route. A tenant with an operator-assigned `billing_user_id`
 * gets a scoped purchase link. A tenant with NONE gets the pricing page with
 * **no credential at all** — the page renders every price and withholds only
 * the Buy button (`canBuy = !!credential` on the storefront).
 *
 * It must not be null there, and that is the whole point: the prime's own
 * fallback is `topupUrl || AURIXA_PRICING_URL`, and `AURIXA_PRICING_URL`
 * carries `?uid=${VITE_AURIXA_BILLING_UID}` defaulting to **`npc-prime`** —
 * a variable Mission Control publishes to no clone. So handing back null
 * would send a clone's customer to a purchase scoped to the PRIME'S tenant:
 * a charge credited to the wrong account, which is worse than the
 * operator-login dead end this replaced. Browse-only is the honest reading
 * when there is no credential to scope a purchase with.
 */
export function topupLinkFor(pricingBase: string, billingUserId: string | null): string {
  return billingUserId
    ? storefrontPurchaseUrl(pricingBase, { uid: billingUserId })
    : normaliseStorefrontBase(pricingBase);
}
