/**
 * The Builder / Developer Portal subscription, and the payment link a signed
 * Builder Partner Agreement sends.
 *
 * The Builder & Developer Portal & Marketplace Agreement has two kinds of fee
 * and this module is about one of them. The monthly Portal subscription is
 * charged here, through a Stripe Payment Link, from the moment the agreement is
 * signed. The Transaction Fees (the New Build Fee and the Development Sale Fee
 * on the agreement's "Your transaction-fee arrangement" page) are separate from
 * it and are NOT charged by this link: each is earned only on its qualifying
 * event and invoiced after it, which no link opened at signing can know. The
 * email says so in words, and so does the Stripe page.
 *
 * ## Why a pinned link rather than a Checkout Session per builder
 *
 * The product, the price and the link were created once, in the Stripe account
 * Mission Control's own key and webhook belong to, and are pinned below. A
 * link is one reviewable object with one price: it cannot quote a builder a
 * figure nobody approved, and the catalog price it charges is asserted equal
 * to `aurixa-catalog.ts`'s by a test, so the two cannot drift apart silently.
 * The module is `directSale` in the catalog precisely so it never appears in
 * self-serve checkout or the add-on sync; this link is that direct sale.
 *
 * Each email carries the builder's own copy of the link, with
 * `client_reference_id` naming the agreement, so the webhook that hears about
 * the payment knows whose it was without guessing from an email address.
 *
 * ## Four rules
 *
 *  - **Evidence before action.** The link goes only once the signed agreement
 *    has been retained, the same condition every other act on a signature
 *    waits for.
 *  - **An unconfirmed send is never repeated automatically.** Graph can take a
 *    message and fail on the way back; an automatic resend then mails a
 *    builder the same demand for money twice. `unconfirmed` waits for a person.
 *  - **Nothing here charges a Transaction Fee.** A link opened at signing
 *    cannot know a qualifying event has happened.
 *  - **A negotiated fee is never sent the link.** The link has one price. A
 *    builder on another monthly figure is switched off it on the agreement
 *    page and invoiced in Stripe, and no path sends them the link.
 */
import { gstComponentCents, moduleBySlug } from "@/lib/pricing/aurixa-catalog";
import { escapeHtml } from "@/lib/email/mergeTemplate.pure";
import { isValidEmail } from "@/lib/email/emailAddress.pure";

/** The Stripe objects, created once and pinned. Live mode, AUD, GST inclusive. */
export const BUILDER_PORTAL_PAYMENT = {
  stripeAccountId: "acct_1TbJPK3tNhf9apmH",
  livemode: true,
  productId: "prod_VLz85NtQ6m8lgb",
  priceId: "price_1ULHAu3tNhf9apmH3iSluzRZ",
  paymentLinkId: "plink_1ULHBH3tNhf9apmHbuT6AyZY",
  url: "https://buy.stripe.com/00w00c5Ee22G1dZd8w0co1o",
  currency: "aud",
  moduleSlug: "builder-developer-portal",
  /** The Stripe price's `unit_amount`, tax inclusive. Asserted equal to the catalog's. */
  monthlyInclGstCents: 69900,
} as const;

/** The metadata `purpose` the link and its subscriptions carry. */
export const BUILDER_PORTAL_PAYMENT_PURPOSE = "builder_portal_subscription";

/** `client_reference_id` is `bpa_<agreement uuid>`. */
export const PAYMENT_REFERENCE_PREFIX = "bpa_";

/** How the link's delivery stands on the agreement row. */
export const PAYMENT_LINK_STATUSES = ["sending", "sent", "failed", "unconfirmed", "held"] as const;
export type PaymentLinkStatus = (typeof PAYMENT_LINK_STATUSES)[number];

/** Stripe's own subscription status words, recorded verbatim. */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;
export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

/** A subscription in any of these is one the builder still has; a second link is not owed. */
const LIVE_SUBSCRIPTION = new Set<string>([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
]);

/**
 * A subscription in one of these has ended and cannot be revived: Stripe never
 * moves a `canceled` or `incomplete_expired` subscription anywhere else. A
 * builder who pays again after one is starting a new subscription, not paying
 * twice.
 */
const ENDED_SUBSCRIPTION = new Set<string>(["canceled", "incomplete_expired"]);

