# Prime merges, the clone follows

Read this before touching `/hooks/github`, `cascade-trigger.server.ts`,
`processClone` in `cascade-engine.server.ts`, or
`server/cascade/syncExclusions.pure.ts`.

## The pipeline was never broken. It had nowhere to go.

`/hooks/github` has verified an HMAC signature and accepted every push to
prime's default branch since **2026-04-23**, and asked for a cascade each time.
Measured in the live database:

```sql
select metadata->>'reason', count(*), min(created_at), max(created_at)
  from audit_log where action = 'webhook.skipped' group by 1;

 "No clones registered" | 1553 | 2026-04-23 03:24 | 2026-08-26 04:43
```

**1,553 deliveries, one reason, four months, and `cascade_events` had zero
rows.** `createCascadeForAllClones` selects from `clones`, finds nothing, and
returns `"No clones registered"`; the webhook records the skip and answers 200,
so GitHub sees a healthy endpoint and nothing anywhere reports a problem. That
is why 159 files of drift accumulated between the prime and
`npc-client-dashboard` and had to be carried across by hand.

The lesson is the one this platform keeps relearning in different clothes: a
green signal about the wrong question. The webhook was asked "did the delivery
succeed?" and it always had.

## Three things had to be true, not one

**1 · Something to cascade to.** `clones` is the registry. Registering
`npc-client-dashboard` is what turns 1,553 skips into work.

**2 · A scope that can express "the whole application".** The engine cascades
the file globs of the modules INSTALLED on a clone. A mirror has no modules — it
*is* the prime with one build flag flipped — so a registered mirror with an
empty `clone_modules` still skips, now saying "No installed modules".
`clones.sync_scope` adds `mirror`, which diffs the two repositories by **git
blob SHA** instead.

Blob SHAs matter for cost, not elegance. The module path re-reads both sides'
*content* to decide whether a file changed: two API calls per file, fine for a
module and impossible for a tree of several thousand against an hourly budget of
5,000. Git already hashed every file, so `prime[path] !== clone[path]` is the
same answer for two calls total, and content is fetched only for what actually
differs.

**3 · A list of what must never be written.** This is the safety-critical part
and the reason the other two are not enough on their own.

## A clone's identity is not a file the cascade owns

Inside the mirrored tree are files whose entire purpose is to differ. The worst
of them is `src/integrations/supabase/env.ts`, which names the Supabase project
the deployment talks to. Its own header records what happened the last time it
resolved to prime's: **the deployed client dashboard served the PRIME's
production database, and signing in authenticated against real staff accounts.**

A cascade that overwrites that file does not fail. It succeeds, reports green,
and asks the hosting layer to redeploy. Nothing downstream of the commit can
distinguish it from a correct sync — which is exactly why the decision is made
before the blob is written, from `clone_sync_exclusions`, a table an operator can
read.

Two reasons, both withheld, only one silent:

| reason | meaning | in the pull request |
| --- | --- | --- |
| `protected` | the clone owns this file outright — config, identity, the fail-closed workflow guards | counted, not listed |
| `manual_reconcile` | the clone's version is a deliberate **superset** of prime's | listed by name, with why |

`src/App.tsx` is the second kind. The clone carries route gates prime does not,
so taking prime's copy would revert real work — but skipping it *silently* means
the clone never learns about a new upstream route. Both failure modes are real;
only one of them is quiet, so that one gets a section in every pull request.

### A list only protects what somebody remembered

That table was written from `docs/CLIENT_FACING_MODE.md`, which is an honest
place to start and not a complete one. On 26 August the first real mirror
cascade wrote prime@14af87a over 57 paths, and **two of them carried this
clone's own divergence and were in nobody's list**:

- `public/lead-magnet-embed.html` — served verbatim out of `public/`, and it
  hard-codes a Supabase URL *and* an anon key. Prime's pair is prime's project.
  The clone had fixed this two days earlier, under a commit whose subject was
  *"A live lead form was writing this clone's leads into the prime's database"*;
  the cascade wrote prime's copy straight back over it, so for the twenty-eight
  minutes between that merge and the repair the lead-capture form on the
  clone's own domain was posting names, emails and phone numbers into the
  prime's database again.
- `src/lib/reportTemplate/__tests__/renderAssetNormalisation.spec.ts` — the
  clone derives the fixture's project from `SUPABASE_URL`; prime hard-codes its
  own. This one *announced itself*: `compileTemplateHtmlForPdf` admits
  `SUPABASE_URL` and nothing else, so prime's literal is a foreign origin here,
  the compiler correctly drops it, and the assertion fails. It was the only red
  check on the next cascade's pull request.

