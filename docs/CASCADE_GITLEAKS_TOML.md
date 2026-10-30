# Proposal: derive each clone's `.gitleaks.toml` instead of protecting it

**Status: proposal, not implemented. The owner decides.** Nothing in the pull
request that adds this file changes how `.gitleaks.toml` is cascaded.

## What happened (30 Oct 2026)

Prime ca5009825 replaced the real Google key that
`scripts/security/check-security-gate-negatives.mjs` planted with a synthetic
one, and changed prime's `.gitleaks.toml` to allow the synthetic key in its
place. The two files changed together, and only one of them could reach the
clones:

- the script is an ordinary repository file, so it travelled;
- `.gitleaks.toml` is `protected` in `DEFAULT_MIRROR_EXCLUSIONS`, so every
  clone kept allowing the old key and gitleaks flagged the new one.

`security` went red on every cascade pull request that carried the script:
`npc-client-dashboard` 453, `npc-crm-independent-6505dc` 160, and then
`tutorial-demo-orrimere-c158c7` 1, `npc-test-76b3b3` 284 and
`preflight-property-group` 285. Each proposal described the hold as one of the
"further path(s) … owned by this clone and withheld without comment", so
nothing in it pointed at the cause. Each clone's `.gitleaks.toml` was then
edited by hand on its cascade branch, swapping the one allowlisted literal
exactly as prime had (176e535, 842b6efd, 1dd653a, 87a8511, db06be9).

The next prime change to that file will do the same thing again, five times.

## Why the file is protected, and why that is wider than it needs to be

The exclusion's note: *"Allowlists THIS deployment's own publishable anon key by
literal. Prime's copy would allow prime's key and re-flag the clone's."* That
is true, and it is the only per-deployment fact in the file. Provisioning
already writes that fact: `appendOwnKeyAllowlist` in
`clone-repo-retarget.server.ts` takes prime's file and appends one block naming
the clone's own key, leaving prime's literal in place because the prime's key
is in files every clone inherits.

Measured on each clone's `main`, 30 Oct 2026, by decoding every key the file
allows and searching the rest of the tree for it:

| Clone | Own project | Keys its scan allows | Needed by another file? |
| --- | --- | --- | --- |
| npc-client-dashboard | `plisdzywzleljorrphxv` | own, prime | both |
| npc-crm-independent-6505dc | `qvuwrvwzjyigptmnijyb` | own, prime | both |
| npc-test-76b3b3 | `umrtusxohxjxzodxorim` | own, prime | both |
| preflight-property-group | `egrmsulhtmqnmhvuccxr` | own, prime | both |
| tutorial-demo-orrimere-c158c7 | `fxqfhiiqdmzvsxbxvqcz` | own, prime, **the CRM line's** | own and prime; the CRM line's key appears in no other file |

