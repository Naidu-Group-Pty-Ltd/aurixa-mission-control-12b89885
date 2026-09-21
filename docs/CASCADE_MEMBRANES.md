# The membranes between cascade layers

21 September 2026. What may cross from one deployment to the next, decided per
**edge** rather than per fleet. Companion to
[`THE_CLONING_ENGINE.md`](./THE_CLONING_ENGINE.md) (the three engines and their
drains), [`CASCADE_ON_MERGE.md`](./CASCADE_ON_MERGE.md) (what fires a cascade)
and [`FLEET_SYNC_STALL_2026-09-20.md`](./FLEET_SYNC_STALL_2026-09-20.md) (the
incident that made the need obvious).

Read this before touching `src/lib/cascade/membrane/*`, the membrane block
in `cascade-engine.server.ts`, or the band on the Yggdrasil diagram.

---

## The shape of the problem

A cascade copies the files it was told to copy and knows nothing about what
depends on them. It fails in exactly two ways and **both report as a healthy
import**: it brings the half that makes a claim and leaves the half the claim
is about, and it silently reverts what a downstream deployment had decided.

Both were measured on this fleet in the week before this shipped.

| what happened                                                                                      | where                                            | how it reported                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| A cascade wrote GoHighLevel function names back over a clone's provider routing, undoing PR #7     | `npc-crm-independent-6505dc`, PR #9, seven files | **green** — nothing failed; replies would simply have gone back out through GoHighLevel |
| A cascade reverted a person's recorded security decision (three `crm-*` entries, `reviewed: true`) | same clone, `39600d3` → reverted                 | **green** on the cascade, then 43 consecutive red CI runs on the clone                  |
| 21 specs delivered whose subjects did not travel                                                   | same clone                                       | four assertion failures naming the half that arrived                                    |

Nothing in the engine was wrong about any individual file. What was missing is
a statement of **what this particular boundary is for**.

## Ions, channels and pumps

The analogy is load-bearing rather than decorative, and it is worth being exact
about which parts of it are claimed.

- An **ion species** is a class of code chunk that a boundary may have an
  opinion about — a GoHighLevel function name, a security baseline, an edge
  function declaration, a test specification, a backend project reference.
  `ionSpecies.pure.ts` classifies a file's text into zero or more readings.
  A file that carries none of them is not a species and crosses untouched.
- A **channel** lets a species through, or does not. It is `open`, `closed`,
  or `gated` — gated meaning the answer depends on the _delivery_ rather than
  on the file, and cannot be settled by looking at one chunk.
- A **pump** moves a chunk across and **changes it on the way**, so the thing
  that arrives is the thing the downstream deployment needed rather than the
  thing the upstream one sent.

The distinction that matters: **a channel is a decision about one file; a pump
is a transformation that needs both sides.** Three pumps already ran here
before any of this was written — `reconcileConfigToml`,
`reconcileSecurityRegistry` and `reconcileDeployWorkflow` each deliver the
prime's file with the clone's own entries carried back into it. Six channels
already ran too. `fleetMembranes.pure.ts` names all nine on every membrane
rather than pretending the boundary began with this module.

## Eleven organs, nine of which already existed

| organ                           | kind     | what it refuses or transforms                                                                                           |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `clone_sync_exclusions`         | channel  | per-path rules recorded against this clone                                                                              |
| `REPOSITORY_INVARIANTS`         | channel  | thirteen fleet-wide patterns a module may not own                                                                       |
| `backendIdentityHold`           | channel  | a shipped file naming somebody else's Supabase project                                                                  |
| `securityInventoryHold`         | channel  | the prime's security baseline where this clone holds functions the prime does not — the gate the pump below runs behind |
| `judgingWorkflowHold`           | channel  | a workflow that judges the whole repository, on a clone that receives part of one                                       |
| `withholdReferencedDeletions`   | channel  | a deletion while a surviving file still imports what it would remove                                                    |
| `reconcileConfigToml`           | **pump** | the prime's config carrying this clone's `project_id` and declarations                                                  |
| `reconcileSecurityRegistry`     | **pump** | the prime's registry keeping this clone's own entries                                                                   |
| `reconcileDeployWorkflow`       | **pump** | the prime's deploy workflow keeping this clone's project references                                                     |
| `reconcileSecurityInventory`    | **pump** | a baseline counted from the config and registry this same pass reconciled                                               |
| `reconcileFunctionCountRatchet` | **pump** | the prime's function-count spec carrying this repository's own number                                                   |

## The two new channels

### A routed CRM name, in the browser layer only

The CRM distinction is the one the fleet actually has, and it is **measured
rather than declared**. Mission Control's `clones` row records nothing that
could answer it — `tags` is `[]` on both parents and `entitled_module_slugs`
is `[]` on the CRM-independent one — so the evidence is in the module header,
taken 21 Sep 2026 by reading the two repositories:

| repository                   | `crm-*` functions | `ghl-*` functions | routing table                |
| ---------------------------- | ----------------- | ----------------- | ---------------------------- |
| `npc-client-dashboard`       | 0                 | 37                | none                         |
| `npc-crm-independent-6505dc` | 3                 | 37                | `src/lib/crm/crmProvider.ts` |

**Both hold all 37 GoHighLevel functions**, and reading that as the difference
is how this gets built wrong. The CRM-independent deployment calls them when
`CRM_PROVIDER=ghl`. What it refuses is a ROUTED name spelled outside
`crmFunction()`, because that function is the whole routing table.

**The channel mirrors that clone's own guard and does not improve on it.**
`src/lib/crm/__tests__/crmIndependence.spec.ts` is the authority — it is what
turns the clone's CI red — so `ROUTED_CRM_FUNCTION_NAMES` is transcribed from
it: six names, **both columns** of the routing table, because spelling
`crm-send-message` outside `crmFunction()` bypasses the switch exactly as
spelling `send-ghl-message` does.

| ghl                            | native                                 |
| ------------------------------ | -------------------------------------- |
| `ghl-calendar`                 | `crm-calendar`                         |
| `send-ghl-message`             | `crm-send-message`                     |
| `sync-ghl-conversations`       | _(vendor step, no native counterpart)_ |
| `update-ghl-opportunity-stage` | _(vendor step, no native counterpart)_ |

plus `VITE_CRM_PROVIDER` itself, guarded by the same rule for the same
reason — a surface that reads the switch has bypassed the module that decides.

