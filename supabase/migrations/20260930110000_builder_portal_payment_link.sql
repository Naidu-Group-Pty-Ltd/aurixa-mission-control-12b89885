-- @asserts column:client_agreements.portal_payment_link_status
-- @asserts column:client_agreements.portal_payment_link_attempts
-- @asserts column:client_agreements.portal_payment_link_sent_at
-- @asserts column:client_agreements.portal_subscription_id
-- @asserts column:client_agreements.portal_subscription_status
-- @asserts check:client_agreements.portal_payment_link_status=held
-- @asserts check:client_agreements.portal_subscription_status=active
--
-- The Builder / Developer Portal subscription, and the payment link a signed
-- Builder Partner Agreement sends.
--
-- The Builder & Developer Portal & Marketplace Agreement carries two kinds of
-- fee. The monthly Portal subscription starts when the agreement is signed;
-- the Transaction Fees (New Build, Development Sale) are separate from it and
-- are invoiced only when earned. When DocuSign reports the agreement signed and
-- its signed copy has been retained, Mission Control now emails the signatory
-- their own copy of the Stripe Payment Link for the subscription (see
-- src/lib/agreements/builderPortalPayment.pure.ts). These columns record that
-- send, and the subscription the payment created, on the agreement row the
-- signature is already recorded on.
--
--   portal_payment_link_status   sending | sent | failed | unconfirmed | held
--   portal_payment_link_attempts automatic and manual sends, counted at claim
--   portal_payment_link_*        when it was tried, when it went, to whom, why not
--   portal_subscription_*        the Stripe subscription the link created,
--                                with Stripe's own status word, verbatim
--
-- `unconfirmed` is Graph having taken the message without saying so; it is
-- never retried automatically, because a retry mails a builder the same demand
-- for money twice. `held` is an agreement signed before the link was sent
-- automatically: the backfill below holds those rather than letting the first
-- sweep after deploy email every builder who already signed.
--
-- Nothing here is frozen. The freeze trigger names its columns one by one and
-- these are none of them: the payment link is what happens after the record,
-- not part of it.

ALTER TABLE public.client_agreements
  ADD COLUMN IF NOT EXISTS portal_payment_link_status TEXT
    CONSTRAINT client_agreements_portal_payment_link_status_check
    CHECK (portal_payment_link_status IS NULL
           OR portal_payment_link_status IN ('sending', 'sent', 'failed', 'unconfirmed', 'held')),
  ADD COLUMN IF NOT EXISTS portal_payment_link_attempts INTEGER NOT NULL DEFAULT 0
    CONSTRAINT client_agreements_portal_payment_link_attempts_check
    CHECK (portal_payment_link_attempts >= 0),
  ADD COLUMN IF NOT EXISTS portal_payment_link_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_payment_link_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_payment_link_sent_to TEXT,
  ADD COLUMN IF NOT EXISTS portal_payment_link_detail TEXT,
  ADD COLUMN IF NOT EXISTS portal_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS portal_subscription_status TEXT
    CONSTRAINT client_agreements_portal_subscription_status_check
    CHECK (portal_subscription_status IS NULL
           OR portal_subscription_status IN ('incomplete', 'incomplete_expired', 'trialing',
                                             'active', 'past_due', 'canceled', 'unpaid',
                                             'paused')),
  ADD COLUMN IF NOT EXISTS portal_subscription_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS portal_checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS portal_subscription_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_subscription_updated_at TIMESTAMPTZ;

-- The Portal subscription is a builder's; on any other kind of agreement these
-- columns would be a claim about somebody who was never sent the link.
ALTER TABLE public.client_agreements
  DROP CONSTRAINT IF EXISTS client_agreements_portal_payment_kind_check;
ALTER TABLE public.client_agreements
  ADD CONSTRAINT client_agreements_portal_payment_kind_check
  CHECK (
    document_kind = 'builder_partner'
    OR (portal_payment_link_status IS NULL
        AND portal_payment_link_attempts = 0
        AND portal_subscription_id IS NULL
        AND portal_subscription_status IS NULL)
  );

-- One subscription belongs to one agreement: the webhook finds the agreement
-- by it, and two rows naming it would make that lookup a guess.
CREATE UNIQUE INDEX IF NOT EXISTS client_agreements_portal_subscription_unique
  ON public.client_agreements (portal_subscription_id)
  WHERE portal_subscription_id IS NOT NULL;

-- The sweep's two questions: what is owed a link, and what is stuck sending.
CREATE INDEX IF NOT EXISTS idx_client_agreements_portal_payment_link
  ON public.client_agreements (portal_payment_link_status)
  WHERE document_kind = 'builder_partner' AND status = 'signed';

-- Agreements already signed are held, not sent: whether each of those builders
-- owes the link is a person's decision, made from the agreement page. Only a
-- row nothing has touched is held, so replaying this file changes nothing.
UPDATE public.client_agreements
   SET portal_payment_link_status = 'held',
       portal_payment_link_detail =
         'Signed before the payment link was sent automatically; send it from the agreement page if it is owed.'
 WHERE document_kind = 'builder_partner'
   AND status = 'signed'
   AND portal_payment_link_status IS NULL
   AND portal_subscription_id IS NULL;

COMMENT ON COLUMN public.client_agreements.portal_payment_link_status IS
  'Builder Partner Agreements only: the Portal subscription payment link. sending (claimed), sent, failed (retried by the agreements sweep), unconfirmed (Graph did not confirm; never retried automatically) or held (signed before automatic sending; sent by an admin if owed).';
COMMENT ON COLUMN public.client_agreements.portal_subscription_id IS
  'Builder Partner Agreements only: the Stripe subscription the payment link created, recorded from checkout.session.completed.';
COMMENT ON COLUMN public.client_agreements.portal_subscription_status IS
  'Builder Partner Agreements only: Stripe''s own status for the Portal subscription, verbatim, kept in step by the subscription webhooks.';
