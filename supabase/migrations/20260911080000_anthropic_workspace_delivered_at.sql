-- @asserts column:clone_anthropic_identity.delivered_at
--
-- When the clone's project was actually TOLD its workspace.
--
-- ## Two facts, one column
--
-- `workspace_id` recorded which workspace a clone is attributed to, and
-- nothing recorded whether the project had been told. They are separate acts
-- that fail separately: the vendor creates the workspace, and the Management
-- API write onto the tenant's project can be refused afterwards. The row is
-- recorded anyway — deliberately, so a retry cannot create a SECOND workspace
-- and split the tenant's spend — which left the id present and the delivery
-- unfinished with no way to tell.
--
-- ## Why not `last_error`
--
-- The first repair recognised a pending delivery by a phrase in `last_error`,
-- and that column has four writers: the reachability probe clears it on a
-- pass, records a note on a failure, the attempt recorder overwrites it, and
-- federation clears it when it records its resources. Every one of those runs
-- in the SAME sweep as workspace provisioning, so the marker was routinely
-- erased before the pass that needed it — after which the recorded workspace
-- read as `already_provisioned` for ever and the clone's spend stayed on the
-- organisation's default line. A fact about delivery needs a column nothing
-- else owns.
--
-- ## The backfill
--
-- A row already carrying a workspace with no error against it was recorded by
-- a run that got past the write, so it is delivered. A row with an error is
-- left NULL and the next pass retries the write, which is idempotent: it sets
-- the same id it already recorded.
alter table public.clone_anthropic_identity
  add column if not exists delivered_at timestamptz;

update public.clone_anthropic_identity
   set delivered_at = coalesce(updated_at, created_at)
 where delivered_at is null
   and workspace_id is not null
   and last_error is null;

comment on column public.clone_anthropic_identity.delivered_at is
  'When ANTHROPIC_WORKSPACE_ID was written onto the clone project. NULL means the workspace is recorded here but the project has not been told, so delivery is retried.';