Both are now in `DEFAULT_MIRROR_EXCLUSIONS`. That is the repair, not the fix:
the next file like them is also in nobody's list. So the property is guarded
directly as well, by `backendIdentityHold`.

### The content rule

Before a blob is written, if the path is one the clone **ships or executes** and
prime's content names a Supabase project that is not this clone's, the clone's
copy is read and compared:

| clone's copy | decision |
| --- | --- |
| names no foreign project | **held** — writing prime's would revert a fix |
| names one too | written — prime is moving, the clone is following |
| does not exist | **held** — a new shipped file naming another tenant |

Three things make it a guard rather than a nuisance.

**It is keyed on the revert, not on prime's content.** Three
`supabase/functions/**` files in the mirror name the prime today, inherited and
never fixed. A rule that fired on prime's content alone would report those on
every cascade forever, and a "needs a human" section that is never empty is one
nobody reads.

**Its scope is the clone's own isolation rule and no wider** — `src/**` less
tests, plus the whole of `public/**`, because every file in there is copied into
`dist/` untouched and is reachable on the deployment's domain. `docs/**` is
deliberately out: 185 tracked files in the mirror name the prime's ref, nearly
all of them prose and captured integration payloads.

**Unknown is not absent.** A clone with no registered backend has no "own
project" to compare against, so every ref counts as foreign and the handful of
paths that name one are held and named rather than written blind.

The extra read costs almost nothing: the clone's copy is fetched only for paths
whose prime content actually names a project — one file out of 71 on the first
mirror run.

### The constant had no caller

`assertMirrorPolicy`'s refusal tells an operator to *"seed it from
`DEFAULT_MIRROR_EXCLUSIONS` before cascading"*. Nothing in the application ever
did: the constant was referenced only by its own test, and the live rows had
been inserted by hand — which is why they were incomplete. Seeding is now a
migration, `20260826070000_seed_mirror_exclusions.sql`, generated from the
constant and re-checked against it by a test that fails on one changed
character. It is additive and idempotent: an exclusion an operator added
deliberately is not the migration's to withdraw.

A mirror registered *after* that migration still gets no rows — the constant
still has no caller on the registration path. `assertMirrorPolicy` refuses to
cascade into it, which is the safe half of the answer and not the whole of it.

## The rules that carry it

**Fail closed.** An exclusion set that could not be READ is not an empty one.
`requireExclusions` throws when the query errored or returned nothing, and the
engine records the throw as a failed cascade result. A cascade that ran without
its guard rails cannot be undone by noticing afterwards.

**An empty policy is legitimate for a module clone and never for a mirror.** A
module-scoped clone receives only what it installed and contests none of it. A
mirror with no exclusions means "overwrite everything", and that state is
reachable by ordinary means — register a mirror, forget to seed it.
`assertMirrorPolicy` refuses, and the refusal names the fix.

**One glob implementation.** `globToRegex` decides which files the cascade READS
out of prime and which it must NOT WRITE into a clone. Two implementations
answering the same question differently is how an exclusion silently stops
excluding, so it lives in `lib/module-globs` and both sides import it.

**Exclusions apply in both scopes.** A module glob that grows to cover
`src/integrations/**` would otherwise reach the clone's identity by a different
route than the one this was written for.

**A cascade never deletes.** A path present in the clone and absent from prime
is left alone — the clone legitimately carries files of its own (its isolation
spec, its transfer scripts), and a mirror that pruned them would remove the very
things that make it a clone rather than a copy. Prime-side deletions are counted
and named in the pull request, never acted on.

**A truncated tree is an error, not a small one.** A partial tree read as
complete looks exactly like a clone that is already in sync.

## One cascade per prime commit

A merged pull request delivers **two** webhooks that both mean "prime moved":
`pull_request.closed` with `merged: true`, and the `push` the merge itself
makes. They carry the same head SHA — `pull_request.merge_commit_sha` equals
`push.after` — so the SHA is what decides, not which delivery arrives first.

- `createCascadeForAllClones` looks for an existing `commit` cascade on that SHA
  and stands down if it finds one.
- `uq_cascade_events_commit_sha` is the backstop underneath for two deliveries
  racing, and a violation there is read as "already cascaded" rather than as an
  error, because it means the other delivery won.
