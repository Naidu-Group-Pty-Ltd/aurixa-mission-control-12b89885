# The four things the MC voice fleet could not do

Four defects were reported against the twelve-assistant Mission Control voice
fleet on +61 2 8105 6305: the end-call tool never fired, the support agent
raised no ticket, booking / availability / transfer-to-human were untested, and
the knowledge base was "extremely repetitive".

**Three of the four were not bugs in code that runs. They were capabilities
that had never been wired**, and one of them was deleted on every deploy by the
fleet's own upgrade script. The fourth was a corpus problem whose worst symptom
turned out not to be repetition at all.

Read this before touching `scripts/voice/apply-fleet-upgrade.py`,
`scripts/voice/build-fleet-prompts.py`, `scripts/voice/knowledge-base/`,
`handleRaiseSupportTicket` in `src/server/voice-tools.server.ts`, or
`src/server/voiceTicketDraft.pure.ts`.

---

## 1. The deploy script deleted the end-call tool, and asserted the deletion

`apply-fleet-upgrade.py` kept only inline tools of `type == "query"`:

```python
kb_tools = [t for t in (model.get("tools") or []) if t.get("type") == "query"]
model["tools"] = kb_tools
```

VAPI's end-call tool is an inline `{"type": "endCall"}` entry, so this removed
it from every assistant on every run. The verify step then made the removal its
**success condition**:

```python
and got_inline == [("query", "aurixa_knowledge")]
```

The script printed `applied` at precisely the moment it had destroyed a
capability — code and check agreeing while only the server disagreed, which is
the same shape as the AML `.or()` double and the `PGRST205` fallback.

`manifest.json` named five tools and `end_call_tool` was not among them, and
`model["toolIds"]` was replaced wholesale, so nothing attached by hand survived
either. And **all twelve prompts mentioned the tool zero times** — the only line
about closing in any of them was *"Never rush to end the call."*

### A correction, from reading the assistants again after the fix

The first account of this said the capability was absent in the binding *and* in
the instruction. The binding half is only half true, and the distinction decides
which fix is load-bearing.

`endCallFunctionEnabled` is a **top-level assistant field, separate from the
tool list, and it reads `true` on all twelve** — the inline-tool filter never
touched it. So VAPI's own end-call function was available to the model the whole
time, and the fleet still never used it: the five most recent calls all ended
`customer-ended-call`, never `assistant-ended-call`. The caller hung up every
time.

So **the prompt is the load-bearing half of this fix.** The script's inline-tool
deletion is a real defect and stays fixed — it would have removed the explicit
tool the moment anyone attached one, which is exactly what this work then did —
but it is not what kept the fleet from hanging up. An instruction nobody gave is.

Three rules now hold it:

- **Nothing inline is this script's to delete.** The manifest governs
  `toolIds`; it says nothing about what VAPI or an operator attached inline.
- **A binding the manifest does not name is kept and reported**, never dropped
  silently. `--prune-unmanaged` is the explicit opt-in for making the manifest
  exclusive.
- **The verify asserts what the script is responsible for and nothing more**:
  every manifest tool bound, the knowledge-base query tool still present,
  the prompt the right length, the model unchanged.

The prompts now carry the same-turn rule measured on the NPC fleet: say the
closing line **and** call `end_call_tool` in the **same turn**. An assistant
only gets another turn when the caller *speaks*, and a caller who has just been
said goodbye to has no reason to say anything — so a hang-up deferred to a later
turn never happens, and the call ends on a timeout instead. The prompt names
which half matters: **the tool call is the half that must never be missed.**

## 2. The support agent had no way to raise a ticket

`MC Support Intake` was bound to `resolve_contact` and `get_call_context` only.
`support.md` mentioned "ticket" once — in Monica's persona line — and told her
twice to *"Point at the support portal for tracking and attachments"*. She had
never been able to raise one, and §9 said outright that she could not transfer
the call either, so a customer reporting a fault reached a line that could
neither log it nor pass it on.

The ticket system was complete and in the **same application**:
`src/server/support-tickets.server.ts`, the portal at `/support/tickets`, and a
remediation drain. So the call travels rather than a credential:
`handleRaiseSupportTicket` calls `ingestSupportTicket` **in process**.

Four rules carry it.

**The server classifies, never the agent.** `SupportTicketPayloadSchema` wants a
`category` from eleven values and a `breakage_vector` from seven, and neither is
a question you can ask somebody on the phone — "would you describe this as a
partial outage or degraded performance?" is not a sentence a support agent
should say out loud. `voiceTicketDraft.pure.ts` maps prose onto the contract and
is **total**: an unrecognised report becomes `other` / `none` rather than an
error, because a ticket filed in the wrong category is recoverable by anyone who
reads it and a lost report is not. It also **never invents** — the description is
padded past the 20-character floor only by saying where the report came from.

**The email comes from the CRM record**, and Monica asks only when there is
none. Reading an address back over the phone is the most fragile step in this
flow, so a spoken value is used only when it parses; `usableEmail` discards
anything else rather than sending a mis-transcription the schema would reject.
A *failed* contact read is logged and not treated as a contact without an email.

