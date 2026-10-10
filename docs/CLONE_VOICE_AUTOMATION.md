# Voice agents' calendar & email on the CRM-independent line

A clone on the CRM-independent line (`clones.crm_mode = 'independent'`) answers
its phone with Vapi agents whose tools are **Make.com scenarios**: check
availability, book, reschedule/cancel, and a notifier that emails the booking.
Which calendar they book into, which mailbox confirms, the hours they offer and
who in the business is told all live in two places in Make:

| Where | What it holds | How it changes |
|---|---|---|
| The stack's **CFG** data-store record (`default`) | provider choice, calendar ids, time zone, hours, slot rules, email provider, recipient, business name, notify-customer, Zoom link, the test gate | a partial record update |
| The **calendar adapter** and **notifier** blueprints | the Outlook calendar / Google Calendar / Outlook mail / Gmail **connections** (`__IMTCONN__`) | a scenario update |

This programme lets those be set **by the operator before hand-off** and **by the
tenant afterwards, from the clone's own Settings page**, with both writers going
through one record in Mission Control.

## The shape

```
provisioning ─┐
operator ─────┼──► clone_voice_automation (desired settings, revision N) ──► apply ──► Make
tenant ───────┘     clone_voice_automation_revisions (ledger)                    adapter + notifier blueprints
  (clone Settings ─► voice-automation-settings edge fn ─► /api/public/voice-automation/*)   then the CFG record
```

**The Make API token never leaves Mission Control** (`MAKE_API_TOKEN`,
`src/server/make-client.server.ts`). A Make token is scoped to a user and its
scopes, not to a scenario, so one token reads and rewrites every tenant's
scenarios in the team. It is brokered for the same reason Didit, Airtable and the
Supabase management token are: the call travels, the credential does not.

## Pieces

