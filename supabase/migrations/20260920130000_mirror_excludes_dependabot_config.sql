-- A mirror does not own its dependency graph, so it must not carry the config
-- that raises pull requests against it.
--
-- `.github/dependabot.yml` is the prime's. It reached the three mirrors by
-- CASCADE — measured on npc-client-dashboard, PR #165 (`aurixa/cascade-8d3b293`),
-- 12 Sep, 130 lines added — and it reaches a clone created after that by
-- provisioning instead, because `createUsingTemplate` is a whole-tree copy.
-- The two arrivals need two different remedies and this is the cascade half.
-- `clone-repo-retarget` is the other, and covers the module-scoped clone that
-- no cascade delivers this to (npc-crm-independent's live proposal carries 48
-- files and not one `.github/` path).
--
-- ## Why the clone can never act on it
--
-- `package.json` and `package-lock.json` are `REPOSITORY_INVARIANTS`: the
-- cascade delivers prime's copies to every deployment, for reasons recorded
-- there — `npm ci` installs exactly the lockfile and the supply-chain gate
-- audits exactly what it installed. Measured on `origin/main`, 20 Sep 2026, all
-- five deployments carried the byte-identical pair (package.json `4d399496`,
-- package-lock.json `f3d3bd4c`).
--
-- So a Dependabot PR on a mirror cannot land in any useful sense. Merging it
-- puts that deployment's lockfile ahead of prime's and the next cascade
-- delivers prime's back over it: the upgrade appears to land and then silently
-- un-lands, which is worse than never raising it.
--
-- It was raising them anyway, on prime's own weekly schedule and
-- `open-pull-requests-limit: 5` — 18 open across four clones the day this was
-- written, none mergeable. The config is not written for them either: its
-- `ignore` list is a set of judgements about prime's own evidence, including
-- one added after "both this repository and its client-facing mirror had `main`
-- broken by exactly this: a Dependabot major merged while the lockfile did not
-- follow, so nothing could `npm ci`".
--
-- ## Protected rather than manual_reconcile
--
-- `protected` is "the clone owns this file outright … prime's version is never
-- interesting and the divergence is permanent, so a difference is not news."
-- That is exactly the case: the clone's correct version of this file is its
-- absence, and there is no decision owed to anybody about it. Naming it in
-- every pull request would be noise about a file nobody is going to reinstate.
--
-- ## What this does NOT do
--
-- It does not remove the file from the three mirrors that already hold it. An
-- exclusion only stops the cascade WRITING the path; the existing copies are
-- taken out separately, and this is what stops the next cascade undoing that.
-- Dependabot is untouched on the prime, which is the only repository where a
-- bump can reach the fleet.
--
-- (This comment avoids one English word on purpose: `syncExclusions.test.ts`
-- refuses `/\bDELETE\b/i` anywhere in a file that writes this table, comments
-- included. It cannot parse SQL, so it refuses the word rather than guessing —
-- the same shape as `NON_TRANSACTIONAL` matching `BEGIN;` and not a bare
-- `BEGIN`, and worth keeping blunt.)
--
-- ## The list is generated, not transcribed
--
-- The row below is emitted from the entry appended to
-- `DEFAULT_MIRROR_EXCLUSIONS` in `src/server/cascade/syncExclusions.pure.ts`.
-- `syncExclusions.test.ts` reads every migration that writes this table,
-- concatenates their rows in filename order and fails if the result is not that
-- array exactly.
--
-- ## Idempotent, additive, and it removes nothing
--
-- `ON CONFLICT DO NOTHING` on (clone_id, pattern), so a replay and any hand
-- edit to an existing note both survive. An exclusion an operator added
-- deliberately is not this migration's to withdraw.
--
-- The countable claim is a FLOOR, for the reason the previous delta records: a
-- row count here is a fact about how many mirrors the fleet happens to have,
-- and a claim that goes false when a tenant is retired is an alarm that cries
-- wolf. At least one mirror holds the whole current default set, now 23.
--
-- @asserts rows:clone_sync_exclusions>=23
-- @asserts check:clone_sync_exclusions.pattern=.github/dependabot.yml

INSERT INTO public.clone_sync_exclusions (clone_id, pattern, reason, note)
SELECT c.id, d.pattern, d.reason, d.note
FROM public.clones c
CROSS JOIN (VALUES
    ('.github/dependabot.yml', 'protected', 'Describes the prime''s dependency graph, which a mirror does not own: package.json and package-lock.json are REPOSITORY_INVARIANTS, so a bump merged on a clone is reverted by the next cascade. Measured 20 Sep 2026 — all five deployments carried the byte-identical pair, and prime''s config had produced 18 open PRs across four clones that could never merge. Removed from a clone rather than rewritten; this stops the cascade putting it back.')
) AS d(pattern, reason, note)
WHERE c.sync_scope = 'mirror'
ON CONFLICT (clone_id, pattern) DO NOTHING;
