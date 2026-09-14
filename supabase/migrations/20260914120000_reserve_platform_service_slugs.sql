-- ===========================================================================
-- Reserve the slugs used by platform-owned hosts on *.aurixasystems.com.au
--
-- @asserts check:platform_hosting_config.reserved_slugs=builders
--
-- Every clone is reachable at <slug>.aurixasystems.com.au, and the guard that
-- stops two clones colliding is the unique index on clones.subdomain. A host
-- that Aurixa itself owns is NOT a clones row at all, so that index has never
-- protected one: today a customer could claim `builders` and be handed the
-- hostname the Builders Network is about to live on.
--
-- reserved_slugs is the only mechanism that covers this. The deploy path
-- enforces it in subdomainAllocation.server.ts (allocateSubdomain refuses with
-- reason "reserved" before any suffixing), and a direct claim throws
-- subdomain_reserved in subdomain-hosting.functions.ts — so a slug listed here
-- is refused before Cloudflare is ever consulted.
--
-- `builders` is the Builders Network host (the Builder Portal extraction,
-- npc-property-dashbord docs/builder-portal/45-network-extraction-plan.md,
-- Phase 0). The other four are reserved now rather than later because they
-- are the names a platform service would plausibly take next, and reserving
-- an unused slug costs nothing while reclaiming a customer's live subdomain
-- costs an outage.
--
-- Both halves are needed and neither is sufficient:
--   * the column DEFAULT covers a fresh install, which is the only thing that
--     reads it — an existing row was populated at insert time and never
--     revisits the default;
--   * the UPDATE covers the row that already exists, and unions rather than
--     replaces so an operator's own additions survive.
-- Idempotent: re-running adds nothing and removes nothing.
-- ===========================================================================

alter table public.platform_hosting_config
  alter column reserved_slugs set default array[
    'www','api','admin','app','mail','ftp','staging','dev','test','prod',
    'auth','portal','dashboard','status','docs','blog','cdn','assets','static',
    'mission-control','aurixa','root','ns1','ns2',
    'builders','builder','network','connect','partners'
  ];

update public.platform_hosting_config
set reserved_slugs = (
      select array(
        select distinct s
        from unnest(
          reserved_slugs
          || array['builders','builder','network','connect','partners']
        ) as s
        order by s
      )
    ),
    updated_at = now()
where singleton = true
  and not (reserved_slugs @> array['builders','builder','network','connect','partners']);

-- A slug reserved after the fact does not evict a clone that already holds it:
-- reserved_slugs is only consulted when a subdomain is claimed. If one of these
-- is already live, the collision is real and a person has to resolve it, so say
-- so loudly rather than failing the deploy of an otherwise correct migration.
do $$
declare
  taken text;
begin
  select string_agg(format('%s (clone %s)', subdomain, id), ', ')
    into taken
  from public.clones
  where subdomain = any (array['builders','builder','network','connect','partners']);

  if taken is not null then
    raise warning 'platform slug already assigned to a clone and must be migrated by hand: %', taken;
  end if;
end $$;
