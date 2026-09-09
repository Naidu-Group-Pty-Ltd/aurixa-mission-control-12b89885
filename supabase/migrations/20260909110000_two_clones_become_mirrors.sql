-- @asserts rows:clone_sync_exclusions>=30
--
-- The floor is what this migration guarantees BY CONSTRUCTION, not a count
-- taken from today's database. Step 2 refuses to finish unless each of the
-- two targets holds at least 10 exclusions, and the rows it copied came from
-- a mirror that therefore holds at least 10 of its own: 3 x 10. Asserting
-- today's actual number (17 patterns x 3) would be a claim about the current
-- DEFAULT_MIRROR_EXCLUSIONS rather than about this migration, and would go
-- false the day somebody legitimately retires a pattern.

-- `npc-test-76b3b3` and `preflight-property-group` become mirrors.
--
-- ## Why
--
-- A module-scoped clone cannot pass the prime's repository-wide CI, and that
-- is not a bug in any one check — it is what the two scopes mean. A module's
-- globs are drawn around a FEATURE; prime's CI is drawn around the
-- REPOSITORY, and its checks assert properties of the whole tree: that an edge
-- function contains a particular call, that a generated file still matches the
-- source it was generated from, that the installed lockfile carries no
-- advisory. A clone that receives a SUBSET fails them by construction. Nothing
-- is broken; the check is asking a question about a tree the clone was never
-- given.
--
-- Measured 9 Sep 2026, chasing it to green on both clones, one layer at a
-- time. Every round delivered the JUDGE without what the judge reads:
--
--   payload            check then failed on
--   -----------------  ----------------------------------------------------
--   Calendar.tsx       the module it imports
--   the `@/` imports   a `./` relative import
--   the missing files  a file PRESENT but stale
--   src/lib/integr…**  update-integration-secret/index.ts — what its test READS
--   prime's ci.yml     cloudflare/builder-stock-pdf-worker/ — what its job READS
--
-- `repositoryInvariants` was the attempt to name that closure as a fixed list.
-- It cannot be finite: the next check reads the next thing.
--
-- The control settles it. `npc-client-dashboard` is a MIRROR, is green on all
-- three checks, and has been in sync throughout. The two clones that could not
-- sync are exactly the two that are module-scoped.
--
-- ## The order is the safety property
--
-- `assertMirrorPolicy` refuses a mirror with no exclusions, because a
-- whole-tree cascade with an empty policy overwrites the clone's backend
-- identity — its Supabase project, its hosting config, its own lead-capture
-- embed. So the rows are seeded FIRST and the scope is flipped only for clones
-- that then hold them. A migration that flipped the column first would leave a
-- window in which a cascade could do exactly the damage that assertion exists
-- to prevent.
--
-- ## There is no second list here
--
-- `20260826070000_seed_mirror_exclusions.sql` transcribes
-- `DEFAULT_MIRROR_EXCLUSIONS`, and `syncExclusions.test.ts` fails if the two
-- ever disagree. Writing the patterns out again here would create a third copy
-- with nothing pinning it, which is precisely how the first policy came to be
-- incomplete — two paths missing, both reverted by a live cascade, one of them
-- posting a clone's leads into the prime's database.
--
-- So these rows are COPIED from the clones that already carry the policy.
-- Whatever the live default set is, that is what the new mirrors get.

-- 1. Seed, from the policy already in force on existing mirrors.
INSERT INTO public.clone_sync_exclusions (clone_id, pattern, reason, note)
SELECT target.id, src.pattern, src.reason, src.note
FROM public.clones target
CROSS JOIN (
  SELECT DISTINCT ON (e.pattern) e.pattern, e.reason, e.note
  FROM public.clone_sync_exclusions e
  JOIN public.clones m ON m.id = e.clone_id
  WHERE m.sync_scope = 'mirror'
  ORDER BY e.pattern, e.created_at NULLS LAST
) AS src
WHERE target.github_repo IN ('npc-test-76b3b3', 'preflight-property-group')
ON CONFLICT (clone_id, pattern) DO NOTHING;

-- 2. Refuse rather than create an unsafe mirror.
--
-- If step 1 found no source policy to copy — no existing mirror, or its rows
-- gone — every clone below would be flipped to a whole-tree cascade with an
-- empty exclusion set. That is the one outcome this must never produce, so it
-- fails the migration instead and the queue halts with a message naming the
-- cause.
DO $guard$
DECLARE _short record;
BEGIN
  FOR _short IN
    SELECT c.github_repo, count(e.clone_id) AS n
    FROM public.clones c
    LEFT JOIN public.clone_sync_exclusions e ON e.clone_id = c.id
    WHERE c.github_repo IN ('npc-test-76b3b3', 'preflight-property-group')
    GROUP BY c.github_repo
    HAVING count(e.clone_id) < 10
  LOOP
    RAISE EXCEPTION
      'refusing to make % a mirror: it holds only % exclusion(s). A whole-tree '
      'cascade with an empty or partial policy overwrites this clone''s backend '
      'identity. Seed clone_sync_exclusions from DEFAULT_MIRROR_EXCLUSIONS first.',
      _short.github_repo, _short.n;
  END LOOP;
END $guard$;

-- 3. Flip the scope. Named repositories only: this is a decision about two
--    tenants, not a fleet-wide policy change, and a later clone provisioned as
--    `modules` is unaffected.
UPDATE public.clones
   SET sync_scope = 'mirror'
 WHERE github_repo IN ('npc-test-76b3b3', 'preflight-property-group')
   AND sync_scope IS DISTINCT FROM 'mirror';
