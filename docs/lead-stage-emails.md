# Lead stage emails, and the data a lead is judged on

Three deliverables, one funnel. This records what was **measured** first,
because two of the three gaps were not where they looked.

The funnel is three stages on `aurixasystems.com.au`, joined end to end by one
key — the application reference `AX-XXXXXXXXXX`:

| Stage | What the applicant does | Where it lands |
| --- | --- | --- |
| 1 | Priority Access Application (`/contact`) | Airtable `Aurixa Waitlist` |
| 2 | Business Readiness Questionnaire (`/questionnaire`, BRQ-01…16) | `BRQ Detailed Responses` |
| 3 | Strategic Review booking | `Strategic Review Bookings` |

---

## 1. The Leads page was reading one table of four

`airtable-sync` walked `Aurixa Waitlist` and nothing else. The questionnaire —
seats, systems, integrations, migration scope, security and procurement,
approved budget, preferred next step — sat in a second table nothing read.

So the columns `stage2_answers` and `stage2_summary` **already existed** and
were filled only by the browser's dual-write, which fires on the applicant's
own device and cannot be relied on. The durable mirror wrote neither. That is
why the page could show a lead had reached Stage 2 and not one thing they had
said in it.

The sync now walks four tables, indexes the children by application reference
and falls back to email, and merges. Three rules carry it:

- **A child table that fails never fails the parent.** `walkOptional` records
  the error in `child_errors` and the Stage 1 mirror completes; a questionnaire
  table that is renamed must not stop leads arriving.
- **The answer set is written in the WEBSITE's own key vocabulary.** Both
  paths — the browser dual-write and this mirror — fill one column, so they
  have to agree or the same applicant reads as two different people depending
  on which delivery arrived first.
- **The lifted columns are lifted for a reason.** `stage2_investment`,
  `stage2_authority`, `stage2_user_count` and the rest are columns rather than
  reads into the blob because they are what the register is filtered, sorted
  and exported on.

### The six answers that were disappearing

Measured while sharing the vocabulary: the section list named **34** keys while
the mapper writes **40**. Six real answers reached no summary, no email and no
page — `roleOther`, `authorityOther`, `informationManagementOther`,
`customSystemOwner`, and the two migration "not yet known" qualifiers.

Four of those are the free-text box an applicant types in when no option
fitted, which is the most informative answer a questionnaire collects.

`src/lib/leadQuestionnaire.pure.ts` is now the one list, read by the mapper,
the internal email and the Leads page. It names all six, and **anything the
vocabulary has not caught up with lands in `OTHER ANSWERS`, humanised**, rather
than being dropped silently. A key with no label is rendered as words: database
vocabulary never reaches the operator.

---

## 2. Internal notification: one stage covered, two not

**This section first said internal emails "did not exist anywhere". That was
wrong, and the way it was wrong is the point.**

What was measured is still true: all four Make blueprints under
`aurixa-systems/docs/integrations/make/waitlist/` were read, and **every
`toRecipients` in the funnel names the applicant and nobody else**; nothing in
`aurixa-systems` sends mail at all. What was never searched was **Airtable's
own automations** — and the live base's automation export does not live in
either `aurixa-*` repo, it lives in the `npc-*` ones
(`npc-property-dashbord/docs/integrations/airtable/npc-emails/automations/`,
baseId `apptyShYE0yzL4IGB`, exported 2026-08-18, 10 automations, 9 deployed).
A search scoped to the obvious repo found nothing and concluded there was
nothing. **An absence you did not search for is not an absence.**

Three of those ten automations carry a `sendEmail` node. What each one does is
decided by the table it triggers on, so that is what to read:

| Stage | Automation | Deployed | Triggers on | Make writes | Fires? |
| --- | --- | --- | --- | --- | --- |
| 1 | `wflM9vUhBoHb0ZE8r` *Aurixa Lead Capture* | yes | Aurixa Waitlist `tblHzGiB591W3GpoZ` | `tblHzGiB591W3GpoZ` | **yes** |
| 2 | `wflh1IWRe0okzxeTK` *Notify Aurixa Team…* | yes | Business Readiness Responses `tblXQx00T3CKEVnvV` | `tblB1t18q6aUTNI0g` | **no** |
| 3 | — | — | — | `tbljj5XQbC2a4ON1U` | **none exists** |

So the team is told when a lead applies, and is told nothing when that lead
completes the questionnaire or books a review. Stage 2's notification is
deployed and bound to the wrong table — *configured* is not *firing*, and the
two read identically from the automation list.

