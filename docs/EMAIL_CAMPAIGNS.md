# The email scheduler

Read this before touching `src/lib/email/*`, `src/server/email-campaigns.server.ts`,
`src/server/email-bounces.server.ts`, `src/server/email-attachments.server.ts`,
`src/server/email-mailboxes.server.ts`, `src/server/graph-client.ts`, or the
`email_*` tables.

Mission Control can now run a scheduled email campaign: upload a contact list as
a spreadsheet, write a message, attach files to it, choose which mailbox in the
Microsoft tenant it leaves from, set the rules that govern how fast it goes and
who gets how much of it, and let a per-minute dispatcher work through it against
the same Microsoft tenant the prime property dashboard sends from.

---

## The two rules that have no undo

Everything below exists to serve two sentences:

1. **A campaign never sends the same message to the same address twice.**
2. **Nothing is ever sent to an address that has bounced.**

Both share the property that decides where they live: **a violation has already
happened by the time anybody can see it.** There is no un-send. So neither rule
is a condition in a planning function, where an added `OR`, a refactor or a
second caller retires it with nothing failing.

### "Never twice" is a unique index

`email_campaign_recipients` carries `unique (campaign_id, email_key)`. There is
exactly **one row per (campaign, normalised address)**, and sending is a state
transition on that row: `pending → claimed → sent`. A second delivery is not
something the code declines to do — it is a row that cannot exist.

That single constraint absorbs every path that would otherwise produce a
duplicate: re-importing the same list, importing a second list that overlaps,
two dispatcher ticks racing, and a retry loop somebody adds later. A database
trigger closes the last door by refusing to move a `sent` row back to `pending`
or `claimed`, which is the only way the constraint could be defeated without
deleting the ledger row outright.

`email_key` — lowercased, unwrapped, trimmed — is what every uniqueness
question is asked about, never `email`. `Bob@Example.com` and `bob@example.com`
are one person, and a dedupe that cannot see that mails them twice out of one
spreadsheet.

### "Never a bouncer" is checked three times, and has a source

`email_suppressions` is global across every campaign, keyed by `email_key`. It
is enforced:

- **at import** — a suppressed contact lands as `suppressed`, never `pending`;
- **at the wire** — the dispatcher re-reads the register between choosing a
  contact and claiming it, because a bounce can arrive in between;
- **by a trigger** — `email_recipient_send_guard` refuses the claim itself, and
  that is the copy that survives the dispatcher being rewritten.

The part that is easy to miss is that **a hard rule with no source of data is
decorative**. Microsoft Graph raises **no webhook** when an application-identity
`sendMail` fails downstream. The send answers `202`; the failure arrives twenty
seconds later as an ordinary message in the sending mailbox. If nothing reads
that mailbox, the register stays empty for ever and the product reports the rule
as enforced.

So `/hooks/email-bounce-scan` reads it every fifteen minutes, parses
delivery-status reports (RFC 3464 where the sender produced one, the prose and
`X-Failed-Recipients` where they did not), and writes hard failures to the
register.

Two rules carry that scan:

- **Only hard.** `5.x.x` means the address is wrong and will stay wrong. `4.x.x`
  means "not right now" — a full mailbox, a greylist, a server restarting.
  Suppressing on a soft failure deletes a good customer from every future
  campaign because of one afternoon, with nothing reporting it. Soft failures
  are counted and shown; they never reach the register.
- **Only addresses we sent to.** A delivery report is a message written by a
  stranger's mail server, and it usually quotes the whole original — headers,
  sender, every address in the body. A scanner that suppressed everything it
  found would, given one bounce from a mailing list, suppress the sending
  mailbox and silently stop the entire product. Every candidate is checked
  against the recipient ledger first, and one no campaign has sent to is counted
  and discarded. **That check is what makes reading arbitrary inbound mail
  safe.**

---

## The third state a send can be in

`sendMail` answers `202 Accepted` with no body. Three outcomes are therefore not
two:

