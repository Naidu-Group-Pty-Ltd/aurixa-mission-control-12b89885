/**
 * The Builder / Developer Portal subscription: the payment link a signed
 * Builder Partner Agreement sends, and what Stripe reports back about it.
 *
 * Three callers send the link and they share one path, `sendBuilderPortalPaymentLink`:
 *
 *  - the SIGNATURE — `completeSignedBuilderPartnerAgreement`, which DocuSign's
 *    status fold calls once the signed copy is retained;
 *  - the SWEEP — the agreements refresh, for a signature whose send could not
 *    run (the record was not retained yet, Graph was down, a claim went stale);
 *  - an ADMIN, from the agreement page, to send it again.
 *
 * The send is claimed on the row before anything leaves, the same pattern as
 * the Subscription Agreement's send and the portal grant, so a signature and
 * a sweep arriving together cannot mail a builder twice. What Graph answered
 * is recorded on the row and said to the people who need it.
 *
 * The other half is the webhook: `api.public.stripe.webhook.ts` hands this
 * module every Checkout Session the link opens and every subscription it
 * creates, BEFORE the clone fulfilment path sees them — a link session carries
 * none of the metadata that path needs, and would otherwise be written up as a
 * failed purchase.
 *
 * Every rule is decided in `src/lib/agreements/builderPortalPayment.pure.ts`.
 */
import type Stripe from "stripe";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { BUILDER_PARTNER_KIND, isSchemaAbsent } from "@/lib/agreements/builderPartner.pure";
import {
  agreementIdFromReference,
  BUILDER_PORTAL_PAYMENT,
  builderPortalPaymentUrl,
  composePaymentLinkEmail,
  decidePaymentLinkDispatch,
  decideSubscriptionRecord,
  isStripeSubscriptionStatus,
  MAX_PAYMENT_LINK_ATTEMPTS,
  portalPrice,
  STALE_PAYMENT_LINK_CLAIM_MS,
  subscriptionNeedsAttention,
  type PaymentLinkSkipReason,
  type PaymentLinkStatus,
  type PaymentLinkTrigger,
} from "@/lib/agreements/builderPortalPayment.pure";
import { isValidEmail } from "@/lib/email/emailAddress.pure";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { defaultMailbox, isGraphConfigured, sendMail } from "@/server/graph-client";
import { getStripe } from "@/server/stripe.server";

const PAYMENT_SELECT =
  "id, document_kind, status, offer_reference, client_name, client_email, client_org, signed_record_path, portal_payment_link_status, portal_payment_link_attempts, portal_payment_link_attempted_at, portal_payment_link_sent_at, portal_payment_link_sent_to, portal_payment_link_detail, portal_subscription_id, portal_subscription_status, portal_subscription_customer_id, portal_checkout_session_id, portal_subscription_started_at, portal_subscription_updated_at";

type PaymentRow = {
  id: string;
  document_kind: string;
  status: string;
  offer_reference: string | null;
  client_name: string;
  client_email: string;
  client_org: string | null;
  signed_record_path: string | null;
  portal_payment_link_status: string | null;
  portal_payment_link_attempts: number;
  portal_payment_link_attempted_at: string | null;
  portal_payment_link_sent_at: string | null;
  portal_payment_link_sent_to: string | null;
  portal_payment_link_detail: string | null;
  portal_subscription_id: string | null;
  portal_subscription_status: string | null;
  portal_subscription_customer_id: string | null;
  portal_checkout_session_id: string | null;
  portal_subscription_started_at: string | null;
  portal_subscription_updated_at: string | null;
};

type RowRead =
  | { kind: "row"; row: PaymentRow }
  | { kind: "absent" }
  | { kind: "not_installed" }
  | { kind: "failed"; error: string };

async function readPaymentRow(agreementId: string): Promise<RowRead> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select(PAYMENT_SELECT)
    .eq("id", agreementId)
    .maybeSingle();
  if (error) {
    if (isSchemaAbsent(error)) return { kind: "not_installed" };
    return { kind: "failed", error: error.message };
  }
  if (!data) return { kind: "absent" };
  const row = data as unknown as PaymentRow;
  if (row.document_kind !== BUILDER_PARTNER_KIND) return { kind: "absent" };
  return { kind: "row", row };
}

function partnerLabel(row: Pick<PaymentRow, "client_org" | "client_name">): string {
  return row.client_org?.trim() || row.client_name;
}

function stripeIdOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/* ───────────────────────────── sending the link ───────────────────────────── */

export type PaymentLinkSendResult =
  | { outcome: "sent"; to: string }
  | {
      outcome: "skipped";
      reason: PaymentLinkSkipReason | "raced" | "not_installed" | "mailbox_not_configured";
      detail: string;
    }
  | { outcome: "failed" | "unconfirmed"; detail: string };

/**
 * Email the signatory their own copy of the Portal subscription link. Never
 * throws: the signature, the sweep and the button each read the outcome.
 */
export async function sendBuilderPortalPaymentLink(
  agreementId: string,
  opts: { trigger: PaymentLinkTrigger; actorUserId: string | null },
): Promise<PaymentLinkSendResult> {
  try {
    const read = await readPaymentRow(agreementId);
    if (read.kind === "not_installed") {
      return {
        outcome: "skipped",
        reason: "not_installed",
        detail: "The payment-link columns are not installed on this database yet.",
      };
    }
    if (read.kind === "absent") {
      return { outcome: "failed", detail: "The Builder Partner Agreement was not found." };
    }
    if (read.kind === "failed") {
      return { outcome: "failed", detail: `The agreement could not be read: ${read.error}` };
    }
    const row = read.row;
    const decision = decidePaymentLinkDispatch(row, Date.now(), { trigger: opts.trigger });

    if (decision.action === "abandon_stale") {
      await abandonStaleClaim(row);
      return {
        outcome: "unconfirmed",
        detail:
          "An earlier send never finished, so the link may have gone. It is not sent again automatically.",
      };
    }
    if (decision.action === "skip") {
      return { outcome: "skipped", reason: decision.reason, detail: decision.detail };
    }

    const mailbox = defaultMailbox();
    if (!isGraphConfigured() || !mailbox) {
      const detail =
        "No sending mailbox is configured (MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_MAILBOX_EMAIL), so the payment link cannot be emailed. The agreements sweep sends it once one is.";
      if (opts.trigger === "signature") {
        await notifyOperators({
          kind: "agreement_attention",
          severity: "warning",
          title: `Builder Portal payment link not sent: ${partnerLabel(row)}`,
          body: detail,
          url: `/agreements/${agreementId}`,
          metadata: { agreement_id: agreementId },
        });
      }
      return { outcome: "skipped", reason: "mailbox_not_configured", detail };
    }

    // Claim: only the invocation whose update matches the state it read sends.
    const attemptAt = new Date().toISOString();
    const attempts = (row.portal_payment_link_attempts ?? 0) + 1;
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("client_agreements")
      .update({
        portal_payment_link_status: "sending",
        portal_payment_link_attempted_at: attemptAt,
        portal_payment_link_attempts: attempts,
        portal_payment_link_detail: null,
      })
      .eq("id", agreementId)
      .eq("document_kind", BUILDER_PARTNER_KIND)
      .eq("status", "signed")
      .filter(
        "portal_payment_link_status",
        row.portal_payment_link_status === null ? "is" : "eq",
        row.portal_payment_link_status,
      )
      .filter(
        "portal_payment_link_attempted_at",
        row.portal_payment_link_attempted_at === null ? "is" : "eq",
        row.portal_payment_link_attempted_at,
      )
      .select("id");
    if (claimError) {
      return { outcome: "failed", detail: `The send could not be recorded: ${claimError.message}` };
    }
    if (!claimed?.length) {
      return {
        outcome: "skipped",
        reason: "raced",
        detail: "Another send of this payment link started first.",
      };
    }

    const to = row.client_email.trim();
    const email = composePaymentLinkEmail({
      agreementId,
      reference: row.offer_reference,
      recipientName: row.client_name,
      recipientEmail: to,
      organisation: row.client_org,
    });

    let settled: { status: PaymentLinkStatus; detail: string | null };
    let sentTo: string | null = null;
    try {
      const outcome = await sendMail(mailbox, {
        subject: email.subject,
        body: { contentType: "HTML", content: email.html },
        toRecipients: [{ emailAddress: { address: to, name: row.client_name } }],
        replyTo: [{ emailAddress: { address: mailbox } }],
      });
      if (outcome.kind === "sent") {
        settled = { status: "sent", detail: null };
        sentTo = to;
      } else if (outcome.kind === "throttled") {
        settled = {
          status: "failed",
          detail: `Microsoft asked us to wait ${Math.round(outcome.retryAfterMs / 1000)}s before sending; the sweep tries again.`,
        };
      } else if (outcome.kind === "refused") {
        settled = { status: "failed", detail: `Microsoft refused the message: ${outcome.message}` };
      } else {
        settled = {
          status: "unconfirmed",
          detail: `Microsoft did not confirm the send (${outcome.message}). It may have arrived, so it is not sent again automatically.`,
        };
      }
    } catch (err) {
      // `sendMail` throws only for a credential Microsoft refused, before
      // anything is on the wire — so nothing left, and a retry is safe.
      settled = {
        status: "failed",
        detail: `The mailbox could not be used: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const { error: settleError } = await supabaseAdmin
      .from("client_agreements")
      .update({
        portal_payment_link_status: settled.status,
        portal_payment_link_detail: settled.detail,
        ...(sentTo
          ? {
              portal_payment_link_sent_at: new Date().toISOString(),
              portal_payment_link_sent_to: sentTo,
            }
          : {}),
      })
      .eq("id", agreementId)
      .eq("portal_payment_link_status", "sending")
      .eq("portal_payment_link_attempted_at", attemptAt);
    if (settleError) {
      console.error("[builder-portal-payment] settle failed:", settleError.message);
    }

    await writeAuditLog({
      action:
        settled.status === "sent"
          ? "agreement.portal_payment_link_sent"
          : "agreement.portal_payment_link_not_sent",
      entityType: "client_agreement",
      entityId: agreementId,
      actorUserId: opts.actorUserId,
      metadata: {
        document_kind: BUILDER_PARTNER_KIND,
        reference: row.offer_reference,
        trigger: opts.trigger,
        outcome: settled.status,
        detail: settled.detail,
        to: sentTo,
        attempts,
        payment_link: BUILDER_PORTAL_PAYMENT.paymentLinkId,
        monthly_incl_gst_cents: BUILDER_PORTAL_PAYMENT.monthlyInclGstCents,
      },
    });

    if (settled.status === "sent") return { outcome: "sent", to };

    const exhausted = settled.status === "failed" && attempts >= MAX_PAYMENT_LINK_ATTEMPTS;
    // The sweep's ordinary retries stay quiet until they run out; the admin's
    // own send answers on the page instead.
    if (settled.status === "unconfirmed" || exhausted || opts.trigger === "signature") {
      await notifyOperators({
        kind: "agreement_attention",
        severity: settled.status === "unconfirmed" ? "warning" : "error",
        title: `Builder Portal payment link ${settled.status === "unconfirmed" ? "unconfirmed" : "not sent"}: ${partnerLabel(row)}`,
        body:
          `${settled.detail ?? ""}` +
          (exhausted
            ? ` It has failed ${attempts} times and is now sent only from the agreement page.`
            : ""),
        url: `/agreements/${agreementId}`,
        metadata: { agreement_id: agreementId, attempts, outcome: settled.status },
      });
    }
    return {
      outcome: settled.status === "unconfirmed" ? "unconfirmed" : "failed",
      detail: settled.detail ?? "",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[builder-portal-payment] send failed:", detail);
    return { outcome: "failed", detail };
  }
}

/** A claim an invocation never settled: whether it sent is unknowable, so it is not repeated. */
async function abandonStaleClaim(row: PaymentRow): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .update({
      portal_payment_link_status: "unconfirmed",
      portal_payment_link_detail:
        "A send was started and never finished, so the link may have gone. It is not sent again automatically; check the mailbox's Sent Items.",
    })
    .eq("id", row.id)
    .eq("portal_payment_link_status", "sending")
    .filter(
      "portal_payment_link_attempted_at",
      row.portal_payment_link_attempted_at === null ? "is" : "eq",
      row.portal_payment_link_attempted_at,
    )
    .select("id");
  if (error || !data?.length) return;
  await notifyOperators({
    kind: "agreement_attention",
    severity: "warning",
    title: `Builder Portal payment link unconfirmed: ${partnerLabel(row)}`,
    body: "A send of the payment link started and never finished. Check the mailbox's Sent Items and send it from the agreement page if it did not go.",
    url: `/agreements/${row.id}`,
    metadata: { agreement_id: row.id },
  });
}

/* ───────────────────────────── the sweep ───────────────────────────── */

export type PaymentLinkSweep = {
  installed: boolean;
  sent: number;
  attempts: number;
  errors: string[];
};

/**
 * The payment links the agreements refresh owes: a retained signature whose
 * link never went, a failed send with attempts left, and a claim gone stale.
 */
export async function sweepBuilderPortalPaymentLinks(): Promise<PaymentLinkSweep> {
  const out: PaymentLinkSweep = { installed: true, sent: 0, attempts: 0, errors: [] };
  const base = () =>
    supabaseAdmin
      .from("client_agreements")
      .select("id")
      .eq("document_kind", BUILDER_PARTNER_KIND)
      .eq("status", "signed")
      .not("signed_record_path", "is", null);
  try {
    const staleBefore = new Date(Date.now() - STALE_PAYMENT_LINK_CLAIM_MS).toISOString();
    const queries = await Promise.all([
      base()
        .filter("portal_payment_link_status", "is", null)
        .is("portal_subscription_id", null)
        .limit(10),
      base()
        .eq("portal_payment_link_status", "failed")
        .lt("portal_payment_link_attempts", MAX_PAYMENT_LINK_ATTEMPTS)
        .limit(10),
      base()
        .eq("portal_payment_link_status", "sending")
        .lt("portal_payment_link_attempted_at", staleBefore)
        .limit(10),
    ]);
    const ids = new Set<string>();
    for (const { data, error } of queries) {
      if (error) {
        if (isSchemaAbsent(error)) return { ...out, installed: false };
        out.errors.push(error.message);
        continue;
      }
      for (const row of data ?? []) ids.add(row.id);
    }
    for (const id of ids) {
      const result = await sendBuilderPortalPaymentLink(id, {
        trigger: "sweep",
        actorUserId: null,
      });
      if (result.outcome !== "skipped") out.attempts++;
      if (result.outcome === "sent") out.sent++;
    }
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
  }
  return out;
}

/* ───────────────────────────── what Stripe reports ───────────────────────────── */

function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = sub as any;
  const ts = s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

/**
 * Which agreement a paid session belongs to: the reference the builder's own
 * link carried, or — for somebody who used the bare link — the one signed
 * agreement with no subscription whose signatory paid. Anything else is left
 * to a person rather than guessed.
 */
async function agreementForSession(
  session: Stripe.Checkout.Session,
): Promise<{ id: string; via: "reference" | "email" } | { id: null; why: string }> {
  const fromReference = agreementIdFromReference(session.client_reference_id);
  if (fromReference) return { id: fromReference, via: "reference" };
  const email = session.customer_details?.email?.trim() ?? session.customer_email?.trim() ?? "";
  // `*` is PostgREST's wildcard in a LIKE pattern and cannot be escaped there;
  // an address carrying one is matched by a person rather than by a pattern.
  if (!email || !isValidEmail(email) || email.includes("*")) {
    return {
      id: null,
      why: "the payment carried no agreement reference and no usable email address",
    };
  }
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select("id")
    .eq("document_kind", BUILDER_PARTNER_KIND)
    .eq("status", "signed")
    .is("portal_subscription_id", null)
    .ilike(
      "client_email",
      email.replace(/[\\%_]/g, (c) => `\\${c}`),
    )
    .limit(2);
  if (error) throw new Error(`builder agreement lookup failed: ${error.message}`);
  if (data?.length === 1) return { id: data[0].id, via: "email" };
  return {
    id: null,
    why: data?.length
      ? `the payment carried no agreement reference and ${email} signed more than one agreement with no subscription`
      : `the payment carried no agreement reference and no signed agreement without a subscription belongs to ${email}`,
  };
}

/**
 * A Checkout Session the Portal link opened has completed. Records the
 * subscription it created on the agreement, with Stripe's own current status
 * (read live, because the session and the subscription's own events arrive in
 * no fixed order). Throws only for a transient fault, so Stripe retries.
 */
export async function recordBuilderPortalCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const subscriptionId = stripeIdOf(session.subscription as string | Stripe.Subscription | null);
  const customerId = stripeIdOf(session.customer as string | Stripe.Customer | null);
  const target = await agreementForSession(session);
  if (target.id === null) {
    await notifyOperators({
      kind: "agreement_attention",
      severity: "warning",
      title: "Builder Portal subscription paid, but not matched to an agreement",
      body: `Stripe checkout ${session.id} (subscription ${subscriptionId ?? "none"}) was paid through the Builder Portal link, but ${target.why}. Match it to the builder's agreement by hand.`,
      url: "/agreements",
      metadata: {
        session_id: session.id,
        subscription_id: subscriptionId,
        customer_id: customerId,
        email: session.customer_details?.email ?? null,
      },
    });
    return;
  }
  const read = await readPaymentRow(target.id);
  if (read.kind === "not_installed") {
    throw new Error("builder portal payment columns are not installed");
  }
  if (read.kind === "failed") throw new Error(`builder agreement read failed: ${read.error}`);
  if (read.kind === "absent") {
    await notifyOperators({
      kind: "agreement_attention",
      severity: "warning",
      title: "Builder Portal subscription paid for an agreement that does not exist",
      body: `Stripe checkout ${session.id} names agreement ${target.id}, which is not a Builder Partner Agreement here.`,
      url: "/agreements",
      metadata: {
        session_id: session.id,
        subscription_id: subscriptionId,
        agreement_id: target.id,
      },
    });
    return;
  }
  const row = read.row;
  if (!subscriptionId) {
    await notifyOperators({
      kind: "agreement_attention",
      severity: "warning",
      title: `Builder Portal checkout completed with no subscription: ${partnerLabel(row)}`,
      body: `Stripe checkout ${session.id} finished without creating a subscription. Check it in Stripe.`,
      url: `/agreements/${row.id}`,
      metadata: { session_id: session.id, agreement_id: row.id },
    });
    return;
  }

  const decision = decideSubscriptionRecord(row.portal_subscription_id, subscriptionId);
  if (decision.action === "duplicate") {
    await notifyOperators({
      kind: "agreement_attention",
      severity: "error",
      title: `Second Builder Portal subscription for ${partnerLabel(row)}`,
      body: `The agreement already has subscription ${decision.existing}; checkout ${session.id} created ${subscriptionId}. Nothing was overwritten. Cancel and refund the one that should not exist in Stripe.`,
      url: `/agreements/${row.id}`,
      metadata: {
        agreement_id: row.id,
        existing_subscription_id: decision.existing,
        new_subscription_id: subscriptionId,
        session_id: session.id,
      },
    });
    return;
  }

  // Stripe's own word for the subscription now — never inferred from the session.
  const live = await getStripe().subscriptions.retrieve(subscriptionId);
  const status = isStripeSubscriptionStatus(live.status) ? live.status : null;
  const now = new Date().toISOString();
  const update = supabaseAdmin
    .from("client_agreements")
    .update({
      portal_subscription_id: subscriptionId,
      portal_subscription_status: status,
      portal_subscription_customer_id: customerId,
      portal_checkout_session_id: session.id,
      portal_subscription_updated_at: now,
      ...(decision.first ? { portal_subscription_started_at: now } : {}),
    })
    .eq("id", row.id);
  const { data: written, error } = decision.first
    ? await update.is("portal_subscription_id", null).select("id")
    : await update.eq("portal_subscription_id", subscriptionId).select("id");
  if (error) throw new Error(`builder subscription not recorded: ${error.message}`);
  if (!written?.length) {
    // Another event recorded a subscription between the read and the write.
    // Run the decision again against what is there now.
    const again = await readPaymentRow(row.id);
    if (again.kind === "row" && again.row.portal_subscription_id !== subscriptionId) {
      throw new Error("builder subscription raced another record; retrying");
    }
    return;
  }

  if (decision.first) {
    await writeAuditLog({
      action: "agreement.portal_subscription_started",
      entityType: "client_agreement",
      entityId: row.id,
      metadata: {
        document_kind: BUILDER_PARTNER_KIND,
        reference: row.offer_reference,
        subscription_id: subscriptionId,
        customer_id: customerId,
        session_id: session.id,
        status,
        matched_by: target.via,
        amount_total_cents: session.amount_total ?? null,
        currency: session.currency ?? null,
      },
    });
    await notifyOperators({
      kind: "agreement_attention",
      severity: target.via === "email" ? "warning" : "info",
      title: `Builder Portal subscription started: ${partnerLabel(row)}`,
      body:
        `Subscription ${subscriptionId} is ${status ?? live.status} (${portalPrice().sentence}).` +
        (target.via === "email"
          ? " The payment carried no agreement reference and was matched by the signatory's email address; confirm it is the right builder."
          : ""),
      url: `/agreements/${row.id}`,
      metadata: { agreement_id: row.id, subscription_id: subscriptionId, matched_by: target.via },
    });
  }
}

