# Retiring the Airtable team notification

Mission Control becomes the **sole** internal notifier for the priority-access
funnel. This is the order to do it in, and the reason for the order.

The whole cutover turns on one asymmetry. **Switching the Airtable automation
off is a click in a browser and nothing in this repository can see it.** No
test fails, no gate goes red, no ledger row changes. If Mission Control is not
already sending by then, the team simply stops being told about leads and the
first evidence is somebody asking why the pipeline went quiet.

So every step below is asserted **by effect** — something observed to have
happened — and never by configuration. Reading a setting proves a setting was
read.

---

## What is live today

Measured from the automation export in
`npc-property-dashbord/docs/integrations/airtable/npc-emails/automations/`
(baseId `apptyShYE0yzL4IGB`, exported 2026-08-18), with every `fld…` resolved
through that export's own `migration/id-references.json`.

| Stage | Automation | Deployed | Triggers on | Make writes | Fires? |
| --- | --- | --- | --- | --- | --- |
| 1 | `wflM9vUhBoHb0ZE8r` *Aurixa Lead Capture* | yes | Aurixa Waitlist `tblHzGiB591W3GpoZ` | `tblHzGiB591W3GpoZ` | **yes** |
| 2 | `wflh1IWRe0okzxeTK` *Notify Aurixa Team…* | yes | Business Readiness Responses `tblXQx00T3CKEVnvV` | `tblB1t18q6aUTNI0g` | **no** |
| 3 | — | — | — | `tbljj5XQbC2a4ON1U` | **none exists** |

**Only Stage 1 is actually replacing anything.** Stage 2's automation is
deployed against a table the live Make scenario does not write, so it has never
fired; Stage 3 has no automation at all. Those two are gaps being closed, not
duties being transferred.

**The Stage 1 automation has a live defect worth knowing before you copy its
recipient list.** Four of its five addresses carry a leading space —
` rugesh@…`, ` lavan@…`, ` arvinraj@…`, ` mithrubanbupathy@…` — and only
`admin@…` is clean. Nothing in the export records whether Airtable trims them
before sending. If it does not, four people have never received a lead alert.
Mission Control trims (`resolveInternalRecipients`, pinned by a test that names
this defect), so pasting the list across is safe — but do not assume the
Airtable side was working for those four.

### Parity

`src/server/leadStageEmailParity.test.ts` asserts, field by field, that Mission
Control's internal email still carries everything the two Airtable emails
carried: **all 12** fields of *New Lead Received* and **all 9** of the BRQ
notification. If somebody later removes one, that test fails and names the
Airtable email that used to carry it.

Mission Control additionally carries the attribution the website captured
(source, campaign, landing page, referrer, marketing consent), the submission
time, a deep link to the record, and — at Stage 2 — the **entire** questionnaire
including the six free-text answers that previously reached no email at all.

---

## Before you touch Airtable

### 1. Set the recipient list, and set it FIRST

```
LEAD_STAGE_INTERNAL_RECIPIENTS = admin@…, rugesh@…, lavan@…, arvinraj@…, mithrubanbupathy@…
```

Comma, semicolon or newline separated. Leading and trailing spaces are trimmed;
`Name <addr@host>` is read; an entry that is not an address is dropped and
named rather than passed to Graph, which refuses the **whole** message for one
bad recipient.

Unset, this resolves to the sending mailbox alone — one person told, which
reads identically to five told in every ledger row and on every screen. That is
why it is step one and not step three.

> A row raised before this is set keeps what it was raised with, because the
> ledger upserts with `ignoreDuplicates` and `UNIQUE (lead_id, stage, audience)`
> means it can never be raised again. Dispatch therefore re-resolves an
> internal send from the configured list at send time and notes on the row when
> the two disagreed. Setting the variable late is recoverable — but only
> because of that, and only for rows not yet sent.

### 2. Decide which stages Mission Control announces

```
LEAD_STAGE_INTERNAL_STAGES = 1,2,3
```

The rule: **a stage covered by a FIRING automation is excluded; one that is not
covered is not.** Until the Stage 1 automation is off, `2,3` avoids two emails
per lead. After it is off, `1,2,3`.

An unparseable value silently restores `1,2,3` — `"4"` and `"stage3"` both do —
so check it after setting it rather than assuming.

### 3. Prove the tick is running, and what it would do

One authenticated call answers every question that lives on the deployment:

```sh
curl -sS -X POST https://mission-control.aurixasystems.com.au/hooks/lead-stage-emails \
  -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" -d '{}'
```