Two exemptions, both the authority's own and both stated as **rules rather
than lists of paths**: the router is exempt because it _is_ the routing table,
and a test is exempt because _a test that names a function is not a surface
that calls one_.

**The first version of this channel was wider, and that was a defect.** It
carried 24 GoHighLevel names, exempted nothing, and matched backticks.
Measured against the live clone, it would have held
`ClientConversationsTab.tsx` **on every pass** — a file whose CI is green,
because `'ghl-conversations'` and `'ghl-messages'` there are React Query cache
keys (`queryKey: ['ghl-messages', …]`) that reach no network at all. It would
also have held `crmProvider.ts`, which is the one file a provider change has
to deliver.

Divergence has a direction and **only one direction is cheap**. Narrower than
the authority lets a file cross that turns the clone's CI red — loudly, on the
clone, with the path named. Wider holds a file the clone would have accepted,
on a fleet whose signature failure is stalling for reasons nobody stated.

There is deliberately **no pump** here. Rewriting `'send-ghl-message'` into
`crmFunction("sendMessage")` means synthesising an import into a file the
engine has not parsed, and a pump that ships broken source is worse than a
hold that names what is owed.

### A spec crosses with its subject

`gated`, on every membrane, because it is a statement about consistency rather
than about any one deployment — and because **one file cannot settle it**.
`strandedSubjects` compares both trees against the delivery this pass will
actually make: a spec is held only where the subject it names is absent from
the clone AND is not among the files crossing in the same pass.

**It is judged against what the pass WRITES, not against what it proposed.**
`partition.write` is the _candidate_ set, and a candidate can still be held —
by the oversize rule, the workflow rule, the backend-identity rule or the
membrane's own per-file channels. A spec judged against the candidates crosses
beside a subject that was held three lines later, which is the exact shape
this channel exists to refuse. So it runs once, after the prepare loop and
after the three reconciles, over the finished delivery; a stranded spec is
taken back out of it rather than merely recorded beside it. It costs no extra
read, because the pass already holds the text of every `.ts`/`.tsx` it
carries.

**A subject the clone does not hold at all is out of scope, not stranded.**
The measured case is the stale one, in the incident's own words: _"Both
subjects EXIST on the clone, at their older versions."_ Extending the rule to
the absent case would hold a spec **forever**, with no act an operator can
perform — widening a clone's scope is a configuration decision with its own
review, and a contract test names repository paths as _data_. Those 21 specs
name 176 distinct paths between them, so nearly every spec in the fleet would
become a permanent hold. A channel whose refusals cannot be discharged is the
stall this module exists to prevent.

There is deliberately **no pump** here either, for the same 176 paths: a
companion pull would widen a module-scoped clone by that many files chosen by
a regex, which is a different and larger decision than the one this channel is
allowed to make.

## The rules that carry it

**A membrane is per EDGE, not per fleet.** An ion that crossed prime → parent
is asked again at parent → child. `npc-test-76b3b3` and
`preflight-property-group` descend from the CRM-dependent parent and inherit
its openness; nothing reaches them that did not first pass the boundary above.

**It is code, not rows.** `CLONE_PROVISIONING_GAPS.md` already paid for this:
provisioning copies a clone's schema and its migration LEDGER but not the rows
a migration INSERTs, so anything seeded by one is absent on every clone while
looking, from the ledger, exactly like it is present. A membrane that silently
resolved to "admit everything" on a deployment nobody had seeded is the
failure this module exists to prevent. `canonicalRegistry.generated.ts` and
`REPOSITORY_INVARIANTS` are both code for the same reason.

**An unknown edge is not a refusal.** `resolveMembrane` falls back to the
standing organs plus the orphan-spec channel, with no opinion about any
species this fleet has not measured on that edge. A clone provisioned tomorrow
must behave exactly as every clone behaved yesterday — a membrane that closed
on an unknown edge would stop the fleet rather than filter it.

**A hold names what is owed.** Every refusal is an ordinary `HeldPath` in the
vocabulary `partitionCascadePaths` already speaks, with `reason:
"manual_reconcile"`, so it reaches `reportableHeld` — the pull request body,
the withheld count and the "nothing to cascade" reason — by exactly the route
a listed path does. A hold nothing surfaces is a fleet that stops for no
stated reason, which is the shape of the 20 September stall.

**An `overwrite` approval does not release it, and that is the established
contract rather than an oversight.** Approvals are read and applied _before_
the prepare loop, deliberately: a released path then flows through that loop
and its content holds still run on it. `backendIdentityHold` and
`judgingWorkflowHold` have had exactly this property since they were written —
an approval releases a PATH rule, and a rule about what a file SAYS still gets
to refuse. So each membrane hold's note names a remedy an operator can
actually perform (route the change through `crmFunction()`; bring the subject
into scope or leave both) rather than pointing at a button that would not
work.

