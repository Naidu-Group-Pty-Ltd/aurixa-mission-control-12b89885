-- Where the schema build had got to when the invocation budget ran out.
--
-- Backend provisioning runs in ~50-second slices of a pipeline that takes
-- much longer, so it pauses at a stage boundary and is resumed by the next
-- drain tick. Until now every resumed invocation replayed introspection from
-- the first stage, and on a prime this size the `tables` stage alone consumes
-- a whole slice: the run reached the same pause point every time and the
-- stages after it were never given any budget at all. The first
-- engine-provisioned clone sat at 155 of 624 database functions across three
-- consecutive passes for exactly that reason — pausing correctly, making no
-- progress.
--
-- The column holds the stage to resume AT, so an interrupted stage re-runs
-- from its own start (every stage is idempotent) while the stages already
-- carried are skipped. NULL means "start from the beginning", which is both
-- the default and what a completed pass writes back — a pass that began
-- partway through never claims the run is finished, it asks for one more full
-- pass to verify the stages it skipped.
-- @asserts column:clone_backends.resume_stage
alter table public.clone_backends
  add column if not exists resume_stage text;

comment on column public.clone_backends.resume_stage is
  'Introspection stage to resume at after a budget pause. NULL = start from the first stage.';
