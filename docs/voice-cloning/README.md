# Voice Cloning Studio

Mission Control's way to give a client a voice agent fleet built from the one
stack that is proven on real phone lines: NPC Services' VAPI fleet and
Mission Control's own reception fleet, which were re-targeted from it.

An operator opens a **cloning project** for a client (an existing workspace, a
lead, a signed agreement, or a prospect) and uploads the client's documents.
A Claude **planning agent** reads them and produces a cited **cloning plan**
from a versioned **recipe book**. A deterministic compiler "cooks" an approved
plan into a **build package**: every system prompt, the knowledge base, the
tools and the squad. An admin approves the package and **deploys** it into the
**client's own VAPI org**. Every step is verified by reading it back, re-runs
are no-ops, and a deploy can be rolled back.

UI: **Voice → Cloning Studio** (`/voice/studio`). Runbook: [RUNBOOK.md](./RUNBOOK.md).

```
documents + what MC knows about the client
  -> ingest    (private bucket; docx/xlsx/csv/txt read here, PDFs read by the model)
  -> plan      (Claude, structured outputs, one checkpointed stage at a time)
       facts per document -> profile -> fleet topology -> each agent
       -> shared voice -> knowledge base parts -> validate (+1 repair) -> plan
  -> review    (edit = new plan version, re-validated) -> APPROVE PLAN
  -> compile   (pure, deterministic, hashed build package) -> APPROVE PACKAGE
  -> deploy    (client's VAPI org: tools, KB file, assistants, squad, number)
  -> verify    (read every assistant back; compare prompt hash, tools, KB, server)
  -> runtime   function tools -> MC /api/public/voice/t/<tenantKey>/webhook
               call logs      -> the client workspace's vapi-call-webhook
```

## The recipe book (`src/lib/voice-recipe/`)

The recipe book is the proven stack as data and code, versioned
(`RECIPE_BOOK_VERSION`) and hashed (`recipeBookSha()`). A plan records the
version and hash it was made against.

