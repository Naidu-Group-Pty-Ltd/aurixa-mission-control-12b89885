# Booking in Cal.com — the voice fleet and Stage 3

Mission Control books every Aurixa session in **one calendar**: the
`aurixasystems` Cal.com account. Three paths read and write it:

| path                                                              | reads free times with                         | books with                                       |
| ----------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| the voice fleet (`check_availability`, `book_appointment`)        | `calendar.server.ts` → `calcomFreeSlots`      | `voice-tools.server.ts` → `createCalcomBooking`  |
| Stage 3 on the waitlist site (`/schedule-strategic-review`)       | `GET /api/public/storefront/strategic-review` | `POST` to the same route                         |
| Cal.com itself (the host, an invitation's reschedule/cancel link) | —                                             | reported back by `POST /api/public/hooks/calcom` |

Free time is Cal.com's answer — the host's schedule, every connected calendar
and every booking from every path — less the CRM appointments Cal.com cannot
see (`crmOnlyBlocks`). So a time an applicant takes on the website can no
longer be offered to a caller, and the reverse. A booking is real the moment it
is made: Cal.com holds it and emails the invitation with the video link.

Production talks to Cal.com's **API v2** with `CALCOM_API_KEY`. The Cal.com MCP
connector in the Claude workspace reaches the same account and is the quickest
way to inspect it (event types, schedule, bookings), but a phone call and a
public web page cannot run through an assistant's session, so nothing in
production depends on it.

## What the account holds (read 24 Sep 2026)

| session                              | kind (`CalcomKind`)       | event type slug                        |
| ------------------------------------ | ------------------------- | -------------------------------------- |
| Aurixa Strategic Review              | `strategic_review`        | `strategic-review`                     |
| Platform Discovery Session           | `discovery_session`       | `platform-discovery-session`           |
| Guided Demonstration                 | `guided_demo`             | `guided-demonstration`                 |
| Enterprise Requirements Consultation | `enterprise_consultation` | `enterprise-requirements-consultation` |
| Onboarding Kickoff Call              | `kickoff`                 | `onboarding-kickoff`                   |

All five are 30 minutes, hidden from the public profile, located on **Cal
Video** (so every booking carries a join link), with 24 hours' minimum notice,
a 45-day booking window and 30-minute slots, on the default schedule "Working
hours": Monday–Friday 09:00–17:00 `Australia/Sydney`. The slugs are the
contract — `CALCOM_EVENT_TYPE_SLUGS` in `calcom.pure.ts` — and renaming one in
Cal.com turns every booking of that kind into a `calendar_booking_failed`
alarm until the constant follows.

**No calendar is connected to the account.** `connectedCalendars` is empty and
there is no destination calendar. Until the host's own calendar is connected,
Cal.com knows only its own bookings: it will offer a time the host is already
busy in Outlook, and a booking reaches the host only as Cal.com's email. That is
the first step below, and the only one that has to be done in Cal.com's own
settings — the MCP connector cannot manage connected calendars.

## Going live, in order

Nothing changes until step 2. With `CALCOM_API_KEY` unset every path keeps its
pre-Cal.com behaviour: the voice tools use the local window in
`voice-tools.server.ts` checked against `crm_appointments`, and the Stage 3
route answers `503 not_configured`, which sends the site back to its request
form. So the code can ship first.

1. **Connect the host's calendar in Cal.com** (Settings → Calendars → add the
   Microsoft 365 / Outlook calendar that `admin@aurixasystems.com.au` works
   from), and make it the destination calendar so bookings land in it. Check it
   with the MCP connector: `get_connected_calendars` should no longer be empty.
2. **Set the API key on Mission Control.** Mint a key on the `aurixasystems`
   account (Settings → Developer → API keys) and set `CALCOM_API_KEY` on the
   Mission Control deployment. `CALCOM_USERNAME` defaults to `aurixasystems`;
   `CALCOM_API_URL` is only for another Cal.com region. See `.env.example`.
