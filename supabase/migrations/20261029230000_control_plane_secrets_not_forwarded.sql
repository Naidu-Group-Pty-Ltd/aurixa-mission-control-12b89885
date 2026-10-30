-- @asserts none:updates two prime_secret_forwards rows, creates no object
--
-- GITHUB_WEBHOOK_SECRET and VAPI_API_KEY stop being fleet policy.
--
-- Both were fleet rows marked `inherit`, so both sat on all five clones
-- (`inherited` in clone_backend_secrets, measured 29 Oct 2026; key audit S1
-- and S2). The first is Mission Control's own GitHub webhook signing secret:
-- /hooks/github trusts anything signed with it, and no clone reads it. The
-- second is Aurixa's organisation-wide Vapi key, which reaches every tenant's
-- assistants and the prime's; Mission Control's own design holds each clone's
-- Vapi organisation in custody and puts no Vapi key on a clone
-- (CLONE_VOICE_AUTOMATION.md, item 3). No clone has ever logged a Vapi call.
--
-- The refusal is in code, where a deleted row cannot undo it:
-- `CONTROL_PLANE_SECRETS` in primeOnlySecrets.pure.ts makes both `prime_only`,
-- both forward paths and the Integrations broker refuse them, and the
-- half-hourly clone-secrets reconcile removes them from any clone found
-- holding one. These rows are the forwarding page's record of that decision,
-- so the page no longer says the opposite.
update public.prime_secret_forwards
   set inherit = false,
       description = case name
         when 'GITHUB_WEBHOOK_SECRET' then
           'Mission Control''s own GitHub webhook signing secret. Control plane only: never forwarded, and removed from any clone holding it.'
         when 'VAPI_API_KEY' then
           'Aurixa''s organisation-wide Vapi key. Control plane only: never forwarded, and removed from any clone holding it. Each clone''s own Vapi organisation is held by Mission Control.'
       end,
       updated_at = now()
 where name in ('GITHUB_WEBHOOK_SECRET', 'VAPI_API_KEY');
