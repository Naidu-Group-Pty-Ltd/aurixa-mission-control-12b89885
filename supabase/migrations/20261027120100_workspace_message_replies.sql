-- @asserts table:clone_announcement_replies
-- @asserts column:clone_announcements.replies_enabled
-- @asserts column:clone_announcements.audience_match
-- @asserts column:clone_announcements.client_request_id
-- @asserts column:clone_announcement_deliveries.seen_count
-- @asserts check:clone_announcements.audience_match=any
-- @asserts check:clone_announcement_replies.direction=operator
--
-- Workspace messages, second pass (docs/CLONE_WORKSPACE_MESSAGES.md).
--
-- Measured 27 Oct 2026, before this migration: three messages in
-- `clone_announcements` and NO row in `clone_announcement_deliveries`, ever.
-- Two causes, neither of them the matcher:
--
--   * The prime could not be addressed. Its key carries no clone, and the
--     public route answered that key an empty list by design — 181 polls a day
--     from the dashboard the operator's own staff work in, each told "nothing".
--     The console's workspace list held only clones, so there was no way to
--     send it anything either.
--   * The one workspace the October messages were addressed to (NPC Client
--     Dashboard) had no staff session open its dashboard: its last gate check
--     from a browser was 20 Sep 2026, and its only browser traffic since is a
--     sign-in probe that never reaches the dashboard. A message nobody's
--     dashboard asks for is, correctly, "not yet fetched".
--
-- What this adds:
--
--   1. `replies_enabled` — a message is either an announcement (no reply, the
--      default and every existing row) or a conversation a workspace's staff
--      can answer. Replies are stored here, one thread per (message,
--      workspace), and a workspace is only ever served its own thread.
--   2. `audience_match` — how a plan list and a workspace list combine. 'all'
--      (the default, and every existing row) is the matcher's original AND;
--      'any' reaches a workspace on a chosen plan OR a chosen workspace, which
--      is what the console's "Selected workspaces" now builds when both are
--      picked. Existing rows keep the reach they have.
--   3. `client_request_id` — Send now creates and publishes in one act. A
--      double click, or a retry after a timeout, carries the same id and finds
--      the first row instead of sending the message twice.
--   4. Deliveries keyed by WORKSPACE, not clone. The prime has no `clones`
--      row; it is addressed by a reserved id (the nil UUID,
--      `PRIME_WORKSPACE_ID` in `cloneAnnouncements.pure.ts`), so the foreign
--      key to `clones` comes off. A stamp for a clone deleted later survives
--      as history; the console reads stamps only for workspaces it lists.
--   5. `seen_*` — a workspace's staff opening, dismissing or acknowledging a
--      message is counted, separately from the dashboard merely fetching it.
--      A count, never a name: Mission Control still does not record who read
--      anything.
--
-- Additive. Every existing row reads exactly as it did: replies off, AND
-- matching, no request id, nothing seen.

alter table public.clone_announcements
  add column if not exists replies_enabled boolean not null default false,
  add column if not exists audience_match text not null default 'all',
  add column if not exists client_request_id uuid;

alter table public.clone_announcements
  drop constraint if exists clone_announcements_audience_match;
alter table public.clone_announcements
  add constraint clone_announcements_audience_match
  check (audience_match in ('all', 'any'));

create unique index if not exists clone_announcements_client_request_id_key
  on public.clone_announcements (client_request_id)
  where client_request_id is not null;

comment on column public.clone_announcements.replies_enabled is
  'False: an announcement, one-way. True: the workspaces it reaches may reply, and each reply returns to Workspace messages as a thread for that workspace (clone_announcement_replies).';
comment on column public.clone_announcements.audience_match is
  'How audience_plan_slugs and audience_clone_ids combine when both are set: all = a workspace must match both (the original rule), any = either reaches it. Irrelevant when either list is null.';
