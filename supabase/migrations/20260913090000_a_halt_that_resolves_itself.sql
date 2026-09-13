-- @asserts rpc:migration_queue_state
-- @asserts column:schema_migration_queue.resolution
-- @asserts column:schema_migration_queue.sqlstate

-- A HALT THAT RESOLVES ITSELF, AND A FAILURE THAT IS TOLD APART FROM A WAIT.
--
-- `INCIDENT_2026-09-08_MIGRATION_QUEUE_HALT.md` records 41 hours in which this
-- database applied no migration at all. Eight accumulated behind one failed
-- row, across three pull requests, while every signal an operator looks at
-- stayed green. What made it 41 hours rather than 41 minutes was not the
-- failure — it was that **nothing in the product could clear it**.
--
-- `service_role` holds `SELECT, INSERT` on this queue and nothing else, by
-- design: the credential that SUBMITS work must not be able to report on it.
-- The consequence nobody costed is that the credential that submits work also
-- cannot RESOLVE it. Only `postgres` can, and `postgres` is reachable from
-- exactly one place — the drain. So a halt could only be cleared by somebody
-- with database access this repository does not have, through Lovable's own
-- console, by hand.
--
-- ## What the repair actually was, and why a machine can make it
--
-- Read the incident's own account of the decision:
--
--   > the database was ahead of the queue in places and behind it in others …
--   > **None of the six was executed.** Replaying them would have moved the
--   > database backwards … So the six were marked applied **without executing**
--
-- and the evidence that settled it:
--
--   > structural fingerprints, not the ledger — the live `billing_reason`
--   > constraint was the 9-value form … `api_provider_rate_features` existed …
--   > `api_provider_rates.absorbed` existed
--
-- That is exactly what a `-- @asserts` claim IS. Every migration in this
-- repository already declares the observable it leaves, `check-migration-
-- assertions` refuses one that does not, and `migration-drift-hourly` already
-- evaluates them. The claims travel INSIDE `schema_migration_queue.sql`,
-- because the header is part of the file.
--
-- So on failure the drain now asks the migration its own question: **is the
-- effect you promised already here?** If every claim it declares holds, the
-- work is done and the row is `recorded` rather than failed — the same verdict
-- a person reached in September, from the same evidence, without the 41 hours.
--
-- ## Four rules, and the first one is the whole safety
--
-- **Silence is never proof.** A migration must declare at least one claim this
-- function can CHECK before it may self-resolve. `none:` is explicitly not
-- checkable — it is the kind a file uses to say "I leave no observable" — and a
-- migration whose every claim is `none` halts exactly as before. A guard that
-- treated "nothing to check" as "nothing wrong" would auto-resolve every
-- failure in the corpus.
--
-- **It resolves, it never re-runs.** A self-resolved row is stamped `recorded`,
-- the status `20260912150000` introduced for "settled without executing". The
-- SQL is not retried, nothing is forced, and the distinction an operator needs
-- later — did anything ever execute this file here — survives.
--
-- **It only ever looks at the CATALOG.** `table`, `column`, `rpc`, `cron`,
-- `rows` and `enum` are exact lookups. `check` is deliberately excluded even
-- though the drift worker evaluates it: deciding whether a constraint admits a
-- value means reading its definition as text, and a fuzzy answer here resolves
-- a halt that should have stood.
--
-- **The reason is written down.** `resolution` records WHY a row left the
-- failed state and which claims carried it, because a queue that silently
-- stopped halting is the same outage pointed the other way.
--
-- ## And a failure is told apart from a wait
--
-- The retry was three attempts for everything. A deadlock and a syntax error
-- got identical treatment: the syntax error burned three minutes proving what
-- it knew on the first attempt, and the deadlock got three tries a minute apart
-- when it wanted patience. `sqlstate` is recorded now and the class decides —
-- a contended lock is retried further, a deterministic error stops at once.

alter table public.schema_migration_queue
  add column if not exists sqlstate text,
  add column if not exists resolution text;

comment on column public.schema_migration_queue.sqlstate is
  'The SQLSTATE of the last failure, e.g. 42601. The CLASS decides the retry: '
  'a contended lock (40001, 40P01, 55P03, 57014) is transient and retried '
  'further; a deterministic error (42xxx, 23xxx, 22xxx) stops on the first '
  'attempt rather than proving three times what it knew once.';