3. **Subscribe Mission Control to Cal.com's changes.** Set
   `CALCOM_WEBHOOK_SECRET` on Mission Control first — without it the route
   answers 503 to every delivery rather than accept an unsigned change. Then in
   Cal.com: Settings → Developer → Webhooks → New, subscriber URL
   `https://mission-control.aurixasystems.com.au/api/public/hooks/calcom`,
   triggers **Booking Created, Rescheduled, Cancelled, Rejected, No-show
   updated**, and the same secret. Cal.com signs the raw body (HMAC-SHA256,
   hex, `x-cal-signature-256`).
4. **Merge.** `supabase/migrations/20260924140000_calendar_notification_kinds.sql`
   adds the two notification kinds the calendar raises; `apply-migrations.yml`
   queues it on the push to `main`, ahead of the Lovable publish. It is
   additive, and a notice raised before it lands is dropped rather than failing
   the booking it reports.
5. **Bring the booking tools up to date** (needs `VAPI_KEY`, and
   `VAPI_WEBHOOK_SECRET_VALUE` — the value Mission Control checks as
   `VAPI_WEBHOOK_SECRET`):
   ```bash
   python3 scripts/voice/create-vapi-org-tools.py --dry-run   # what differs
   python3 scripts/voice/create-vapi-org-tools.py             # PATCH + read back
   ```
   This brings `check_availability` and `book_appointment` to their
   declarations: `book_appointment` takes the caller's `email`,
   `reschedule_existing` and a 45-second timeout, and both say something when
   the calendar is slow. Commit `fleet-prompts/mc_org_tool_ids.json` if it had
   to create a tool. Until it runs, a caller with no email on file cannot
   finish a booking, because the live declaration has nowhere to put one.
6. **Deploy the waitlist site** (`aurixa-systems`). It asks this route for
   times on load; until step 2 it keeps its request form, and afterwards it
   books.
7. **Prove it by effect.** `GET` the Stage 3 route and expect
   `200 {"ok":true,"provider":"calcom",…,"slots":[…]}`. Then book one real
   review against an internal address — it sends a real invitation — cancel it
   in Cal.com, and expect a `lead_stage_three` notice in Mission Control. A
   green configuration is not a working calendar; a booking that round-trips
   is.

## Stage 3: what the page and this route agree on

`GET /api/public/storefront/strategic-review` →
`200 { ok, provider: "calcom", timeZone: "Australia/Sydney", durationMinutes: 30, generatedAt, slots: [{ start, end }] }`,
or `503 { ok: false, reason: "not_configured" | "calendar_unavailable" }`.

`POST` the same route with
`{ applicationId, start, timeZone?, name?, email?, organisation?, phone?, notes?, rescheduleExisting? }`:

| answer                                         | status  | the page                                                                                      |
| ---------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `ok`, `booked`                                 | 200     | "Your strategic review is booked." Cal.com has sent the invitation.                           |
| `ok`, `already_booked`                         | 200     | The time was already theirs (a double submit, or a retry whose answer was lost). Nothing new. |
| `ok`, `rescheduled` (+ `previous`)             | 200     | "Your strategic review has moved." Only ever after the applicant said yes to moving.          |
| `already_booked` + `existing`                  | 409     | Nothing changed. Names the review they hold and **asks** before moving it.                    |
| `slot_unavailable` (+ `existing`)              | 409     | Somebody took the time first. Says so and re-reads the calendar; a review being moved stands. |
| `invalid_request` + `field`                    | 400     | The message on that field.                                                                    |
| `invalid_reference` / `access_denied`          | 400/403 | Nothing booked; email the team.                                                               |
| `access_unverifiable` / `calendar_unavailable` | 503     | Nothing booked (or "has not moved"); try again or email. **Never** turned into a request.     |
| `not_configured`, or the route is absent       | 503/404 | The request form, exactly as before this route existed.                                       |

Access is checked here the way the Stage 3 gate checks it, from Airtable and
the lead mirror, so the page cannot book for a reference the gate would refuse.