/** A delayed payment for the Portal link did not clear. */
export async function recordBuilderPortalCheckoutFailed(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const agreementId = agreementIdFromReference(session.client_reference_id);
  await notifyOperators({
    kind: "agreement_attention",
    severity: "warning",
    title: "Builder Portal subscription payment did not clear",
    body: `Stripe checkout ${session.id} for the Builder Portal subscription failed to settle. The builder may need to pay again from their link.`,
    url: agreementId ? `/agreements/${agreementId}` : "/agreements",
    metadata: { session_id: session.id, agreement_id: agreementId },
  });
}

/**
 * A Portal subscription changed (created, updated or deleted). Keeps the
 * agreement's copy of Stripe's status in step. A subscription no agreement
 * names yet is left alone: its Checkout Session records it, reading the live
 * status then, whichever order the two events arrive in.
 */
export async function recordBuilderPortalSubscription(sub: Stripe.Subscription): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select("id, client_org, client_name, portal_subscription_status")
    .eq("document_kind", BUILDER_PARTNER_KIND)
    .eq("portal_subscription_id", sub.id)
    .maybeSingle();
  if (error) {
    if (isSchemaAbsent(error)) return;
    throw new Error(`builder subscription lookup failed: ${error.message}`);
  }
  if (!data) return;
  const status = isStripeSubscriptionStatus(sub.status) ? sub.status : null;
  if (!status) return;
  const { error: updateError } = await supabaseAdmin
    .from("client_agreements")
    .update({
      portal_subscription_status: status,
      portal_subscription_updated_at: new Date().toISOString(),
    })
    .eq("id", data.id)
    .eq("portal_subscription_id", sub.id);
  if (updateError) throw new Error(`builder subscription not updated: ${updateError.message}`);

  if (subscriptionNeedsAttention(data.portal_subscription_status, status)) {
    await notifyOperators({
      kind: "agreement_attention",
      severity: "warning",
      title: `Builder Portal subscription ${status.replace(/_/g, " ")}: ${partnerLabel(data)}`,
      body: `Stripe reports subscription ${sub.id} as ${status}${subscriptionPeriodEnd(sub) ? ` (period ends ${subscriptionPeriodEnd(sub)?.slice(0, 10)})` : ""}. Portal access is not changed automatically; decide whether it should be.`,
      url: `/agreements/${data.id}`,
      metadata: { agreement_id: data.id, subscription_id: sub.id, status },
    });
  }
}

