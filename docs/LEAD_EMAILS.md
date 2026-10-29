# Lead emails — Mission Control sends the applicant's emails

A free trial applicant receives three emails:

| Stage | Email | Sent when | Carries |
| --- | --- | --- | --- |
| 1 | Application received | the application lands | the secure questionnaire link |
| 2 | Questionnaire received | the Business Readiness Questionnaire is completed | the strategic review booking link |
| 3 | Review confirmed | the strategic review is booked | the session time, in the applicant's zone and Sydney's, and the video link |

Until now Make.com composed and sent all three: scenarios 9389960, 9590512 and
9601915, with the HTML inlined in each blueprint, editable only by opening Make.
Mission Control now composes and sends them itself — through the Microsoft
Graph sender the campaigns use, past the same do-not-send register, recorded in
the same `lead_stage_emails` ledger as the team notification — and the copy is
edited on **Email → Lead emails** (`/email/lead-emails`).

Make keeps doing everything else it does: it still writes each stage to
Airtable, and **Aurixa Stage 3 Access** (9602082) still decides whether the
scheduler opens. Only the email modules leave.

## The console

- **Stage cards** — who sends each stage today, whether its copy is the default
  or edited, and anything to fix.
- **Sent as** — the Microsoft tenant, the mailbox, the sender name and the
  reply-to, for all three stages. The tenant and mailbox pickers are the
  campaign composer's own. A blank mailbox is the tenant's default: under an
  added tenant, its own default mailbox; under the deployment's tenant,
  `LEAD_STAGE_EMAIL_MAILBOX`, else `MICROSOFT_MAILBOX_EMAIL`. The reply-to is
  also what `{{support_email}}` says. The team's notification sends from the
  same mailbox and, while no `LEAD_STAGE_INTERNAL_RECIPIENTS` list is set,
  goes to it.

  **On production** (set 29 Oct 2026): the *Aurixa Systems* tenant,
  `admin@aurixasystems.com.au`, sender name *Aurixa Systems*, replies to
  `admin@aurixasystems.com.au`. The deployment's own tenant is not Aurixa's —
  its campaigns send from npcservices.com.au mailboxes — so leaving "Sent as"
  blank would send Aurixa's applicants mail from another company's address.
  The same mailbox sends Mission Control's warmup mail through the same
  tenant, which is the standing proof that it can send.
