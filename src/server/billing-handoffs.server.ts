// Billing handoff minting (user-attributed pricing workflow, Phase 2;
// see docs/user-tracking-pricing-workflow-plan.md §4 Phase 2).
//
// A handoff is a short-lived, single-use token that carries the identity of
// the command-center user who initiated a purchase. It is minted strictly
// server-to-server under a clone API key; the browser only ever sees the
// opaque `?h=<uuid>` — never the identity fields themselves.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DEFAULT_STOREFRONT_PRICING_URL,
  normaliseStorefrontBase,
  storefrontPurchaseUrl,
} from "@/lib/storefront";
import type { BillingContact } from "@/server/billing-contact.server";

const adminAny = supabaseAdmin;

export const HANDOFF_TTL_MINUTES = 30;

export type CreateHandoffInput = {
  cloneId: string | null;
  tenantId: string | null;
  originUserId: string;
  originUsername?: string | null;
  originSource: string;
  intent?: string | null;
  returnUrl?: string | null;
  /** Buyer contact details, forwarded to Stripe at checkout so the payment
   *  page arrives prefilled. Travels server-to-server only — the browser
   *  carries nothing but the opaque handoff id. */
  contact?: BillingContact | null;
};

/** Parses the mode prefix out of an intent string ('<mode>' or '<mode>:<item_id>'). */
export function intentMode(intent: string | null | undefined): string | null {
  if (!intent) return null;
  const mode = intent.split(":")[0]?.trim();
  return mode || null;
}

/** Parses the item id out of an intent string ('<mode>:<item_id>'), if any. */
export function intentItemId(intent: string | null | undefined): string | null {
  if (!intent) return null;
  const item = intent.split(":")[1]?.trim();
  return item || null;
}

/**
 * Whether a handoff's intent permits checking out a given mode/item.
 * Enforced server-side by the handoff-scoped checkout.
 *
 * A bare mode intent ('topup', 'seat_plan', …) is ADVISORY: it records which
 * CTA launched the visit, but the buyer lands on the full pricing page where
 * every plan/pack/package is purchasable — a "Top up credits" entry must not
 * reject the buyer for choosing a plan instead (handoff_intent_mismatch).
 * Only an exact '<mode>:<item>' pin — the auto-launch deep-link case —
 * restricts checkout, and then to precisely that item.
 */
export function intentAllows(
  intent: string | null | undefined,
  mode: string,
  itemId: string,
): boolean {
  const item = intentItemId(intent);
  if (!item) return true;
  return intentMode(intent) === mode && item === itemId;
}

/**
 * Base URL of the CUSTOMER-FACING pricing page. All user-centric monetisation
 * (tokens, plans, seats — prime repo and every clone) flows through the
 * Aurixa Systems website's pricing page, configured via
 * PUBLIC_PRICING_SITE_URL (e.g. https://aurixasystems.com/pricing).
 * Mission Control has no customer /pricing route, so when the env var is
 * unset the links fall back to the storefront's default domain.
 */
export function storefrontPricingBase(): string {
  const site = process.env.PUBLIC_PRICING_SITE_URL;
  if (site && /^https?:\/\//.test(site)) return normaliseStorefrontBase(site);
  return DEFAULT_STOREFRONT_PRICING_URL;
}

/**
 * Attributed deep link into the pricing page: `<pricingBase>?h=<token>`.
 * One implementation with the unattributed `?uid=` form it sits beside —
 * they are the same act (send a buyer to the storefront to purchase) and two
 * copies is how they come to disagree about a trailing slash.
 */
export function handoffUrl(pricingBase: string, handoffId: string): string {
  return storefrontPurchaseUrl(pricingBase, { h: handoffId });
}

/**
 * Open-redirect guard for the "back to your dashboard" URL. Must be https;
 * when the clone has a deploy_url with a resolvable host, the return URL must
 * point at that same host.
 */
export function validateReturnUrl(
  returnUrl: string | null | undefined,
  cloneDeployUrl: string | null | undefined,
): { ok: true; url: string | null; error?: undefined } | { ok: false; error: string } {
  if (!returnUrl) return { ok: true, url: null };
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    return { ok: false, error: "return_url_invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "return_url_not_https" };

  if (cloneDeployUrl) {
    try {
      const deployHost = new URL(cloneDeployUrl).host;
      if (deployHost && parsed.host !== deployHost) {
        return { ok: false, error: "return_url_host_mismatch" };
      }
    } catch {
      // Unparseable deploy_url on the clone record — fall through to accept
      // any https URL rather than blocking purchases on bad clone config.
    }
  }
  return { ok: true, url: parsed.toString() };
}

export type HandoffRow = {
  id: string;
  clone_id: string | null;
  tenant_id: string | null;
  origin_user_id: string;
  origin_username: string | null;
  origin_source: string;
  intent: string | null;
  return_url: string | null;
  expires_at: string;
  consumed_at: string | null;
  contact_email: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_phone: string | null;
  contact_company: string | null;
  contact_tax_id: string | null;
  contact_tax_id_type: string | null;
};

/**
 * Loads a handoff row with NO validity checks (expired/consumed rows
 * included). Only for callers that have already proven a right to it — e.g.
 * the success page after matching a checkout session's handoff_id — never as
 * a checkout credential; that's loadValidHandoff in purchases.server.
 */
export async function loadHandoffById(handoffId: string): Promise<HandoffRow | null> {
  const { data, error } = await adminAny
    .from("billing_handoffs")
    .select(
      "id, clone_id, tenant_id, origin_user_id, origin_username, origin_source, intent, return_url, expires_at, consumed_at, contact_email, contact_first_name, contact_last_name, contact_phone, contact_company, contact_tax_id, contact_tax_id_type",
    )
    .eq("id", handoffId)
    .maybeSingle();
  if (error || !data) return null;
  return data as HandoffRow;
}

export async function createHandoff(
  input: CreateHandoffInput,
): Promise<
  { ok: true; id: string; expiresAt: string; error?: undefined } | { ok: false; error: string }
> {
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await adminAny
    .from("billing_handoffs")
    .insert({
      clone_id: input.cloneId,
      tenant_id: input.tenantId,
      origin_user_id: input.originUserId,
      origin_username: input.originUsername ?? null,
      origin_source: input.originSource,
      intent: input.intent ?? null,
      return_url: input.returnUrl ?? null,
      contact_email: input.contact?.email ?? null,
      contact_first_name: input.contact?.firstName ?? null,
      contact_last_name: input.contact?.lastName ?? null,
      contact_phone: input.contact?.phone ?? null,
      contact_company: input.contact?.company ?? null,
      contact_tax_id: input.contact?.taxIdValue ?? null,
      contact_tax_id_type: input.contact?.taxIdType ?? null,
      expires_at: expiresAt,
    })
    .select("id, expires_at")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "handoff_insert_failed" };
  }
  return { ok: true, id: data.id as string, expiresAt: (data.expires_at as string) ?? expiresAt };
}
