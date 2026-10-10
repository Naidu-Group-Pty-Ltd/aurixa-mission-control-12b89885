# Audit: five pages on the CRM-independent line (10 Oct 2026)

**Question.** Are Clients, Client Tracker, CRM Conversations, Calendar and Call
Logs independent of GoHighLevel? Do they work as a closed system on the
CRM-independent head clone (`npc-crm-independent-6505dc`, Supabase
`qvuwrvwzjyigptmnijyb`)? And will clones born from that branch keep the same
rules through the membrane?

**Short answer.**

- **In the code as it stands, yes.** No page can send a request to
  GoHighLevel, and none of the GoHighLevel functions is deployed on the head.
- **There is one way to break it, and nothing stops it today.** A GoHighLevel
  key pair can land on an independent-line project, and the server treats its
  presence as a switch. Three routes can put it there: the clone's own
  Integrations page, Mission Control's per-clone secret forward, and a CRM
  conversion from the dependent line. The membrane withholds this line's
  functions, crons and files, but not its secrets.
- See H1 and H2. The fixes are proposed below, not made.

Owner decisions this raises are parked in `OPEN_QUESTIONS.md` as E1 to E6.

## Method

Everything below was measured, not read off documentation.

- **Browser.** For each page, the full import closure (every source file
  reached through `@/` and relative imports from the page). In each closure:
  every edge-function invocation, table read, RPC and URL, and every GoHighLevel
  mention. Each call to a withheld function was then traced to its guard.
- **Server.** For every edge function the pages reach, and then for all 383
  functions the head carries: the server-side import closure. Each was checked
  for calls to GoHighLevel's hosts and for calls to a withheld function by name.
  Every hit was read by hand.
- **Live state, on the head's own project.**
  - Deployed functions against the tree and the withheld list.
  - `cron.job` searched for GoHighLevel callers.
  - Every trigger on the tables these pages write.
  - Row counts of those tables, and whether any GoHighLevel lookup ever
    succeeded.
- **Membrane.**
  - The pages' 1,040 files compared byte-for-byte with the prime
    (`prime@772e5a0`), each difference classified against
    `CRM_LINE_VARIANT_PATTERNS`.
  - Mission Control's provisioning, conversion, backend sync, self-healing and
    secret-forward code read for line rules.
- **Repositories as read:** head `main@ad0ed8a`; Mission Control
  `main@da8da73`.

## Page by page

### 1. Clients — independent

- The page's closure is 960 files.
- It names three withheld functions: `import-clients-from-ghl`,
  `sync-client-to-ghl` and `sync-notes-to-ghl`.
- **No request can leave.** `invokeSecureFunction` answers each withheld name
  locally with `crm_function_not_carried`, before any network call
  (`src/lib/secureInvoke.ts:409`).
- **No control is drawn.** Each of these sits behind `ghlCarried` /
  `ghlAffordancesAvailable()`, which is false on this line:
  - auto-sync, "Import from GHL", "Sync all", "Clear & reimport";
  - the card's "Sync to GHL" and "View in GHL";
  - bulk "Sync to GHL", the import-time sync, and the add-client sync toggle.
- **One residue (low, F6).**
  - Saving or editing a note with "All" visibility still calls
    `sync-notes-to-ghl` (`ClientNotes.tsx`, `ActiveClientCard.tsx`). The call
    is fire-and-forget and refused locally, so nothing is sent and no error is
    shown.
  - The picker describes "All" as "Both portals and the CRM", which on this
    line promises a copy that never happens. The wording lives in
    `_shared/clients/noteWords.pure.ts`, a module shared with the prime.
- **Server:** `manage-client-data`, the page's data function, does not reach
  GoHighLevel.

### 2. Client Tracker — independent

- The closure is 64 files.
- **No request can leave.** `sync-ghl-pipelines` is refused locally.
- **No control is drawn.** Its auto-sync switch and "Sync pipelines" button are
  inside `ghlCarried &&`.
- The board reads this deployment's own `ghl_pipelines` /
  `ghl_pipeline_stages` tables.
