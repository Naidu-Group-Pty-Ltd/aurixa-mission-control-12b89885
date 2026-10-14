-- @asserts column:email_campaigns.unsubscribe_token
--
-- Email campaigns: an unsubscribe link a message to many people can carry.
-- See docs/EMAIL_CAMPAIGNS.md, "Unsubscribing".
--
-- `{{unsubscribe_url}}` was a per-recipient field: each contact's link carries
-- a token minted for that one address, so a message holding it could only go
-- to one person — forty people in one BCC line cannot share one person's
-- unsubscribe link. A campaign sending fifty contacts to a message therefore
-- had to choose between its batch size and its unsubscribe facility, which a
-- commercial message in Australia is not allowed to go without.
--
-- This token is the campaign's own. A message carrying several contacts links
-- to `/api/public/email/unsubscribe?c=<token>`, where the reader confirms the
-- address the message was sent to; the address is removed only if this
-- campaign has it, and the page answers the same either way, so the link
-- cannot be used to learn who is on the list. A message to one contact still
-- carries that contact's own one-click link.
--
-- Minted like the recipient tokens — two v4 UUIDs rather than pgcrypto, so the
-- corpus replays where that extension is absent. The default is volatile, so
-- every existing campaign gets a token of its own.

ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT NOT NULL DEFAULT
    (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

COMMENT ON COLUMN public.email_campaigns.unsubscribe_token IS
  'The campaign''s shared unsubscribe link, carried by messages to several contacts. The reader confirms their address; it is removed only if this campaign has it.';

CREATE UNIQUE INDEX IF NOT EXISTS email_campaigns_unsubscribe_token_idx
  ON public.email_campaigns (unsubscribe_token);
