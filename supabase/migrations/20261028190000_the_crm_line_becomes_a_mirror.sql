-- @asserts none:one clone's scope and its missing exclusion rows; no object is created, and no table-wide count could tell this ran
--
-- It claims nothing the queue can check, on purpose. The queue asks a
-- migration that failed whether the effect it claims is already present, and
-- settles it as `recorded` when every checkable claim holds
-- (`20260913090000_a_halt_that_resolves_itself.sql`). Any count of
-- `clone_sync_exclusions` this file could claim already holds from the other
-- clones' rows (166 on 28 Oct 2026), so a refusal by the guard in step 4 would
-- be recorded as done and the queue would move on with the CRM still
-- module-scoped. The queue never evaluates `none`, so a refusal halts it. The
-- guard is this file's proof of its effect, and the read-back after it applies
-- is the CRM's own row: `mirror`, with 31 exclusions.

-- `npc-crm-independent-6505dc`, the independent CRM line's head, becomes a
-- mirror (D15 of docs/DELIVERY_SYSTEM_PLAN.md).
--
-- ## Why
--
-- Module scope delivers only the paths inside the clone's installed modules'
-- globs, so everything outside them stays as it was on the day the clone was
-- created. Measured 27 Oct 2026, the CRM read `in_sync` while missing 495 of
-- the prime's files and holding 32 stale ones, and the client half of D18 (a
-- workspace's agreement excluding a module at every gate) never reached it,
-- because no CRM module covers `src/lib/entitlements/`. Every other clone is a
-- mirror, and every clone created since 27 Oct is one
-- (`20261027100000_clones_default_to_mirror_scope.sql`).
--
-- ## What the line keeps
--
-- The line is a variant of the prime, not a copy of it, and the engine knows
-- which of its files are its own without a row here:
--
--   - `CRM_LINE_FEATURES`: what the line does not carry (the GoHighLevel
--     integration), held `protected`;
--   - `CRM_LINE_VARIANT_PATTERNS`: files it carries in its own shape, held for
--     a person;
--   - `CRM_LINE_KEPT_PATTERNS`: trees it keeps whole (its rules, its agent
--     specs, `clientImportRecords.spec.ts`), held `protected`, a deletion as
--     well as a write.
--
-- The owner chose the third set on 28 Oct 2026 after a replay of this switch
-- with the cascade engine against the live records. As things stood, the
-- cascade pull request would have been red: the prime's agent specs import a
-- module the line removed, and the drain never merges a red pull request.
-- That engine shipped and was published first, because this file flips the
-- scope the moment it applies, and a cascade on the old engine would carry
-- all three trees in.
--
-- ## The guard is the safety property
--
-- A whole-tree cascade with a partial policy overwrites a clone's backend
-- identity (`assertMirrorPolicy`), so the clone must hold the policy before
-- any cascade reads it as a mirror. The queue applies a migration inside a
-- savepoint of the drain's one transaction (docs/MIGRATION_QUEUE.md), so no
-- reader sees the clone between these statements, and the guard in step 4
-- undoes every one of them, the flip included, if the policy is incomplete.
-- That is why the flip can come first: the seed in step 2 is mirror-scoped,
-- as every seed of the default policy is.
--
-- ## The policy, from its one authority
--
-- The CRM holds 22 of the 25 rows of `DEFAULT_MIRROR_EXCLUSIONS` and six of
-- its own. It lacks `.github/dependabot.yml` (Dependabot would open weekly
-- pull requests on the CRM that can never merge),
-- `src/integrations/supabase/supabaseTarget.pure.ts` and
-- `.github/workflows/vcr-prune.yml`.
--
--   - `vcr-prune.yml` is the constant's newest entry, whose seed was owed
--     (`SEED_OWED` in `syncExclusions.test.ts`): the two mirrors that inherit
--     the file from their parent wrote the pattern by hand on 26 Oct, each
--     with a note about its own repository, and the third mirror is the
--     parent that owns it. The CRM never held the file, so neither of those
--     notes is true of it. It takes the constant's row, and the test pins
--     this row to the constant.
--   - The other two are copied from the two mirrors whose rows are exactly
--     the default set, so no pattern is written out a second time. Their
--     notes there are the constant's, byte for byte (measured 28 Oct).
--
-- `npc-client-dashboard` is not a source: it holds rows of its own (the CRM
-- line's rule files, kept off it), and those are not the CRM's.

-- 1. Flip the scope. The named repository only: a decision about one line
--    head, not a fleet-wide policy.
UPDATE public.clones
   SET sync_scope = 'mirror'
 WHERE github_repo = 'npc-crm-independent-6505dc'
   AND sync_scope IS DISTINCT FROM 'mirror';

-- 2. Seed the default the fleet still owed, as the constant states it.
INSERT INTO public.clone_sync_exclusions (clone_id, pattern, reason, note)
SELECT c.id, v.pattern, v.reason, v.note
FROM public.clones c
CROSS JOIN (VALUES
  ('.github/workflows/vcr-prune.yml', 'protected', 'NPC Client Dashboard''s own retention job: it prunes the Vercel container registry of that deployment''s project, prj_Mi3Wyu1ZsY7C9u6Q3ElzR7xRS3tj, and with redeploy=true creates a production deployment of it, using a VERCEL_TOKEN or VERCEL_API_TOKEN secret that only the dashboard''s repository holds. The prime has no such file. Lineage cascades delivered it to the dashboard''s two children on 21 Sep 2026, where it failed every Sunday for want of a token until it was deleted by hand on 26 Oct 2026, and a clone created from the dashboard''s repository receives it in its first commit. Held so no cascade delivers it again.')
) AS v(pattern, reason, note)
WHERE c.sync_scope = 'mirror'
  AND c.github_repo = 'npc-crm-independent-6505dc'
ON CONFLICT (clone_id, pattern) DO NOTHING;

-- 3. Copy the rest of the policy already in force on the two default mirrors.
--    The row step 2 wrote is already there, so its copy is skipped.
INSERT INTO public.clone_sync_exclusions (clone_id, pattern, reason, note)
SELECT target.id, src.pattern, src.reason, src.note
FROM public.clones target
CROSS JOIN (
  SELECT DISTINCT ON (e.pattern) e.pattern, e.reason, e.note
  FROM public.clone_sync_exclusions e
  JOIN public.clones m ON m.id = e.clone_id
  WHERE m.sync_scope = 'mirror'
    AND m.github_repo IN ('npc-test-76b3b3', 'preflight-property-group')
  ORDER BY e.pattern, e.created_at NULLS LAST
) AS src
WHERE target.github_repo = 'npc-crm-independent-6505dc'
ON CONFLICT (clone_id, pattern) DO NOTHING;

-- 4. Refuse rather than create an unsafe mirror.
--
-- If a source had lost its rows, or the copy above missed a pattern, the CRM
-- would be flipped to a whole-tree cascade with a partial policy. That is the
-- one outcome this must never produce, so it fails the migration instead: the
-- savepoint rolls back the flip with the rows, and the queue halts with a
-- message naming the cause.
DO $guard$
DECLARE
  _source record;
  _missing integer;
BEGIN
  FOR _source IN
    SELECT c.github_repo, count(e.clone_id) AS n
    FROM public.clones c
    LEFT JOIN public.clone_sync_exclusions e ON e.clone_id = c.id
    WHERE c.github_repo IN ('npc-test-76b3b3', 'preflight-property-group')
    GROUP BY c.github_repo
    HAVING count(e.clone_id) < 20
  LOOP
    RAISE EXCEPTION
      'refusing to make the CRM a mirror: its source % holds only % exclusion(s), '
      'so the copy cannot be the default policy.',
      _source.github_repo, _source.n;
  END LOOP;

  SELECT count(*) INTO _missing
  FROM (
    SELECT DISTINCT e.pattern
    FROM public.clone_sync_exclusions e
    JOIN public.clones m ON m.id = e.clone_id
    WHERE m.github_repo IN ('npc-test-76b3b3', 'preflight-property-group')
  ) AS wanted
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.clone_sync_exclusions x
    JOIN public.clones c ON c.id = x.clone_id
    WHERE c.github_repo = 'npc-crm-independent-6505dc'
      AND x.pattern = wanted.pattern
  );
  IF _missing > 0 THEN
    RAISE EXCEPTION
      'refusing to make the CRM a mirror: it lacks % pattern(s) of the default '
      'policy. A whole-tree cascade with a partial policy overwrites this '
      'clone''s backend identity.',
      _missing;
  END IF;
END $guard$;
