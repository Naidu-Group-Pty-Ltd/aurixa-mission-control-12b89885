# Open questions, gaps and owner tasks

This file is the parking lot. Anything that needs the owner's decision, anything
ambiguous in an instruction, and any gap found while building is recorded here
rather than guessed at in code. Each entry says what is known, what is
recommended, and what it blocks. Entries are appended as work goes on. They are
resolved later, in their own change.

**How to read an entry.**

- **Status:** `open` (needs a decision), `answered` (the owner decided; not yet
  built), `parked` (known gap, deliberately deferred) or `done`.
- **Blocks:** what cannot happen until it is settled. "Nothing" means the
  system works without it and the entry is about doing it better.
- Dates are when the entry was written.

---

## A. Decisions the owner asked for a technical answer on

These two were raised on 10 Oct 2026 (`CLONE_VOICE_AUTOMATION.md` § Open
decisions). The owner asked for the technical answer and said **no code change
yet**. Nothing below has been built.

### A1. Gmail on the CRM-dependent line

- **Status:** answered technically, owner to choose; nothing built.
- **The difference between the lines.**
  - On the CRM-independent line the agents book through Make scenarios, and a
    Make notifier sends the confirmation. Gmail there is one more Make
    connection the notifier can route through. It is built.
  - On the CRM-dependent line the agents book into **GoHighLevel**: the
    `ghl_*` tools call Make scenarios that write a GHL appointment. GHL then
    sends confirmations itself, from the sub-account's own workflows and its
    own email service. There is no Make notifier on that line to bind a mailbox
    into.
- **Two ways to give the dependent line Gmail.**
  1. **Recommended: connect Gmail inside GoHighLevel.** A GHL sub-account can
     send through a connected Google Workspace / Gmail mailbox (GHL Settings →
     Email Services), and its appointment workflows then send from it. No
     Mission Control, Make or Vapi change. Confirmations stay where the
     dependent line keeps everything else, in GHL.
  2. **Add a Make notifier to the dependent stack.** Insert, after the GHL
     booking succeeds, the same notifier the independent line uses, with a
     `gmail` connection bound per clone. This reuses the connection flow
     (`clone_voice_automation_connections`, kind `gmail`) and the Gmail route
     builder (`voiceAutomationBlueprint.pure.ts`). It also means two systems
     can email the same customer about one booking (GHL's workflow and the
     notifier), so the GHL workflow would have to be switched off per tenant.
- **Recommendation:** option 1 for every dependent tenant. Option 2 only for a
  tenant who wants Aurixa to own the confirmation wording.
- **Blocks:** nothing. Dependent tenants keep whatever email GHL sends today.

### A2. A Make API key per clone

- **Status:** answered technically, owner to choose; nothing built.
- **What a Make token is.** A Make API token belongs to a Make USER, and
  reaches every team and scenario that user can reach, with the scopes it was
  minted with. Make has no token scoped to a scenario, a folder or a data
  store. So "one key per clone" can only mean one Make USER (or one team, or
  one organisation) per clone.
- **What is true today.** `MAKE_API_TOKEN` lives only on Mission Control. No
  clone holds any Make token, the prime's included. A clone's change travels
  as a request that Mission Control applies (`CLONE_VOICE_AUTOMATION.md`). So
  "a clone must not share the prime's Make key" already holds in the strong
  sense: no clone shares any key. The residual risk is concentration: one
  token on Mission Control reaches every tenant's stack.
- **Three options.**
  1. **One Aurixa team, one token on Mission Control (today).** Each clone's
     stack lives in its own folder in team 2731020. Isolation is enforced by
     Mission Control, which only ever writes the ids recorded for that clone.
     Cheapest; one blast radius.
  2. **One Make team per clone, one token per team.** A Make user who is a
     member of that team alone mints the token, so it cannot reach another
     tenant. Mission Control holds N tokens, one per stack. The stack tables
     already record the zone and team per clone (`clone_voice_automation`,
     and `clone_voice_stacks` from this build), so option 2 is a credential
     lookup by team, not a schema change. Costs one Make seat per team on
     Make's pricing.
  3. **One Make organisation per clone.** Separate billing and operations
     quota per tenant. Only worth it if a tenant is to pay Make directly or
     needs to log in to Make.
- **Recommendation:** stay on option 1 while every stack is operated by
  Aurixa. Move a tenant to option 2 when they need contractual isolation or
  their own access to Make. Option 3 only if Make billing must be per tenant.
- **Blocks:** nothing technical. Ops consumption per tenant is unmetered
  either way (gap C6).

---

## B. Ambiguities in instructions (my reading, to confirm)

### B1. "The Resend email designated to them during clone provisioning"

- **Status:** open (a default is built).
- Provisioning designates a **sending domain** per clone,
  `send.<clone-host>` (`CLONE_EMAIL_IDENTITY.md`), and a from address,
  `notifications@send.<clone-host>`. It does not designate a mailbox that can
  RECEIVE mail, and a Vapi signup needs one: Vapi emails a verification link
  or code to the address.
