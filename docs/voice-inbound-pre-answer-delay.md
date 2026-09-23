# The pre-answer delay on the inbound reception line

A caller who dials `+61 2 8105 6305` hears a short beat before the agent
speaks. That beat is deliberate, it is not produced by VAPI, and until this
document existed nothing anywhere said so.

It is written down because its twin on the NPC line was **not**. That one has
sat on a live customer number since May, as a five-character literal inside a
Make blueprint, with no prose in either repository explaining that it existed
or why — which is how the question *"what is that pause masking?"* survived an
entire platform migration unanswered, and how it came to be removed by
accident.

## What it is

Twilio's "A Call Comes In" for the reception number points at a webhook that
answers with static TwiML:

```xml
<Response>
  <Pause length="5"/>
  <Dial timeout="20" action="<the failed-dial handler's hook>" method="POST">
    <Sip>sip:aurixa-…@sip.vapi.ai</Sip>
  </Dial>
</Response>
```

`timeout` and `action` belong to the failed-dial handler, which has a section
of its own below. The pause is the `<Pause>` and nothing else.

The `<Sip>` target is a **vapi-provider phone record**,
`663c24e4-0393-4d75-aa75-63c43aeb9303`, bound to the MC Reception Squad
`d6bfd085-2724-476d-9d5e-0c9d72463e4c`. Its SIP URI is deliberately **not
written here** — a VAPI-hosted SIP URI takes no authentication, so anyone who
knows the string can dial the squad and spend the account's minutes. It lives
in the TwiML and nowhere else. If it ever leaks, the remedy is cheap: create a
replacement endpoint and edit the one string.

## What the caller actually hears, precisely

"Ring" is the natural word for it and is not quite what happens, which matters
when somebody reports it missing.

`<Pause>` makes Twilio **answer** the call in order to execute TwiML. So the
five seconds is *silence*, not ringing. The ring that follows is Twilio's
ringback during the `<Dial>` while the SIP leg connects. The sequence is:

1. Twilio answers — carrier ringback stops.
2. Five seconds of silence.
3. Twilio ringback while the SIP leg rings.
4. The agent's first message.

Two consequences worth knowing. Five seconds of **Twilio** voice time is spent
on every inbound call; **VAPI** minutes are not, because VAPI is not connected
until step 3. And if the delay should *sound* like ringing rather than silence,
the lever is `ringTone="au"` on the `<Dial>`, which sets Australian cadence for
step 3 — it does not move step 2.

## Why it cannot be done in VAPI

This was settled against VAPI's own Create DTOs rather than from memory,
because the obvious assumption is that a voice platform can delay its own
answer.

`CreateTwilioPhoneNumberDTO` is `assistantId, fallbackDestination, hooks,
name, number, provider, server, smsEnabled, squadId, twilioAccountSid,
twilioApiKey, twilioApiSecret, twilioAuthToken, workflowId`. `CreateSquadDTO`
is `members, membersOverrides, name` — that is the entire object.
`answerDelay`, `ringDelay`, `answerTimeout`, `ringSeconds` and `delaySeconds`
have **zero occurrences across all 38 DTOs**.

Two fields look like the answer and are not. `startSpeakingPlan.waitSeconds`
is post-user-speech endpointing — how long to wait after the *caller* stops
talking. `firstMessageMode: "assistant-waits-for-user"` waits **indefinitely**
for the caller, not for N seconds, which is dead air rather than a delay.

The one genuinely unexplored surface is `hooks`, declared on every
phone-number DTO and used by no live object in either org, with a shape the
distilled spec does not carry.

**So the delay has to come from TwiML in front of VAPI.** There is no other
place to put it.

## It is masking nothing — measured, not assumed

The NPC pause was carried through the org migration untouched because nobody
knew what it was for, and "it might be load-bearing" is not a reason anyone
could test. It is testable here, because the Aurixa line ran **without** a
pause from 16 September.

An inbound call on 17 September, on the same squad, reads
`system, bot, user, tool_calls, bot, tool_call_result, …, bot` — greeting
intact, four tool round-trips, a full conversation, `customer-ended-call`.
Answering with no pause clips nothing and races nothing.

