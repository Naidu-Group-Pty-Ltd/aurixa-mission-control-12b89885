# Airtable intake to the clones, the cascade and the Actions policy — handover, 19 Oct 2026

The owner's ask on 19 Oct 2026 was first "the Airtable Property Intake Master
isn't cascading into the clones — start with that", then, once the Airtable
credentials had been changed to the new base, "run the cascade appropriately",
and finally "complete the job with maximum effort". This document records what
was found, what shipped, what is in flight at the time of writing, and what is
still owed and to whom. It is a living document: the session that wrote it
(https://claude.ai/code/session_016zhCkg3g3xf3hTLC4ZkzAf) keeps updating it
while the work runs, and the "Where things stand" table is the part to read
first.

Repositories: Prime is `Naidu-Group-Pty-Ltd/npc-property-dashbord`; Mission
Control is this repository; the clone this round reconciled by hand is
`Naidu-Group-Pty-Ltd/npc-client-dashboard` (parent of Preflight and NPC Test);
the fourth clone is `npc-crm-independent-6505dc`. Supabase projects: Prime
`dduzbchuswwbefdunfct`, NPC Client Dashboard `plisdzywzleljorrphxv`, NPC CRM
Independent `qvuwrvwzjyigptmnijyb`, NPC Test `umrtusxohxjxzodxorim`, Preflight
Property Group `egrmsulhtmqnmhvuccxr`.

## Where things stand (13:10 UTC, 19 Oct 2026)

| Piece | Where | State |
|---|---|---|
| Prime: `listings-cache` sheds the unread bulk columns and reads the deployment's own table | PR #3341, branch `claude/serene-gates-b7f5pi`, head `efeead42` | Ready for review. CI 9082 running on this head. Carries the pin, Deno and Supabase CLI commits below, and its body says so; merge #3342 first. |
| Prime: every action pinned to a commit, Deno and the Supabase CLI from their own releases | PR #3342 (draft), branch `claude/serene-gates-b7f5pi-pin-actions`, head `f2eef880` | CI 9083 running. CI 9080, on the Deno commit, had its `security` job pass the new Deno step and every Deno check before the Supabase CLI push superseded it. |
| Mission Control: forwarded configuration follows Mission Control's value | PR #345, branch `claude/serene-gates-b7f5pi`, head `773f7932` (code unchanged since `be2f94cd`; this document on top) | Green, `mergeable_state: clean`, deliberately **not merged** until Prime's fix reaches the clones (§ Order). |
| Clone `npc-client-dashboard`: cascade `prime@6bd6e86` | PR #379, branch `aurixa/cascade-70132e8-mvb39lqx`, head `06d2d096` | Three hand commits on top of the engine's (`3922a634` pins + Deno, `5b6cf760` the held App.tsx reconcile, `06d2d096` the Supabase CLI step in nine workflows, byte-identical to Prime). CI 1307 running. CI 1306, on `5b6cf760`, had `security` (with the regenerated inventory check), `render-container` and `supply-chain` green before the push superseded it. |
| Clone `npc-crm-independent`: stuck cascade rows | Mission Control `cascade_results` | Not yet re-examined this round (task #45 second half). |
| Organisation Actions policy | Enterprise / organisation settings | Two rules in force since ~11:00 UTC: SHA pins required, and only GitHub-owned actions admitted. Both measured by effect (§ F6). Needs the owner for the two publishers not replaced. |

## What the job was

Every deployment shows the same marketplace, read from one Airtable table,
**Property Intake Master**. Since 15 Oct 2026 the live base is
`appFNPL7iYiuQyHAO` and the table `tblumTIRYBn92B2ST` (680 records at the time
of measuring); `apptyShYE0yzL4IGB` / `tblWIg5cs85O30pcY` took its last record on
8 Sep and is kept in every `listings_cache` as an archive. The clones showed
nothing new from the live base.

## Findings

### F1. The clones were asking the broker for a table it refuses

`AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` are **withheld** on every clone by
design (an Airtable personal access token carries its whole scope, and with
`data.records:write` could rewrite the shared intake table), and the READ is
brokered by Mission Control: `GET /api/public/listings/{tables|records|selftest}`
under `x-clone-api-key`. `resolveTable` admits only the table the clone names
in `AIRTABLE_TABLE_NAME` when it is the one Mission Control holds, or an
allow-listed table; anything else is `table_not_allowed`. The other four
`AIRTABLE_*` names are configuration and forward to the clones.

The clones still carried the retired table in `AIRTABLE_TABLE_NAME`. The fleet
forward (`/hooks/fleet-secret-forward-reconcile`, cron `15,45 * * * *`) is
**deliver-once**: a name already delivered to a clone is never re-sent, so a
changed VALUE in Mission Control's environment never reached a clone that
already held the old one. That is the defect PR #345 closes.

### F2. Prime's own sync could not finish either

Prime's `listings-cache` has answered HTTP 546 "Memory limit exceeded" since
16 Oct: the rebuilt base's records carry the model's answer twice and the whole
email (`UNREAD_BULK_COLUMNS`), 57 MB for 459 records against about 4 MB
without, and the function held whole pages of them. PR #3341 sheds those
columns as each page arrives (`shedUnreadColumns`, `toCacheRow` in
`_shared/listingsCache.pure.ts`; `WHOLE_RECORD_PAGE = 200`; `readCache` pages
at 200 and sheds; the `record` op sheds), and `cacheTableKey` no longer names a
table id (`TABLE_KEY_ALIASES` removed), because the one it named outlived the
base. 165 tests across 7 spec files pass locally; the docs
(`AIRTABLE_KEY_OWNERSHIP.md`, `CLAUDE.md`) record the move and the two bases.

### F3. Mission Control re-sends a changed configuration value (PR #345)

`FLEET_CONFIGURATION` names the forwarded configuration names whose VALUE
follows Mission Control's, and a `refresh` act re-delivers them; secrets keep
deliver-once. Once published, the next sweep (:15 / :45) sends
`AIRTABLE_TABLE_NAME=tblumTIRYBn92B2ST` to every clone.

### F4. The order is load-bearing

If #345 is published before Prime's #3341 has cascaded to a clone, that clone
is told the live table and then syncs 680 whole records with the OLD
`listings-cache`, which is the exact shape that killed Prime's worker at 546.
So: #3341 merges on Prime → the cascade carries it to all four clones → #345
merges and is published → the sweep re-sends the table name → each clone's
sync is read for `ok` with about 680 records and no 546.

### F5. The cascade had held the files that mattered on `npc-client-dashboard`

PR #379 (`prime@6bd6e86`, 970 files) merged nothing of the prime's `App.tsx`
work: `src/App.tsx` is `manual_reconcile`, `src/lib/clientFacing.ts` and 32
specs that read them were held with their subject. The hand reconcile is
commit `5b6cf760`: a three-way merge of App.tsx (ours / base `dd5286f` / theirs
`6bd6e86`) that carries `ClientPortalAuthLayout`, `PortalPathRedirect`, the
lazy hub message pages on five portals, the solicitor and accountant redirects
and `requireRole="superadmin"` on `admin/users`, while every clone route and
build gate (`RouteExcludedFromBuild`, `__CLIENT_FACING__`) stays; the prime's
`declare const` block in `clientFacing.ts` and nothing else; the 32 specs
verbatim at `6bd6e86`; and `SECURITY_INVENTORY.json` regenerated.

Two engine facts decided how that commit was written. `variantMerge.pure.ts`
reads the base for a held file from the newest clone commit naming exactly ONE
`prime@<sha>` (regex `\bprime@([0-9a-f]{7,40})\b`, two names is ambiguous), so
the reconcile commit names `prime@6bd6e86` once and the pin commit names none.
And `cascade-engine.server.ts` refreshes an open PR with a preserving merge
when the branch carries human commits (`refreshOverHumanWork.pure.ts`), so a
hand commit on a cascade branch survives the next refresh. The engine's own
`refreshForce` applies only to a branch that is entirely its own statements.

### F6. The organisation's Actions policy, measured by effect

Between 10:41 and 11:26 UTC on 19 Oct every Prime workflow that named an
action by tag started ending in `startup_failure` — a run with no jobs, no
logs and nothing to re-run (CI 9075–9077, PDF Import Regression 1573–1574; the
RBA refresh at 10:40 still ran). The two Codex workflows, SHA-pinned when they
were copied from Mission Control, kept starting. So rule one: **actions must
be pinned to a full-length commit SHA**. PR #3342 pins every `uses:` in 30
workflows to the commit its tag resolved to, with the tag in a trailing
comment.

With every action pinned, `ci.yml` STILL read `startup_failure` (CI 9078,
9079) while PDF Import Regression 1575–1577 ran to green on the same commits.
The one `uses:` the first had and the second lacked was `denoland/setup-deno`;
`address-service` and `routing-service` (which name `supabase/setup-cli` and
`superfly/flyctl-actions/setup-flyctl`) failed the same way on the same
commits. So rule two: **only GitHub-owned actions are admitted** (which other
publishers it admits, if any, was not measured). The remedy taken in Prime is
to install a tool from the tool's own release, pinned and checksummed, rather
than widen the list:

- Deno 2.9.7 in `ci.yml`'s `security` job, checked against the `.sha256sum`
  Deno publishes beside the zip (`c6527f24…c3490`). CI 9080's `security` job
  passed that step and every Deno check at 12:48 UTC.
- The Supabase CLI 2.121.0 in the nine workflows that used
  `supabase/setup-cli` — `deploy-supabase-functions` (what carries a merged
  function to production), `release-held-function`,
  `rotate-internal-edge-secret`, both `decommission-*`,
  `maps-credential-remediation`, `deploy-render-fly`, `address-service`,
  `routing-service` — checked against the `checksums.txt` of its release
  (`4b481189…275f` for `supabase_2.121.0_linux_amd64.tar.gz`).

Still naming a publisher the policy refuses: `google-github-actions/auth` and
`setup-gcloud` in `deploy-pdf-parse-service`, `deploy-weasyprint-service` and
`maps-credential-remediation`; `superfly/flyctl-actions/setup-flyctl` in
`deploy-render-fly`, `address-service` and `routing-service`. Those six will
`startup_failure` until the owner adds the two publishers to the allowed list
(§ Owed, item 4) or each is replaced the same way.

The clones are in the same organisation, so the same two rules apply to them.
`npc-client-dashboard`'s copies of the workflows carry the same bytes (commit
`3922a634`); its `address-service` and `routing-service` runs 9 and 4 failed at
startup on the pin commit exactly as Prime's did. The other three clones will
need the same bytes, which the cascade carries once #3342 is on Prime's `main`.

`docs/operations/CI_SCOPE.md` in Prime ("Every action is pinned to a commit")
records both rules and the replacements.

### F7. `pdf-extraction-v3-gates` is red on Prime's `main` and has been

It fails on every scheduled run on `main` since at least 14 Oct (runs 90–93)
on a "credential-like assignment present" heuristic that lists `_shared/*`
files, and fails identically on #3341 and #3342. It is not caused by these
changes and is not fixed by them; it is named here so nobody reads it as
theirs.

### F8. Not addressed: the broker relays whole pages

`brokeredUrl` sends no `fields[]`, so a clone's sync receives full 100-record
pages and sheds them itself. With #3341 that is safe; it is still more bytes
than the read needs.

### F9. Environment facts worth knowing

- `cdn.sheetjs.com` (the `xlsx` tarball host) is unreachable from this
  session's egress, so `xlsx` cannot be installed locally; the clone's build
  and the five specs that import it were validated with a local stand-in in
  `node_modules` that is not a repository file. CI installs it normally (the
  clone's `security` job and build run on GitHub are the proof that counts).
- GitHub run pages answer 403 to this session; runs were read through the
  GitHub tools. A `startup_failure` has no logs anywhere.
- The repositories were shallow clones; pushes to existing branches were
  fast-forwards checked against `git ls-remote` first.

## What shipped, by commit

Prime, branch `claude/serene-gates-b7f5pi-pin-actions` (PR #3342):

- `541b5dd9` Pin every GitHub Action to a commit SHA (30 workflows,
  `CI_SCOPE.md`).
- `83e72936` CI installs Deno from its own release, not through a third-party
  action.
- `f2eef880` The Supabase CLI is installed from its own release, in the nine
  workflows that used `setup-cli` (cherry-picked from `efeead42` below).

Prime, branch `claude/serene-gates-b7f5pi` (PR #3341): `3bfefd08` the
listings-cache fix, then the same three changes (`35e49428` pins,
`96b6a574` Deno, `efeead42` Supabase CLI).

Mission Control, branch `claude/serene-gates-b7f5pi` (PR #345): `be2f94cd`
Forwarded Airtable settings follow Mission Control's value; `773f7932` and
later, this document.

Clone `npc-client-dashboard`, branch `aurixa/cascade-70132e8-mvb39lqx`
(PR #379): `3922a634` pins + Deno (no `prime@` token), `5b6cf760` the reconcile
(names `prime@6bd6e86` once), `06d2d096` the Supabase CLI step in the nine
workflows plus `CI_SCOPE.md`, copied byte for byte from Prime `efeead42` (no
`prime@` token).

## Owed, in order

1. **Prime #3342 → `main`.** When CI 9083 (on `f2eef880`) is green: mark the
   PR ready once (`gh pr ready 3342` or `update_pull_request` with
   `draft: false`), let the full gate run, merge with a merge commit. `pdf-extraction-v3-gates` will be red; it is red on
   `main` (§ F7). After the merge, `deploy-supabase-functions` runs on `main`
   because its own file changed: read it on the Actions page — it is the first
   production run of the Supabase CLI step.
2. **Prime #3341 → `main`.** Its full gate re-runs on the merge of #3342 (the
   shared commits become a no-op diff). Merge with a merge commit. Then watch
   `deploy-supabase-functions` deploy `listings-cache`, and read the next sync:
   `ok`, about 680 records, no 546 in `function_edge_logs` for
   `dduzbchuswwbefdunfct`.
3. **The cascade carries #3341 and #3342 to all four clones.** For
   `npc-client-dashboard`, PR #379 is the vehicle (never convert it to a
   draft; the engine merges it when green). Re-examine the
   `npc-crm-independent` rows in `cascade_results` for anything stuck; the
   FLEET_SYNC_STALL documents in this directory record how.
4. **The owner: the Actions allowed list.** In the enterprise or organisation
   settings → Policies → Actions → "Allow select actions and reusable
   workflows", add `google-github-actions/*` and `superfly/*` (or
   `google-github-actions/auth@*`, `google-github-actions/setup-gcloud@*` and
   `superfly/flyctl-actions/setup-flyctl@*`). Until then the six workflows in
   § F6 cannot start, and the two Cloud Run deploys stage nothing on a push to
   `main`. Leave "Require actions to be pinned to a full-length commit SHA" as
   it is: everything is pinned now.
5. **Mission Control #345 → `main`, then publish.** Only after step 3 for
   every clone. Squash-merge as this repository does; publish with Lovable
   `deploy_project` on project `0fb4d803-5071-4093-be25-5afbcf116476`. The
   next sweep at :15 or :45 re-sends `AIRTABLE_TABLE_NAME=tblumTIRYBn92B2ST`.
6. **Verify on each clone** that `listings_cache` syncs `tblumTIRYBn92B2ST`
   (the sync run's own record, and the Listings page showing the live base's
   records), on `plisdzywzleljorrphxv`, `qvuwrvwzjyigptmnijyb`,
   `umrtusxohxjxzodxorim` and `egrmsulhtmqnmhvuccxr`.
7. **Carried from earlier legs, still the owner's:** a workspace-scoped
   Anthropic key for Mission Control's autofix (replacing the org-scoped
   `ANTHROPIC_API_KEY`); the rotations recorded earlier (the signing key,
   `CRON_SECRET` on three projects, nine leaked credentials); and the eight
   template seed migrations over 40 MB that a person pushes to each clone
   from a local copy, because the cascade holds anything that size.

## Rules this round paid for

- **A `startup_failure` says nothing in its logs.** The first thing to check
  is the policy, by comparing a workflow that started with one that did not,
  on the same commit.
- **Asserted by effect, never by configuration.** The pin rule and the
  publisher rule were each established from runs, not from reading a setting
  nobody in the session could read.
- **A tool a workflow needs can be installed from its own release**, pinned
  and checked against the checksum the publisher ships, which is at least as
  strong as the action it replaces and asks nothing of the allowed list.
- **A hand commit on a cascade branch names the prime commit exactly once**,
  so the engine's next held-file merge reads the right base; a mechanical
  commit beside it names none.
- **Order the publishes by who can be hurt.** A re-sent configuration value is
  harmless only once every reader of it can carry the load it names.