**The membrane is keyed by repository NAME**, not by clone slug, because
repository names are what `processClone` holds on both sides — `primeRef.repo`
upstream (already the PARENT'S repository for a lineage-routed child) and
`clone.github_repo` downstream. A slug would have to be threaded through an
argument that does not carry one, and a key the engine cannot supply is a
membrane that never resolves.

## On the diagram

Yggdrasil's diagram view draws a band across each branch: a bilayer with one
pore per channel the boundary declares. An open pore carries an ion across it,
a closed one is plugged, a gated one is plugged in outline. The pumps that
already run there are one count at the band's foot.

Two rules the drawing answers to.

**Colour never carries the state alone.** `--primary` and `--warning` are both
gold in this product's dark theme. The plug is a SHAPE — present or absent,
solid or dashed — so a closed channel survives greyscale, and the detail panel
prints the word beside every channel.

**The band sits on the curve, derived rather than eyeballed.** `TreeBranchPath`
draws a cubic whose control points are pulled horizontally by 15% of the run
and pinned to the vertical midpoint. Evaluated at `t = 0.5` the control offsets
cancel exactly in both axes, so the band's centre is the CHORD midpoint and
needs no curve-length solver. The tangent does not cancel, and using the
chord's direction instead would tilt the band visibly on the fleet's widest
branches:

```
B′(0.5) = ¾(P1−P0) + 1½(P2−P1) + ¾(P3−P2)
        = ( 1.5·dx − 1.5·k , 0.75·dy )
        = ( 1.275·dx , 0.75·dy )            with k = 0.15·dx
```

`membraneGeometry.pure.ts` is arithmetic on two points — it reads no DOM and
no clock — so the placement is asserted against an independent evaluation of
that curve rather than looked at.

**Selecting a clone says which boundaries it sits between.** The node panel
draws `membranesTouching(node.githubRepo)` — the edge above and the edges
below, each naming what is refused and what waits on a person. Read-only: the
band is the control, and two ways to open one panel is how the two come to
disagree about which is selected. It names refusals rather than counting
organs, because every membrane in this fleet carries the same nine standing
ones and a count of them prints the same number under every node. The prime's
absent inbound edge is stated rather than left blank, since a blank area reads
as a broken panel.

**A component is not shipped until something renders it.** The fleet has paid
for that rule twice in a row in the clones' builder portal: three components
with zero call sites, then 28 unmounted CSS classes. An unused export
typechecks, lints and builds — and this work committed it once, with
`membranesTouching` exported into nothing until the node panel drew it.
`membraneIsDrawn.contract.test.ts` asserts the mounting on the source —
presence, layer position (after the branches, before the nodes), the selection
keyed on the EDGE rather than on a branch index that a resize would renumber,
and that the node panel keys its summary on the repository rather than on a
clone uuid that would resolve no edge while looking exactly like a fleet with
no membranes.

## Where the modules live, and why that is load-bearing

The three judgement modules are in **`src/lib/cascade/membrane/`**, not under
`src/server/`, because the diagram reads the registry. TanStack Start's
import-protection plugin refuses a route whose chain reaches `src/server/**`
for a VALUE — rightly, since a module under that root is allowed to grow an
I/O dependency tomorrow, so the boundary is the PATH rather than the current
contents.

**`tsc` cannot see that rule.** `npx tsc --noEmit` passed clean on the very
commit `npx vite build` refused, four frames into a rollup stack trace. So the
position is stated in `membraneIsDrawn.contract.test.ts` as well: each of the
three modules may import `@/server/**` only as `import type` (which erases
before the bundler sees it — this is how `membrane.pure.ts` legitimately
reaches the engine's `HeldPath` vocabulary), and may otherwise reach only a
sibling or a module that has declared itself client-safe in its own header.
`@/lib/module-globs` is the one such dependency, and it does exactly that.

The engine imports the same modules from `@/lib/...`, which is a direction
this codebase already takes in a dozen places.

## What is asserted

| file                               | what it pins                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `membrane.test.ts`                 | permeation, the routing rule's reach, the glob scoping, the orphan-spec rule and the project-ref detector — over verbatim breached source from `ClientConversationsTab.tsx`, and against the shipped `backendRefsIn` itself rather than a restatement of it |
| `membraneIsWired.contract.test.ts` | that the engine resolves a membrane from `primeRef.repo`, asks it per file, ACTS on a refusal, judges specs against the finished delivery rather than the candidates, and takes a held spec back out of it                                                  |
| `membraneGeometry.test.ts`         | the band's placement, against an independent evaluation of the drawn cubic                                                                                                                                                                                  |
| `membraneBandRenders.test.ts`      | what the component actually EMITS — the placement survives, and no animated transform shares its element                                                                                                                                                    |
| `membraneIsDrawn.contract.test.ts` | that the band and the panel are rendered, in the right layer, keyed on the edge                                                                                                                                                                             |

Every assertion in the two contract tests was proven non-vacuous by planting
the defect it describes and watching it fail.

## What an adversarial review found in this work

Six confirmed findings, each verified by execution against the real modules
rather than by reading. Recorded because the _classes_ recur, not because the
instances were interesting.

**The band drew at the origin.** `<motion.g transform="translate(…)"
animate={{ scale: 1 }}>` renders at (0,0), unrotated. `buildSVGAttrs` in
motion-dom does `state.attrs = state.style` for any non-`<svg>` SVG element
and then lifts `attrs.transform` back into `style.transform`, so an animated
`scale` arrives as an inline `style="transform:scale(0.6)"` — and an inline
declaration beats a presentation attribute in every conforming engine. The
settled state is `transform: none`, because `buildTransform` returns the
literal "none" when every value is default. It typechecked, linted, built, and
the source read exactly as intended. **The lesson is the tool**: every other
guard here reads source, which is right for "is this mounted" and useless for
"does the browser honour it". `membraneBandRenders.test.ts` renders the real
component through the real library and reads the markup — no JSX and no DOM,
so it lives beside the unit tests. And the attribute's PRESENCE proves
nothing: both ship, and the assertion that catches it is that the placed
element carries no `style` at all.

**The membrane was keyed on whatever ref the caller held.** `processClone` has
three callers and only the live cascade resolves lineage; `cascade-dryrun` and
`regenerateCloneProposal` both build `primeRef` straight from
`prime.github_*`. With lineage on, the two grandchildren resolved a prime→child
edge this fleet does not have and fell through to the default membrane —
behaviourally identical today, and already printing an edge that does not exist
into a held row the repair path persists. It is keyed on the DESTINATION now
(`membraneInto`), which is the only identifier every caller reliably holds.

**The spec channel was blind to how a third of its subjects are written.**
`subjectsNamedBy` read one quoted literal, so
`readFileSync(join(ROOT, "docs", "reports", "X.md"))` yielded nothing.
Measured over the prime's spec corpus: **33 files name their subject only that
way**, and the live case is the 20 September incident itself —
`scoringMethodology.spec.ts` against `SCORING_V2_METHODOLOGY.md`, 3.0.0 on
prime and 2.1.0 on the clone. The channel was blind to an instance of the
exact failure it exists to refuse.

**A reused blob skipped the membrane.** The resume ledger short-circuits 119
lines before `permeate` and sets `content: null`, which also takes the file out
of the set the spec channel reads. Narrower than it looks: every per-file
judgement is a pure function of the file's own text, so an answer settled in an
earlier tick is the same answer now. A **spec** is not — its verdict is about
THIS delivery, and a resumed pass carries a different one — so a spec is never
reused. One file read given up for a verdict about the delivery being made.

**A hold reaches the operator and the Approve button cannot release it.**
Confirmed, and **pre-existing**: `cascade_path_approvals` is read and applied
before the prepare loop, so every content hold has this property —
`judgingWorkflowHold`, `securityInventoryHold` and the three reconcile holds
as well as the membrane's two. Only `oversizeHold` carries a different reason.
Deliberately not changed here: it is the established contract (an approval
releases a PATH rule; a rule about what a file SAYS still refuses), it reaches
five holds this work did not introduce, and each membrane hold's note names a
remedy an operator can actually perform. Recorded as fleet-wide rather than
papered over.

**And the one that was already closed.** `crossingPaths` was a snapshot of the
candidate set taken before the three reconcile pumps, so a spec naming
`supabase/config.toml` — nine of prime's specs do — read it as stranded on all
four clones while the pump delivered it in the same pass. Closed by moving the
channel to a post-pass over `treeEntries` after all three pumps, which was done
for an independent reason before the finding landed.

## Two things the review found in this work itself

Worth recording, because both are the classes this repository keeps paying
for and both were committed here first.

**An export with no caller.** `membranesTouching` shipped in the first cut
exported into nothing — the builder portal's defect, in the very feature whose
test asserts against it. It is drawn on the node panel now, which is where it
belonged.

**A comment that claimed a correspondence it did not have.** The `backend_ref`
detector read `\b[a-z]{20}\b` — any twenty-letter lowercase word — under a
header saying it was "deliberately the same shape `backendRefsIn` already
looks for". The shipped rule is anchored: `[a-z]{20}.supabase.co` and the
`"ref"` claim inside an anon key. The species is inert today, since no
membrane declares a channel on it, so nothing was firing wrongly — and that is
exactly what made it dangerous: whoever added the first such channel would
have inherited a detector that matches prose while its own header promised
otherwise. It is transcribed from the shipped rule now, and
`membrane.test.ts` **imports `backendRefsIn` and asserts the two agree** on
the same inputs rather than restating the regex.

## What a second review found, after the first one passed

Thirty-five adversarial agents were run against the finished feature, each
asked to DISPROVE one claimed defect by execution. Most claims died — two of
the loudest were mutation-coverage observations dressed as defects, and both
verifiers proved the engine's output byte-identical either way. Four survived,
and three of them were in the guards rather than in the work.

**A test that imported the constant it was testing.** `membraneGeometry.pure.ts`
restates `TreeBranchPath`'s 0.15 control-point pull, and the geometry test
built its "independent" reference curve from that restatement. An agent set
the constant to `0.42` to see whether anything would notice; 112 of 112
passed, and the number was **committed and pushed**. The band would have sat
on every branch at a tangent nothing drew. `DRAWN_PULL` is read out of
`tree-branch.tsx`'s source now and the module is asserted to equal it — and
the two "sits exactly on the drawn curve" cases are labelled as unable to see
this parameter at all, because B(0.5) is the chord midpoint for any pull.

**An assertion that could not fail for its own name.** _"is resolved once per
clone, not once per file"_ counted the call sites, and moving the declaration
into the per-file callback leaves the count at one. `tsc` caught that
particular move, because the post-pass then read an out-of-scope name — but an
edit that took the post-pass down with it would satisfy the compiler and
resolve the membrane ~830 times a backfill. It asserts the POSITION now.

**A path constant naming a file that does not exist.** `SECURITY_BASELINE_PATH`
was set to `docs/security/WRONG_NAME.json` and 193 of 193 passed. The channel
would never have matched, a changed security inventory would have crossed a
membrane that declares itself closed to it, and nothing would have said so —
this repository's own signature failure, committed inside the feature built to
prevent it. The three path constants here are second copies, forced by the
client/server module boundary (`ionSpecies.pure.ts` is reached by a route and
may not import a value from `src/server/**`). The copy is unavoidable; the
silence was not. `membraneIsWired.contract.test.ts` can import both sides, and
now pins each copy to the rule it restates.

**And four assertions that a formatter could turn red.** They pinned exact
source text, so a Prettier-legal reflow of the `permeate` call and a rename of
a two-use local both failed the suite with no behaviour change — while
`npm run lint` stayed green on both, since Prettier accepts either form. A
test that red-lights a rename teaches people to edit the test. They read the
property now: whitespace-tolerant on the call, and name-agnostic on the
crossing set, which is still asserted to be built from `treeEntries` and never
from `partition.write`.

## The defect the band found in the page it was drawn on

Rendering the real tree to check whether node labels overlapped the new band
found that they did — and, in the markup rather than the source, something
larger underneath. The node NAME label animated `y`, which framer-motion
routes through the transform pipeline on an SVG element, so it shipped
`y="448"` beside `style="transform:translateY(456px)"`. **Every node on
Yggdrasil drew its own name 456 units below itself**, nearly four levels down
the tree, on a page whose whole job is saying which clone is which. It
animates `attrY` now, which is the key that writes the attribute.

It is the same trap `membrane-band.tsx` documents from the other side: there
an animated `scale` displaced a `transform` PROP and drew the band at the
origin; here an animated `y` displaced a `y` ATTRIBUTE. Both are motion
routing a name through the transform pipeline, and neither is visible to
`tsc`, to eslint or to a source-scanning test. Both are now asserted against
rendered markup.

The overlap itself is closed twice over. The labels are captions rather than
targets — nodes paint after bands, so a status line crossing one was silently
taking its clicks; both decline pointer events now and the node carries a
stated hit circle of its own, so declining costs it nothing. And the ink is
cleared by making the caption say its status ONCE: it read `BEHIND · 12
BEHIND`, and the second word was most of the width that reached. Measured on
the fleet's own layout it now clears every band by a margin at any plausible
monospace advance.

`membraneClearsLabels.test.ts` is the standing form of that measurement, and
it is the only guard that could have caught the original. It drives the real
`useTreeLayout` over the recorded fleet, parses each caption's box out of a
real `TreeNodeCircle` render and each band's ink out of a real `MembraneBand`
render, maps the band's local coordinates onto the page through
`placeMembrane`, and asserts no ink falls inside a caption. Nothing in it is
restated: the one estimate is the monospace advance, which is bounded by
running the whole check at 0.55, 0.60 and 0.65 em rather than assumed at one.
Two things it caught while being written are worth keeping. It measures the
caption at REST, because `renderToStaticMarkup` returns an animation's opening
frame and the name starts eight units low — a transient crossing during a
half-second entrance, while both are still fading in, is not what a reader
looks at, and the band has no such offset because its placement is on a plain
`<g>` that motion cannot reach. And its first draft passed the suite while
`tsc` refused it, from a `let` assigned inside the probe component narrowing
to `never` — the same disagreement between gates that this whole branch keeps
turning on.

## The gate resolves by carrying

A spec and its subject travel together or neither does, and there are two ways
to satisfy that. Holding the spec leaves both. Carrying the subject brings
both — and on a clone that already HOLDS the subject and is merely behind on
it, which is every one of the fleet's measured 176, bringing both is what an
operator wants. Leaving both meant a standing backlog nobody was going to
clear by hand, one spec at a time, for ever.

So the spec channel now tries to carry before it condemns, and three things
bound it.

**A carried subject is judged by `prepareOne`** — the same function every
other write goes through, extracted from the prepare loop's lambda precisely
so it could be asked twice. It meets the oversize ceiling, the
judging-workflow rule, the backend-identity rule and this edge's own channels
on identical terms. Nothing is carried past a rule for having been MENTIONED,
which is the distinction between a caller naming rows and a caller asking
questions — the same one `airtableListingsRoute` turns on.

**A carried subject meets the PATH rules before the content rules**, which is
the order every other candidate meets them in. `planSubjectCarry` refuses what
`partition.held` already holds, and on a MIRROR that is enough: `candidatePaths`
there is every path whose SHAs differ, so a stranded subject — which differs by
definition — was partitioned and its exclusions applied. On a MODULE-SCOPED
clone it is not. There `candidatePaths` is the installed globs plus the
repository invariants, so a subject outside that scope was never put through
`partitionCascadePaths` at all, has no hold for the plan to see, and would have
been carried with its exclusions never asked. `backendIdentityHold` inside
`prepareOne` would still have caught the worst of it — but that is a different
rule catching it by luck rather than the rule that governs it. The carry is
partitioned through the same function over the same exclusions, so a protected
path is protected whether the clone installs the module it lives in or not.

**And a spec may not name a path outside the five top-level directories, or
one with a `..` segment in it.** The prefix rule was already there and refuses
`/etc/…`, `../…`, `.github/workflows/…` and root-level lockfiles — measured
against the real function, not reasoned about. `src/../../etc/passwd.conf`
satisfies it. Nothing downstream would have carried that, because a git tree
listing holds no `..` segment so it matches neither side and `strandedSubjects`
drops it — which is protection by consequence rather than by rule, on the one
place in the cascade where model-written prose becomes a filesystem path. It is
refused at the source now.

**A subject an existing rule already holds is never released by this.**
`planSubjectCarry` is handed the live partition and returns its refusals
rather than dropping them, so a `protected`, `oversize` or unapproved
`manual_reconcile` path stays held and the spec that named it stays stranded
_with_ it — now saying which rule stopped which subject, in an operator's
words rather than the column's.

**It answers to the pass's own clock**, through the same `shouldStop` the
prepare loop uses, and to a ceiling of `MAX_SUBJECTS_CARRIED`. Neither is a
failure: what fits is carried, what does not leaves its spec held exactly as
before this existed, and the hold SAYS which of the two stopped it — because
"we could not" and "we did not get to" send a reader to opposite places, a
rule to argue with or a pass to run again. A budget-stopped carry deliberately
does not hand the event back the way a budget-stopped prepare does: that one
would ship half a module's diff, while this one leaves a delivery that is
already coherent.

Two corrections worth keeping from writing it. The refusals are read from
`partition.held` at the moment the specs are held, not from the plan computed
at the top of the round — where every carried subject met a rule of its own,
those holds were pushed a few lines earlier and the plan predates all of them,
so the generic instruction would have printed on exactly the case with a
specific answer. And both `carryStoppedOnBudget` and `carryHitCeiling` were
computed and read by nothing for a first draft, which is this repository's own
signature defect committed inside the feature built to name it; they are on
the hold an operator reads.

## The two baselines stopped being merely withheld

`securityInventoryHold` and `functionCountRatchetHold` refuse prime's copies of
`docs/security/SECURITY_INVENTORY.json` and
`src/lib/security/auditRemediation.spec.ts` where a clone owns edge functions
the prime does not, and refusing is right — prime's numbers describe prime's
tree. **But a refusal leaves the clone's numbers describing the tree it had
BEFORE the pass**, and the pass changes that tree. So `security` and `verify`
go red on two files the cascade declined to write rather than on any it wrote
wrong, which is the shape the 20 September stall took. The hold's own note has
always named `npm run security:inventory` as the remedy and nothing has ever
run it, because this engine composes a git tree over the GitHub API and cannot
run npm.

`securityBaselineReconcile.pure.ts` computes them instead, and the hold is what
happens when it cannot.

**Six of the inventory's ten fields are computed; two are partitioned; two are
prime's.** The generator emits ten. Six are a function of `config.toml`, the
security registry and the set of function directories — all three of which the
pass has already reconciled, in memory, a few hundred lines above. The other
two are a function of the SOURCE of ~555 files, and reading those over the API
on every pass is not on; a reimplementation that agrees with the generator in
practice but not in principle is how code and test agree while only the server
disagrees. So they are **partitioned rather than recomputed**: the merged tree
takes prime's content for a delivered path and the clone's for every other, so
each path's contribution is whatever the corresponding inventory — written by
the same generator over its own tree — already attributes to it.

**The graph is carried only where it cannot matter.** The import lists name
PATHS, so that partition is exact. `statically_derivable_inter_function_graph`
does not: its entries are `caller->callee`, attributed to a DIRECTORY, so a
merged tree taking one file from each side cannot be split edge by edge. It is
carried only where prime's graph and the clone's are IDENTICAL. Measured
21 Sep 2026 against `npc-crm-independent`: 69 edges each, no edge in one and
not the other, while the imports differ by exactly two pairs and both are for
functions only the clone has. Where they differ at all it refuses and the
caller holds, which is the behaviour it replaces.

**The ratchet's rule is read out of the spec, never restated.** The spec counts
with a regex whose exact shape decides the number — unanchored, `[^[]*?`
running through prose — and this repository has already shipped a comment that
rule counted as a declaration (`CLONE_OWNED_MARKER`, closed the day before).
A copy of the rule here would be a second statement of one rule, so
`extractRatchetRule` takes it from prime's own file and refuses rather than
guesses: exactly one `CONFIG.matchAll(` in the file, a literal short enough to
be a regex, mentioning `functions`, and compiling.

**Validated by reproduction, not by fixture.** Fed the clone's own tree as the
merged one with prime supplying every path the two repositories share, the
reconciler emits `npc-crm-independent`'s committed `SECURITY_INVENTORY.json`
**byte for byte** — 27,867 bytes, the file that repository's own generator
wrote. The ratchet reconciler counts 416 against the 416 that clone's spec
asserts. Both are exercised against the real files rather than a sample,
because a fixture shorter than the product turns a real measurement into a
statement about the fixture.

Three properties are pinned rather than promised. It is a **fixed point** — the
engine hands it prime's file every pass, so a stacked note cannot happen in the
loop that runs, which is exactly why it is asserted: a stacked note compiles,
passes, and grows by four lines a pass for ever. A clone owning nothing prime
does not gets **prime's file byte for byte**, so "carry it unchanged" falls out
of the general rule rather than being a special case somebody has to remember.
And the note it writes is **driven through the spec's own counting rule** on the
composed file, rather than asserted about the template.

It is gated on the holds' own trigger and no wider: this reconciles precisely
where it used to withhold.

## What a second adversarial review found in the carry gate

Nineteen agents read the carry gate on 21 Sep 2026 and confirmed six defects
BY EXECUTION — replaying the real modules, not reasoning about them. All six
are in the gate merged a day earlier, and all six had this shape: the carry
runs LAST, over the finished delivery, so everything it adds is added over a
decision something else already made.

**A `protected` refusal reached the approval offer.** `needsReconcile` is
`reportableHeld(partition.held)` everywhere else, and that filter keeps
`protected` out on purpose — `decideHoldRelease` refuses a protected path
outright, so an approval drawn over one reports success and releases nothing,
for ever. The carry pushed its own refusals raw, and `partitionCascadePaths`
emits the exclusion row's OWN reason. On a module-scoped clone the trigger is
ordinary: a subject outside the installed globs was never partitioned before,
so it has no earlier hold to be recognised by, and `supabase/config.toml` —
which nine of prime's specs name — is `protected`. It is the defect
`approvalReachesItsHold.contract.test.ts` exists to prevent, one
reason-category over.

**A carried subject never met the import closure.** That closure's own comment
calls its placement "the whole safety argument": a module may not cross
without what it imports. It ran once, ~1,100 lines above the carry, over the
paths this clone's modules put in scope. A subject the carry brought in behind
a spec was a delivered module that had never been through it, so it arrived
without its imports and no later round could notice. It is a function now,
asked twice, and what it finds is OWED rather than written — fed back as a
stranded path so it meets `planSubjectCarry`, the exclusions, the ceiling and
`prepareOne` on the terms every other candidate does.

**The budget guard could not fire on an all-text delivery.** `shouldStop`
required `freshlyPrepared > 0`, and that counter is the resume LEDGER's: only
a binary file buys a blob, because text travels inline in the chunked
`createTree` chain. A carry is all text by construction, so the guard that
stops it running past its window was the one guard it could never reach, and
`cutShort: "budget"` was unreachable with it. It predates the carry and is
wider than it — the MAIN prepare loop had no wall-clock bound either on a text
pass, so a big one was killed by the platform instead of handing back a
resumable row. Counted in files read now, at the line where the read is
attempted rather than at each of the four exits below it.

**The belt shipped what it should have held.** `if (round >= maxCarryRounds)
break` stopped the loop, and holding a spec takes it out of the delivery —
which can strand another spec that named it. A bare break shipped that one
without its subject, the single thing this channel exists to prevent. The belt
turns CARRYING off now and the loop keeps going; with carrying off every round
holds at least one spec, so it settles in at most one round per spec. The
bound itself was also below its own worst case: carry rounds are capped at
200 and hold rounds at the number of specs, and a carried subject can itself
be a spec, so that set grows by up to the same cap while the loop runs.

**The carry re-delivered a path a pump had decided.** Every reconcile pump
drops prime's copy from the tree and then either writes a merged file or
leaves the clone's standing — the second writes nothing, because the merged
result IS the clone's file, and a dry run writes nothing for its own reason. A
path in neither `treeEntries` nor `partition.held` reads to the carry as
STRANDED, and the carry answers a stranded subject by delivering prime's RAW
copy. So a reconcile was undone inside its own pass, in its own steady state.
`SECURITY_REGISTRY.json` is the sharp case: it is a repository invariant
rather than an exclusion row, so nothing else in the carry would have refused
it. `reconciledPaths` records the decision and the carry reads it as part of
the delivery, which is what it is. A REFUSAL is not recorded — a held path is
one a spec naming it should still strand on.

**And a spec was told the wrong one of two things.** `carryStoppedOnBudget`
and `carryHitCeiling` are set once for the whole pass and were then stamped on
every spec held in every later round — so a spec whose subjects were each
permanently refused by a rule carried a note reading "we ran out of time" over
a list of reasons we did not, and an operator waited for a next tick to finish
something no tick can. Decided per spec now, from what refused ITS subjects.

Two things worth recording beyond the six. Closing the last two opened a
SEVENTH that the review could not have seen, because it did not exist yet:
`importsOwed` is cleared only of what was delivered or attempted, and a round
that can plan nothing attempts nothing — so a set of owed imports no plan
could reach would have spun the loop until the belt fired, thousands of rounds
later, each re-scanning the whole delivery. Keyed on an empty plan rather than
on `atCeiling`, which is also true of a round that truncated and carried the
rest. And eight assertions in `membraneIsWired.contract.test.ts` sliced a
fixed 400 to 3,000 characters after `planSubjectCarry({`: each had to be
widened every time a comment landed inside the loop, which is an assertion
people learn to edit. They read the loop by its own two code anchors now.

## The boundary the carry does not cross

Worth stating plainly, because none of the six defects above is it and a
reader who has just been told the gate "resolves by carrying" will assume
more of it than is true.

**The channel reads `deliveredSource`, which holds only what THIS pass
writes.** It is filled in one place from `prepareOne`'s `content`, and that is
set for a `.ts`/`.tsx` the pass prepared — so a path is judged only if it was
a candidate, which on a mirror means its SHAs differ. A spec sitting on a
clone whose subject went stale in some earlier pass is therefore never
re-asked: prime has not touched the spec, so the spec is not delivered, so
nothing strands and nothing is carried.

That is not the defect it sounds like. A stale subject is itself a path where
the two trees differ, so the ordinary write path delivers it — the carry is
for the case where a rule would otherwise have held the subject and taken the
spec down with it. What the carry does NOT do is sweep a clone for specs whose
subjects a PREVIOUS pass left behind. Nothing here is a backfill, and a pass
that delivers nothing judges nothing.

## What an acid test against the live fleet found

The work above had been checked against fixtures and against one replayed
proposal. On 21 September 2026 it was driven instead against **every repository
in the fleet at its real head**, and against the composed tree the deployed
cascade had actually written — 218 assertions across six sweeps, over
`npc-property-dashbord@cbd4f5d` and the four clones.

**The standard applied was the clone's own CI, not this repository's opinion of
it.** `npm run security:inventory` is one 61-line Node script with no
dependency beyond `node:fs`, so the composed tree can be materialised and the
clone's generator run over it. `reconcileSecurityInventory` is then correct
exactly when its output is byte-identical to what that generator emits — which
is the question `git diff --exit-code` asks in the `security` job, and the only
question that decides whether a proposal is green.

### The proposal that is open right now

`npc-crm-independent-6505dc` PR #13 (head `50ca3875`, updated 08:47 UTC) is
**red**, and both failures are the two this work closed:

- `security` — `config_declared_function_count` 416 → 417,
  `registry_function_count` 416 → 417, `exposure_class_counts.internal-service`
  26 → 27, as a byte diff against the clone's committed baseline.
- `verify` — `AssertionError: expected 418 to be 414` at
  `src/lib/security/auditRemediation.spec.ts:105`.

The composed `supabase/config.toml` on that head carries
`# [functions.X] block is read by the CLI as verify_jwt = true`, which is the
pre-`#251` marker: the spec's unanchored rule reads `functions.X` out of the
prose and counts a function nobody declared. Measured on that file, the
generator's line-anchored rule answers **417** and the spec's answers **418**;
with the merged marker (`[functions.<name>]`) both answer 417. So the deployed
engine is running code from before that fix — the repository is right and the
deployment is behind it, which is a fact about a release and not about a tree.

Replayed against that same head, the merged reconcilers produce the file the
clone's own generator produces, **byte for byte at 27,867 bytes**, and a ratchet
spec asserting 417 exactly once that is a fixed point under re-reconciliation.
Composed over all four clones the same way — three of which own no function the
prime lacks, the shape the fleet's one interesting clone hides — every
reconciled baseline equals its own generator's output and every ratchet count
equals its own `config_declared_function_count`.

### Two faults, and what each cost

**A baseline holding literal `null` threw out of the whole pass.**
`JSON.parse("null")` succeeds, and `null` is the one JSON value whose next
property access throws rather than answering `undefined`. The shape checks read
`inv.schema_version` straight off the parsed value, so the module that exists
to leave a hold standing instead took the clone's entire cascade down with a
`TypeError`. The registry's own parse was guarded one line below and the two
baselines' were not, which is the tell: the rule existed once and was missing
once. It is stated once now, in `parseJson`, for all three documents — every
one of them is something the generator emitted as a JSON **object**, and an
array is refused by the same sentence.

**`decideHoldRelease`'s header promised a guarantee its own test contradicted.**
It said `cloneSha === null` "always holds"; the approval branch above it
releases, and `heldEvidence.test.ts` has asserted that release since it was
written. The code is right and the prose was not: the evidence route asks
whether this clone's copy is unmodified prime content and with no copy cannot
be asked, while an operator's overwrite approval is a person deciding prime's
copy should stand here — which on a path the clone lacks reads as "create it"
and loses nothing of this clone's. What keeps a NEW file's arrival the content
rules' business is the `protected` guard, which is first and survives any
approval. The header now says that, and a test names the rule rather than
exercising it in passing.

### Three things measured and deliberately left alone

- **The graph refusal is honest.** `statically_derivable_inter_function_graph`
  is attributed to a CALLER, and `_shared` is the one directory the fleet
  composes from both sides — so a clone-only file under it carrying a
  `functions/v1/…` string makes the composed graph underdetermined from the two
  inventories alone. Measured: prime and every clone hold the same 69 edges
  today, and none of the five clone-only `_shared/crm/*` files names one. When
  that stops being true the reconcile refuses, and refusing is correct: the
  check is a byte diff, so a graph that cannot be computed exactly cannot be
  written green either, and the hold costs the pass the red check it already
  had.
- **`.git/…` is not refused by `isSafeRepoPath`, and is unreachable.**
  Candidates come from a git TREE listing, which cannot contain a `.git` path
  component. Recorded rather than guarded: a rule added without a measured
  defect is a rule nobody can retire.
- **`securityRegistryReconcile` refuses a registry it cannot reproduce byte for
  byte**, which is why a fixture built with `JSON.stringify` fails it. That is
  the guard working — a duplicated function key, which `JSON.parse` silently
  discards, fails in exactly the same way.

Everything else answered as its header said it would: the deletion path keeps on
every branch but a byte-identical prime version, the cap refuses a partial
approval and names the overflow, a single entry larger than the byte bound
becomes its own chunk rather than being dropped, an import cycle terminates, the
carry reaches its ceiling and resumes rather than losing subjects, and the merge
gate refuses PR #13 for a failing check rather than the billing note — because
`security` ran for 23 seconds, past the 20-second never-started ceiling, and
`verify` for 196.

## The invariant list was one document behind whoever last added a check

The two baselines above stopped being withheld, and the pass that proved it
went green on both — and then failed one step further on, at a step no
previous run had ever reached. `verify` had been dying at the ratchet;
with the ratchet fixed it got to the report-format suite and found two
assertions that had been failing silently for as long as they had existed
(npc-crm-independent PR #13, run 35601703085, 21 Sep 2026).

Both are the same rule broken in opposite directions.

**`scoringMethodology.spec.ts` travelled and the document it reads did not.**
It asserts `docs/reports/SCORING_V2_METHODOLOGY.md` states the version
constants the engine exports; the spec is inside a module glob, the document
is in `docs/`, and `docs/` was carried one named path at a time.
`docs/reports/SECTION_OWNERSHIP_MATRIX.md` was named on 20 Sep for exactly
this shape and the methodology was not, so the list was one document behind
the newest check — which is what a hand-list always is.

**`openLocationWiring.spec.ts` did not travel and its subject did.** It pins
the call text inside `supabase/functions/location-intelligence-service/
index.ts`, which is inside a module glob and cascades. Prime renamed an
argument `cbdCoordinates` → `destination` and shipped the new function beside
the old assertion.

`REPOSITORY_INVARIANTS` now carries `docs/**` and `src/lib/openLocation/**`.
Three things were measured before widening rather than after.

**Docs do not cascade at all, and the fleet had been hiding it.** Of the 13
documents prime changed in its last 40 commits, 12 had never reached the one
module-scoped clone — 6 stale, 6 absent. The other three clones are mirrors
and receive the whole tree, so `docs/` matching on 1443 of 1444 files there
is mirror residue and says nothing about delivery. That single clone's `main`
is one squashed commit whose title reads *"Restore the CRM security
declarations and deliver the two documents the cascade asserted about"* — the
same defect, patched by hand, before anyone named it.

**Nothing on any clone is lost by widening.** The one document the fleet
deliberately diverges on is `docs/CLIENT_FACING_MODE.md`, which differs on all
three mirrors and is already a `protected` exclusion — so `docs/**` is an
invariant narrowed by a path exactly as `.github/workflows/**` already is, and
the exclusion still wins because the engine applies exclusions after this list
builds the candidate set. On the module-scoped clone the seven differing
documents are all prime-ahead (18–189 lines behind, at most 13 lines of
superseded draft ahead) and none carries clone-specific content.

**A directory is safe for documents and would not be for source.** `docs/` is
64.7 MB and holds a 9.18 MB Airtable extract — over `CASCADE_MAX_FILE_BYTES`.
It is byte-identical on the clone, so it is never a delivery candidate and the
oversize hold never fires; what `docs/**` actually delivers is 367 KB of
markdown the clone lacks and six small updates. The asymmetry that matters is
that **a document imports nothing and executes nothing**. A spec does — which
is why `src/lib/openLocation/**` is one named directory and there is no entry
for specs in general: a spec for a module the clone never installed would
arrive importing code the clone does not have, and turn `verify` red for the
opposite reason. All eleven files in that directory are already present on
every clone, so carrying it introduces no import that was not already there.

Two contract tests were re-pointed rather than renegotiated:
`securityInventoryHold.test.ts` compared `i.pattern` to a path, which is a
statement about a glob's spelling rather than about what it reaches, so
widening the glob broke them while strengthening what they protect. They
match by path now, the way `repositoryInvariants.test.ts` already did and for
the reason it already gave.

## A skipped pass had no room to report its ceilings

A cascade whose every differing path was withheld returns `skipped` **before it
opens a pull request**. That matters more than it sounds, because the PR body is
the only place `reportableHeld` has ever been rendered: the "Needs a human"
section is composed some three hundred lines below the skip's `return`. All that
survives a fully-held pass is one line of `diff_summary`, and that line said a
count.

A count is the wrong unit for this hold. `protected` differs for ever by design
and an operator can read past it; `oversize` is a file prime **has**, the clone
**lacks**, and no cascade will ever deliver, because `CASCADE_MAX_FILE_BYTES` is
a ceiling rather than a decision. Folded into *"all 23 differing path(s) are
withheld by this clone's exclusion policy"*, the two are indistinguishable — and
the one that matters is the one that disappears.

Measured 21 Sep 2026, firing a manual pass at all three mirrors: every one
returned `skipped` on exactly that sentence, `0 merged · 0 PRs · 0 failed ·
3 skipped (of 3)`, while `npc-client-dashboard` sat **six template-library seed
versions behind prime** — v13 through v18, ~39.8 MB each against an 8 MB
ceiling. The three mirrors are chained (prime → NPC Client Dashboard → NPC Test,
Preflight), so all three are stuck at v12 together. The only way to learn any of
it was to query `cascade_results` by hand.

`oversizeHoldNotice` is that sentence's missing clause, and it is in the pure
module beside `reportableHeld` and `approvableHeld` because it is the third
question about the same set: what must be SAID, what may be OFFERED, and what
can never be either.

Four rules carry it.

**It rides on both readings of the skip, including "already in sync."** That is
the stronger claim of the two, and a clone missing a file prime holds is not in
sync however little differed — so if a ceiling ever holds a path on a pass that
reports no differences, the sentence carries the contradiction rather than hides
it.

**It is silent when nothing hit a ceiling.** Every mirror holds a dozen
`protected` paths on every pass; a notice that spoke there would be noise on
every skip for ever, and noise is how a real notice stops being read. A healthy
skip is byte-identical to before.

**Paths, not notes.** `oversizeHold` writes a ~250-character note per file and
six of them would bury the sentence they qualify. The note still travels in the
PR body on every pass that opens one; this is the summary field, and a summary
nobody finishes reading is the silence again at greater length.

**The lines may not open with a diff mark.** `inline-diff-summary.tsx` treats a
summary as structured when every trimmed line starts with `+`, `-`, `~`, `M`,
`A` or `D`, and draws each as a diff mark. A notice listing `- path` would have
rendered as deletions — the cascade claiming to have removed the very files it
could not deliver. The paths are indented instead, and a test asserts the
property rather than the spelling.

One thing this reaches for free: `cascade-dryrun.server.ts` has always forwarded
the engine's own words on a plan-less pass (`reason: patchSummary`, under a
comment saying "Its own words are better than a number"), so the impact card an
operator reads **before** firing now carries the clause too.

## What this deliberately does not do

- **It does not widen a clone's scope to a file the clone does not have.**
  Carrying a subject updates a file this clone already holds and is behind on;
  adding a path it has never had is a different act with a different blast
  radius, and `strandedSubjects` refuses to name one.
- **It does not rewrite source.** The two new organs are channels. A pump that
  synthesises an import is a pump that can ship a file that does not compile.
- **It does not read the database.** Every membrane is a literal in
  `fleetMembranes.pure.ts` with its measurement in the header beside it.
- **It does not fix the dry run's STRUCTURED fields on a skipped pass.** The
  impact card's prose now carries the ceilings, but `cascade-dryrun.server.ts`'s
  `!plan` branch still publishes `filesHeld: 0`, `oversizePaths: []` and
  `level: "green"` for a clone with two dozen held paths — a false zero beside a
  true sentence. Closing it properly means emitting `onPlan` from the skip, and
  the skip returns *above* where `deletionPlan`, `staleHeld` and `missingHeld`
  are decided: a plan emitted there would have to invent those three, which is
  the same class of lie one field along. It wants the skip moved below them, or
  a narrower published shape, and either is a change to the plan contract rather
  than to this sentence.
