-- @asserts table:email_mail_domains
-- @asserts column:email_campaigns.bounce_pause_percent
-- @asserts column:email_campaigns.warmup_guard
-- @asserts table:email_campaign_bounces
--
-- Email campaigns: protecting the sending domain while a campaign runs.
-- See docs/EMAIL_CAMPAIGNS.md, "Protecting the sender".
--
-- Every rule a campaign had was about one contact: never twice, never a
-- bouncer. Nothing watched the campaign as a whole, and the failures that get
-- a domain blocklisted are campaign-wide: a list whose addresses bounce by
-- the hundred keeps sending until it runs out, and a mailbox whose warmup mail
-- has started landing in spam keeps sending campaign mail into spam too.
--
-- ## Bounce rate
--
-- `bounce_pause_percent`: the share of contacts sent since the campaign was
-- last started that may hard-bounce before the dispatcher pauses it. 5 by
-- default; null switches it off. Counted since the last start rather than
-- over the whole campaign, so resuming after cleaning the list starts a fresh
-- sample instead of tripping again on the bounces that caused the pause.
--
-- `email_campaign_bounces`: each contact a campaign sent to whose address
-- later went on the do-not-send register as bounced. A join, not a stored
-- counter — the ledger and the register are the only records of what
-- happened, so a count taken from them cannot drift from it. Reads with the
-- caller's own rights, like the other views here.
--
-- ## The warmup guard
--
-- `warmup_guard`: when the campaign's sending mailbox is in the warmup pool
-- and its warmup mail is landing in spam, pause the campaign rather than send
-- more mail from it into spam. On by default.
--
-- ## Domains that take no mail
--
-- `email_mail_domains`: what DNS said about recipients' domains — whether
-- each exists and has a mail server. Mail to a domain with none bounces every
-- time, and a run of such bounces is exactly what a receiver reads as a
-- spammer's list, so the dispatcher steps over those contacts before sending.
-- Remembered here so the same agencies' domains are not looked up every slot
-- by every isolate. Written by the dispatcher with the service role; operators
-- may read it.

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS bounce_pause_percent INTEGER DEFAULT 5
    CHECK (bounce_pause_percent IS NULL OR bounce_pause_percent BETWEEN 1 AND 50),
  ADD COLUMN IF NOT EXISTS warmup_guard BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.email_campaigns.bounce_pause_percent IS
  'Pause when this share of the contacts sent since the campaign last started has hard-bounced. Null switches it off.';
COMMENT ON COLUMN public.email_campaigns.warmup_guard IS
  'Pause when the sending mailbox is in the warmup pool and its warmup mail is landing in spam.';

CREATE OR REPLACE VIEW public.email_campaign_bounces
WITH (security_invoker = true) AS
SELECT
  r.campaign_id,
  r.id AS recipient_id,
  r.email_key,
  r.sent_at,
  s.first_seen_at AS bounced_at
FROM public.email_campaign_recipients r
JOIN public.email_suppressions s
  ON s.email_key = r.email_key
 AND s.reason = 'bounced'
WHERE r.status = 'sent'
  AND r.sent_at IS NOT NULL
  AND s.first_seen_at >= r.sent_at;

COMMENT ON VIEW public.email_campaign_bounces IS
  'Contacts a campaign sent to whose address went on the do-not-send register as bounced after that send. Reads with the caller''s own rights.';

GRANT SELECT ON public.email_campaign_bounces TO authenticated;

CREATE TABLE IF NOT EXISTS public.email_mail_domains (
  domain TEXT PRIMARY KEY CHECK (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  accepts_mail BOOLEAN NOT NULL,
  detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_mail_domains IS
  'What DNS said about recipients'' domains: whether each takes mail at all. The dispatcher steps over contacts at a domain that does not.';

ALTER TABLE public.email_mail_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read mail domains" ON public.email_mail_domains;
CREATE POLICY "Operators read mail domains"
  ON public.email_mail_domains FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));