- **Who sends it** — per stage. See [Handing a stage over](#handing-a-stage-over).
- **The editor** — every section of the email: subject and inbox line, header,
  message, next-step card, main button, security note, details, next steps,
  second button and footer. A section can be left out. Text takes
  `{{merge_fields}}` (click a chip to insert one at the cursor), `**bold**`, and
  a blank line between paragraphs. A link takes `https://`, `mailto:` or a merge
  field that is a link.
- **The preview** — drawn in the browser, as you type, by
  `renderLeadEmail` from `src/lib/leadEmailTemplates.pure.ts`: the same function
  the dispatcher sends with. Sample values by default; choose a recent applicant
  to see theirs. Desktop and phone widths; the plain-text version too. It sits
  in a sandboxed frame, so nothing in it runs or navigates.
- **Save / Discard / Reset to default / Send a test.** Save is refused while
  the email has problems (an unknown merge field, a link that is not a link, an
  empty subject, heading, message or compliance line). A saved email is an
  *override*: Reset deletes it, and the stage sends the default as it ships —
  including any later improvement to the default. A test goes to one address,
  saved or not, with `[Test]` in the subject; nothing is recorded against an
  applicant and its questionnaire link opens nothing.
- **Recent applicant emails** — the ledger's applicant rows: sent, waiting,
  skipped with the reason.

Reading is for operators. Every change — copy, identity, sender, a test — is
for administrators, is audited (`lead_emails.*`), and a sender change notifies
every operator.

## Handing a stage over

Every stage starts on **Make**. While a stage is on Make, Make sends it and
Mission Control only backstops it (`LEAD_STAGE_APPLICANT_MODE=auto`, as
`docs/lead-stage-emails.md` describes) — in the copy on this page.

A stage handed to **Mission Control** is sent within a minute of the stage
landing (the `lead-stage-emails` tick now runs every minute), with no grace
period and no reliance on a Make receipt.

**On production** (29 Oct 2026): all three stages are Mission Control's. The
EU Make account that ran scenarios 9389960, 9590512 and 9601915 is deprecated
(its hooks answer `200 Accepted` and run nothing), and the us2 account's
copies — Aurixa Waitlist Stage 1, 2 and 3 (5979814, 5979818, 5979838) — are
switched off, so nothing else sends these emails. The hand-over was written to
`lead_email_settings` with an audited `lead_emails.sender_set` per stage and
the operator notice, and proven by effect: test applicant `AX-F86555B04D`,
addressed to `admin@aurixasystems.com.au`, went through all three stages and
each applicant email and team notification was sent on its first attempt
(Graph 202), within a minute of its stage.

The order matters — the email modules come out of Make **first**, or every
applicant receives the email twice:

1. **Deploy and check.** The migration `20261029100000` has applied (the page
   no longer says it is pending). The **Sent as** card reads *sends from …*.
   Send yourself a test of each stage and read it in Outlook and on a phone.
2. **Stage 1 only: deploy the website change first.** The Stage 1 email's link
   is `…/questionnaire?ref=AX-…&token=…&expires=…`. The website asks Mission
   Control whether it is live (`POST /api/public/storefront/questionnaire-access`)
   and opens the questionnaire addressed to that applicant. A website without
   that change still opens the link, anonymously, as it does Make's today.
3. **Remove the email modules from Make.** The console shows these steps for
   the stage you are handing over:

   | Stage | Scenario | Remove | Keep |
   | --- | --- | --- | --- |
   | 1 | Aurixa Waitlist Stage 1 (9389960) | modules 19 and 21 (create and send) and 22 (record the send in Airtable) | 1–6: the application still goes to Airtable |
   | 2 | Aurixa Waitlist Stage 2 (9590512) | modules 3 and 4 (create and send) | 1–2: the answers still go to Airtable |
   | 3 | Aurixa Waitlist Stage 3 (9601915) | modules 7 and 8 (create and send) | 1–4 and 9. Connect module 4 straight to module 9, give that link module 7's filter (`Send Booking Confirmation` equal to `SEND`), and clear module 9's Confirmation Message ID field — it read module 7 |

   Save the scenario and leave it **on**.
4. **Hand it over.** *Send it from Mission Control*, tick that the modules are
   removed, confirm.
5. **Prove it by its effect.** Put one real application through the stage and
   check the applicant received exactly one email, from the mailbox on the
   card, and that **Recent applicant emails** shows it `sent`.

To hand a stage back, *Hand back to Make*, then restore the scenario's previous
version from Make's version history. Until Make sends again, Mission Control
backstops the stage.

### What changes when Mission Control sends

- **The send gates come with it.** Airtable's gate formulas are recreated in
  Mission Control and hold the email on the same conditions — see
  [The send gates](#the-send-gates). Declining an applicant is now
  **Disqualified** on the Leads page.
- **Airtable no longer records the Stage 1 send** (module 22 wrote
  `Stage 2 Invite Sent At`, the message id and the invite count). The ledger
  records it; the Leads page shows it. Stage 3 keeps module 9, so the booking
  is still marked Confirmed in Airtable.
- **The questionnaire link carries who it is for.** Make's link was a token the
  website only shape-checked, so the questionnaire opened anonymously and its
  submission reached Mission Control with no email (refused as
  `invalid_email`). Mission Control's link names the application and holds a
  256-bit token it can check.

## The send gates

Make sent each email only while an Airtable formula on the record read `SEND`,
re-reading the record twenty seconds after the event so a change in between
counted. Those formulas are recreated in `src/lib/leadEmailGates.pure.ts`,
condition for condition and in Airtable's order, with Airtable's own hold
reasons. They come from the 2026-08-18 export of base `apptyShYE0yzL4IGB`
(`npc-property-dashbord/docs/integrations/airtable/npc-emails/schema/base-schema.source.json`),
and `leadEmailGates.test.ts` quotes each formula beside its port.

| Email | Airtable formula | Held when (first that is true) |
| --- | --- | --- |
| 1. Application received | `Aurixa Waitlist.Send Stage 2 Invite` | Applicant already reached Stage 2 · Application declined · No Application ID on the record · No corporate email to send to |
| 2. Questionnaire received | `Aurixa Waitlist.Send Stage 3 Invite` | Applicant already booked a strategic review · Applicant has not reached Stage 2 yet · Application declined · No Application ID on the record · No corporate email to send to · Invitation limit reached (3) |
| 3. Review confirmed | `Strategic Review Bookings.Send Booking Confirmation` | Confirmation already sent · Booking cancelled · No applicant email to send to · No requested time on the booking |

The Stage 2 email is the strategic review invitation — it carries the link
`Stage 3 Booking URL` builds — so it takes the Stage 3 invitation's gate, which
the Make scenario never read.

**Where each input comes from now:**

| Airtable | Mission Control |
| --- | --- |
| `Stage 2 Reached` | a questionnaire is in (`stage2_completed_at`) |
| `Status = "Declined"` | the lead is **Disqualified** on the Leads page, or the mirror read Declined from Airtable |
| `Application ID`, `Corporate Email` | `application_id`, `email` |
| `Stage 3 Reached` (`Counts As Booked`) | a booking with a time, not cancelled, not a no-show |
| `Stage 3 Invite Count` | as Make recorded it; Mission Control sends each email once (its ledger is unique per applicant and stage) |
| `Confirmation Message ID` | Make's receipt (`stage3_confirmation_sent_at`); Mission Control's own send is its ledger row |
| `Booking Status = "Cancelled"` | `stage3_cancelled_at` — set by the Cal.com webhook when a stage-three booking is cancelled, cleared when the website reports a new booking — or the status read as cancelled. The webhook finds the lead by `stage3_cal_booking_uid`, the Cal.com uid the website reported, else by the application reference; it never compares `stage3_booking_reference`, which the Airtable mirror rewrites with the base's own reference |
| `Requested Start (UTC)` | `stage3_session_start` |

**When it is asked.** When the email is raised, and again just before it goes —
Mission Control's twenty-second re-read. A held email is a `skipped` ledger row
reading `held by the send gate: <reason>`, which Recent applicant emails and
the Leads page show. As with Make's filter, a held email is not sent later.

**One difference from Make.** Make confirmed each booking — every booking was
its own Airtable record with its own gate. Mission Control sends each email
once per applicant (the ledger is unique per applicant and stage), so a review
booked again after a cancellation is confirmed by Cal.com's own invitation,
not by a second Mission Control email.

**It applies whoever sends.** A stage still on Make is held in the backstop on
the same rule, so the backstop never sends an email Make deliberately held.
Email → Lead emails lists each stage's gate beside who sends it.

**Airtable is not in the path.** Every input above is a column Mission Control
holds. That matters now: since mid-October the NPC Emails workspace has been
over Airtable's monthly API allowance (`PUBLIC_API_BILLING_LIMIT_EXCEEDED`),
which stops Mission Control's mirror — and Make's own Airtable steps, since
they use the same API — until it resets.

## The questionnaire link

Minted by Mission Control at send time, for every Stage 1 email it sends:

- `lead_questionnaire_links` keeps the **SHA-256 of the token**, never the
  token, with the lead and an expiry **21 days** out. A retried send mints a
  new link; an earlier one stays valid until it expires.
- `POST /api/public/storefront/questionnaire-access`, rate limited per address:

  ```json
  { "applicationId": "AX-…", "token": "…" }          // the link from the email
  { "applicationId": "AX-…", "workEmail": "…" }      // "Continue with your Application ID"
  ```

  answers `{ ok: true, via, applicant: { applicationId, firstName, lastName,
  workEmail, organisationName, role, organisationType, annualVolume } }` — what
  the applicant typed at Stage 1, so the questionnaire is addressed to them —
  or `{ ok: false, reason }` with `invalid_reference` (also a wrong email: the
  answer does not say which), `invalid_token`, `expired` or
  `already_completed`. A database it cannot read is `503 unavailable`, never a
  refusal.

## Configuration

| Setting | Where | What |
| --- | --- | --- |
| Who sends each stage, the identity | Email → Lead emails | `lead_email_settings`, one row |
| The copy | Email → Lead emails | `lead_email_templates`, one row per edited stage |
| `AURIXA_WEBSITE_URL` | environment | the website's origin for the links. Unset: the origin of `AURIXA_QUESTIONNAIRE_URL`, else `https://www.aurixasystems.com.au` |
| `AURIXA_REVIEW_BOOKING_URL` | environment | the scheduler, if not `/schedule-strategic-review` on the website |
| `LEAD_STAGE_APPLICANT_MODE`, `LEAD_STAGE_APPLICANT_STAGES` | environment | still apply on top: `off`, or a stage left out, sends nothing whatever the console says — the console warns |

**When the settings cannot be read**, the tick makes no applicant decision and
claims nothing: guessing Make for a stage whose modules are gone could write a
terminal skip, and guessing Mission Control for one still on Make sends a
duplicate. **When the copy cannot be read**, an applicant's email waits a tick
rather than going out in words an operator may have replaced. Before the
migration applies, both are the defaults — every stage on Make — which is then
the truth.

## Files

| Path | What it holds |
| --- | --- |
| `src/lib/leadEmailTemplates.pure.ts` | the default copy, merge fields, validation, the renderer and the layout (Make's HTML, rebuilt) |
| `src/lib/leadEmailGates.pure.ts` | the send gates — Airtable's three formulas, recreated |
| `src/server/lead-emails.server.ts` | settings, templates, sending identity, questionnaire links, preview and test |
| `src/server/lead-emails.functions.ts` | the console's server functions |
| `src/routes/email.lead-emails.tsx` | the console |
| `src/routes/api.public.storefront.questionnaire-access.ts` | the website's link check |
| `src/server/lead-stage-emails.server.ts` | enqueue, claim, compose, send, record |
| `src/server/leadStageEmailPolicy.pure.ts` | whether an email is owed — `applicantSenders` decides who sends |
| `supabase/migrations/20261029100000_lead_email_templates.sql` | the three tables, `stage3_meeting_url`, the one-minute tick |
| `supabase/migrations/20261029120000_lead_stage3_cancelled_at.sql` | `stage3_cancelled_at`, the cancellation the Stage 3 gate reads |
| `supabase/migrations/20261029130000_lead_stage3_cal_booking_uid.sql` | `stage3_cal_booking_uid`, the Cal.com uid a cancellation is matched on |
