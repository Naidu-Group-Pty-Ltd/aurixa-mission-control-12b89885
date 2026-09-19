# What a clone is called, and what its build is handed

Three defects on the creation path, found while closing the gap between "the
New Clone wizard was submitted" and "a clone exists, correctly". Each was
invisible to the whole 4,225-test suite, because each is an **absence** — of
coordination, of a caller, of a removal — and an absence type-checks, lints,
builds and ships.

---

## 1. A clone's name had two writers, and they disagreed

`provisionCloneCore` reserved a name through `allocateSubdomain`. The New Clone
wizard then called `requestCloneSubdomain` **from the browser**, a few lines
later, after the server function had returned, and wrote a different string
straight onto the row.

The browser's write was second, so the browser's write won. Measured on the live
fleet, 19 Sep 2026:

| `clones.slug` | `clones.subdomain` |
|---|---|
| `npc-crm-independent-6505dc` | `npc-crm-independent` |
| `npc-test-76b3b3` | `npc-test` |
| `preflight-property-group` | `preflight-property-group` |
| `npc-client-dashboard` | `npc` |

Both names are *reasonable* — which is exactly what made it invisible. The
wizard sends `slug` with a six-character idempotency suffix on it so a retry
reuses the same GitHub repository, and it knew perfectly well a hostname must
not carry a retry token. It just expressed that knowledge in a second write
instead of in the one input field that existed for it:
`ProvisionCloneInput.subdomain`, documented for precisely this and **never once
populated by anything**.

What went with the losing write was not the string. It was the rules:

1. **The taken-set check.** `reserveCloneSubdomain` allocates against every name
   another clone already holds, and suffixes on collision. The wizard's path
   checked `reserved_slugs` alone and let a collision reach
   `clones_subdomain_uidx` — so an operator got a raw
   `duplicate key value violates unique constraint` in a toast, about a clone
   that had in fact been given a perfectly good name a moment earlier.

2. **`subdomain_status`.** The reservation sets `awaiting_deployment`, under a
   comment saying `queued` "would promise a job that does not exist". The second
   write set `queued` anyway.

3. **The operator's own typed name.** It reached the second writer and never the
   allocator, so it was never checked against anything — and the reservation had
   meanwhile allocated a different name from the slug.

4. **The checkbox.** "Reserve a subdomain for this clone" controlled the wizard's
   second call and nothing else. The reservation block in `provisionCloneCore`
   ran unconditionally, so a clone whose operator unticked the box got a
   subdomain regardless.

### The rule

**One writer.** `provisionCloneSubdomain` reserves the name *and* asks for the
DNS record, and both surfaces come through it. The difference between them is
one flag, not a second implementation:

```ts
provisionCloneSubdomain({ cloneId, slug, preferred, refuseIfSuffixed? })
```

A name **derived** from a slug may be suffixed — nobody chose it, and
`npc-test-2` is a better outcome than a failed provision. A name a person
**typed** may not: `requestCloneSubdomain` passes `refuseIfSuffixed: true` and
answers `subdomain_taken`, the same word `checkSubdomainAvailability` already
uses, so the surface that checks before submitting and the surface that refuses
on submit cannot disagree. A refusal **rolls the reservation back**, because an
operator told "taken" who is then silently left with `acme-2` has the worst of
the three outcomes: a name nobody knows.

Two more consequences:

- **`subdomain: null` is a decision**, not an absent preference. `undefined`
  still means "derive one from the slug", which is what the agreement path has
  always had and still gets.
- **The reserved name is handed back** (`ProvisionCloneResult.subdomainFqdn`)
  rather than left for the caller to guess. A caller that guesses is a caller
  that can disagree, which is the defect in one sentence.

### The edge drain confirms a name; it does not assign one

`hooks.edge-drain` wrote `subdomain` back onto the row when a DNS record landed,
taking the value from the **job payload** — composed when the record was
enqueued. That restores a name the clone may have been detached from or
re-pointed away since: an allocation decision taken by a worker with no idea
what any other clone holds. The name is the **guard** now
(`.eq("subdomain", subdomain)`), not the value; a row that no longer holds it
matches nothing and keeps whatever it was changed to.

