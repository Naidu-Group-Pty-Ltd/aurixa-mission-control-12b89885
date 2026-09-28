-- @asserts table:clone_crm_conversions
-- @asserts column:clone_crm_conversions.status
-- @asserts column:clone_crm_conversions.from_mode
-- @asserts column:clone_crm_conversions.to_mode
-- @asserts column:clone_crm_conversions.pr_number
-- @asserts column:clone_crm_conversions.plan
-- @asserts column:clone_crm_conversions.delivered_sha
-- @asserts check:clone_crm_conversions.status=proposed
-- @asserts check:clone_crm_conversions.status=merged
-- @asserts check:clone_crm_conversions.status=completed
-- @asserts check:clone_crm_conversions.status=cancelled
-- @asserts check:clone_crm_conversions.status=failed

-- MOVING A CLONE FROM ONE CRM LINE TO THE OTHER, RECORDED.
--
-- `20260928100000_clone_crm_mode.sql` made the CRM a clone runs a recorded
-- fact and gave each line a head. This is the ledger of the one act that
-- changes it after provisioning: a CRM conversion
-- (`src/server/crmConversion.pure.ts` decides, `crmConversion.server.ts`
-- acts).
--
-- A conversion is ONE pull request on the clone, built by the cascade engine
-- from the target line's head, and it is never merged by the platform:
-- merging it IS the conversion. So the row's life follows the pull request:
--
--   proposed  → the slot is claimed; the pull request is being built or open
--   merged    → it landed; the clone's parent, mode, pointer and functions
--               are being moved (idempotent, retried from here)
--   completed → moved
--   cancelled → closed unmerged, or withdrawn; nothing moved
--   failed    → the proposal could not be built, or finishing was refused
--
-- Three rules are held by the table itself rather than by the code that
-- writes it, because two writers (the operator's start and the drain's
-- finaliser) touch it and a rule stated in one of them is a rule the other
-- can break:
--
--  * ONE OPEN CONVERSION PER CLONE — a partial unique index over the two open
--    states. Two proposals for one clone would each delete what the other
--    delivers.
--  * A CONVERSION CHANGES LINE — `from_mode <> to_mode`.
--  * THE VOCABULARY IS THE MODULE'S — CHECKs rather than enums, for the reason
--    `clones.crm_mode` gives: this is the kind of vocabulary that grows.
--
-- Records are not moved by a conversion, and nothing here holds a client or a
-- conversation: `plan` is what the proposal decided (writes, removals, kept
-- files, retired functions), kept so the page can show what a merge will do
-- and what it did.
--
-- Written by the service role only (the server functions and the drain). The
-- policies below are for the console's reads; an admin write through the
-- caller's own client is permitted so the table behaves like every other
-- operator-owned table in this schema.

create table if not exists public.clone_crm_conversions (
  id                   uuid primary key default gen_random_uuid(),
  clone_id             uuid not null references public.clones(id) on delete cascade,
  from_mode            text not null
    constraint clone_crm_conversions_from_mode_check
      check (from_mode in ('dependent', 'independent')),
  to_mode              text not null
    constraint clone_crm_conversions_to_mode_check
      check (to_mode in ('dependent', 'independent')),
  from_parent_clone_id uuid references public.clones(id) on delete set null,
  to_parent_clone_id   uuid references public.clones(id) on delete set null,
  status               text not null default 'proposed'
    constraint clone_crm_conversions_status_check
      check (status in ('proposed', 'merged', 'completed', 'cancelled', 'failed')),
  pr_number            integer,
  pr_url               text,
  branch               text,
  -- The target head's commit the tree was read at.
  source_sha           text,
  -- The PRIME commit the target head carried when its tree was read — the
  -- clone's new sync pointer once the proposal merges.
  delivered_sha        text,
  -- The merge commit on the clone, once merged.
  merge_sha            text,
  plan                 jsonb,
  requested_by         uuid,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  merged_at            timestamptz,
  completed_at         timestamptz,
  constraint clone_crm_conversions_modes_differ check (from_mode <> to_mode)
);

-- One open conversion per clone.
create unique index if not exists clone_crm_conversions_one_open
  on public.clone_crm_conversions (clone_id)
  where status in ('proposed', 'merged');

-- The drain's read: every open conversion.
create index if not exists idx_clone_crm_conversions_open
  on public.clone_crm_conversions (status)
  where status in ('proposed', 'merged');

-- Foreign-key indexes (`check:fk-indexes`).
create index if not exists idx_clone_crm_conversions_clone_id
  on public.clone_crm_conversions (clone_id);
create index if not exists idx_clone_crm_conversions_from_parent_clone_id
  on public.clone_crm_conversions (from_parent_clone_id);
create index if not exists idx_clone_crm_conversions_to_parent_clone_id
  on public.clone_crm_conversions (to_parent_clone_id);

drop trigger if exists clone_crm_conversions_set_updated_at on public.clone_crm_conversions;
create trigger clone_crm_conversions_set_updated_at
  before update on public.clone_crm_conversions
  for each row execute function public.update_updated_at_column();

alter table public.clone_crm_conversions enable row level security;

drop policy if exists "Operators read CRM conversions" on public.clone_crm_conversions;
create policy "Operators read CRM conversions"
  on public.clone_crm_conversions for select to authenticated
  using (public.is_operator(auth.uid()));

drop policy if exists "Admins insert CRM conversions" on public.clone_crm_conversions;
create policy "Admins insert CRM conversions"
  on public.clone_crm_conversions for insert to authenticated
  with check (public.is_admin(auth.uid()));

drop policy if exists "Admins update CRM conversions" on public.clone_crm_conversions;
create policy "Admins update CRM conversions"
  on public.clone_crm_conversions for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

comment on table public.clone_crm_conversions is
  'One row per CRM conversion of a clone (dependent <-> independent). A conversion is one pull request on the clone, never merged by the platform; merging it is the conversion. See src/server/crmConversion.pure.ts.';
