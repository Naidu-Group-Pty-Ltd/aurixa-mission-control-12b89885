-- @asserts column:clones.parent_clone_id

-- THE CLONE TREE WAS NEVER RECORDED ANYWHERE. IT WAS GUESSED AT RENDER TIME.
--
-- `useTreeLayout`'s `inferHierarchy` built Yggdrasil from `tags[0]` plus
-- `created_at`: clones sharing a first tag became a group, the OLDEST of that
-- group became its root, and every other member became that root's child.
-- Nothing in the database said so. Three things follow, and each one bites.
--
--  1. **The shape moved on its own.** A clone added to a tag group re-parents
--     itself onto whichever member happens to be oldest; edit `created_at` on
--     a restore and the root flips. Nobody wrote either change down, so
--     nothing can report it.
--
--  2. **The picture and the cascade read the same field for different
--     questions.** `tags` is a cascade TARGETING mechanism — a cascade with
--     `scope: 'tagged'` picks its clones by tag. Reshaping the tree by
--     editing a tag therefore silently changes which clones a tagged cascade
--     hits. One field, two authorities, no test between them.
--
--  3. **The inference cannot express depth.** A group root's children are the
--     whole rest of the group, so the shape it can draw is exactly two levels
--     and never three. A grandchild had nowhere to be.
--
-- `parent_clone_id` is the record. `NULL` means "cascades from prime", which
-- is what every clone is today and what every clone stays until somebody
-- says otherwise — so this column changes no behaviour on the day it lands.
--
-- ## Why a trigger and not a CHECK
--
-- A cycle is not a property of one row. `A→B→A` is legal in both rows read
-- separately and fatal read together: the cascade walks a clone's ancestry to
-- resolve its source, and a loop there is an unbounded walk inside the engine.
-- A CHECK constraint sees one row and cannot see the loop, so the guard has
-- to read the table — which is a trigger.
--
-- The walk is BOUNDED (`_max_depth`) rather than trusted to terminate. A
-- guard that assumes the data it is guarding is already acyclic is not a
-- guard; if a loop ever gets in by some path this trigger does not cover, the
-- bound is what stops it hanging the transaction instead.
--
-- ## The populated shape
--
-- Recorded 20 Sep 2026, from the operator's worktree diagram:
--
--     npc-property-dashbord                     (PRIME — prime_config, not a clone row)
--     ├── npc-client-dashboard                  (parent NULL — from prime)
--     │   ├── preflight-property-group          (parent → npc-client-dashboard)
--     │   └── npc-test-76b3b3                   (parent → npc-client-dashboard)
--     └── npc-crm-independent-6505dc            (parent NULL — from prime)
--
-- Keyed on `github_repo` because that is the clone's identity in every other
-- migration that has had to name these four rows, and because `slug` is
-- operator-editable while the repository is not.
--
-- Idempotent: re-running re-asserts the same four parents and changes nothing
-- else. It writes ONLY the two rows the diagram nests and leaves every other
-- clone's parent exactly as it found it — a migration that set the column for
-- rows it was not told about would be inventing lineage, which is the fault
-- this column exists to end.

alter table public.clones
  add column if not exists parent_clone_id uuid
    references public.clones(id) on delete set null;

comment on column public.clones.parent_clone_id is
  'The clone this clone receives cascades FROM. NULL means it receives from prime, which is the default and the state of every clone before 20 Sep 2026. Never inferred: Yggdrasil and the cascade engine both read this column, and a row nobody has classified stays NULL rather than being guessed at from tags or creation order.';

-- The referencing side of a foreign key is never indexed by Postgres. Without
-- this, resolving a clone's children — which the tree does per node and the
-- cascade does per pass — is a sequential scan.
create index if not exists idx_clones_parent_clone_id
  on public.clones (parent_clone_id);

-- ---------------------------------------------------------------------------
-- The cycle guard
-- ---------------------------------------------------------------------------

create or replace function public.assert_clone_parent_acyclic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _cursor uuid;
  _depth int := 0;
  -- Deeper than any fleet this will plausibly hold, and finite either way.
  _max_depth constant int := 64;
begin
  if new.parent_clone_id is null then
    return new;
  end if;

  if new.parent_clone_id = new.id then
    raise exception
      'Clone % cannot be its own parent.', new.id
      using errcode = 'check_violation';
  end if;

  _cursor := new.parent_clone_id;

  while _cursor is not null loop
    _depth := _depth + 1;

    if _depth > _max_depth then
      raise exception
        'Clone parent chain from % exceeds % levels; refusing a walk that may not terminate.',
        new.id, _max_depth
        using errcode = 'check_violation';
    end if;

    if _cursor = new.id then
      raise exception
        'Clone % cannot descend from itself — parent % closes a cycle.',
        new.id, new.parent_clone_id
        using errcode = 'check_violation';
    end if;

    select c.parent_clone_id into _cursor
      from public.clones c
     where c.id = _cursor;
  end loop;

  return new;
end;
$$;

comment on function public.assert_clone_parent_acyclic() is
  'Refuses a parent_clone_id that makes a clone its own ancestor. A cycle is a property of the table rather than of one row, so it cannot be a CHECK. The walk is bounded so a loop arriving by any path this does not cover fails loudly instead of hanging the transaction.';

drop trigger if exists trg_clones_parent_acyclic on public.clones;
create trigger trg_clones_parent_acyclic
  before insert or update of parent_clone_id on public.clones
  for each row
  execute function public.assert_clone_parent_acyclic();

-- ---------------------------------------------------------------------------
-- Record the drawn tree
-- ---------------------------------------------------------------------------

update public.clones child
   set parent_clone_id = parent.id,
       updated_at = now()
  from public.clones parent
 where parent.github_repo = 'npc-client-dashboard'
   and child.github_repo in ('preflight-property-group', 'npc-test-76b3b3')
   and child.parent_clone_id is distinct from parent.id;