/* ───────────────────────────── the page ───────────────────────────── */

export type BuilderPortalPaymentView = {
  installed: boolean;
  price: { monthlyInclGstCents: number; gstCents: number; sentence: string };
  /** The builder's own copy of the link — the same one the email carries. */
  url: string | null;
  link: {
    status: string | null;
    attempts: number;
    attemptedAt: string | null;
    sentAt: string | null;
    sentTo: string | null;
    detail: string | null;
  };
  subscription: {
    id: string | null;
    status: string | null;
    customerId: string | null;
    startedAt: string | null;
    updatedAt: string | null;
  };
};

/** The Portal subscription as the agreement page shows it; null when unreadable. */
export async function describeBuilderPortalPayment(
  agreementId: string,
): Promise<BuilderPortalPaymentView | null> {
  const price = portalPrice();
  const read = await readPaymentRow(agreementId);
  const base = {
    price: {
      monthlyInclGstCents: price.monthlyInclGstCents,
      gstCents: price.gstCents,
      sentence: price.sentence,
    },
  };
  if (read.kind === "not_installed") {
    return {
      installed: false,
      ...base,
      url: null,
      link: {
        status: null,
        attempts: 0,
        attemptedAt: null,
        sentAt: null,
        sentTo: null,
        detail: null,
      },
      subscription: { id: null, status: null, customerId: null, startedAt: null, updatedAt: null },
    };
  }
  if (read.kind !== "row") return null;
  const row = read.row;
  return {
    installed: true,
    ...base,
    url: builderPortalPaymentUrl({ agreementId: row.id, email: row.client_email }),
    link: {
      status: row.portal_payment_link_status,
      attempts: row.portal_payment_link_attempts ?? 0,
      attemptedAt: row.portal_payment_link_attempted_at,
      sentAt: row.portal_payment_link_sent_at,
      sentTo: row.portal_payment_link_sent_to,
      detail: row.portal_payment_link_detail,
    },
    subscription: {
      id: row.portal_subscription_id,
      status: row.portal_subscription_status,
      customerId: row.portal_subscription_customer_id,
      startedAt: row.portal_subscription_started_at,
      updatedAt: row.portal_subscription_updated_at,
    },
  };
}