**A refusal is never dressed as a success.** The handler returns the `TKT-…`
reference on success and, on anything else, an instruction to tell the caller it
has **not** been logged and to invent no reference. The prompt carries the same
three branches.

**One ticket per problem.** A second call for the same fault gives the team two
records of one problem, so the prompt forbids it and says a genuinely separate
issue is a separate ticket, out loud.

The authentication is the intake route's own: `signIntakeBody` is now exported
from `src/server/security-intake/signature.ts` so the HMAC is computed in one
place and an in-process caller cannot drift from a webhook caller.

## 3. Transfer to a human did not exist, and booking had never been exercised

| flow | before | now |
|---|---|---|
| `check_availability` | handler present, proven live | unchanged |
| `book_appointment` | handler present, **never exercised** | exercised in live verification |
| transfer to a human | **no tool, no handler, no prompt mention anywhere** | `transfer_to_human_mc` on the four reception assistants |

The squad's only transfer was VAPI's built-in `transferCall` **between squad
members by name** — agent to agent, never to a person.

The mechanism is deliberately *not* NPC's. NPC transfers by redirecting the
Twilio parent call from a Make scenario; Mission Control's voice module runs no
Make scenarios, and honouring that is worth more than symmetry. So this is
VAPI's own `transferCall` tool with a number destination, and
`routeHandoff` / `transfer-destination-request` are untouched — this adds a
destination, it does not switch on the unreachable handoff path.

What *is* borrowed is the prompt rule, because that is what was measured to
work: say the handover line and place the call in the **same turn**, and if
only one is possible, place the call.

**Which of the two section 9s a prompt gets is derived from the agent's tool
list**, not listed separately — a prompt that offers a transfer the assistant
cannot place, or withholds one it can, is the same defect in opposite
directions. The eight outbound agents keep the original "cannot transfer"
section, which remains true for them.

## 4. The knowledge base was not repetitive — it was narrow, and its prices were wrong

Measured on the old builder: 85 prose literals, 12,064 characters, 106
sentences, **0 duplicated sentences and 0 duplicated literals**, across
**7 sections** — About / Access / What the platform does / Plans / Security /
Support / Quick answers.

So "extremely repetitive" was an effect rather than a cause. A 12 KB brochure
covering sales and access means most questions outside those seven topics
retrieve the *nearest* passage, and callers hear the same paragraphs back.

**The more serious finding was the pricing.** Every tier and nine module prices
were stale, because they had been typed in and compared with nothing:

| | knowledge base said | catalog says |
|---|---|---|
| Launch | A$699/mo | **A$999** (A$849 without AML) |
| Growth | A$1,055/mo | **A$1,399** (A$1,249) |
| Scale | A$2,210/mo | **A$2,699** (A$2,549) |
| AML/CTF module | A$195/mo | **A$150** |
| Finance Portal | A$225/mo | **A$349** |
| Aurixa Agent | A$375/mo | **A$495** |

Four modules were missing entirely (Client Forms, Lenders, Solicitor Portal,
Builder / Developer Portal). A voice agent quoting three hundred dollars under
the list price is worse than one that cannot quote at all.

Three rules now:

- **A price is read from the catalog, never restated.**
  `knowledge-base/pricing-prose.mjs` imports `src/lib/pricing/aurixa-catalog.ts`
  and generates every figure in the document, so the two ends cannot drift.
- **A module with no agreed selling price carries no figure.** `lenders` is
  `comingSoon`, and its own catalog note says *"the listed figure is historical
  and is not a current price"* — a historical figure spoken aloud is a quote.
- **The headings are questions, and each answer stands alone.** 13 sections and
  56 question-shaped headings against the old 7 and 9, so a query matches one
  passage rather than the nearest paragraph of a brochure.

The corpus is `knowledge-base/content.mjs`, rendered to a **Markdown file that
is checked in** — the old builder emitted only a `.docx` that was uploaded by
hand and committed nowhere, so the document the live agents answered from could
not be compared with anything. `--check` fails when the committed file is not
what the content module produces, and `knowledge-base/vapi-file.json` records
the uploaded file's id and the SHA-256 of what was uploaded: a wrong file id and
a stale corpus are different failures with different remedies, so both are
recorded. `apply-fleet-upgrade.py` re-points every inline `query` tool at that
id and verifies it by read-back, which removes the last hand step.

A null `file_id` means the corpus is not managed from here and every query tool
is left exactly as found — **unbinding a knowledge base leaves every assistant
answering from nothing, which is worse than a stale one.** VAPI stores the file
id in *two* places on an assistant — the inline query tool's
`knowledgeBases[].fileIds` and `model.knowledgeBase.fileIds` — and both carried
the same id on all twelve when this was measured, so both are written together
or neither is: an assistant naming two different corpora is worse than a stale
one too.