| outcome       | what it means                                                    | what happens                             |
| ------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| `sent`        | Graph accepted the message                                       | terminal                                 |
| `failed`      | Graph refused it **before** accepting (4xx) — no message exists  | may be released by a person              |
| `unconfirmed` | the request left and no answer arrived (network error, 5xx)      | **never** retried automatically          |
| throttled     | 429/503 — a refusal to start, so nothing was sent                | the claim is released, retried next tick |
| deferred      | a draft could not be BUILT (5xx, dropped connection) — see below | the claim is released, retried next tick |

`unconfirmed` is the one that matters. "We do not know whether this arrived",
resolved by sending it again, is exactly the duplicate rule 1 exists to prevent.
Releasing an unconfirmed recipient is a person's decision, made on the Audience
tab, and the confirmation says what is being traded: the chance of a second copy
against the certainty of a first.

### When a refusal is about the campaign, not the contact

A `failed` recipient is one Graph refused — usually something about that
address. But some refusals are the same answer for every contact: access to the
chosen mailbox withdrawn (401/403, `ErrorAccessDenied`, `ErrorSendAsDenied`),
the mailbox gone (404), or the message too large for it (413,
`ErrorMessageSizeExceeded`). Recording those against each contact in turn turns
one configuration fault into a whole list of "refused" rows a person must
release one by one.

So `refusalScope` (`mailboxes.pure.ts`) sorts a refusal into `recipient`,
`mailbox` or `message`. Only `recipient` marks the contact failed. The other two
were refused **before** acceptance, so nothing exists: the claim is released,
the campaign is paused, and `paused_reason` says what Microsoft said and what to
do — shown at the top of the campaign page. Three refusals in a row of any kind
pause the campaign too, because a fault this code has no name for looks exactly
like that. Each pause is written to the audit log as
`email_campaign_paused_by_dispatcher`.

---

## The rules an operator sets

Per campaign, in the campaign's **own** timezone (this runs in a Cloudflare
Worker, which is UTC wherever it happens to be executing — a scheduler reading
the server's clock mails an Australian list at ten at night for half the year):

- sending days and an hours window (which may wrap past midnight);
- **messages per day** and **contacts per day** — different numbers the moment
  one message carries forty people, both nullable, neither derived from the
  other;
- **contacts per message** — above 1 the extras travel as BCC and the mailbox
  addresses itself, so a campaign cannot publish its own list to everyone on it;
- **seconds between messages**, honoured inside a tick as well as across ticks;
- **messages per dispatcher tick**, so one campaign cannot spend the whole
  invocation budget.

All of it is decided by `campaignRules.pure.ts`, which takes every input as an
argument — the clock included — so the awkward cases are tested rather than
reasoned about.

### Per-parameter quotas

The distinguishing feature: **a quota may be set on a column nobody told the
product about.** "No more than 20 a day to NSW", where `State` is simply a
heading that happened to be in the spreadsheet.

That works because the parse produces a description of every column good enough
to offer as a control — how full it is, how many distinct values, and what they
are (`listProfile.pure.ts`). A column is offered when its values **repeat**:
`State` with four values across 800 rows is a control; `Full Name` with 800
values across 800 rows is an identifier, and offering it produces a picker with
800 entries and no meaning.

Three rules:

- **A quota covers a SET of values, not one.** A real list spells one thing
  several ways, and `NSW` and `New South Wales` are one allowance. The operator
  says so explicitly; the product never silently rewrites somebody's data.
  `auStateSiblings` only pre-ticks the box.
- **Usage is counted from the ledger, never stored.** A counter table is a
  second copy of a fact, and its failure — a count that drifts below the truth —
  spends somebody's daily allowance twice with nothing reporting it. The ledger
  is the only place a send is recorded, so a count taken from it cannot
  disagree with what was sent.
- **A tick claims against its own quotas as it plans.** Without that, a tick
  planning forty messages against an allowance of twenty reads "twenty already
  sent" forty times and sends all forty — the quota holds across ticks and fails
  inside one, which is the harder failure to notice.

