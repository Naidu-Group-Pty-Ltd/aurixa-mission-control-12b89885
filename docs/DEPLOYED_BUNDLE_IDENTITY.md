# The bundle is asked which backend it names

**Status:** shipped, 19 Sep 2026.
Modules: `src/server/hosting/deployedBundleIdentity.{pure,server}.ts`.
Guarded by `deployedBundleIdentity.pure.test.ts` and
`bundleIdentityMounted.contract.test.ts`.

## What happened

A clone provisioned that morning could not be logged into with the credentials
Mission Control issued for it.

Every signal this pipeline holds was green, and each was telling the truth
about a different thing:

| signal | what it said | true? |
|---|---|---|
| `clone_backends.status` | `ready`, `schema_verified_at` stamped | yes |
| admin seed | created in `qvuwrvwzjyigptmnijyb`, `password_still_queued: false` | yes |
| `clone_deployments.env_synced_at` | five `VITE_*` written, production-targeted | yes |
| `last_build_state` | `ready`, 85 minutes after the env write | yes |
| `clone_health.pingDeploy` | `up` | yes |

And the deployed bundle carried none of it. Loading the domain in a real
Chromium and recording every host it contacts:

```
16  npc-crm-independent.aurixasystems.com.au
 3  dduzbchuswwbefdunfct.supabase.co          <- the PRIME
```

with a realtime socket opened under the prime's anon key. The clone's browser
was authenticating against another tenant's database, so a password written
into the clone's own project could not sign anybody in.

Reading each live deployment's entry bundle for its own project ref:

| clone | its project | what its bundle names |
|---|---|---|
| `npc-crm-independent-6505dc` | `qvuwrvwzjyigptmnijyb` | **the prime** |
| `preflight-property-group` | `egrmsulhtmqnmhvuccxr` | **the prime** |
| `npc-test-76b3b3` | `umrtusxohxjxzodxorim` | **the prime** |
| `npc-client-dashboard` | `plisdzywzleljorrphxv` | its own |

Three of four. The fourth escapes only because somebody rewrote its built-in
fallback constants to its own project.

## The cause was in the clone, and that is the point

The clone's `integrations/supabase/env.ts` read the environment through a
helper that took the variable's NAME (`import.meta?.env?.[key]`), which no
bundler substitutes, so every build resolved to its built-in fallback — the
prime's pair. That is fixed in the product repository
(`docs/operations/BUILD_TIME_ENVIRONMENT.md` there).

What matters here is that **Mission Control could not have known**. Nothing in
this pipeline had ever fetched the JavaScript and asked which project it names.
`envPolicy.pure.ts` refuses to *publish* an environment that names the prime —
a rule written after `npc-client-dashboard` served the prime's production
database on a custom domain for a week — and it is a rule about our inputs. It
cannot see the same outcome reached from the other direction: the environment
correct, the sync recorded, the build green, the artefact wrong.

## The rule

**Asserted by effect, never by configuration.** The same rule the retention
purge answers to (`oldest_live_created_time` rather than its schedule) and
`verification_selftest` (a real vendor rejection rather than a credential being
present).

### The build declares, and that is the answer

Reading the JavaScript for a project name **cannot settle it**. The prime's ref
is compiled into every build as `FALLBACK_URL`, so a correctly configured clone
names BOTH its own project and the prime's. Measured on a real build:

| what was read | bytes | verdict |
|---|---|---|
| `/version.json` | 89 | `carries_own` via `manifest` |
| the entry chunk | 5,036,633 | `carries_both` via `scan` — *unproven* |

So the product's `vite.config.ts` writes the resolved backend into
`version.json` beside the build id, through the **same pure resolver the
running client calls** (`supabaseTarget.pure.ts` in the product repository,
split out of `env.ts` precisely so a Vite config can import it — a config
cannot load a module that names `import.meta`). `source` travels with the ref,
because `fallback` and `env` send an operator to opposite remedies.

`probeDeployedBundle` asks for that first and **never fetches the bundle when
it gets one** — a few hundred bytes per clone per sweep instead of five
megabytes, and an answer instead of an inference.

