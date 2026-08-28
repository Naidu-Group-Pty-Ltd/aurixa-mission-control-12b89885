-- @asserts table:clone_email_identities
--
-- Per-clone email sending identity (Resend).
--
-- Why this table exists: every clone provisioned by this platform inherited
-- the PRIME's RESEND_API_KEY (a vendor secret marked inheritable in
-- prime_secret_forwards). That model has a single blast radius and a single
-- point of rot — when the prime's key was rotated at Resend, every clone's
-- outbound mail (password-reset OTPs, portal invites, appointment
-- notifications — 22 edge functions on the prime) failed with
-- `401 API key is invalid`, and nothing on the clone could say why.
--
-- The dedicated model this table carries: each clone gets its OWN sending
-- domain registered at Resend under the platform's master account, and its
-- own DOMAIN-SCOPED, SENDING-ONLY API key written to the clone's Supabase
-- project as RESEND_API_KEY. A leaked clone key can only send as that clone;
-- revocation and rotation are per-clone; billing attribution is per-domain.
--
-- One identity per clone (unique clone_id) — rotation replaces the key in
-- place rather than accumulating identities.
--
-- The Resend API key TOKEN is never stored here. Resend returns it exactly
-- once at mint time and it is written straight onto the clone's Supabase
-- project (the same "values are never stored in this dashboard" rule the
-- clone secrets page states). This row keeps only the key's Resend id and
-- last four characters, enough to recognise and revoke it.

create table if not exists public.clone_email_identities (
  id uuid primary key default gen_random_uuid(),
  clone_id uuid not null unique references public.clones(id) on delete cascade,

  -- The domain registered at Resend for this clone's outbound mail, e.g.
  -- `send.npc.aurixasystems.com.au`. A subdomain by default, per Resend's
  -- own guidance, so the clone's root-domain DNS is never touched.
  sending_domain text not null,
  region text not null default 'us-east-1',

  -- Resend-side resources. Null until the corresponding step has run.
  resend_domain_id text,
  domain_status text not null default 'unprovisioned'
    check (domain_status in ('unprovisioned','pending_dns','verified','failed','revoked')),

  -- The DNS records Resend requires for this domain (SPF TXT, DKIM TXT, MX),
  -- exactly as Resend reported them, so the operator UI can render them for
  -- manual installation and re-render them on every check.
  dns_records jsonb not null default '[]'::jsonb,
  -- 'cloudflare' when Mission Control wrote the records into the clone's own
  -- Cloudflare zone; 'manual' when the operator was shown records to install.
  dns_installed_via text
    check (dns_installed_via is null or dns_installed_via in ('cloudflare','manual')),

  -- The domain-scoped sending key. Identification only — never the token.
  resend_key_id text,
  key_last4 text,
  key_written_at timestamptz,

  -- The address the clone should send from once verified, e.g.
  -- `notifications@send.npc.aurixasystems.com.au`. Guidance for the sender
  -- alignment step; the clone's own brand config remains the authority.
  default_from_address text,

  last_error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.clone_email_identities to authenticated;
grant all on public.clone_email_identities to service_role;

alter table public.clone_email_identities enable row level security;

drop policy if exists "clone_email_identities admin read" on public.clone_email_identities;
create policy "clone_email_identities admin read"
  on public.clone_email_identities for select
  to authenticated
  using (public.is_admin(auth.uid()));

drop policy if exists "clone_email_identities admin write" on public.clone_email_identities;
create policy "clone_email_identities admin write"
  on public.clone_email_identities for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop trigger if exists clone_email_identities_updated_at on public.clone_email_identities;
create trigger clone_email_identities_updated_at
  before update on public.clone_email_identities
  for each row execute function public.update_updated_at_column();

create index if not exists idx_clone_email_identities_domain_status
  on public.clone_email_identities (domain_status);
