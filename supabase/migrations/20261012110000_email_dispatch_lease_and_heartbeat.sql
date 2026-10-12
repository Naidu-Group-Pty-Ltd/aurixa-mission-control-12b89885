-- @asserts column:email_campaigns.dispatch_lease_until
-- @asserts column:email_campaigns.dispatch_lease_token
-- @asserts column:email_campaigns.last_tick_at
-- @asserts column:email_campaigns.last_tick_note
-- @asserts column:email_campaigns.next_send_at
-- @asserts cron:email-campaign-dispatch-1min
--
-- The email dispatcher: one pass per campaign at a time, a pass long enough to
-- cover the gap between the ticks that actually arrive, and a record on the
-- campaign of what the last pass decided. See docs/EMAIL_CAMPAIGNS.md, "The
-- workers".
--
-- ## What was measured (12 Oct 2026)
--
-- The dispatcher was written for one tick a minute, one after another. That is
-- not what reaches it. pg_net sends this deployment's hook calls in batches and
-- starts the next batch only when the slowest request in the current one has
-- answered; every-minute jobs here allow up to 290 s. Over two hours the
-- responses arrived in 61 batches, 41 to 262 seconds apart (median about 100),
-- each carrying ONE TO FOUR dispatcher ticks at once — and pg_cron failed to
-- start about one run in eleven ("job startup timeout": eleven every-minute
-- jobs against six worker processes).
--
-- Against that, three things went wrong:
--
-- * Ticks of the same campaign ran concurrently. Each read the same
--   `last_message_at`, so the gap between messages was not enforced across
--   them, and each counted the same "sent today".
-- * A pass could last 20 seconds. With a 60-second gap (the default) a pass can
--   send one message and then has to stop, and the next pass arrives a minute
--   and a half later on average: the campaign ran at roughly half its own pace.
-- * Nothing recorded why a running campaign was not sending. A campaign started
--   at 16:57 in Sydney with a 09:00–17:00 window sent one message, waited for
--   the morning as its rules said, and the page showed "running" with no
--   reason — indistinguishable from a broken scheduler.
--
-- ## The lease
--
-- `dispatch_lease_until` / `dispatch_lease_token`: a pass claims the campaign
-- with one conditional UPDATE (no lease, or an expired one) and owns it until it
-- releases it. Concurrent ticks lose that race and leave the campaign alone. A
-- pass that dies holding it costs at most the lease's lifetime.
--
-- ## The heartbeat
--
-- `last_tick_at`, `last_tick_note`, `next_send_at`: written by every pass that
-- held the lease — what it decided, in words, and when the next message may go
-- (the window opening, the end of the gap, tomorrow once a daily cap is spent).
-- A running campaign whose `last_tick_at` is old is a scheduler that has stopped
-- reaching it, which the page can now say.
--
-- ## The timeout
--
-- The dispatcher's pass now runs up to about 90 seconds before it stops starting
-- new messages, so one pass covers the usual interval between batches. The HTTP
-- call is given 115 seconds: a Worker whose caller disconnects is cancelled, and
-- a cancellation in the middle of a send is the one way to strand a contact as
-- `claimed`. A pass is long only while a campaign is sending inside its window
-- and waiting out its gap; otherwise it answers in a second or two. When it is
-- long it can hold a pg_net batch open longer than the batch's other hooks
-- would have — within what the batches already tolerate, since other
-- every-minute hooks here allow up to 290 seconds.

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS dispatch_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatch_lease_token UUID,
  ADD COLUMN IF NOT EXISTS last_tick_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_tick_note TEXT,
  ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ;

COMMENT ON COLUMN public.email_campaigns.dispatch_lease_until IS
  'While in the future, one dispatcher pass owns this campaign and every other pass leaves it alone. Concurrent ticks are routine: pg_net delivers them in bursts.';
COMMENT ON COLUMN public.email_campaigns.dispatch_lease_token IS
  'Which pass holds the lease, so only that pass releases it.';
COMMENT ON COLUMN public.email_campaigns.last_tick_at IS
  'When a dispatcher pass last worked this campaign. Old while running means the scheduler has stopped reaching it.';
COMMENT ON COLUMN public.email_campaigns.last_tick_note IS
  'What that pass decided, in words: sent, outside the window, waiting out the gap, a cap reached, throttled.';
COMMENT ON COLUMN public.email_campaigns.next_send_at IS
  'When the next message may go under the campaign''s own rules, as of the last pass. Null when nothing is waiting or nothing ever will.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The dispatcher's schedule, with the longer HTTP timeout
--
-- Same job name, same cadence, same endpoint. The secret is read from the vault
-- INSIDE the command string, per `check-cron-auth.mjs`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  PERFORM cron.unschedule('email-campaign-dispatch-1min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-campaign-dispatch-1min');

  PERFORM cron.schedule(
    'email-campaign-dispatch-1min',
    '* * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 115000
      )$f$,
      v_base || '/hooks/email-campaign-dispatch'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'email campaign dispatcher NOT rescheduled (%).', SQLERRM;
END $$;
