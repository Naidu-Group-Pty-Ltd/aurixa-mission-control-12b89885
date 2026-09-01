-- @asserts column:clone_email_identities.revoked_at
--
-- Revoking a clone's sending key was undone by the drain within five minutes.
--
-- `revokeEmailIdentity` deletes the key at Resend and clears `resend_key_id` /
-- `key_written_at`. With `deleteDomain: false` — which is what the operator's
-- Revoke button sends — it deliberately leaves the domain alone, so the row is
-- left with a verified domain and no key. That is indistinguishable from an
-- identity that has finished DNS and is waiting to be minted, which is exactly
-- what the drain exists to carry forward: `decideEmailIdentitySweep` said
-- "domain verified, key not yet minted", `canMintKey` agreed, and a fresh key
-- was minted and written to the clone. The operator's deliberate act of
-- stopping that clone's mail was reversed by a scheduled job, silently.
--
-- Two automated callers reach that mint — `email-identity-drain` and the
-- deployment drain's credential arming — so the guard cannot live in either.
--
-- Why a column of its own rather than `domain_status = 'revoked'`:
-- `domain_status` is a fact about the DOMAIN at Resend, and with
-- `deleteDomain: false` the domain IS still verified there. `advanceEmailIdentity`
-- re-reads Resend on every pass and overwrites `domain_status` from the
-- answer, so an intent stored in that column is erased on the next tick.
-- Intent and observation are different things and cannot share a field.
--
-- Set on every revoke, cleared only by an explicit operator resume. A NULL
-- here is the ordinary state: nobody has stopped this identity.
alter table public.clone_email_identities
  add column if not exists revoked_at timestamptz;

comment on column public.clone_email_identities.revoked_at is
  'When an operator revoked this identity. While set, no key may be minted by any path (canMintKey refuses) and the drain skips the row entirely. Cleared only by an explicit resume, never by a sweep.';

-- The sweep claims work with `revoked_at is null` as well as
-- `from_address_written_at is null`, so revoked rows cannot occupy slots in
-- its ordered LIMIT window and starve identities that still owe work.
drop index if exists idx_clone_email_identities_from_address_pending;
create index if not exists idx_clone_email_identities_sweep_pending
  on public.clone_email_identities (updated_at)
  where from_address_written_at is null and revoked_at is null;