- The index covers `commit` only. A **manual** re-run of the same SHA is how an
  operator retries a cascade after correcting an exclusion; a unique index that
  refused it would turn a repair into a constraint violation.
- A read that FAILED is not an absence: reporting "no existing cascade" on a
  database fault is how you get the duplicate this exists to stop.

A closed-but-unmerged pull request changes nothing on prime and does not
cascade. Direct pushes — this prime takes them from Lovable constantly — still
cascade on their own, because they simply find no earlier event.

## What lands on the clone

`prime_config.default_cascade_mode` is `pr`, so a cascade opens a pull request
on the clone rather than pushing to its default branch. The clone's own CI then
decides whether the change is safe, which is the point: the mirror runs the same
gates the prime does, and a cascade that would break it is caught there rather
than in production.

`auto_merge` and `notify` still behave as they did.

### One open proposal per clone, kept current

Opening a fresh pull request per cascade is what the first live run did:
prime merged eight pull requests in the minutes a fix was deploying, eight
cascades queued, and each opened its own pull request carrying **the same 57
files** — #27 through #34 on the clone.

They could not see each other. In `pr` mode nothing merges, so every one of
them diffed prime against a clone `main` no earlier cascade had changed, found
identical work, and proposed it again. "The first will win and the rest will
skip" is only true of `auto_merge`.

So `pr` mode now keeps one proposal and moves it forward, the way Dependabot
does:

| state | what happens |
| --- | --- |
| same tree as the open cascade PR | report that PR, open nothing |
| new tree | move that PR's branch to the new commit and retitle it |
| none open | open one |

The open proposal is found by branch prefix (`aurixa/cascade-`), not by author,
because the pull request is opened by whichever App installation is configured
and that is not a stable identity to match on. When several are open the
**oldest** wins — it is the one a reviewer is most likely already reading, and
after the duplicate storm there were eight.

Failing to LIST is not failing to find: if the lookup errors the engine falls
through to opening a new pull request. A duplicate is a tidiness problem; a
cascade that silently proposed nothing is not.

## What a held file never learns on its own

`manual_reconcile` holds a file back and names it in the pull request, because
the clone's copy has to win. That hold is correct and it is also a hole: the
cascade delivers a module and declines to deliver the file that wires it up, so
the two halves of one change land a commit apart, or never.

Two guards close it, and they fail in opposite ways.

**A removal is loud.** `findStaleHeldReferences` reads the clone's copy of each
held source file and asks whether it imports anything the cascade's own payload
has stopped exporting. That is how `src/App.tsx` came to sit on the clone's
`main` importing an `AmlIntakeQueue` that `AmlShellPages.tsx` no longer had —
every Vercel deployment failing, while the cascade reported the same
"1 awaiting manual reconcile" it reports on a healthy run.

**An addition is silent.** `findMissingHeldReferences` reads BOTH copies — the
clone's and the one the cascade declined to write — and asks what prime's copy
takes from a module this cascade delivers that the clone's copy takes from
nowhere. An import that is simply absent compiles perfectly. The clone does not
have the feature and nothing anywhere goes red. The AUSTRAC drafting routes were
caught only because a source test happened to assert them, which is luck rather
than a mechanism.

Comparing two held files in general is meaningless — they differ on purpose,
which is what "held" means. Comparing them on **one axis** is not, and the
restrictions are what keep it quiet: only modules this run delivers, only
symbols that module actually exports, and matched on the RESOLVED target so
`@/pages/x` and `./pages/x` are one module rather than an absence.

### And on a clock, because a cascade only sees its own payload

Both guards run inside a cascade, over the files that cascade touches. Drift on
a module no cascade has touched since is invisible to both: the guard never
runs, nothing goes red, and nobody is told.

`hooks/held-file-drift` is the part that comes back and looks anyway — hourly,
per clone, with no cascade running. It reads the clone's tree once, takes the
`manual_reconcile` source paths out of the same `partitionCascadePaths` the
engine uses, fetches both copies of each, and puts the result through
`findMissingHeldReferences` — the same function, so the sweep and the cascade
cannot reach two different conclusions.

Four rules carry it.

**It reports; it never repairs.** A held file is held precisely because this
platform is forbidden to write it. A sweep that pushed the missing import would
be the cascade overwriting a clone's own work by another route.

