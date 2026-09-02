-- @asserts table:clone_secret_forwards
--
-- Per-clone forwarding of a prime credential.
--
-- `prime_secret_forwards` is FLEET policy: a name marked `inherit` reaches
-- every clone this platform ever provisions, and only at provisioning time.
-- Both halves are wrong for a credential one tenant should hold and the next
-- should not, wanted on a clone provisioned days ago.
--
-- The row IS the authorisation, which is why there is no `inherit` column
-- here: a row that is not wanted is deleted. A false row would mean
-- "considered and declined", which is a statement fleet policy needs and a
-- single clone does not.
--
-- No value is stored. Mission Control never reads the prime's secret values
-- from its Supabase project — the only source is this deployment's own
-- environment, resolved at push time.
create table if not exists public.clone_secret_forwards (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null references public.clones(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Authorising the same name twice for one clone is one authorisation.
  unique (clone_id, name)
);

create index if not exists clone_secret_forwards_clone_idx
  on public.clone_secret_forwards (clone_id);

grant select, insert, update, delete on public.clone_secret_forwards to authenticated;
grant all on public.clone_secret_forwards to service_role;

alter table public.clone_secret_forwards enable row level security;

drop policy if exists "clone_secret_forwards admin read" on public.clone_secret_forwards;
create policy "clone_secret_forwards admin read"
  on public.clone_secret_forwards for select
  to authenticated
  using (public.is_admin(auth.uid()));

drop policy if exists "clone_secret_forwards admin write" on public.clone_secret_forwards;
create policy "clone_secret_forwards admin write"
  on public.clone_secret_forwards for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop trigger if exists clone_secret_forwards_updated_at on public.clone_secret_forwards;
create trigger clone_secret_forwards_updated_at
  before update on public.clone_secret_forwards
  for each row execute function public.update_updated_at_column();
