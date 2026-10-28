-- @asserts column:prime_config.clone_gate_default_hours
-- @asserts column:client_agreements.trial_days
-- @asserts column:client_agreements.trial_offer_code
--
-- The free trial is fourteen days (docs/CLONE_PAYMENT_GATES.md, "The free
-- trial is fourteen days").
--
-- On 28 Oct 2026 the owner confirmed that the free trial the website and the
-- promo videos offer is real, and that it is 14 days by default. In Mission
-- Control that trial IS the activation gate's window: a paid workspace works
-- normally until the window closes and then locks until its plan is activated.
-- The window was 72 hours.
--
--   1. The platform default becomes 336 hours. The column default changes for
--      any row created later, and the live row moves only if it still holds
--      the old default. A value an admin chose on Billing → Payment Gates is
--      a decision, not a default, and is left exactly as it is.
--
--      Gates already armed keep their deadlines. An armed gate holds the
--      window its customer was told about, and no migration touches
--      `clone_payment_gates` (paymentGate.contract.test.ts). Giving an
--      existing customer the longer trial is the console's Extend trial act.
--
--   2. `client_agreements.trial_days`: the free trial a signed agreement
--      provisions its workspace with. Null is the platform default, which is
--      every agreement that exists today. An agreement was the one way to
--      provision a workspace that could not set its own trial length.
--      `trial_offer_code` records which trial offer the length came from, if
--      any (`trial_offers`, the next migration). It is provenance, kept as
--      text: the days are what provisioning reads, and an offer retired after
--      the agreement was written must not change what it provisions.
--
-- Additive. Nothing here can lock a workspace: the default only ever applies
-- to a gate armed after it, and a longer default only lengthens trials.

alter table public.prime_config
  alter column clone_gate_default_hours set default 336;

update public.prime_config
   set clone_gate_default_hours = 336
 where clone_gate_default_hours = 72;

comment on column public.prime_config.clone_gate_default_hours is
  'The free trial a newly provisioned paid clone is armed with, in hours: how long it works before it locks behind its activation payment. 336 = fourteen days, the default the owner confirmed on 28 Oct 2026. Changing it affects the next gate armed, never an existing one.';

alter table public.client_agreements
  add column if not exists trial_days integer;

alter table public.client_agreements
  drop constraint if exists client_agreements_trial_days_range;
alter table public.client_agreements
  add constraint client_agreements_trial_days_range
  check (trial_days is null or trial_days between 1 and 365);

comment on column public.client_agreements.trial_days is
  'The free trial, in whole days, the workspace this agreement provisions is armed with. Null uses the platform default (prime_config.clone_gate_default_hours). Read once, at provisioning.';

alter table public.client_agreements
  add column if not exists trial_offer_code text;

alter table public.client_agreements
  drop constraint if exists client_agreements_trial_offer_has_days;
alter table public.client_agreements
  add constraint client_agreements_trial_offer_has_days
  check (trial_offer_code is null or trial_days is not null);

comment on column public.client_agreements.trial_offer_code is
  'The trial offer (trial_offers.code) trial_days was taken from, when it came from one. Provenance only: provisioning reads trial_days.';