Two consequences for this feature. Mission Control's internal email is **on by
default at all three stages**, which duplicates stage 1; `LEAD_STAGE_INTERNAL_STAGES`
is what settles it, and the rule is that a stage already covered by a FIRING
automation is excluded and one that is not covered is not. And the default
falls back to all three stages on any value it cannot parse — `"4"` and
`"stage3"` both silently restore `1,2,3`, so the value is worth checking after
it is set rather than assumed.

**Mission Control is taking all three over**, and the order that makes that
safe is [`lead-stage-email-cutover.md`](./lead-stage-email-cutover.md). The
asymmetry it turns on: switching the Airtable automation off is a click in a
browser and nothing in this repository can see it, so every step there is
asserted by EFFECT — a tick that ran and reported what it would do, a
`cron.job` row, an inbox somebody opened — and never by reading a setting.

Parity is asserted rather than claimed. Every `fld…` the two automation
templates reference resolves through the export's own
`migration/id-references.json` to a column this repo already maps, and
`leadStageEmailParity.test.ts` pins all **12** fields of *New Lead Received*
and all **9** of the BRQ notification against the composed email. Remove one
later and the test names the Airtable email that used to carry it.

**Two caveats on the evidence.** The export is a snapshot, not a live read: the
Airtable credential this repo's tooling holds reaches only the *rebuild* base
`appFNPL7iYiuQyHAO`, so the live base's state today is inferred from a file.
One `list_automations(apptyShYE0yzL4IGB)` from the owning account settles it.
And the rebuild's copies all read `undeployed`, which is an artefact of how
they were created and **not** evidence about the live base.

## 3. The applicant's emails already existed — so this is a backstop

Make sends the applicant an email at all three stages today. Writing a second
sender that also sends is how an applicant gets two "Questionnaire Received"
emails four minutes apart.

`LEAD_STAGE_APPLICANT_MODE` therefore defaults to **`auto`**: send only where
the operations record positively proves nobody did.

| Stage | Receipt the scenario writes back | What `auto` does |
| --- | --- | --- |
| 1 | `Email Message ID` | sends only if absent, after the grace period |
| 2 | **nothing** | records `skipped`, naming the switch that settles it |
| 3 | `Confirmation Message ID` / `Confirmation Sent At` | sends only if absent |

Stage 2 answers **`null`**, not `false`. Collapsing "we cannot tell" into
"nobody sent" is precisely what produces the duplicate. To take ownership of
the Stage 2 send, switch the Make scenario's mail module off and set
`LEAD_STAGE_APPLICANT_MODE=always`.

**The Make scenarios were deliberately not edited.** They are outward-facing
and re-importing a blueprint creates a new scenario rather than updating the
live one.

---

## How a send is decided and recorded

`lead_stage_emails` is a ledger, not a flag — the same shape
`email_campaign_recipients` already uses:

- `UNIQUE (lead_id, stage, audience)` **is** the "never twice" rule. Not a
  boolean somebody has to remember to set.
- Enqueue writes an **obligation**; dispatch claims it with a lease and records
  the outcome. A throttle returns the row to `pending`; `unconfirmed` is
  terminal and never auto-retried.
- Suppressions are re-read **between the claim and the send**, and the read
  **fails closed**.
- The email is composed from the CURRENT lead row at send time, not from
  whatever the row held when the obligation was raised.

### The guard that matters most

`LEAD_STAGE_EMAIL_MAX_AGE_HOURS` (72). Without it, the first cron tick after
this ships emails every historical applicant in the table at once. It binds in
every mode, `always` included.

### What the email may say

**Nothing that is a verdict.** No score, no grade, no "strong fit", no priority
class. The funnel collects the applicant's answers; an opinion about them is
`crm.fit`'s to form, with its own evidence and its own audit trail.

A test asserts this, and it is written as the forms a verdict is **asserted**
in rather than as a bare-word scan. The first version scanned for `score` and
failed on the email's own closing sentence — *"Mission Control has not scored,
ranked or interpreted them"*. A sentence forbidding a verdict is the guarantee
working; rewording it to satisfy a regex would have deleted the guarantee to
keep the guard. A companion test plants seven real verdicts to prove the guard
is not vacuous.

A field the record does not hold is **omitted**, never rendered as "N/A" or as
a dash.

And **a humaniser belongs nowhere near an identifier.** `humanise` turned any
value with no capital and no space into sentence case, which is true of
`mortgage_broking` and equally true of `ada@analytical.example` — so the
applicant's own email address was capitalised on every internal email at every
stage, and an operator copying it out of one got a string the record does not
hold. It is bounded to a `lower_snake_case` token now, found by the parity
check rather than by reading: database vocabulary still becomes words, and an
address, a phone number, a time zone and a reference are rendered exactly as
stored.

### Failure is a notification; success is a record

A send that went needs nobody and lives in the ledger alone. A send that did
not go needs a person, so it raises `lead_stage_email_failed` through the
shared `notifyOperators` helper — `notificationDisposition.ts`'s rule, applied
rather than restated.

