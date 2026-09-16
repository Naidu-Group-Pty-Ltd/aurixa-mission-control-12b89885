-- Clone announcements: operator-authored notices that clone dashboards fetch
-- through the keyed public API and render as banners or modal popups.
--
-- The design mirrors the activation gate's rules:
--   * State is DERIVED, never stored. draft / scheduled / active / expired /
--     archived are computed from published_at, archived_at, starts_at and
--     ends_at at read time, so nothing can wedge in a stale status and no
--     worker is needed to move one.
--   * Audience is explicit and NULL means everyone: a NULL plan list matches
--     every plan, a NULL clone list matches every clone, and both NULL is a
--     global notice. A non-NULL list must actually name something.
--   * A modal must be dismissible. An uncloseable modal is a lock screen, and
--     locking is the payment gate's job — enforced by CHECK, not convention.
--   * Deliveries are stamped by the public route, so the console can show
--     which clones have actually received a notice. That table is the loop
--     back to Mission Control; clones themselves are told nothing about
--     targeting and nothing about each other.
--
-- @asserts table:clone_announcements
-- @asserts table:clone_announcement_deliveries
-- @asserts column:clone_announcements.audience_plan_slugs
-- @asserts column:clone_announcements.revision
-- @asserts check:clone_announcements.severity=critical

create table public.clone_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null
    constraint clone_announcements_title_len check (char_length(title) between 1 and 140),
  body text not null
    constraint clone_announcements_body_len check (char_length(body) between 1 and 2000),
  link_url text
    constraint clone_announcements_link_https check (link_url is null or link_url ~ '^https://'),
  link_label text
    constraint clone_announcements_link_label_len check (link_label is null or char_length(link_label) between 1 and 60),
  severity text not null default 'info'
    constraint clone_announcements_severity check (severity in ('info','success','warning','critical')),
  display text not null default 'banner'
    constraint clone_announcements_display check (display in ('banner','modal')),
  dismissible boolean not null default true,
  audience_plan_slugs text[],
  audience_clone_ids uuid[],
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  revision integer not null default 1
    constraint clone_announcements_revision_floor check (revision >= 1),
  published_at timestamp with time zone,
  archived_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint clone_announcements_window
    check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint clone_announcements_modal_dismissible
    check (display <> 'modal' or dismissible),
  constraint clone_announcements_link_label_needs_url
    check (link_label is null or link_url is not null),
  constraint clone_announcements_plans_named
    check (audience_plan_slugs is null or cardinality(audience_plan_slugs) > 0),
  constraint clone_announcements_clones_named
    check (audience_clone_ids is null or cardinality(audience_clone_ids) > 0)
);

alter table public.clone_announcements enable row level security;

create policy "Operators read clone announcements"
  on public.clone_announcements for select to authenticated
  using (is_operator(auth.uid()));

create policy "Operators insert clone announcements"
  on public.clone_announcements for insert to authenticated
  with check (is_operator(auth.uid()));

create policy "Operators update clone announcements"
  on public.clone_announcements for update to authenticated
  using (is_operator(auth.uid()));

create trigger clone_announcements_set_updated_at
  before update on public.clone_announcements
  for each row execute function public.update_updated_at_column();

-- Partial index for the public route's hot read: published, not archived.
create index idx_clone_announcements_live
  on public.clone_announcements (published_at desc)
  where archived_at is null and published_at is not null;

-- One row per (announcement, clone): stamped on every successful delivery by
-- the public route. First/last timestamps and a count, like the gate's
-- check_count — evidence of effect, never of configuration. Written only by
-- the service-role route; operators read it in the console.
create table public.clone_announcement_deliveries (
  announcement_id uuid not null references public.clone_announcements(id) on delete cascade,
  clone_id uuid not null references public.clones(id) on delete cascade,
  first_delivered_at timestamp with time zone not null default now(),
  last_delivered_at timestamp with time zone not null default now(),
  delivery_count integer not null default 1,
  last_revision integer not null default 1,
  primary key (announcement_id, clone_id)
);

-- The FK's reverse lookup (deliveries for a clone) gets its own index; the PK
-- already covers announcement-first reads.
create index idx_clone_announcement_deliveries_clone
  on public.clone_announcement_deliveries (clone_id);

alter table public.clone_announcement_deliveries enable row level security;

create policy "Operators read clone announcement deliveries"
  on public.clone_announcement_deliveries for select to authenticated
  using (is_operator(auth.uid()));

-- Operator-feed notification kinds for the publish and archive acts. Added
-- last and never used inside this migration — an enum value cannot be used in
-- the transaction that adds it.
alter type public.notification_kind add value if not exists 'clone_announcement_published';
alter type public.notification_kind add value if not exists 'clone_announcement_archived';
