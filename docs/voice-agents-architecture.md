# Voice Agents & the Client Journey — the full loop in Mission Control

This module brings the VAPI voice-agent operation — previously spread across
Make.com scenarios, GoHighLevel and the NPC dashboard's call-logs page — into
Mission Control as one closed loop. Nothing external holds state any more:
the CRM is the client tracker, the client tracker is the outbound trigger,
and every call lands back on the client's timeline.

```
inbound call ──▶ VAPI squad ──▶ /api/public/voice/webhook (tools: resolve
                                 contact, context, availability, booking,
                                 handoff)  ──▶ crm_contacts / crm_appointments
                                                     │
client journey stage change / appointment outcome ───┤
                                                     ▼
                                        voice_outbound_jobs (queue)
                                                     │  /hooks/voice-outbound-dispatch (1 min)
                                                     ▼
                                          POST api.vapi.ai/call
                                                     │  end-of-call webhook
                                                     ▼
                              voice_call_events ──▶ /hooks/voice-call-drain (1 min)
                                                     ▼
                       voice_calls (call log) + crm_activities(kind 'call')
                                    + journey stats + alert rules
```

## What was migrated, from where

- **The Call Logs surface** replicates the NPC dashboard's `CallLogs.tsx`
  (`vapi_call_logs` in the prime repo): the same call-record vocabulary
  (39 columns incl. squad handoffs, sentiment, root cause, escalation,
  resolution workflow, tags), the same outcome mapping of VAPI
  `endedReason`s, the same quality-score rubric, live-call monitor,
  blacklist with kill modes, alert rules, negative-call review queue and
  analytics. Lesson carried over: `call_outcome` is **TEXT, not an enum** —
  the original CHECK constraint went stale the day VAPI added a reason.
- **Outbound scheduling** replaces nine Make.com scenarios. Every cadence
  they encoded is now a `voice_campaign_rules` row: opt-in follow-up at
  +2 min (expires +7 min), quiz follow-up at +30 min, nurture at +2 min,
  discovery-call reminder at appointment −2 h, and the three no-show
  flows at +2 min. What Make never had is added here: retries on
  transient VAPI failure, quiet hours, and a dedupe key so one event can
  never dial twice. The appointment time comes from `crm_appointments` —
  the whole Outlook-email-scraping + GPT-timestamp layer in Make is gone.
- **Everything GoHighLevel did** is re-homed: contact search/create is
  `crm_contacts`, pipelines are `crm_journey_stages` + `crm_client_journeys`,
  calendars/free-slots/booking are `crm_appointments` with the same
  business window the Make classifier enforced (Mon–Fri 13:00–18:00
  Australia/Sydney, no same-day bookings, 30-minute slots).
- **The inbound context store** (Make data store 133627) becomes
  `voice_call_context`, keyed by **VAPI call id** — the Make version was
  keyed by caller phone, so two concurrent calls from one number
  collided. Phone stays as a secondary lookup for the tools that only
  know the caller number.

## The pieces

| Piece | Path | Role |
|---|---|---|
| Webhook | `src/routes/api.public.voice.webhook.ts` | VAPI server URL. Status updates, end-of-call ingestion, synchronous tool calls, squad handoff routing. Auth: `x-vapi-secret` shared secret, constant-time, fails closed. |
| Drain | `src/routes/hooks.voice-call-drain.tsx` | Enriches queued end-of-call events: contact match, agent naming, optional LLM transcript analysis, CRM activity, alert rules, outbound retry decisions, stale-call cleanup. |
| Dispatcher | `src/routes/hooks.voice-outbound-dispatch.tsx` | Claims due `voice_outbound_jobs`, applies quiet hours/expiry, `POST https://api.vapi.ai/call` with `schedulePlan`. |
| Server logic | `src/server/voice.server.ts`, `src/server/voice-tools.server.ts` | All heavy lifting; the routes are shells. |
| Operator API | `src/lib/voice.functions.ts`, `src/lib/voice-outbound.functions.ts`, `src/lib/crm-journey.functions.ts` | `createServerFn` + `requireOperator`. |
| Pure vocabulary | `src/lib/voice-vocab.ts` | Outcome/sentiment/intent display maps and the quality-score rubric (tested). Client-safe. |
| UI | `/voice/calls`, `/voice/agents`, `/voice/outbound`, `/crm/journey` | The call-logs replica, the fleet registry, the dispatch queue, the client tracker board. |

## Rules that carry the design

- **A tool response is an envelope.** Every tool call answers
  `{ results: [{ toolCallId, result: <stringified JSON> }] }` — VAPI matches
  results to calls by id, and a bare JSON body is silently ignored.
- **The journey is the trigger.** Outbound calls are only ever created by
  `enqueueOutboundForTrigger()`, driven by journey transitions and
  appointment outcomes through `voice_campaign_rules`. Nothing else dials.
  A rule that is disabled, a journey marked `do_not_call`, or a
  blacklisted number all stop the job before VAPI is asked.
- **A missed webhook leaves no trace**, so the drain also closes phantom
  live calls (30-minute hard stop) and reconciles dispatched jobs against
  the call log — the same reasoning as the deployment drain.
- **No secrets in the repo.** `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET` and
  (optionally) `OPENAI_API_KEY` are environment secrets on the Worker.
  The VAPI key previously pasted into Make module bodies should be
  rotated before this goes live — it has been outside version control.
- **AI analysis is optional and labelled.** Without `OPENAI_API_KEY` the
  drain stores calls with `aiAnalyzed: false` and no sentiment rather
  than guessing; the UI renders the absence honestly.

## Environment

| Secret | Where | Purpose |
|---|---|---|
| `VAPI_WEBHOOK_SECRET` | Worker env + VAPI phone number/assistant `server.headers` | Webhook auth (min 16 chars). |
| `VAPI_API_KEY` | Worker env | Outbound dialing, live-call control, recording re-signing. |
| `OPENAI_API_KEY` | Worker env (optional) | Post-call transcript analysis and quiz summaries. |

VAPI-side wiring: point the inbound number/squad `server.url` at
`https://mission-control.aurixasystems.com.au/api/public/voice/webhook`
with an `x-vapi-secret` header, and give the assistants the tools named in
`src/server/voice-tools.server.ts` (`resolve_contact`, `get_call_context`,
`check_availability`, `book_appointment`, `phoneNumber_inject`).

The reception number does **not** reach VAPI by the native
`api.vapi.ai/twilio/inbound_call` route: Twilio serves static TwiML first, so
the caller gets a short beat before the agent speaks. VAPI has no answer-delay
field anywhere in its API, so there is nowhere else to put it. Read
[`voice-inbound-pre-answer-delay.md`](./voice-inbound-pre-answer-delay.md)
before changing that number's `VoiceUrl`, its `voice_fallback_url`, or the
SIP phone record the TwiML dials — it records what the caller actually hears,
why the fallback makes the arrangement safe, and the one check that can tell a
working delay from a fallback answering normally.
