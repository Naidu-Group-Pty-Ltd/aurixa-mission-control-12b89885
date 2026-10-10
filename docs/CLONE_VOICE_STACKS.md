# Clone voice stacks

Every clone that gets voice agents gets them on its own CRM line, in its own
Vapi organisation, built by Mission Control from that line's head. This is the
voice half of the Yggdrasil branching: a clone's code comes down its line from
the line head, and so do its agents. Converting a clone to the other line moves
its agents with it.

Open questions, gaps and the owner's outstanding tasks are in
[`OPEN_QUESTIONS.md`](./OPEN_QUESTIONS.md). This document describes what is
built.

## The shape

- **Two lines, two templates.** `prime_config` names each line's head:
  `crm_dependent_parent_clone_id` (GoHighLevel) and
  `crm_independent_parent_clone_id` (native CRM). A head's voice stack was
  built by hand and is the TEMPLATE. Every other clone on the line gets a copy
  of it. A head is never built from itself.
- **The template is a manifest, read live.** `voice_stack_templates` holds one
  manifest per line: the head's Make hooks, data stores, CFG record and
  scenarios, the Vapi tools, assistants and squad, the connections the tenant
  must supply, and the words that identify the head's business. The manifest
  holds ids, never content. Each build reads the head's scenarios and agents
  as they are that day.
- **A copy is the tenant's own.**
  - **Make:** one folder per clone in the stacks' team. It holds new hooks, new
    data stores, a CFG record with freshly minted secrets, and scenarios
    rewritten to point at all of them.
  - **Vapi:** the clone's OWN org. It holds copies of the knowledge files,
    structured outputs, scorecards, tools, assistants and squad, re-pointed at
    the new hooks and renamed for the tenant.
  - **The clone's backend:** a minted `VAPI_WEBHOOK_SECRET` and a Vapi
    credential carrying the same value, so calls land on the clone's own Call
    Logs page.
  - **Voice automation (independent line):** the built stack registers itself
    (`CLONE_VOICE_AUTOMATION.md`). From then on, the tenant's calendar and
    email settings reach it exactly as they reach the hand-built one.
- **Switching lines.** `finaliseConversion` calls `onCrmLineChanged`. That
  parks the stack of the line left (its scenarios switched off, nothing
  deleted) and opens or resumes the stack for the line joined. The drain
  checks the line again on every pass, so a conversion that missed this is
  caught there.

## Each clone's own Vapi org (custody)

Vapi has no public API to create an account or an organisation (B3), so one
step is a person's. Everything around it is Mission Control's.

| Step | What happens | Who |
|---|---|---|
| `email_domain` | The clone's sending domain exists (`CLONE_EMAIL_IDENTITY.md`). | provisioning |
| `receiving` | Resend receiving is switched on for that domain, and its MX record is installed through the same DNS path as the sending records. | Mission Control |
| `login` | A login `voice-agents@<sending domain>` and a 28-character password are minted. The password is stored encrypted. | Mission Control |
| `signup` | An operator signs up at Vapi with that login. The card reads Vapi's verification mail from the inbox and shows the code or link. | operator |
| `org_key` | The operator creates the org and pastes its id and private key. The key is judged and probed with a real read. | operator, then Mission Control |

- **Custody starts with the email identity.** The deployment drain calls
  `startVapiCustodyIfDue`, and the voice-stack drain carries it on from
  there. It is best-effort: a clone that cannot get one still reaches
  production, and its card says why.
- **A key is refused when it is not this clone's.** That covers anything that
  is not a Vapi private key, Aurixa's own key or org, and a key or org already
  held for another clone.
- **The tenant never sees the login, the password or the key.** Showing the
  password is an admin act, audited each time (B2).

## What each line needs before it is built

| Requirement | Independent | Dependent |
|---|---|---|
| The clone's own Vapi org, active | ✓ | ✓ |
| The tenant's business identity (label and replacements for the head's words) | ✓ | ✓ |
| A clone backend for the call logs | ✓ | ✓ |
| A GoHighLevel private-integration token and location id, verified against GoHighLevel | — | ✓ always |
| The tenant's GoHighLevel grant for Make's GoHighLevel modules, for the same location | — | ✓ |

`judgeStackProvision` refuses a build and names every reason at once:

- `crm_mode_unrecorded`, `clone_is_line_head`, `conversion_open`;
- `template_missing`, `template_invalid`, `template_disabled`;
- `make_not_configured`, `aurixa_vapi_not_configured`,
  `encryption_not_configured`;
- `vapi_org_not_active`, `no_backend`;
- on the dependent line, `ghl_credentials_missing` and
  `ghl_credentials_unverified`.

**The dependent template is registered disabled.** Its booking scenario carries
a token placeholder with no CFG record to bind it to (C1), and where the GHL
key reaches today is set out in C16. The owner decides the template change;
the original NPC scenarios are never edited.

## The build

- **One plan, one ledger.** `planStackSteps` orders the work: discover, folder,
  hooks, data stores, records, CFG, call-log secret, Vapi objects,
  scenarios, the tenant's grants, activation, voice-automation hand-off, and
  verify. Each step has dependencies.
  - Every step writes a ledger row the moment its object exists: the external
    id, an encrypted secret where it has one, attempts and the next attempt.
  - A re-run finds the object and PATCHes it rather than creating a second one.
