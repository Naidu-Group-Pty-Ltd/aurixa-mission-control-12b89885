-- @asserts column:clone_deployments.bundle_billing_uid

-- Which billing identity the SERVED bundle actually carries.
--
-- `clones.billing_user_id` is what a clone should be spending against.
-- `VITE_AURIXA_BILLING_UID` is inlined at BUILD time, so the value published
-- to a hosting project and the value in the artefact a customer downloaded are
-- different claims — and only the second decides where a purchase goes.
--
-- This is the same distinction `bundle_identity` records for the Supabase
-- project ref, added beside it for the same reason: every signal this pipeline
-- held was green while three of four clones served a bundle pointed at the
-- prime's database, because nothing anywhere fetched the JavaScript and asked.
--
-- Four readings, and the pair that matters is the last two. `fallback` means
-- the chunk carrying the identity WAS read and the identity in it is the
-- prime's built-in — a statement about the clone, and the one that credits the
-- prime for its customers' purchases. `not_scanned` means we did not reach
-- that chunk — a statement about the scan. Only the first is worth a rebuild,
-- and `shouldRequestResync` asks for one.
--
-- Null is never probed, which is not a pass.
alter table public.clone_deployments
  add column if not exists bundle_billing_uid text;

comment on column public.clone_deployments.bundle_billing_uid is
  'own | fallback | not_scanned | none — which billing identity the served bundle carries, read from the bytes. Null = never probed, which is not a pass. "fallback" means this clone''s customers'' purchases credit the prime.';

-- Partial: the interesting set is small and permanently so. A clone reading
-- `own` needs nothing, and a full index over a column that is one of four
-- values on a table of tens of rows buys nothing.
create index if not exists clone_deployments_bundle_billing_uid_idx
  on public.clone_deployments (bundle_billing_uid)
  where bundle_billing_uid is not null and bundle_billing_uid <> 'own';
