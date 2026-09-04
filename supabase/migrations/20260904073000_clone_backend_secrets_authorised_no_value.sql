-- @asserts none:widens a CHECK constraint. The effect is real and observable — a write of
--   `authorised_no_value` succeeds after this and is refused before it — but the assertion
--   grammar has no kind for a constraint, and a claim nobody can parse looks like coverage
--   while checking nothing. Said plainly rather than mis-declared as a column or a table.
-- An authorised forward that did not happen is not an unauthorised name.
--
-- The forwarded-key model reads the prime's vendor credentials out of Mission
-- Control's OWN environment, so a name marked inheritable in
-- `prime_secret_forwards` still cannot travel if Mission Control holds no
-- value for it. That case reported as `missing` — which is also what a name
-- nobody authorised reports as — so the ledger an operator reads could not
-- tell "nobody said this may travel" from "somebody said it may, and it did
-- not".
--
-- Measured 4 Sep 2026 on the first clone this engine drove to `ready` through
-- a repair: 72 secrets read `missing`, and TEN of them were authorised
-- forwards that silently did not happen — ANTHROPIC_API_KEY,
-- OPENROUTER_API_KEY, PERPLEXITY_API_KEY, GOOGLE_MAPS_API_KEY,
-- DOMAIN_API_KEY, GAMMA_API_KEY, FIRECRAWL_API_KEY, API2PDF_API_KEY,
-- PDF_PARSE_SERVICE_TOKEN and WEASYPRINT_SERVICE_TOKEN. Those are exactly the
-- vendor keys a tenant is supposed to boot with under the prime's accounts.
--
-- The remedies differ, which is the whole point of separating them: set the
-- value on Mission Control, or withdraw the forward. Neither is "fill this in
-- on the clone", which is what `missing` tells an operator to do.
--
-- The value goes on the COLUMN, not only in the code: the status is
-- CHECK-constrained, so a status the column does not accept is refused by
-- Postgres while looking, from the function, exactly like a write nobody
-- attempted. That is how this table's ledger came to be empty once already.
alter table public.clone_backend_secrets
  drop constraint if exists clone_backend_secrets_status_check;

alter table public.clone_backend_secrets
  add constraint clone_backend_secrets_status_check
  check (status = any (array['missing'::text, 'set'::text, 'failed'::text, 'inherited'::text, 'authorised_no_value'::text]));

comment on column public.clone_backend_secrets.status is
  'missing = no value and none authorised, the operator supplies one; set = written by provisioning; inherited = forwarded from the prime; failed = the write was refused; authorised_no_value = marked inheritable and Mission Control holds no value, so nothing was forwarded — fix it on Mission Control, not on the clone.';
