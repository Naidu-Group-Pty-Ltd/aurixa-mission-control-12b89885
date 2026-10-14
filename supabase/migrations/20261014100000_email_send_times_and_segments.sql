-- @asserts column:email_campaigns.send_times
-- @asserts column:email_campaigns.slot_grace_minutes
-- @asserts column:email_campaigns.max_messages_per_slot
-- @asserts column:email_campaigns.segment_dimension
-- @asserts column:email_campaigns.segment_messages_per_slot
-- @asserts table:email_campaign_segments
-- @asserts column:email_campaign_messages.segment_id
-- @asserts column:email_campaign_messages.segment_label
-- @asserts column:email_campaign_messages.slot_at
--
-- Email campaigns: sending at set times, and one message per segment of the
-- list. See docs/EMAIL_CAMPAIGNS.md, "Sending times and segments".
--
-- The shape this is for: Monday to Saturday at 09:00, 13:00, 15:00 and 17:00
-- Sydney, fifty contacts to a message, and at each of those times one message
-- for each of six states read from the uploaded list's State column. Before
-- this, a campaign had a window and a gap — it could not send at 09:00 and
-- 17:00 without sending at 11:00 too — and a fifty-contact batch was the next
-- fifty rows of the file, every state mixed into one message.
--
-- ## Sending times
--
-- `send_times`: the times of day a batch goes out, in the campaign's own zone.
-- Empty keeps the window (`window_start`/`window_end`) in charge, so every
-- campaign that exists today behaves exactly as it did.
--
-- `slot_grace_minutes`: how long each time stays open. The dispatcher is not
-- called on the minute — pg_net delivers its ticks in bursts a minute and a
-- half apart, and about one cron start in eleven never happens (see
-- 20261012110000) — so the 09:00 batch has to still be sendable at 09:03. A
-- time never stays open past the next one: a scheduler that stalls loses a
-- batch rather than sending two at once.
--
-- `max_messages_per_slot`: the most one sending time may carry, across every
-- segment. Null is no limit beyond the daily caps.
--
-- ## Segments
--
-- `segment_dimension`: a column of the uploaded list (its parsed key, e.g.
-- `state`) that every message is confined to. Null is no segmentation.
--
-- `email_campaign_segments`: the values that make up each segment. A SET of
-- normalised values per segment, like a quota, because a real list spells one
-- state several ways and nothing here rewrites anybody's data. A value belongs
-- to at most one segment of a campaign; the operator's API refuses overlap.
--
-- `segment_messages_per_slot`: each segment's share of one sending time.
--
-- ## What a message records
--
-- `segment_id`, `segment_label` and `slot_at` say which segment a message
-- went to and which sending time it belonged to. "Has NSW had its 09:00
-- message today" is answered by counting these rows, never by a counter: the
-- ledger is the one place a send is recorded, so a count taken from it cannot
-- disagree with what went. The label is a snapshot, so a segment renamed or
-- removed later does not change the record of who a message was for.

-- ─────────────────────────────────────────────────────────────────────────────
-- The calendar and the segmentation, on the campaign
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS send_times TIME[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(send_times) <= 24),
  ADD COLUMN IF NOT EXISTS slot_grace_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (slot_grace_minutes BETWEEN 1 AND 720),
  ADD COLUMN IF NOT EXISTS max_messages_per_slot INTEGER
    CHECK (max_messages_per_slot IS NULL OR max_messages_per_slot > 0),
  ADD COLUMN IF NOT EXISTS segment_dimension TEXT
    CHECK (segment_dimension IS NULL OR segment_dimension ~ '^[a-z][a-z0-9_]*$'),
  ADD COLUMN IF NOT EXISTS segment_messages_per_slot INTEGER NOT NULL DEFAULT 1
    CHECK (segment_messages_per_slot BETWEEN 1 AND 100);

COMMENT ON COLUMN public.email_campaigns.send_times IS
  'Times of day, in the campaign''s zone, at which a batch goes out. Empty means the window decides instead.';
COMMENT ON COLUMN public.email_campaigns.slot_grace_minutes IS
  'How long each sending time stays open for its batch. Never past the next sending time, so a missed batch is lost rather than doubled.';
COMMENT ON COLUMN public.email_campaigns.max_messages_per_slot IS
  'The most messages one sending time may carry, across every segment. Null is no limit beyond the daily caps.';
COMMENT ON COLUMN public.email_campaigns.segment_dimension IS
  'The parsed list column every message is confined to: each message goes to contacts sharing one segment of it. Null is no segmentation.';
COMMENT ON COLUMN public.email_campaigns.segment_messages_per_slot IS
  'Messages each segment may have at one sending time.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Segments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaign_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  -- Normalised values (`attributes_norm`) this segment covers.
  match_values TEXT[] NOT NULL CHECK (cardinality(match_values) > 0),
  position INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, label)
);

COMMENT ON TABLE public.email_campaign_segments IS
  'One segment of a segmented campaign: the values of its segment column that a message to this segment may go to. Disjoint within a campaign.';

DROP TRIGGER IF EXISTS email_campaign_segments_updated_at ON public.email_campaign_segments;
CREATE TRIGGER email_campaign_segments_updated_at
  BEFORE UPDATE ON public.email_campaign_segments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.email_campaign_segments ENABLE ROW LEVEL SECURITY;

-- Written through operator-gated server functions holding the caller's token,
-- so this policy is the real authorisation. The dispatcher reads with the
-- service role.
DROP POLICY IF EXISTS "Operators manage campaign segments" ON public.email_campaign_segments;
CREATE POLICY "Operators manage campaign segments"
  ON public.email_campaign_segments FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Which segment, and which sending time, a message was for
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_campaign_messages
  ADD COLUMN IF NOT EXISTS segment_id UUID
    REFERENCES public.email_campaign_segments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS segment_label TEXT,
  ADD COLUMN IF NOT EXISTS slot_at TIMESTAMPTZ;

COMMENT ON COLUMN public.email_campaign_messages.segment_id IS
  'The segment this message went to. Counted per sending time to decide whether that segment has had its share.';
COMMENT ON COLUMN public.email_campaign_messages.segment_label IS
  'The segment''s label when the message was sent, kept if the segment is renamed or removed.';
COMMENT ON COLUMN public.email_campaign_messages.slot_at IS
  'The sending time this message belonged to — the instant it names, e.g. Tuesday 13:00 Sydney. Null for a campaign sending across a window.';

CREATE INDEX IF NOT EXISTS email_campaign_messages_segment_idx
  ON public.email_campaign_messages (segment_id);
CREATE INDEX IF NOT EXISTS email_campaign_messages_slot_idx
  ON public.email_campaign_messages (campaign_id, slot_at);