comment on column public.schema_migration_queue.resolution is
  'Why this row left the failed state without its SQL being executed, and which '
  '@asserts claims carried it. Written by the drain''s self-resolution and by '
  'aurixa.resolve_migration(). Null on a row that simply ran.';

-- ---------------------------------------------------------------------------
-- Is the effect this migration promised already present?
-- ---------------------------------------------------------------------------
--
-- Reads `-- @asserts <kind>:<target>` out of the migration's own text. Returns
-- a row: whether every checkable claim held, how many there were, and the
-- claims themselves for the record.
--
-- `checked = 0` is the refusal that matters. It means the file declared
-- nothing this function can verify, which is a statement about the FILE and
-- never about the database — so the caller must treat it as "cannot say",
-- never as "all clear".
create or replace function aurixa.migration_effect_present(_sql text)
returns table (satisfied boolean, checked integer, detail text)
language plpgsql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
DECLARE
  v_line     text;
  v_kind     text;
  v_target   text;
  v_ok       boolean;
  v_checked  integer := 0;
  v_failed   integer := 0;
  v_notes    text[]  := ARRAY[]::text[];
  v_parts    text[];
  v_n        bigint;
BEGIN
  FOR v_line IN
    SELECT trim(substring(l FROM '^\s*--\s*@asserts\s+(.*)$'))
      FROM regexp_split_to_table(coalesce(_sql, ''), E'\n') AS l
     WHERE l ~* '^\s*--\s*@asserts\s'
  LOOP
    CONTINUE WHEN v_line IS NULL OR v_line = '';
    v_kind   := lower(split_part(v_line, ':', 1));
    v_target := trim(substring(v_line FROM position(':' IN v_line) + 1));
    CONTINUE WHEN v_target = '';

    v_ok := NULL;

    IF v_kind = 'table' THEN
      v_ok := to_regclass('public.' || quote_ident(v_target)) IS NOT NULL;

    ELSIF v_kind = 'column' THEN
      v_parts := string_to_array(v_target, '.');
      IF array_length(v_parts, 1) = 2 THEN
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = v_parts[1]
             AND column_name = v_parts[2]
        ) INTO v_ok;
      END IF;

    ELSIF v_kind = 'rpc' THEN
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_target
      ) INTO v_ok;

    ELSIF v_kind = 'enum' THEN
      SELECT EXISTS (
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typname = v_target AND t.typtype = 'e'
      ) INTO v_ok;

    ELSIF v_kind = 'cron' THEN
      -- `cron` lives in a schema PostgREST cannot reach, which is precisely why
      -- CI reports it unassertable. `postgres` reads it directly.
      BEGIN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = $1)'
          INTO v_ok USING v_target;
      EXCEPTION WHEN OTHERS THEN
        v_ok := NULL; -- not reachable here; counts as unchecked, never as true
      END;

    ELSIF v_kind = 'rows' THEN
      -- Bounded at twelve digits, not `\d+`: `999999999999999999999999::bigint`
      -- raises 22003, and a claim that cannot be READ must not be able to throw
      -- from inside the exception handler that is asking about it. Twelve
      -- digits is a trillion rows; past that the claim is not a row count.
      v_parts := regexp_match(v_target, '^([a-z_][a-z0-9_]*)\s*>=\s*(\d{1,12})$');
      IF v_parts IS NOT NULL AND to_regclass('public.' || quote_ident(v_parts[1])) IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I', v_parts[1]) INTO v_n;
        v_ok := v_n >= v_parts[2]::bigint;
      END IF;

    -- `check:` and `none:` are deliberately NOT evaluated. `none` says the file
    -- leaves no observable; `check` needs a constraint definition read as text,
    -- and a fuzzy answer would resolve a halt that should have stood.
    END IF;

    IF v_ok IS NULL THEN
      CONTINUE;  -- unchecked: neither evidence for nor against
    END IF;

    v_checked := v_checked + 1;
    IF NOT v_ok THEN
      v_failed := v_failed + 1;
      v_notes := v_notes || format('%s:%s ABSENT', v_kind, v_target);
    ELSE
      v_notes := v_notes || format('%s:%s present', v_kind, v_target);
    END IF;
  END LOOP;

  RETURN QUERY SELECT
    (v_checked > 0 AND v_failed = 0),
    v_checked,
    CASE WHEN v_checked = 0
      THEN 'no checkable @asserts claim — cannot say'
      ELSE array_to_string(v_notes, '; ')
    END;
