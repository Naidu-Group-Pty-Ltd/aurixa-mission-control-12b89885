-- ===========================================================================
-- Builders Network — the Mission Control trust anchor (Phase 1)
--
-- @asserts table:builders_network_connections_shadow
--
-- The Builder Portal is being extracted from the per-clone deployment to one
-- central platform at builders.aurixasystems.com.au (npc-property-dashbord
-- docs/builder-portal/45-network-extraction-plan.md). Mission Control is its
-- trust anchor and nothing else: it vouches for a workspace's identity the
-- same way it already does for Anthropic federation, and it keeps an
-- operator-visible shadow of the connection graph. It never holds the
-- network's service-role key and the network never holds a fleet credential.
--
-- Two things here, and what each deliberately is NOT:
--
-- 1. The shadow connections ledger. The AUTHORITATIVE graph lives in the
--    network's own database (workspace_connections); this table is what lets
--    a Mission Control operator see, next to a clone, which builder
--    organisations it is connected to — without asking the network on every
--    page draw. It is written only by the service role (the sync that relays
--    the network's reports) and read by admins. Nothing on this table may
--    ever gate a request: a stale shadow that could refuse traffic would make
--    an operator cache into an authority, which is exactly the split-brain
--    the plan forbids ("operator visibility only, never authoritative").
--
-- 2. edge_dns_records learns that a managed record can belong to the
--    PLATFORM. Today clone_id is NOT NULL, so a row for a host Aurixa itself
--    owns cannot exist at all — and builders.aurixasystems.com.au is exactly
--    that. The column becomes nullable with an owner-agreement CHECK: a
--    platform_service record has no clone, every other purpose keeps one.
--    No row is inserted here. zone_id and external_record_id are facts about
--    a Cloudflare record that exists, and inventing them so a row can appear
--    early is asserting by configuration what only the hosting path can
--    assert by effect — the row is written when the record is actually
--    created (Phase 2), and this migration is what makes that write legal.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The shadow connections ledger
-- ---------------------------------------------------------------------------

create table if not exists public.builders_network_connections_shadow (
  id uuid primary key default gen_random_uuid(),

  -- The workspace side of the edge. A clone that is deleted takes its shadow
  -- rows with it; the network keeps its own authoritative history.
  clone_id uuid not null references public.clones(id) on delete cascade,

  -- The network's own id for this connection — the authority's key, stored so
  -- an operator's view and the network's records can always be joined. One
  -- shadow row per authoritative row.
  network_connection_id uuid not null unique,

  -- Who the workspace is connected TO, as the network reported it. A label
  -- and an opaque reference, never a foreign key: the builder organisation is
  -- not a row in this database and must not become one by accident.
  builder_org_ref text not null,
  builder_org_label text,

  -- The network's connection states, mirrored: none is not a row, revoked is
  -- terminal, re-connection is a new row (partnerAccess shape, re-created on
  -- the network side per the plan).
  state text not null check (state in ('invited', 'active', 'revoked')),

  -- The scopes the connection carried when last reported. Display only.
  scopes text[] not null default '{}',

  -- When the network last told us this. The staleness an operator sees is a
  -- property of the sync, and showing the timestamp is what keeps a shadow
  -- honest about being one.
  reported_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists builders_network_connections_shadow_clone_idx
  on public.builders_network_connections_shadow (clone_id, state);

alter table public.builders_network_connections_shadow enable row level security;

-- Admins read; only the service role (the sync) writes. An authenticated
-- write policy here would let a browser edit a mirror of somebody else's
-- authority, which is worse than useless — it is a forgery surface.
drop policy if exists "builders_network_connections_shadow admin read"
  on public.builders_network_connections_shadow;
create policy "builders_network_connections_shadow admin read"
  on public.builders_network_connections_shadow for select
  to authenticated
  using (public.is_admin(auth.uid()));

grant select on public.builders_network_connections_shadow to authenticated;
grant all on public.builders_network_connections_shadow to service_role;

drop trigger if exists builders_network_connections_shadow_updated_at
  on public.builders_network_connections_shadow;
create trigger builders_network_connections_shadow_updated_at
  before update on public.builders_network_connections_shadow
  for each row execute function public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 2. A DNS record the platform owns has no clone
-- ---------------------------------------------------------------------------

alter table public.edge_dns_records
  alter column clone_id drop not null;

-- Owner agreement, in the portal_terms_multi_portal shape: NOT VALID first so
-- an existing bad row (there are none expected) is found by VALIDATE rather
-- than silently blocking the deploy, then validated so the rule holds.
alter table public.edge_dns_records
  drop constraint if exists edge_dns_records_owner_agree;
alter table public.edge_dns_records
  add constraint edge_dns_records_owner_agree
  check (
    (purpose = 'platform_service' and clone_id is null)
    or (purpose <> 'platform_service' and clone_id is not null)
  ) not valid;
alter table public.edge_dns_records
  validate constraint edge_dns_records_owner_agree;
