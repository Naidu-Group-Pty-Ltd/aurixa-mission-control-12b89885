-- @asserts table:email_campaigns
-- @asserts table:email_lists
-- @asserts table:email_list_contacts
-- @asserts table:email_campaign_recipients
-- @asserts table:email_campaign_messages
-- @asserts table:email_campaign_quotas
-- @asserts table:email_campaign_imports
-- @asserts table:email_suppressions
-- @asserts table:email_bounce_scans
-- @asserts rpc:email_import_list_into_campaign
-- @asserts table:email_campaign_recipient_counts
--
-- The email scheduler: an uploaded list, a ruleset, and a mailbox.
--
-- ## The two rules that may never be broken, and why they are HERE
--
-- The product has two hard rules — never send the same campaign to the same
-- address twice, and never send to an address that has bounced — and both of
-- them share a property that decides where they have to live: THERE IS NO
-- UNDO. A duplicate that a planner emits has already arrived by the time
-- anybody can look at it. So neither rule is allowed to be a condition in a
-- planning function, where a refactor, an added `OR`, or a second caller
-- retires it silently.
--
--   * "Never twice" is `unique (campaign_id, email_key)` on the recipient
--     ledger. There is exactly ONE row per (campaign, address), and sending is
--     a state transition ON that row: pending → claimed → sent. A second
--     delivery is not something the code declines to do — it is a row that
--     cannot exist. Re-importing the same list, importing an overlapping
--     second list, and two dispatcher ticks racing each other all resolve to
--     the same single row.
--
--   * "Never to a bouncer" is `email_suppressions`, checked three times over:
--     at import (a suppressed contact lands as `suppressed`, never `pending`),
--     at the wire (the dispatcher re-reads the register between claim and
--     send, because a bounce can arrive in between), and by the trigger below,
--     which refuses the claim itself. The trigger is the one that holds when
--     the other two are edited.
--
-- ## The state a send can leave behind
--
-- `sendMail` answers 202 with no body. A non-2xx BEFORE acceptance means no
-- message was created; a network failure AFTER the request left is ambiguous,
-- and the two must not be recorded as the same thing. `unconfirmed` is that
-- third state, and nothing automatically retries it: "we do not know whether
-- this arrived" resolved by resending is exactly the duplicate the first rule
-- exists to prevent. Releasing an unconfirmed recipient is an operator's
-- explicit act.
--
-- ## Why quota usage is counted and never stored
--
-- Per-parameter quotas ("no more than 20 a day to NSW") are answered by
-- counting sent rows in the ledger, not by a counter table a trigger
-- maintains. A counter is a second copy of a fact, and the failure it produces
-- — a count that drifts below the truth — spends somebody's daily allowance
-- twice with nothing reporting it. The ledger is the only place a send is
-- recorded, so a count taken from it cannot disagree with what was sent.

-- ─────────────────────────────────────────────────────────────────────────────
-- Campaigns
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'paused', 'completed', 'cancelled')),

  -- Identity of the send. NULL mailbox means "the deployment's configured
  -- mailbox", so a campaign does not silently pin an address that later moves.
  from_mailbox TEXT,
  from_name TEXT,
  reply_to TEXT,

  subject_template TEXT NOT NULL DEFAULT '',
  body_template TEXT NOT NULL DEFAULT '',
  body_format TEXT NOT NULL DEFAULT 'html' CHECK (body_format IN ('html', 'text')),

  -- ── The ruleset ──────────────────────────────────────────────────────────
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  -- ISO weekday numbers, 1 = Monday .. 7 = Sunday.
  send_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  window_start TIME NOT NULL DEFAULT '09:00',
  window_end TIME NOT NULL DEFAULT '17:00',
  -- NULL means unlimited on that axis. Messages and contacts are counted
  -- separately because they are different questions: one message carrying
  -- forty people is one message and forty contacts.
  max_messages_per_day INTEGER CHECK (max_messages_per_day IS NULL OR max_messages_per_day > 0),
  max_recipients_per_day INTEGER CHECK (max_recipients_per_day IS NULL OR max_recipients_per_day > 0),
  recipients_per_message INTEGER NOT NULL DEFAULT 1
    CHECK (recipients_per_message BETWEEN 1 AND 500),
  min_gap_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (min_gap_seconds >= 0 AND min_gap_seconds <= 86400),
  -- A ceiling on one dispatcher tick, so a campaign with no gap cannot spend
  -- the whole invocation budget and starve every other campaign.
  max_messages_per_run INTEGER NOT NULL DEFAULT 20
    CHECK (max_messages_per_run BETWEEN 1 AND 200),

  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,

  -- ── Observed ─────────────────────────────────────────────────────────────
  last_message_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  paused_reason TEXT,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_campaigns IS
  'One scheduled email campaign: the message, the mailbox it leaves from, and the ruleset that decides when and how fast it goes.';
