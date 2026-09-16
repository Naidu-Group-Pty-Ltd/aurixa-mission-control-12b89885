-- ===========================================================================
-- The Aurixa reception line — registering the number the fleet answers on
--
-- @asserts rows:voice_phone_numbers>=1
--
-- `+61 2 8105 6305` now answers in the Aurixa Systems VAPI org
-- (`453f00c2-cb26-43f0-8da3-2eb13b578e15`) as phone record
-- `83b9a6d8-5666-41a5-8b97-ed94aa550ea0`, bound to the MC Reception Squad
-- `d6bfd085-2724-476d-9d5e-0c9d72463e4c` and named "Aurixa Systems
-- Reception". Verified by effect on 2026-09-16: a live call resolved a
-- contact, read call context and answered from the knowledge base through
-- `/api/public/voice/webhook`.
--
-- Inbound works without this migration. **Outbound does not**, and that is
-- what this fixes.
--
-- ## Why the table is empty in the first place
--
-- `20260826120000` seeded five NPC numbers; `20260827000000` deleted all five
-- when the fleet was retargeted at the Aurixa account, with the honest
-- comment that "the Aurixa account holds no phone numbers yet". Both files
-- were then applied a SECOND time by byte-identical duplicates
-- (`20260827020519`, `20260827020707`), so the net is zero rows — and
-- `20260827020707:84` re-ran `UPDATE voice_campaign_rules SET
-- vapi_phone_number_id = NULL` after the Aurixa cadences were inserted.
-- Nothing since has set one.
--
-- ## What a NULL phone id actually does
--
-- It is not a local precondition check. `dispatchOne`
-- (`src/server/voice.server.ts:411`) omits the key entirely when the job's
-- id is falsy, posts `/call` without `phoneNumberId`, and VAPI rejects it —
-- surfacing as a retried then `failed` job and a `voice_outbound_failed`
-- operator notification. The UI calls that option "VAPI default line"
-- (`src/routes/voice.agents.tsx:334`), which is optimistic about what VAPI
-- does with a missing id.
--
-- ## Three deliberate choices
--
-- **Every rule with a NULL id gets the line, not only the enabled ones.**
-- The phone id is configuration, not an on-switch: a disabled rule carrying
-- it changes nothing until somebody enables it, whereas a rule left NULL
-- fails confusingly on the day it is switched on. `checkin_at_risk` stays
-- `is_enabled = false` — that decision is untouched here.
--
-- **`IS NULL` rather than `ON CONFLICT DO NOTHING`.** The seeds are
-- re-runnable because they insert; this one has to UPDATE seventeen rows
-- that already exist, where `DO NOTHING` would silently no-op. The `IS NULL`
-- guard is what makes it idempotent AND what stops it ever overwriting a
-- choice an operator made at `/voice/agents`.
--
-- **NPC's `+61 2 8609 3299` is deliberately NOT registered.** It lives in
-- the same VAPI org now, but it is NPC's own customer line answering the NPC
-- Sales Force squad. Listing it here would offer it in the `/voice/agents`
-- picker as a line for Aurixa's outbound calls.
--
-- Note `voice_campaign_rules.vapi_phone_number_id` is free TEXT holding the
-- VAPI id — not a foreign key to `voice_phone_numbers.id`. The two are
-- matched by convention only (`voice.agents.tsx:336` populates the picker
-- with `value={p.vapi_phone_number_id}`), so the literal below is the VAPI
-- id, deliberately.
-- ===========================================================================

INSERT INTO public.voice_phone_numbers (
  vapi_phone_number_id,
  phone_number,
  provider,
  label,
  routes_to,
  route_ref,
  is_active,
  notes
) VALUES (
  '83b9a6d8-5666-41a5-8b97-ed94aa550ea0',
  '+61281056305',
  'twilio',
  'Aurixa Systems Reception',
  'squad',
  'd6bfd085-2724-476d-9d5e-0c9d72463e4c',
  true,
  'Inbound reception for Aurixa Systems. Answers the MC Reception Squad '
    || '(Front Desk, Review Booking, Solutions Advisor, Support Intake). '
    || 'Falls back to +61433005110 when the squad cannot be reached.'
)
ON CONFLICT (vapi_phone_number_id) DO NOTHING;

-- Every rule that has no line yet dials from this one.
UPDATE public.voice_campaign_rules
SET vapi_phone_number_id = '83b9a6d8-5666-41a5-8b97-ed94aa550ea0'
WHERE vapi_phone_number_id IS NULL;

-- The id is copied onto a job at enqueue time (`voice.server.ts:290`), so
-- fixing the rules fixes future enqueues only. Anything already queued and
-- not yet dispatched would still post without a `phoneNumberId`.
UPDATE public.voice_outbound_jobs
SET vapi_phone_number_id = '83b9a6d8-5666-41a5-8b97-ed94aa550ea0'
WHERE vapi_phone_number_id IS NULL
  AND status IN ('pending', 'dispatching');
