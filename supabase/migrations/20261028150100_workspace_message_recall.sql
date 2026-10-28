-- @asserts column:clone_announcements.recalled_at
-- @asserts column:clone_announcement_deliveries.withdrawn_at
--
-- Recall (docs/CLONE_WORKSPACE_MESSAGES.md, "Recall"): the operator's way to
-- withdraw a message that went out wrong, asked for by the owner on
-- 28 Oct 2026.
--
-- Archive already takes a message down, but it files it away as finished.
-- Recall says "this should not have gone out": the message comes down from
-- every dashboard at once and returns to the operator as a draft marked
-- recalled, to be corrected and sent again or archived.
--
--   1. `recalled_at` — when it was recalled. A recalled message is unpublished
--      (`published_at` null), so every reader that serves only published
--      messages already stops serving it. The CHECK keeps the state
--      unambiguous: a message cannot be both recalled and out. Publishing it
--      again clears the stamp; the audit log keeps the history.
--   2. `withdrawn_at` on a delivery stamp — evidence of effect, the stamp's
--      own rule. When a workspace that had fetched the message next fetches
--      after the recall, its answer no longer holds it, and this records when.
--      The console says "withdrawn from 2 of 3" from these, not from the act
--      having been taken.
--
-- Additive. Every existing row reads exactly as it did: never recalled,
-- nothing withdrawn.

alter table public.clone_announcements
  add column if not exists recalled_at timestamp with time zone;

alter table public.clone_announcements
  drop constraint if exists clone_announcements_recalled_is_unpublished;
alter table public.clone_announcements
  add constraint clone_announcements_recalled_is_unpublished
  check (recalled_at is null or published_at is null);

comment on column public.clone_announcements.recalled_at is
  'When an operator recalled the message: withdrawn from every workspace and returned to the drafts, to be corrected and sent again. Null once it is published again.';

alter table public.clone_announcement_deliveries
  add column if not exists withdrawn_at timestamp with time zone;

comment on column public.clone_announcement_deliveries.withdrawn_at is
  'When the workspace first fetched after the message was recalled, so its dashboards were answered without it. Cleared when the message is delivered again.';