- **Status is derived, never stored as a second opinion** (`readStack`).
  - `failed` means a step has used all eight attempts; it runs again only when
    an operator retries it.
  - A step with a retry to come shows as `retrying`, and the stack as still
    building.
  - A step waiting on a person (the tenant's grant, an operator's request) is
    `waiting`, never a failure.
- **The drain runs every five minutes** (`/hooks/voice-stack-drain`, cron
  `voice-stack-drain`).
  - It opens a stack row for every clone on a line.
  - It ticks up to ten stacks that are not live, oldest first, under a lease
    and within its budget.
  - An exhausted step notifies operators once.
- **Discovery dry-runs the copy first.**
  - Every template scenario is rewritten against placeholder ids.
  - Every template tool and assistant is read.
  - Every id is accounted for.
  - Anything that would carry the head's identity into the tenant's org is
    listed.
  - A template that cannot be copied cleanly is held at discovery, before
    anything exists.

## Rules that carry it

- **Aurixa's Vapi key only reads.** Templates are read through a reader that
  has `get` and nothing else. Every write goes through the clone's own key,
  which is refused if it is Aurixa's. A contract test fails on any write
  through anything else, and was proven against planted violations.
- **No credential is ever written into a blueprint as text.**
  - A `{{SECRET:…}}` placeholder is bound to the stack's CFG record, and only
    in a scenario that reads that record. A scenario without such a reader is
    held.
  - An independent residue check then confirms no template hook, store,
    connection or URL survived the rewrite.
- **An id nothing accounts for holds its object.** Copying it would point the
  tenant's agent at the head's knowledge file or scorecard, and dropping it
  would ship an agent missing a piece. The one exception is a voice id, which
  is a provider catalogue entry, not an org object.
- **Nothing of the head's business reaches the tenant.** Each template carries
  a deny-list of the head's words. A tool or assistant still containing one
  after the replacements is held, with the words listed on the card.
- **Connections are bound by what the module is, not by which connection the
  head used.** Shared connections (Aurixa's OpenAI classifier) are kept.
  Tenant connections are re-bound by app. One the tenant has not made yet
  leaves its scenarios waiting rather than bound to the head's.
- **Parking never deletes.** Scenarios are switched off and every id is kept.
  Resuming switches them back on and reads the stack back again before it can
  be called live.

## Pieces

| Piece | What it is |
|---|---|
| `supabase/migrations/20261011090000_clone_voice_stacks.sql` | Five tables (custody, GHL credentials, templates, stacks, ledger), closed to browsers by REVOKE and RLS with no policy; the two line templates seeded. |
| `supabase/migrations/20261011090100_schedule_voice_stack_drain.sql` | The five-minute drain. |
| `src/server/voiceStackTemplate.pure.ts` | The manifest type, its validation, the provision gate, and the two seeds. |
| `src/server/voiceStackMake.pure.ts` | Blueprint references, the scenario rewrite, the residue check, the CFG record. |
| `src/server/voiceStackVapi.pure.ts` | Preparing tools, assistants and the squad for the tenant's org; replacements and residue. |
| `src/server/voiceStackPlan.pure.ts` | The plan, the ledger, retries and the derived status. |
| `src/server/cloneVapiCustody.pure.ts` | Login, password, key judgement, verification mail, custody readiness. |
| `src/server/ghlVoiceCredentials.pure.ts` | GoHighLevel input, verification and the grant's location match. |
| `src/server/voice-stack.server.ts` | The orchestrator: view, operator inputs, tick, park, line change, sweep. |
| `src/server/clone-vapi-custody.server.ts` | Custody: inbox, login, sign-up, org key, suspension. |
| `src/lib/voice-stack.functions.ts` | Admin-only server functions behind the card. |
| `src/components/clone-voice-stack-card.tsx` | The operator card on the clone page. |
| `src/components/yggdrasil/voice-line.tsx` | The voice line on a Yggdrasil node. |
| `src/server/voiceStack.contract.test.ts` | The wiring rules above, asserted on the source. |

## Operator steps for a new clone

1. **Vapi org.** On the clone's Voice stack card:
   - press **Advance** until the login is minted;
   - reveal the login and sign up at Vapi with it;
   - press **Read inbox** for the verification code;
   - create the org, then paste the org id and the private key.
2. **Identity.** Enter the tenant's business label and a replacement for each
   of the head's words (name, website, phone).
3. **Dependent line only:**
   - enter the tenant's GoHighLevel private-integration token and location id;
   - request the GoHighLevel grant;
   - send the tenant the authorisation link the card shows.
4. **Build.** Press **Build now**, or let the drain pick it up. The card shows
   each step. The independent line's calendar and mailbox are then the
   tenant's to connect, through voice automation as before.

## Configuration on Mission Control

| Name | Why |
|---|---|
| `MAKE_API_TOKEN` | Every Make read and write. Needs `scenarios`, `datastores`, `connections`, `credential-requests` and `hooks`, read and write (D1). |
| `VAPI_API_KEY` | Reading the templates in Aurixa's org. Never used to write. |
| `RESEND_MASTER_API_KEY` | Switching on receiving and reading the Vapi inbox. |
| `CREDENTIALS_ENC_KEY` | Encrypting logins, keys, tokens and minted secrets. Without it nothing is built. |
| `AURIXA_VAPI_ORG_IDS` | Optional: further Aurixa org ids a tenant key must never belong to. |
