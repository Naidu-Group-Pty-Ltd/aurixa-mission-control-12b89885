#!/usr/bin/env python3
"""Create the 5 MC tools at ORG level (dashboard-visible), pointing at the
Mission Control webhook with the shared secret. Idempotent: reuses an
existing org tool when one with the same function name already targets the
MC webhook."""
import json
import os
import time
import urllib.error
import urllib.request

KEY = os.environ["VAPI_KEY"]
BASE = "https://api.vapi.ai"
SERVER = {
    "url": "https://mission-control.aurixasystems.com.au/api/public/voice/webhook",
    "secret": os.environ["VAPI_WEBHOOK_SECRET_VALUE"],
}

# The Make webhook behind `transfer_to_human_mc`. It is read from the
# environment rather than written down here: anyone holding the URL can ask
# Make to redirect a call that is in progress, so it is closer to a credential
# than to configuration. Its value is the webhook URL of the Make scenario
# "Aurixa Vapi - Transfer Caller to Human via Twilio Redirect".
MAKE_TRANSFER_HOOK_URL = os.environ["MAKE_TRANSFER_HOOK_URL"]

TOOLS = [
    {
        "type": "function",
        "async": False,
        "server": SERVER,
        "function": {
            "name": "resolve_contact",
            "description": (
                "Resolve the caller against Mission Control's CRM by their phone number. "
                "Call this silently at the start of every conversation. The caller's phone "
                "number is supplied automatically; never provide it manually. If it returns "
                "contactState NEEDS_NAME, ask the caller for their full name once, then call "
                "it again with the name fields only. A valid contactId means the caller is "
                "resolved; a new contact and client journey are created automatically when "
                "a name is supplied for an unknown number."
            ),
            "parameters": {
                "type": "object",
                "required": [],
                "properties": {
                    "full_name": {"type": "string", "description": "The caller's full name, if they gave it"},
                    "first_name": {"type": "string"},
                    "last_name": {"type": "string"},
                    "email": {"type": "string", "description": "The caller's email address, if they gave it"},
                },
            },
        },
    },
    {
        "type": "function",
        "async": False,
        "server": SERVER,
        "function": {
            "name": "get_call_context",
            "description": (
                "Fetch the stored context for this call from Mission Control: who the caller "
                "is (contactId, firstName, fullName, phone), their confirmed intent, and "
                "whether they were already resolved earlier in the call or by another "
                "assistant. Call it silently once after the final resolve_contact attempt."
            ),
            "parameters": {"type": "object", "required": [], "properties": {}},
        },
    },
    {
        "type": "function",
        "async": False,
        "server": SERVER,
        "function": {
            "name": "phoneNumber_inject",
            "description": (
                "Package the caller's context before transferring them to a specialist "
                "assistant. Call this once, silently, right before a squad transfer, passing "
                "the confirmed intent and the caller's own words for why they called."
            ),
            "parameters": {
                "type": "object",
                "required": [],
                "properties": {
                    "confirmedIntent": {
                        "type": "string",
                        "description": "One of: strategic_review, discovery_session, guided_demo, enterprise_consultation, kickoff, support",
                    },
                    "callerReason": {"type": "string", "description": "The caller's own words for why they called"},
                },
            },
        },
    },
    {
        "type": "function",
        "async": False,
        "server": SERVER,
        "function": {
            "name": "check_availability",
            "description": (
                "Get real open session slots from the Aurixa calendar. Slots are 30 minutes, "
                "Monday to Friday 9:00 am to 4:30 pm Sydney time, at least 24 hours ahead, up "
                "to 45 days out. Pass the session type in the caller's words; if the type is "
                "ambiguous the tool returns a clarification question to ask."
            ),
            "parameters": {
                "type": "object",
                "required": ["booking_intent_text"],
                "properties": {
                    "booking_intent_text": {
                        "type": "string",
                        "description": "The session being booked, in the caller's words (strategic review, platform discovery session, guided demonstration, enterprise requirements consultation, onboarding kickoff)",
                    },
                    "preferred_date_text": {"type": "string", "description": "The caller's preferred day, if any"},
                },
            },
        },
    },
    {
        "type": "function",
        "async": False,
        "server": SERVER,
        "function": {
            "name": "book_appointment",
            "description": (
                "Book one of the slots returned by check_availability. Pass the exact "
                "startIso value of the chosen slot as startTime. The caller must be resolved "
                "first (resolve_contact). Booking registers the request in Mission Control; "
                "the Aurixa team confirms by email and the calendar invitation follows "
                "separately - never tell the caller the meeting is final beyond that."
            ),
            "parameters": {
                "type": "object",
                "required": ["booking_intent_text", "startTime"],
                "properties": {
                    "booking_intent_text": {"type": "string", "description": "The session type being booked"},
                    "startTime": {"type": "string", "description": "The exact startIso value of the chosen slot"},
                    "notes": {"type": "string", "description": "Anything worth noting for the Aurixa team"},
                },
            },
        },
    },
    {
        "type": "function",
        "async": False,
        "server": SERVER,
        "function": {
            "name": "raise_support_ticket",
            "description": (
                "Lodge a support ticket in Mission Control for the caller. Call this once the "
                "caller has described the problem - do not ask them to choose a category or a "
                "severity, the server works those out from what they said. Returns a reference "
                "number to read back to the caller. If it returns needs_email, ask for their "
                "email address, repeat it back, then call again."
            ),
            "parameters": {
                "type": "object",
                "required": ["summary", "detail"],
                "properties": {
                    "summary": {"type": "string", "description": "One line naming the problem, in the caller's own words"},
                    "detail": {"type": "string", "description": "What the caller said: what they were doing, what happened, any error wording they read out"},
                    "what_is_broken": {"type": "string", "description": "How much is affected, in the caller's words - everything is down, one feature, it is slow, it comes and goes, it just looks wrong"},
                    "since_when": {"type": "string", "description": "When it started, in the caller's words"},
                    "email": {"type": "string", "description": "Only when the caller volunteers or confirms an email address. Leave empty otherwise - their contact record is used."},
                },
            },
        },
    },
    # The transfer is NOT a native VAPI `transferCall`, and that is the whole
    # point. On 23 Sep 2026 call 01a0cefc the assistant said its line and placed
    # the tool call in the same turn - the prompt half worked - and VAPI answered
    # `call.in-progress.error-transfer-failed` seventeen seconds in. NPC reached
    # the same conclusion first: its native `transferCall` tool
    # (3a6a892d, created 2026-05-07) is bound to ZERO assistants, and the tool all
    # thirteen of its live assistants use was created 2026-05-20 as a `function`
    # that asks Make to redirect the Twilio PARENT call into
    # `<Dial><Number>...</Number></Dial>`. This mirrors that.
    #
    # Two things carry it. The `request-start` message is SILENT and
    # non-blocking, because the prompt already makes the assistant say its own
    # line in the same turn and a tool that also speaks turns one sentence into
    # two. And `request-failed` sets `endCallAfterSpokenEnabled: False`, so a
    # transfer that cannot be completed leaves the caller talking to the
    # assistant instead of dropping them - which is what the reported defect
    # felt like from the caller's end.
    #
    # It needs no static `parameters[]`: every other function tool in this org
    # reads the caller from `message.call.customer.number`, which VAPI sends on
    # every tool call, and the Make scenario keys its datastore lookup on the
    # same field.
    {
        "type": "function",
        "async": False,
        "server": {
            "url": MAKE_TRANSFER_HOOK_URL,
            "timeoutSeconds": 20,
        },
        "messages": [
            {"type": "request-start", "content": "", "blocking": False},
            {
                "type": "request-failed",
                "content": (
                    "Sorry, I could not connect you through just now. I can keep helping "
                    "here, or the team will pick up if you call back on this number."
                ),
                "endCallAfterSpokenEnabled": False,
            },
        ],
        "function": {
            "name": "transfer_to_human_mc",
            "description": (
                "Transfer the caller to a human on the Aurixa Systems team. Use when the caller "
                "clearly asks for a person, or when their need is outside what this assistant "
                "can do. This does not perform a native Vapi transfer: it asks Make to redirect "
                "the active Twilio call to the Aurixa escalation line."
            ),
            "parameters": {
                "type": "object",
                "required": ["transferReason"],
                "properties": {
                    "transferReason": {
                        "type": "string",
                        "description": (
                            "Short reason for the transfer request. Example: Caller asked to "
                            "speak with a human team member."
                        ),
                    },
                    "callerContext": {
                        "type": "string",
                        "description": (
                            "Brief context about the call so far, so the person who picks up "
                            "knows what the caller wants."
                        ),
                    },
                },
            },
        },
    },
    # `endCall` is not a `function` tool: VAPI runs it itself, so it never
    # reaches our webhook and needs no handler. It is declared here so the org's
    # tool set is reproducible from this file alone.
    {
        "type": "endCall",
        "function": {
            "name": "end_call_tool",
            "description": (
                "Hang up. Call this in the SAME turn as the spoken goodbye, never in a later "
                "one: the assistant only gets another turn when the caller speaks, and a caller "
                "who has just been said goodbye to has no reason to."
            ),
        },
    },
]


def api(method, path, body=None, retries=5):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            BASE + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={
                "Authorization": f"Bearer {KEY}",
                "Content-Type": "application/json",
                "User-Agent": "curl/8.5.0",
            },
        )
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            last = f"{e.code}: {detail}"
            if e.code == 429:
                time.sleep(15 * (attempt + 1))
                continue
            if e.code < 500:
                raise RuntimeError(f"{method} {path} -> {last}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{method} {path} failed after {retries} tries -> {last}")


def main():
    existing = api("GET", "/tool?limit=100")
    mc_existing = {
        (t.get("function") or {}).get("name"): t["id"]
        for t in existing
        if (t.get("server") or {}).get("url") == SERVER["url"]
    }
    ids = {}
    for spec in TOOLS:
        name = spec["function"]["name"]
        if name in mc_existing:
            print(f"exists  {name} -> {mc_existing[name]}")
            ids[name] = mc_existing[name]
            continue
        created = api("POST", "/tool", spec)
        ids[name] = created["id"]
        print(f"created {name} -> {created['id']}")
        time.sleep(1.2)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mc_org_tool_ids.json")
    with open(out, "w") as f:
        json.dump(ids, f, indent=2)
    print("wrote", out)


if __name__ == "__main__":
    main()
