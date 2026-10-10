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

---

## D. Tasks waiting on the owner

Carried from earlier work. Each one is also recorded where it was found.

| # | Task | Where it is recorded |
|---|---|---|
| D1 | Set `MAKE_API_TOKEN` on Mission Control: a Make API token on team 2731020 with scopes `scenarios:read/write`, `datastores:read/write`, `connections:read/write`, `credential-requests:read/write`, `hooks:read/write` (a new stack reuses the template's data structures, so no data-structures scope). Until then voice-automation applies and stack provisioning are blocked, and say so. | `CLONE_VOICE_AUTOMATION.md`, `CLONE_VOICE_STACKS.md` |
| D2 | Set one secret value in both halves for the NPC CRM Independent clone's call logs: the clone's Integrations → Vapi → Webhook Secret, and the token of Vapi credential "NPC CRM Independent call logs" (`49187eb8`) in org B. New clones provisioned by this build get both halves minted automatically. | clone repo `docs/integrations/VOICE_AGENT_CALL_LOGS.md` |
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