COMMENT ON COLUMN public.email_campaigns.recipients_per_message IS
  'How many contacts share one message. Above 1 the extras travel as BCC and personalisation is refused, because a merge field can only be resolved for one reader.';
COMMENT ON COLUMN public.email_campaigns.min_gap_seconds IS
  'Floor on the interval between two messages of this campaign, honoured within a dispatcher tick as well as across ticks.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Uploaded lists and the contacts parsed out of them
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  file_name TEXT,
  -- Object path in the `email-lists` bucket. The raw file is retained whether
  -- or not the parse succeeded: what a column MEANT is a question you answer
  -- by opening the source, and a list that cannot be re-read is a list nobody
  -- can audit.
  file_path TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  checksum TEXT,
  source_format TEXT,
  status TEXT NOT NULL DEFAULT 'parsing'
    CHECK (status IN ('parsing', 'ready', 'failed')),
  row_count INTEGER NOT NULL DEFAULT 0,
  contact_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  email_column TEXT,
  -- One entry per discovered column: key, header as spelled, coverage, the
  -- distinct values and whether it is offerable as a quota dimension. This is
  -- a snapshot of one parse and is never queried across rows, so it is jsonb
  -- rather than a table.
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  parse_error TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_lists IS
  'An uploaded contact list: the stored source file, what the parse made of it, and the columns it offers as campaign parameters.';

CREATE TABLE IF NOT EXISTS public.email_list_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES public.email_lists(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  -- The address lowercased and trimmed. Every identity question in this
  -- feature is asked of this column and never of `email`, because
  -- `Bob@Example.com` and `bob@example.com` are one person and a rule that
  -- cannot see that is a rule that mails them twice.
  email_key TEXT NOT NULL,
  row_number INTEGER,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The same map with values trimmed, whitespace-collapsed and case-folded.
  -- Quotas match against this; merge fields render from `attributes`, so what
  -- a reader sees is what the spreadsheet said.
  attributes_norm JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (list_id, email_key)
);

COMMENT ON TABLE public.email_list_contacts IS
  'One parsed row of an uploaded list, deduplicated by normalised address within that list.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Messages, then the recipient ledger that points at them
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaign_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'failed', 'unconfirmed')),
  subject TEXT NOT NULL,
  body_preview TEXT,
  mailbox TEXT,
  to_address TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  bcc_count INTEGER NOT NULL DEFAULT 0,
  graph_status INTEGER,
  graph_request_id TEXT,
  error TEXT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  duration_ms INTEGER
);

COMMENT ON TABLE public.email_campaign_messages IS
  'One message handed to Microsoft Graph. A message may carry many recipients; a recipient belongs to at most one message.';
COMMENT ON COLUMN public.email_campaign_messages.status IS
  'sent = Graph accepted it. failed = Graph refused it before accepting, so no message exists. unconfirmed = the request left and the answer never arrived, which is not a licence to send it again.';