**The pause is a presentation choice, not a workaround.** A phone answered
before it has rung reads as a machine. Nothing downstream depends on it, so it
can be shortened, lengthened or removed without consulting anything else.

## The failure behaviour, which is the reason this is safe

`voice_fallback_url` on the number is set to
`https://api.vapi.ai/twilio/inbound_call` — VAPI's native route, which
resolves to the Twilio-provider record `83b9a6d8-5666-41a5-8b97-ed94aa550ea0`,
also bound to the MC Reception Squad.

Twilio falls back whenever the primary handler errors, times out or returns
invalid TwiML. So **every failure mode of the TwiML host degrades to the
line's previous behaviour** — same squad, same org, no delay — rather than to
a dead line. The fallback was armed *before* the primary handler was moved,
for exactly that reason.

This is also why "the phone was answered" is never evidence that the delay is
working. The fallback answers the call perfectly normally. The only honest
check is the one below.

## The failed-dial handler

`voice_fallback_url` above covers one layer, and the SIP phone record's
`fallbackDestination: +61 433 005 110` covers a second — VAPI answers the SIP
leg but the squad cannot be reached. Between them sits a third layer that
neither can see: **a `<Dial>` that fails.**

If VAPI's SIP ingress were unreachable, Twilio would fetch the TwiML above
(fine), execute it (fine), the `<Dial><Sip>` would fail, and — with no verb
after it — the call would simply end. The handler is what turns that into a
person:

```xml
<Response>
  <Say voice="alice" language="en-AU">Sorry, we could not connect you to our
    reception system. Putting you through to the team now.</Say>
  <Dial callerId="<this line's number>" timeout="25" answerOnBridge="true">
    <Number>+61433005110</Number>
  </Dial>
  <Say voice="alice" language="en-AU">We could not reach the team either.
    Please call back shortly.</Say>
  <Hangup/>
</Response>
```

The inner `<Dial>` deliberately carries **no** `action`, so when the mobile
does not answer it falls through to the closing `<Say>`.

Each line has its own handler so that either can be rolled back alone. Both
are stateless responders in the same place as the TwiML above: *Aurixa
Reception - Dial Failure Handler* and *NPC Reception - Dial Failure Handler*.

### It has to answer the normal case too

This is the part that is easy to get wrong. Twilio's `<Dial>` reference:
*"If you specify an `action` URL for `<Dial>`, Twilio will continue the
initial call after the dialed party hangs up. Any TwiML verbs included after
this `<Dial>` will be unreachable… you must respond to Twilio's request with
TwiML instructions on how to handle the call."*

So the handler is reached after **every** dial, not only a failed one, and a
finished conversation that gets no answer hangs. It replies `<Response/>` —
end the call — for anything that is not a failure.

That is also why the two simpler-looking shapes are wrong and must not be
reintroduced: a bare `<Say>`/`<Dial>` *after* the `<Dial>` fires at the end of
every normal call, and two nouns inside one `<Dial>` ring **simultaneously**,
so the mobile would ring on every inbound call.

### The branch is in the mapper, never in a router filter

A Make **router filter cannot read a custom webhook's fields.**
`{{1.DialCallStatus}}` resolves correctly in a *mapper* and is empty inside a
*filter*, because a webhook carrying no data structure gives Make nothing to
bind against at filter time. Measured directly: with a payload of
`status=[failed]`, the route filtered `notequal "failed"` fired and the route
filtered `equal "failed"` did not, while the same expression in a mapper read
`raw=[failed] eq=[Y]`.

Three rounds of this were spent blaming the filter operator. It was never the
operator. The handler is therefore one module with the decision inline:

```
{{if(contains("no-answer|failed|busy"; 1.DialCallStatus); "<divert…>"; "<Response/>")}}
```

Two details that cost a run each. **`or()` does not exist in Make** —
`Function 'or' not found!` — hence `contains()` over a delimited list, which
is safe because no other `DialCallStatus` value (`completed`, `answered`,
`canceled`) is a substring of it. And the TwiML uses **single-quoted
attributes** so it can sit inside a double-quoted Make string with no
escaping.

