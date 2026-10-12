-- @asserts table:email_campaign_attachments
-- @asserts column:email_campaign_messages.attachments
-- @asserts column:email_campaign_messages.attachment_count
-- @asserts column:email_campaign_messages.attachment_bytes
-- @asserts column:email_campaign_messages.graph_draft_id
-- @asserts table:email_campaign_sending_mailboxes
--
-- Email campaigns: files that travel with the message, and a sending mailbox
-- chosen from the tenant rather than fixed to MICROSOFT_MAILBOX_EMAIL.
-- See docs/EMAIL_CAMPAIGNS.md, "Attachments" and "Choosing the mailbox".
--
-- ## Attachments
--
-- One row per file a campaign sends with every message. The file itself goes
-- from the browser straight to the `email-attachments` bucket — the same shape
-- as a contact list, for the same reason: a file routed through the Worker
-- meets the Worker's request-body ceiling, which is the smallest number in the
-- path and not raiseable from here.
--
-- `sha256` is computed by the SERVER when the upload is registered, from the
-- bytes it reads back, never taken from the browser. The dispatcher re-hashes
-- what it downloads before anything is claimed and refuses to send on a
-- mismatch: a message that has gone cannot be recalled, so the file it carries
-- has to be the file the operator looked at. The bucket grants no UPDATE, so
-- an object cannot be replaced in place; the hash is the second wall.
--
-- A removed attachment loses its ROW, not necessarily its FILE. Every message
-- snapshots what it carried (`email_campaign_messages.attachments`, below),
-- and the stored object is deleted only when no message carried it — a file
-- that went to customers is the record of what they received.
--
-- ## The message snapshot
--
-- `attachments` is what one message actually carried, written before the
-- send. It is a snapshot rather than a link table because it describes a
-- message that has already left: an attachment removed later must not change
-- the record of what an earlier message held.
--
-- `graph_draft_id` is set only when the message was built as a draft (files
-- too large for one `sendMail` request). If such a send ends `unconfirmed`,
-- that id is what lets a person look in the mailbox's Drafts folder: a draft
-- still there was never sent.
--
-- ## Sending mailboxes
--
-- Once a campaign may send from any mailbox the tenant permits, the bounce
-- scan has to read every mailbox that has actually sent — not only the ones
-- campaigns name today. A campaign moved from mailbox A to mailbox B still has
-- bounces arriving in A for days. The view answers "which mailboxes sent, and
-- when last" from the message ledger, which is the only place a send is
-- recorded. `security_invoker`, like the recipient counts, so it publishes
-- nothing the message table's own policies would not.

-- ─────────────────────────────────────────────────────────────────────────────
-- Attachments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_campaign_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  -- 20 MB: the per-campaign ceiling, so also the largest any one file can be.
  -- A message carries every attachment, and a receiving server that refuses
  -- 25 MB refuses the whole message, not the attachment.
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  -- `<campaign id>/<attachment id>/<safe name>` in `email-attachments`.
  storage_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- What an HTML body writes as `cid:<content_id>` to show an image inline. A
  -- file the body references this way is sent inline; any other file is an
  -- ordinary attachment. Derived from the file name, unique per campaign.
  content_id TEXT NOT NULL CHECK (content_id ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  position INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, content_id)
);

COMMENT ON TABLE public.email_campaign_attachments IS
  'A file sent with every message of a campaign. The bytes live in the email-attachments bucket; sha256 is the server''s own hash of them, re-checked by the dispatcher before anything is claimed.';
COMMENT ON COLUMN public.email_campaign_attachments.content_id IS
  'Referenced from an HTML body as cid:<content_id> to show the file inline. Unreferenced files are sent as ordinary attachments.';

CREATE INDEX IF NOT EXISTS email_campaign_attachments_campaign_idx
  ON public.email_campaign_attachments (campaign_id, position);

ALTER TABLE public.email_campaign_attachments ENABLE ROW LEVEL SECURITY;

-- Written through operator-gated server functions holding the caller's token,
-- so this policy is the real authorisation. Deleting a row never deletes a
-- file that went out: that decision is the server function's, made against
-- the message snapshots, and the bucket below grants operators no DELETE.
DROP POLICY IF EXISTS "Operators manage campaign attachments" ON public.email_campaign_attachments;
CREATE POLICY "Operators manage campaign attachments"
  ON public.email_campaign_attachments FOR ALL TO authenticated
  USING (public.is_operator(auth.uid()))
  WITH CHECK (public.is_operator(auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- What a message carried
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.email_campaign_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS attachment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attachment_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_draft_id TEXT;

COMMENT ON COLUMN public.email_campaign_messages.attachments IS
  'Snapshot of the files this message carried: id, file name, content type, size, sha256, storage path and whether it was inline. Written before the send, never edited.';
COMMENT ON COLUMN public.email_campaign_messages.graph_draft_id IS
  'Set when the message was built as a draft because its files were too large for one sendMail request. For an unconfirmed send, a draft still in the Drafts folder was never sent.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Every mailbox that has sent
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.email_campaign_sending_mailboxes
WITH (security_invoker = true) AS
SELECT
  lower(mailbox) AS mailbox,
  max(queued_at) AS last_used_at,
  count(*)::BIGINT AS messages
FROM public.email_campaign_messages
WHERE mailbox IS NOT NULL
GROUP BY lower(mailbox);

COMMENT ON VIEW public.email_campaign_sending_mailboxes IS
  'Each mailbox a campaign message has left from, and when last. The bounce scan reads every one used recently, so moving a campaign to another mailbox does not stop its bounces being read. Reads with the caller''s own rights.';

GRANT SELECT ON public.email_campaign_sending_mailboxes TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The bucket
--
-- Private, and no `allowed_mime_types` — a PDF arrives labelled whatever the
-- operator's browser decided, and the dispatcher sends the type recorded at
-- registration. The size limit matches the per-campaign ceiling above. The
-- project-level "Upload file size limit" is a separate setting and the lower
-- of the two wins.
--
-- No UPDATE policy: an object cannot be replaced in place, so a path names one
-- set of bytes for its whole life. No DELETE for operators either — the server
-- removes a file with the service role, and only when no message carried it.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('email-attachments', 'email-attachments', false, 20971520, NULL)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public = false;

DROP POLICY IF EXISTS "Operators read email attachment files" ON storage.objects;
CREATE POLICY "Operators read email attachment files"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'email-attachments' AND public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Operators write email attachment files" ON storage.objects;
CREATE POLICY "Operators write email attachment files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'email-attachments' AND public.is_operator(auth.uid()));

DROP POLICY IF EXISTS "Admins delete email attachment files" ON storage.objects;
CREATE POLICY "Admins delete email attachment files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'email-attachments' AND public.is_admin(auth.uid()));