```jsonc
{ "ok": true,
  "swept": { "queued": 0, "skipped": 0, "existing": 0 },
  "dispatched": {
    "claimed": 0, "sent": 0, "failed": 0, "skipped": 0,
    "readiness": {
      "graph": true,              // Microsoft Graph credentials present
      "mailbox": true,            // a sending mailbox resolves
      "recipients": 5,            // ← must be 5, not 1
      "recipientSource": "configured",   // ← must NOT be "mailbox_fallback"
      "droppedRecipients": [],    // ← must be empty
      "internalStages": [1,2,3],
      "applicantMode": "auto"
    } } }
```

`recipients: 1` with `recipientSource: "mailbox_fallback"` means step 1 did not
take. Stop here.

### 4. Prove the SCHEDULE exists, not just the migration

This is the step most likely to be skipped and the one that costs most.
`20260922130000_schedule_lead_stage_emails.sql` wraps its `cron.schedule` in
`EXCEPTION WHEN OTHERS THEN RAISE WARNING`, deliberately — a deployment without
pg_cron must not fail the whole migration. The consequence is that **the
migration ledger will read `applied` whether or not the job exists.**

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'lead-stage-emails';
```

One row, `*/5 * * * *`, `active = true`. No row means nothing ticks, nothing
sends, and every ledger row sits at `pending` for ever.

Then confirm the job is *delivering*, because a green cron run reports on the
SQL that queued the HTTP call and not on the call:

```sql
SELECT status_code, created FROM net._http_response ORDER BY created DESC LIMIT 5;
```

### 5. Send one real lead through, end to end

Submit a genuine Stage 1 application. Within five minutes:

- the team receives *[Aurixa] New application — …*
- `/leads` shows the lead, and its **Email record** shows a `sent` row reading
  `admin@… +4` — the `+4` is the whole point; a single address there means four
  people were not told
- the applicant receives their own acknowledgement, or a `skipped` row naming
  the switch that settled it

Do not proceed on a `sent` row alone. **Open an actual inbox.** The ledger
records what Graph accepted, not what arrived.

---

## Then, and only then

Open the live base (`apptyShYE0yzL4IGB`) and switch **`wflM9vUhBoHb0ZE8r`** off.
Set `LEAD_STAGE_INTERNAL_STAGES=1,2,3` if it was `2,3`. Send one more lead
through and confirm the team receives exactly one email.

Leave `wflh1IWRe0okzxeTK` alone or switch it off; it has never fired either way.

**Do not delete either automation.** Switching off is reversible in a click and
is the rollback below; deleting is not, and the export in the repo is a
2026-08-18 snapshot rather than a backup.

---

## Rollback

Switch `wflM9vUhBoHb0ZE8r` back on. It fires on `recordCreated` in
`Aurixa Waitlist`, so it resumes with the next lead and needs nothing else.
Then set `LEAD_STAGE_INTERNAL_STAGES=2,3` so the two notifiers do not both
announce Stage 1.

Nothing needs to be undone in Mission Control. A ledger row is a record that an
obligation was discharged; leaving it is correct.

---

## After the cutover, these are the things that will tell you

Once Mission Control is the only notifier, these are the failures that would
otherwise be silent, and what each now does:

| What happens | What you see |
| --- | --- |
| A colleague lands on the do-not-send register | `lead_stage_email_failed` naming them. They would otherwise stop being told for ever while every row read `sent`. |
| The suppression register cannot be read | The batch is **held at `pending`** and retried, with an operator notice. It is never recorded as "everybody is suppressed", which is what a statement timeout used to say. |
| One recipient address is malformed | Dropped at enqueue and named in `droppedRecipients`. Graph refuses the whole message for one bad recipient, so this would otherwise silence the notification for everybody. |
| Graph refuses, throttles, or is unconfigured | `failed` / `pending` / `skipped` on the row, plus a notice; `readiness.graph` says which. |
| The recipient list changes after a row is queued | Re-resolved at send, and the row says `recipients re-resolved at send: 1 → 5`. |

## Two limits, stated

**The live base is not reachable from this repository's tooling, nor from the
Airtable connection available to Claude Code.** Both reach only the rebuild
`appFNPL7iYiuQyHAO`, because an Airtable personal access token reaches only its
own account's bases. Everything above about the live automations is read from a
2026-08-18 export. One `list_automations(apptyShYE0yzL4IGB)` from the owning
account would settle their current state, and is worth running before step 5.

**Mission Control's own Supabase project (`fgpvagejkaeqedcwvbte`) is a Lovable
Cloud project outside this account's organisation** and cannot be reached by
the Management API. That is why steps 3 and 4 are an authenticated HTTP call
and a SQL query an operator runs, rather than something asserted here.
