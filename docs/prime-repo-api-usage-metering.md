# API key usage: metering and recharge

## The problem this solves

Mission Control provisions a clone by replicating the prime repo's Supabase
architecture onto a fresh project — migrations, edge functions, and the *secret
names* those functions read. For a whitelisted subset of those names
(`prime_secret_forwards.inherit = true`) it also forwards the prime's **real
key values**, because a secret shell makes every consumer 500 on its first call.

That is deliberate and it is what lets a clone work on day one. It also means a
clone spends **our** money from its first request: its OpenAI tokens, Resend
emails, Domain lookups and AML verifications are billed to the prime's vendor
accounts. Until now none of that was attributable to the tenant that caused it.

This system meters it and recharges it — and charges nothing for a key the
clone supplies itself.

## The billability rule

There is exactly one input, and nobody sets it by hand. It is
`clone_backend_secrets.status`, which provisioning writes and the operator "set
secret value" action updates:

| status | meaning | billed |
|---|---|---|
| `inherited` | provisioning forwarded our key onto the clone | **yes** |
| `minted` | a key minted for this clone on Aurixa's account (OpenAI, OpenRouter, the email identity's Resend key) | **yes** (`inherited`) |
| `federated` | a short-lived token in Aurixa's organisation, bound to this clone | **yes** (`inherited`) |
| `withheld` | taken off the clone; Mission Control makes the call for it | **yes** (`brokered`) |
| `set` | the clone's own key, or a value Mission Control set for it | no — BYOK |
| `missing`, `failed`, `authorised_no_value` | no working key on either side | no |
| *(no row)* | we never lent this clone this key | no — and it is flagged |

Two writers once recorded Aurixa's money as `set` (key audit R3, 29 Oct 2026),
and both now decide per name:

- **The email identity's Resend key** is minted on Aurixa's Resend account, so
  it is `minted` (`settledLedgerStatus`). It was `set` on all four clones that
  had one, so every email rated `byok`. The hourly email audit corrects a row
  it finds `set`. Whether email is billed or absorbed is the rate row's
  `absorbed` flag, never this record.
- **The Integrations page** (`/api/public/integrations/secrets`) recorded every
  write `set`. It now keeps a platform-paid record when the save changed
  nothing, records Mission Control's own value as `inherited`, and records only
  a key the tenant brought as `set` (`integrationLedgerStatus`).

The last row matters. An event we cannot tie to a key we lent is recorded and
surfaced as `unknown_secret`, never charged. **We do not bill on a guess.** At
volume it means the prime's reporter is sending a name the provisioner does not
know, which is a bug to fix rather than spend to collect.

Two more outcomes are free by design: a call the vendor rejected (`error_call` —
charging for nothing delivered is indefensible on an invoice), and a key we
forward as platform overhead rather than tenant usage (`not_billable`, e.g.
`CLOUDFLARE_API_TOKEN`).

The rule lives in two places, on purpose:

- `public.resolve_api_key_billability(clone_id, secret_name)` — used inside the
  ingest transaction, because the lookup and the rollup update must be atomic.
- `src/lib/api-usage-rating.ts` → `resolveBillingReason()` — the same rule,
  pure, pinned by `api-usage-rating.test.ts`. Change one, change both. It has
  no runtime caller, so nothing but that discipline keeps it true: until
  29 Oct 2026 it rated `minted` and `federated` as `no_key` and kept a failed
  call on a tenant's own key `byok`, where the SQL bills the first two and
  calls every failed call `error_call` (key audit A1).

## Why the secret name is the key

`secret_name` is the only identifier shared by all three parties:

- the prime's edge functions read it from `Deno.env.get("…")`,
- `prime_secret_forwards` whitelists it for forwarding,
- `clone_backend_secrets` records whose key is behind it on each clone.

A provider slug is not good enough: `GOOGLE_MAPS_API_KEY` and `GOOGLE_API_KEY`
are the same vendor and separate bills.

## Money

Rates are carried in **micros** — 1e-6 of a currency unit, so 10,000 micros =
1 cent. Per-token prices sit far below a cent (AUD 0.0000006 per Gemini Flash
input token); in cents they round to zero and the meter would read free forever.

Micros become cents **once**, on the settled period total — never per line. A
thousand sub-cent calls would each round to nothing and bill as zero.

## The tables

| table | what it is |
|---|---|
| `api_provider_rates` | the price list, one row per secret name: unit, our cost, resale rate, free allowance per period, billable flag |
| `api_usage_events` | every reported call with its rating decision and reason — the answer to a disputed invoice |
| `api_usage_rollups` | `(tenant, period, secret)` totals, maintained inside the ingest transaction so it cannot drift from the events |
| `api_usage_charges` | one settled charge per tenant-period; immutable once closed |
| `api_usage_charge_lines` | the per-secret detail behind a charge |