The corpus is rendered ASCII-only. A U+2014 reads no differently to a retrieval
index or a TTS engine, and the file is carried by hand between this repository
and a vendor's file store — every step of that journey is somewhere an encoding
can be mangled silently, and an ASCII artefact can be compared byte for byte at
either end. Which is what was done: the upload was read back from the store and
its MD5 matched the committed file exactly.

---

## What is live, and how that was established

Applied 23 Sep 2026 to all twelve assistants in org `453f00c2…`. Every write was
a full `model` PATCH (a VAPI PATCH replaces a whole top-level key) built from a
GET taken moments earlier, and every one was verified by a **fresh GET** rather
than by the PATCH's own response:

- `PATCH=200` on all twelve.
- The **MD5 of the live system message equals the MD5 of the prompt this
  repository generates**, on all twelve. Not the length — the bytes.
- `toolIds` carry `end_call_tool` on all twelve, `transfer_to_human_mc` on the
  four reception assistants, and `raise_support_ticket` on Support Intake.
- The inline tool set is still exactly the knowledge-base `query` tool: nothing
  was deleted, which is the defect this work exists to end.
- Both knowledge-base file ids read `0af91eda-7a07-41b6-87be-72f75317dced`.
- `model.model` is unchanged at `gpt-5.6-luna` on all twelve.

The live state was also read **before** any write, and it matched this
repository byte for byte on all twelve — so the drift this work was braced for
did not exist, and the audit is recorded here rather than assumed.

---

## The trap that nearly cost all of the above

`scripts/voice/fleet-prompts/*.md` **and `manifest.json` are generated** by
`build-fleet-prompts.py` — verified byte-identical with the committed copies
before any of this work landed. Nothing said so, nothing checked it, and the
manifest is what the deploy script binds tools from. Every prompt edit above was
first made by hand in the generated files, where the next run of the generator
would have silently discarded it.

`build-fleet-prompts.py --check` now re-derives all thirteen files and compares
the **bytes**, naming each that drifted. The comparison is the artefact and
never a count, for the reason `check-edge-functions.mjs` already paid for: a
count absorbs one change arriving as another leaves.

`mc_org_tool_ids.json` is the one file in that directory that is *not*
generated. It maps a tool name to its VAPI org tool id and is maintained by
hand beside `create-vapi-org-tools.py`.

---

## What an agent is bound to

| assistant | tools |
|---|---|
| MC Front Desk | `resolve_contact`, `get_call_context`, `phoneNumber_inject`, `transfer_to_human_mc`, `end_call_tool` |
| MC Review Booking | + `check_availability`, `book_appointment`, `transfer_to_human_mc`, `end_call_tool` |
| MC Solutions Advisor | + `check_availability`, `book_appointment`, `transfer_to_human_mc`, `end_call_tool` |
| MC Support Intake | `resolve_contact`, `get_call_context`, `raise_support_ticket`, `transfer_to_human_mc`, `end_call_tool` |
| the eight outbound agents | `resolve_contact`, `get_call_context`, `check_availability`, `book_appointment`, `end_call_tool` |

`end_call_tool` and `transfer_to_human_mc` are VAPI-native (`endCall`,
`transferCall`) and need no webhook handler. `raise_support_ticket` is a
`function` tool and is dispatched in `voice-tools.server.ts`.

---

## What is still unproven, and why

Everything above is established by reading VAPI back. **None of it is
established by a call**, and the difference matters.

A phone call could not be placed from the session that did this work. VAPI's
`/chat` endpoint — which would have driven a text conversation through the same
assistant, tools and knowledge base — answers **HTTP 402** for this
organisation, so that substitute is closed too. The account is not out of
credit: five inbound calls landed and completed normally the same day.

So these remain open, and each needs somebody to dial **+61 2 8105 6305**:

| what | what to do | what proves it |
|---|---|---|
| end call | let the agent finish and say goodbye | `endedReason` is `assistant-ended-call`, not `customer-ended-call` or a timeout, and the transcript's last turn carries the tool call beside the closing line |
| transfer | ask for a person | a child leg to +61 433 005 110, and the handover line in the same turn as the call |
| availability | ask for a time next week | `check_availability` in the call's tool calls, and only those times offered |
| booking | accept one | `book_appointment` succeeds and a `crm_appointments` row exists |
| **support ticket** | report a fault to Monica | a `TKT-…` reference read aloud **and** a matching row in the support portal |
| knowledge | ask something outside the old seven topics — "what does a plan cost", "do credits expire", "who decides how urgent my ticket is" | answered from the new corpus, with the **current** prices |

**The support ticket cannot pass until this branch is deployed.** The tool is
bound on the assistant and the handler exists in `voice-tools.server.ts`, but
the handler is in this branch and the webhook runs what is on `main`. Until
then Monica will call the tool, get `unknown_tool_raise_support_ticket`, and —
correctly — tell the caller it was not logged and offer to put them through.
That is honest, and it is still a failure; it is strictly better than the
previous state, where she could neither log it nor transfer.

The webhook's shared secret is **write-only in VAPI** (`serverUrlSecret` reads
back only as `isServerUrlSecretSet`), so the handlers could not be exercised
directly from here either. That is the right design and it is recorded, not
complained about.
