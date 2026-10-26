# The credential a clone's own CI holds

A clone repository ships `apply-migration.yml`, mirrored from the prime. On
2 September 2026 it was dispatched against `npc-client-dashboard` to apply the
39 MB template-library seed and stopped at its first gate:

```
SUPABASE_ACCESS_TOKEN is not set. Add it in Settings → Secrets → Actions.
```

The obvious repair — give each clone a Supabase access token — does not exist.

## Why a token cannot be minted at scale

| Mechanism                                              | Created how                             | Reaches                                                                                           |
| ------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Classic personal access token                          | By hand, in the dashboard               | The whole account: every organization and project, **including ones created after it was issued** |
| Scoped personal access token (`sbp_fc…`, public alpha) | By hand, in the dashboard               | Only the organizations, projects and permissions chosen at creation                               |
| OAuth app access + refresh token                       | Programmatically, after a user consents | The organizations that user granted                                                               |

There is **no Management API endpoint that creates a personal access token**.
Every one is a signed-in human in a browser, so "one per clone" is one manual
step per clone for ever — and the classic token Mission Control holds creates
and deletes projects, which makes it the last thing that should sit in a
tenant's repository.

The OAuth flow _is_ programmatic, and it is for a different problem: it
authorizes an integration against somebody else's organizations. Every clone
here lives in the one organization Mission Control already administers, so it
would add a consent dance and a refresh-token store while granting exactly the
same org-wide reach.

## What does scale

The credential Supabase already mints per project, automatically, at creation:
the database password. `createProject` generates it, `clone_backends.db_pass`
stores it encrypted, and `cloneCiCredential.server.ts` composes a session-pooler
connection string from it for any clone with nobody in the loop.

It reaches **one database**. Not another project, not billing, not the project's
own deletion. Rotating it for one clone touches no other. And for this job it is
simply better: `psql` has no request-size ceiling, so a 39 MB seed is one file
rather than 55 chunked Management API calls.

## Three rules

**A clone is only ever handed its own database.** The pooler user is
`postgres.<ref>`, so the composed URL is checked against the ref the caller
asked for and a mismatch refuses. This fleet has already made the mirror-image
of that mistake once: a workflow whose target _defaulted_ to the prime.

**Session mode, never transaction mode.** Supavisor's 6543 port pools per
transaction — no prepared statements, no session state — and a `psql -f` of a
migration then behaves in ways that are hard to predict and worse to debug.
5432 is the session port, and it is IPv4 on every tier, which GitHub's runners
need: the direct `db.<ref>.supabase.co` endpoint is IPv6 unless the project buys
the IPv4 add-on.

The port Supabase's pooler config reports is the project's DEFAULT mode's,
which is transaction: on 26 Oct 2026, the first pass with a password to compose
with, all four clones reported 6543, and a guard that refused any reported port
but 5432 refused every one. The shared pooler (`<region>.pooler.supabase.com`)
serves session mode on 5432 on the same host, so there the URL always uses
5432; on any other host a non-session port is still refused.

**Nothing composes half a URL.** A missing password, host or user refuses and
says which. A string assembled around a hole is a credential that fails at
connect time inside a CI job somebody else is reading.

## And the service-role key beside it (26 Oct 2026)

A clone also ships the prime's three scheduled refreshes — the sanctions
register, the PEP office-holder index and the RBA store — and each writes with
the project's service-role key. Measured 26 Oct 2026: on all four clones every
scheduled run of all three had failed at its credential check, every day, and
so had every run of `migration-drift.yml`. Each clone's registers stood where
the one-off reference copy left them in September (`docs/REFERENCE_DATA.md`:
that copy is a seed, not a feed), and no clone held a single RBA observation.

Mission Control holds each clone's own key (`clone_backends.service_role_key`,
stored at provisioning) and now hands it over under the same rule as the URL:
**a clone is only ever handed its own.** `judgeServiceRoleKey` admits a JWT
whose `role` is `service_role` and whose `ref` is the clone's, and refuses
anything else — another project's key, the prime's above all, the anon key, or
a non-JWT `sb_secret_` key, which the gateway in front of `rba-tables-ingest`
(`verify_jwt = true`) would refuse anyway.

## Both live in `supabase-production`, never in the repository

A repository secret is readable by every job of every workflow on every
branch. The prime keeps its production credentials in the `supabase-production`
environment (its `docs/operations/DEPLOYMENT_PROTECTION.md`), and every
workflow that reads either credential names that environment, so a clone's copy
is written there (`putEnvironmentSecret`). An environment that does not exist is
created bare, as GitHub creates one the first time a job names it; one that
exists is never changed, because its branch policy and reviewers are the
owner's.

`SUPABASE_PROJECT_REF` is written as a repository VARIABLE on every pass,
whether or not either credential could be: it is a fact about the repository,
not a credential.

## The password nobody kept

Until 26 Oct 2026 this sweep had reported `no database password is stored for
this clone` for all four clones, every half hour, since it was written. The
password is generated in the invocation that creates the project, and that
invocation persisted only the ref (`onProjectRef`). The wait for a new project
to come up outlives the budget and pauses; the resumed run enters with the ref
and no password, and the final update stores none.

- **Creation keeps it.** `onProjectRef(ref, dbPass)` writes the password,
  encrypted, in the same statement as the ref.
