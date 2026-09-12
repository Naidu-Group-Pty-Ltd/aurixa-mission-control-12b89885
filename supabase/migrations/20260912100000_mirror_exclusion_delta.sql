-- Bring every mirror's exclusion policy up to the current default set.
--
-- Five patterns, in two groups. All five are already in
-- `DEFAULT_MIRROR_EXCLUSIONS`; this is the delta that registration cannot
-- deliver, because registration seeds a mirror once and these arrived after
-- all three were registered.
--
-- ## Group one: the login CAPTCHA (already live, never in any list)
--
--   src/lib/turnstileSiteKey.ts
--   src/lib/__tests__/turnstileIdentity.spec.ts
--
-- Both are on all three mirrors today and neither was in the default set —
-- put there by hand when the per-clone Turnstile identity was built, which is
-- the same way the first policy came to be incomplete. A mirror registered
-- tomorrow would have received neither, and cascading prime's copy would put
-- the prime's built-in site key literal into that tenant's repository and
-- build. The pairing rule stops it RENDERING, because the built-in is bound to
-- the backend its secret lives in, but the literal is still there — and the
-- spec that pins it would then be asserting prime's decisions about a module
-- the clone holds its own version of, which is the split that turned
-- `renderAssetNormalisation.spec.ts` red on a clone.
--
-- On the three mirrors these two rows are no-ops. That is the point: the
-- constant and the table now agree, so the next mirror gets what these three
-- already have.
--
-- ## Group two: the three workflows that write an Edge secret
--
--   .github/workflows/set-builder-stock-pdf-worker-secrets.yml
--   .github/workflows/set-builder-stock-link-secrets.yml
--   .github/workflows/rotate-internal-edge-secret.yml
--
-- Writing a Supabase Edge secret from CI needs a Supabase management
-- credential, and the prime repository is the only one in this fleet that holds
-- one: `primeOnlySecrets.pure.ts` refuses to forward `SUPABASE_ACCESS_TOKEN` by
-- name, because a classic personal access token carries every project in the
-- account including ones created after it was issued. A clone's Edge secrets
-- are written by Mission Control itself.
--
-- So on a clone each of these can only reach its own "check the credential this
-- job needs" step and fail, naming a missing setting that must never be
-- supplied there. The PDF worker one is worse than inert: its Cloudflare half
-- reads a checked-in `wrangler.jsonc` naming one worker on one account, so a
-- clone that acquired a Cloudflare token and dispatched it would rotate the
-- prime's worker bearer and store the new value in its own project.
--
-- ## Why freezing them is safe, when freezing a workflow once was not
--
-- `deploy-supabase-functions.yml` is the cautionary case. It was excluded for
-- an equally good reason, it runs on PUSH, and the exclusion also froze the
-- stand-down out of two clones that were forked before it existed — 9 of 9 and
-- 8 of 8 runs failing, for a week, which is what `deployWorkflowReconcile`
-- exists to undo.
--
-- These three are `workflow_dispatch` only. Nothing runs them, nothing is
-- judged by them, and prime's copy of a file a clone can never execute is never
-- interesting. What the exclusion buys is the other direction: a clone that
-- diverges — deletes them, or points them at infrastructure it owns — keeps
-- that divergence instead of having the next cascade write prime's copy back
-- over it. That is the `public/lead-magnet-embed.html` lesson, and a list only
-- protects what somebody remembered to add.
--
-- The prime carries a fail-closed guard in each file (`EDGE_SECRET_OWNER_REPO`,
-- compared in the shell and executed by `edgeSecretWorkflowOwnership.test.ts`).
-- That guard has to reach the clones BEFORE this runs, or this freezes the
-- unguarded version.
--
-- ## The list is generated, not transcribed
--
-- Every row below is emitted from the three entries appended to
-- `DEFAULT_MIRROR_EXCLUSIONS` in `src/server/cascade/syncExclusions.pure.ts`.
-- `syncExclusions.test.ts` reads this file together with
-- `20260826070000_seed_mirror_exclusions.sql`, concatenates their rows in
-- filename order and fails if the result is not that array exactly. There is
-- one authority; these are a projection of it.
--
-- ## Idempotent, additive, and it removes nothing
--
-- `ON CONFLICT DO NOTHING` on the (clone_id, pattern) unique constraint, so a
-- replay and any hand edit to an existing note both survive. Nothing is
-- deleted: an exclusion an operator added deliberately is not this migration's
-- to withdraw.

-- ## What this makes true
--
-- The five `check:` claims are the precise ones: each names a pattern that
-- existed in no row before this ran. They are deliberately not row COUNTS,
-- because a count here is a fact about how many mirrors the fleet happens to
-- have — 3 today, 57 rows before this and 66 after — and a claim that goes
-- false when a tenant is retired is an alarm that cries wolf.
--
-- The one countable claim is therefore a FLOOR with a meaning: at least one
-- mirror holds the whole current default set, which is 22 patterns. That is
-- what `assertMirrorPolicy` refuses to run a cascade without, and it survives
-- a clone being added or removed.
--
-- @asserts rows:clone_sync_exclusions>=22
-- @asserts check:clone_sync_exclusions.pattern=src/lib/turnstileSiteKey.ts
-- @asserts check:clone_sync_exclusions.pattern=src/lib/__tests__/turnstileIdentity.spec.ts
-- @asserts check:clone_sync_exclusions.pattern=.github/workflows/set-builder-stock-pdf-worker-secrets.yml
-- @asserts check:clone_sync_exclusions.pattern=.github/workflows/set-builder-stock-link-secrets.yml
-- @asserts check:clone_sync_exclusions.pattern=.github/workflows/rotate-internal-edge-secret.yml

INSERT INTO public.clone_sync_exclusions (clone_id, pattern, reason, note)
SELECT c.id, d.pattern, d.reason, d.note
FROM public.clones c
CROSS JOIN (VALUES
    ('src/lib/turnstileSiteKey.ts', 'protected', 'Declares this deployment''s built-in Turnstile site key and the backend its secret is paired with. Prime declares a literal, a clone declares null and uses VITE_TURNSTILE_SITE_KEY.'),
    ('src/lib/__tests__/turnstileIdentity.spec.ts', 'protected', 'Asserts THIS deployment''s Turnstile decisions, which contradict prime''s. It travels with turnstileSiteKey.ts because a spec and the module it pins are one setting in two files — the split is what turned renderAssetNormalisation.spec.ts red on a clone.'),
    ('.github/workflows/set-builder-stock-pdf-worker-secrets.yml', 'protected', 'Writes an Edge secret and a Cloudflare worker secret. wrangler.jsonc names one worker on one account, so running it from a clone would rotate the prime''s worker bearer and store the new value in the clone''s own project. Guarded at source by EDGE_SECRET_OWNER_REPO; held here so a clone''s own divergence is never reverted.'),
    ('.github/workflows/set-builder-stock-link-secrets.yml', 'protected', 'Writes an Edge secret, which needs a Supabase management credential no clone repository may hold. Guarded at source by EDGE_SECRET_OWNER_REPO; held here so a clone''s own divergence is never reverted.'),
    ('.github/workflows/rotate-internal-edge-secret.yml', 'protected', 'Rotates INTERNAL_EDGE_SECRET, which Mission Control mints and rotates per clone through cloneSigningPair. Guarded at source by EDGE_SECRET_OWNER_REPO; held here so a clone''s own divergence is never reverted.')
) AS d(pattern, reason, note)
WHERE c.sync_scope = 'mirror'
ON CONFLICT (clone_id, pattern) DO NOTHING;
