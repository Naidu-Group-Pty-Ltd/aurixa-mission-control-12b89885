# Each clone's `.gitleaks.toml` is derived, and a protected file prime changed is named

**Status: implemented in Mission Control #461 (30 Oct 2026), on the owner's
decisions of the same day.** This file began as the proposal; it now records
what was decided, what was built, and what the replays showed.

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

The same gap nearly bit that morning. Mission Control #460 withheld prime's
new tutorial records from every clone, for two reasons. The first is what the
records say. The second is that two phrases in their CSVs pass gitleaks only
under prime's `.gitleaks.toml` allowance, so delivered, they would have turned
every clone's secret scan red.

## Why the file was protected, and why that was wider than it needed to be

The exclusion's note: *"Allowlists THIS deployment's own publishable anon key by
literal. Prime's copy would allow prime's key and re-flag the clone's."* That
is true, and it is the only per-deployment fact in the file. Provisioning
already wrote that fact: `appendOwnKeyAllowlist` takes prime's file and
appends one block naming the clone's own key, leaving prime's literal in place
because the prime's key is in files every clone inherits.

Measured on each clone's `main`, 30 Oct 2026, by decoding every key the file
allows and searching the rest of the tree for it:

| Clone | Own project | Keys its scan allows | Needed by another file? |
| --- | --- | --- | --- |
| npc-client-dashboard | `plisdzywzleljorrphxv` | own, prime | both |
| npc-crm-independent-6505dc | `qvuwrvwzjyigptmnijyb` | own, prime | both |
| npc-test-76b3b3 | `umrtusxohxjxzodxorim` | own, prime | both |
| preflight-property-group | `egrmsulhtmqnmhvuccxr` | own, prime | both |
| tutorial-demo-orrimere-c158c7 | `fxqfhiiqdmzvsxbxvqcz` | own, prime, **the CRM line's** | own and prime; the CRM line's key appears in no other file |

Read value by value, every clone's file let through what prime's does, and
little else. Three exceptions, all of them a frozen file failing to correct
itself:

- Tutorial Demo inherited the CRM line's copy, which allows
  `qvuwrvwzjyigptmnijyb` under the description "This deployment's own Supabase
  anon (publishable) key". Its scan therefore lets another project's key
  through, which is the one thing the file's header says must keep failing.
- `npc-client-dashboard`, and the two children that read it, allow a
  `MARKETING_ENGINE.lock.json` line shape. Prime added that allowance on
  9 Oct (5a4ea7f2c) and removed it the same day (77f4f5fc5), when the lock
  stopped putting digests on their filenames' lines. The lock is the same blob
  in all six repositories, so the allowance matches nothing anywhere.
