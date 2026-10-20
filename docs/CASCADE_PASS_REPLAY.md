# Replaying a cascade pass locally

`src/server/cascade/cascadePassReplay.test.ts` runs `processClone` for one
clone against local git clones of the prime and the clone. Every GitHub request
is answered from git and charged a latency modelled on production, and every
stage the engine enters (`passTrace.pure.ts`) is timed, counted and charged its
CPU. Nothing reaches GitHub or Mission Control.

Use it to measure an engine change on a real pass **before** it ships. The
alternative is what F21–F28 did: deploy an instrument, wait for a pass, read
the trace, and repeat. Each of those rounds cost hours.

It is opt-in: the suite skips it unless `CASCADE_REPLAY=1`.

## 1. Gather the clone's world

Mission Control's database is reached through Lovable's `query_database`
(project `0fb4d803-5071-4093-be25-5afbcf116476`). Put the answers in one
directory, the **replay directory**.

`world.json` holds the clone row and the four tables `processClone` reads,
plus the open cascade pull request if you want the refresh path:

```sql
select json_build_object(
  'clone', (select row_to_json(c) from (
     select id, name, github_owner, github_repo, default_branch, sync_scope,
            crm_mode, parent_clone_id, last_synced_sha
     from clones where id = '<clone id>') c),
  'exclusions', (select json_agg(row_to_json(x)) from (
     select clone_id, pattern, reason, note
     from clone_sync_exclusions where clone_id = '<clone id>') x),
  'backend', (select row_to_json(b) from (
     select clone_id, supabase_project_ref
     from clone_backends_safe where clone_id = '<clone id>') b),
  'approvals', coalesce((select json_agg(row_to_json(a)) from (
     select kind, path from cascade_path_approvals
     where clone_id = '<clone id>' and revoked_at is null and expires_at > now()) a), '[]'),
  'pins', coalesce((select json_agg(row_to_json(p)) from (
     select slug, version, library_entry_id
     from clone_library_pins where clone_id = '<clone id>') p), '[]'),
  'modules', (select json_agg(json_build_object('slug', m.slug, 'file_globs', m.file_globs))
     from clone_modules cm join modules m on m.id = cm.module_id
     where cm.clone_id = '<clone id>'),
  'open_pr', null
)::text;
```

A module-scoped clone's modules run to ~70 KB, past what the tool answers
inline; it saves the answer to a file, which `jq` or Python can unpack.

`progress.json` (optional) is the ledger the next pass would borrow: the
newest `cascade_results.progress` for the clone that is not null.

```sql
select progress::text from cascade_results
where clone_id = '<clone id>' and progress is not null
order by updated_at desc limit 1;
```

Without it the pass asks every question afresh, which is a first pass, not
the one production runs.

## 2. Clone the two repositories

Attach both read-only (`add_repo`), clone them shallow, and then deepen them
for the history probes. A probe walks up to ten versions of a path, so prime
needs enough history to answer it, and the clone needs its own.

```sh
git clone --depth 1 https://github.com/<owner>/<prime> /home/user/<prime>
git -C /home/user/<prime> fetch --depth=3000 origin main
git clone --depth 1 https://github.com/<owner>/<clone> /home/user/<clone>
git -C /home/user/<clone> fetch --depth=2000 origin main
```

For a lineage child, the source is its parent's repository rather than prime's
(`REPLAY_PRIME_*` names whichever repository the pass reads).

## 3. Run one pass

```sh
export CASCADE_REPLAY=1 REPLAY_DIR=<replay directory> \
  REPLAY_PRIME_REPO=<owner>/<prime> REPLAY_PRIME_DIR=/home/user/<prime> \
  REPLAY_PRIME_HEAD=$(git -C /home/user/<prime> rev-parse HEAD) \
  REPLAY_CLONE_REPO=<owner>/<clone> REPLAY_CLONE_DIR=/home/user/<clone> \
  REPLAY_CLONE_HEAD=$(git -C /home/user/<clone> rev-parse HEAD)
npx vitest run src/server/cascade/cascadePassReplay.test.ts
```