- **Built default:** the clone's Vapi login is `voice-agents@send.<clone-host>`.
  Mission Control turns on Resend **receiving** for that clone's sending domain
  (`capabilities.receiving`), installs the receiving MX record where it manages
  DNS, and reads the mail through Resend's received-email API. The local part
  is distinct from `notifications@` so Vapi's mail is never mixed with the
  notifications address.
- **To confirm:** whether the owner wants a different local part, or a
  different domain (for example the clone's root domain).

### B2. "They won't get access to their Vapi org"

- **Status:** open (the strict reading is built).
- **Built:** the tenant never sees the login, the password or the private
  key. Mission Control holds all three, encrypted. Showing the password is an
  admin act, audited each time.
- **What is not decided:** whether the clone's OWN backend may hold its org's
  private key (`VAPI_API_KEY` on the clone's Supabase project). Mission
  Control's rule is "brokering is decided by scope, not spend". A per-clone
  org's key reaches only that clone's own assistants, so forwarding it would
  not cross tenants. Forwarding it would let the clone's Call Logs page show
  agent names and re-sign recordings. **Built:** the key stays on Mission
  Control only. **To confirm:** whether the clone's backend may hold it.

### B3. "Login access to every clone-specific Vapi org on MC"

- **Status:** open.
- Vapi has **no public API to create an account or an organisation**.
  - Vapi's OpenAPI document declares `CreateOrgDTO` and `CreateTokenDTO` but
    publishes no `/org` or `/token` route.
  - Vapi's own support threads say organisations are created in the dashboard
    only.
  - The dashboard signs people in through WorkOS, which a third party cannot
    call without Vapi's own WorkOS key.
- **Built:**
  - Mission Control mints and holds the login (email + password).
  - It shows the operator the clone's inbox, with the verification code or link
    pulled out of Vapi's email.
  - It takes the org id and the private key once an operator has signed up and
    created the org, and verifies the key with a real read.
  - Everything after that is automatic.
- **To confirm:** that a guided one-time signup per clone is acceptable.
  - The alternative is a headless-browser signup. That is fragile (captcha,
    WorkOS bot checks) and may breach Vapi's terms.
  - Asking Vapi for an enterprise or partner arrangement with sub-org
    provisioning is the clean fix, and is an owner/commercial step.

---

## C. Gaps found while building (parked)

### C1. The CRM-dependent booking template is broken at its source

- **Status:** parked; blocks dependent-line booking for every clone.
- **The broken scenario.** The NPC CRM-dependent booking scenario is 5978179,
  "Vapi - GHL Booking Appointment Intent Router - Generic HTTP PIT - IMPORT
  SAFE".
  - It is what Vapi tool `ghl_create_booking` (`7d6b6d41`) calls.
  - It carries the placeholder `{{SECRET:GHL_PIT_TOKEN_BOOKING}}` where a GHL
    private-integration token belongs.
  - On 9 Oct 2026 it showed 9 runs, all errored.
- **What cloning does with it.** The cloner refuses to put a credential into a
  blueprint as text. So it binds a `{{SECRET:…}}` placeholder only where the
  template scenario reads the stack's CFG record, and holds the scenario
  otherwise (`secret_placeholder_without_cfg_reader`).
- **Fix:** give the dependent booking template a CFG reader, the way every
  independent scenario reads `adapter_secret`. That is a change to the
  dependent line's template, so it is the owner's call: the original must not
  be edited. The fix is a new template scenario.

### C2. The dependent line has no working cancel or reschedule

- **Status:** parked.
- The five NPC "Delete … Session" scenarios are inactive and marked invalid,
  and every run errored. They only ever emailed the admin. The independent
  line has a real find / cancel / reschedule tool. The dependent template
  therefore carries no cancel tool: a dependent clone's agents send cancel
  requests to a human, as NPC's do today.

### C3. Transfer to a human needs telephony per tenant

- **Status:** parked (Twilio deferred by the owner).
- Both lines' agents use `transfer_to_human` (`bf4b9260`), which reaches Make
  scenario 6279259 and data store 150577. Both are shared with NPC's
  production and redirect a Twilio call. A clone's transfer needs its own
  number and its own call-tracking store. Until Twilio is in scope, a clone's
  stack carries no transfer tool, and its prompts' transfer instruction is
  flagged for review.

### C4. Template prompts speak as NPC

- **Status:** open.
- The template assistants' prompts and first messages name Naidu Property
  Consulting (NPC), its staff personas and its offers. Copying them into a
  tenant's org would have the tenant's agents introduce themselves as NPC.
- **Built:** every template carries a deny-list of the source business's
  words. A clone's assistants are refused while any of those words remains.
  The operator supplies the replacements per clone (business name, website,
  phone). The alternative is to let the Voice Cloning Studio write the
  tenant's prompts.
- **To decide:** whether tenant prompts come from a substitution table (fast,
  same script) or from a Voice Studio plan (slower, written for the tenant).

### C5. Knowledge-base files are per org

- **Status:** handled in the build, recorded here.
- Several template assistants carry knowledge-base files. Vapi file ids belong
  to one org, so each file is downloaded from the template org and uploaded
  into the clone's org, and the assistant is pointed at the new id. A file
  that cannot be read holds that assistant rather than shipping it without its
  knowledge.

### C6. Per-tenant usage is not metered

- **Status:** parked.
- Make operations and the independent line's availability classifier (Make
  OpenAI connection 10496826, Aurixa's account) are spent by every cloned
  stack on Aurixa's accounts. Nothing records which tenant spent what.
- Vapi minutes are per org, so they are naturally per tenant once each clone
  has its own org. Who pays that org's Vapi bill is in D.
- Make's plan is Core (org 8699071). Its monthly operations are shared by
  every stack.

### C7. Vapi billing per clone org

- **Status:** open.
- Every new Vapi org needs a payment method or credits before it can place a
  call. Whether Aurixa pays and recharges the tenant, or the tenant pays Vapi,
  is a commercial decision. **Built:** the stack can be provisioned into an
  org with no credit. Calls simply fail until the org is funded, and the card
  says so.

### C8. The independent line's head agents live in Aurixa's org

- **Status:** open.
- The NPC CRM Independent clone heads the independent line. Its 13 agents,
  tools and squad were built in Aurixa's own Vapi org B on 9 Oct 2026, before
  per-clone orgs existed. Under the new rule that clone should have its own
  org too.
- Moving them is a re-provision of the head into its own org, and it gives
  every template object a new id. The template does not follow by itself:
  - Every template read (tools, assistants, squad, knowledge files) is made
    with Mission Control's own `VAPI_API_KEY`, which is org B's key. The
    manifest does NOT record which org its ids belong to (gap C15).
  - So moving the head means a new manifest version carrying the new ids, and
    a template reader keyed on the head's own custody key instead of
    `VAPI_API_KEY`. Until then, a moved head reads as "template tool … does not
    exist" at discovery: loud, never silent.
- **To decide:** when to move the head. Its Call Logs credential (`49187eb8`)
  would be re-created in the new org.

### C9. Post-call report scenarios are not cloned on either line

- **Status:** parked (was HANDOFF Q23).
- NPC's post-call scenarios (5978462, 5978440) read GHL data. Neither line's
  cloned stack carries a post-call report. Calls still land on the clone's Call
  Logs page through `vapi-call-webhook`.

### C10. Resend's receiving MX record is read at run time

- **Status:** handled in the build, recorded here.
- Resend documents a `capabilities.receiving` switch on a domain. It does not
  document the receiving MX value: the dashboard shows it after the switch.
  The build reads whatever MX records Resend lists for the domain after
  receiving is on, and installs any it does not already hold through the same
  DNS path the sending records use. If Resend lists none, the inbox step stays
  open and says so; it is never marked done on a guess.

### C11. Make's answer to switching on a scenario with an unbound connection

- **Status:** parked; recorded so the behaviour is not mistaken for a fault.
- An independent stack's adapter and notifier use the tenant's calendar and
  mailbox. Those connections are the tenant's to make, through voice
  automation, so a freshly built stack has them unbound.
- What Make answers when asked to switch such a scenario on has not been
  measured. **Built:** for a scenario whose only unbound connections are voice
  automation's, ANY refusal to switch on is read as "waiting for the tenant to
  connect", re-asked every five minutes, with Make's own words in the step's
  detail. It is never counted as a failed attempt.
- **Risk:** a refusal for some other reason on such a scenario reads as waiting
  rather than failed. The detail shows Make's message, so an operator can tell.
- **To do:** measure Make's refusal on the first real clone and narrow the
  reading to that error.

### C12. The tenant can break their own call-log pairing

- **Status:** open.
- The stack mints one secret and writes it to both halves: the clone's
  `VAPI_WEBHOOK_SECRET` and a Vapi credential in the clone's org.
- The clone's own Integrations page lets the tenant overwrite
  `VAPI_WEBHOOK_SECRET`. If they do, every call log is refused and
  `webhook_rejections` on the clone says so. Nothing on Mission Control
  notices.
- **Options:**
  1. Withhold the name from the clone's Integrations page once a stack owns it.
  2. Have the drain re-assert the value. That overwrites a tenant's deliberate
     change, so it is not built.

### C13. The tools keep the template's function names

- **Status:** parked (cosmetic).
- A tool's function name (`npc_ci_check_availability`) is what the model calls,
  and the prompts name it. Renaming it would mean rewriting every prompt that
  mentions it. So a tenant's org carries tools whose function names start with
  `npc_ci_` or `ghl_`. The tenant cannot see the org (B2), and callers never
  hear function names.

### C14. Assistant names are cut to fit Vapi's 40 characters

- **Status:** handled in the build, recorded here.
- Vapi refuses an assistant name over 40 characters. A clone's assistants are
  named `<label> <role>`, with the label cut to 16 characters at a word
  boundary, and a numeric suffix where two names would collide. A long business
  name therefore appears shortened in the clone's Vapi org. Callers never hear
  the name.

### C15. The template's Vapi org is implicit

- **Status:** parked; part of C8.
- Template reads use Mission Control's `VAPI_API_KEY`, and the manifest does
  not record the org its ids belong to. Both seeded templates are in that org
  today, so this works. It stops working the day either line's head moves to
  its own org (C8). The remedy is a manifest field naming the template's org,
  and a reader that uses the head's custody key when that org is not
  Aurixa's.

### C16. Where a dependent clone's GoHighLevel key actually reaches

- **Status:** open; the owner's instruction is met in part, and this says
  exactly which part.
- **The instruction.** A dependent clone must ALWAYS require GoHighLevel API
  keys, and its Make scenarios must run on them.
- **Built:**
  - A private-integration token and a location id are required before a
    dependent stack can be built.
  - They are verified against GoHighLevel and stored encrypted.
  - The stack writes them into its CFG record wherever the template declares
    `ghlFields`, and a scenario's `{{SECRET:…}}` placeholder is bound to that
    record.
- **What that reaches today: nothing.** The dependent template has no CFG
  record (`cfg: null`, gap C1). So no cloned dependent scenario reads the key
  yet, and the booking scenario is held for exactly that reason.
- **Make's own GoHighLevel modules do not take a pasted key.** The contact
  lookup scenario (5978434) uses them, and they take a Make connection: either
  the `highlevel3` app's OAuth for one location, or the deprecated `highlevel`
  app. As far as Make's app records show, the deprecated app takes GHL's older
  API key, not a private-integration token (to confirm).
  - **Built:** those modules are bound through a Make credential request the
    tenant authorises.
  - Mission Control refuses a grant whose location is not the verified key's
    location.
- **Recommended:** rebuild the dependent template so every GoHighLevel call is
  an HTTP module that reads the token from the stack's CFG record, as the
  "Generic HTTP PIT" scenarios already do.
  - The key alone then runs the whole line, with no OAuth grant.
  - It is the same template change C1 needs, so it is one piece of work.
  - It is the owner's call because it means a new template, never an edit of
    NPC's originals.

### C17. Nothing decides WHICH clones get voice agents

- **Status:** open; needs an owner decision. Live since Mission Control was
  published on 11 Oct 2026 (F0): the 5-minute drain now runs.
- The drain opens a stack row for every clone that has a CRM line recorded,
  line heads aside. Any such clone is then built once its Vapi org is active
  and its requirements are met. That includes test and preflight clones.
- Nothing ties a build to a purchase. The `voice-agents` add-on (D11) is not
  read anywhere in the stack builder.
- In practice, the manual Vapi sign-up (D15) is the only gate today: a clone
  nobody signs up for is never built. Its card simply reads "Waiting on
  requirements".
- **To decide:** whether a stack should be built only for clones that bought
  the voice-agents add-on (or a plan that includes it). If so, the gate is
  one more block in `judgeStackProvision`.

### C18. Clones that already exist do not start custody on their own

- **Status:** recorded; needs an operator action per clone.
- Custody starts automatically when a NEW clone's deployment reaches its
  email identity (`startVapiCustodyIfDue` in the deployment drain).
- Clones deployed before this change have no custody row, so the drain has
  nothing to carry forward for them. An operator starts each one with
  **Advance** on the clone's Voice stack card.
- **To decide:** whether to backfill custody for every existing clone that
  has a verified sending domain, or start them one by one as each is sold
  voice agents (ties to C17).

### C19. The dependent template is NPC's live production stack

- **Status:** open; confirm.
- The dependent seed names NPC's own production GoHighLevel scenarios
  (5978159, 5978179, 5978434, 5978425, 5978051), its hooks, its store 133627,
  its 13 agents and squad `13c37e4c` in org B.
- Every dependent clone would be copied from what NPC itself runs today.
  Nothing NPC runs is ever edited, but a change NPC makes to its own agents
  reaches the next dependent clone built.
- The independent line instead copies a dedicated head clone (NPC CRM
  Independent). Its agents were built for that purpose.
- **To confirm:** that the dependent template should be NPC's live stack, or
  build a dedicated dependent template (it would also fix C1 and C16).

### C20. Switching the dependent template on is a database edit

- **Status:** recorded.
- `voice_stack_templates.enabled` for the dependent line is `false`, with
  C1's reason, and no screen changes it. Once the template change in
  C1/C16/C19 is made, enabling it is an update of that row (and a new
  manifest if the ids change). Done by a migration, so it is reviewed.

### C21. Watch the CRM-independent cascade (#104) after the membrane fix

- **Status:** done (10 Oct 2026); the watch found a defect, fixed.
- #104 was refreshed to prime@22e04d8 at 21:04 and went red on `security`
  (`missing policy: log_client_activity`) and on the agent specs. #322's
  three-way merge of held variants never ran on the file that mattered:
  `MAX_VARIANT_MERGES` was 12 and held paths were taken in list order. #104
  held 26, and `ai-dashboard-agent/index.ts` was 22nd.
- **Fixed:** the cap is 32 (`variantMerge.pure.ts`), and held paths are
  offered most consequential first (`orderVariantMergeCandidates`: Edge
  Function entrypoints, then source, then workflows, scripts and docs).
- #104 itself was landed by hand on the head (head PR #108): the agent
  three-way merged cleanly, and three agent specs took prime's copies.
- **The watch then found a second fault (10 Oct, 22:57 UTC).** #104 was
  refreshed to prime@4b9ae04 by a Mission Control whose published app still
  predated #324, so it held none of the line's variant patterns. It wrote the
  prime's GoHighLevel copies over nine of the line's own files (Call Logs,
  portal booking, Integrations, the note wording, the lead-magnet pipelines,
  the client card). The line's guard tests failed `verify`, so it never
  merged. Head PR #109 landed it by hand: the nine line copies kept, the
  prime's CA-3 calendar-id rule ported into the native booking, and the agent
  three-way merged again. #104 closed as merged with it (11 Oct, 00:43 UTC).
- **What keeps it from recurring:** the published Mission Control now carries
  the variant patterns (F0), and MC #326 holds the line's own copy of
  `portal-book-appointment/calendar-id-refusal.test.ts`, because the prime's
  version asserts GoHighLevel calls.

---

## E. From the audit of the five CRM-independent pages (10 Oct 2026)

Full findings and evidence: [`audits/2026-10-10-crm-independent-pages.md`](./audits/2026-10-10-crm-independent-pages.md).
The owner approved all six fixes on 10 Oct 2026 and they were made the same
day (head `npc-crm-independent-6505dc` and Mission Control). E1 to E6 are kept
as a record. E7 to E11 are what checking the fixes went live found.

### E1. A GoHighLevel key on an independent-line project flips the server

- **Status:** resolved by F1 (head) and F3/F4 (the three routes).
- The head's server now answers `native` whatever its environment holds, and
  reports a GoHighLevel pair as a secret to remove. The Integrations page,
  Mission Control's per-clone forward and a conversion into the line all
  refuse or remove the credentials.

### E2. The membrane does not cover secrets

- **Status:** resolved by F4.
- `CRM_LINE_WITHHELD_SECRETS` in `crmLineFeatures.pure.ts` is asked by every
  route that writes a vendor credential onto a clone. The fleet sweep removes
  any it finds on an independent project and stamps it `withheld`.

### E3. Call logs never match a caller to the deployment's own clients

- **Status:** resolved by F2. A caller is matched among the deployment's own
  clients by phone; a number two clients share names nobody.

### E4. Client-portal self-booking has no native path

- **Status:** resolved by F5. The portal books into the native calendar under
  the staff Calendar's own rules, only into a calendar the portal offers.

### E5. The note "All" wording promises a CRM copy

- **Status:** resolved by F6, as a line variant of `noteWords.pure.ts` rather
  than a prime change (the prime's wording is true on the prime). Saving or
  editing a note no longer calls `sync-notes-to-ghl` on this line.

### E6. Three things the audit could not measure from here

- **Status:** the first two no longer need a person. The fleet sweep removes
  a GoHighLevel credential from an independent project on its next pass and
  reports it in `removed`; a per-clone forward row naming one is refused with
  the line's reason. The third (whether a child of the head exists) stays
  open and changes nothing here: a child inherits every fix from the head.

### E7. What the fixes leave

- **Status:** done (10 Oct 2026, head PR #108).
- `manage-lead-magnets` `list_pipelines` answers with the Client Tracker's
  own pipelines on this line (`nativePipelineChoices.pure.ts`), so a lead
  magnet can route a lead onto this CRM's board.
- The client card's note delete asks GoHighLevel only about a note copied
  there (`ghl_note_id`), so it makes no call on this line.
- Both files are held as line variants. Every carried function that can
  still reach GoHighLevel now takes its native branch on this line
  (`ghlReachRatchet.test.ts` on the head).

### E8. The line's own functions never reached its project

- **Status:** done (10 Oct 2026); found while checking that the fixes went
  live.
- Mission Control's rolling `edge_function_deploy` lane builds every
  function the prime declares from the PRIME's repository. So a function the
  independent line keeps in its own shape was held in the repository and
  overwritten on the project. Measured on `qvuwrvwzjyigptmnijyb`: the live
  `manage-automation-settings` was the prime's copy, with no
  `createPipeline`, so the Client Tracker could not create a pipeline. The
  same was true of `vapi-call-webhook`, `portal-book-appointment`,
  `request-lead-magnet` and the rest. Only the clone-owned `crm-*` functions
  came from the clone.
- **Fixed:** `crmLineVariantFunctionNames` derives the line's own functions
  from the variant patterns (13 on the independent line). The clone-owned
  lane deploys them from the clone's tree, the prime-tree lane and
  provisioning skip them, and a conversion off the line restores the prime's
  copies.
- **How it goes live:** after this merges and Mission Control redeploys, the
  next `backend-catchup` tick (`:20` and `:50` past the hour) sees the
  owned set change and deploys all 14 from the head's tree. Verify on the
  project that `manage-automation-settings` contains `createPipeline`.
- **Not live yet (measured 10 Oct 2026, 23:28 UTC):** #325 and head #108 are
  merged, and the `backend-catchup` tick at 23:21 redeployed only the four
  clone-owned `crm-*` / `voice-automation-settings` functions. The 13 line
  variants were not touched, and `manage-lead-magnets` was overwritten with
  the prime's copy again at 22:41 by the per-function lane. The reason is that
  **the published Mission Control app is behind `main`**: the
  `/hooks/voice-stack-drain` route #323 added answers 404 on
  `mission-control.aurixasystems.com.au`, while `/hooks/deployment-drain`
  answers 401. So #323, #324 and #325 are merged and not running. See F0.
- **Live (measured 11 Oct 2026, 00:51–00:52 UTC).** Mission Control was
  published, `/hooks/voice-stack-drain` answers 401, and the `backend-catchup`
  tick at 00:50 redeployed all 14 of the line's own functions from the head's
  `main` (b4c4dee). Each deployed bundle was read back from the project and
  compared file by file with the head's tree: every file of every function is
  byte-identical (ai-dashboard-agent v1320, 153 files; cleanup-call-log-names
  v1266; crm-calendar, crm-inbound-message and crm-send-message v28;
  finance-portal-client-comms and finance-portal-client-data v1242;
  manage-automation-settings v1223, with `createPipeline`;
  manage-lead-magnets v1222; portal-book-appointment v1210;
  request-lead-magnet v1206; update-integration-secret v1201;
  vapi-call-webhook v1200; voice-automation-settings v5). None logged a boot
  error.

### E9. The head's `aml` schema was not exposed to the API

- **Status:** fixed and verified (11 Oct 2026). The processor answered 200 at
  01:19 UTC, its first success on this project.
- Found in the head's logs while checking E8: `aml-verification-processor`
  answered 500 `Invalid schema: aml` on every one of its 1,440 runs a day, and
  `aml-idv-retention` failed the same way. The `aml` schema exists on
  `qvuwrvwzjyigptmnijyb` with all 113 tables, but the project's exposed-schema
  list did not name it. This is the fault `projectSettingsParity.pure.ts`
  describes; `replicateApiConfig` fixes it for a NEW clone, and this head was
  provisioned before that.
- **Fixed:** the head's `authenticator` role now carries
  `pgrst.db_schemas = public, graphql_public, aml`, exactly the prime's value.
  It took two steps, and the second is easy to miss:
  - **The setting** was written at 00:56. PostgREST took it up on its own
    schedule, about 15 minutes later. The error then changed to
    `Could not find the table 'aml.verification_checks' in the schema cache`,
    although the table exists.
  - **A schema-cache reload** (`NOTIFY pgrst, 'reload schema'`) at 01:18 then
    let the processor answer 200 from the next run. A config reload alone
    adds the schema but leaves the cache without its tables.
  Exposure grants nothing new: on both projects only `service_role` holds
  USAGE on `aml`, and `anon` and `authenticated` do not.
- **Not checked here:** other clones. Mission Control's parity report marks a
  missing exposed schema as blocking for every clone. The same two steps fix
  each one.
- **The line's functions stayed put.** At 01:17 UTC the 14 line functions
  were still at their 00:51–00:52 versions, while the prime's per-function
  lane went on deploying `market-*` functions around them. So that lane now
  leaves the line's own functions alone, as #325 intended.

### E10. The head runs an old copy of `finance-portal-briefing-runner`

- **Status:** recorded; no action needed. It fixes itself.
- It answered 500 twice on 10 Oct: `ReferenceError: verifyRequiredCronSecret
  is not defined`. The deployed copy is from 9 Oct, 23:51 UTC. The prime fixed
  the function on 10 Oct, 11:51 UTC (61c8dc94), and the head's tree carries the
  fix. It is a prime-lane function, so it arrives when the rolling
  `edge_function_deploy` lane reaches it (about 2.3 bundles every 8 minutes,
  stalest first). Until then the runner fails twice a day.

### E11. What the line keeps differently from the prime, after #109

- **Status:** recorded; each item is deliberate.
- **The agent's `create_client`** sends Add Client's request with no
  GoHighLevel sync and no pipeline stage, because this line's Add Client has
  neither. The shared reader (`clientRecordAsk.pure.ts`) defaults the sync on,
  so the line turns it off and refuses a named stage
  (`agentCreateClient.test.ts`).
- **Portal booking** refuses a malformed calendar id first, as the prime does
  (CA-3), and then books natively. The line carries its own version of the
  prime's refusal test.
- **Specs not carried:**
  - `clients.spec.tsx`: it imports `parityRegister.ts`, which this line does
    not carry, and it asserts the GoHighLevel sync;
  - `serviceRoleWrites.spec.ts`: never in the line's scope.
- **Twelve agent specs are the line's own.** `borrowingCapacitySave`,
  `comparisonAsk`, `distribution`, `financeShare`, `marketIntelligence`,
  `namedOnTheCard`, `playbookAndSchedule`, `portalPublication`,
  `portfolioAnalysis`, `portfolioSend`, `subReports` and `templateChoice`
  match no version the prime held. The cascade holds them, and a prime change
  to any of them is reconciled by hand. All pass on the head today.
- **The edge typecheck baseline** is the prime's, so it still allows the
  prime's counts on `portal-book-appointment` (3) and `vapi-call-webhook` (9).
  The line's copies have 0 and 8. The gate passes; it is only looser than it
  needs to be on those two files. Holding the baseline as a variant would
  block the prime's own baseline updates, so it is not held.

---

## D. Tasks waiting on the owner

Carried from earlier work. Each one is also recorded where it was found.

| # | Task | Where it is recorded |
|---|---|---|
| D1 | Set `MAKE_API_TOKEN` on Mission Control: a Make API token on team 2731020 with scopes `scenarios:read/write`, `datastores:read/write`, `connections:read/write`, `credential-requests:read/write`, `hooks:read/write` (a new stack reuses the template's data structures, so no data-structures scope). Until then voice-automation applies and stack provisioning are blocked, and say so. | `CLONE_VOICE_AUTOMATION.md`, `CLONE_VOICE_STACKS.md` |
| D2 | Set one secret value in both halves for the NPC CRM Independent clone's call logs (still missing on 11 Oct: the clone's last refusal reads `secret_not_configured`): the clone's Integrations → Vapi → Webhook Secret, and the token of Vapi credential "NPC CRM Independent call logs" (`49187eb8`) in org B. New clones provisioned by this build get both halves minted automatically. | clone repo `docs/integrations/VOICE_AGENT_CALL_LOGS.md` |
| D3 | Choose between the A1 options (Gmail on the dependent line). | A1 |
| D4 | Choose between the A2 options (per-clone Make key). | A2 |
| D5 | Test the CI squad with Talk in the Vapi dashboard (org B, squad "NPC CI Sales Force"). | clone repo `voice-agents/crm-independent/HANDOFF.md` §00.6 |
| D6 | Check the `property@npcservices.com.au` inbox for the 9 Oct test mails and their `.ics` files. | HANDOFF §00.6 |
| D7 | Authorise Make credential request `98f5f77d` with the calendar that should hold NPC CI bookings. | HANDOFF §00.6 |
| D8 | Go-live for NPC CI: clear `email_redirect_to`, rotate `adapter_secret` (it appeared in a transcript), delete the old Vapi proxy (scenario 6560898, hook 2910906) and the gated proxy (scenario 6571056, hook 2914419, store 168760, structure 529586). | HANDOFF §00.6 |
| D9 | Rotate the Vapi private key written in plain text in inactive scenario 5978090. | HANDOFF §04 row 7 |
| D10 | Check credits on Make OpenAI connection 10496826, which the availability classifier uses on every independent stack. | HANDOFF §04 row 10 |
| D11 | Publish the `voice-agents` add-on catalog row, so a signed agreement opens a Voice Studio project. | `voice-cloning/README.md` § Provisioning |
| D12 | Make sure `RESEND_MASTER_API_KEY` and `CREDENTIALS_ENC_KEY` are set on Mission Control. Per-clone Vapi custody needs both: the inbox reads through the first, and the login and key are stored encrypted with the second. | `CLONE_VOICE_STACKS.md` |
| D13 | Twilio numbers per clone, the outbound launcher (HANDOFF Q20) and post-call reports (Q23). Deferred by the owner. | C3, C9 |
| D14 | Decide B1 to B3 and C4, C7 and C8. | above |
| D15 | For each clone that gets voice agents: sign up its Vapi org once from the clone card's guided steps (Mission Control shows the login and reads Vapi's verification mail), create the org, and paste the org id and private key. Everything after that is automatic. | `CLONE_VOICE_STACKS.md` § Operator steps |
| D16 | For each CRM-dependent clone: enter the tenant's GoHighLevel private-integration token and location id on the clone card, then send the tenant the GoHighLevel authorisation link it produces. | `CLONE_VOICE_STACKS.md`, C16 |
| D17 | For each clone: enter the tenant's business name, website and phone replacements on the clone card, so no NPC wording reaches their agents (C4). | `CLONE_VOICE_STACKS.md` |
| D18 | Decide C12 and C16. | above |
| D19 | Decide C17 to C19 (which clones get voice agents; existing clones' custody; the dependent template's source). | above |
| D20 | ~~After the next cascade into the CRM-independent clone, check it carried held files cleanly~~ Done 11 Oct 2026: it had not, and head #109 landed it (C21). | C21 |
| D21 | ~~Decide E1 to E5~~ Done 10 Oct 2026: all six fixes approved and made. | E |
| D22 | ~~Check E6~~ No longer needed: the fleet sweep removes and reports any GoHighLevel credential on an independent project. | E6 |
| D23 | ~~Decide E7~~ Done 10 Oct 2026 (head #108). | E7 |
| D24 | ~~Publish Mission Control~~ Done 11 Oct 2026 (F0). | E8 |

---

## F. What only the owner can do (consolidated 10 Oct 2026)

Everything above that needs a person, in one list and in priority order.
Nothing here can be done from a session: each needs a login, a credential
nobody else may see, money, or a decision. "Unblocks" says what starts
working when it is done.

### Do first: things that are broken or exposed today

| # | Action | Where | Unblocks | Ref |
|---|---|---|---|---|
| F0 | ~~**Publish Mission Control**~~ Done 11 Oct 2026. The line's 14 own functions are live from the head's tree (E8), the line secret refusals are live, and the voice-stack drain runs. | Lovable | — | E8 |
| F1 | Rotate the Vapi private key written in plain text in inactive Make scenario 5978090, then delete it from the scenario. Never paste it anywhere. | Vapi dashboard → API keys; Make → scenario 5978090 | Closes a live credential exposure | D9 |
| F2 | Rotate `adapter_secret` on CFG record 168061 (it appeared in a transcript), then store the new value only in the record. | Make → data store 168061, record `cfg`, field `adapter_secret` | Closes a credential exposure | D8 |
| F3 | Set ONE value in BOTH halves of the NPC CRM Independent call-log pairing (measured 11 Oct: the clone's half is still unset, `webhook_rejections` reads `secret_not_configured`, last seen 10 Oct 16:27 UTC): the clone's Integrations → Vapi → Webhook Secret, and the token of Vapi credential "NPC CRM Independent call logs" (`49187eb8`) in org B. Until they match, every call is refused and `webhook_rejections` says which half is missing. | Clone dashboard Integrations page; Vapi dashboard org B → Credentials | Calls landing on the clone's Call Logs | D2 |
| F4 | Set `MAKE_API_TOKEN` on Mission Control: a Make API token on team 2731020 with `scenarios`, `datastores`, `connections`, `credential-requests` and `hooks`, read and write. | Mission Control hosting env vars | Voice-automation applies; every clone voice stack build | D1 |
| F5 | Make sure `RESEND_MASTER_API_KEY` is set on Mission Control. `CREDENTIALS_ENC_KEY` is set (measured 11 Oct: `/api/health` reports `credential_encryption: ok`). | Mission Control hosting env vars | Per-clone Vapi custody (inbox + encrypted login) | D12 |

### Then: go-live of the NPC CRM Independent voice agents

| # | Action | Where | Ref |
|---|---|---|---|
| F6 | Authorise Make credential request `98f5f77d` with the calendar that should hold NPC CI bookings. | The link Make emails / Make → Credential requests | D7 |
| F7 | Test the CI squad with Talk (org B, squad "NPC CI Sales Force"), and check `property@npcservices.com.au` for the 9 Oct test mails and their `.ics` files. | Vapi dashboard; the mailbox | D5, D6 |
| F8 | When satisfied: clear `email_redirect_to` on CFG 168061 (this is the go-live switch; until then every customer mail goes to `property@npcservices.com.au`), and delete the old Vapi proxy (scenario 6560898, hook 2910906) and the gated proxy (scenario 6571056, hook 2914419, store 168760, structure 529586). | Make | D8 |
| F9 | Check credits on Make OpenAI connection 10496826 (the availability classifier on every independent stack). | OpenAI billing for that key | D10 |

### Per clone, when a clone is sold voice agents

| # | Action | Ref |
|---|---|---|
| F10 | Sign the clone's Vapi org up once from the clone card's guided steps (Mission Control shows the login and reads Vapi's verification mail), create the org, and paste the org id and private key. | D15, B3 |
| F11 | Fund that Vapi org (payment method or credits), or decide who pays. | C7 |
| F12 | CRM-dependent clones: enter the tenant's GoHighLevel private-integration token and location id on the clone card, and send the tenant the authorisation link it produces. | D16, C16 |
| F13 | Enter the tenant's business name, website and phone replacements on the clone card, so no NPC wording reaches their agents. | D17, C4 |
| F14 | For a clone that existed before custody: press **Advance** on its Voice stack card. | C18 |

### Decisions (nothing is built until you answer)

| # | Decide | Ref |
|---|---|---|
| F15 | Gmail on the dependent line: connect Gmail inside GoHighLevel (recommended) or add a Make notifier. | A1 / D3 |
| F16 | A Make key per clone: stay on one Aurixa team (recommended for now), one team per clone, or one organisation per clone. | A2 / D4 |
| F17 | Confirm the Vapi login address (`voice-agents@send.<clone-host>`), whether a clone's backend may hold its own org's Vapi key, and that a guided one-time Vapi signup per clone is acceptable. | B1–B3 |
| F18 | Tenant prompts: a substitution table (built) or a Voice Studio plan per tenant. | C4 |
| F19 | When to move the independent head's agents out of Aurixa's org B into their own org (needs a new template manifest). | C8, C15 |
| F20 | Whether a tenant may change its own `VAPI_WEBHOOK_SECRET` once a stack owns it (if not, it is withheld from their Integrations page). | C12 |
| F21 | Which clones get voice agents (only those that bought the add-on?), and whether to back-fill custody for existing clones. | C17, C18 |
| F22 | The CRM-dependent template: build a dedicated dependent template (fixes the broken booking scenario, lets a pasted GoHighLevel key run the whole line, adds cancel/reschedule) or keep copying NPC's live stack. Until decided, dependent-line voice stacks stay disabled. | C1, C2, C16, C19, C20 |
| F23 | Publish the `voice-agents` add-on catalog row, so a signed agreement opens a Voice Studio project. | D11 |
| F24 | Twilio numbers per clone, the outbound launcher and post-call reports (deferred by you). | D13, C3, C9 |

### Not yours to do; recorded so nobody waits on them

- C11: Make's refusal when a scenario's connection is unbound is measured
  automatically on the first real clone build.
- C21, E7, E8: done. E8 and the audit's F4 are live since Mission Control was
  published (11 Oct 2026); every line function was read back and matches the
  head.
- E9: fixed and verified on the head (200 at 01:19 UTC).
- E10: fixes itself when the prime's deploy lane reaches the function.

