# Workspace messages: how Mission Control speaks to the fleet

Mission Control sends messages to the workspaces it runs. It is **never a
contact** in any workspace's Messaging Hub, and no message it sends can be
answered. This page records how that is built and why.

## The three ways to address a message

The console at `/announcements` (labelled **Workspace messages**) offers three
modes. All three are stored in the same two columns of `clone_announcements`,
so the modes needed no schema change:

| Mode | Stored as | Reaches |
|---|---|---|
| **One workspace** | `audience_clone_ids = [id]`, `audience_plan_slugs = null` | that workspace |
| **All workspaces** | both columns `null` | every workspace, including ones provisioned later |
| **Selected workspaces** | either the chosen ids, or the chosen plan slugs (never both) | those workspaces, or every workspace on those plans |

`audienceScopeOf` (`src/lib/cloneAnnouncements.pure.ts`) turns the editor's
choice into those columns. `audienceDraftOf` reads them back.
`announcementReachesClone` remains the one rule that decides delivery.

Three rules hold it together.

- **An empty choice is never "everyone".** A `null` column means "all", so an
  empty list stored there would reach every workspace while the operator thought
  it reached none. The editor refuses an empty selection, and
  `validateDraft` refuses an empty array on the server too, so neither end can
  store one.
- **Opening a message never widens it.** A message written before the three
  modes may hold both a plan list and a workspace list, which reaches only
  workspaces matching both. The editor opens such a row as the workspaces it
  reaches today, so saving it cannot reach anyone new.
- **The editor shows who a message reaches before it is saved.** The reach
  preview runs `announcementReachesClone` over the live fleet, using the same
  rule as delivery.

A workspace's own page has **Message this workspace**, which opens the editor
in One-workspace mode with that workspace already chosen
(`/announcements?to=<cloneId>`).

## Who may do what

Reads use `requireOperator`, so support can see what the fleet is being told.
Writing, publishing, archiving and re-raising use `requireAdmin`. The page
hides the write controls from operators, and the server enforces the same rule
whatever the page shows.

## How a workspace receives it

A workspace polls `GET /api/public/clones/announcements` with its clone API key.
The answer carries the words to draw and nothing else. Targeting never travels:
a workspace is not told which plans a message was scoped to, which other
workspaces received it, or that other workspaces exist.

On the workspace, `mission-control-announcements` relays the list to signed-in
**staff** only. It is shown in three places:

- as a banner or a modal (`AnnouncementHost`), as the message's `display` asks;
- in the staff Messaging Hub's **From Mission Control** panel, which is a
  read-only feed with no composer and no reply.

Clients, finance, solicitor, accountant and builder partners never see it.

## Why it is one-way

The request was to message workspaces "without exposing Mission Control as a
standard messaging contact or creating unnecessary two-way communication
channels". The design keeps to that in three ways:

1. **Mission Control is not a hub participant.** A participant can be added to
   a group, searched for, and messaged by anyone with hub access. The messages
   are announcements on their own wire, rendered by their own component.
2. **There is no reply path.** A workspace that needs to answer uses the support
   channels it already has. Adding replies would mean Mission Control holding a
   conversation store for every tenant, which it does not do.
3. **Delivery is recorded, not read receipts.** `clone_announcement_deliveries`
   records that a workspace fetched a message (`first_delivered_at`,
   `delivery_count`). It does not record who read it.