A contact whose value for the dimension is blank is outside every rule on that
column. Several rules may cover one contact; the strictest binds; none can lift
a global cap.

---

## Uploading a list

**The file goes to Supabase Storage directly from the browser, and only the
parsed rows travel through a server function.**

Uploading through the app would put the file through a Cloudflare Worker, whose
request-body ceiling is the smallest number in the whole path and is not
raiseable from here — so "max out the upload size" would have meant "whatever
the Worker allows", which is where a 200 MB export becomes a 413 with no
explanation. Going straight to Storage means the limit is the bucket's
(`file_size_limit` is set to 50 GB, the largest a bucket accepts; the
project-level "Upload file size limit" is a second setting and the **lower of the
two wins**), the parse never leaves the operator's machine, and the rows arrive
in chunks of 500 so a lost connection resumes instead of restarting.

The one real ceiling left is memory: a workbook must be held whole (it is a
compressed archive) and text becomes UTF-16 on the way in. `MAX_PARSE_BYTES` is
100 MB — roughly a million contacts — and it is **named, not discovered**: a
file above it is still stored, and the page says exactly why it was not read and
what to do instead.

### The format is read from the bytes, never from the MIME type

A contact list arrives labelled whatever the sending tool felt like: `text/csv`,
`application/vnd.ms-excel` on a file that is really CSV,
`application/octet-stream` from a browser that recognised nothing, or an empty
string. Refusing on the label rejects files this parser reads perfectly;
trusting it hands a ZIP to the CSV reader. **The bucket declares no
`allowed_mime_types` and the uploader accepts every file**, and
`workbook.pure.ts` opens it and looks.

Supported: CSV, TSV and any sniffed delimiter; XLSX; JSON (an array of records,
an array of arrays, or a wrapped payload); newline-delimited JSON. UTF-8 and
UTF-16 with or without a byte-order mark.

One format is **refused by name rather than guessed at**: the legacy OLE2
`.xls`. Nothing here can read a compound binary document, and a reader that
half-succeeds produces a table of mojibake that looks like a parsing bug rather
than an unsupported format. The refusal names the remedy.

### Why the parsers are written rather than depended on

npm's `xlsx` is frozen at a version carrying published prototype-pollution and
ReDoS advisories, and `package.json` already keeps a note about pinning
transitive dependencies away from exactly that. `zip.pure.ts` +
`xlsx.pure.ts` + `tabular.pure.ts` are ~900 lines with their own tests and no
supply chain. Inflation is the platform's own
`DecompressionStream("deflate-raw")`, so there is no inflate implementation here
to get wrong.

Four things in the workbook reader decide whether a real export comes out right,
and each is a silent failure if missed:

- **Shared strings.** Text is not in the sheet. A reader that takes `<v>` at
  face value turns every name and address into a small integer.
- **Missing cells.** An empty cell is usually absent, so columns are placed by
  their `A1` reference and never by counting `<c>` elements — counting is how
  one blank cell shifts the email column onto the postcode.
- **Dates are numbers.** `2023-03-15` is stored as `45000`, and only a number
  format id in `styles.xml` says otherwise.
- **The 1900 leap-year bug is real.** Serials at or below 60 are off by a day,
  and the workbook may be on the 1904 epoch instead.

---

## Attachments

Every message of a campaign carries the same files — up to ten, **20 MB in
total**. The ceiling is the receiving server's, not ours: Exchange will send 35
MB, but a gateway that refuses 25 MB refuses the whole message, and that comes
back as a bounce that puts a good address on the register.

### The file goes to Storage from the browser, then the server measures it

Like a contact list, an attachment never passes through a Worker: the browser
uploads it to the private `email-attachments` bucket at
`<campaign>/<attachment id>/<name>`, then calls `registerCampaignAttachment`,
which reads the object back with the service role and records **its own** size
and SHA-256. A hash the browser computed would be a claim. Anything refused —
a blocked type, over the ceiling, a duplicate, a running campaign — is removed
from the bucket on the way out. A path whose id already belongs to a row or a
sent message is refused before anything is removed, so registration can never
be used to delete the record of a file somebody received.

