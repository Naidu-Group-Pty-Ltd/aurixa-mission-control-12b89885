# Reference data: what may travel from the prime to a tenant

Read this before touching `src/server/referenceTables.pure.ts`,
`referenceCopy.pure.ts`, `reference-data.server.ts`, or the
`clone_reference_syncs` table.

## The gap

`provisionCloneBackend` carries an explicit promise in its own docstring:

> Full pipeline: create project → wait ready → get keys → replay the prime's
> migrations → deploy the prime's edge functions → create empty-shell secrets →
> seed admin. **Structure only — no data ever leaves the prime.**

That is the right default and it is why a fresh clone has 641 tables in
`public` and `aml` with nothing in any of them. It is also why the clone cannot
draw a document: the 500-master Investment Compass catalogue is *data*, in
`template_library_entries`, and no report renders without it.

The obvious repair is not available and should not be. The four
`seed_template_library_*` migrations are **36–41 MB each** — past what the
Management API accepts in one statement — and they are the wrong shape anyway:
a migration replays what the prime's repo said months ago, while a tenant needs
the catalogue as it stands.

## The rule

This programme **narrows** the "no data" promise rather than repealing it.
Exactly the tables in `REFERENCE_TABLES` may be copied, for the reason recorded
beside each one. Everything else is tenant data **by default**, and default is
the load-bearing word — the prime holds, in tables that sit alphabetically
beside the allowed ones:

| table | what it holds |
| --- | --- |
| `email_copilot_emails` | 5,350 real client emails, 64 MB |
| `report_versions` | 1,857 generated client reports, 91 MB |
| `ghl_conversation_messages` | 11,335 CRM conversation messages |
| `listing_images` | 9,089 listing photographs |
| `document_chunks` | indexed customer document text, 59 MB |

A deny-list would have to name all of them, and would be wrong the moment
somebody adds a table. `referenceTables.pure.test.ts` asserts each of those
stays disallowed.

## Three refusals

**1. Allow-list, never deny-list.** `isReferenceTable` answers `false` for
anything not named — including tables that did not exist when the list was
written.

**2. An identity column must be classified, and the LIVE schema decides which
columns those are.** The allow-list is configuration and configuration goes
stale; the prime's `information_schema` is the effect. Every run reads the real
column list, applies `IDENTITY_COLUMN_PATTERN`, and **refuses the table** if it
finds a match nobody has classified. Add `owner_user_id` to
`template_library_entries` tomorrow and the sync stops, rather than copying a
prime user's id into a tenant's database.

The reverse is a refusal too: a classified column that is no longer in the
schema fails the table. A classification binding to nothing means the entry was
written against a different shape, and the columns it *does* still name cannot
be trusted either.

The pattern is deliberately broad, because it is a prompt to look rather than a
decision. `document_requirement_templates.default_owner` matches it and holds
`client` / `legal` / `finance_partner` — a role, not a person — so it is
classified `keep` with that reason. Over-matching costs a line in a file;
under-matching costs a tenant.

**3. A row filter is part of the allow-list.** A table can be reference data in
most rows and tenant data in the rest. That is why `report_templates` is
excluded rather than filtered: 111 rows, 5 with a populated `owner_user_id`,
258 MB with its version history, and it is not the seeded catalogue anyway.

## Two properties worth keeping

**Identity columns are stripped on the prime, inside the SELECT.**
`to_jsonb(t) - ARRAY[…]::text[]` runs in the read query, so a prime user's id is
never in Mission Control's memory — not merely never written to the clone.
"The clone never receives it" and "it was never read" are different guarantees
and only the second one holds here.

**Rows cross as one `jsonb` literal, cast by Postgres.** The alternative —
rendering each value as a SQL literal — needs a correct renderer for jsonb,
arrays, enums, timestamptz, numeric and bytea, and gets it wrong quietly: a
number round-tripped through a JavaScript double loses precision, and a
hand-reserialised `jsonb` changes key order. `jsonb_populate_recordset(null::public.<table>, $json)`
makes the table's own record type do the casting, and leaves exactly one string
to escape — which is also the entire injection surface.

## Shape: budgeted and resumed