CREATE TABLE IF NOT EXISTS public.email_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  list_id UUID REFERENCES public.email_lists(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  email_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'unconfirmed', 'suppressed', 'cancelled')),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributes_norm JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL DEFAULT 0,
  message_id UUID REFERENCES public.email_campaign_messages(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  suppressed_reason TEXT,
  -- Per-recipient, so withdrawing one person's link never touches anybody
  -- else's. Two v4 UUIDs rather than pgcrypto's gen_random_bytes: the corpus
  -- must replay on a database where that extension has not been installed.
  unsubscribe_token TEXT NOT NULL DEFAULT
    (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- THE RULE. One row per address per campaign, so a second delivery is not
  -- declined — it is unrepresentable.
  UNIQUE (campaign_id, email_key)
);

COMMENT ON TABLE public.email_campaign_recipients IS
  'The campaign ledger: exactly one row per (campaign, normalised address), carrying that address''s entire history in this campaign. The unique constraint is what makes a duplicate send impossible rather than merely unlikely.';

CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_recipients_unsub_idx
  ON public.email_campaign_recipients (unsubscribe_token);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_queue_idx
  ON public.email_campaign_recipients (campaign_id, status, position);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_sent_idx
  ON public.email_campaign_recipients (campaign_id, status, sent_at);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_list_idx
  ON public.email_campaign_recipients (list_id);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_message_idx
  ON public.email_campaign_recipients (message_id);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_key_idx
  ON public.email_campaign_recipients (email_key);

CREATE INDEX IF NOT EXISTS email_campaign_messages_campaign_idx
  ON public.email_campaign_messages (campaign_id, queued_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-parameter quotas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaign_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  -- The normalised column key discovered by the parse, e.g. `state`.
  dimension TEXT NOT NULL,
  -- The header as the spreadsheet spelled it, e.g. `State/Territory`.
  dimension_label TEXT NOT NULL,
  -- Normalised values this rule covers. A SET rather than a value, because a
  -- real list spells one thing several ways — `NSW` and `New South Wales` are
  -- one allowance and the operator says so explicitly rather than the product
  -- guessing and rewriting their data.
  match_values TEXT[] NOT NULL CHECK (cardinality(match_values) > 0),
  value_label TEXT NOT NULL,
  max_per_day INTEGER CHECK (max_per_day IS NULL OR max_per_day > 0),
  max_total INTEGER CHECK (max_total IS NULL OR max_total > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_campaign_quotas_has_limit
    CHECK (max_per_day IS NOT NULL OR max_total IS NOT NULL)
);

COMMENT ON TABLE public.email_campaign_quotas IS
  'A cap on one value of one parsed column, e.g. at most 20 a day to State = NSW. Several rules may cover the same contact; the strictest binds, and none of them can lift a global cap.';

CREATE INDEX IF NOT EXISTS email_campaign_quotas_campaign_idx
  ON public.email_campaign_quotas (campaign_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- What one import actually did
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaign_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  -- Nullable, and SET NULL rather than CASCADE. A list is an upload; deleting
  -- one is tidying up, and it must not take with it the record of what a
  -- campaign received — the campaign's own recipients are still there, still
  -- carrying the attributes that came from it.
  list_id UUID REFERENCES public.email_lists(id) ON DELETE SET NULL,
  -- Snapshotted at import, for the same reason. The column profile is what
  -- decides which merge fields resolve and which parameters may be capped, so
  -- reading it through the list makes both of those answers depend on a row an
  -- operator is entitled to delete: the campaign then reports its own template
  -- as unsupported and its parameters as absent, with nothing naming the cause.
  list_name TEXT,
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  email_column TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  skipped_duplicate INTEGER NOT NULL DEFAULT 0,
  skipped_suppressed INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_campaign_imports IS
  'Why 5,000 uploaded rows became 4,812 recipients, and what columns came with them. An import that silently loses rows is indistinguishable from a parse that never read them.';

CREATE INDEX IF NOT EXISTS email_campaign_imports_campaign_idx
  ON public.email_campaign_imports (campaign_id);
CREATE INDEX IF NOT EXISTS email_campaign_imports_list_idx
  ON public.email_campaign_imports (list_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- The do-not-send register
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_suppressions (
  email_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  reason TEXT NOT NULL
    CHECK (reason IN ('bounced', 'complaint', 'unsubscribed', 'invalid', 'manual')),
  detail TEXT,
  source TEXT NOT NULL
    CHECK (source IN ('bounce_scan', 'unsubscribe_link', 'operator', 'import')),
  -- Where it was learned. Deliberately not a scope: a bounce is a fact about
  -- the address, so it stops every campaign, not the one that found it.
  campaign_id UUID REFERENCES public.email_campaigns(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrences INTEGER NOT NULL DEFAULT 1,
  created_by UUID
);

COMMENT ON TABLE public.email_suppressions IS
  'Addresses this deployment will not mail, keyed by normalised address and global across every campaign. A soft (4.x.x) failure is deliberately NOT recorded here — a full mailbox is not a wrong address.';

CREATE INDEX IF NOT EXISTS email_suppressions_campaign_idx
  ON public.email_suppressions (campaign_id);
CREATE INDEX IF NOT EXISTS email_suppressions_seen_idx
  ON public.email_suppressions (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.email_bounce_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  messages_examined INTEGER NOT NULL DEFAULT 0,
  reports_found INTEGER NOT NULL DEFAULT 0,
  addresses_suppressed INTEGER NOT NULL DEFAULT 0,
  soft_failures INTEGER NOT NULL DEFAULT 0,
  -- High-water mark of `receivedDateTime` this run consumed. The next run
  -- resumes from the newest mark a SUCCEEDED run left, so a failed run
  -- re-reads its window instead of stepping over it.
  cursor_at TIMESTAMPTZ,
  error TEXT
);

COMMENT ON TABLE public.email_bounce_scans IS
  'Each pass over the sending mailbox looking for delivery-status reports. Without this the never-mail-a-bouncer rule has no source of bounces and never fires.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The guard
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_recipient_send_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A suppressed address may not be claimed for sending. The dispatcher checks
  -- this too, immediately before the wire; this is the copy that survives the
  -- dispatcher being rewritten.
  IF NEW.status IN ('claimed', 'sent')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND EXISTS (SELECT 1 FROM public.email_suppressions s WHERE s.email_key = NEW.email_key)
  THEN
    RAISE EXCEPTION 'email_suppressed: % is on the do-not-send register', NEW.email
      USING ERRCODE = 'check_violation';
  END IF;

  -- `sent` is terminal. Returning a sent row to the queue is the only way the
  -- unique constraint above can be defeated, so it is refused here rather than
  -- left to whoever writes the next retry loop.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'sent'
     AND NEW.status IN ('pending', 'claimed')
  THEN
    RAISE EXCEPTION 'email_resend_blocked: campaign % has already sent to %', NEW.campaign_id, NEW.email
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.email_recipient_send_guard() IS
  'Refuses to let a suppressed address be claimed, and refuses to return a sent recipient to the queue. Both rules have no undo, so neither is left to application code alone.';

DROP TRIGGER IF EXISTS email_recipient_send_guard_trg ON public.email_campaign_recipients;
CREATE TRIGGER email_recipient_send_guard_trg
  BEFORE INSERT OR UPDATE ON public.email_campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION public.email_recipient_send_guard();

DROP TRIGGER IF EXISTS email_campaigns_updated_at ON public.email_campaigns;
CREATE TRIGGER email_campaigns_updated_at
  BEFORE UPDATE ON public.email_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS email_lists_updated_at ON public.email_lists;
CREATE TRIGGER email_lists_updated_at
  BEFORE UPDATE ON public.email_lists
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS email_campaign_quotas_updated_at ON public.email_campaign_quotas;
CREATE TRIGGER email_campaign_quotas_updated_at
  BEFORE UPDATE ON public.email_campaign_quotas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────────
-- Import: one statement, so a half-imported list cannot exist
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.email_import_list_into_campaign(
  p_campaign UUID,
  p_list UUID
)
RETURNS TABLE (imported INTEGER, skipped_duplicate INTEGER, skipped_suppressed INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total INTEGER;
  v_pending INTEGER;
  v_suppressed INTEGER;
BEGIN
  -- SECURITY DEFINER, so the caller's authorisation is asserted rather than
  -- assumed. Reached only from an operator-gated server function holding the
  -- user's own token.
  IF NOT public.is_operator(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden_operator_required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.email_list_contacts c
  WHERE c.list_id = p_list;

  WITH src AS (
    SELECT
      c.email,
      c.email_key,
      c.attributes,
      c.attributes_norm,
      COALESCE(c.row_number, 0) AS ordinal,
      s.reason AS suppressed_reason
    FROM public.email_list_contacts c
    LEFT JOIN public.email_suppressions s ON s.email_key = c.email_key
    WHERE c.list_id = p_list
  ), ins AS (
    INSERT INTO public.email_campaign_recipients
      (campaign_id, list_id, email, email_key, attributes, attributes_norm, position, status, suppressed_reason)
    SELECT
      p_campaign,
      p_list,
      src.email,
      src.email_key,
      src.attributes,
      src.attributes_norm,
      src.ordinal,
      CASE WHEN src.suppressed_reason IS NULL THEN 'pending' ELSE 'suppressed' END,
      src.suppressed_reason
    FROM src
    ON CONFLICT (campaign_id, email_key) DO NOTHING
    RETURNING status
  )
  SELECT
    count(*) FILTER (WHERE ins.status = 'pending')::INTEGER,
    count(*) FILTER (WHERE ins.status = 'suppressed')::INTEGER
  INTO v_pending, v_suppressed
  FROM ins;

  imported := COALESCE(v_pending, 0);
  skipped_suppressed := COALESCE(v_suppressed, 0);
  -- Everything the list held that produced no new row: already a recipient of
  -- this campaign, whether from this list or another one.
  skipped_duplicate := GREATEST(v_total - COALESCE(v_pending, 0) - COALESCE(v_suppressed, 0), 0);

  INSERT INTO public.email_campaign_imports
    (campaign_id, list_id, list_name, columns, email_column,
     imported, skipped_duplicate, skipped_suppressed, created_by)
  SELECT
    p_campaign, p_list, l.name, l.columns, l.email_column,
    imported, skipped_duplicate, skipped_suppressed, auth.uid()
  FROM public.email_lists l
  WHERE l.id = p_list;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.email_import_list_into_campaign(UUID, UUID) IS
  'Copy a parsed list into a campaign''s ledger in one statement: suppressed contacts land suppressed, addresses the campaign already holds are left alone, and the counts are recorded so the shortfall is explained rather than noticed.';

REVOKE ALL ON FUNCTION public.email_import_list_into_campaign(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.email_import_list_into_campaign(UUID, UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
--
-- Every write from the browser travels through an operator-gated server
-- function holding the CALLER'S token, not the service role, so these policies
-- are the real authorisation and not a formality. The dispatcher and the bounce
-- scan hold the service role and bypass them.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_list_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaign_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaign_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaign_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_bounce_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Operators manage email campaigns" ON public.email_campaigns;
CREATE POLICY "Operators manage email campaigns"
  ON public.email_campaigns FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators manage email lists" ON public.email_lists;
CREATE POLICY "Operators manage email lists"
  ON public.email_lists FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators manage email list contacts" ON public.email_list_contacts;
CREATE POLICY "Operators manage email list contacts"
  ON public.email_list_contacts FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

-- Recipients are readable and correctable by an operator (cancel one, release
-- an unconfirmed one) but never insertable by hand: the only way into this
-- ledger is the import function, which is where the suppression check and the
-- dedupe live.
DROP POLICY IF EXISTS "Operators read campaign recipients" ON public.email_campaign_recipients;
CREATE POLICY "Operators read campaign recipients"
  ON public.email_campaign_recipients FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators correct campaign recipients" ON public.email_campaign_recipients;
CREATE POLICY "Operators correct campaign recipients"
  ON public.email_campaign_recipients FOR UPDATE TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators delete campaign recipients" ON public.email_campaign_recipients;
CREATE POLICY "Operators delete campaign recipients"
  ON public.email_campaign_recipients FOR DELETE TO authenticated
  USING (public.is_operator(auth.uid()));

-- A message is a record of something that happened. Nothing in the browser
-- writes one.
DROP POLICY IF EXISTS "Operators read campaign messages" ON public.email_campaign_messages;
CREATE POLICY "Operators read campaign messages"
  ON public.email_campaign_messages FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators manage campaign quotas" ON public.email_campaign_quotas;
CREATE POLICY "Operators manage campaign quotas"
  ON public.email_campaign_quotas FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators read campaign imports" ON public.email_campaign_imports;
CREATE POLICY "Operators read campaign imports"
  ON public.email_campaign_imports FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

-- Adding somebody to the register is safe and any operator may do it. Removing
-- them is the act that can put mail back on the wire to an address that
-- already bounced, so it is an admin's.
DROP POLICY IF EXISTS "Operators read suppressions" ON public.email_suppressions;
CREATE POLICY "Operators read suppressions"
  ON public.email_suppressions FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators add suppressions" ON public.email_suppressions;
CREATE POLICY "Operators add suppressions"
  ON public.email_suppressions FOR INSERT TO authenticated
  WITH CHECK (public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins update suppressions" ON public.email_suppressions;
CREATE POLICY "Admins update suppressions"
  ON public.email_suppressions FOR UPDATE TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admins delete suppressions" ON public.email_suppressions;
CREATE POLICY "Admins delete suppressions"
  ON public.email_suppressions FOR DELETE TO authenticated
  USING (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Operators read bounce scans" ON public.email_bounce_scans;
CREATE POLICY "Operators read bounce scans"
  ON public.email_bounce_scans FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- How many recipients are in each state
--
-- A list of forty campaigns needs one number per state per campaign, and the
-- only honest source is the ledger. Reading it row by row to count is what a
-- first version did: `select campaign_id, status` over every recipient of every
-- campaign on the page, which is fine at a thousand contacts and transfers four
-- million rows at a hundred thousand — to produce about two hundred numbers.
--
-- `security_invoker = true` so the recipient table's own policies decide what a
-- caller sees. A view that reads with the owner's rights is a way to publish a
-- table's contents past its RLS, one aggregate at a time.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.email_campaign_recipient_counts
WITH (security_invoker = true) AS
SELECT
  campaign_id,
  status,
  count(*)::BIGINT AS recipients
FROM public.email_campaign_recipients
GROUP BY campaign_id, status;

COMMENT ON VIEW public.email_campaign_recipient_counts IS
  'Recipients per (campaign, status). Reads with the caller''s own rights, so it publishes nothing the recipient table would not.';

GRANT SELECT ON public.email_campaign_recipient_counts TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The bucket
--
-- No `allowed_mime_types`: a contact list arrives as whatever the sender's
-- tooling produced — text/csv, application/vnd.ms-excel, octet-stream from a
-- browser that recognised nothing — and refusing the upload on a MIME string
-- rejects files this parser can read perfectly well. The format is decided by
-- reading the bytes, not by trusting the label.
--
-- `file_size_limit` is set to the largest value Supabase accepts per object.
-- The project-level ceiling (Storage → Settings → Upload file size limit) is a
-- separate setting and the LOWER of the two wins, so raising this alone does
-- not raise the effective limit.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('email-lists', 'email-lists', false, 53687091200, NULL)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "Operators read email list files" ON storage.objects;
CREATE POLICY "Operators read email list files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'email-lists' AND public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators write email list files" ON storage.objects;
CREATE POLICY "Operators write email list files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'email-lists' AND public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators update email list files" ON storage.objects;
CREATE POLICY "Operators update email list files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'email-lists' AND public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins delete email list files" ON storage.objects;
CREATE POLICY "Admins delete email list files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'email-lists' AND public.is_admin(auth.uid()));
