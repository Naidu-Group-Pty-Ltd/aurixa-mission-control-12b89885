/**
 * Minting the activation payment for one gated workspace.
 *
 * ## Why this is a module and not the route it came from
 *
 * There are two callers and there must be one implementation. The clone's own
 * lock screen mints this through `POST /api/public/clones/gate/checkout`; an
 * operator mints the same thing from the Payment Gates page to send a customer
 * a link. Those are different authentications of the same act, and the act has
 * three decisions in it that are easy to get subtly wrong — which catalogue row
 * the gate's plan means, whether the money can open the gate at all, and where
 * Stripe returns the buyer.
 *
 * `docs/aml/PASSPORT_DISTRIBUTION.md` records what the second copy costs: two
 * send paths existed, one passed the one-time link as a `placeholder` rather
 * than a value, and the defect was fixed on one path and survived on the other.
 * This is the same shape with money attached.
 *
 * ## What it refuses, and why each refusal exists
 *
 * **`already_paid`** — minting a second subscription checkout for a workspace
 * that has one is how a customer pays twice, and a CTA is the easiest thing in
 * the product to click again.
 *
 * **`operator_locked`** — an operator's standing lock outranks the money.
 * `resolveGateState` reads the override BEFORE `paid_at`, deliberately, because
 * locking is how a workspace is suspended even though it once paid; and
 * `settleGatePayment` never clears it. So a session minted for one of these
 * would take the payment, stamp `paid_at`, resolve `operator_locked` exactly as
 * before, and leave the workspace the customer just bought still shut. It is
 * asked of the resolver rather than of `manual_override`, because one module
 * decides what locked means.
 *
 * **`plan_not_purchasable`** — the catalogue reuses rows through the tier
 * rename, so a row called `growth` exists on both sides of the cutover and is a
 * different tier in each. `seatPlanForTier` settles that the way the catalogue
 * sync does and then refuses any row whose price disagrees with what this gate
 * quoted, because inferring wrong means charging a customer more than twice
 * what they agreed to.
 *
 * Every refusal except `operator_locked` carries a pricing URL, so a customer
 * always has somewhere to pay. That one does not, on purpose: a link to buy
 * would invite a second subscription that opens nothing, and the remedy is a
 * person.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startCheckoutCore } from "@/server/checkout.server";
import { resolveCloneBillingTenant } from "@/server/billing-tenant.server";
import { normalizeBillingContact } from "@/server/billing-contact.server";
import { factsOf, logGateEvent, readGate } from "@/server/payment-gate.server";
import { resolveGateState } from "@/lib/clonePaymentGate.pure";
import { storefrontPricingBase } from "@/server/billing-handoffs.server";
import { seatPlanForTier } from "@/lib/pricing/seatPlanForTier.pure";

/** Who asked. Reaches the gate event and the purchase attribution, so a
 *  customer-started activation can be told from one an operator sent. */
export type GateCheckoutOrigin = "clone_cta" | "operator";

export type GateCheckoutContact = {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  phone?: string | null;
  company?: string | null;
} | null;

export type GateCheckoutResult =
  | { ok: true; url: string; sessionId: string | null }
  | {
      ok: false;
      /** The machine-readable refusal. */
      error: string;
      /** The HTTP status the public route answers with. Carried here so the
       *  route stays a mapping and the two callers cannot drift on it. */
      status: number;
      /** Extra detail for the log, never for the customer. */
      detail?: string;
      /** Somewhere the customer can always pay. Null only where sending them
       *  to a checkout would be the wrong thing. */
      pricingUrl: string | null;
    };

/**
 * https only, and no credentials in the URL. A return URL is handed to Stripe
 * and then to a browser, so it is an open-redirect surface.
 */
