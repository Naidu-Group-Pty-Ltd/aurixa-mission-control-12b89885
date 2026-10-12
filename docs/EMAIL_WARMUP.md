# Email warmup

**Email Campaigns → Warmup** (`/email/warmup`). Mailboxes in the Microsoft
tenants Mission Control holds credentials for write to each other a little more
each day, and treat what arrives the way an interested reader would: open it,
pull it out of Junk, flag some of it, answer some of it. Mailbox providers read
those signals — mail that is opened, answered and rescued from spam — as
evidence that a sender is wanted, and a new domain or mailbox earns its sending
reputation from them before a campaign asks anything of it.

It is the mechanism Instantly, Lemwarm and their peers sell, run on mailboxes
this deployment can act on directly through Microsoft Graph. The difference
that matters is the network: theirs is thousands of other customers' Gmail and
Outlook mailboxes; ours is the mailboxes you enrol. See [Limits](#limits).

---

## The pool

Every enrolled mailbox is one tenant's mailbox — the deployment's own (its
Lovable secrets) or one added under **Email Campaigns → Microsoft tenants**.
The pool pairs them **across organisations only**.

**Why across organisations.** Mail from one mailbox to another in the same
Microsoft 365 organisation is delivered inside Exchange Online. It never
leaves Microsoft's internal routing, is not judged by inbound spam filtering,
and does nothing for either domain's reputation — a pool that paired
`sales@acme` with `info@acme` would report a perfect score and accomplish
nothing. Two accepted domains in one tenant are still one organisation.

An **organisation** is the directory a tenant's token is issued by (its `tid`
claim), not the Mission Control tenant row: a tenant entered by its GUID and by
a domain, or two app registrations in one directory, are the same
organisation.

**So a working pool needs mailboxes in at least two organisations**, and works
better with more: each mailbox writes to the others' mailboxes, so with only
two organisations every message goes between the same two sets. The page warns
when every warming mailbox is in one organisation.

**Test mode** (Pool settings) allows pairs inside one organisation, so the
machinery can be watched end to end with a single tenant. Those pairs build no
reputation, and pairs across organisations are still preferred when they
exist.

**Who writes to whom.** For each message, among the mailboxes in other
organisations that are warming and have room: the least loaded relative to
what it may receive, with the sender's last few partners pushed back and a
little randomness, so mail spreads across the pool rather than following a
fixed rota. A mailbox may receive about one and a half times its own daily
volume (`receiveCap`), so a mailbox two days in is not handed fifty messages a
day by partners further along. A pool that is lopsided — one mailbox on one
side, five on the other — will hold the larger side back, and says so
("every partner has received its share for today").

---

## Enrolling a mailbox

**Add mailboxes**: choose a tenant, tick mailboxes from its directory (the same
list, with the same access badges, as the campaign mailbox picker) or type an
address, set the schedule, start.

Each mailbox is **prepared** before it is enrolled, and refused with the
reason if that fails:

- its tenant's credentials are tried (a token is requested);
- if the token lists application roles, it must include **Mail.Send** and
  **Mail.ReadWrite** — warmup sends, moves, flags and replies to mail;
- a top-level folder named **Warmup** is found or created in the mailbox. That
  is a write, so it is also the proof that this application may change the
  mailbox at all — the one thing a token cannot show when Exchange's RBAC for
  Applications grants access without a role, or an application access policy
  excludes the mailbox.

| permission           | needed for                                              |
| -------------------- | ------------------------------------------------------- |
| `Mail.Send`          | sending warmup mail and replies (required)              |
| `Mail.ReadWrite`     | drafting, finding, moving, flagging, filing (required)  |
| `User.ReadBasic.All` | listing the tenant's mailboxes in the dialog (optional) |

One live enrolment per address.

---

## The schedule