| Module                       | What it holds                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sections/core.pure.ts`      | Every prompt section, ported from `scripts/voice/build-fleet-prompts.py` with each business literal turned into a slot.                                                                                                           |
| `sections/playbooks.pure.ts` | The NPC playbooks (AI transparency, time authority, tool-turn discipline, objections, edge cases, tool errors, negative-sentiment close, reschedule/cancel). `PLAYBOOK_PROVENANCE` names the NPC file and heading each came from. |
| `compiler.pure.ts`           | `compileAgentPrompt` in `build()`'s order, with the tool-conditional sections and absolute rules.                                                                                                                                 |
| `archetypes.pure.ts`         | Ten agent archetypes, each with direction, first-message mode, squad role, default and optional tools, playbooks and what it was proven on.                                                                                       |
| `tools.pure.ts`              | The tool catalog, the **fixed backend menu**, and the VAPI tool payloads (parameters lifted from `create-vapi-org-tools.py`).                                                                                                     |
| `kb.pure.ts`                 | Knowledge-base parts, ASCII rendering, the claims denylist, and the upload rule (`text/plain`, `.txt`).                                                                                                                           |
| `defaults.pure.ts`           | Model, transcriber, voice palette and speaking plan NPC settled on.                                                                                                                                                               |
| `lessons.pure.ts`            | The rules the stack learned live, each with the reason.                                                                                                                                                                           |
| `recipeBook.pure.ts`         | The deterministic text form. It is the planner's cached system prompt.                                                                                                                                                            |

**It is proven equivalent to the live fleet by test.**
`aurixaFleet.golden.test.ts` compiles Mission Control's 12 live prompts from
`scripts/voice/fleet-prompts/fleet-spec.json` through the TypeScript compiler
and requires them byte-identical to the committed `.md` files that
`build-fleet-prompts.py` writes. `recipeBook.invariants.test.ts` compiles every
archetype for a placeholder business and fails on any Aurixa or NPC word. So
the book can only ever contain structure, never another client's words.

`scripts/voice/check-recipe-provenance.mjs --npc <path>` checks that every NPC
heading a playbook was distilled from still exists. It is not in CI, because
CI does not check out the NPC repository. Run it when NPC's prompts change.

### The backend menu

The planning agent chooses where each tool runs, **but only from this menu**
(it is an enum in the output schema):

| Backend                  | Deployable                          | Used for                                                                                         |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `vapi_native`            | yes                                 | end call, knowledge-base query, squad handoff                                                    |
| `mission_control_tenant` | yes (not cancel/reschedule yet)     | contacts, call context, availability, booking, tickets                                           |
| `make_twilio_redirect`   | yes, needs the operator's Make hook | transfer to a human. VAPI's native `transferCall` failed live, and NPC binds it to no assistant. |
| `external_crm_custom`    | **no**                              | becomes an open item                                                                             |
| `make_scenario_custom`   | **no**                              | becomes an open item                                                                             |

An undeployable choice is never dropped silently. The validator turns it into
an open item, and the compiler leaves that tool out along with anything that
requires it.

## The planning agent (`src/lib/voice-studio/`, `src/server/voice-studio/`)

- **Model:** Claude (`claude-opus-5`) over the Anthropic API.
  - Adaptive thinking, with per-stage effort.
  - Streaming, with server-side refusal fallbacks.
  - Structured outputs against zod/v4 schemas (`schemas.pure.ts`).
  - The recipe book is the cached system prefix.
- **The key is `VOICE_STUDIO_ANTHROPIC_API_KEY`, never `ANTHROPIC_API_KEY`.** Mission Control forwards named LLM secrets into clones (`cloneSecretForward.server.ts`), and `ANTHROPIC_API_KEY` is one of those names.
- **Stages** (`plannerEngine.pure.ts`):
  - A stage machine with the model and the store injected.
  - Every unit (one document's facts, one agent, one KB part) is saved as an artifact the moment it exists.
  - A tick that runs out of time re-queues the run, and the next tick resumes without paying twice.
  - `stage_cursor` pins which document is `doc:1`, `doc:2`, and so on. The Mission Control context document is stored on the first tick. So a run's inputs cannot move under it.
- **Documents:**
  - docx, xlsx, csv, txt and md are read here (`extract.pure.ts`, reusing the email import's zip/xlsx readers).
  - A PDF goes to the model whole through the Files API, uploaded once and referenced by id.
  - Every ceiling is visible: a document cut short says so.
- **Citations are schema fields**, because API citations cannot be combined with structured outputs.
  - `confidence.pure.ts` checks each quote verbatim against the extracted text.
  - A PDF quote is counted as model-asserted, because its text is not held here.
  - Confidence is computed from what was measured, never from the model's opinion of itself.
- **Validation** (`validate.pure.ts`):
  - It checks what a schema cannot: that the fleet fits together, that each tool can be built, and that the written words carry no URL, injection phrase, invented number or denied claim.
  - One repair pass re-asks for the topology with the errors listed. What still fails is recorded on the plan and blocks approval.
- **Cost:** each run has an estimated spend cap, `VOICE_STUDIO_MAX_RUN_USD` (default $25). Usage goes to `ai_usage_log` under `voice_studio.<stage>`.

### Documents are data

A client's brochure can say "ignore your instructions". Five things stand
between that and a phone line:

1. It arrives as a document block.
2. The rules tell the model what a document is for.
3. The output is enum-constrained.
4. The validator lints every written field for injection phrases.
5. Two humans approve before anything is deployed.

There is no schema field for a URL, phone number, API key or webhook. Those
are supplied by an operator and never read out of a document. The Mission
Control context is redacted of emails, numbers and links **before** it reaches
the model, because a number that is never in a source can never be quoted
into a prompt.

## Plans and packages

- **An edit is a new plan version**, re-validated with the planner's checks. An operator's words go through the same lint as a model's, because the agent reads them out either way.
- **Approving a plan compiles the package** (`package.pure.ts`).
  - The package is immutable, hashed (`contentSha256`), and identical for identical plans.
  - It holds **placeholders only** (`{{tool:x}}`, `{{kb:file}}`, `{{secret:tenant_webhook}}`, and so on), never a secret.
- **The package is approved separately.** The Package tab shows every prompt, the KB text, the tools, the squad, and a diff against the previous version.

## Deploy (`vapiDeploy.pure.ts`, `deploy.server.ts`)

Into the **client's own VAPI org**, with the client's key:

- The key is verified with a real read before it is stored.
- It is stored encrypted, and nothing is stored while `CREDENTIALS_ENC_KEY` is unset.
- It is refused if it is Mission Control's own `VAPI_API_KEY`.
- It is never returned to a browser; the Studio shows only a fingerprint.

Order: tools → KB file → wait for `status=done` → assistants → squad → optional phone number → read-back.

| Rule (lesson)                                       | How deploy keeps it                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KB_TEXT_PLAIN`                                     | Upload as `text/plain` `.txt`; `failed` stops the deploy before any assistant points at the file.                                                                |
| `KB_BOTH_LOCATIONS`                                 | The file id goes in the inline query tool and in `model.knowledgeBase`, and verification checks both.                                                            |
| `PATCH_WHOLE_MODEL` + `KEEP_UNMANAGED_INLINE_TOOLS` | Updates send the whole model and carry over inline tools the Studio did not put there.                                                                           |
| `READBACK_NOT_HTTP_STATUS`                          | Each assistant is read back: prompt hash, tool ids, KB in both places, first-message mode, server URL, squad membership. A hand edit in VAPI fails verification. |