### What a message carries is exactly what was attached, or nothing is claimed

The dispatcher reads and **re-hashes** every file before it claims a single
contact, the same rule as the token: a message missing its file is a different
message, and once it has gone the never-twice rule makes it permanent. A file
that cannot be read, or no longer hashes to what was registered, costs one tick
and touches no recipient. The bucket grants no UPDATE, so an object cannot be
replaced in place; the hash is the second wall. Verified bytes are cached per
isolate (48 MB, keyed by id **and** hash), so a running campaign does not
download the same file every minute.

Each message row snapshots what it carried (`email_campaign_messages.attachments`:
id, name, type, size, hash, storage path, inline) **before** the send. Removing an
attachment deletes its row; the stored file is deleted only when no message
carried it — once sent, it is the record of what those people received, and the
Activity tab links to it from every message.

Attachments can change only while a campaign is a draft or paused. A file
swapped mid-send would split one campaign into two messages with no record of
who received which.

### Two ways out of Graph

`sendMail` carries attachments inside its one request, as base64, and that
request is capped at about 4 MB. So `deliverMessage` estimates the request and
picks:

- **one `sendMail`** when it fits (files totalling up to about 2.9 MB);
- **a draft** otherwise: create it, attach each file — a POST for files under 3
  MB, an **upload session** in ~3 MB ranges for larger ones (Graph refuses an
  upload session below 3 MB and a POST above it, so the threshold is not a
  knob) — then `send`. The upload URL is pre-authenticated on
  `outlook.office.com` and never carries our bearer token.

Everything before the draft's `send` creates a draft and sends nothing, so a
failure there is `refused`, `throttled` or `deferred` — never `unconfirmed` —
and the draft is deleted. The `send` itself is classified exactly as `sendMail`
is. When it ends `unconfirmed`, the draft is **kept** and its id recorded as
`graph_draft_id`: a draft still sitting in the mailbox's Drafts folder is proof
the message never left, which is what a person needs before releasing it.

The draft path needs **`Mail.ReadWrite`** as well as `Mail.Send`. Readiness says
so when a campaign's files are large enough to need it, and louder when the
token visibly lacks it; if it is missing, the first message is refused, the
campaign pauses, and the pause reason names the permission.

### Inline images

There is no "inline" toggle. A file is inline when the HTML body refers to it
as `cid:<name>` — `<img src="cid:logo.png">` — and an ordinary attachment
otherwise. A toggle could disagree with the body, and both ways round that is a
visible defect. The name is derived from the file name and shown beside each
file, with a button that copies the tag. Readiness **blocks** a body that shows
a `cid:` no attachment provides (every reader would see a broken image), and the
preview swaps each inline image for a short-lived signed URL so the operator
sees what the reader will.

### What is refused, and what is warned

Refused at upload, by the browser and again by the server: executables,
scripts, disk images and the rest of Outlook's blocked list (`BLOCKED_EXTENSIONS`
in `attachments.pure.ts`, read from the **last** extension, so `invoice.pdf.exe`
is the executable it is), an eleventh file, and anything taking the total past
20 MB.

Warned before Start: a message over 10 MB (receiving servers), the draft path
and its permission, and a pace that will outrun Exchange's per-mailbox upload
allowance of **150 MB in any five minutes** — a 10 MB file on every message
meets it at fifteen messages. A 429 there is the ordinary throttle (claim
released, retried next tick), so the cap slows a campaign and never loses or
repeats a message; the warning says how fast it will really go.

---

## Choosing the mailbox

`MICROSOFT_MAILBOX_EMAIL` used to be the only mailbox a campaign could send
from in practice (the field existed but was free text, checked against
nothing). It is now a **default**: each campaign picks its mailbox on the
Message tab from the tenant `MICROSOFT_TENANT_ID` names.

An application permission is not tied to one mailbox — `Mail.Send` reaches
every mailbox the tenant's Exchange policy allows. So the picker lists the
tenant's directory (users and shared mailboxes with a mail address, guests
excluded) and marks each entry with whether **this application can actually
use it**, read from Exchange rather than assumed:

| badge        | meaning                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| can send     | its inbox can be read, so the access policy admits this application                  |
| blocked      | Exchange refused — an application access policy excludes it, or Mail.Read is missing |
| no mailbox   | no Exchange Online mailbox (unlicensed, inactive, on-premises) or no such user       |
| not answered | throttled or unreachable just now — not a verdict, never cached                      |
| can't check  | the token holds Mail.Send but no Mail.Read, so no inbox can be read; choosable       |
| unchecked    | listed but not yet checked — checked the moment it is chosen                         |

**Why "can read its inbox" is the test.** Exchange applies the same access policy
to reading and sending, and there is no way to ask "may I send as X" without
sending something; reading one folder id is free. And a mailbox that cannot be
read cannot have its bounces read — a campaign sending from it would report
rule 2 as enforced with no data at all.

The probe is `GET /users/{address}/mailFolders/inbox?$select=id`, twenty to a
`$batch`. The default, the mailboxes this deployment already uses and the first
200 directory entries are checked when the picker opens; the rest when chosen.
Answers are cached per isolate for five minutes; "not answered" is never cached.

Saving a **changed** mailbox checks it again, fresh, and refuses one that is
blocked or has no mailbox; the change is audited as
`email_campaign_mailbox_changed`. Readiness checks the effective mailbox
(the campaign's own, or the default) and blocks Start on a blocked one.
Leaving the field on "Deployment default" keeps the campaign following
`MICROSOFT_MAILBOX_EMAIL` rather than pinning today's address.

**Listing the directory needs a directory permission** — `User.ReadBasic.All` is
the least of them. Without one the picker says so, still offers every mailbox
this deployment already uses, and accepts any address typed and checked.

**The token's roles are advisory.** A client-credentials token lists its
granted application permissions in its `roles` claim, and the console reads it
to say what is missing (the strip on the campaigns page). Exchange's RBAC for
Applications grants mailbox access without putting any role in the token, so a
missing role is a warning, never a block — the probe is the authority. The one
place roles change a verdict: a token that carries roles but no read role is
refused every inbox, so its probes become "can't check" rather than "blocked",
and campaigns that send today are not stopped by a check that could never pass.

## More than one Microsoft tenant

A campaign sends through **one** Microsoft tenant, chosen on its Message tab
above the mailbox. The deployment's own tenant — the four Lovable secrets
above — is the default (`tenant_id` NULL everywhere). Others are added on the
Email Campaigns page under **Microsoft tenants**, by an admin, with the same
four values: Directory (tenant) ID, Application (client) ID, the client
secret's **Value**, and an optional default mailbox.

**Why not Lovable secrets.** A Lovable secret is set in the Lovable editor and
read by the Worker when it is deployed; the running app has no way to create
one. Added tenants therefore live in **Supabase Vault**, the store this
deployment already keeps `cron_secret` in, and behave the way a deployment
secret does:

- **Write-only.** The credentials go in through `addMicrosoftTenant` /
  `updateMicrosoftTenant` and never come back out. The page shows a hint of each
  — the last four characters of the two IDs and the first three of the secret,
  the same hint Azure shows beside a client secret.
- **One Vault secret per tenant** (`microsoft_tenant_<uuid>`, JSON), reached only
  through `microsoft_tenant_credentials()` — `SECURITY DEFINER`, executable by
  the service role and nobody else. `public.microsoft_tenants` holds the label,
  the hints, the fingerprint and the verification record; operators can read it,
  nothing in it is a credential.
- **Tried before saved.** A token is requested with new credentials before
  anything is stored, and a refusal comes back with Microsoft's reason in words
  (`AADSTS7000215` → "the client secret is wrong — paste the secret's Value…").
  A default mailbox, if given, is probed the same way.
- **Blank keeps the stored value.** Editing a tenant with the secret left empty
  changes nothing about the secret, exactly as leaving a deployment secret alone.
- **One row per app registration.** A SHA-256 of `tenant:client` is unique among
  live tenants, and the deployment's own registration cannot be added twice.
- **Removal destroys the Vault secret** and keeps the row (`removed_at`) so the
  messages that went through it still say which tenant they used. Removal is
  refused while a running campaign uses the tenant.

Every write is audited (`microsoft_tenant_added`, `_updated` with field names
only, `_removed`), as is moving a campaign between tenants
(`email_campaign_tenant_changed`). A campaign's tenant can change only while it
is not running; changing it resets the mailbox to the new tenant's default,
and a named mailbox is re-checked against the new tenant before it is saved.

**Everything that talks to Microsoft is per tenant.** Tokens are cached per
tenant and per credentials version, so a rotated secret never reuses the old
token; the mailbox directory, the access probes and the token's roles are
cached per tenant; the dispatcher takes each tenant's token once a pass, before
claiming anything, and a tenant whose credentials fail holds up only its own
campaigns. Every message row records `tenant_id`, and the bounce scan reads
each mailbox through the tenant that sent from it. A resolved tenant is cached
for a minute per isolate, which bounds how long an isolate keeps using a
secret that was just replaced.

Lead-stage emails, payment links and CRM journeys still send through the
deployment's own tenant only.

### Warming a mailbox up first

A new domain or mailbox has no sending reputation, and a campaign is a poor
way to earn one. **Email Campaigns → Warmup** runs an Instantly-style warmup
pool across your tenants' mailboxes — see [EMAIL_WARMUP.md](EMAIL_WARMUP.md). A
campaign whose sending mailbox is warming gets a readiness warning while it is
in its first two weeks, or while its warmup mail is landing in spam.

### The bounce scan follows the mailboxes that actually sent

Once a campaign can move between mailboxes, reading only the mailboxes campaigns
name **today** would stop reading a mailbox's bounces the moment somebody
changed the field — while they keep arriving there for days. The scan now reads
every tenant's default, every mailbox a non-draft campaign names, **and** every
mailbox a message has left from in the last 30 days
(`email_campaign_sending_mailboxes`, a view over the message ledger) — each read
through the tenant it was used with.

---

## Personalisation, and what it costs

Merge fields are `{{column_key}}` — any column from an attached list — plus
`{{email}}`, `{{campaign_name}}`, `{{sender_name}}`, `{{today}}` and
`{{unsubscribe_url}}`.

- **Substitution escapes.** A body is HTML, and a contact called
  `Smith & Sons <Trading>` substituted raw closes a tag and swallows the
  paragraph — and, worse, a list is data somebody else supplied, so an unescaped
  merge is a way to put markup of their choosing into mail sent under our
  domain. Escaping is the renderer's job, so no call site can forget.
- **An unknown field is reported before the send.** `{{firstname}}` against a
  list whose column is `first_name` produces `Hi ,` on every message — invisible
  in the editor, obvious in the inbox. The campaign will not start.
- **Any per-recipient field forces one message per contact**, whatever the batch
  size says, and `messageBatchSize` enforces it server-side so a template edited
  after the fact cannot quietly BCC a hundred people a letter addressed to one.

---

## Unsubscribing

`{{unsubscribe_url}}` resolves to `/api/public/email/unsubscribe?t=<token>`, a
64-hex token minted per recipient.

**A GET does not unsubscribe anybody.** A link in an email is fetched by things
that are not the recipient — Outlook Safe Links, corporate mail gateways, spam
scanners, preview panes — and an endpoint that acts on GET therefore
unsubscribes people who never clicked, in a way that looks from every log like
they chose to. GET renders a page with a button; the POST behind it is what
writes. The cost is one extra click.

An unsubscribe writes to the same register the bounce scan does, so there is
exactly one list of addresses this deployment will not mail, and it applies to
every campaign — including ones that have not started.

Readiness **warns** rather than blocks when a message carries no unsubscribe
link: an internal notice to a handful of colleagues is a legitimate use. A
commercial electronic message in Australia needs a working unsubscribe facility,
and the warning says so at the moment it is worth noticing.

---

## Credentials

The same application registration the prime property dashboard sends from:
`MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and
optionally `MICROSOFT_MAILBOX_EMAIL` as the default mailbox. A client-credentials
identity with admin consent for:

| permission           | needed for                                                    |
| -------------------- | ------------------------------------------------------------- |
| `Mail.Send`          | sending (required)                                            |
| `Mail.Read`          | the bounce scan — rule 2's only data — and checking mailboxes |
| `Mail.ReadWrite`     | messages whose attachments exceed ~2.9 MB (built as drafts)   |
| `User.ReadBasic.All` | listing the tenant's mailboxes in the picker                  |

An application permission reaches **every** mailbox in the tenant unless an
Exchange `ApplicationAccessPolicy` (or RBAC for Applications) scopes it.
Scoping it to the mailboxes campaigns should use is strongly recommended: the
picker reads that policy, so a mailbox outside it shows as blocked and cannot
be chosen. That is why the mailbox a campaign sends from is a stored,
operator-set, checked field rather than something a request may name.

All unset is a supported state: campaigns can be written and lists uploaded, and
the page says the deployment cannot send rather than offering a Start button
that can only fail.

The token is read from `process.env` at **call** time, never at module load — a
module-level read makes an absent credential a boot failure instead of a dormant
feature — and cached per isolate with sixty seconds of headroom.

**The send does not retry.** `withRetry` is right for reading a mailbox and
wrong for sending one message: an error after the request has left says nothing
about whether a message was created. Only the reads retry.

---

## The workers

| job                            | cadence          | what it does                           |
| ------------------------------ | ---------------- | -------------------------------------- |
| `email-campaign-dispatch-1min` | every minute     | leases, claims, sends, records         |
| `email-bounce-scan-15min`      | every 15 minutes | reads the mailbox for delivery reports |

Both read `cron_secret` from the vault **inside** the command string, per
`check-cron-auth.mjs`: an unset GUC coalesced to `''` produces the literal header
`Bearer `, a well-formed request every hook answers 401, and pg_cron reports
every one of those runs as succeeded because queueing the HTTP call is the
success it reports.

The dispatcher takes its Graph token **before it claims anything**. A credential
failure after a claim leaves rows marked `claimed` with nothing to release them
and a queue that looks like it is working; taken first, it costs one tick and
touches no recipient.

### What actually calls the dispatcher

The job is scheduled every minute, but that is not how the calls arrive. pg_net
sends this deployment's hook calls in **batches**, and starts the next batch only
when the slowest request in the current one has answered — and other
every-minute hooks here allow up to 290 seconds. Measured on 12 Oct 2026 over two
hours: 61 batches, **41 to 262 seconds apart (median about 100)**, each carrying
**one to four** dispatcher calls at once. pg_cron also failed to start about one
run in eleven (`job startup timeout`: eleven every-minute jobs against six
worker processes). Look at it yourself with:

```sql
select created, count(*) filter (where position('"unconfirmed"' in content) > 0) as dispatch_calls
from net._http_response where created > now() - interval '1 hour'
group by created order by created;
```

The dispatcher was written for one call a minute, one after another. Against
bursts it had three faults, all fixed in `20261012110000`:

- **Calls in a burst worked the same campaign at once.** Each read the same
  `last_message_at`, so none waited out the gap for the others. Now a pass takes
  a **lease** on the campaign (`dispatch_lease_until` / `dispatch_lease_token`,
  one conditional UPDATE) and the other calls leave it alone. A pass that dies
  holding it delays the campaign by at most the lease (150 s).
- **A pass lasted 20 seconds.** With the default 60-second gap that is one
  message per burst — roughly half the campaign's own pace. Now a pass keeps
  starting messages for up to **90 seconds**, waiting out the gap between them,
  and re-checks the campaign's status and window before each one, because in
  that time an operator may pause it or its window may close. The hook's HTTP
  timeout is 115 s: a Worker whose caller disconnects is cancelled, and a
  cancellation mid-send is the one way to strand a contact.
- **Nothing said why a running campaign was not sending.** Every pass now writes
  `last_tick_at`, `last_tick_note` and `next_send_at` (the window opening, the end
  of the gap, or tomorrow once a daily cap is spent). The campaign page shows it
  — "Waiting for the sending window — Mon–Fri, 09:00–17:00 Australia/Sydney. Next
  message: Tue 13 Oct, 09:00" — and warns when the heartbeat is more than eight
  minutes old, which is the scheduler stalling rather than the campaign waiting.
  Readiness warns, before Start, when the window is closed right now, and says
  when the first message will go.

The case that found these: a test campaign started at 16:57 Sydney with the
default 09:00–17:00 Mon–Fri window sent one message at 16:58:51, then waited —
correctly — for 09:00 the next morning, while the page said only "running".

### Contacts stranded as `claimed`

A pass that dies mid-send (a cancelled Worker, a crash) leaves its contacts
`claimed`, and before this nothing ever moved them: the campaign could not
complete, and nobody was told. Each pass now records any contact claimed more
than ten minutes ago as **`unconfirmed`** — never `pending`, because the message
may have left — and its message row likewise. Ten minutes is well past the
lease, so no live pass can still be sending to them. Releasing them stays a
person's decision, on the Audience tab.

### The calendar, precisely

The window is half-open (09:00–17:00 sends at 16:59, not at 17:00), in the
campaign's own zone across daylight saving, and may wrap past midnight. **An
equal start and end means all day**; read as half-open it would be a window that
never opens. `nextWindowOpening` and `nextSendTime` in `campaignRules.pure.ts`
are what the page and the dispatcher both use to say when the next message goes.

---

## Where things live

|                                                    |                                              |
| -------------------------------------------------- | -------------------------------------------- |
| `src/lib/email/emailAddress.pure.ts`               | one identity per address                     |
| `src/lib/email/tabular.pure.ts`                    | RFC 4180 delimited text, delimiter sniffing  |
| `src/lib/email/zip.pure.ts`                        | ZIP central directory, ZIP64, deflate        |
| `src/lib/email/xlsx.pure.ts`                       | workbook parts → a grid                      |
| `src/lib/email/workbook.pure.ts`                   | the format router                            |
| `src/lib/email/listProfile.pure.ts`                | column profiles, address detection, contacts |
| `src/lib/email/campaignRules.pure.ts`              | window, gap, caps, quotas                    |
| `src/lib/email/mergeTemplate.pure.ts`              | merge fields and escaping                    |
| `src/lib/email/bounceReport.pure.ts`               | delivery reports → verdicts                  |
| `src/lib/email/attachments.pure.ts`                | what may be attached, and the delivery path  |
| `src/lib/email/mailboxes.pure.ts`                  | mailbox access, refusal scope, token roles   |
| `src/lib/email/microsoftTenants.pure.ts`           | added tenants: validation, hints, refusals   |
| `src/server/microsoft-tenants.server.ts`           | tenant credentials from Vault, add/rotate    |
| `src/lib/microsoft-tenants.functions.ts`           | the tenant API (admin writes)                |
| `src/components/email/microsoft-tenants-panel.tsx` | the Microsoft tenants tab                    |
| `src/server/graph-client.ts`                       | the only place this talks to Microsoft       |
| `src/server/email-campaigns.server.ts`             | the dispatcher                               |
| `src/server/email-attachments.server.ts`           | verified attachment bytes                    |
| `src/server/email-mailboxes.server.ts`             | the tenant directory and access probes       |
| `src/server/email-bounces.server.ts`               | the mailbox scan                             |
| `src/lib/email-campaigns.functions.ts`             | the operator's API                           |
| `src/routes/email.*`                               | the console                                  |
| `src/components/email/mailbox-picker.tsx`          | choosing the mailbox                         |
| `src/components/email/attachment-panel.tsx`        | attaching files                              |
| `src/routes/api.public.email.unsubscribe.ts`       | the unsubscribe facility                     |