END $function$;

revoke all on function aurixa.migration_effect_present(text) from public;

-- ---------------------------------------------------------------------------
-- The retry budget, by what actually failed
-- ---------------------------------------------------------------------------
--
-- Transient classes get patience; deterministic ones get none. A syntax error
-- is as true on the third attempt as on the first, and spending three minutes
-- discovering that delays the operator's only useful signal.
create or replace function aurixa.migration_attempt_budget(_sqlstate text)
returns integer
language sql
immutable
as $function$
  SELECT CASE
    -- Contention and cancellation: the migration is fine, the moment was not.
    WHEN _sqlstate IN ('40001','40P01','55P03','57014','53300','53400','08000','08003','08006')
      THEN 6
    -- Deterministic: syntax, undefined object, constraint violation, bad input.
    WHEN _sqlstate LIKE '42%' OR _sqlstate LIKE '23%' OR _sqlstate LIKE '22%'
      THEN 1
    -- Anything unrecognised keeps the behaviour that existed before this.
    ELSE 3
  END
$function$;

revoke all on function aurixa.migration_attempt_budget(text) from public;

-- ---------------------------------------------------------------------------
-- The drain
-- ---------------------------------------------------------------------------
create or replace function aurixa.drain_schema_migrations(_max_per_run integer default 20)
returns jsonb
language plpgsql
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
DECLARE
  v_row      public.schema_migration_queue%ROWTYPE;
  v_applied  integer := 0;
  v_recorded integer := 0;
  v_resolved integer := 0;
  v_failed   integer := 0;
  v_names    text[]  := ARRAY[]::text[];
  v_noted    text[]  := ARRAY[]::text[];
  v_healed   text[]  := ARRAY[]::text[];
  v_msg      text;
  v_state    text;
  v_terminal boolean;
  v_budget   integer;
  -- Three scalars rather than a record. `ROW(false,0,'…')::record` has no
  -- NAMED fields, so a fallback built that way raises "record has no field" at
  -- the first read — inside the very handler meant to make a fault harmless.
  v_sat      boolean;
  v_nchecked integer;
  v_detail   text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('aurixa.drain_schema_migrations')) THEN
    RETURN jsonb_build_object('skipped', 'another drain holds the lock');
  END IF;

  IF EXISTS (SELECT 1 FROM public.schema_migration_queue WHERE status = 'failed') THEN
    RETURN jsonb_build_object('halted', 'a failed migration is blocking the queue');
  END IF;

  WHILE v_applied + v_recorded + v_resolved + v_failed
        < GREATEST(COALESCE(_max_per_run, 20), 1) LOOP
    SELECT * INTO v_row
      FROM public.schema_migration_queue
     WHERE status = 'queued'
     ORDER BY version, enqueued_at
     LIMIT 1;
    EXIT WHEN NOT FOUND;

    UPDATE public.schema_migration_queue
       SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE id = v_row.id;

    BEGIN
      IF NOT v_row.already_applied THEN
        EXECUTE v_row.sql;
      END IF;

      INSERT INTO supabase_migrations.schema_migrations (version)
      SELECT v_row.version
       WHERE NOT EXISTS (
         SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = v_row.version
       );

      UPDATE public.schema_migration_queue
         SET status = CASE WHEN v_row.already_applied THEN 'recorded' ELSE 'applied' END,
             finished_at = now(), error = NULL, sqlstate = NULL
       WHERE id = v_row.id;

      IF v_row.already_applied THEN
        v_recorded := v_recorded + 1;
        v_noted := v_noted || v_row.name;
      ELSE
        v_applied := v_applied + 1;
        v_names := v_names || v_row.name;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;

        -- ASK THE MIGRATION ITS OWN QUESTION BEFORE HALTING THE FLEET.
        --
        -- The savepoint has rolled the attempt back, so the catalog below is
        -- the database as it stood BEFORE this migration touched it. If the
        -- effect it promised is already there, the work is done and the failure
        -- is the replay reporting a collision — which is exactly the September
        -- case, and exactly the verdict a person reached from the same
        -- evidence after 41 hours.
        --
        -- Asked inside its own block, because a fault HERE must never be worse
        -- than the failure it was asked about. If this raised, the outer
        -- transaction would abort — taking the `attempts` increment with it —
        -- and the row would return to `queued` to be retried for ever, never
        -- failing and never progressing. A livelock is worse than a halt: a
        -- halt at least says something. So an unevaluable claim degrades to
        -- "cannot say", which is the behaviour that existed before this.
        BEGIN
          SELECT satisfied, checked, detail
            INTO v_sat, v_nchecked, v_detail
            FROM aurixa.migration_effect_present(v_row.sql);
        EXCEPTION WHEN OTHERS THEN
          v_sat := false;
          v_nchecked := 0;
          v_detail := 'the effect check could not be evaluated';
        END;
        v_sat := coalesce(v_sat, false);

        IF v_sat THEN
          INSERT INTO supabase_migrations.schema_migrations (version)
          SELECT v_row.version
           WHERE NOT EXISTS (
             SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = v_row.version
           );

          UPDATE public.schema_migration_queue
             SET status = 'recorded',
                 finished_at = now(),
                 error = NULL,
                 sqlstate = v_state,
                 resolution = format(
                   'self-resolved: the effect was already present, so the %s failure was a replay. Evidence (%s claim(s)): %s. Original error: %s %s',
                   v_state, v_nchecked, v_detail, v_state, v_msg)
           WHERE id = v_row.id;

          v_resolved := v_resolved + 1;
          v_healed := v_healed || v_row.name;
          CONTINUE;  -- the queue keeps moving
        END IF;

        -- A real failure. How many attempts it deserves depends on what it was.
        v_budget := aurixa.migration_attempt_budget(v_state);
        v_terminal := (v_row.attempts + 1) >= v_budget;
        UPDATE public.schema_migration_queue
           SET status = CASE WHEN v_terminal THEN 'failed' ELSE 'queued' END,
               error = format('%s %s', v_state, v_msg),
               sqlstate = v_state,
               resolution = CASE WHEN v_terminal THEN format(
                 'halted after %s of %s attempt(s). The effect is NOT present: %s',
                 v_row.attempts + 1, v_budget, v_detail) ELSE NULL END,
               finished_at = CASE WHEN v_terminal THEN now() ELSE NULL END
         WHERE id = v_row.id;
        v_failed := v_failed + 1;
        EXIT;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'recorded', v_recorded,
    'self_resolved', v_resolved,
    'failed', v_failed,
    'names', to_jsonb(v_names),
    'noted', to_jsonb(v_noted),
    'healed', to_jsonb(v_healed)
  );
