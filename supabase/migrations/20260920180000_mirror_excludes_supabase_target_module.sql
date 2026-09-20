-- Protect the OTHER module a deployment can declare its Supabase pair in.
--
-- `src/integrations/supabase/env.ts` has been the first entry in this list
-- since it was written, under the note "Names the Supabase project this
-- deployment talks to. Prime's version points at prime's database." That is
-- still true, and it stopped being the whole truth:
-- `npc-crm-independent-6505dc` declares its pair in
-- `src/integrations/supabase/supabaseTarget.pure.ts`, because a Vite config
-- cannot import `env.ts` and the reads had to be split out for the build to
-- resolve the project ref at all.
--
-- Measured 20 Sep 2026, the fleet holds both layouts at once:
--
--   npc-property-dashbord (prime)   dduzbchuswwbefdunfct   env.ts
--   npc-crm-independent             qvuwrvwzjyigptmnijyb   supabaseTarget.pure.ts
--   npc-test                        umrtusxohxjxzodxorim   env.ts
--   preflight-property-group        egrmsulhtmqnmhvuccxr   env.ts
--
-- ## Why this reads as safe today, and is not
--
-- The prime does not carry the file. A cascade copies what the SOURCE has, so
-- there is nothing to deliver and no clone has ever been harmed by the
-- omission. That is containment by accident, and it ends the day the prime
-- adopts the same split — which it has a standing reason to, since the split
-- exists because a Vite config cannot import `env.ts` anywhere.
--
-- At that moment a cascade would write the prime's `FALLBACK_URL` and
-- `FALLBACK_ANON_KEY` over npc-crm's, and that clone's app would fall back to
-- the prime's database. The exact defect the first entry in this list exists
-- to prevent, reached through the file it does not name.
--
-- ## Why the guard is not the answer
--
-- `src/lib/__tests__/shippedBackendIdentity.spec.ts` now ships on every
-- deployment and is run by a CI step that names it by exact path, so the swap
-- would turn that clone's CI red rather than passing silently. That is worth
-- having and it is not a substitute: a guard catching it afterwards still
-- means a cascade wrote another tenant's database into this one's resolver and
-- somebody has to undo it. Prevention and detection are different jobs, and
-- this list is the prevention.
--
-- ## The spec itself is deliberately NOT excluded
--
-- Worth stating, because the instinct from `turnstileIdentity.spec.ts` — which
-- IS protected, two rows above — points the wrong way here. That one pins
-- THIS deployment's Turnstile decisions, which contradict the prime's, so
-- cascading it would assert the prime's choices about a module the clone holds
-- its own version of.
--
-- `shippedBackendIdentity.spec.ts` asserts nothing deployment-specific: it
-- reads its own project ref out of `supabase/config.toml`, which is protected,
-- so the byte-identical file checks a different answer on every deployment.
-- Cascading it is how a new clone receives the guard at all. Protecting it
-- would freeze the guard at whatever version a clone was forked with.
--
-- ## The list is generated, not transcribed
--
-- The row below is emitted from the entry appended to
-- `DEFAULT_MIRROR_EXCLUSIONS` in `src/server/cascade/syncExclusions.pure.ts`.
-- `syncExclusions.test.ts` reads every migration that seeds this table, by
-- what its SQL DOES rather than from a list of filenames, concatenates their
-- rows in filename order and fails if the result is not that array exactly.
-- There is one authority; this is a projection of it.
--
-- ## Idempotent, additive, and it removes nothing
--
-- `ON CONFLICT DO NOTHING` on (clone_id, pattern), so a replay and any hand
-- edit to an existing note both survive. An exclusion an operator added
-- deliberately is not this migration's to withdraw.
--
-- The countable claim is a FLOOR, for the reason the earlier deltas record: a
-- row count here is a fact about how many mirrors the fleet happens to have,
-- and a claim that goes false when a tenant is retired is an alarm that cries
-- wolf. At least one mirror holds the whole current default set, now 24.
--
-- @asserts rows:clone_sync_exclusions>=24
-- @asserts check:clone_sync_exclusions.pattern=src/integrations/supabase/supabaseTarget.pure.ts

INSERT INTO public.clone_sync_exclusions (clone_id, pattern, reason, note)
SELECT c.id, d.pattern, d.reason, d.note
FROM public.clones c
CROSS JOIN (VALUES
    ('src/integrations/supabase/supabaseTarget.pure.ts', 'protected', 'The other place a deployment can declare its built-in Supabase pair. `env.ts` beside it has been protected since this list was written; this is the same setting after npc-crm-independent split the reads out so a Vite config could import them. Prime does not carry the file today, so a cascade delivers nothing and the omission is invisible — containment by accident, which ends the day prime adopts the split. The clone''s shippedBackendIdentity guard would turn red rather than the swap being silent, but a guard catching it afterwards is not a reason to let the cascade write prime''s database into a tenant''s resolver.')
) AS d(pattern, reason, note)
WHERE c.sync_scope = 'mirror'
ON CONFLICT (clone_id, pattern) DO NOTHING;
