# The lateral membrane — between the two parents

23 September 2026. The boundary between the CRM-dependent parent
(`npc-client-dashboard`) and the CRM-independent one
(`npc-crm-independent-6505dc`), crossed both ways. Companion to
[`CASCADE_MEMBRANES.md`](./CASCADE_MEMBRANES.md), whose vocabulary it uses
throughout — ion species, channels, pumps, `permeate`, a hold that names what
is owed — and [`THE_CLONING_ENGINE.md`](./THE_CLONING_ENGINE.md) (the drains
this lane runs inside).

Read this before touching `src/lib/cascade/membrane/lateralMembranes.pure.ts`,
`src/server/cascade/lateralExchange.pure.ts`, `src/server/lateral-exchange.*`,
the lateral branch in `hooks.cascade-drain.tsx`, or the arch between the two
parents on the Yggdrasil diagram.

---

## What was asked, and the two things that differ

Every membrane before this one is VERTICAL: it sits on an edge of the lineage
tree and faces one way, from the prime (or a parent) down to the deployment
below it. The two parents never had a boundary between them, because nothing
ever moved between them — each is fed by the prime, and whatever either wrote
for itself stayed where it was written.

The ask was a membrane between them, **using the rulebook the fleet already
has, with one difference**: code changes made at the parent level move across
it, both ways, while every rule already drawn between the two branches still
holds. In the code that one difference is two rules, and only two.

**Only parent-level work crosses: a file the prime's history has never held.**
A vertical membrane filters everything the prime has. This one carries nothing
the prime owns or ever owned, because the vertical cascade already decides
those paths on both sides, and carrying one sideways as well would give one
path two authors and a cascade that argued with itself. The two lanes
therefore write disjoint sets of paths by construction — which is what lets
them run without knowing about each other. The vertical cascade never deletes
a file the prime never held (its deletion rule is history-based), and the
lateral lane never touches a file the prime ever held.

**Direction is read, not declared.** Neither parent is upstream of the other,
so a file moves toward the side still holding the version the other side left
behind, as each side's own history records it. Two sides that each changed a
file since they last agreed are held for a person. Nothing here merges two
authors' work into one.

Everything else is the existing rulebook, applied by the destination: its
module scope, its `clone_sync_exclusions`, the membrane channels, the
repository invariants, `judgingWorkflowHold`, the orphan-spec rule, the import
rule, the deletion rules, the file-size ceiling and the merge gate.

## What was there to carry

Measured at the real heads on 23 September 2026 — `npc-property-dashbord@2efa524`,
`npc-client-dashboard@6d88097`, `npc-crm-independent-6505dc@7253414`:

| reading                                                   | paths |
| --------------------------------------------------------- | ----: |
| differ between the two parents                            |   238 |
| … of which the prime does not currently hold (candidates) |    35 |
| … of which the prime's history once held (vertical's)     |     4 |
| … parent-level work, this lane's to judge                 |    31 |

Of the 31, **19 are the independent's** — 16 of them the CRM routing layer
(`src/lib/crm/**`, `supabase/functions/_shared/crm/**`, the three native
`crm-*` functions, `docs/crm/**`), plus a native-CRM migration, a document and
a spec — and **12 are the dependent's**: backend-isolation and clone-backend
tooling, a registry-prune workflow, two specs and a reminders fix. Every one of
the 31 is present on one side only and absent from the other side's history,
which is the simplest case the direction rule has.

The four the prime once held (`set-builder-stock-*-secrets.yml` on the
dependent, two `_*.tmp.mts` scratch files on the independent) are the vertical
cascade's to decide, and the lateral lane leaves them alone.

## One boundary, two membranes

A lateral boundary is not one membrane with a switch in it. It is the vertical
vocabulary declared **once per direction**, because what may enter a
deployment is a fact about the deployment being entered. The CRM line the
vertical membranes draw runs opposite ways across it:

| species             | into the independent                                   | into the dependent                                      |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `routed_crm_name`   | **closed** in `src/**` — route through `crmFunction()` | open — this deployment calls GoHighLevel by name        |
| `crm_routing_layer` | open — it is that deployment's own architecture        | **closed** — it would install a second CRM architecture |
| `edge_function`     | **closed** — source without its declaration            | **closed**                                              |
| `migration`         | **closed** — one database's history                    | **closed**                                              |
| `backend_ref`       | **closed** — another tenant's database                 | **closed**                                              |
| `hosting_ref`       | **closed** — another project's deployments             | **closed**                                              |
| `spec`              | gated on its subject                                   | gated on its subject                                    |

Four species were added to `ionSpecies.pure.ts` for this. Three are facts about
a PATH (`crm_routing_layer`, `edge_function`, `migration`) and one about text
(`hosting_ref`, Vercel's `prj_…` / `team_…`). `backend_ref` is also widened for
this lane: it matches the fleet's own twenty-letter project refs written BARE,
because `scripts/clone-backend/02-deploy-functions.py` names its database as a
string handed to the Management API and neither anchored shape matches it. The
list of refs is the fleet's own — every recorded clone backend, the prime's and
Mission Control's — because which refs exist is a fact about the fleet rather
than about the text, and an exact twenty-letter token is never an ordinary
English word. A read of that list that fails refuses the pass: without it, a
script handing another tenant's project to the Management API would cross as
an ordinary file.

**The new species change nothing vertically.** `permeate` refuses only on a
CLOSED channel whose species and glob match, and no vertical membrane declares
a channel for any of the four. The vertical engine also never passes the fleet
ref list, so its `backend_ref` reading is exactly the anchored one it was.
`lateralMembranes.test.ts` asserts the first against every vertical membrane in
the shipped registry, and `membraneIsWired.contract.test.ts` the second against
the engine's own source.

**Channel order is load-bearing.** A native `crm-*` function is both an edge
function and the routing layer, and `permeate` reports the first closed channel
a chunk trips. Into the dependent, the routing layer is declared first, so the
hold says "this must never arrive" rather than "bring it across with its
declaration" — a remedy for a file that must never arrive.

**An unknown lateral pair carries nothing.** `lateralMembrane(from, to)`
returns null for two repositories no boundary joins. That is the opposite of
the vertical default, deliberately: an unknown vertical edge must behave as
every edge did yesterday, and yesterday nothing moved sideways at all.

## The rules that carry it

The rules below run in `lateralExchange.pure.ts` and are wired in
`lateral-exchange.server.ts`. Each is the vertical rule, called rather than
copied, except where the lateral case genuinely differs — and those are named.

**Candidates are compared by blob SHA, never by content.** Present on one side
only, or on both with different blobs, and absent from the prime's CURRENT
tree. A path the prime holds today is dropped without a history call, because
the tree already answered.

**Origin is one `listCommits` page of one.** An empty page means the prime
never held the path; any commit at all means it did. `held` is remembered for
ever (a history is append-only); `never` is trusted for seven days, because the
prime may add the path tomorrow — and then its current tree says so on the
next pass anyway. A read that FAILED is neither: the path waits.

**Direction, from both histories** (`decideLateral`):

| the two sides                                             | what happens                                          |
| --------------------------------------------------------- | ----------------------------------------------------- |
| one holds it; the other's history never did               | **written** to the side that lacks it                 |
| one holds it; the other deleted exactly that copy         | **deleted** from the side still holding it            |
| one holds it; the other deleted a DIFFERENT copy          | held — deleted there, changed here                    |
| both hold it; one side once held the other's current copy | **written** toward the side that is behind            |
| both hold it; each has held the other's copy              | held — one of them went back                          |
| both hold it; neither ever held the other's copy          | held — both changed it; a person decides              |
| a walk did not reach the beginning of a history           | held — undecidable, and it says why                   |
| a history could not be read                               | deferred — an unreadable history is not an absent one |

**The destination's rulebook decides what enters** (`judgeLateralWrites`), in
the vertical order: scope, then `clone_sync_exclusions`, then the file's own
shape, then the membrane's channels, then the whole-delivery rules.

- **Scope.** A mirror is offered everything. A module-scoped destination is
  offered its installed modules plus the repository invariants for what is
  WRITTEN, and its installed modules alone for what is DELETED — the vertical
  engine's own sentence, "Invariants widen what is SENT; they never widen what
  is REMOVED." Both lanes read the installed globs through one reader,
  `installedGlobs.server.ts`, so a library pin cannot be honoured by one lane
  and not the other. The lateral lane reads a FAILED glob read as a refusal of
  the direction, never as an empty scope: every path an incomplete list omits
  would otherwise be REPORTED as outside the destination's modules, which is a
  statement about a deployment made from a read that failed.
- **Shape.** Only a regular or executable file crosses, and it carries its own
  mode: a script that crosses without its executable bit is a script that no
  longer runs, and a symbolic link written as `100644` becomes a file holding
  its target's path. The vertical engine still writes every file `100644`, as
  it always has. A file past the read ceiling stays where it was written.
- **Channels.** `permeate`, against the membrane INTO the destination.
- **Workflows.** `judgingWorkflowHold`, exactly as vertically.
- **A spec crosses with its subject, or not at all.** Vertically a stranded
  subject is carried in behind its spec. Sideways it cannot be, because the
  subjects a parent-level spec asserts about are, measured, mostly files the
  prime owns. So the spec waits until both parents hold the same copy of its
  subject.
- **A file crosses only where what it imports will be there.** The vertical
  lane repairs a missing import by carrying it; this lane cannot widen a
  payload, so it HOLDS the importer instead — where the target is absent on the
  destination and not crossing, or present but not exporting a name the file
  imports. A target the lane could not read leaves the importer unread rather
  than written.
- **An overwrite may not take away what the destination still uses.** It is
  held where a file the destination keeps imports something the incoming
  version no longer exports — the vertical cascade's own
  `findStaleHeldReferences`, asked with the destination's own work as the
  files that stay.

The last three need the whole delivery, so they run to a fixed point: a file
held leaves the crossing set, and anything that imported it, asserted about it
or relied on it arriving is judged again.

**Deletions cross only where they are provably unmodified work**
(`planLateralDeletions`). The deleting side must have held the exact blob the
other side still has; an exclusion on the destination claims the path; and
`withholdReferencedDeletions` keeps any target a surviving file still imports —
run to a fixed point, because a kept target is itself a survivor. If the files
that could import a target were not all read, every deletion waits. The
sentence a reader sees names the parent that deleted the file, never "Prime".

## How it runs

**A slot, not a timer.** The cascade drain ticks every minute; the lane takes
an idle tick whose minute falls on its ten-minute slot
(`LATERAL_CADENCE_MINUTES`). Only an IDLE tick: one that claimed a cascade,
raised the drift beacon or is starved of GitHub budget belongs to the prime's
cascade, which is always the more urgent of the two. The lane asks the budget
itself, at the scan floor.

**A due slot runs a pass only where something could have changed**
(`decideLateralRun`): no pass recorded yet, a head moved, a proposal was merged
or declined, the last pass deferred work, or a day has passed. The three heads
are fingerprinted, and the trees the pass acts on are read at exactly those
heads, never at whatever a branch points to a moment later.

**Proposals live on `aurixa/lateral-from-<origin>`** — one branch per origin,
and deliberately not `aurixa/cascade-…`: the vertical engine's proposal lookup,
the merge drain and the conflict resolver all key on that prefix and would
treat a lateral proposal as a prime cascade. A proposal a person has pushed to
is never rebuilt over: its commits are read before a replacement is built, and
the branch's head is read again just before it moves, because building a
replacement spends calls and a push can land in between. (GitHub's REST API
has no compare-and-swap on a ref, so the moment between that last read and the
write is the one window left.) A proposal a person closed unmerged is
remembered as a decline and not offered again for the same copies.

**The mode is the rulebook's own** — `prime_config.default_cascade_mode`,
which reads `auto_merge` in production. An auto-merge proposal lands through
the vertical cascade's own gate, `decideCascadeMerge`, once `verify` and
`security` pass on it; `pr` opens it and leaves it; `notify` decides and
records, and proposes nothing.

**The brake.** An operator can pause every lateral boundary. A pause stops the
slot from running at all and DISARMS GitHub's auto-merge on every proposal the
lane has open, because a pause that left an armed proposal to land on its own
would stop the lane and not the crossing. A pass an operator asks for while
paused proposes and never merges (`effectiveLateralMode`). Resuming re-arms
nothing; the next slot's gate lands what is green.

**The ledger is `audit_log`** — action `cascade.lateral_exchange`, entity
`lateral_boundary`, one row per pass carrying both the state the next slot
reads back (the fingerprint, the pause, open proposals, a memo of settled
questions) and the report a person reads. A slot that decides not to run writes
nothing, and a refusal repeated exactly is not written again, so the log holds
one row per thing that happened rather than one per ten minutes.

**Three operator doors, and no more** (`lateral-exchange.functions.ts`, all
behind `requireOperator`): read the ledger (asks GitHub nothing), run a pass
now — with `dryRun` it judges everything and writes nothing anywhere — and
pause or resume.

## On the diagram

Every vertical band sits ON a branch, because every vertical boundary is a line
of descent. The boundary between the parents is not one — nothing joins them in
the lineage — so it gets an edge of its own: **an arch from one parent's node
to the other's, with the band at its apex.** `lateralBand.pure.ts` is the
geometry, arithmetic on two points with no DOM and no clock.

**The arch is a cubic whose midpoint is exactly `sag` off the chord.** Both
control points are the chord's ends pushed `(4/3)·sag` along its normal; at
`t = 0.5` a cubic evaluates to `(P0 + 3·P1 + 3·P2 + P3)/8`, which is the chord
midpoint plus `¾` of that push. The tangent there is `1½·(b − a)`, parallel to
the chord whatever the sag, so the band stands square across the arch with no
curve solver. It is turned to whichever of the chord's directions points
right, so the same boundary never reads upside down because of where a
sibling landed.

**It bows toward the trunk, and that was measured rather than preferred.** The
parents' captions hang below their nodes; an arch bowed downward runs through
the name of the parent it leaves. `membraneClearsLabels.test.ts` draws both at
every corner of the layout's jitter and asserts the upward arch clears every
caption, node and vertical band while the downward one does not. The recorded
fleet alone would not have shown the second.

**An open passage at the centre, with a lane each way.** What this boundary
exists to carry is not a species — it is ordinary parent-level code, which no
channel names and `permeate` therefore admits. Drawn as a stack of pores alone
the band read as a wall of plugs (four species are closed both ways and the
fifth gated both ways), which is the opposite of what it does. So the arch runs
through an unconditional passage, and each direction's traffic flows along it:
the lane INTO the CRM-independent parent on the band's upper side and the lane
into the dependent below — the rows every pore's lanes use, whichever side of
the diagram the layout drew each parent on. The species pores split around the
passage, so the arch runs into neither a plug nor the wall.

**One pore per species, with a lane each way.** A lane is the membrane INTO the
side it moves toward, read straight off `boundary.toward`, which is how the CRM
line shows as two pores whose lanes disagree. Where a direction declares several
channels for one species, the lane shows the strictest — the drawing never looks
more permeable than the rule. A species a direction does not declare at all is
drawn **undeclared** (an arrow with a hollow dot, in the wall's grey), because
`permeate` admits it and the lane says so rather than inventing a plug. As on
the vertical bands, the state is a SHAPE and never colour alone: an arrow with
a solid dot for open, a solid square for closed, a hollow dashed square for
gated.

**The flow is timed by length, and never drawn under a node.** Particles ride
the arch translated by each lane's offset, using SVG `animateMotion`, which
measures progress by distance — so a fade keyed on the curve's parameter would
switch a particle off in the wrong place. Each particle is dark while it is
under either parent's node (whose glow is not opaque). Each direction also
carries one arrowhead on its own lane, a quarter of the arch's length in from
the parent it points into, because the flow moves and a screenshot does not.
Under `prefers-reduced-motion` the particles are not rendered at all; the
arrowheads and the passage still say the edge is crossed, and both ways.

**Selecting the band opens the lateral panel** (`lateral-detail-panel.tsx`):
the rule one direction at a time, chosen explicitly, since the two membranes
differ only where the CRM line crosses; a folded **"Reading the band"** key to
the drawing's marks, in the channel list's own words and ink
(`ChannelStateIcon` / `ChannelStateWord` in `membrane-lists.tsx`, shared with
the vertical panel so the two cannot drift); what the ledger says the lane last
did; and preview, run and pause. A run can open pull requests on two
deployments, so it asks twice; a pause is the brake, so it asks once. A reader
without the operator role is told so in a sentence rather than shown an empty
ledger, because `audit_log` refuses them and an empty panel would read as
"nothing has crossed". **Selecting either parent** names the lateral boundary
among the boundaries that node sits between.

## What the first pass would do

Run offline against the three real repositories at the heads above and the
live rulebook read from Mission Control (24 and 22 exclusions, 134 module rows
per clone, no library pins), through the production code with GitHub served
from local clones and every write refused: **7.7 seconds, 104 read calls, zero
write attempts, zero ledger rows.**

**Nothing crosses today, in either direction, and every hold is a rule the
fleet already had.**

| direction               | held | why                                                                            |
| ----------------------- | ---: | ------------------------------------------------------------------------------ |
| independent → dependent |   16 | the CRM routing layer (the three `crm-*` functions included, by channel order) |
|                         |    1 | the native-CRM migration                                                       |
|                         |    1 | `BUILD_TIME_ENVIRONMENT.md` names five Supabase project refs                   |
|                         |    1 | `buildDeclaresItsBackend.spec.ts` — its subject is prime-owned and differs     |
| dependent → independent |    6 | backend-isolation and clone-backend tooling names Supabase project refs        |
|                         |    1 | `vcr-prune.yml` names a hosting project and team by id                         |
|                         |    5 | outside the independent's installed modules — reported, not written            |

The five outside scope are `src/lib/__tests__/backendIsolation.spec.ts`,
`src/lib/__tests__/routeExclusionGates.test.ts` and the dependent's reminders
fix (`src/lib/reminders/priority.pure.ts`, its spec and
`src/pages/__tests__/remindersHubPriority.spec.tsx`). Checked again with the
engine's own `globToRegex` over the independent's installed globs: none of the
five matches.

**The reminders fix is not this lane's to carry, and the reason is worth
knowing.** PR #203 on the dependent (`9488817`, 18 Sep) wrote three new files
and edited two the prime owns — `src/pages/RemindersHub.tsx` and
`src/hooks/useAllReminders.ts`. The next vertical cascade that same day
(`be27114`) put both prime-owned files back to the prime's copy: all three
repositories now hold byte-identical versions of them. So what remains on the
dependent is the new module and two specs, while the page they fix is the
prime's again. That is the vertical lane's "silently reverts what a downstream
deployment decided" failure, one parent over, and the remedy is upstream: a fix
to a page every deployment serves is landed at the prime, and the vertical
cascade then brings it to both parents.

**What the live lane does on its first slot after deploy** is the same pass,
for real: no ledger row exists yet, so it runs, finds nothing to carry, opens
no pull request, and writes one ledger row saying so. Parent-level work written
from then on crosses as soon as a head moves, under the rules above.

### 26 September: the independent was out of sync, and this lane was not why

The report was that the independent had not been in sync since this membrane
went in. Two facts settle whether this lane is the cause.

- **The lane has never run.** The production deployment was published before
  this lane was merged. Its diagram chunk draws the vertical membranes and no
  arch, so no lateral pass has ever been attempted.
- **It would have carried nothing if it had.** Re-measured over both parents'
  heads, 32 files of parent-level work are candidates:
  - four were once held by the prime, so they are the vertical lane's;
  - 26 are held by rules the fleet already had;
  - two pass the membranes' channels and are held by the spec gate.
    `buildDeclaresItsBackend.spec.ts` (independent → dependent) asserts about
    `src/integrations/supabase/env.ts` and `supabaseTarget.pure.ts`, which are
    each parent's own backend identity. `routeExclusionGates.test.ts`
    (dependent → independent) asserts about `src/App.tsx`, which the two
    parents hold at different versions.

Code both parents share reaches the independent through the vertical cascade,
and that is what stopped. The independent's own history shows when:

- the last cascade to merge by itself was #22, at 05:25 UTC on 23 September,
  eighteen hours before this lane was merged;
- #23 went in by hand, through a repair pull request (#25) carrying the three
  files it could not deliver and this clone's own count in the Edge Function
  type baseline;
- #26 has not merged.

The timing is a coincidence: the deployment that built both predates this
lane. They were the two largest deliveries the independent had been sent (276
files, then 254), and they met two defects in the vertical engine. The Edge
Function type baseline one is fixed on `main` but not yet deployed. The other
was a missing half of the spec channel, and it is in
[*The other half*](./CASCADE_MEMBRANES.md#the-other-half-a-spec-the-clone-keeps-left-behind-by-its-subject).

## What is asserted

| file                               | what it pins                                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lateralMembranes.test.ts`         | the boundary joins the two parents and nobody else; the CRM line holds both ways; what never crosses either way; that the new species change nothing on any vertical membrane; every channel explains itself                                                            |
| `lateralExchange.test.ts`          | candidates, origin, every row of the direction table, the destination's rulebook in order, spec-with-subject, the import and overwrite rules, deletions to a fixed point, when a pass runs, memory, declines, the proposal text                                         |
| `lateral-exchange.server.test.ts`  | a first pass proposes both ways under each destination's rulebook; the next slot; a person's push, before or during a rebuild, is never overwritten; declines remembered; auto-merge through the vertical gate; the pause; a failed read never taken for an absent fact |
| `lateralBand.test.ts`              | the arch's midpoint and tangent against an independent evaluation; each pore's lanes; a lane never more permeable than its rule; the flow along the arch                                                                                                                |
| `lateralBandRenders.test.ts`       | what the component actually EMITS: where the band lands, each direction's marks, the flow and its arrowheads, the wall framing every mouth (the passage's included), an undeclared lane                                                                                 |
| `membraneClearsLabels.test.ts`     | the arch, band, particles and arrowheads clear every caption, node and vertical band at every corner of the layout's jitter; nothing lit is drawn under either parent                                                                                                   |
| `membraneIsDrawn.contract.test.ts` | the band and panel are mounted, in the right layer, keyed on the boundary; the panel's words come from the shared vocabulary; a selected parent names its lateral boundary                                                                                              |
| `membraneIsWired.contract.test.ts` | the vertical engine never passes the fleet's ref list, so the prime's cascade reads project refs exactly as it did                                                                                                                                                      |

The render and geometry guards were each proven non-vacuous by planting the
defect they describe — the passage's walls removed, a particle lit under a
node, a lane drawn more open than its rule — and watching them fail.

## What this deliberately does not do

- **It does not carry anything the prime owns or ever owned.** Not even a fix
  both parents want. A change to a prime-owned file is landed at the prime.
- **It does not merge.** Two sides that both changed a file are held, with the
  reason, for a person — every time.
- **It does not widen a destination's scope.** A file outside a module-scoped
  parent's installed modules is reported, not written, and an import that would
  need one is a hold on the importer rather than a second file carried in.
- **It does not rewrite source.** There are no pumps on this boundary. A file
  that names another tenant's project or hosting id stays until it reads that
  id from its own deployment's configuration.
- **It does not run ahead of the prime's cascade.** It takes only idle ticks,
  one pass per slot, and never a tick that claimed, beaconed or is starved.
- **It does not read the database for its rules.** Both membranes are literals
  in `lateralMembranes.pure.ts`; only a destination's own exclusions and module
  scope come from rows, exactly as they do vertically.