- Pipelines are created natively (`NativePipelineCreator` →
  `manage-automation-settings`). The empty state says so instead of telling
  the user to sync.

### 3. CRM Conversations — independent, conditional on H1

- The closure is 43 files (the separate Messages page is 18), and neither names
  a withheld function.
- **Sending:** `crmFunction('sendMessage')` → `crm-send-message`, which writes
  this deployment's own `ghl_conversations` / `ghl_conversation_messages`.
  Inbound is `crm-inbound-message`.
- **Conditional on H1.** `crm-send-message` refuses with 409
  `crm_provider_mismatch` whenever the server resolves its provider as `ghl`.

### 4. Calendar — independent, conditional on H1, with one adjacent gap

- The closure is 86 files.
- **Data:** `useGHLCalendar` → `crmFunction('calendar')` → `crm-calendar`,
  native, reading this deployment's own appointments.
- **Outlook:** `outlook-calendar` is the tenant's own Microsoft calendar, not
  GoHighLevel.
- **Conditional on H1,** for the same reason as `crm-send-message`.
- **Adjacent gap (M1).** A client booking from the client portal goes through
  `portal-book-appointment` (`PortalBooking.tsx`, `PortalAppointments.tsx`).
  - That function has **no native path**: it reads slots from and books into
    GoHighLevel's calendar API, and needs the client's `ghl_contact_id`.
  - On this line, portal self-booking therefore cannot reach this Calendar at
    all.

### 5. Call Logs — browser clean, server not closed

- **Browser.** The closure is 114 files.
  - "Clean up contact names" (`CleanupContactNames`) is drawn only behind
    `ghlAffordancesAvailable()` (`CallLogs.tsx:596`), so it is not drawn here.
- **Server: `vapi-call-webhook` (H1).**
  - It is byte-identical to the prime's copy.
  - On every end-of-call report, it looks the caller up in GoHighLevel: first
    by a stored `ghl_contact_id`, then by phone. It does this whenever
    `GOHIGHLEVEL_API_KEY` (and the location id) are present, with no line check.
  - With a key present, a call to this deployment is matched against that
    GoHighLevel account, and the contact's name and id are written into this
    deployment's call log.
- **Server: `cleanup-call-log-names`** does the same in bulk. It is unreachable
  from the page, but deployed and callable.
- **Functional gap (M2).** Nothing matches a caller to this deployment's OWN
  clients. Neither the webhook nor `get-call-logs` reads `clients`. On this
  line, a caller's name comes only from Vapi's customer name or the AI
  summary, never from the native CRM.

## Cross-cutting findings

### H1 (high). A GoHighLevel key on an independent-line project is a switch

`_shared/crm/crmProvider.pure.ts` (`resolveCrmProviderFromEnv`) decides the
server's provider from the credentials whenever `CRM_PROVIDER` is not set:
`credentialled ? "ghl" : "native"`. It was written for the prime, where a
deployment must not lose its GoHighLevel identity by omission. On this line it
is wrong, because the line carries no GoHighLevel to switch to. With a key pair
present:

- `crm-calendar` and `crm-send-message` answer 409, so **Calendar and CRM
  Conversations stop working**.
- Six carried functions start calling GoHighLevel:
  - `vapi-call-webhook` and `cleanup-call-log-names` (Call Logs);
  - `portal-book-appointment`;
  - `finance-portal-client-comms`, `request-lead-magnet` and
    `manage-lead-magnets`.

**How a key can arrive.** Nothing refuses any of these today.

1. **The clone's own Integrations page.** It offers "GoHighLevel" and
   "GoHighLevel (Migration Account)" cards on this line.
   - The legacy card's `GHL_API_KEY` / `GHL_LOCATION_ID` fields alias onto
     `GOHIGHLEVEL_API_KEY` / `GOHIGHLEVEL_LOCATION_ID`
     (`registry.ts:1971`).
   - Every one of the names is on the server's integration allow-list
     (`_shared/integrationSecrets.ts:95-98`).
   - So a tenant admin who fills in that card breaks two of these pages.