---

## What the Leads page draws now

Expanding a lead shows, in order: the funnel timeline, **qualification
signals** (the lifted columns — what a decision turns on), the **full
questionnaire** behind a disclosure, the **strategic review** in all three time
readings the record keeps, and the **email record**.

Two rules in the page itself:

- **A row the record has nothing for is omitted, never dashed.** A grid of
  dashes reads as a broken template.
- **The email ledger has three readings, not two**: rows, no rows, and
  could-not-be-read. The table arrives with a migration, and a deployment the
  migration has not reached answers **`PGRST205`** on the wire. Rendering that
  as an empty list would tell an operator nobody was emailed when the truth is
  that we could not look — so `unavailable` is its own state and says so.

## Who the team notification actually reaches

Once this is the SOLE notifier, every way the recipient list can quietly become
the wrong list is a way the team stops being told with nothing reporting it.
Four were found by driving the real dispatch path rather than reading it, and
each reported as normal operation.

**A stale list was served for ever.** The ledger upserts with
`ignoreDuplicates`, so a row raised before `LEAD_STAGE_INTERNAL_RECIPIENTS` was
set kept the fallback permanently, and `UNIQUE (lead_id, stage, audience)`
means it can never be re-raised — the ordinary cutover sequence left every
queued lead notifying one address while the console read `sent`. **Who an
internal notification goes to is a property of the deployment now**, the same
reasoning that composes the body from the current lead row, so it is re-resolved
at send and the row says so when the two disagreed. The ordering matters in
both directions: a configured list outranks the row, the row outranks a
fallback, and letting a `mailbox_fallback` overrule a row that already names
real recipients would be the same five-to-one collapse from the other side. The
applicant's own address is never re-resolved — it is a fact about the lead.

**An unreadable register was recorded as a register that said no.**
`readSuppressions` returned every key on error — failing closed, which is
right — but the caller could not tell that from a real answer and settled the
row `suppressed` with the reason *"every recipient is on the do-not-send
register"*. On a statement timeout that sentence is false, and `suppressed` is
terminal, so a transient fault dropped a notification permanently and
misdescribed why. **Fail closed, and say which kind of closed it is**: the
reading carries `readable`, an unreadable register HOLDS the batch at `pending`
and raises a notice.

**A suppressed colleague was silent.** A team recipient on the register is
anomalous — nobody unsubscribes themselves from their own lead alerts — and the
failure is that one person is never told again while every row reads `sent`. A
suppressed applicant still raises nothing: that is the register working.

**And there was a second reading of an address.** The resolver carried its own
shallow regex, which is precisely what lets an address `emailKey` cannot key
reach the wire while being invisible to the suppression lookup. One reading,
imported — which also trims the leading space four of the five recipients carry
in the deployed Stage 1 automation, and drops what cannot be an address before
Graph refuses the whole message for it.

## Configuration

Every switch is documented in `.env.example` under *Lead stage emails*. All of
it is optional: unset, `LEAD_STAGE_INTERNAL_RECIPIENTS` falls back to
`MICROSOFT_MAILBOX_EMAIL`, and with no Graph credentials at all the dispatcher
records `skipped` rows saying so rather than failing.

**The tick reports its own readiness.** Three facts decide whether this mailer
works — Graph configured, a mailbox resolved, who the team list reaches — and
all three live on the deployment where no test here can see them. The schedule
they hang off is allowed to fail silently: `20260922130000` wraps its
`cron.schedule` in `EXCEPTION WHEN OTHERS THEN RAISE WARNING`, so a deployment
without pg_cron records the migration as applied while no job exists. So an
authenticated `POST /hooks/lead-stage-emails` answers with a `readiness` block
naming the recipient count, how it was resolved and anything the list dropped:
one assertion by effect — the tick ran, and here is what it would have done —
in place of three readings of configuration, none of which prove anything ran.
It carries a COUNT and never an address.

## Files

| Path | What it holds |
| --- | --- |
| `src/lib/leadQuestionnaire.pure.ts` | the questionnaire vocabulary — one list, three readers |
| `src/server/airtableLeadMapping.pure.ts` | every Airtable column name, once |
| `src/server/airtable-sync.server.ts` | the four-table walk and merge |
| `src/server/leadStageEmail.pure.ts` | what the six messages say |
| `src/server/leadStageEmailPolicy.pure.ts` | whether one is owed, and to whom |
| `src/server/lead-stage-emails.server.ts` | enqueue, claim, send, record |
| `src/routes/hooks.lead-stage-emails.tsx` | the five-minute tick |
| `docs/lead-stage-email-cutover.md` | retiring the Airtable automation, in order |