export function safeReturnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Where Stripe may send this buyer back to — the clone's own origin, or
 * nowhere.
 *
 * ## Why the protocol check was not enough
 *
 * The caller supplies this and the caller is a browser inside a gated
 * workspace. Accepting any https URL means any signed-in user of a gated clone
 * can have Mission Control mint a Stripe Checkout Session, branded Aurixa
 * Systems, whose success and cancel links land on an origin they chose — with
 * the real `{CHECKOUT_SESSION_ID}` on the query string. A payment page the
 * customer has every reason to trust is the worst possible host for an open
 * redirect.
 *
 * So the supplied URL is pinned to the clone's own `deploy_url`, which is the
 * platform's record of where that workspace actually lives. Anything else
 * falls back to `deploy_url` itself rather than being honoured.
 *
 * The stored value is put through the same `safeReturnUrl` as the caller's.
 * It was previously used raw — a `deploy_url` that is `http://` or malformed
 * produced a `success_url` Stripe rejects, which fails the mint rather than
 * the redirect, silently, at the moment a customer clicks pay. And when there
 * is nothing to pin against, the answer is null: the receipt page on the
 * pricing site is a worse landing than the workspace, and better than an
 * unverified one.
 */
export function returnUrlWithinClone(
  raw: string | null | undefined,
  deployUrl: string | null | undefined,
): string | null {
  const home = safeReturnUrl(deployUrl);
  const asked = safeReturnUrl(raw);
  if (!asked) return home;
  if (!home) return null;
  try {
    return new URL(asked).origin === new URL(home).origin ? asked : home;
  } catch {
    return home;
  }
}

/**
 * Add the activation parameters without letting a fragment swallow them.
 *
 * The URLs were built by appending `?`/`&` to whatever came back, and
 * `safeReturnUrl` round-trips a hash. `ActivateNowButton` passes
 * `window.location.href`, so any dashboard URL carrying one — an in-page
 * anchor, a deep link a user copied — produced
 * `https://clone/dashboard#section?activation=success&…`, where every
 * parameter lives inside the fragment and `URLSearchParams` on the other end
 * finds none of them. The customer lands on a screen that cannot tell they
 * just paid.
 *
 * `session_id` is appended raw on purpose: Stripe substitutes the literal
 * `{CHECKOUT_SESSION_ID}`, and `searchParams.set` would percent-encode the
 * braces into something it never replaces.
 */
function activationUrl(base: string, outcome: "success" | "cancelled"): string {
  const u = new URL(base);
  u.hash = "";
  u.searchParams.set("activation", outcome);
  const out = u.toString();
  return outcome === "success" ? `${out}&session_id={CHECKOUT_SESSION_ID}` : out;
}

