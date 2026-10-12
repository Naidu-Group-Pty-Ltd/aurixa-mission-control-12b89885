-- @asserts table:email_warmup_settings
-- @asserts table:email_warmup_mailboxes
-- @asserts table:email_warmup_messages
-- @asserts table:email_warmup_daily
-- @asserts rows:email_warmup_settings>=1
-- @asserts check:email_warmup_messages.status=missing
-- @asserts cron:email-warmup-2min
--
-- Email warmup: a pool of mailboxes, in the Microsoft tenants Mission Control
-- holds credentials for, that write to each other and treat what arrives the
-- way an interested reader would — opened, rescued from Junk, sometimes
-- flagged, sometimes answered — so the mailbox providers judging them see
-- wanted mail, and new domains and mailboxes earn a sending reputation before
-- a campaign asks anything of it. The same mechanism Instantly and its peers
-- sell, run on mailboxes this deployment can act on directly. See
-- docs/EMAIL_WARMUP.md.
--
-- ## The tables
--
-- `email_warmup_mailboxes` — one row per enrolled mailbox: which tenant it is
-- reached through (NULL is the deployment's own), its ramp and window, where
-- it is in that ramp, when it next sends, and the id of the folder warmup mail
-- is filed into in that mailbox. Removal is soft: the messages it exchanged
-- stay attributed to it.
--
-- `email_warmup_messages` — one row per message, written BEFORE it is created
-- in the sender's mailbox and moved along as the engine learns more: sent,
-- found in the recipient's mailbox (`landed`, with where: inbox, junk or
-- another folder), engaged with, answered — or `missing` (never arrived:
-- quarantined, rejected, deleted) or `failed` (never left). Placement over the
-- last week is the mailbox's health. A reply is a row of its own, with the
-- message it answers as `parent_id`.
--
-- `email_warmup_settings` — one row: the pool-wide pause, the test-mode
-- switch that allows pairs inside one organisation, and the engine's lease and
-- heartbeat. The engine runs from a pg_cron hook every two minutes; pg_net
-- delivers those in bursts (see 20261012110000), so a pass takes the lease
-- with one conditional UPDATE and every concurrent tick leaves.
--
-- ## Who writes what
--
-- Operators read all three through RLS. Nothing is written from a browser:
-- enrolment has to talk to Microsoft first (to create the warmup folder, which
-- is also the proof the tenant's application may change that mailbox), so
-- every write goes through a server function behind `requireOperator`, or the
-- engine, with the service role.

CREATE TABLE IF NOT EXISTS public.email_warmup_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  -- Pool-wide stop: no new conversations and no replies. Mail already in
  -- flight is still found and filed, so nothing is left in anyone's inbox.
  paused BOOLEAN NOT NULL DEFAULT false,
  -- Test mode. Mail between two mailboxes of ONE Microsoft organisation never
  -- leaves Exchange Online, so it exercises the machinery and builds no
  -- reputation; off, such pairs are never made.
  allow_same_organisation BOOLEAN NOT NULL DEFAULT false,
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  last_tick_at TIMESTAMPTZ,
  last_tick_note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

COMMENT ON TABLE public.email_warmup_settings IS
  'The email warmup pool: one row. The pool-wide pause, the same-organisation test mode, and the engine''s lease and heartbeat.';

INSERT INTO public.email_warmup_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.email_warmup_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Microsoft tenant the mailbox is reached through. NULL is the
  -- deployment's own (its Lovable secrets), as everywhere else.
  tenant_id UUID REFERENCES public.microsoft_tenants(id) ON DELETE RESTRICT,
  mailbox TEXT NOT NULL CHECK (mailbox ~ '^[^@\s]+@[^@\s]+$'),
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) <= 200),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'removed')),
  -- Why it is paused or in error, in words.
  status_reason TEXT,

  -- The schedule. A ramp from start_per_day, up increase_per_day for each day
  -- it actually warms, to max_per_day; inside window_start–window_end in
  -- `timezone`, optionally weekdays only.
  start_per_day INTEGER NOT NULL DEFAULT 2 CHECK (start_per_day BETWEEN 1 AND 50),
  increase_per_day INTEGER NOT NULL DEFAULT 2 CHECK (increase_per_day BETWEEN 0 AND 20),
  max_per_day INTEGER NOT NULL DEFAULT 30 CHECK (max_per_day BETWEEN 1 AND 100),
  reply_rate INTEGER NOT NULL DEFAULT 30 CHECK (reply_rate BETWEEN 0 AND 100),
  important_rate INTEGER NOT NULL DEFAULT 15 CHECK (important_rate BETWEEN 0 AND 100),
  weekdays_only BOOLEAN NOT NULL DEFAULT false,
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  window_start TIME NOT NULL DEFAULT '08:00',
  window_end TIME NOT NULL DEFAULT '18:00',
  -- Move the sender's own copy out of Sent Items into the warmup folder too.
  tidy_sent BOOLEAN NOT NULL DEFAULT true,

  -- Progress. active_days counts days it has sent on, last_active_on the last
  -- of them (in its zone): a paused week is not a week of ramp.
  active_days INTEGER NOT NULL DEFAULT 0 CHECK (active_days >= 0),
  last_active_on DATE,
  next_send_at TIMESTAMPTZ,

  -- Prepared at enrolment: the folder warmup mail is filed into, and the
  -- organisation (the token's tenant id) the mailbox belongs to.
  warmup_folder_id TEXT,
  organisation_id TEXT,
  prepared_at TIMESTAMPTZ,

  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  removed_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_warmup_mailboxes IS
  'Mailboxes enrolled in email warmup, each reached through a Microsoft tenant (NULL is the deployment''s own). Soft-removed, so the messages they exchanged stay attributed.';
COMMENT ON COLUMN public.email_warmup_mailboxes.organisation_id IS
  'The directory (tid) the tenant''s token is issued by. Warmup pairs mailboxes across organisations only: mail inside one never leaves Exchange Online.';

-- One live enrolment per address. A mailbox belongs to one organisation, so
-- enrolling it again through a second tenant would only make it write to
-- itself.
CREATE UNIQUE INDEX IF NOT EXISTS email_warmup_mailboxes_live
  ON public.email_warmup_mailboxes (lower(mailbox)) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_warmup_mailboxes_tenant_id
  ON public.email_warmup_mailboxes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_warmup_mailboxes_due
  ON public.email_warmup_mailboxes (status, next_send_at);

CREATE TABLE IF NOT EXISTS public.email_warmup_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The first message's id, shared by every reply in the thread.
  thread_id UUID NOT NULL,
  parent_id UUID REFERENCES public.email_warmup_messages(id) ON DELETE SET NULL,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 5),
  sender_id UUID NOT NULL REFERENCES public.email_warmup_mailboxes(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES public.email_warmup_mailboxes(id) ON DELETE CASCADE,
  -- Copied, so the log reads without a join and survives a re-enrolment.
  sender_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) <= 300),

  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'landed', 'engaged', 'done', 'missing', 'failed')),
  -- Where it arrived: the inbox, Junk, or another folder (a rule moved it).
  placement TEXT CHECK (placement IN ('inbox', 'junk', 'other')),
  -- Focused Inbox's verdict when it arrived; NULL where Focused is off.
  focused BOOLEAN,

  -- Graph's handles, all immutable ids: the sender's draft (which becomes its
  -- Sent Items copy), the Message-ID it travelled under, and the copy that
  -- arrived in the recipient's mailbox.
  sender_item_id TEXT,
  internet_message_id TEXT,
  recipient_item_id TEXT,

  -- What the recipient will do with it, decided when it was sent.
  will_reply BOOLEAN NOT NULL DEFAULT false,
  will_flag BOOLEAN NOT NULL DEFAULT false,

  sent_at TIMESTAMPTZ,
  sent_confirmed_at TIMESTAMPTZ,
  sender_filed_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  check_attempts INTEGER NOT NULL DEFAULT 0,
  landed_at TIMESTAMPTZ,
  engage_at TIMESTAMPTZ,
  engaged_at TIMESTAMPTZ,
  rescued_at TIMESTAMPTZ,
  flagged_at TIMESTAMPTZ,
  filed_at TIMESTAMPTZ,
  reply_due_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  action_attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);

