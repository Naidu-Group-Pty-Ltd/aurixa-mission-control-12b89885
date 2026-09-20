# Finish the Aurixa Mission Control audit

Two audit passes have landed on `claude/npc-dashboard-client-facing-zq1md2` (PR #58).
`docs/AUDIT-2026-08.md` is the full record — **read it first**, it explains why each
guard exists and which failure class each one catches.

CI is green for the first time: `npm ci` → 4 guards → typecheck → lint → test → build,
0 lint errors, 838 tests, 0 npm advisories. **Do not regress that.** Every task below
must end with all of these passing:

```
npm ci && npm run check:supabase-types && npm run check:ts-nocheck \
  && npm run check:rls && npm run check:cron \
  && npm run typecheck && npm run lint && npm run test && npm run build
```

## Status, re-measured 20 Sep 2026

**Five of the six tasks below are done and this document did not say so.** It
reads as a to-do list with none of it started, which is the same failure the
migration incident's "Still open" list committed — a record that outlives the
work it describes and sends the next reader at something already finished.

Each task keeps its reasoning rather than being deleted: the reason a hazard
existed outlives the hazard, and the five rules below are still the rules.

| Task | Claim in this document | Measured 20 Sep 2026 |
| --- | --- | --- |
| 1 | 30 files carry `@ts-nocheck`, 103 errors | **Done.** Budget file empty, `check:ts-nocheck` passes at 0. The one remaining is `src/routeTree.gen.ts`, which is generated. |
| 2 | 30 `supabaseAdmin as any` aliases remain | **Done.** 0 occurrences in `src/`, in 0 files. |
| 3 | 412 discarded errors, 549 fire-and-forget writes | **Partly, and bounded.** `check:discarded-errors` reports **349 across 97 files against a budget of 358**, and the budget only shrinks. The two counts are one measure now. |
| 4 | A cron delivery card on `/health` | **Done.** `CronDeliveryHealthCard`, mounted at `health.tsx:132`. |
| 5 | A foreign-key index guard | **Done.** `scripts/check-fk-indexes.mjs`, wired as `check:fk-indexes`, passing. |
| 6 | Decide on the two stale lockfiles | **Resolved.** One lockfile: `package-lock.json`. |

Task 3 is the only one still owed work, and it is a ratchet rather than a
backlog item: the number goes down or the gate fails.

## Five rules that are not negotiable

1. **Never hand-edit `src/integrations/supabase/types.ts`.** Regenerate it:
   `supabase gen types typescript --project-id fgpvagejkaeqedcwvbte > src/integrations/supabase/types.ts`.
   A table missing from that file makes every `.from("x")` resolve to `never`, so
   `tsc` passes _because nothing is checked_. `npm run check:supabase-types` enforces
   this — if it complains, regenerate, do not patch.
2. **`scripts/ts-nocheck-budget.txt` only shrinks.** Remove a file by fixing its
   errors and deleting its line. Never add one. `npm run check:ts-nocheck` fails on
   both an addition and on a fix that leaves the ledger stale.
3. **Never name a column or RPC the database does not have.** This audit found five
   of those, each fatal at runtime and each invisible because the error was
   discarded. Before writing `.select("a, b")`, `.eq("col", …)` or `.order("col")`,
   confirm the column exists in `types.ts`. PostgREST answers **42703 to the whole
   query**, so one wrong name kills the entire read.
4. **A read that FAILED is not a row that is ABSENT.** Never `const { data } = await
supabase...` and treat null as "nothing there". Destructure `error`, and branch on
   it separately. That single pattern caused most of the defects in this audit.
5. **`strictNullChecks` stays on.** It is load-bearing for TanStack's middleware
   inference, not a style preference — see the note beside the flag in
   `tsconfig.json`. Turning it off silently retypes every server function's `context`
   as `undefined`.

---

## Task 1 — clear the last 103 type errors and empty the @ts-nocheck budget

30 files still carry `// @ts-nocheck`, each annotated at its top with how many errors
it holds and of what kind. Removing all of them exposes **103 errors**, concentrated:

| File                                                                                       | errors   |
| ------------------------------------------------------------------------------------------ | -------- |
| `src/routes/billing.success.tsx`                                                           | 21       |
| `src/lib/handoffs.functions.ts`                                                            | 14       |
| `src/lib/client-supabase-accounts.functions.ts`                                            | 7        |
| `src/lib/api-usage.functions.ts`                                                           | 6        |
| `migration-sync`, `settings.clone-stripe`, `handoff-audit`, `fit-analysis`, `clone-stripe` | 4 each   |
| 21 more files                                                                              | 1–3 each |

By error code: 31 × TS2345 (argument types), 28 × TS2339 (unknown property),
22 × TS2322 (assignability), 6 × TS2304 (**cannot find name — treat every one of
these as a real bug, not type debt; an identifier that does not exist throws at
runtime**), 4 × TS2698 (spread of a non-object), 3 × TS2719.

Work file by file, smallest first. For each: delete the `@ts-nocheck` header, fix the
errors, delete its line from `scripts/ts-nocheck-budget.txt`, run the gate.

**Most of these are `Record<string, unknown>` being written to a `jsonb` column.**
Do not reach for `as any`. Either type the value as `Json` at its source, or cast at
the write boundary with a named helper so it stays greppable.

**`billing.success.tsx` is one root cause, not 21 bugs.** A ternary picks between two
`useServerFn` results with different shapes, and TypeScript intersects them to `{}`.
Give the query an explicit return type, or normalise both branches to one shape.

## Task 2 — remove the remaining 30 `supabaseAdmin as any` aliases

57 files aliased `supabaseAdmin` to `any`, which switches off typing for every admin
query in the file. 27 were removed once the six missing tables were declared — those
casts had simply gone stale. **30 remain, and clearing them costs about 73 further
errors** of the same mechanical kind (measured, not estimated).

Do this _after_ Task 1, one file at a time. Each removal is an independent, verifiable
change. Where a cast turns out to be genuinely needed, cast the single expression that
needs it — never the client.

## Task 3 — stop 412 discarded errors and 549 fire-and-forget writes

**412 of 886** Supabase result destructures discard `error` (46%), and there are
**549 awaited writes** with no destructure and no `.catch`. This is the pattern behind
nearly every defect in this audit: a failed read is indistinguishable from an empty one.

Do not attempt all 961 at once. Work in this order:

1. **`audit_log` and `notifications` writes** (127 + 50 sites). `src/server/audit.server.ts`
   already provides `writeAuditLog()` and `notifyOperators()`, which log a failed write
   and never throw. Retrofit call sites to use them. This is what made three invalid
   `notification_kind` values invisible for the life of the feature.
2. **Reads whose result drives a decision** — anything where `data` being null changes
   what happens next. Destructure `error` and branch on it. Prefer three outcomes:
   _failed_ (retryable), _absent_ (final), _found_.
3. **Everything else** — leave it, and say so in the audit doc rather than churning it.

Add a `scripts/check-discarded-errors.mjs` ratchet keyed **by file and count** (not by
line number, which shifts): a file may not increase its number of discarded errors, and
the ledger must be updated when one drops. Model it on
`scripts/check-ts-nocheck-budget.mjs`. Wire it into `.github/workflows/ci.yml`.

## Task 4 — a cron delivery card on `/health`

The data already exists. `public.cron_delivery_health(_since_hours int)` (migration
`20260820160000`) returns one row per pg_cron job: `jobname, schedule, active,
last_run_at, last_run_status, runs, last_http_status, last_http_error, delivered`.
`/api/health` reports failures from it behind the cron credential.

Build the operator surface on the existing `/health` route:

- A table of every job, newest run first.
- **`delivered` is three-valued and must render as three states.** `true` = delivered,
  `false` = the HTTP call failed (show `last_http_status` and `last_http_error`),
  `null` = **unknown**, not broken — a job that has not run inside the window. Do not
  collapse null into false; every newly scheduled job would look like a failure on its
  first day.
- Make the distinction the whole feature exists for legible on the page: **pg_cron
  reporting `succeeded` while the HTTP call came back 401 is the case that was
  invisible.** A row where `last_run_status = 'succeeded'` and `delivered = false`
  should read as a failure, not a success.
- Gate it behind `requireOperator` and reach it through a `createServerFn` in
  `src/server/`, not from the browser client.

Use the existing card components and semantic design tokens. Do not add a chart
library.

## Task 5 — a foreign-key index guard

35 FK columns were indexed in this branch, chosen because they carry
`ON DELETE CASCADE`/`SET NULL` _and_ are filtered on in application code. **53 remain
unindexed** and were deliberately left alone.

There is no guard for this class because it needs a real SQL parser — a regex over
`REFERENCES` was tried, ran past a `CREATE TABLE` boundary in a file that puts several
columns on one line, and invented two columns that do not exist. Add
`scripts/check-fk-indexes.mjs` using a JS Postgres parser (`libpg-query` or
`pgsql-ast-parser`) that fails when a **new** FK with a referential action lands with
no leading index. Freeze the existing 53 in a ledger, same shape as the other guards.
If the parser dependency is unacceptable, say so and skip this task rather than
shipping another regex.

## Task 6 — decide on the two stale lockfiles

The repo carries `bun.lock` and `bun.lockb` alongside `package-lock.json`. No workflow
uses either, and **`bun.lockb` predates the support-ticketing dependencies by three
weeks**, so `bun install` produces a tree missing packages the app now imports. They
were left in place only because the generating platform's own toolchain could not be
verified from a CI container — you can check that directly. Either delete both and
`bunfig.toml`, or regenerate them and add a CI step that keeps them in step with
`package.json`. Do not leave them stale.

---

## Two operator actions — not code, and both matter

Neither can be done from a repository, and both are load-bearing:

1. **Set `CREDENTIALS_ENC_KEY`.** `encryptSecret()` is a **no-op** without it — no
   warning, no failure, into columns named `..._ciphertext`. Unset, all of this is
   plaintext in Mission Control's own database: every managed clone's Supabase
   **service-role key** and **database password**, client **personal access tokens**,
   queued clone **admin passwords**, and per-clone **Stripe webhook secrets**. Check
   `/api/health` → `checks.credential_encryption` (with the cron bearer token) to see
   which state the deployment is actually in. Turning it on is safe at any time:
   `decryptSecret` reads legacy plaintext transparently and each value is re-encrypted
   on its next write.

2. **Set the two database GUCs.**
   ```sql
   ALTER DATABASE postgres SET app.settings.public_app_url = 'https://<mission-control-host>';
   ALTER DATABASE postgres SET app.settings.cron_secret     = '<same value as CRON_SECRET>';
   ```
   Cron job URLs were hardcoded in migrations, at two different hostnames over time.
   New jobs read `public_app_url` and fall back to the old hardcoded host, so nothing
   breaks if it is unset — but setting it is what stops the next domain change from
   pointing cron at a dead host silently.

**Then verify the six newly scheduled jobs actually deliver.** They are
`api-usage-settle-daily`, `edge-drain-1min`, `edge-drift-daily`,
`handoff-observability-poll-15min`, `handoff-parity-refresh-hourly`,
`drift-refresh-5min`. Give them one cycle, then:

```sql
SELECT jobname, last_run_status, last_http_status, delivered
  FROM public.cron_delivery_health(24) ORDER BY jobname;
```

`last_run_status = 'succeeded'` on its own means nothing — pg_cron is reporting that it
queued an HTTP call, not that anyone answered. **`delivered` is the column that matters.**
A 401 there means `app.settings.cron_secret` does not match `CRON_SECRET`; a 404 means
the URL is wrong.

`api-usage-settle` deserves particular attention on its first run: it closes every
ended billing period and pushes what it owes onto the tenant's next Stripe invoice, and
it has never run, so there is a backlog. It is idempotent three times over — closing a
closed period returns it untouched, an invoiced charge returns early, and the Stripe
call carries `api-usage-charge-<id>` as its idempotency key — but watch the first run
and check `notifications` for `api_usage_settlement_failed`.

---

## Finally

Update `docs/AUDIT-2026-08.md` as you go. Its "What is left" section is the ledger —
move items out of it as they are done, and add anything new you find with a **number
against it** rather than a description. Where you check something and find it sound,
write that down too.
