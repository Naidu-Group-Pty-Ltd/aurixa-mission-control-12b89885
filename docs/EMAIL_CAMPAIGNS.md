# The email scheduler

Read this before touching `src/lib/email/*`, `src/server/email-campaigns.server.ts`,
`src/server/email-bounces.server.ts`, `src/server/graph-client.ts`, or the
`email_*` tables.

Mission Control can now run a scheduled email campaign: upload a contact list as
a spreadsheet, write a message, set the rules that govern how fast it goes and
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

| outcome       | what it means                                                   | what happens                             |
| ------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `sent`        | Graph accepted the message                                      | terminal                                 |
| `failed`      | Graph refused it **before** accepting (4xx) — no message exists | may be released by a person              |
| `unconfirmed` | the request left and no answer arrived (network error, 5xx)     | **never** retried automatically          |
| throttled     | 429/503 — a refusal to start, so nothing was sent               | the claim is released, retried next tick |

`unconfirmed` is the one that matters. "We do not know whether this arrived",
resolved by sending it again, is exactly the duplicate rule 1 exists to prevent.
Releasing an unconfirmed recipient is a person's decision, made on the Audience
tab, and the confirmation says what is being traded: the chance of a second copy
against the certainty of a first.

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
`MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
`MICROSOFT_MAILBOX_EMAIL`. A client-credentials identity needing **`Mail.Send`**
and **`Mail.Read`** with admin consent — the second is the bounce scan, without
which rule 2 has no data.

An application permission reaches **every** mailbox in the tenant unless an
Exchange `ApplicationAccessPolicy` scopes it. Scoping it to the sending mailbox
is strongly recommended, and it is why the mailbox a campaign sends from is a
stored, operator-set field rather than something a request may name.

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
| `email-campaign-dispatch-1min` | every minute     | claims, sends, records                 |
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

Each tick runs to a wall-clock budget (20s) and honours a sub-minute gap by
waiting inside itself, so a five-second cadence does not need a five-second
cron.

---

## Where things live

|                                              |                                              |
| -------------------------------------------- | -------------------------------------------- |
| `src/lib/email/emailAddress.pure.ts`         | one identity per address                     |
| `src/lib/email/tabular.pure.ts`              | RFC 4180 delimited text, delimiter sniffing  |
| `src/lib/email/zip.pure.ts`                  | ZIP central directory, ZIP64, deflate        |
| `src/lib/email/xlsx.pure.ts`                 | workbook parts → a grid                      |
| `src/lib/email/workbook.pure.ts`             | the format router                            |
| `src/lib/email/listProfile.pure.ts`          | column profiles, address detection, contacts |
| `src/lib/email/campaignRules.pure.ts`        | window, gap, caps, quotas                    |
| `src/lib/email/mergeTemplate.pure.ts`        | merge fields and escaping                    |
| `src/lib/email/bounceReport.pure.ts`         | delivery reports → verdicts                  |
| `src/server/graph-client.ts`                 | the only place this talks to Microsoft       |
| `src/server/email-campaigns.server.ts`       | the dispatcher                               |
| `src/server/email-bounces.server.ts`         | the mailbox scan                             |
| `src/lib/email-campaigns.functions.ts`       | the operator's API                           |
| `src/routes/email.*`                         | the console                                  |
| `src/routes/api.public.email.unsubscribe.ts` | the unsubscribe facility                     |