**The clone's own tree decides what exists.** A module prime's held file imports
from that the clone does not have at all is not a finding — that is ordinary
cascade lag, and the cascade's own guard will speak when the module lands.
Without that rule every open cascade becomes an operator notification.

**The plan decides what to FETCH, never what to REPORT.** `planHeldFileDrift`
is a pre-filter so a held file importing from forty modules costs one blob read
rather than forty. Two implementations of "what is missing" is how they come to
disagree.

**A standing finding is not news.** The gap persists until a person edits a file
this platform may not touch, so `decideDriftReport` compares an
order-independent fingerprint of the whole finding set against what was last
**observed** — not what was last announced. A clearance is recorded and not
announced, which is what makes a gap that came back audible again.

Measured on the live fleet: 7,910 paths, five held source files, eleven GitHub
calls, no findings. Against the clone as it stood the day before the routes were
reconciled by hand: one module read, one finding, named as
`AmlAustracReportDraft` from `src/pages/aml/AmlShellPages.tsx`.

## Mission Control's record of a cascade, and GitHub's

A cascade result reached `pr_opened` and stopped there permanently. Nothing ever
looked at the pull request again. The merge drain merged it on GitHub and wrote
an audit row; a person merging one by hand wrote nothing at all. Neither reached
`cascade_results`, `cascade_events.summary` or `clones`.

Measured on 30 August 2026, an hour after the fact:

| | GitHub | Mission Control |
| --- | --- | --- |
| PR #66 | merged 07:55 | `pr_opened` |
| PR #67 | merged 08:35 | `pr_opened` |
| both events | — | `0 merged · 1 PRs` |
| the clone | two cascades landed | `behind`, **140 commits**, pointer frozen |

The clone's card drew a green tick and the word `PR_OPENED` beside a badge
reading `AUTO MERGE` — three signals that together say "merged" about a pull
request nobody had merged.

`commits_behind` is the part that is not cosmetic. `runDriftRefresh` measures
drift **from `last_synced_sha`**, and only a `succeeded` result ever moved that
pointer, so a clone kept up to date entirely by the drain reports as
permanently behind and its drift number grows for ever.

### The rule

**The pull request's own state is the truth, and it is READ rather than
remembered.**

Not "what the drain did". That misses every merge a person performed, every
merge that landed while this control plane was down, and every proposal an
operator closed. One `pulls.get` answers all of them, which is also what lets a
record that fell behind *before any of this existed* be brought forward.

It is why the work list is Mission Control's **unreconciled rows** rather than
GitHub's open pull requests: a merged pull request is not open any more, so a
drain enumerating only open ones can never discover it. GitHub's open list is
read on top, so a pull request this engine opened but failed to record is still
merged when it goes green.

Three rules carry it. A summary has a **durable half and a perishable half** —
the engine writes which pull request and what it carries, which stays true
whatever becomes of it, and the drain owns the leading outcome sentence and
rewrites it every pass; blending them is what left rows reading "No check has
reported on this pull request" long after every check had. Everything derived
is **recomputed, never incremented** — the event's counts are tallied from its
results and the clone's pointer is taken from its newest merged cascade, so two
pull requests landing out of order cannot walk it backwards and a wrong record
repairs itself. And **a closed-unmerged proposal is `skipped`, never `failed`**:
nothing failed, and colouring the fleet red over a decision an operator made on
purpose is worse than useless.

### A drained merge rebuilds the clone

The engine requests a redeploy on its own `succeeded` path and its comment
explains why nothing else will: Vercel rebuilds on push only where its GitHub
App is installed, Mission Control forks clones through its own App and never
installs Vercel's, so on this fleet nothing else asks. A merge performed by the
drain reaches `main` exactly as a direct push does, and until now nothing
rebuilt after one.

### `auto_merge` gets the one-proposal rule too

`pr` mode learned this after eight cascades opened eight pull requests carrying
the same 57 files. `auto_merge` did not, on the reasoning that "the first will
win and the rest will skip". It does not: auto-merge does not merge on the spot,
it waits about seventeen minutes for `verify`, and prime moves faster than that.
Three prime commits inside thirty-one minutes gave the clone #67, #68 and #69 at
once, all carrying overlapping trees cut from a common ancestor — #67 merged and
the other two were left proposing changes to the same files, so at least one of
them could only ever land as a conflict.

Both modes now keep one proposal and move it forward. The drain merges oldest
first for the same reason: two proposals open together carry overlapping trees,
and landing the newer one first would put the older one's content on top of it.
