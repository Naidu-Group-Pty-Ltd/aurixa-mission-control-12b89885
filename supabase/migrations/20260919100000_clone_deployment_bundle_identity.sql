-- @asserts column:clone_deployments.bundle_identity
-- @asserts column:clone_deployments.bundle_identity_detail
-- @asserts column:clone_deployments.bundle_checked_at
-- @asserts column:clone_deployments.bundle_artefact
-- @asserts column:clone_deployments.bundle_resync_artefact
-- @asserts column:clone_backends.admin_seed
-- @asserts enum:notification_kind

-- What the browser downloaded, recorded beside what we published.
--
-- `clone_deployments` already records that the environment was synced
-- (`env_digest`, `env_synced_at`) and that the build succeeded
-- (`last_build_state`). Measured 19 Sep 2026, all three were true of
-- `npc-crm-independent` while its served bundle named the PRIME's Supabase
-- project — so nobody could sign in with the credentials Mission Control had
-- issued, and every signal this pipeline held was green because each was
-- telling the truth about a different thing.
--
-- These columns hold the one reading none of them could give: the verdict of
-- fetching the deployed JavaScript and asking which project it names. They are
-- additive and nullable on purpose — a deployment that has never been probed is
-- `null`, which is a distinct state from one probed and found wrong, and no
-- backfill may invent either.

-- ── Notification kind ───────────────────────────────────────────────────────
-- Declared BEFORE anything inserts it. Three kinds shipped without this once
-- and every insert failed with `invalid input value for enum`, silently,
-- because the error was discarded (see 20260820170000_clone_deployments.sql).
alter type public.notification_kind add value if not exists 'deployment_bundle_identity';

alter table public.clone_deployments
  -- One of: carries_own | carries_prime | carries_both | names_neither |
  -- unreadable | unreachable. Not a CHECK constraint: the vocabulary lives in
  -- `deployedBundleIdentity.pure.ts` and a second copy here is how two
  -- statements of one rule come to disagree.
  add column if not exists bundle_identity text,
  -- The operator-facing sentence from the same reading.
  add column if not exists bundle_identity_detail text,
  -- When the artefact was last read. Null means never, never "fine".
  add column if not exists bundle_checked_at timestamptz,
  -- The entry asset the verdict was taken from, e.g. /assets/index-ABC123.js.
  -- A new hash here means a genuinely new build to judge.
  add column if not exists bundle_artefact text,
  -- The artefact an automatic environment re-sync was last requested for.
  --
  -- ONE attempt, ever, per artefact — the same discipline as the Compliance
  -- Passport's `portrait_backfill` stamp. A re-sync fixes a CONFIGURATION
  -- cause (the value never reached the build's environment). It cannot fix a
  -- CODE cause: a bundle that reads its variables in a form no bundler
  -- substitutes comes out byte-identical however many times it is rebuilt,
  -- which is what happened here and to the Turnstile site key before it. So
  -- the guard is the attempt and never its outcome, and a second wrong reading
  -- on a NEW artefact is a fact about the clone's source for a person to read.
  add column if not exists bundle_resync_artefact text;

comment on column public.clone_deployments.bundle_identity is
  'Verdict of reading the deployed bundle: which Supabase project it actually names. Null = never probed, which is not a pass.';
comment on column public.clone_deployments.bundle_resync_artefact is
  'The entry asset an automatic env re-sync was last requested for. One attempt per artefact; a repeat on the same bytes is a source fault, not a configuration one.';

create index if not exists clone_deployments_bundle_identity_idx
  on public.clone_deployments (bundle_identity)
  where bundle_identity is not null;

-- ── Can anybody sign in? ────────────────────────────────────────────────────
--
-- `seedAdminUser` already builds an `AdminSeedReport` and verifies it against
-- the clone's own store — `password_hash = extensions.crypt(pw, password_hash)`
-- is a real bcrypt check, not a claim that the insert returned no error. That
-- report reached `clone_backends.status_detail` and nothing else, and the
-- finalising update in the same run overwrites `status_detail` with the parity
-- line. So the one answer to "can anybody sign in to this clone" lived for a
-- few seconds and was gone.
--
-- Exactly the defect `parity_report.replication.*` was added for — "computed
-- and dropped on the floor, so a per-item failure existed only in a status
-- line that the next step overwrote" — one row up and on the more
-- consequential question. It gets a column of its own rather than a corner of
-- `parity_report`, because parity answers whether the clone MATCHES the prime
-- and this answers whether anybody can get in, and filing one under the other
-- is how a question stops being asked.
alter table public.clone_backends
  add column if not exists admin_seed jsonb;

comment on column public.clone_backends.admin_seed is
  'The AdminSeedReport from the last pass that seeded one: product_identity, password_verifies, role_label, auth_user, notes. Null = no pass has seeded on this row (a repair pass deliberately does not, and must not null this).';