comment on column public.clone_announcements.client_request_id is
  'The console''s id for one Send now / Save act. Unique, so a repeated request finds the row it already made instead of making a second.';

-- The prime has no clones row, so a delivery stamp can no longer reference one.
alter table public.clone_announcement_deliveries
  drop constraint if exists clone_announcement_deliveries_clone_id_fkey;

alter table public.clone_announcement_deliveries
  add column if not exists first_seen_at timestamp with time zone,
  add column if not exists last_seen_at timestamp with time zone,
  add column if not exists seen_count integer not null default 0;

alter table public.clone_announcement_deliveries
  drop constraint if exists clone_announcement_deliveries_seen_floor;
alter table public.clone_announcement_deliveries
  add constraint clone_announcement_deliveries_seen_floor check (seen_count >= 0);

comment on column public.clone_announcement_deliveries.clone_id is
  'The workspace that fetched the message: a clones.id, or the prime''s reserved id (the nil UUID). Not a foreign key, because the prime has no clones row.';
comment on column public.clone_announcement_deliveries.seen_count is
  'How many times a member of the workspace''s staff opened, dismissed or acknowledged the message. A count, never a name.';

-- One thread per (message, workspace). Rows are written only by the service
-- role: the public reply route for a workspace's staff, the console's server
-- function for an operator.
create table if not exists public.clone_announcement_replies (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null
    references public.clone_announcements(id) on delete cascade,
  workspace_id uuid not null,
  direction text not null,
  body text not null,
  author_name text not null,
  author_email text,
  author_role text,
  author_ref text,
  client_request_id uuid,
  operator_read_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  constraint clone_announcement_replies_direction
    check (direction in ('workspace', 'operator')),
  constraint clone_announcement_replies_body_len
    check (char_length(body) between 1 and 2000),
  constraint clone_announcement_replies_author_name_len
    check (char_length(author_name) between 1 and 120),
  constraint clone_announcement_replies_author_email_len
    check (author_email is null or char_length(author_email) <= 320),
  constraint clone_announcement_replies_author_role_len
    check (author_role is null or char_length(author_role) <= 60),
  constraint clone_announcement_replies_author_ref_len
    check (author_ref is null or char_length(author_ref) <= 100),
  -- Only a workspace's message waits to be read by an operator.
  constraint clone_announcement_replies_read_is_inbound
    check (operator_read_at is null or direction = 'workspace')
);

comment on table public.clone_announcement_replies is
  'Replies to a Mission Control message sent with replies enabled, one thread per (announcement, workspace). A workspace is only ever served its own thread; an operator answers within it.';
comment on column public.clone_announcement_replies.workspace_id is
  'The workspace the thread belongs to: a clones.id, or the prime''s reserved id (the nil UUID). Not a foreign key, so a thread outlives a deleted clone as the record of what was said.';
comment on column public.clone_announcement_replies.author_ref is
  'Who wrote it, as their own system names them: the workspace''s user id for a workspace reply (resolved by the workspace''s server from the session, never taken from a browser), the operator''s user id for an operator reply.';

-- The thread read (and the FK's reverse lookup, which leads with the same column).
create index if not exists idx_clone_announcement_replies_thread
  on public.clone_announcement_replies (announcement_id, workspace_id, created_at);

-- The console's unread count.
create index if not exists idx_clone_announcement_replies_unread
  on public.clone_announcement_replies (created_at)
  where direction = 'workspace' and operator_read_at is null;

-- A workspace that retries a reply after a timeout sends the same request id
-- and finds the first row.
create unique index if not exists clone_announcement_replies_request_key
  on public.clone_announcement_replies (workspace_id, client_request_id)
  where client_request_id is not null;

alter table public.clone_announcement_replies enable row level security;

drop policy if exists "Operators read clone announcement replies"
  on public.clone_announcement_replies;
create policy "Operators read clone announcement replies"
  on public.clone_announcement_replies for select to authenticated
  using (is_operator(auth.uid()));
