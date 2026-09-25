#!/usr/bin/env python3
"""Declare the MC org tools, and make VAPI hold exactly what is declared.

Every tool here lives at ORG level (dashboard-visible). The Mission Control
tools post to the MC webhook with the shared secret, `transfer_to_human_mc`
posts to Make, and `end_call_tool` is VAPI's own.

This used to CREATE a missing tool and skip one that already existed, so a
changed description, a new parameter or a longer timeout written here never
reached VAPI: the fleet ran on whatever each tool said the day it was made.
That mattered the day the calendar started confirming bookings itself - the
declaration of `book_appointment` still told every assistant that "the Aurixa
team confirms by email", which is the opposite of what the tool now does, and
it had no way to receive the address the invitation goes to. So an existing
tool is now compared with its declaration and PATCHed where they differ, then
read back; a tool that still differs fails the run.

A tool is found by the id recorded in fleet-prompts/mc_org_tool_ids.json (the
file apply-fleet-upgrade.py binds assistants from, and which this now writes),
and by name only where no id is recorded. Matching by name among MC-webhook
tools alone - what this used to do - finds neither the Make transfer tool nor
the end-call tool, and would create a second copy of each on every run.

Only the fields declared here are compared: an id, a timestamp or a default
VAPI fills in is not drift. A PATCH carries only the top-level keys that
differ, because VAPI replaces a whole top-level key.

  --dry-run         report what differs; change nothing, write nothing.
  --rotate-secret   allow the webhook secret VAPI holds to be replaced with
                    VAPI_WEBHOOK_SECRET_VALUE. Without it, a secret that reads
                    back different is reported and left alone, and so is the
                    rest of that tool's `server` - a PATCH of `server` has to
                    carry a secret, and a mistyped value would fail every tool
                    call on every assistant bound to it.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ["VAPI_KEY"]
BASE = "https://api.vapi.ai"
S = os.path.dirname(os.path.abspath(__file__))
IDS_PATH = os.path.join(S, "fleet-prompts", "mc_org_tool_ids.json")

DRY_RUN = "--dry-run" in sys.argv
ROTATE_SECRET = "--rotate-secret" in sys.argv

SERVER = {
    "url": "https://mission-control.aurixasystems.com.au/api/public/voice/webhook",
    "secret": os.environ["VAPI_WEBHOOK_SECRET_VALUE"],
}

# `book_appointment` makes more than one calendar request in a single tool
# call - it looks for a session the caller already holds, then creates the
# booking, and when an answer is lost it asks the calendar again rather than
# guess (voice-tools.server.ts). Each request has its own timeout, and in a
# calendar outage they add up to a little over thirty seconds. VAPI's default
# of twenty would give up first and leave the assistant with no answer, where
# waiting gets the honest one: "not booked, and the team has been told".
BOOKING_SERVER = {**SERVER, "timeoutSeconds": 45}

# Said only when an answer is slow, so the caller is not left in silence. The
# assistant already says its own line as it calls the tool (the prompt makes
# it), so nothing is said at `request-start`: that would be two sentences for
# one. Neither line claims anything about the outcome.
CALENDAR_DELAY_AVAILABILITY = {
    "type": "request-response-delayed",
    "content": "Still with you - the calendar's just being a little slow.",
    "timingMilliseconds": 5000,
}
CALENDAR_DELAY_BOOKING = {
    "type": "request-response-delayed",
    "content": "Still with you - just waiting on the calendar to confirm that.",
    "timingMilliseconds": 7000,
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
                "is (contactId, firstName, fullName, phone, and the email on file when there is "
                "one), their confirmed intent, and whether they were already resolved earlier "
                "in the call or by another assistant. Call it silently once after the final "
                "resolve_contact attempt."
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
        "messages": [CALENDAR_DELAY_AVAILABILITY],
        "function": {
            "name": "check_availability",
            "description": (
                "Get the real open session times from the Aurixa calendar. Sessions are 30 "
                "minutes, Monday to Friday 9:00 am to 4:30 pm Sydney time, at least 24 hours "
                "ahead, up to 45 days out. Pass the session type in the caller's words, and "
                "their preferred day or time of day when they gave one - times that match it "
                "come first. If the type is ambiguous the tool returns a clarification question "
                "to ask. Offer only times from the returned availability list. If it returns "
                "calendar_unavailable, no times are known: offer none, and offer a call back "
                "instead. This tool never books anything."
            ),
            "parameters": {
                "type": "object",
                "required": ["booking_intent_text"],
                "properties": {
                    "booking_intent_text": {
                        "type": "string",
                        "description": "The session being booked, in the caller's words (strategic review, platform discovery session, guided demonstration, enterprise requirements consultation, onboarding kickoff)",
                    },
                    "preferred_date_text": {
                        "type": "string",
                        "description": "The caller's preferred day or time of day in their own words, for example 'Thursday afternoon', if they gave one",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "async": False,
        "server": BOOKING_SERVER,
        "messages": [CALENDAR_DELAY_BOOKING],
        "function": {
            "name": "book_appointment",
            "description": (
                "Book one of the times check_availability returned, in the Aurixa calendar. "
                "Pass the exact startIso value of the chosen slot as startTime. The caller must "
                "be resolved first (resolve_contact). success = true is a real, confirmed "
                "booking: the calendar invitation with the video link is emailed to the caller "
                "straight away, to the invite_email it returns. needs_email: ask for the "
                "address, spell it back, and call again with email. already_booked: the caller "
                "already holds that kind of session - ask whether to move it, and only if they "
                "say yes call again with reschedule_existing set to true. slot_taken: nothing "
                "was booked - offer only the alternatives it returns. calendar_unavailable: "
                "nothing was booked or moved. Never say a session is booked unless this "
                "returned success = true."
            ),
            "parameters": {
                "type": "object",
                "required": ["booking_intent_text", "startTime"],
                "properties": {
                    "booking_intent_text": {"type": "string", "description": "The session type being booked"},
                    "startTime": {"type": "string", "description": "The exact startIso value of the chosen slot"},
                    "email": {
                        "type": "string",
                        "description": "The address the caller confirmed for the calendar invitation, spelled back to them. Leave empty to use the address on file.",
                    },
                    "reschedule_existing": {
                        "type": "boolean",
                        "description": "True only after an already_booked reply, when the caller has said yes to moving the session they already hold. Never true on a first attempt.",
                    },
                    "timezone": {
                        "type": "string",
                        "description": "The caller's IANA time zone, for example Australia/Perth, only when they said they are outside Sydney time - the invitation shows times in it. Leave empty otherwise.",
                    },
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


# Compared by its own rule and never printed.
SECRET_PATH = ("server", "secret")
# Compared as a key SET, not only key by key: a parameter removed here but
# still live would go on being offered to the model.
EXACT_KEYS = {("function", "parameters", "properties")}


def same(declared, live):
    if declared == live:
        return True
    # VAPI leaves out a field that is at its default; declaring the default
    # is not drift.
    return live is None and declared in (False, "", [], {})


def drift(declared, live, path=()):
    """The paths at which `live` does not hold what `declared` says."""
    if path == SECRET_PATH:
        return []
    if isinstance(declared, dict):
        if not isinstance(live, dict):
            return [] if same(declared, live) else [path]
        out = [path] if path in EXACT_KEYS and set(live) != set(declared) else []
        for key, value in declared.items():
            out += drift(value, live.get(key), path + (key,))
        return out
    if isinstance(declared, list):
        if not isinstance(live, list) or len(live) != len(declared):
            return [] if same(declared, live) else [path]
        out = []
        for i, (d, item) in enumerate(zip(declared, live)):
            out += drift(d, item, path + (i,))
        return out
    return [] if same(declared, live) else [path]


def secret_differs(spec, live):
    """True only when VAPI shows a secret and it is not the declared one.

    A secret VAPI does not return, or returns masked, is unknown rather than
    different - and is simply sent again with any PATCH of `server`."""
    declared = (spec.get("server") or {}).get("secret")
    held = (live.get("server") or {}).get("secret")
    if declared is None or not isinstance(held, str) or "*" in held:
        return False
    return held != declared


def label(path):
    return ".".join(str(p) for p in path) or "(tool)"


def find_live(spec, recorded_id, org_tools):
    """The live tool this declaration describes, or None."""
    name = spec["function"]["name"]
    by_id = {t.get("id"): t for t in org_tools}
    if recorded_id and recorded_id in by_id:
        return by_id[recorded_id]
    url = (spec.get("server") or {}).get("url")
    for t in org_tools:
        if (t.get("function") or {}).get("name") != name or t.get("type") != spec["type"]:
            continue
        if (t.get("server") or {}).get("url") == url:
            return t
    return None


def main():
    recorded = {}
    if os.path.exists(IDS_PATH):
        with open(IDS_PATH) as f:
            recorded = json.load(f)
    org_tools = api("GET", "/tool?limit=1000")
    ids = dict(recorded)
    failures = []

    for spec in TOOLS:
        name = spec["function"]["name"]
        live = find_live(spec, recorded.get(name), org_tools)
        if live is not None and live.get("type") != spec["type"]:
            # A tool's type cannot be PATCHed. The recorded one is left where
            # it is - still bound to whichever assistants have it until
            # apply-fleet-upgrade.py rebinds them to the new id.
            print(f"retype  {name}: {live['id']} is {live.get('type')}, declared {spec['type']}")
            live = None
        if live is None:
            if DRY_RUN:
                print(f"missing {name} (would create)")
                continue
            created = api("POST", "/tool", spec)
            ids[name] = created["id"]
            print(f"created {name} -> {created['id']}")
            time.sleep(1.2)
            continue

        tool_id = live["id"]
        ids[name] = tool_id
        paths = drift({k: v for k, v in spec.items() if k != "type"}, live)
        keys = sorted({p[0] for p in paths})
        rotate = secret_differs(spec, live)
        if rotate and not ROTATE_SECRET:
            failures.append(
                f"{name}: VAPI holds a different webhook secret from VAPI_WEBHOOK_SECRET_VALUE. "
                "Left alone, with the rest of its server settings - re-run with --rotate-secret "
                "if the value supplied is the one the Mission Control webhook checks."
            )
            keys = [k for k in keys if k != "server"]
        elif rotate and "server" not in keys:
            keys.append("server")
        if not keys:
            print(f"current {name} -> {tool_id}")
            continue

        print(f"differs {name} -> {tool_id}: {', '.join(label(p) for p in paths) or 'server.secret'}")
        if DRY_RUN:
            continue
        api("PATCH", f"/tool/{tool_id}", {k: spec[k] for k in keys})
        time.sleep(1.2)
        after = api("GET", f"/tool/{tool_id}")
        left = [p for p in drift({k: spec[k] for k in keys}, after)]
        if left or (ROTATE_SECRET and secret_differs(spec, after)):
            failures.append(f"{name}: still differs after the update: {', '.join(label(p) for p in left) or 'server.secret'}")
            print(f"DRIFTED {name}")
        else:
            print(f"updated {name} ({', '.join(keys)})")

    if DRY_RUN:
        print("dry run: nothing was changed or written")
    else:
        with open(IDS_PATH, "w") as f:
            json.dump(ids, f, indent=2)
            f.write("\n")
        print("wrote", IDS_PATH)
    for failure in failures:
        print("FAILED", failure)
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
