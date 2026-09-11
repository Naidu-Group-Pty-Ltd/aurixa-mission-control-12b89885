-- @asserts table:clone_anthropic_identity
-- @asserts column:clone_anthropic_identity.workspace_id
-- @asserts column:clone_anthropic_identity.federation_rule_id
--
-- What Anthropic knows about one clone.
--
-- ## Why a table rather than the secrets ledger
--
-- `clone_backend_secrets` records that a name is SET on a project; it stores
-- no value. That is right for a credential and wrong for this, because Mission
-- Control has to read these identifiers back: to avoid creating a second
-- workspace for a clone that already has one, and — once a clone federates —
-- to name the service account and federation rule in every token exchange.
--
-- ## Why the workspace is the interesting object
--
-- Anthropic publishes no endpoint that creates an API key. Its own
-- documentation is explicit: "you create API keys in the Claude Console."
-- So the per-clone credential that OpenRouter, OpenAI, Perplexity and Google
-- all allow cannot exist here, and for a while that read as "Anthropic cannot
-- be attributed per clone".
--
-- It can. The unit of attribution at Anthropic is the WORKSPACE, not the key:
-- `POST /v1/organizations/workspaces` creates one, the usage and cost reports
-- group by `workspace_id`, and a credential that is not bound to a single
-- workspace acts in whichever one each request names in its
-- `anthropic-workspace-id` header. One workspace per clone therefore makes
-- Anthropic's own ledger agree with ours, which is what makes a disputed
-- charge answerable — and it costs one Console visit in total rather than one
-- per clone.
--
-- ## The federation columns are nullable on purpose
--
-- They are the second half of the same design, and they are declared here so
-- the queue takes one file rather than two. A clone that holds a workspace and
-- no federation triple is the ordinary, correct state: it reaches Anthropic on
-- the organisation key and names its own workspace. The triple is what lets it
-- reach Anthropic with NO key at all, and it is written only once Mission
-- Control has created a service account for the clone and a rule that pins it.
--
-- ## The ceiling, recorded where somebody will meet it
--
-- An Anthropic organisation gets 100 workspaces by default; archived ones do
-- not count, and the limit is raised on request. There is deliberately no
-- constraint enforcing that here — a database that refused to record the
-- hundred-and-first workspace would be refusing to record something Anthropic
-- had already created. `anthropicWorkspace.pure.ts` warns as the count
-- approaches it instead.

create table if not exists public.clone_anthropic_identity (
  clone_id uuid primary key references public.clones(id) on delete cascade,

  -- `wrkspc_`-prefixed. Not null: a row exists because a workspace does.
  workspace_id text not null,
  -- What the workspace is called at the vendor, so a person reading
  -- Anthropic's console can tell whose spend a line is.
  workspace_name text not null,

  -- Federation (null until this clone reaches Anthropic without a key).
  service_account_id text,
  federation_rule_id text,
  federation_issuer_id text,
  federated_at timestamptz,

  -- The last time a real call was proven to resolve to this workspace, read
  -- back from Anthropic's own `anthropic-workspace-id` response header.
  -- Configuration is not reachability: every readiness reading in the
  -- verification broker was green on tenants that had never completed a call.
  verified_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.clone_anthropic_identity is
  'One Anthropic workspace per clone, so the vendor''s own usage and cost reports carry a per-tenant figure. Federation columns are null until the clone reaches Anthropic with no static key.';

-- One workspace is used by exactly one clone. Two clones sharing one would
-- merge their spend back into a single line, which is the state this whole
-- table exists to leave behind — and it would do so silently.
create unique index if not exists clone_anthropic_identity_workspace_key
  on public.clone_anthropic_identity (workspace_id);

grant select, insert, update, delete on public.clone_anthropic_identity to authenticated;
grant all on public.clone_anthropic_identity to service_role;

alter table public.clone_anthropic_identity enable row level security;

drop policy if exists "clone_anthropic_identity admin read" on public.clone_anthropic_identity;
create policy "clone_anthropic_identity admin read"
  on public.clone_anthropic_identity for select
  to authenticated
  using (public.is_admin(auth.uid()));

drop policy if exists "clone_anthropic_identity admin write" on public.clone_anthropic_identity;
create policy "clone_anthropic_identity admin write"
  on public.clone_anthropic_identity for all
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- A foreign key gives Postgres no index of its own, and the fk-index guard
-- fails CI without one. Here the primary key already covers `clone_id`, so
-- this is a no-op the guard can see.
create index if not exists clone_anthropic_identity_clone_idx
  on public.clone_anthropic_identity (clone_id);