2. **Mission Control's per-clone secret forward**
   (`cloneSecretForward.*`). It has no line check, so it will forward
   `GOHIGHLEVEL_*` to an independent clone if a row asks for it. (The fleet
   policy `prime_secret_forwards` deliberately excludes those names.)
3. **A CRM conversion from the dependent line.** `crmConversion.server.ts`
   neither deletes the clone's `GOHIGHLEVEL_*` secrets nor pins
   `CRM_PROVIDER=native`. A converted clone keeps its key, so it is a `ghl`
   deployment running the native code, and Calendar and Conversations refuse.

**State today on the head.**

- No calls are logged, no GoHighLevel usage row exists, and every CRM table is
  empty. So there is no evidence that a lookup has ever run.
- Whether the project holds a `GOHIGHLEVEL_*` secret right now is **not
  measured**: the tools available here cannot list a project's secret names.
  The module itself records that none was set on 19 Sep 2026.

### H2 (high, membrane). Secrets are not part of the line register

`crmLineFeatures.pure.ts` withholds this line's functions (deploy, sweep,
undeploy), crons and files (cascade holds), keyed on `crm_mode`. It names no
secrets. H1's three routes are all instances of that one omission.

### M1, M2

Above, under Calendar and Call Logs.

### Low

F6 above. Also, `notify_new_ghl_contact` on `clients` is a local
notification and dormant: it fires only for a client carrying a
`ghl_contact_id`, which nothing on this line sets.

## What was verified correct

| Check | Result |
|---|---|
| Withheld functions deployed on the head | **0 of 19**; deployed set (383) equals the tree |
| `cron.job` entries calling GoHighLevel or a withheld function | **0** |
| Triggers on the pages' tables making HTTP calls | **0** |
| Browser calls to a withheld function that can leave the browser | **0** (all refused locally, before a request) |
| GoHighLevel controls drawn on the five pages | **0** |
| Pages' files that differ from the prime and carry a GoHighLevel guard without a line-variant hold | **0** of 1,040. 13 differing files are held, 10 differ for reasons unrelated to the line (ordinary prime drift), 6 exist only on the line |
| A new clone on this line | Copied from the HEAD's repository, recorded as its child (`crmLineage`) |
| Cascades into a child | Read from the head; the line-variant holds apply only where bytes come from the prime, so children receive the head's copies |
| Backend provisioning and self-healing | Withhold this line's functions and crons by `crm_mode` |

**Not measured, recorded rather than assumed:**

- whether the head's project holds `GOHIGHLEVEL_*` secrets;
- whether any per-clone secret-forward row names them for an independent
  clone;
- whether any child of the independent head exists yet.

Mission Control's database is not reachable from here.

## Proposed fixes (not made; awaiting the owner)

| # | Where | Change |
|---|---|---|
| F1 | head, `_shared/crm/crmProvider.pure.ts` (already a line variant) | On this line the server is native whatever the environment holds. A present GoHighLevel pair is reported as an anomaly, never acted on. This closes H1's effect on Calendar and Conversations. |
| F2 | head, `vapi-call-webhook`, `cleanup-call-log-names` (made line variants) | No GoHighLevel lookup on this line. Match the caller to this deployment's own `clients` by phone (closes M2). |
| F3 | head, Integrations card registry and the integration-secret allow-list (made line variants) | Do not offer the GoHighLevel cards on this line, and refuse `GOHIGHLEVEL_*` at the server. |
| F4 | Mission Control | Add secrets to the line register. The per-clone forward refuses `GOHIGHLEVEL_*` for an independent clone. Conversion to the independent line deletes them and sets `CRM_PROVIDER=native`. The sweep reports any it finds. Closes H2. |
| F5 | head, `portal-book-appointment` (made a line variant) | A native path: slots and bookings from this deployment's own calendar, as `crm-calendar` reads them (closes M1). |
| F6 | prime, `noteWords.pure.ts`; head, the two note components | Line-neutral wording for "All", and drop the two dead `sync-notes-to-ghl` calls on this line. |

Every head file F2, F3 and F5 make a variant must also be added to
`CRM_LINE_VARIANT_PATTERNS` in Mission Control, in the same change. Otherwise
the next prime cascade puts the GoHighLevel copy back.