/** A subscription arriving in one of these needs a person to look at the builder. */
const ATTENTION_SUBSCRIPTION = new Set<string>([
  "past_due",
  "unpaid",
  "canceled",
  "incomplete_expired",
]);

/** The agreement page's switch, named once so the page and the refusal say the same words. */
export const BILL_THROUGH_LINK_LABEL = "Bill through the payment link";

/** Automatic sends a failed link gets before it waits for a person. */
export const MAX_PAYMENT_LINK_ATTEMPTS = 5;

/**
 * A `sending` claim older than this belonged to an invocation that died.
 * Whether its message left is unknowable, so it becomes `unconfirmed` — never
 * a retry.
 */
export const STALE_PAYMENT_LINK_CLAIM_MS = 15 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ───────────────────────────── the price ───────────────────────────── */

export function formatAud(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export type PortalPrice = {
  monthlyInclGstCents: number;
  gstCents: number;
  exGstCents: number;
  /** "$699.00 a month including GST ($63.55 GST)". */
  sentence: string;
};

export function portalPrice(): PortalPrice {
  const incl = BUILDER_PORTAL_PAYMENT.monthlyInclGstCents;
  const gst = gstComponentCents(incl);
  return {
    monthlyInclGstCents: incl,
    gstCents: gst,
    exGstCents: incl - gst,
    sentence: `${formatAud(incl)} a month including GST (${formatAud(gst)} GST)`,
  };
}

/** The catalog's own figure for the module, for the test that keeps the two equal. */
export function catalogPortalPriceCents(): number | null {
  return moduleBySlug(BUILDER_PORTAL_PAYMENT.moduleSlug)?.monthlyInclGstCents ?? null;
}

/* ───────────────────────────── the builder's own link ───────────────────────────── */

export function paymentReferenceFor(agreementId: string): string {
  if (!UUID.test(agreementId)) throw new Error("agreement id is not a uuid");
  return `${PAYMENT_REFERENCE_PREFIX}${agreementId.toLowerCase()}`;
}

/** The agreement a `client_reference_id` names, or null for anything else. */
export function agreementIdFromReference(reference: string | null | undefined): string | null {
  if (!reference || !reference.startsWith(PAYMENT_REFERENCE_PREFIX)) return null;
  const id = reference.slice(PAYMENT_REFERENCE_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/**
 * The link as one builder receives it: their agreement as the reference, and
 * their address prefilled so the receipt and the subscription reach the person
 * who signed.
 */
export function builderPortalPaymentUrl(input: {
  agreementId: string;
  email?: string | null;
}): string {
  const url = new URL(BUILDER_PORTAL_PAYMENT.url);
  url.searchParams.set("client_reference_id", paymentReferenceFor(input.agreementId));
  const email = input.email?.trim();
  if (email && isValidEmail(email)) url.searchParams.set("prefilled_email", email);
  return url.toString();
}

/* ───────────────────────────── recognising Stripe's answers ───────────────────────────── */

type Ref = string | { id?: string | null } | null | undefined;

function idOf(ref: Ref): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : (ref.id ?? null);
}

/**
 * A Checkout Session opened from the Builder Portal link. The link id is the
 * authority; the purpose metadata is a second witness Stripe copies from the
 * link onto its sessions.
 */
export function isBuilderPortalSession(session: {
  payment_link?: Ref;
  metadata?: Record<string, string> | null;
}): boolean {
  if (idOf(session.payment_link) === BUILDER_PORTAL_PAYMENT.paymentLinkId) return true;
  return session.metadata?.purpose === BUILDER_PORTAL_PAYMENT_PURPOSE;
}

/**
 * A subscription the link created: its purpose metadata (the link's
 * `subscription_data`), or failing that the Portal price on one of its items.
 */
export function isBuilderPortalSubscription(sub: {
  metadata?: Record<string, string> | null;
  items?: { data?: Array<{ price?: Ref }> } | null;
}): boolean {
  if (sub.metadata?.purpose === BUILDER_PORTAL_PAYMENT_PURPOSE) return true;
  return (sub.items?.data ?? []).some(
    (item) => idOf(item.price) === BUILDER_PORTAL_PAYMENT.priceId,
  );
}

export function isStripeSubscriptionStatus(value: string): value is StripeSubscriptionStatus {
  return (STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

export function subscriptionIsLive(status: string | null | undefined): boolean {
  return Boolean(status && LIVE_SUBSCRIPTION.has(status));
}

export function subscriptionHasEnded(status: string | null | undefined): boolean {
  return Boolean(status && ENDED_SUBSCRIPTION.has(status));
}

/** Whether a change to this status is one an operator should hear about. */
export function subscriptionNeedsAttention(
  previous: string | null | undefined,
  next: string,
): boolean {
  return ATTENTION_SUBSCRIPTION.has(next) && previous !== next;
}

/* ───────────────────────────── recording a subscription ───────────────────────────── */

export type SubscriptionRecordDecision =
  | { action: "record"; first: boolean }
  | { action: "replace"; previous: string }
  | { action: "duplicate"; existing: string };

/**
 * One agreement, one current Portal subscription.
 *
 *  - None recorded: this one is the first.
 *  - The same one again: Stripe is repeating itself; record its latest state.
 *  - The recorded one has ENDED (`canceled`, `incomplete_expired`): this one
 *    replaces it. The builder cancelled or never finished paying, and was sent
 *    the link again; refusing the new subscription would leave a builder who is
 *    paying recorded as a builder who is not, and would let the sweep and the
 *    button mail them the link a third time.
 *  - The recorded one is still live: this is a second subscription for the
 *    same agreement (the builder paid twice, or somebody reused their link). It
 *    is never written over the first; it is reported so a person can refund or
 *    cancel.
 *
 * A recorded subscription whose status is unknown counts as live: refusing a
 * replacement costs a person one look, while overwriting a live subscription
 * loses track of money being taken.
 */
export function decideSubscriptionRecord(
  existing: string | null | undefined,
  existingStatus: string | null | undefined,
  incoming: string,
): SubscriptionRecordDecision {
  if (!existing) return { action: "record", first: true };
  if (existing === incoming) return { action: "record", first: false };
  if (subscriptionHasEnded(existingStatus)) return { action: "replace", previous: existing };
  return { action: "duplicate", existing };
}

/* ───────────────────────────── whether to send ───────────────────────────── */

export type PaymentLinkRow = {
  status: string;
  signed_record_path: string | null;
  client_email: string | null;
  /**
   * Whether this builder is billed through the link at all. Off for a builder
   * on a negotiated monthly fee the link's one price cannot charge; that
   * builder is invoiced in Stripe and is never sent the link. Absent reads as
   * on, which is the column's default.
   */
  portal_payment_link_enabled?: boolean | null;
  portal_payment_link_status: string | null;
  portal_payment_link_attempts: number | null;
  portal_payment_link_attempted_at: string | null;
  portal_subscription_status: string | null;
};

export type PaymentLinkTrigger = "signature" | "sweep" | "manual";

export type PaymentLinkSkipReason =
  | "not_signed"
  | "not_retained"
  | "no_address"
  | "already_subscribed"
  | "billed_separately"
  | "in_flight"
  | "already_sent"
  | "unconfirmed"
  | "held"
  | "gave_up";

export type PaymentLinkDecision =
  | { action: "send" }
  | { action: "abandon_stale" }
  | { action: "skip"; reason: PaymentLinkSkipReason; detail: string };

/**
 * Whether this invocation may email the link. Every automatic path asks this
 * and so does the admin's button; only `manual` may send a link again after
 * one went, nothing may send while another send is in flight, and nothing at
 * all sends to a builder the agreement says is billed separately.
 */
export function decidePaymentLinkDispatch(
  row: PaymentLinkRow,
  nowMs: number,
  opts: { trigger: PaymentLinkTrigger },
): PaymentLinkDecision {
  const skip = (reason: PaymentLinkSkipReason, detail: string): PaymentLinkDecision => ({
    action: "skip",
    reason,
    detail,
  });
  if (row.status !== "signed") {
    return skip(
      "not_signed",
      "The agreement is not signed; the payment link follows the signature.",
    );
  }
  if (!row.signed_record_path) {
    return skip(
      "not_retained",
      "The signed agreement has not been copied out of DocuSign yet; the payment link waits for it.",
    );
  }
  if (!row.client_email || !isValidEmail(row.client_email.trim())) {
    return skip("no_address", "The agreement records no usable email address for the signatory.");
  }
  if (subscriptionIsLive(row.portal_subscription_status)) {
    return skip(
      "already_subscribed",
      `The builder already has a Portal subscription (${row.portal_subscription_status}).`,
    );
  }

  const status = row.portal_payment_link_status;
  if (status === "sending") {
    const at = row.portal_payment_link_attempted_at
      ? Date.parse(row.portal_payment_link_attempted_at)
      : Number.NaN;
    if (Number.isFinite(at) && nowMs - at < STALE_PAYMENT_LINK_CLAIM_MS) {
      return skip("in_flight", "The payment link is being sent.");
    }
    return { action: "abandon_stale" };
  }
  // Checked after a stale claim is settled, so an abandoned send still becomes
  // `unconfirmed`, and before `manual`: the button cannot send a link the
  // agreement says this builder is not billed through.
  if (row.portal_payment_link_enabled === false) {
    return skip(
      "billed_separately",
      `This builder is not billed through the payment link (a negotiated monthly fee, invoiced in Stripe). Switch "${BILL_THROUGH_LINK_LABEL}" back on to send it.`,
    );
  }
  if (opts.trigger === "manual") return { action: "send" };

  if (status === null) return { action: "send" };
  if (status === "failed") {
    return (row.portal_payment_link_attempts ?? 0) < MAX_PAYMENT_LINK_ATTEMPTS
      ? { action: "send" }
      : skip(
          "gave_up",
          `The payment link failed ${row.portal_payment_link_attempts} times; it is sent again only from the agreement page.`,
        );
  }
  if (status === "sent") return skip("already_sent", "The payment link was sent.");
  if (status === "held") {
    return skip(
      "held",
      "This agreement was signed before payment links were sent automatically; send it from the agreement page if it is owed.",
    );
  }
  return skip(
    "unconfirmed",
    "Microsoft did not confirm the last send, so it may have arrived. It is never sent again automatically; check the mailbox's Sent Items and send it from the agreement page if it did not go.",
  );
}

/* ───────────────────────────── the email ───────────────────────────── */

export type PaymentLinkEmail = { subject: string; html: string; text: string };

/**
 * The message that carries the link. It names what is being paid for, the
 * amount with its GST, and — because this is where a builder would otherwise
 * assume it — that the Transaction Fees are separate and are not charged here.
 * It cites no clause numbers: the terms in force can be re-issued with a
 * different numbering, and an email that cites the wrong clause is worse than
 * one that cites none.
 */
export function composePaymentLinkEmail(input: {
  agreementId: string;
  reference: string | null;
  recipientName: string | null;
  recipientEmail: string;
  organisation: string | null;
}): PaymentLinkEmail {
  const price = portalPrice();
  const url = builderPortalPaymentUrl({
    agreementId: input.agreementId,
    email: input.recipientEmail,
  });
  const greetingName = input.recipientName?.trim().split(/\s+/)[0] || "there";
  const agreementLabel = input.reference
    ? `Builder & Developer Portal & Marketplace Agreement (${input.reference})`
    : "Builder & Developer Portal & Marketplace Agreement";
  const forOrganisation = input.organisation?.trim() ? ` for ${input.organisation.trim()}` : "";
  const subject = `Set up your Builder / Developer Portal subscription${input.reference ? ` — ${input.reference}` : ""}`;

  const paragraphs = [
    `Hi ${greetingName},`,
    `Thank you for signing the ${agreementLabel}${forOrganisation}. DocuSign has sent you a copy of the signed agreement.`,
    `The next step is your monthly Builder / Developer Portal subscription: ${price.sentence}, billed through Stripe from the day you set it up.`,
  ];
  const separate =
    "New Build Fees and Development Sale Fees are separate from this subscription and are not charged through this link. " +
    "Each is earned only when its qualifying event happens and is invoiced after it, as your agreement sets out.";
  const closing =
    "If anything here does not match your agreement, reply to this email before you pay and we will sort it out.";

  const text = [
    ...paragraphs,
    `Set up your subscription: ${url}`,
    separate,
    closing,
    "Aurixa Systems",
  ].join("\n\n");

  const p = (s: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1f2933">${escapeHtml(s)}</p>`;
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">',
    ...paragraphs.map(p),
    `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:15px">Set up your subscription</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#52606d">If the button does not work, open this address: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
    p(separate),
    p(closing),
    p("Aurixa Systems"),
    "</div>",
  ].join("");

  return { subject, html, text };
}