---

## 2. Two variables the pipeline could publish and nothing needed

`buildCloneEnv` took `aurixaApiKey` and `siteOrigin` and pushed them as
`VITE_AURIXA_API_KEY` and `VITE_SITE_URL`. Its only call site — the deployment
drain's `syncing_env` step — passed neither, and nothing in a clone reads either
name. No key was ever published.

That is not the same as harmless. The parameter's own doc comment read *"the
clone's Mission Control API key, already committed to its private repo"* — a
credential — under a `VITE_` prefix, which this module's header **opens** by
explaining is inlined into the JavaScript every visitor downloads. And
`refuseReason` would not have caught it: `SECRET_FRAGMENTS` omits bare `KEY`
deliberately (`ANON_KEY` and `PUBLISHABLE_KEY` are publishable by design) and
carries no `API_KEY`. The only thing between that key and the public bundle was
that no caller had got round to using the parameter.

Both are **removed rather than guarded**, for the reason the module already
gives for the service-role key: *a caller cannot pass what the type does not
name, and that is a stronger guarantee than a filter.* A clone that needs to
speak to Mission Control does it from its own Supabase project, where a secret
is a secret; its origins are derived server-side by `applyCloneDerivedConfig`
once the deployment is live, which is the first moment they are actually known.

`envPolicy.test.ts` asserts the **whole emitted set** rather than a list of
prohibitions, because a name arriving by accident is the failure mode and a
list of things-not-to-emit cannot see one nobody thought of.

---

## 3. `syncEnv` upserted and never removed

`removed: 0` was a literal in its return value. A name this pipeline stopped
emitting stayed on the hosting project for ever, and the next build inlined it —
which is not hypothetical, since §2 just retired two of them.

The obvious repair, *delete anything not in the set being pushed*, is wrong in
the direction this codebase keeps paying for: an operator's own variable, set on
the Vercel project for a reason nobody recorded, would go with it. That is the
correction losing to the document it corrects.

So removal is bounded by `MANAGED_ENV_NAMES`, a **declared** enumeration — the
same discipline `aml-idv-retention` uses for storage objects, where a new name
is invisible until somebody names it. A variable outside the list is somebody
else's and is never touched. **Retired names stay in the list**, because being
on it is what makes removal possible: dropping `VITE_AURIXA_API_KEY` from it
would strand that name on every project that already has it.

Three things the order and the guards buy:

- **After the write, never before.** A prune that runs first and then fails to
  write leaves the clone with neither value; this way the worst case is the
  state we already had.
- **An empty set is not a clear-down.** It is what a deployment whose backend
  has not reported yet produces, and removing the managed set there strips a
  working clone's Supabase pair.
- **A stale `VITE_TURNSTILE_SITE_KEY` is worse than none** — it draws a CAPTCHA
  that verifies against a secret this deployment no longer holds — so it is
  declared managed even though it arrives through the open `extra` passthrough.

---

## 4. The wizard's submit was a script the browser ran

`provisionClone` returns, and then the browser makes four more calls — the
backend, the edge attach, the Turnstile widget, the sending identity — each
`await`ed in sequence, each non-fatal, each with its own toast. Close the tab
between any two of them and the clone is half-provisioned, with nothing
anywhere recording what was asked for.

Two of the four could not recover from that, and they fail in different ways.

**The backend cannot recover at all.** *Nothing else in the platform creates a
`clone_backends` row* — not the deployment drain, not a sweep, not a repair.
So an interrupted submit leaves a clone with a repository, a queued deployment,
`isolated_tenant: true` and no backend, for ever. The admin password went with
the tab.

That is worse now than it was, because of §-the-dependency-wait in
[`DEPLOYED_BUNDLE_IDENTITY.md`](./DEPLOYED_BUNDLE_IDENTITY.md): `syncing_env`
waits on the backend, and a wait that names a `progressing` dependency never
times out. So the fix there had to be paired with a rule of its own —
**a dependency reading has to be earned by observing something**. With no
`clone_backends` row, the drain names no dependency and the elapsed-time rule
applies exactly as it always did, because "nobody is building this" is not
progress.