COMMENT ON TABLE public.email_warmup_messages IS
  'Every warmup message, written before it is created and moved along as the engine learns more: sent, landed (and where), engaged, answered — or missing, or failed. A reply is a row of its own.';
COMMENT ON COLUMN public.email_warmup_messages.placement IS
  'Where it arrived in the recipient''s mailbox: inbox, junk (rescued afterwards — see rescued_at), or other (a rule moved it).';

CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_sender
  ON public.email_warmup_messages (sender_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_recipient
  ON public.email_warmup_messages (recipient_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_parent_id
  ON public.email_warmup_messages (parent_id);
CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_thread
  ON public.email_warmup_messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_check
  ON public.email_warmup_messages (status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_engage
  ON public.email_warmup_messages (status, engage_at);
CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_reply
  ON public.email_warmup_messages (status, reply_due_at);
CREATE INDEX IF NOT EXISTS idx_email_warmup_messages_sent_at
  ON public.email_warmup_messages (sent_at);

ALTER TABLE public.email_warmup_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_warmup_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_warmup_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators read warmup settings" ON public.email_warmup_settings;
CREATE POLICY "Operators read warmup settings"
  ON public.email_warmup_settings FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators read warmup mailboxes" ON public.email_warmup_mailboxes;
CREATE POLICY "Operators read warmup mailboxes"
  ON public.email_warmup_mailboxes FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators read warmup messages" ON public.email_warmup_messages;
CREATE POLICY "Operators read warmup messages"
  ON public.email_warmup_messages FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Each mailbox's day, in its own zone
--
-- What it sent and where that landed, and what it received and did with it.
-- The page's charts and the health score read this rather than the message
-- log, which at a few dozen messages per mailbox per day is not something to
-- ship to a browser. Bounded to 90 days, so its cost does not grow with the
-- pool's age. `security_invoker` so the tables' own policies decide.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.email_warmup_daily
WITH (security_invoker = true) AS
WITH sent AS (
  SELECT
    m.sender_id AS mailbox_id,
    (m.sent_at AT TIME ZONE mb.timezone)::date AS day,
    1 AS sent,
    (m.depth > 0)::int AS replies_sent,
    (m.placement = 'inbox')::int AS inbox,
    (m.placement = 'junk')::int AS junk,
    (m.placement = 'other')::int AS other,
    (m.status = 'missing')::int AS missing
  FROM public.email_warmup_messages m
  JOIN public.email_warmup_mailboxes mb ON mb.id = m.sender_id
  WHERE m.sent_at IS NOT NULL
    AND m.status <> 'failed'
    AND m.sent_at >= now() - interval '90 days'
),
received AS (
  SELECT
    m.recipient_id AS mailbox_id,
    (m.landed_at AT TIME ZONE mb.timezone)::date AS day,
    1 AS received,
    (m.rescued_at IS NOT NULL)::int AS rescued,
    (m.replied_at IS NOT NULL)::int AS replied
  FROM public.email_warmup_messages m
  JOIN public.email_warmup_mailboxes mb ON mb.id = m.recipient_id
  WHERE m.landed_at IS NOT NULL
    AND m.landed_at >= now() - interval '90 days'
)
SELECT
  mailbox_id,
  day,
  sum(sent)::bigint AS sent,
  sum(replies_sent)::bigint AS replies_sent,
  sum(inbox)::bigint AS inbox,
  sum(junk)::bigint AS junk,
  sum(other)::bigint AS other,
  sum(missing)::bigint AS missing,
  sum(received)::bigint AS received,
  sum(rescued)::bigint AS rescued,
  sum(replied)::bigint AS replied
FROM (
  SELECT mailbox_id, day, sent, replies_sent, inbox, junk, other, missing,
         0 AS received, 0 AS rescued, 0 AS replied
    FROM sent
  UNION ALL
  SELECT mailbox_id, day, 0, 0, 0, 0, 0, 0, received, rescued, replied
    FROM received
) both_sides
GROUP BY mailbox_id, day;

COMMENT ON VIEW public.email_warmup_daily IS
  'Per warmup mailbox per day (in its zone), the last 90 days: what it sent and where that landed, and what it received, rescued from Junk and answered.';

GRANT SELECT ON public.email_warmup_daily TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- A tenant whose mailboxes are warming cannot be removed
--
-- The same function as 20261012120000, with one more refusal: removing the
-- tenant would leave enrolled mailboxes the engine can no longer reach, and
-- their partners' mail unread in their inboxes. Take them out of warmup first.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.microsoft_tenant_remove(p_tenant UUID, p_actor UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret UUID;
BEGIN
  SELECT vault_secret_id INTO v_secret
    FROM public.microsoft_tenants
   WHERE id = p_tenant AND removed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'microsoft_tenant_not_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.email_campaigns WHERE tenant_id = p_tenant AND status = 'running'
  ) THEN
    RAISE EXCEPTION 'microsoft_tenant_in_use';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.email_warmup_mailboxes
     WHERE tenant_id = p_tenant AND status <> 'removed'
  ) THEN
    RAISE EXCEPTION 'microsoft_tenant_warming';
  END IF;

  -- Overwritten first, with the same call the credentials were written by, so
  -- they are gone even where this role may not delete from the Vault; then
  -- deleted outright where it may.
  IF v_secret IS NOT NULL THEN
    PERFORM vault.update_secret(v_secret, '{}');
  END IF;
  BEGIN
    DELETE FROM vault.secrets
     WHERE id = v_secret OR name = 'microsoft_tenant_' || p_tenant::TEXT;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'microsoft_tenant_remove: Vault secret overwritten, not deleted (%)', SQLERRM;
  END;

  UPDATE public.microsoft_tenants
     SET vault_secret_id = NULL,
         removed_at = now(),
         removed_by = p_actor,
         updated_at = now()
   WHERE id = p_tenant;
END;
$$;

REVOKE ALL ON FUNCTION public.microsoft_tenant_remove(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.microsoft_tenant_remove(UUID, UUID) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- The engine's schedule
--
-- Every two minutes: warmup is paced in minutes, not seconds, and pg_cron here
-- already runs eleven every-minute jobs on six workers (20261012110000), so
-- this asks for half a slot rather than a whole one. The pass stops starting
-- work after about 85 seconds; the HTTP call is given 115, as the campaign
-- dispatcher's is, so a send in flight is never cancelled by its caller
-- hanging up. The secret is read from the vault INSIDE the command string, per
-- `check-cron-auth.mjs`.
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

  PERFORM cron.unschedule('email-warmup-2min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-warmup-2min');

  PERFORM cron.schedule(
    'email-warmup-2min',
    '*/2 * * * *',
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
      v_base || '/hooks/email-warmup'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'email warmup engine NOT scheduled (%).', SQLERRM;
END $$;