END $function$;

revoke all on function aurixa.drain_schema_migrations(integer) from public;

-- ---------------------------------------------------------------------------
-- The operator's way out, without a database console
-- ---------------------------------------------------------------------------
--
-- For the failure the drain could not resolve: genuinely broken SQL, or a file
-- whose effect really is absent. Runs as the definer so the endpoint can reach
-- it with the credential it already holds — `service_role` still cannot UPDATE
-- this table, and this is the only door.
--
-- `retry` is always safe: it clears the error and lets the drain try again,
-- which is what an operator does after fixing the cause elsewhere.
--
-- `record` is the September repair, and it demands the SAME evidence the drain
-- demands of itself: the migration's own claims must hold. An operator cannot
-- wave a failure through — if the effect is absent, this refuses and says so.
create or replace function aurixa.resolve_migration(_version text, _action text, _reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
DECLARE
  v_row     public.schema_migration_queue%ROWTYPE;
  -- Scalars, not a record: a fallback built as `ROW(...)::record` has no named
  -- fields, so reading `.satisfied` off it raises inside the guard that exists
  -- to stop a fault mattering.
  v_sat      boolean;
  v_nchecked integer;
  v_detail   text;
BEGIN
  IF _action NOT IN ('retry', 'record') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'action must be retry or record');
  END IF;
  IF coalesce(trim(_reason), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'a reason is required and is recorded on the row');
  END IF;

  SELECT * INTO v_row FROM public.schema_migration_queue WHERE version = _version;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', format('no queue row for version %s', _version));
  END IF;
  IF v_row.status <> 'failed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('version %s is %s, not failed — there is nothing to resolve', _version, v_row.status));
  END IF;

  IF _action = 'retry' THEN
    UPDATE public.schema_migration_queue
       SET status = 'queued', attempts = 0, error = NULL, sqlstate = NULL,
           started_at = NULL, finished_at = NULL,
           resolution = format('retried by an operator: %s', _reason)
     WHERE id = v_row.id;
    RETURN jsonb_build_object('ok', true, 'action', 'retry', 'version', _version);
  END IF;

  BEGIN
    SELECT satisfied, checked, detail
      INTO v_sat, v_nchecked, v_detail
      FROM aurixa.migration_effect_present(v_row.sql);
  EXCEPTION WHEN OTHERS THEN
    -- Refusing is the safe side. An evidence check that could not run is not
    -- evidence, and `record` settles a row without executing it.
    v_sat := false;
    v_nchecked := 0;
    v_detail := 'the effect check could not be evaluated';
  END;
  IF NOT coalesce(v_sat, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'refused: this migration''s declared effect is NOT present, so recording it would claim work that was never done',
      'detail', v_detail,
      'checked', v_nchecked);
  END IF;

  INSERT INTO supabase_migrations.schema_migrations (version)
  SELECT v_row.version
   WHERE NOT EXISTS (
     SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = v_row.version
   );

  UPDATE public.schema_migration_queue
     SET status = 'recorded', finished_at = now(), error = NULL,
         resolution = format('recorded by an operator: %s. Evidence (%s claim(s)): %s',
                             _reason, v_nchecked, v_detail)
   WHERE id = v_row.id;

  RETURN jsonb_build_object('ok', true, 'action', 'record', 'version', _version,
                            'evidence', v_detail);