**The sending identity recovers, onto the wrong domain.** The drain calls
`advanceEmailIdentity` at `syncing_env` with no domain at all, and that
function falls back to `deriveSendingDomain(clone)` when it finds none
recorded. So a browser that never reached the second call did not *fail* — it
quietly started an identity on a domain nobody chose, which is the harder of
the two to notice.

Both now travel **with the submit**. `ProvisionCloneInput` carries `backend`
(region and the admin credentials, validated as a pair before anything is
created) and `sendingDomain`, and `provisionCloneCore` performs both, in one
server call, from one set of inputs.

Three things hold it:

- **The password is on a shorter path, not a new one.** It reaches the same
  queue it always did, encrypted at rest by `enqueueCloneBackendProvisioning`
  and cleared once the worker seeds the admin user. What changed is that it no
  longer has to survive a round trip through a browser to get there.
- **The backend is enqueued BEFORE the deployment**, because the deployment
  waits on it: queueing a deployment first means queueing a wait whose
  dependency does not yet exist.
- **Non-fatal is not unobserved.** Every one of these is wrapped, because a
  clone that exists with a gap is repairable in one click while a provision
  that threw after a GitHub repository existed is not — but each failure
  reaches an operator through `warnOnClone`, since a console line nobody reads
  is not a report.

`moduleIds` is deliberately *not* repeated in the backend payload: provisioning
has already written the authoritative set to `clone_modules` and the backend
pipeline reads it from there, so the two tracks cannot drift if the picker
changed mid-submit.

Turnstile stays in the wizard. It is the one of the four the platform already
recovers correctly — the drain mints it at `syncing_env` and a ten-minute sweep
mints it unattended — so moving it would change where a working thing happens
for no gain.

---

## What is asserted, and how it was checked

Every rule above is stated over the source or over a pure function, and **every
assertion was planted before it was trusted**. Twenty-eight violations,
twenty-eight caught, each by exactly the test that claims to catch it — one of
them only on the second attempt, because the first plant silently replaced
nothing (a `perl -0pi -e` that reported zero substitutions against text
prettier had since reflowed). A plant that does not change the file proves
nothing, so the count of substitutions is part of the check:

| planted violation | caught |
|---|---|
| the edge drain assigns a name again | yes |
| the wizard calls `requestCloneSubdomain` again | yes |
| the wizard stops sending its subdomain decision | yes |
| `provisionCloneCore` reserves without enqueueing | yes |
| the explicit decline is ignored again | yes |
| a typed name may be suffixed | yes |
| a refused reservation stops rolling back | yes |
| the reserved name is never handed back | yes |
| the `VITE_AURIXA_API_KEY` parameter comes back | yes |
| `VITE_SITE_URL` comes back | yes |
| a fifth emitted name arrives by accident | yes |
| the managed guard is dropped (prune deletes anything) | yes |
| a retired name is dropped from the list | yes |
| the Turnstile key is not declared managed | yes |
| an emitted name is missing from the list | yes |
| the pushing guard is dropped (prune removes what we wrote) | yes |
| name comparison becomes case-insensitive | yes |
| the prune is removed / moved before the write / decides for itself | yes |
| an absent backend row reads as `progressing` again | yes |
| the dependency state is hard-coded `progressing` | yes |
| the backend wait stops passing its dependency | yes |
| the server-side backend enqueue goes away | yes |
| the server-side email start goes away | yes |
| the operator's typed domain stops travelling | yes |
| a failure stops reaching an operator | yes |
| the wizard stops sending the backend | yes, on the second attempt |
| `refresh` mode is used where only `provision` creates | yes |
| the admin credentials are dropped from the payload | yes, by the type |

The suite passed before every one of these fixes and passes after. That is the
finding worth keeping: 4,225 tests could not see a second writer, a dead
parameter or a missing removal, and only a rule stated *about the code* can.
