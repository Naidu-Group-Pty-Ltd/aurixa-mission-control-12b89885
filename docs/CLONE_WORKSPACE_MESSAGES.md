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
  An open dashboard shows it within about a minute (the workspace polls every
  minute while the tab is in front, every two while it is behind).
- **Schedule** publishes with a start time that must be in the future; the
  message goes live by itself then. State is derived from timestamps at every
  read, so no worker moves it.
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
| list | `GET /api/public/clones/announcements` | silent: an empty list |
| reply | `POST /api/public/clones/announcements/replies` | loud: the person is told why |
| seen | `POST /api/public/clones/announcements/seen` | best-effort, never waited on |

The answer carries the words to draw and the workspace's own thread, nothing
else. Targeting never travels: a workspace is not told which plans a message
was scoped to, which other workspaces received it, or that they exist.

Only signed-in **staff** see it, in four places: a banner in the dashboard's
banner strip; a centred popup for a message sent as one (it waits while another
dialog is open, and can always be closed); a side notice and, while the reader
is in another tab or application, a browser notification with the Aurixa
Systems icon; and the Message Hub's **Aurixa Systems** list, which holds the
reply box for a message that takes replies. Clients, finance, solicitor,
accountant and builder partners never see it.

## What the console can tell you

`clone_announcement_deliveries` records that a workspace's dashboard fetched a
message (`first_delivered_at`, `delivery_count`) and, separately, that a person
there opened, dismissed or acknowledged it (`seen_count`, `first_seen_at`). A
count, never a name: Mission Control does not record who read anything. The row
says "fetched by N of M · opened in K"; "not yet fetched by any workspace"
means no dashboard it reaches has asked since it went live — a workspace asks
only while somebody has its dashboard open.

## Deploying it

The two migrations (`20261027120000_workspace_message_reply_kind.sql`,
`20261027120100_workspace_message_replies.sql`) apply through the migration
queue on merge. The code reads the new table only for messages that take
replies, so it is safe in the minutes before they land. The workspace side
ships from the prime (`mission-control-announcements`, the notice components)
and reaches each clone through the cascade and the function deploy lane.