| Piece | Path |
|---|---|
| Settings vocabulary, validation, locks, CFG compile/projection, connection kinds | `src/server/voiceAutomation.pure.ts` |
| Blueprint binding (find modules by app, never by id; add Gmail routes) | `src/server/voiceAutomationBlueprint.pure.ts` |
| Apply plan (bind first, CFG last; blocked is all-or-nothing) | `src/server/voiceAutomationPlan.pure.ts` |
| Tests (against the real NPC stack's blueprints in `src/server/fixtures/voice-automation/`) | `src/server/voiceAutomation.pure.test.ts`, `voiceAutomation.contract.test.ts` |
| Make API client | `src/server/make-client.server.ts` |
| Orchestration (read, write, apply, connect, drift, sweep) | `src/server/voice-automation.server.ts` |
| Tenant door (clone key, scope `automation:configure`) | `src/routes/api.public.voice-automation.$operation.ts` |
| Drain (every 5 min) | `src/routes/hooks.voice-automation-drain.tsx`, `20261009120100_schedule_voice_automation_drain.sql` |
| Tables + the NPC stack's registration | `20261009120000_clone_voice_automation.sql` |
| Operator surface | `src/lib/voice-automation.functions.ts`, `CloneVoiceAutomationCard` on `/clones/$cloneId` |
| Clone side | `npc-crm-independent-6505dc`: `voice-automation-settings`, `VoiceAgentCalendarEmailCard`, `docs/integrations/VOICE_AGENT_CALENDAR_EMAIL.md` |

## Rules that carry it

1. **One record, three writers, revisioned.** Provisioning, the operator and the
   tenant all write `clone_voice_automation.settings` through
   `validateSettings`, each write naming the revision it read
   (`expectedRevision`) and the UPDATE conditioned on it. Two people saving at
   once cannot overwrite each other unseen: the second gets `revision_conflict`
   and reloads. Every accepted write is a row in
   `clone_voice_automation_revisions` (who, what changed, the whole object).
2. **Desired is never mistaken for applied.** `applied_revision` /
   `applied_settings` move only when Make has been written. A revision can be
   accepted and BLOCKED (the chosen calendar has no authorised connection) or
   FAILED (a Make error, retried on a back-off up to 8 times, then an operator is
   told). Both the operator card and the clone's card say "saved — not live
   yet" and give the reason; neither says "saved" over a change the agents are
   not using.
3. **Bind first, CFG last.** CFG is what *selects* a provider. Writing it before
   the connection is in the blueprint points live calls at nothing. Binding first
   is harmless: a bound connection nothing selects is never called. Every
   authorised connection is bound, selected or not, so a later provider switch
   is a CFG write alone.
4. **Blocked writes nothing.** If a required connection is missing, nothing at
   all is written — not the bindings, not the hours. A partial apply leaves the
   stack at a state nobody chose.
5. **Modules are found by what they call, never by their id.** The generator
   numbers them (adapter 6/11, notifier 7/8) and the Make designer renumbers
   freely. A blueprint without the expected module is refused by name.
6. **The CFG record's secret never travels.** Make's data-store endpoints
   answer with the whole record, including the stack's shared `adapter_secret`.
   `readManagedCfg` projects to the managed fields at the read; `patchCfg`
   discards its echo; nothing managed by this programme can name the secret,
   the internal hook URLs or the launcher map (`UNMANAGED_CFG_FIELDS`, pinned
   by a test).
7. **Locks are the operator's, and visible.** `locked_fields` defaults to
   `email.testRedirectTo` (the test gate: clearing it starts real customers
   receiving real mail). A tenant write that changes a locked field is refused
   naming it — never silently dropped. **Hand-off** is a separate act; "hand off
   and release locks" is the go-live decision and is audited as such.
8. **"No email" must mean no email.** The stack originally filtered Outlook on
   `email_provider != google`, so `none` still sent. The clone repository's
   generator now filters `= outlook` (deployed to the NPC notifier on 10 Oct
   2026), and the plan refuses to apply `none` onto a notifier that still has
   the old filter (`notifier_cannot_disable`) rather than record a choice Make
   would ignore.
9. **Drift is reported, not silently reverted.** Once a day per clone the drain
   reads the live CFG and records fields somebody edited in Make by hand; the
   operator is notified once. The next applied change overwrites them — the
   record here is the source of truth — which the notification says.

## Connecting a calendar or mailbox

A connection is an OAuth grant to the **tenant's own** Microsoft or Google
account. `startConnection` creates a Make credential request (v2,
`provider: newUser{name,email}` — the person authorising), with a unique
`nameOverride` (`aurixa-<clone>-<kind>-<nonce>`), and hands back Make's
authorisation link (`publicUri`), which the tenant opens in a new tab. The link
is stored **encrypted** (`public_uri_enc`, `CREDENTIALS_ENC_KEY`) because it lets
whoever holds it attach an account to this clone's request, and is shown only to
that clone and to operators.

`refreshConnection` (on "I've authorised it", and on every drain pass) reads the
request detail. When Make reports `authorized`, the connection id is the
credential's numeric `remoteId`, else the team's connection with that exact name.
It is checked to belong to the stack's team, **verified** with Make's connection
test, promoted (the previous one for that kind is superseded), and the waiting
revision is applied.

The operator can also register an EXISTING connection by id ("Use existing"),
which is how the NPC stack's `property@` mailbox (10496840) is registered.

## Provisioning a new clone's stack

Today a stack is built from the clone repository's generators
(`voice-agents/crm-independent/make/`) and registered here with **Register stack**
on the clone's page (zone, team, CFG data store, adapter and notifier scenario
ids, and the first settings). Registration refuses a clone that is not on the
independent line, and applies immediately. The NPC CRM Independent stack is
registered by the migration.

Not automated yet, and recorded here so nobody assumes it is: **creating** a new
tenant's stack (cloning the nine scenarios, five data stores and hooks, and
re-pointing the Vapi tools) is still a build step outside Mission Control. The
registration above is the seam that step will fill.

## What an operator must configure

- `MAKE_API_TOKEN` on Mission Control: a Make API token on the team that holds the
  stacks, with scopes `scenarios:read`, `scenarios:write`, `datastores:read`,
  `datastores:write`, `connections:read`, `connections:write`,
  `credential-requests:read`, `credential-requests:write`. Until it is set,
  every apply is BLOCKED with `make_not_configured` (said on both cards), and
  nothing reaches the voice agents.
- `CREDENTIALS_ENC_KEY` (already used by Voice Studio): without it the
  authorisation link is not stored, so a tenant who closes the tab must start
  again.

## The scope

`automation:configure` is on by default, so `ensureCloneMissionControlLink`
widens live link keys onto it. Until a key has been widened, the route also
accepts `integrations:write` (already on every link key), so the feature works
from the first deploy.