~19 MB across eight tables does not fit in one edge invocation, and a worker
that tries is the shape that timed the mirror cascade out at exactly 60,000 ms.
A run works to a wall-clock budget (90 s under the cron's 120 s timeout), banks
a **keyset** cursor per table in `clone_reference_syncs`, and returns.

Keyset, not `OFFSET`: this copy is resumed across ticks by definition, and
`OFFSET` on a table being written to skips and repeats rows at every page
boundary. The cursor advances **only after a page has landed** — a crash between
the read and the write re-copies a page, which `on conflict do nothing` makes
free, whereas advancing first would skip it and nothing would ever notice.

`on conflict do nothing`, never `do update`. A clone is a live tenant that may
have edited a catalogue row, and a sweep silently reverting their edit is a
worse failure than a row one version behind. **Seeding is not replication.**

## Scheduling and claims

`reference-data-sync-hourly` at `43 * * * *`, hourly because seeding a clone
finishes and then costs one cheap "already complete" read per tick forever
after; the only work it picks up later is a newly provisioned clone.

The claim is `clone_backends.reference_sync_started_at` and **not**
`worker_started_at`, which the fleet migration sync owns. Sharing one column
means each worker's release clears the other's claim, and the failure is
invisible — two runs copying the same page concurrently is idempotent, so it
looks like it worked while quietly doubling the prime's read load. Both workers
still require `status = 'ready'`, so neither runs against a schema that is
mid-migration.

Provisioning deliberately calls neither. A backend that has just reached `ready`
is exactly what the hourly sweep claims, so a new clone is seeded without the
provisioning pipeline growing a step that can fail and leave a half-built tenant
behind. **Seeding is a property of a ready clone, not a stage of building one.**

## The AML programme, the flags, and the registers

The list grew by sixteen on 6 September 2026, and the reason is the same gap
this file opens with, one layer down: the schema travels by catalog
introspection, and a seed `INSERT` in a migration is data the introspection
cannot see. Every clone therefore held **zero** rows in `public.feature_flags`
(34 on the prime — so every flagged module read as off) and zero in every
`aml.*` table, including the programme configuration the module refuses to run
without and the two registers screening fails closed against.

Three shapes of entry, and the rules each turns on:

- **`public.feature_flags`** — the switches themselves. `on conflict do
  nothing` is what makes this safe: a flag a tenant has since set keeps the
  tenant's value, because seeding is not replication.
- **The programme configuration** (`aml.plan_tiers` → `aml.tenant_settings` →
  `aml.provider_configs`, then the factors, triggers, rules, retention and
  catalogues). The order is load-bearing twice over — two real foreign keys.
  `tenant_settings` is the entry to read before adding anything like it: the
  prime's row is entirely generic (the module's own default title, no contact,
  no MLRO, no brand kit), and every person-shaped field is nulled anyway —
  including `mlro_contact_name`, which the identity pattern cannot flag and is
  classified by hand. `provider_configs` also nulls the prime's own
  provider-health readings: a tenant earns its own.
- **The registers** (`aml.sanctions_list_syncs` → `aml.sanctions_entries`,
  `aml.pep_officeholder_syncs` → `aml.pep_officeholders`) — published
  reference data in the most literal sense. The LEDGERS travel first and are
  part of the register: the provider judges freshness by the latest recorded
  load, so entries without their ledger read as a register that never loaded,
  and screening keeps refusing. `normalised_names` travels verbatim because it
  was written by the same server-side normaliser the screening query uses.

Mechanically this is the `schema` field on an entry and `refName()` everywhere
a table is named outside the allow-list — the SQL builders qualify with the
entry's schema, and the `clone_reference_syncs` state row for an `aml` table is
keyed `aml.<table>` while public tables keep their bare key, so nothing
already complete re-copied when the field arrived.

## Adding a table

1. Confirm it is reference data — check whether its identity columns are
   populated on the prime, not just whether they exist.
2. Add an entry with a `reason`, a `pageKey` that is unique and orderable, a
   `rowsPerPage` sized from the measured average row width, and a
   classification for **every** column the identity pattern flags.
3. Put it after anything it references — the copier walks the array as written.
4. `npm run test` — the allow-list specs check reasons, page sizes, ordering,
   and that the known tenant tables are still disallowed.