`no-answer` is in the list deliberately: a dial that never connects surfaces
as `no-answer`, not `failed`, so keying on `failed` alone would miss the case
the handler exists for.

### How to simulate an outage

Not with a wrong SIP username. **`sip.vapi.ai` answers an unknown user and
then drops the call** — `DialCallStatus=completed`, `DialCallDuration=1` — so
a bad username is invisible to the status test and is not a stand-in for
anything. Use an **unroutable host**; that is what yields `failed`.

Run it as a Twilio call whose own `Twiml` parameter carries the broken
`<Dial>` and the handler's action URL. That exercises the handler with the
live number nowhere in the path. Measured that way: SIP leg `in-progress`,
the unroutable host `failed` two seconds later, the handler taking the divert
branch, and a leg to `+61 433 005 110` `ringing` six seconds after that.

### `transfer_to_human` is unaffected

The one real risk, because the NPC line's transfer works by redirecting the
**parent** call while the `<Dial><Sip>` is still live — and it was not
knowable from the documentation whether a callback for that torn-down dial
would arrive and hang up the call the transfer had just set up.

Measured rather than reasoned about: the redirect was accepted (HTTP 200),
the SIP leg was torn down at 21 s, a leg to `+61 433 005 110` went
`in-progress`, and both parent legs stayed live. A parent redirect survives
the handler.

### What it costs

A Make round-trip at the end of every call, measured at 141–290 ms, and a
second execution per call. Rollback is the two attributes on the one mapper
field, next call only.

## How to verify it, and how to roll it back

**Verify** by asserting against VAPI's own call record, never by ear:

| check | pass |
|---|---|
| which path ran | `phoneNumberId` is the **SIP** record, not `83b9a6d8…` (that is the fallback) |
| routing | `squadId` is `d6bfd085-2724-476d-9d5e-0c9d72463e4c` |
| **the pause itself** | the gap between the TwiML host's response and the VAPI call's `createdAt` is ≈ 5 s |
| the webhook still authenticates | a `tool_calls` → `tool_call_result` pair in the call's `messages` |
| the handler is not diverting good calls | Twilio's log for the call shows **no** child leg to `+61 433 005 110` |

Measured on 23 September 2026: TwiML served at `04:49:21.942Z`, VAPI call
created at `04:49:27.188Z` — a gap of **5.25 s**, reconciling with
`<Pause length="5"/>`. The NPC line reconciles the same way at **5.51 s**.

The third row is the one that matters: the first two pass whenever routing is
right, whether or not the pause is present.

**Roll back** by setting the number's `VoiceUrl` back to
`https://api.vapi.ai/twilio/inbound_call`. One field, next call only,
in-flight calls untouched.

## What this does not change

`83b9a6d8-5666-41a5-8b97-ed94aa550ea0` remains the Twilio-provider record: it
is what `voice_phone_numbers` names, what **outbound** dials from, and what
the fallback resolves to. Inbound arriving through a SIP endpoint does not
invalidate that row — as
`supabase/migrations/20260916140000_aurixa_reception_line.sql` says in its own
header, *"Inbound works without this migration. Outbound does not."* The row
is an outbound line picker.

## On the Make.com question

`docs/voice-aurixa-pipeline.md` states that the fleet's CRM tools need **no
Make.com scenarios**, and `docs/voice-agents-architecture.md` opens by saying
that state no longer lives outside Mission Control. Both remain true and
neither is bent by this.

The TwiML host and the failed-dial handler are both **stateless responders**:
one webhook, one response, no data store, no reads, no writes. They hold
nothing, and neither is in the path of any tool call — the agents still reach
`/api/public/voice/webhook` directly. Their only job is to answer one HTTP
request with an XML document, one before the call is handed to VAPI and one
after the dial ends.

It is worth being honest about the trade anyway: it puts a third party in the
synchronous path of every inbound call, which is precisely what the fallback
above is there to bound. A Twilio TwiML Bin is strictly better — Twilio hosts
the same static XML itself, removing the dependency entirely — and swapping to
one is a single `VoiceUrl` change with no other edit. Twilio publishes no REST
API for creating bins, which is the only reason one was not used here.