- `npc-client-dashboard` groups a few values differently and writes the PEM
  regex's quote as `'` where prime writes `\x27`. Those match the same strings.

## What was decided, and what was built

### 1. The file is derived, the way `supabase/config.toml` is reconciled

**The exclusion row stays.** The write path never carries prime's copy, as
before. What changed is that a reconcile now writes the file, through
`reconcileWrites`, exactly as `configTomlReconcile.pure.ts` writes
`config.toml`. (The proposal said the row would leave `DEFAULT_MIRROR_EXCLUSIONS`.
It does not, and `config.toml` never left it either: its row stays and the
reconcile writes the file.) The path is in `PUMPED_PATHS` with the other
composed files.

`gitleaksReconcile.pure.ts`, called from `processClone` after the deploy
workflow's reconcile:

- **Input:** the source's text (prime's, or the parent's for a lineage child),
  the clone's current text, the project the clone's own `config.toml` names,
  and, for a child, the project the parent's `config.toml` names. The
  registered backend (`clone_backends_safe`) is a cross-check, as it is for
  `config.toml`.
- **Own key:** the allowance in the clone's current file whose JWT `ref` claim
  is the clone's own project. None, more than one, or one that is not an
  `anon` key, and the file is held for a person (`manual_reconcile`, under
  "Needs a human") with that reason. The reconcile never writes a config that
  would reject the clone's own key, never guesses which key is current, and
  never writes an allowance for a key that bypasses RLS.
- **Output:** the source's text whole, less any allowance for the clone's own
  project and, for a child, the parent's own project, plus one block allowing
  the clone's own key as one literal. The prime's key stays wherever the source
  has it. A parent's key does not: each child's scan passes without it today,
  so no file a child inherits carries it.
- **Refusals:** the result is read back. It must allow the own key, allow no
  other key for the own project, and name no project the rule took out
  anywhere outside a comment. An allowance is never edited where it shares its
  line with another value, or is the only value in a block that also allows
  paths, commits or stopwords, because removing it there would widen what the
  block allows.
- **Said, not just written:** the proposal gets a section, "The secret scan's
  config was derived, not copied", naming any key and any allowance the
  clone's copy let through and the result does not. Values are compared one
  by one, with a quote written as `\x27` read as the quote, so a regrouped or
  respelled value is not reported as lost.

Run against each clone's `main` and its source's `main` on 30 Oct 2026, every
derivation succeeded, and a second pass over its own output changed nothing:

| Clone | Source | First pass |
| --- | --- | --- |
| npc-client-dashboard | prime | prime's file plus its own block; drops the stale lock-file allowance (1 value) |
| npc-crm-independent-6505dc | prime | prime's file plus its own block; drops nothing |
| npc-test-76b3b3 | npc-client-dashboard | the parent's file without the parent's key, plus its own block; drops nothing |
| preflight-property-group | npc-client-dashboard | the same |
| tutorial-demo-orrimere-c158c7 | npc-crm-independent-6505dc | the parent's file without the parent's key, plus its own block; no longer allows `qvuwrvwzjyigptmnijyb` |

A child derives from its parent's file as it stands. Until the parent's own
derivation merges, the child receives the parent's hand-edited prose. After
that, it receives prime's, through the parent.

**Prime's wording stays as it is** (the owner's decision). Prime's header says
its keys are `role=anon` for "THIS project", and its first block calls the
prime's key "this project's own". On a clone those sentences describe the
prime. The block Mission Control appends says so: "The rest of this file is
the prime's, so where it says this project it means the prime's, whose key
stays allowed because files this repository inherits carry it." Provisioning
writes the same block, worded once (`appendOwnKeyAllowlist`, now in
`gitleaksReconcile.pure.ts`).

What it would have done on 30 Oct: prime's swap of the planted key is a change
outside the own-key block, so it would have reached all five clones on the same
pass as the script that plants the key. None of the five hand fixes would have
been needed.

### 2. Never silent: a protected file prime changed is named

`protectedChanges.pure.ts`. A proposal names every path a protected exclusion
row withheld and prime changed in the range it delivers, from the prime
revision the clone last took (`clones.last_synced_sha`) to the one the
proposal carries, under "Prime changed files this clone keeps as its own",
each with its exclusion's note. A path that merely differs stays in the
closing count. The section exists to point at a cause, and a section that
names every differing path would fill on every pass.

- **Only the clone's own copies** (the owner's decision): paths a protected
  exclusion row holds, such as `vite.config.ts`, `vercel.json` and
  `.env.example`. A boundary the engine composes (a prime-only feature,
  another CRM line's files, a parent's own trees) is left out. So is a spec
  the independent line keeps, which `keptSpecRelease.pure.ts` lists where a
  file it tests crosses. A path a reconcile decided has its own section, and a
  refusal is already under "Needs a human".
- **Asked of prime's history**, which for a lineage child is not the
  repository it reads, so the child's provenance carries the prime's
  repository. One `compareCommitsWithBasehead` per pass.
- **A question not answered says so.** GitHub's comparison lists at most 300
  files for a whole range. Where it reaches that, each protected path the list
  does not name is asked by its blob at both ends, up to twenty paths, within
  the pass's budget. A path that cannot be asked, or a comparison that cannot
  be read, is listed as not asked, never as unchanged.

## Replayed

`cascadePassReplay.test.ts` on the CRM line at its head (`7d033aed`) against
prime@`31e8db7`:

- **At its recorded revision (`31e8db7`, in sync):** the proposal carries
  `.gitleaks.toml` as prime's file at `31e8db7` plus the line's own block, and
  nothing else differs from prime's. The kept-spec list folds into one summary
  line ("2 specs stay this line's own…") over a collapsed block. Prime changed
  nothing in the range, so no file is named.
- **As if it had last taken `18685b3`:** one comparison, 8 files, none of them
  a protected own copy, so no section.
- **As if it had last taken `adb6bc5`** (before prime's last `vite.config.ts`
  change): the comparison listed 1,401 changed files and was cut at 300, so
  three paths were asked one by one (six reads). The proposal names
  `.github/dependabot.yml`, `.github/workflows/address-service.yml`,
  `.github/workflows/routing-service.yml` and `vite.config.ts`, and the closing
  count fell from 502 to 498.

## Alternatives considered

- **`gitleaks:allow` on the planted line in prime's script.** The allowance
  would then travel with the literal it allows, but the copies the script
  plants (written without the comment) would still trip the gate. It fixes the
  planted-literal case only, and splits the record of exceptions across two
  places.
- **A three-way merge (the variant machinery).** It needs a merge base named by
  the line's own history, which the NPC Test and Preflight proposals of 30 Oct
  lacked for every variant. A file merged that way would often be held for a
  person. A derivation needs no base.
- **Split the file with `[extend] path`.** Unverified against how gitleaks
  8.28.0 merges `[[allowlists]]` across an extended config, and it would change
  prime's file layout for every repository.

## Still the owner's

ca5009825's message says the real key that `useGoogleFonts.ts` shipped is
still in the history of prime and of every clone. Whether it is still live can
only be answered at Google Cloud. It should be revoked, and
`GOOGLE_FONTS_API_KEY` checked to make sure it is not the same value.