- **The ledger** (`voice_studio_vapi_ledger`) records every VAPI id and the hash of the payload last written, _including resolved secrets_.
  - A re-run skips anything unchanged, so an identical re-deploy writes nothing.
  - A rotated secret re-writes the tools that carry it.
  - Something deleted in VAPI is recreated.
  - The KB file is recorded before waiting on the parser, so a tick that runs out never uploads twice.
- **Modes:**
  - `dry_run` only reads and reports what would change.
  - `apply` makes the org match the package.
  - `rollback` applies an earlier package that was deployed successfully before. Old KB files are never deleted, so rollback always has something to return to.

## The tenant tool backend

A deployed fleet's function tools call
`/api/public/voice/t/<tenantKey>/webhook`:

- The tenant key is random, unguessable and stable across renames.
- Each tenant has **its own** secret in `x-vapi-secret`, checked in constant time.
- Refusals are audited.

It answers from `voice_tenant_*` tables keyed by the project. Aurixa's own fleet
and CRM are untouched (`voice-tools.server.ts` is unchanged in behaviour).
`tenantTools.pure.ts` is the same contract as Aurixa's tools (same names,
arguments and guidance) over a store scoped to one tenant.
`tenantBooking.pure.ts` generates availability in the business's own
timezone, and a booking is written only for a slot it would still offer.
The day-preference parsing lives there once and Aurixa's tools use it too.

The backend switches on only after an apply verifies. It then carries the
package's booking window and types, so a half-deployed fleet never answers
from another package's config.

Call logs go to the client workspace's own `vapi-call-webhook` (URL and
`VAPI_WEBHOOK_SECRET` set on the Deploy tab). With none set, calls still work
but their end-of-call reports are acknowledged and discarded. The Deploy tab
says so.

## Data

| Migration                                     | Tables                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260924100000_voice_studio_core`            | projects, documents, runs, artifacts, plans, packages; `claim_voice_studio_runs`                                                                           |
| `20260924110000_voice_studio_tenancy`         | `voice_studio_vapi_credentials` and `voice_tenant_configs` (service role only; encrypted secrets), tenant contacts / call context / appointments / tickets |
| `20260924120000_voice_studio_deploy`          | deployments (one live per project), ledger; `claim_voice_studio_deployments`                                                                               |
| `20260924130000_voice_studio_bucket_and_cron` | private `voice-studio-docs` bucket; `voice-studio-plan-drain` and `voice-studio-deploy-drain`, every minute, 290 s HTTP timeout                            |

## Provisioning

When a signed agreement that includes the `voice-agents` add-on provisions
its clone, a **draft** project opens (`provisioning.server.ts`). This never
fails provisioning, and there is only ever one project per agreement. The
catalog row for that add-on (name and price) is the owner's to publish,
because the catalog syncs to Stripe. Until it exists, this does nothing.

## Not built yet (open items the Studio names itself)

- Cancel and reschedule in the tenant backend: the tools exist in the catalog and are marked not deployable.
- The `external_crm_custom` and `make_scenario_custom` backends.
- Buying phone numbers and creating the Make transfer scenario in a client's accounts. The operator supplies the hook URL; `docs/voice-aurixa-pipeline.md` has the scenario.
- Syncing tenant contacts and appointments into the client workspace's CRM.
