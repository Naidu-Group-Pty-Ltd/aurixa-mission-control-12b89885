/**
 * Whether a clone is a demo, the one kind of clone whose sign-in an operator
 * may change from Mission Control.
 *
 * Two levers change how a clone is signed in to: the CAPTCHA test pair
 * (`cloneTurnstileIdentity.pure.ts`), which turns the security check off so
 * an automated recorder can sign in, and the account reset
 * (`cloneAccountReset.pure.ts`), which sets a staff account's password and
 * can clear its authenticator. Both are for the tutorial programme's demo
 * and never for a workspace somebody signs in to for real, so both ask this.
 * It is stated once, here, because two copies of who counts as a customer
 * would drift, and the one that drifted would be the one that let a lever
 * reach a customer.
 *
 * A customer is read from what Mission Control records about money and
 * entitlement: a Stripe customer, or a plan the clone is entitled to. The
 * clone must also be tagged `demo` by its operator, so a clone with neither
 * (a new one, or an internal one) is not a demo by default. Measured 30 Oct
 * 2026: every clone but the tutorial demo is entitled to a plan, and the
 * demo is tagged `demo`. The prime is refused separately, where every
 * clone-scoped write is refused, by `resolveCloneSecretTarget`.
 */
export type DemoCloneRefusal =
  | { readonly reason: "stripe_customer" }
  | { readonly reason: "entitled_plan"; readonly plan: string }
  | { readonly reason: "not_tagged_demo" };

export function demoCloneRefusal(clone: {
  billing_stripe_customer_id: string | null;
  entitled_plan_slug: string | null;
  tags: readonly string[] | null;
}): DemoCloneRefusal | null {
  if (clone.billing_stripe_customer_id) return { reason: "stripe_customer" };
  if (clone.entitled_plan_slug) return { reason: "entitled_plan", plan: clone.entitled_plan_slug };
  if (!(clone.tags ?? []).includes("demo")) return { reason: "not_tagged_demo" };
  return null;
}
