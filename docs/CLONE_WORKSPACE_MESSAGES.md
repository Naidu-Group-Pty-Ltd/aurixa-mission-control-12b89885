# Workspace messages: how Mission Control speaks to the fleet

Mission Control sends messages to the workspaces it runs — every clone, and
the prime. It is **never a contact** in any workspace's Messaging Hub: a
workspace can answer a message Mission Control sent with replies enabled, and
cannot start anything. This page records how that is built and why.

## Why no message had ever arrived (measured 27 Oct 2026)

Three messages had been written in `clone_announcements` and
`clone_announcement_deliveries` held **no row at all** — including the
all-workspaces notice that was live from 16 to 23 Sep. The matcher was not the
fault. Measured on the wire and in each project's edge logs:

1. **The prime could not be addressed.** Its clone API key carries no clone
   (`clone_api_keys.clone_id` is null, scope `tokens:meter`), and the public
   route answered such a key an empty list by design — "the prime is the
   operator's own house". The prime's dashboard polled 181 times in 24 hours
   and was told "nothing" every time. The console's workspace list held only
   clones, so the prime could not be chosen either. The operator's own staff
   work in the prime, which is where the messages were being looked for.
2. **The workspace the October messages named had no staff session.** NPC
   Client Dashboard's browser last checked its payment gate on 20 Sep 2026; in
   the log windows read (21, 25–27 Oct), its only browser traffic was
   `custom-auth-verify-v2` from one Linux Chrome user agent and no
   `mission-control-*` call at all — sign-in, never the dashboard. A message
   nobody's dashboard asks for is correctly "not yet fetched". The same held
   for NPC CRM Independent.
3. **One of the two October messages was never sent.** "Going Live — 22
   October 2026" (`7268ac7a…`) was saved as a draft with a start time and
   never published — Save and Publish were two separate clicks.

Also corrected on the way: the delivery stamp was written *unawaited* after
the response on a Cloudflare Worker, where work still pending when the
response returns may be cancelled. It is now awaited (and still never fails
the answer).

## Who a message is for

The console at `/announcements` (labelled **Workspace messages**) offers three
modes. They are three views of one stored scope, so delivery, reach and the
workspace's wire all run `announcementReachesClone`:

| Mode | Stored as | Reaches |
|---|---|---|
| **One workspace** | `audience_clone_ids = [id]` | that workspace — a clone, or the prime |
| **All workspaces** | both lists `null` | every workspace, the prime included, and any provisioned later |
| **Selected workspaces** | chosen plan slugs and/or workspace ids; with both, `audience_match = 'any'` | every workspace on a chosen plan, **plus** every workspace chosen by name |

### The prime is a workspace

The prime has no `clones` row. It is addressed by a reserved id, the nil UUID
(`PRIME_WORKSPACE_ID` in `src/lib/cloneAnnouncements.pure.ts`), which no
`gen_random_uuid()` clone id can be. A key with no clone is the prime's (the
route's rule since the channel existed). The prime has no plan, so it receives
what is addressed to every workspace or to it by name, and nothing scoped to a
plan. Delivery stamps and reply threads key on the workspace id, which is why
`clone_announcement_deliveries.clone_id` no longer references `clones`.

Three rules hold the scope together.

- **An empty choice is never "everyone".** A `null` column means "all", so an
  empty list stored there would reach every workspace while the operator thought
  it reached none. The editor refuses an empty selection, and `validateDraft`
  refuses an empty array on the server too.