| Variable | Meaning |
|---|---|
| `REPLAY_SCALE` | Real milliseconds slept per modelled one. `0` (the default) counts requests and times CPU only, in about 20 s. `1` runs at production pace. |
| `REPLAY_LAT_FACTOR` | Multiplies the model. `1.2` matched production on 20 Oct 2026. |
| `REPLAY_BUDGET_MS` | The drain's budget (`INVOCATION_BUDGET_MS`, 45000). Unset: no budget, the whole pass runs. |
| `REPLAY_LEDGER` | A ledger to start from other than `progress.json`. |
| `REPLAY_TAG` | Suffix for the files written, so runs can be compared. |

It writes `report<tag>.json` into the replay directory:

- `stages`: each stage entered and when, as the production trace records it;
- `by_stage`: requests by method, and CPU in milliseconds;
- `delivery_digest`, `proposal_digest` and `outcome_digest`: hashes of every
  tree entry written, the pull request's text, and the result row. Two runs
  with the same digests delivered the same bytes, so this is how a change is
  shown to be exact;
- `ledger_writes`: when each ledger write happened.

It also writes `requests<tag>.json` (every request, with its stage),
`ledger-writes<tag>.json`, and `ledger<tag>.json` (the ledger the pass kept).

To compare a change with `main`, run once, `git stash` the change, run again
with another tag, and compare the two reports.

## 4. Run the passes that follow

Production runs a pass, keeps its ledger, and runs the next one a tick later.
To replay that, run with `REPLAY_SCALE=1 REPLAY_LAT_FACTOR=1.2
REPLAY_BUDGET_MS=45000`, then start the next run from the ledger the last one
kept (`REPLAY_LEDGER=<dir>/ledger<tag>.json`).

The platform's cut is not modelled inside the run. To model it, read the
pass's `wall_ms`. Where it is past the cut, start the next pass from the last
entry of `ledger-writes<tag>.json` whose `at` is inside it, since a cut pass
keeps only what it wrote in time. On 20 Oct 2026 a cut at 70 s fitted every
observation. Blobs a pass created stay under `<dir>/created/`, as they would
on GitHub.

## 5. How close it is

Fitted to the CRM line's traced pass in event `522816f5` (11:03 UTC,
20 Oct 2026), replayed on the engine production ran, at the same heads, with
the same ledger and the drain's 45-second budget:

| Stage entered | Production | Replay, × 1.0 | Replay, × 1.2 |
|---|---|---|---|
| `functions` | 7.1 s | 8.8 s | 9.4 s |
| `held` | 22.5 s | 24.0 s | 26.0 s |
| `prepare` | 26.4 s | 28.0 s | 29.2 s |
| `survivors` | 36.9 s | 33.8 s | 36.1 s |
| `specs` | 40.8 s | 36.2 s | 38.6 s |
| `recount` | 68.7 s | 57.1 s | 63.2 s |

The GitHub usage meter agreed on the count: about 200 requests by `recount`
in production, 193 in the replay at × 1.2.

What it does not model:

- **CPU limits.** It times the engine's CPU, but the platform's own limit is
  unknown. Passes died at different wall times (55 s in `proposal`, 68.7 s in
  `recount`), which a CPU limit would explain and a fixed wall-clock limit
  would not. That is a hypothesis, not a measurement.
- **Rate limits, server errors, and GitHub's own variance.**
- **Every GitHub shape.** A request it does not model throws, naming the
  method, so the gap is visible rather than silent.

## 6. What it found (F29)

The CRM line at prime@`adb6bc5` against `2a26ddc`: 1,365 files.

| | Before | After `92dd4a7` |
|---|---|---|
| Requests, whole pass | 361 | 212 |
| Engine CPU, whole pass | 22.3 s | 11.9 s |
| `specs` CPU | 9.4 s | 2.8 s |
| `listing` requests | 7 | 5 |
| `survivors` + `recount` + `references` requests | 158 | 11 |
| Delivery, PR text, result | — | the same bytes (digests equal) |
| Budgeted passes, cut at 70 s | never converges | the chain advances a chunk a pass, delivery stable |

See F29 in `HANDOFF_2026-10-19_CONTINUED.md` for what each change is.
