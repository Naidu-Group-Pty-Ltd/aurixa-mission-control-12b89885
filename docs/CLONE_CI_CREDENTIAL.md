# The credential a clone's own CI holds

A clone repository ships `apply-migration.yml`, mirrored from the prime. On
2 September 2026 it was dispatched against `npc-client-dashboard` to apply the
39 MB template-library seed and stopped at its first gate:

```
SUPABASE_ACCESS_TOKEN is not set. Add it in Settings → Secrets → Actions.
```

The obvious repair — give each clone a Supabase access token — does not exist.

## Why a token cannot be minted at scale

| Mechanism | Created how | Reaches |
| --- | --- | --- |
| Classic personal access token | By hand, in the dashboard | The whole account: every organization and project, **including ones created after it was issued** |
| Scoped personal access token (`sbp_fc…`, public alpha) | By hand, in the dashboard | Only the organizations, projects and permissions chosen at creation |
| OAuth app access + refresh token | Programmatically, after a user consents | The organizations that user granted |

There is **no Management API endpoint that creates a personal access token**.
Every one is a signed-in human in a browser, so "one per clone" is one manual
step per clone for ever — and the classic token Mission Control holds creates
and deletes projects, which makes it the last thing that should sit in a
tenant's repository.

The OAuth flow *is* programmatic, and it is for a different problem: it
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
of that mistake once: a workflow whose target *defaulted* to the prime.

**Session mode, never transaction mode.** Supavisor's 6543 port pools per
transaction — no prepared statements, no session state — and a `psql -f` of a
migration then behaves in ways that are hard to predict and worse to debug.
5432 is the session port, and it is IPv4 on every tier, which GitHub's runners
need: the direct `db.<ref>.supabase.co` endpoint is IPv6 unless the project buys
the IPv4 add-on.

**Nothing composes half a URL.** A missing password, host or user refuses and
says which. A string assembled around a hole is a credential that fails at
connect time inside a CI job somebody else is reading.

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
compare against and the write is simply repeated. A pass that distributes
nothing new files no audit row.