- **Opening a message never widens it.** A message written before
  `audience_match` existed, holding both a plan list and a workspace list, means
  "these workspaces, if on these plans" (the original AND, `audience_match =
  'all'`, the column's default). The editor opens such a row as the workspaces
  it reaches today, so saving it cannot reach anyone new.
- **The editor shows who a message reaches before it is saved**, by running the
  same matcher over the live roster.

A workspace's own page has **Message this workspace**, which opens the editor
in One-workspace mode with that workspace already chosen
(`/announcements?to=<cloneId>`).

## When it goes out

The editor's last step is **Send now**, **Schedule** or **Save as draft**.

- **Send now** inserts the message *already published* — there is no moment at
  which a draft exists that a failure could strand — and it is live at once.
  Every workspace it reaches is signalled in the same act, and an open
  dashboard shows it within a second or two (see *How fast a workspace hears*).
- **Schedule** publishes with a start time that must be in the future; the
  message goes live by itself then. State is derived from timestamps at every
  read, so no worker moves it — and an open dashboard asks again at exactly
  that start time.
- **Save as draft** stores it for nobody; Publish on the list sends it later.

Every act carries a request id minted when the editor opens
(`client_request_id`, unique). A double click, or a retry after a timeout, is
the same act and finds the row the first attempt made: a message is never sent
twice. Times are entered in the operator's browser zone, which the editor names
beside the inputs, and travel as ISO instants.

## Announcement, or replies enabled

Each message is one of two kinds (`replies_enabled`).

- **Announcement only** (the default, and every message written before the
  column): one-way. The workspace's Hub says so in words.
- **Replies enabled**: a workspace's Command Centre staff can answer it. The
  answer is stored in `clone_announcement_replies` as that workspace's thread
  on that message, the operators are notified (`clone_announcement_reply`),
  and it appears under **Conversations** on the message's row. An operator
  answers within the thread; the workspace reads the answer signed "Aurixa
  Systems", never with the operator's name.

What a workspace may answer is decided by `replyRefusal`: the message must be
live, take replies, and reach that workspace by the matcher it was served by.
A workspace is only ever served its own thread (`threadForWorkspace`), and a
thread message carries exactly `THREAD_WIRE_KEYS` — no email, role or refs.
The author of a workspace reply is named by the workspace's own server from
its staff record, never by a browser.

## Severity, as a workspace draws it

Since 28 Oct 2026 every notice in a workspace is drawn in its severity's
colour, the same in every workspace (never the workspace's white-label
brand): Info in Aurixa blue, Success in green, Warning in the Aurixa orange,
Critical in red, each with its word ("Information", "Good news", "Needs
attention", "Critical"). The editor's severity picker shows a swatch for each
and says, under it, what the workspace will show (`SEVERITY_IN_WORKSPACE`).

## How fast a workspace hears (28 Oct 2026)

Measured before this change, from `clone_announcement_deliveries`: the prime
fetched the four messages sent on 27–28 Oct 0.1 s, 5.6 s, 6.5 s and 44 s
after they were published. That spread was the poll (every minute in front,
every two behind), and a scheduled message appeared up to a minute after
its start.

Now Mission Control **signals** each workspace a change reaches, at the
moment it is made, on that workspace's own Supabase Realtime
(`src/lib/workspaceSignal.pure.ts`, `src/server/workspaceSignal.server.ts`),
and every open dashboard there asks its relay at once. Measured on the wire:
Realtime accepted the broadcast (202) in about 200 ms, and a subscribed
browser received it 190 ms (prime) and 224 ms (NPC Test) after it was sent.

| Act | Who is signalled |
|---|---|
| Send now, Publish, Re-raise, Archive | every workspace the message reaches |
| Edit of a published message | every workspace it reached before **or** reaches now — a narrowed message must leave the workspace it was taken from |
| Schedule | every workspace it will reach, so their dashboards learn the start time |
| An operator's answer in a thread | that workspace alone |
| A draft | nobody |

- **The signal carries nothing.** Topic `aurixa-systems-notices`, event
  `changed`, payload `{ at }`. The dashboard then reads its notices through
  its keyed relay exactly as before, and this server decides what it is
  shown. So the channel is public: a listener with the workspace's
  publishable key learns only that something changed, and a sender can only
  make dashboards ask early, which the dashboard throttles (one read per four
  seconds per tab, spread over 1.2 s). The Message Hub's doorbell uses
  rotating secret topics because it reveals conversation activity; this one
  reveals nothing and Mission Control could not know a rotating name.
- **Where a workspace's Realtime is.** A clone's: `clone_backends`
  (`supabase_url`, `anon_key`), written at provisioning. The prime's:
  `prime_config.supabase_project_ref`, with its publishable key read through
  the Management API, as provisioning already reads it, and kept for the
  isolate's life. Only a `https://<ref>.supabase.co` URL is ever posted to.
- **A scheduled change needs no signal at its start.** The workspace's read
  carries `nextChangeAt` (the next scheduled start or live end that reaches
  it) and `serverTime`, and the dashboard asks again at that moment,
  measured on this server's clock.
- **The operator is told how it went.** Each act's toast says how many of the
  workspaces it reaches were signalled (`signalSentence`). One that was not
  still hears on its next check: every two minutes while its signal is up,
  every minute while it is down.
- **Never fails the act.** The message is already written; a signal that
  cannot be sent is counted and logged, never thrown. Awaited, because a
  Worker may cancel what is pending once the response has gone.

## When a workspace answers (28 Oct 2026)

A reply raises one `clone_announcement_reply` notification, written by
`replyNotificationOf` (`src/lib/workspaceReplyAlert.pure.ts`) and read back
by `workspaceReplyAlertOf`. It names **the business** (the workspace's own
trading name, which its relay reads from its own settings — never its
browser — and sends with the reply) and **the workspace** (the clone's name
here, or "Prime workspace"), who wrote, an excerpt and the message.

- **The pop-up.** `WorkspaceReplyAlerts`, mounted once in the root layout (so it outlives a change of page),
  hears the same notification insert the bell already hears live and shows a
  card bottom right — business, workspace, author, excerpt, **Open
  conversation** — that stays until it is opened or dismissed (three at a
  time; the rest wait in the bell). It honours the operator's mutes and
  refreshes the page's conversation counts as it appears.
- **The desktop notification** for the same row is `BrowserPushNotifications`'
  (opt-in, only while the tab is behind); the pop-up offers the opt-in.
- **The phone.** The notification row is the record: its `metadata`
  (`v: 1`, `announcement_id`, `workspace_id`, `workspace_name`,
  `business_name`, `author_name`, `excerpt`, `message_title`) and `url` are
  everything a phone notification needs. When the mobile app arrives, its
  sender subscribes to the same inserts and renders `workspaceReplyAlertOf`,
  so the words on a phone and on a screen cannot drift.
- A relay deployed before this change sends no business; the operator is
  shown the workspace's name alone.

## Who may do what

Reads use `requireOperator`, so support can see what the fleet is being told
and read replies. Writing, sending, publishing, archiving, re-raising and
answering use `requireAdmin`. The page hides the write controls from operators,
and the server enforces the same rule whatever the page shows.

## How a workspace receives it

A workspace's edge function `mission-control-announcements` relays three acts
to the keyed public routes (the clone API key never reaches a browser):

| Act | Route | Failure policy |
|---|---|---|
| list | `GET /api/public/clones/announcements` | silent: an empty list, marked `unavailable` so the dashboard keeps what it shows |
| reply | `POST /api/public/clones/announcements/replies` (with the workspace's business) | loud: the person is told why |
| seen | `POST /api/public/clones/announcements/seen` | best-effort, never waited on |

The answer carries the words to draw and the workspace's own thread, nothing
else. Targeting never travels: a workspace is not told which plans a message
was scoped to, which other workspaces received it, or that they exist.

Only signed-in **staff** see it, in four places: a banner that stays in view
at the top of every page (under the header; one line once the page is
scrolled; several take turns); a centred popup for a message sent as one (it
waits while another dialog is open, and can always be closed); a side notice
and, while the reader is in another tab or application, a browser
notification with the Aurixa Systems icon; and the Message Hub's **Aurixa
Systems** list, which holds the reply box for a message that takes replies.
Clients, finance, solicitor, accountant and builder partners never see it.

## What the console can tell you

`clone_announcement_deliveries` records that a workspace's dashboard fetched a
message (`first_delivered_at`, `delivery_count`) and, separately, that a person
there opened, dismissed or acknowledged it (`seen_count`, `first_seen_at`). A
count, never a name: Mission Control does not record who read anything. The row
says "fetched by N of M · opened in K"; "not yet fetched by any workspace"
means no dashboard it reaches has asked since it went live — a workspace asks
only while somebody has its dashboard open.

## Deploying it

The 28 Oct 2026 change needs no migration here. The workspace half (the
dashboard's signal listener, the relay carrying `nextChangeAt` and the
business) ships from the prime; until a workspace has it, it simply hears on
its poll as before, and its replies name no business.

The two migrations (`20261027120000_workspace_message_reply_kind.sql`,
`20261027120100_workspace_message_replies.sql`) apply through the migration
queue on merge. The code reads the new table only for messages that take
replies, so it is safe in the minutes before they land. The workspace side
ships from the prime (`mission-control-announcements`, the notice components)
and reaches each clone through the cascade and the function deploy lane.