export async function mintGateActivationCheckout(input: {
  cloneId: string;
  /** Where Stripe returns the buyer. Falls back to the clone's own deploy URL,
   *  then to the pricing site's receipt pages. */
  returnUrl?: string | null;
  contact?: GateCheckoutContact;
  origin: GateCheckoutOrigin;
  /** The operator who asked, when one did. Recorded on the gate event. */
  actorId?: string | null;
}): Promise<GateCheckoutResult> {
  const pricingBase = storefrontPricingBase();

  const read = await readGate(input.cloneId);
  if (!read.ok) {
    return { ok: false, error: "gate_read_failed", status: 503, pricingUrl: pricingBase };
  }
  if (!read.row) {
    return { ok: false, error: "not_gated", status: 404, pricingUrl: pricingBase };
  }
  if (read.row.paid_at) {
    return { ok: false, error: "already_paid", status: 409, pricingUrl: pricingBase };
  }

  // See the header. Deliberately the only refusal with no pricing URL.
  const gateState = resolveGateState(factsOf(read.row));
  if (gateState.reason === "operator_locked") {
    return { ok: false, error: "operator_locked", status: 409, pricingUrl: null };
  }

  if (!read.row.plan_slug) {
    return { ok: false, error: "no_plan_on_gate", status: 409, pricingUrl: pricingBase };
  }

  const { data: planRows, error: planError } = await supabaseAdmin
    .from("seat_plans")
    .select("id, slug, name, is_active, stripe_price_id, price_cents");
  if (planError) {
    return { ok: false, error: "plan_lookup_failed", status: 503, pricingUrl: pricingBase };
  }

  const match = seatPlanForTier(
    read.row.plan_slug,
    (planRows ?? []).filter((r) => r.is_active),
    read.row.amount_due_cents,
  );
  if (!match.ok) {
    console.error("[gate] no purchasable plan row for this gate", {
      clone_id: input.cloneId,
      plan_slug: read.row.plan_slug,
      reason: match.reason,
      quoted_cents: read.row.amount_due_cents,
      row_cents: match.reason === "price_mismatch" ? match.rowCents : undefined,
    });
    return {
      ok: false,
      error: "plan_not_purchasable",
      status: 409,
      detail: match.reason,
      pricingUrl: pricingBase,
    };
  }
  const plan = match.row;

  if (!plan.stripe_price_id) {
    return {
      ok: false,
      error: "plan_not_purchasable",
      status: 409,
      detail: "no_stripe_price",
      pricingUrl: pricingBase,
    };
  }

  const { data: clone } = await supabaseAdmin
    .from("clones")
    .select("id, name, slug, billing_user_id, deploy_url")
    .eq("id", input.cloneId)
    .maybeSingle();

  const tenant = await resolveCloneBillingTenant(input.cloneId, {
    billingUserId: clone?.billing_user_id ?? null,
    fallbackExternalRef: `clone:${clone?.slug ?? input.cloneId}`,
    fallbackDisplayName: clone?.name ?? null,
  });
  if (!tenant.ok) {
    return { ok: false, error: tenant.error, status: 500, pricingUrl: pricingBase };
  }

  // Success returns the buyer to their own workspace where possible: the gate
  // they were blocked by is the thing they want to see open. An operator-minted
  // link has no browser origin to offer, so it lands on the clone's own URL.
  const back = returnUrlWithinClone(input.returnUrl, clone?.deploy_url ?? null);
  const successUrl = back
    ? activationUrl(back, "success")
    : `${pricingBase}/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = back ? activationUrl(back, "cancelled") : `${pricingBase}/cancel`;

  try {
    const result = await startCheckoutCore({
      mode: "seat_plan",
      itemId: plan.id,
      quantity: 1,
      period: "monthly",
      cloneId: input.cloneId,
      tenantId: tenant.tenantId,
      successUrl,
      cancelUrl,
      contact: normalizeBillingContact(input.contact ?? null),
      attribution: {
        originUserId: clone?.billing_user_id ?? input.cloneId,
        originUsername: clone?.name ?? null,
        // Distinct from `storefront_uid`: this purchase started against a
        // gated workspace, and which side started it is worth counting.
        originSource:
          input.origin === "operator" ? "activation_gate_operator" : "activation_gate",
        handoffId: null,
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        error: "error" in result && typeof result.error === "string" ? result.error : "checkout_failed",
        status: 400,
        pricingUrl: pricingBase,
      };
    }

    await logGateEvent({
      gateId: read.row.id,
      cloneId: input.cloneId,
      kind: "checkout_started",
      statusBefore: gateState.status,
      statusAfter: gateState.status,
      reason:
        input.origin === "operator"
          ? "Activation payment link minted by an operator"
          : "Activation checkout started from the locked workspace",
      actor: input.origin === "operator" ? "operator" : "system",
      actorId: input.actorId ?? null,
      metadata: {
        session_id: result.sessionId,
        plan_slug: plan.slug,
        origin: input.origin,
      },
    });

    return { ok: true, url: result.url, sessionId: result.sessionId ?? null };
  } catch (err) {
    console.error("[gate] activation checkout failed", err);
    return { ok: false, error: "checkout_failed", status: 500, pricingUrl: pricingBase };
  }
}