- **A clone without one is given one**, through Supabase's own
  `PATCH /v1/projects/{ref}/database/password`, but only where
  `decidePasswordSet` allows: none is stored, and neither the repository nor
  its production environment holds a `SUPABASE_ACCESS_TOKEN` of its own. A
  tenant whose own CI deploys holds that token, may have set its own password,
  and would lose every connection made with it. `BACKEND_DEPLOYED_BY` is NOT
  the signal: the declaration sweep writes it on every clone, a tenant's
  included, because the deploy workflow lets a token outrank it. A secret
  listing that failed is not an absent token, so it sets nothing.
  The ref comes from `resolveCloneSecretTarget`, which refuses the prime and
  Mission Control's own project. The row is claimed first — the new password
  written, marked `pending:`, only while the row holds nothing and names that
  project — and only the pass that wins the claim goes on, so two overlapping
  passes cannot both reset the database. A claim is never handed out as a
  credential, and a pass that finds one standing finishes it: it sends the
  same password again (setting one the database already holds changes
  nothing) and then stores it plain. So a pass stopped anywhere — before the
  reset, after it, or before the confirmation — leaves a state the next pass
  completes rather than a stored password the database does not take. Each
  set files `clone_db_password_set`, which never carries the password.

Resetting it was safe for the four clones it found on 26 Oct 2026: nothing
held the lost password, no edge function connects with `SUPABASE_DB_URL`, and
each clone's deploy workflow had stood down on its last run ("Report that
Mission Control deploys this project"), which it does only where the
repository holds no deploy token.

## Where it runs

Inside `/hooks/clone-deployer-declaration-reconcile`, the sweep that already
keeps `BACKEND_DEPLOYED_BY` true on every clone repository, on the same
half-hourly cadence. Both are the same concern — Mission Control keeping a clone
repository's CI configuration true from here rather than asking somebody to go
and set it — and one timer is cheaper than two.

The credential phase can never fail the declaration phase. The declaration is
what keeps a clone's deploy check green; the credential is what lets an operator
apply a migration by hand when Mission Control itself cannot be reached. Losing
the second must not cost the first.

It settles: GitHub never returns a secret's value, so there is nothing to
compare against and the write is repeated — once a day, or at once when
Mission Control has just changed the value (a password set that pass). A
settled clone costs one variable listing and one metadata read per secret each
pass, because this installation's hourly GitHub allowance has run out before. A
write over a secret that was already there is recorded as `kept` and files
nothing; a first write, a password set, a refusal or a failure files one audit
row.

## And then it reads back what the CI did (26 Oct 2026)

Distributing a credential is configuration. A refresh that runs on it is the
effect, and until this section Mission Control never looked. Measured on 26 Oct
2026, on all four clones: `aml-sanctions-refresh.yml` had failed 18 to 21
scheduled runs in a row, `rba-refresh.yml` 28 to 30, `migration-drift.yml` 19
to 21 (on the CRM line, every one of its 35 runs since it was created), and
`aml-pep-officeholders-refresh.yml` every weekly run in the window. Each was a
clone serving a stale sanctions list, a stale cash rate or an unverified
schema, and nothing said so.

So the same hook ends with a third pass, `sweepCloneCi`
(`src/server/cloneCiWatch.server.ts`, judged in `cloneCiWatch.pure.ts`). Per
clone it reads the scheduled runs, the runs dispatched on the default branch,
the workflow list, and — where the clone protects any path — its
`.github/workflows`, against the prime's read once for the pass. It finds three
things:

| finding   | when                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failing` | the last two scheduled runs of a workflow failed, with no success of that workflow on the default branch since                                                                                                                                                   |
| `stopped` | GitHub has disabled a workflow whose file declares a schedule (`disabled_inactivity`, `disabled_manually`): nothing fails, and nothing runs. Judged from the workflow list and the file, never from the run window, which a stopped workflow leaves within weeks |
| `differs` | a workflow the clone holds `protected` is not the prime's copy — the cascade withholds it without comment, by design                                                                                                                                             |

Three rules make it worth reading:

1. **A success proven by hand counts.** A green `workflow_dispatch` on the
   default branch ends a streak; a failed one never extends it. On the day this
   was written every refresh had been repaired and proven by dispatch while its
   schedule was still red, and a schedule-only watch would have opened with
   eleven alarms about jobs that already worked.
2. **Announced once.** A finding's identity carries no count, so a job failing
   every night is one announcement, not one a night. A clearance is recorded and
   not announced. A `differs` finding carries both blobs, so the prime moving a
   protected workflow is news again — that is the moment somebody has to decide.
   Only what LANDED counts as told: the record keeps what was observed and what
   was announced apart, so a notification that fails to insert is tried again
   on the next pass instead of being recorded as said.
3. **A failed read is not a clean clone.** Any input that could not be read makes
   the clone `unreadable` for the pass: nothing is recorded, its standing
   findings stand, and a pass with any unreadable clone files a
   `clone_ci_watch_cron` row, because a watch that cannot look is the one thing
   it cannot report about itself.

It reports and never repairs. Findings land on the clone's history as
`clone_ci_watch` and in the inbox as `clone_ci_attention`, a kind of its own so
muting it silences nothing else. It runs last, in a try of its own, after
`decideSpend` has let it spend: seventeen reads a pass for four clones, and the
first thing to yield when a cascade needs the installation budget.