| setting          | default          | meaning                                                    |
| ---------------- | ---------------- | ---------------------------------------------------------- |
| Start at         | 2                | new conversations on the first day                         |
| Add each day     | 2                | added for each day the mailbox actually warms              |
| Daily maximum    | 30               | the ceiling — 30–40 is plenty for most mailboxes           |
| Reply rate       | 30%              | share of the warmup mail it receives that it answers       |
| Mark important   | 15%              | share it flags (Outlook's "important")                     |
| Window           | 08:00–18:00      | when it sends, in its own zone                             |
| Time zone        | Australia/Sydney |                                                            |
| Weekdays only    | off              |                                                            |
| File sent copies | on               | move its own warmup mail out of Sent Items into the folder |

**The ramp counts days it warmed**, not calendar days: a mailbox paused for a
week resumes where it was, not seven days further up.

**Replies are on top of the daily number** — they are the reply rate at work,
not new conversations.

**Pacing.** Sends are spread across the rest of the window: the time left is
divided by the conversations left, and each gap drawn at random within ±40% of
that, never under four minutes. A day's sends land spread through it, at
irregular intervals, rather than in a burst at nine.

---

## A message's life

1. **Sent.** A row is written, then the message is created as a **draft** in the
   sender's mailbox and the draft is sent. Drafting rather than `sendMail` is
   what gives the engine a handle on it: every Graph call asks for **immutable
   ids**, so the draft's id is still the Sent Items copy's id afterwards, and
   its Message-ID is the one the recipient's copy carries.
2. **Confirmed and found** (from three minutes later). The sender's copy is read
   back once: still a draft means it never left — after 45 minutes that is
   `failed`, and the draft is deleted. Otherwise it is filed into the sender's
   Warmup folder (unless "file sent copies" is off), and the recipient's mailbox
   is searched for its Message-ID: **inbox, then Junk, then anywhere**. Where it
   is found is its **placement**. Searches widen from minutes to an hour apart;
   searched for and not found within **six hours**, it is `missing` —
   quarantined, rejected or deleted on arrival. A check that could not run at
   all (Microsoft unreachable or throttling, the tenant's credentials refused)
   is no evidence either way, so it never makes a message missing: it keeps
   being retried, and after two days the message is given up as "could not be
   checked", which counts for and against nobody.
3. **Engaged** (2–20 minutes after it is found): moved out of Junk if it landed
   there (**rescued**), marked read, flagged at the mark-important rate, moved
   to Focused if Focused Inbox had put it in Other, and **filed into the
   recipient's Warmup folder**, so it does not sit in anybody's inbox.
4. **Answered**, at the recipient's reply rate, 10–150 minutes later and inside
   the recipient's own window: Microsoft's own reply draft (so threading and the
   quoted original are real) with a few lines written above the quote, sent,
   and recorded as a message of its own that goes through all of this again —
   so the original sender's inbox placement is measured too. A reply to a reply
   is half as likely, and a thread stops at three messages. A message is never
   answered twice: a reply already on record — including one a pass sent and
   then died before it could mark the message answered — settles it.

What the recipient will do — answer, flag — is decided when the message is
sent and stored on it, by the **recipient's** rates. A step that is retried
does not roll the dice again.

### What it says

Assembled from a topic (catching up, notes from a meeting, a quick question, an
update, a book recommendation, …), a greeting by first name when the mailbox
has one, a main point and up to two supporting lines, a closing line and a
sign-off — thousands of combinations, a little different every time. No
links, images, attachments, prices, urgency or anything that sells: warmup
mail exists to be unremarkable, and a pool that sends the same three sentences
forty times a day is a pattern, not a conversation.
(`src/lib/email/warmupContent.pure.ts`)

---

## Health

**Inbox placement over the last seven days**: of the messages a mailbox sent
whose fate is known, the share that reached somewhere other than Junk. A folder
a rule moved it to counts as reached; **missing counts against**, because mail
that never arrives is worse than mail in Junk. Below five settled messages
there is no score, only "not enough mail yet".

| score  | reads as                                                          |
| ------ | ----------------------------------------------------------------- |
| ≥ 90%  | good                                                              |
| 75–89% | fair                                                              |
| < 75%  | poor — warmup mail is landing in spam, and campaign mail will too |

The page shows it per mailbox and for the pool, and each mailbox's last thirty
days as a chart (with a table view): each day's column is what it sent, the
part that missed the inbox highlighted.

**Campaigns are told.** A campaign whose sending mailbox is in the pool gets a
readiness warning while that mailbox is in its first two weeks, or while its
placement is under 75%.

---

## Stopping it

- **Pool settings → Pause the whole pool**: no new conversations and no
  replies. Mail already on its way is still found, read and filed, so nothing
  is left sitting in an inbox.
- **Pause a mailbox**: it stops sending and replying and is no longer written
  to; mail already on its way to it is still filed. **Resume** prepares it
  again first, so a mailbox in `error` comes back only once whatever stopped it
  is fixed.
- **Remove**: out of the pool. Its Warmup folder and the mail in it stay in the
  mailbox; its record stays here, so the messages it exchanged remain
  attributed.
- **Automatically**: a mailbox whose sends Microsoft refuses three times
  running goes into `error` with the reason. A tenant cannot be removed while
  any of its mailboxes is enrolled (`microsoft_tenant_warming`).

---

## The engine

`/hooks/email-warmup`, every two minutes (`email-warmup-2min`), with the cron
secret read from the vault inside the command, as every hook here. One pass at
a time: a pass takes the pool's lease with one conditional UPDATE on
`email_warmup_settings`, and concurrent ticks — pg_net delivers them in bursts
— find it taken and leave. A pass stops starting work after about 85 seconds
(the HTTP call allows 115), runs at most three Graph steps at once, and works
in this order:

1. rows a dead pass left as `sending` (with a draft on record: checked; without:
   failed);
2. mailboxes enrolled but not yet prepared;
3. confirming and finding sent mail (up to 40);
4. engaging with mail that landed (up to 40);
5. replies that are due (up to 20);
6. new conversations from mailboxes whose next send is due (up to 25), one at
   a time so each choice of partner sees the last.

Each pass writes what it did to `last_tick_at` / `last_tick_note`, which the
page shows; ten minutes without a pass is reported as a stalled scheduler.

---

## Limits

**The network is yours.** Instantly's pool is thousands of mailboxes across
Gmail, Google Workspace, Outlook.com, Microsoft 365 and others, so its warmup
mail exercises every major receiver. This pool is the Microsoft 365 mailboxes
you enrol: what it builds is reputation **with Microsoft's filtering** (Exchange
Online Protection and Outlook) — the receiver that matters most for
business-to-business mail, but not the only one. Mail to Gmail recipients is
judged by Google, which this pool never shows a warmup message to.

**It is only as good as its spread.** Two organisations work; five work better.
Domains you send campaigns from should each have mailboxes in the pool.

**It reads and files mail in real mailboxes.** Warmup mail passes through the
inbox for a few minutes (until it is engaged with) before it is filed into the
Warmup folder, and sent copies are filed out of Sent Items. Nothing else in a
mailbox is touched.

---

## Data

| table / view                | what it holds                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `email_warmup_settings`     | one row: pool pause, test mode, the engine's lease and heartbeat                                |
| `email_warmup_mailboxes`    | enrolments: tenant, schedule, ramp progress, next send, folder, errors                          |
| `email_warmup_messages`     | every message: sent → landed (where) → engaged → answered, or missing/failed                    |
| `email_warmup_daily` (view) | per mailbox per day in its zone, 90 days: sent and where it landed; received, rescued, answered |

Operators read all of it through RLS; every write is the engine or a server
function behind `requireOperator`, with the service role. Enrol, schedule
changes, pause, resume, remove and pool settings are audited
(`email_warmup_*`).

## Where things live

|                                                       |                                                 |
| ----------------------------------------------------- | ----------------------------------------------- |
| `src/lib/email/warmupPlan.pure.ts`                    | ramp, pacing, pairing, engagement plan, health  |
| `src/lib/email/warmupContent.pure.ts`                 | what warmup mail says                           |
| `src/server/email-warmup.server.ts`                   | the engine, and preparing a mailbox             |
| `src/server/graph-client.ts` ("Warmup")               | drafts, search by Message-ID, move, flag, reply |
| `src/lib/email-warmup.functions.ts`                   | the operator's API                              |
| `src/routes/email.warmup.tsx`                         | the page                                        |
| `src/components/email/warmup/*`                       | its parts, and the placement chart              |
| `src/routes/hooks.email-warmup.tsx`                   | the cron hook                                   |
| `supabase/migrations/20261012130000_email_warmup.sql` | tables, view, cron job                          |