A confirmed booking still goes down the **Aurixa Waitlist Stage 3** Make
scenario (9601915) from the browser, once per tab and after the page has shown
the booking: the scenario writes the Strategic Review Bookings record and sends
the branded "Strategic Review Confirmed" email, as it always has. The payload
adds `bookingStatus: "Confirmed"`, `bookingProvider`, `calBookingUid`,
`meetingUrl` and `rescheduledFromUtc`; a request from the fallback form carries
none of them, field for field the payload the scenario was built on. Two things
follow from the scenario being left untouched:

- It does not map the new fields, so the Airtable record shows the booking's
  time and applicant but not its Cal.com id or join link. Mapping them is a
  change to the live scenario and was deliberately not made here.
- It only ever creates a record. A review moved on the page arrives as a new
  record for the new time, and the record for the old time stays; the
  reschedule webhook raises a `lead_stage_three` notice naming both times so an
  operator can retire the old one. A cancellation in Cal.com does the same.

Mission Control's lead mirror (`/api/public/leads/capture`) has always read
`bookingStatus` into `stage3_status`; a confirmed booking now records
`Confirmed` there instead of the default `Requested`.

## The voice fleet

`check_availability` offers the soonest free times of the kind asked for, read
through `calcomFreeSlots` exactly as the website reads them.
`book_appointment` books the chosen time in Cal.com with the caller's email, so
the invitation reaches them. A caller who already holds a session of that kind
is told so and asked before anything moves; the second call carries
`reschedule_existing` and moves it in Cal.com, which issues a new booking uid
and emails the updated invitation. Every booking is mirrored into
`crm_appointments` with its Cal.com uid under `metadata.calcom`, which is what
the webhook matches changes against.

A failure the caller did not cause — Cal.com unreachable, a refused key, an
event type that no longer exists — is never spoken as a booking. The agent says
nothing was booked and that the team will call back, and that promise is kept
by a `calendar_booking_failed` notice. A refused key or a missing event type
raises it at `error` severity, because it means every booking path is failing.

### What the agents say about a booking

The twelve prompts and the knowledge base say what `book_appointment` does
once Cal.com is on: a booking made on a call is confirmed in the calendar there
and then, and the invitation with the video link is emailed straight away. The
booking specialist's first message asks which day or time suits, so a caller
handed over from the front desk is never left waiting in silence.

None of it is live until `apply-fleet-upgrade.py` pushes it, and the
knowledge-base half cannot merge before its corpus is uploaded:
`npm run check:voice-kb` fails while the committed corpus differs from the copy
`knowledge-base/vapi-file.json` records, so the fleet never answers from a
corpus the repository does not hold. The prompts travel in the same change, so
the prompts and the knowledge base never disagree. With `VAPI_KEY`, on the
change's branch:

```bash
python3 scripts/voice/upload-knowledge-base.py   # text/plain, polled to `done`; commit vapi-file.json
```

then merge it, and from `main`:

```bash
python3 scripts/voice/apply-fleet-upgrade.py     # prompts, first messages and knowledge-base file, all 12
```

Run that only once Mission Control is published with the Cal.com code and
`CALCOM_API_KEY` is set. Before then the live `book_appointment` still records
a request, and these words would claim a confirmation it does not make.

Uploading changes nothing live. The fleet reads the new file only once
`apply-fleet-upgrade.py` points it there. Until then the live agents still call
a booking a request the team confirms by email — an understatement once
Cal.com is on, never a claim beyond what happened — and every reply from
`book_appointment` already tells the agent what to say for the outcome it got
(`voiceBooking.pure.ts`).

## What operators see

| notification kind         | raised when                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `calendar_booking_failed` | somebody asked for a time and did not get it because the calendar failed, not because it was taken |
| `crm_appointment_changed` | a booking the CRM mirrors was moved, cancelled or marked a no-show in Cal.com                      |
| `lead_stage_three`        | a Stage 3 review was moved or cancelled in Cal.com (it lives in Airtable, not the CRM)             |

Each is its own enum value, so muting one does not silence another.

## Rolling back

Unset `CALCOM_API_KEY`. The voice tools return to the local window and the
Stage 3 route to `not_configured`, which returns the site to its request form —
no deploy of either needed. Bookings already made stay in Cal.com with their
invitations; cancel them there if they should not stand.