Rollups and charges are the billing record and are kept indefinitely. Raw events
are purged at 400 days (`purge_api_usage_events`) — longer than any plausible
dispute window plus a year-on-year comparison.

## The flow

```
prime edge function
  → logApiUsage()                    writes api_usage_log (fire-and-forget)
  → report-api-usage worker (cron)   drains it in batches of 200
  → POST /api/public/usage/report    x-clone-api-key, scope usage:report
  → record_api_usage_event()         rates each event, updates the rollup
  → close_api_usage_period()         applies the free allowance, micros → cents
  → Stripe invoice item              rides on the tenant's next invoice
```

### Ingest

`POST /api/public/usage/report`, scope `usage:report`, batches of up to 200:

```jsonc
{
  "tenant_ref": "prime:abcdefgh",
  "display_name": "Naidu Property",
  "events": [
    {
      "secret_name": "OPENAI_API_KEY",   // the Deno.env name, not a vendor slug
      "quantity": 1500,                   // tokens, emails, lookups — per the rate's unit
      "idempotency_key": "<api_usage_log row id>",
      "model": "gpt-4o-mini",
      "feature": "/v1/chat/completions",
      "status": "success",                // "error" is metered, never charged
      "occurred_at": "2026-08-07T10:00:00.000Z"
    }
  ]
}
```

Every event gets its own outcome, and a malformed one does not cost the other
199 their delivery:

```jsonc
{
  "ok": true, "accepted": 199, "rejected": 1, "billable": 140,
  "results": [{ "idempotency_key": "…", "ok": true, "billable": true,
                "billing_reason": "inherited", "duplicate": false }]
}
```

Idempotency is on `(tenant_id, idempotency_key)`: a retried batch returns the
original rating rather than charging twice.

### Settlement

A period closes only once it has **ended** — closing an open cycle would bill
half a month and freeze the rollups the rest of it needs. `hooks/api-usage-settle`
runs the sweep on cron (Bearer `DRIFT_REFRESH_TOKEN`, like the other hooks); the
manual path is Billing → API Usage → Charges.

Closing is idempotent: re-closing a closed period returns it untouched. Invoicing
is idempotent three times over — an already-invoiced charge returns early, the
Stripe call carries `api-usage-charge-<id>` as its idempotency key, and the item
id is written back immediately.

Charges under `MIN_INVOICEABLE_CENTS` (50c) close, are marked invoiced with
`below_threshold`, and never reach Stripe: reconciling them costs more than they
collect.

A **Stripe invoice item** is the primitive, not a separate payment. It rides on
the tenant's next subscription invoice as an extra line, which is what "an
additional charge for API key usage" means on a statement.

Waiving a charge never edits the meter. Events and rollups stay exactly as
reported; the waiver is recorded with who and why, so a written-off month still
reconciles against usage. A charge already on a Stripe invoice cannot be waived
here — that credit belongs in Stripe, or our record and the customer's statement
disagree.

## Repricing is not retroactive

`api_usage_events.rated_micros` is stamped at ingest. A rate changed today
cannot rewrite what a tenant was quoted last week. Every edit to
`api_provider_rates` is written to the audit log with before and after.

## The seeded catalog

Seeded from a scan of all 412 edge functions in `npc-property-dashbord` for
`Deno.env.get("…")`. Config values, feature flags, internal HMACs and the
Supabase-injected names are deliberately absent — they cost nothing and charging
for them would be indefensible.

Metered and billable: Lovable AI Gateway, OpenAI, Anthropic, Perplexity,
OpenRouter, Gemini, Google AI, Resend, Microsoft Graph, Domain, Cotality,
Airtable, Firecrawl, Google Maps, Vapi, Gamma, API2PDF, WeasyPrint, PDF parse,
DocuSign, AML verification, GoHighLevel (×2), ManyChat, Meta Ads.

Metered, not billable: Turnstile, Cloudflare API, Figma, MCP — platform
overhead, not tenant usage.

The migration also seeds `prime_secret_forwards` for the billable keys **except**
the ones that are per-tenant by nature — Microsoft Graph, GoHighLevel, DocuSign,
Meta Ads, ManyChat, Airtable. A shared credential there would cross-contaminate
mailboxes, CRM locations and signing identities between agencies. Those are
metered when an operator sets a shared key deliberately, and BYOK otherwise.

Opening rates are positions for an operator to tune in Billing → API Usage, not
fixed prices.

## Where things fail quietly, and what surfaces them

Two failure modes cost real money without erroring:

- `rate_missing` — a key nobody catalogued. Metered at zero.
- `unknown_secret` — a clone reporting a key provisioning never recorded lending it.

Both are counted on the "Metered but not billable" card on `/billing/api-usage`
rather than left in the tail of an events table nobody opens. A third —
`usage:report` missing from a clone's API key — meters *nothing at all*, which
is why that scope is on by default for newly-issued keys.

## Prime side

See `docs/integrations/API_USAGE_METERING.md` in `npc-property-dashbord`.
