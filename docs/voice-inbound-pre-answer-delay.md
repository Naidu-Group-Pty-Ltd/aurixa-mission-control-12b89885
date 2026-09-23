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
  <Dial>
    <Sip>sip:aurixa-…@sip.vapi.ai</Sip>
  </Dial>
</Response>
```

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

## How to verify it, and how to roll it back

**Verify** by asserting against VAPI's own call record, never by ear:

| check | pass |
|---|---|
| which path ran | `phoneNumberId` is the **SIP** record, not `83b9a6d8…` (that is the fallback) |
| routing | `squadId` is `d6bfd085-2724-476d-9d5e-0c9d72463e4c` |
| **the pause itself** | the gap between the TwiML host's response and the VAPI call's `createdAt` is ≈ 5 s |
| the webhook still authenticates | a `tool_calls` → `tool_call_result` pair in the call's `messages` |

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

The TwiML host is a **stateless responder**: one webhook, one response, no
data store, no reads, no writes. It holds nothing, and it is not in the path
of any tool call — the agents still reach
`/api/public/voice/webhook` directly. Its only job is to answer one HTTP
request with a fixed XML document before handing the call to VAPI.

It is worth being honest about the trade anyway: it puts a third party in the
synchronous path of every inbound call, which is precisely what the fallback
above is there to bound. A Twilio TwiML Bin is strictly better — Twilio hosts
the same static XML itself, removing the dependency entirely — and swapping to
one is a single `VoiceUrl` change with no other edit. Twilio publishes no REST
API for creating bins, which is the only reason one was not used here.
