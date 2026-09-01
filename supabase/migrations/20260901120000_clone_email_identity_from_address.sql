-- @asserts column:clone_email_identities.from_address_written_at
--
-- The sending key and the address it may send from are ONE credential.
--
-- `mintAndWriteKey` wrote `RESEND_API_KEY` to the clone and nothing else, so a
-- clone finished provisioning holding a key scoped to
-- `send.<clone-fqdn>` while every one of its edge functions still built its
-- from-header from `global_report_settings.contact_details.email` — which is
-- EMPTY on a fresh clone, so `getBrandConfig` fell to its hard-coded
-- `noreply@npcservices.com.au`. That address belongs to the prime's own Resend
-- account and is not verified in the platform account at all, so every send
-- answered `403 ... not verified`. Measured on the first clone: password
-- recovery, portal invites and every other outbound mail, all failing on a
-- domain that was correctly registered, correctly DNS'd and verified.
--
-- The repair is to write the address as `RESEND_FROM_EMAIL` in the SAME
-- Management API call that writes the key, so the pair cannot be half-written.
-- This column records that the clone actually received it.
--
-- It is deliberately SEPARATE from `key_written_at` rather than folded into
-- it: every identity provisioned before this one has a key and no address,
-- and the drain must be able to see that difference to repair it. The sweep's
-- "finished" test reads THIS column, because a key whose address never
-- arrived is exactly the state that looked finished and could not send.
alter table public.clone_email_identities
  add column if not exists from_address_written_at timestamptz;

comment on column public.clone_email_identities.from_address_written_at is
  'When RESEND_FROM_EMAIL (default_from_address) was written to the clone''s Supabase project. Null on an identity whose key was written before the address was paired with it — the drain repairs those.';

-- The sweep now claims work by this column (a row needing either the key or
-- the address has it null), so it is the one the scheduled drain orders on.
create index if not exists idx_clone_email_identities_from_address_pending
  on public.clone_email_identities (updated_at)
  where from_address_written_at is null;