END $function$;

revoke all on function aurixa.resolve_migration(text, text, text) from public;

-- The door into it. `aurixa` is not a schema PostgREST exposes — it answers
-- `PGRST106` — which is exactly why the drain lives there and why nothing
-- reaches it by accident. A caller therefore needs a `public` entry point, and
-- this is the whole of it: a SECURITY DEFINER wrapper owned by `postgres`,
-- carrying no logic of its own, so the rules above are enforced in one place.
create or replace function public.resolve_migration_queue_row(
  _version text, _action text, _reason text)
returns jsonb
language sql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  SELECT aurixa.resolve_migration(_version, _action, _reason)
$function$;

-- ---------------------------------------------------------------------------
-- What the queue looks like, for a caller who submitted none of it
-- ---------------------------------------------------------------------------
--
-- The third silence the incident names: `action: "status"` answers about the
-- versions the CALLER submitted, so three merges in a row reported truthfully
-- that their own files were "still queued" and not one named the failed row
-- holding the line.
create or replace function public.migration_queue_state()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  SELECT jsonb_build_object(
    'halted', EXISTS (SELECT 1 FROM public.schema_migration_queue WHERE status = 'failed'),
    -- `jsonb_agg` over no rows is NULL, not `[]`. Every reader here normalises
    -- it, but a null where a list is promised is the shape that makes the next
    -- reader — one written against this function rather than through them —
    -- throw on a queue that is simply healthy.
    'blocking', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'version', version, 'name', name, 'attempts', attempts,
        'error', error, 'sqlstate', sqlstate, 'resolution', resolution)
        ORDER BY version), '[]'::jsonb)
        FROM public.schema_migration_queue WHERE status = 'failed'),
    'waiting', (SELECT count(*) FROM public.schema_migration_queue
                 WHERE status IN ('queued', 'running')),
    'settled', (SELECT count(*) FROM public.schema_migration_queue
                 WHERE status IN ('applied', 'recorded'))
  )
$function$;

-- ---------------------------------------------------------------------------
-- Both public functions, closed and then opened to exactly one role
-- ---------------------------------------------------------------------------
--
-- `revoke ... from public` alone is not enough here. This database's
-- `pg_default_acl` grants EXECUTE on every new `public` function to `anon` AND
-- `authenticated` by name, and a grant made by name is not removed by revoking
-- from PUBLIC. 77 of 145 public functions were anon-executable when the queue
-- was built, which is why it put the drain in `aurixa` in the first place.
--
-- `resolve_migration_queue_row` refuses anything the evidence does not carry,
-- so it is not a lever even to a caller who reaches it — but a function that
-- can move a migration's status is not one to leave on the default ACL.
do $close$
declare r text;
begin
  foreach r in array array['public', 'anon', 'authenticated'] loop
    if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.migration_queue_state() from %I', r);
      execute format(
        'revoke all on function public.resolve_migration_queue_row(text, text, text) from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.migration_queue_state() to service_role';
    execute 'grant execute on function public.resolve_migration_queue_row(text, text, text) to service_role';
  end if;
end $close$;
