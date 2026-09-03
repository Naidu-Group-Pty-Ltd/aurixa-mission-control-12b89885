-- @asserts column:clone_backends.repair_requested_at
-- A lever for converging a clone that is ALREADY ready.
--
-- Until now every path into the provisioning queue refused such a row:
-- `enqueueCloneBackendProvisioning` answers "This clone already has a
-- provisioned backend", and /hooks/backend-provisioning-retry answers 409 for
-- anything that is not `failed`. Both guards are right about what they are
-- guarding — the wizard must not double-provision, and a live run must not be
-- clobbered by a fresh upsert resetting its attempts — but between them they
-- left a state with no lever at all.
--
-- That state is the ordinary one. Every time the ENGINE is fixed, the clones
-- provisioned under the old engine are frozen holding the old engine's gaps:
-- on 3 Sep 2026 two clones sat at `ready` with 0 of the prime's 32 storage
-- buckets and 9 of its 86 secrets, because the fixes for both landed after
-- they finished. The only remedy the product offered was to destroy a paying
-- tenant's Supabase project and provision it again.
--
-- So a repair is its own queued pass, and the flag is a timestamp because
-- WHEN a convergence was asked for is worth keeping in the row an operator
-- reads. Its presence means "the pass now queued is a repair"; the completion
-- path clears it.
--
-- Two things follow from a repair carrying no admin credential:
--   * the drain's claim must not require `queued_admin_password_enc`, and
--   * the stranded sweep — which fails a parked row precisely BECAUSE it has
--     no credential and so can never be claimed — must not touch one.
alter table public.clone_backends
  add column if not exists repair_requested_at timestamptz;

comment on column public.clone_backends.repair_requested_at is
  'Set when this queued pass is a REPAIR of an already-ready backend: converge it onto the current engine, resuming onto the existing Supabase project, without re-seeding the admin identity. Cleared when the pass completes.';