### The scan is the fallback, and it says so

Every deployment in the fleet today predates the field, so the probe still
reads the served HTML, takes the entry asset, and asks whether it names this
clone's project, the prime's, both, or neither. `via` carries which route the
verdict came from, so "unproven" is never mistaken for "unchecked".

### The vocabulary, and why it has six values

| verdict | means |
|---|---|
| `carries_own` | the artefact names this clone's project and not the prime's |
| `carries_prime` | it names the prime's — customers are signing in to another tenant's database |
| `carries_both` | both appear; a resolved value beside a fallback looks like this, and which one the browser uses cannot be read off the text |
| `names_neither` | neither appears in what was read — **a fact about the scan, not about the clone** |
| `unreadable` | bytes arrived, the HTML named no entry script |
| `unreachable` | nothing arrived — **ours** |

`via` is `manifest` or `scan`. A declaration short-circuits the rest: nothing
is inferred, so none of the scan's caveats apply, and a declared ref that is
neither this clone's nor the prime's reads as `names_neither` rather than being
forced into one of them.

A ref FOUND is a fact about the artefact. A ref NOT found is a fact about the
SCAN, and collapsing those is the confident-clear-against-nothing failure the
product has already paid for twice (an empty sanctions register reading as "no
match"; a failed Places lookup reading as "zero hospitals"). So
`names_neither` is its own verdict and **is not a pass**, and a probe that
never arrived never demotes a deployment.

The CAPTCHA site key is reported as `not_scanned` rather than missing. It is
imported lazily and lands in a chunk the served HTML does not name — measured
on this very build, where it sits in `OtpInput-*.js`. Calling it "absent" from
a set that could not contain it would be the same mistake one field down.

### The scan widens only when it cannot say

One fetch of the entry chunk answers the question almost always — the module
that resolves the Supabase target compiles into it, because the client every
page imports is built from it. Pulling every preloaded vendor chunk as well
would spend three times the egress per clone per run to learn the same thing.
So the entry is read first, and the preloads are read **only** when the verdict
is `names_neither`. That is what the verdict is for: the honest response to an
absence is to search more before recording it.

### One re-sync per artefact, ever

`shouldRequestResync` is the `portrait_backfill` discipline. A re-sync fixes a
CONFIGURATION cause — the value never reached the build's environment. It
cannot fix a CODE cause: a bundle that reads its variables in a form no bundler
substitutes comes out **byte-identical** however many times it is rebuilt,
which is what happened here and to the Turnstile site key before it
(`requestEnvResync`'s own header records that one). So the guard is the
ATTEMPT and never its outcome, stamped in
`clone_deployments.bundle_resync_artefact`; a second wrong reading on a NEW
artefact is a fact about the clone's source, for a person to read.

### Recorded, reported, never demoting

The verdict is written on every probe including the ones about our own failure,
because `bundle_checked_at` with a `names_neither` is a different state from
never having looked. A wrong backend raises a notification rather than a status
change: the deployment IS live, and demoting it on a probe that can itself fail
would be a worse lie than the one this finds — the judgement `onLive` already
makes about a failed auth-config re-apply.

And it is **drawn**. `bundleIdentityReading` gives the card the four different
facts in its own vocabulary, and the block renders for every deployment that
has one — including the ones never probed, which read *"never read — that is
not the same as having checked and found it correct."* A card that draws
nothing for "never checked" cannot be told apart from one that checked and was
happy.

## Five other gaps closed in the same pass

**A `VITE_*` written outside `syncing_env` now nulls `env_digest`.**
`publishSiteKey` wrote the Turnstile key straight to the hosting project and
left the digest standing — and `syncing_env` SKIPS its push when the digest
matches, so the next build inherited whatever Vercel happened to hold. That is
the failure `requestEnvResync` documents as already having happened. The rule
is enforced over the class, not the one function:
`bundleIdentityMounted.contract.test.ts` finds every module that pushes to the
host and requires each to answer for the digest, with two named exemptions (the
drain, which sets it, and the provider adapter it writes through).

**A queued deployment starts itself.** `pending_platform` is excluded from
`CLAIMABLE`, so no drain ever touched it; its own status card said *"Queued —
the reconcile action will fan this out"* and only an operator pressing a button
ever did. The drain wakes them now, keyed on the ROW's own provider being
configured. `wakesWhenProviderConfigured` is deliberately narrower than
`isDormant`: `not_requested` is a DECISION, and deploying a clone whose
operator declined one is a worse failure than the dormancy this fixes.

**The plan the operator picked is applied.** `provisionCloneCore` wrote
`entitled_plan_slug` and the ticked `clone_modules`, and nothing resolved the
plan into `entitlement_keys` — the 2-minute drain claims `plan_change_events`,
which provisioning has never written, so the wizard was the one route that
skipped what the agreement path has always done at creation. Non-fatal and
reported: a clone with a repository and a backend is repairable in one click; a
clone whose creation threw after the repository existed is not.

**A wait knows what it is waiting ON.** Elapsed time was the only signal a
wait had, and `syncing_env` waits for the clone's own Supabase project to
publish its URL and anon key — a backend provisioning run measured in HOURS
(~7 edge functions a pass against 413 declared). Six hours of that is a
healthy clone being built, and `STUCK_HOURS` failed it: a wait became a
terminal status that nothing retries, on a clone where nothing was wrong. It
cuts the other way and harder — a backend that has already ended `failed` will
never write those columns, so six more hours of silence is six hours of a
deployment that could not possibly proceed reading as though it might.

`judgeWait` takes an optional `WaitDependency` now, and it outranks the clock
in **both** directions: `progressing` waits however long it has been,
`terminal` is stuck immediately. The parameter is optional so every other step
keeps exactly the reading it had, which is also why the CALL SITE is asserted
rather than the function — a step that quietly passes nothing type-checks and
keeps the six-hour failure, the same class as `statusSince: row.status_since`.
The two failures are told apart in the words an operator reads:
`error_message` is `blocked_dependency` rather than `stuck`, because "stuck"
means look at this deployment and "blocked" means look at the backend.

**Whether anybody can sign in is kept.** `seedAdminUser` verifies its own work
against the clone's store — `password_hash = extensions.crypt(pw, password_hash)`
is a real bcrypt check — and that `AdminSeedReport` reached `status_detail` and
nowhere else, which the finalising update overwrites in the same run. Exactly
the defect `parity_report.replication.*` was added for, one row up and on the
more consequential question. It has a column now, and a pass that did not seed
(a repair, which must not touch a tenant's credential) leaves the previous
reading alone rather than erasing it with the absence of a new one.

## What is asserted

Every assertion in `bundleIdentityMounted.contract.test.ts` is about an
ABSENCE, and each was **planted** before being trusted:

| planted violation | caught |
|---|---|
| `publishSiteKey` stops nulling the digest | yes |
| `onLive` stops probing the bundle | yes, after the first version was found vacuous |
| the drain declares the wake but never calls it | yes |
| provisioning stops reconciling entitlements | yes, after the first version was found vacuous |
| the admin seed report is dropped again | yes |
| the backend wait stops naming its dependency | yes |
| the dependency's state is hard-coded `progressing` | yes |
| `judgeWait` stops receiving what the step said | yes |
| one word is used for both failures | yes |
| the card block is unmounted | yes |

`deploymentState.test.ts` was planted the same way for the dependency wait
itself — removing either short-circuit, making `hoursIn` return a constant, and
letting it report negative hours on a skewed clock each failed exactly the
tests that claim to catch them.

Two of them passed on the first attempt and were wrong: `toContain("verifyCloneBundleIdentity")`
is satisfied by the dynamic import that destructures the name, and
`toContain("reconcileCloneEntitlements")` is satisfied by
`reconcileCloneEntitlementsNOPE`. Both are anchored on the CALL now. A rule
that names a word is worthless if something else can spell it.