With the comments and key blocks set aside, every clone's file has prime's
allowances. Two exceptions, both cosmetic: `npc-client-dashboard` has reworded
some descriptions, and it writes the PEM regex's quote as `'` where prime writes
`\x27`, which matches the same strings. So every clone's file is prime's file
plus its own key, with the prose edited by hand. Tutorial Demo's copy also
carries one stale entry. It inherited the CRM
line's file, which allows `qvuwrvwzjyigptmnijyb` under the description "This
deployment's own Supabase anon (publishable) key". Its scan therefore lets
another project's key through, which is the one thing the file's header says
must keep failing. The key is publishable, so the exposure is small, but the
file now contradicts its own header, and a protected file never corrects itself.

## The proposal

### 1. Reconcile it the way `supabase/config.toml` is reconciled

`configTomlReconcile.pure.ts` already handles a protected file that carries two
kinds of fact. It writes prime's `config.toml` and puts back the one line that
names the deployment. `.gitleaks.toml` has the same shape: prime's file, with
the clone's own-key block put back.

A `gitleaksReconcile.pure.ts`, called where the config.toml reconcile is and
writing through `reconcileWrites` in the same way:

- **Input:** the source's text (prime's, or the parent's for a child), the
  clone's current text, and the clone's own project ref from its
  `supabase/config.toml`, which the config.toml reconcile already reads.
- **Own key:** the allowance in the clone's current file whose JWT `ref` claim
  is the clone's own project. If there is none, or more than one, the file is
  held for a person (`manual_reconcile`) with that reason. The reconcile never
  writes a config that would reject the clone's own key, and never guesses
  which key is the clone's.
- **Output:** the source's text, minus any key allowance whose `ref` is
  neither the prime's project nor the clone's own, plus
  `appendOwnKeyAllowlist(text, ownRef, ownKey)`. The removal matters for
  children. A child reads its parent's tree, and without it the parent's key
  would be copied forward, which is how Tutorial Demo came to allow the CRM
  line's key. Two cheap ways to recognise the prime's project are the backend
  `SUPABASE_URL` and the ref in prime's `config.toml`. Never use a name.
- **The exclusion row:** `.gitleaks.toml` leaves `DEFAULT_MIRROR_EXCLUSIONS`,
  just as `supabase/config.toml`'s whole-file freeze gave way to its reconcile.
  The rule moves from "never write this file" to "write prime's file, with this
  deployment's key put back".

On the five clones as they stand, the first pass would replace each clone's
hand-edited header prose with prime's, and remove Tutorial Demo's stale entry
for the CRM line's key. Both are intended. One prime-side wording change should
go first. Prime's header says *"All 39 are `role=anon` for THIS project,
`dduzbchuswwbefdunfct`"*, which is false on every clone, and that sentence is
why the clones rewrote their headers. Re-worded to name the prime's project as
the prime's, the same text is true everywhere.

What it would have done on 30 Oct: prime's swap of the planted key is a change
outside the own-key block, so it would have reached all five clones on the same
pass as the script that plants the key. None of the five hand fixes would have
been needed.

### 2. Never silent: name a protected file that prime changed

Whatever happens to `.gitleaks.toml`, a protected path that prime changed in
the delivered range should be named in the proposal, under a heading such as
"Prime changed files this clone keeps as its own". Today a protected hold is
"withheld without comment" by design, and that silence cost a red `security`
check on five proposals with no line pointing at the file. This is the same
silence the kept-spec change in this pull request removes for the CRM line's
specs (`keptSpecRelease.pure.ts`).

The list should be limited to paths whose prime blob changed since the
delivered-from revision. Listing every protected path that merely differs
would fill the section on every pass and teach readers to skip it.

### Alternatives considered

- **`gitleaks:allow` on the planted line in prime's script.** The allowance
  would then travel with the literal it allows, and the copies the script
  plants (written without the comment) would still trip the gate. It is a
  prime-only change and fixes this class of incident (planted literals). It
  does not help a shape allowance prime adds later, and it splits the record of
  exceptions across two places, where prime's header keeps them in one
  reviewed file. Worth doing only if the reconcile is not.
- **A three-way merge (the variant machinery).** It would carry prime's hunks
  and keep the clone's. But it needs a merge base named by the line's own
  history. On the current NPC Test and Preflight proposals, every variant merge
  failed for want of one: "no commit on this line names the prime revision it
  was reconciled to", or a named revision that could not be resolved. A file
  merged this way would often be held for a person. That beats silence but not
  a derivation, which needs no base.
- **Split the file with `[extend] path`.** A per-deployment `.gitleaks.toml`
  would extend a shared, travelling base. This depends on how gitleaks 8.28.0
  merges `[[allowlists]]` across an extended path config, which has not been
  verified here. It would also change prime's file layout for every
  repository, to solve a problem the reconcile solves inside Mission Control.

## Open questions for the owner

1. Take (1), (2), both, or neither?
2. If (1): is it acceptable to replace each clone's hand-edited header with
   prime's, once prime's header is reworded to be true everywhere?
3. Separately from this file: ca5009825's message says the real key that
   `useGoogleFonts.ts` shipped is still in the history of prime and of every
   clone, and was allowlisted by name on all five clones until today. Whether
   it is still live can only be answered at Google Cloud. It should be revoked,
   and `GOOGLE_FONTS_API_KEY` checked to make sure it is not the same value.
