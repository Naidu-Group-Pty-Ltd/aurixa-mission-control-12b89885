# Agreements — Service Level Agreements via DocuSign

Converted leads sign an Aurixa Systems Service Level Agreement. The operator
raises it at `/agreements` (usually against a CRM contact), sends it for
signature through DocuSign, and the lifecycle is tracked on the same page:
`draft → sent → delivered → signed / declined / voided`. A signed agreement's
PDF downloads straight from DocuSign; a signed or declined transition raises
an operator notification.

The flow mirrors the prime repo's `manage-agency-agreements` module — the
same JWT-grant auth, the same anchor-token envelope pattern — rebuilt for a
Cloudflare Worker with WebCrypto.

## Built now, connected later

Like the softphone, the feature is env-gated. Until the secrets exist,
`/agreements` says exactly what is missing; drafts can still be prepared and
nothing pretends to send.

| Secret | What it is |
| --- | --- |
| `DOCUSIGN_INTEGRATION_KEY` | The app's integration key (GUID) from the DocuSign console |
| `DOCUSIGN_USER_ID` | API User ID (GUID) of the impersonated user — Settings → Apps & Keys |
| `DOCUSIGN_RSA_PRIVATE_KEY` | RSA private key generated for the integration key (PKCS#1 is fine — it is converted; escaped `\n` is fine — it is normalised) |
| `DOCUSIGN_ACCOUNT_ID` | API Account ID (GUID) |
| `DOCUSIGN_BASE_URL` | *(optional)* REST base; defaults to `https://demo.docusign.net/restapi`. Production accounts use the base URI shown in Apps & Keys, e.g. `https://au.docusign.net/restapi` |
| `DOCUSIGN_OAUTH_HOST` | *(optional)* overrides the OAuth host; otherwise derived (demo → `account-d.docusign.com`, production → `account.docusign.com`) |
| `DOCUSIGN_COUNTERSIGNER_NAME` / `DOCUSIGN_COUNTERSIGNER_EMAIL` | *(optional)* an Aurixa signatory routed **second**, after the client signs. Omit both and the envelope is client-only |

## DocuSign console setup (one time)

1. **Create an app** (Settings → Apps & Keys → Add App and Integration Key).
   Record the Integration Key.
2. **Generate an RSA keypair** on the app and keep the private key — that is
   `DOCUSIGN_RSA_PRIVATE_KEY`.
3. Record the **API User ID** and **API Account ID** from the same page.
4. **Grant one-time consent** for impersonation. Open (demo shown; swap the
   host for production):

   ```
   https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<INTEGRATION_KEY>&redirect_uri=https://www.docusign.com
   ```

   sign in as the impersonated user and click **Accept**. Until consent is
   granted, sending fails with a message carrying this URL.
5. Add the secrets to the Worker env and redeploy. No code change.

Demo envelopes are watermarked and free; switching to production is a
secrets change (`DOCUSIGN_BASE_URL` + re-consent on the production host).

## The template

The document every client sees is `public/agreements/aurixa-sla-template.pdf`:
nine clause pages generated in Gamma on the Aurixa brand (warm near-black
ground, metallic gold serif display — the **aurum** theme, matching the
aurixa-systems.com.au gold/dark identity) plus an **Execution Schedule** page
appended by `scripts/agreements/build-sla-template.mjs`. The script also
stamps the real brand marks onto the Gamma body: the full lockup
(`scripts/agreements/aurixa-lockup.png`, alpha-trimmed from
`aurixa-systems/brand-source/aurixa-lockup-source.png`) as the cover
centrepiece and in the Execution Schedule header, and the triangle mark
(`aurixa-mark.png`) in the top-right corner of every body page.

The execution page carries the machinery:

- **Visible**: labelled panels for client name, organisation, service tier
  and commencement date, and two signature blocks (Client / Aurixa Systems).
- **Invisible**: ~6pt anchor tokens (`\sig_client_1\`, `\field_service_tier\`, …)
  painted in the exact colour of the panel they sit on. DocuSign's text
  scanner finds them and places the tabs; humans never see them. The token
  strings are defined once in `ANCHORS`
  (`src/server/agreements.server.ts`) and a unit test asserts the build
  script carries every one verbatim.

When the agreement is sent, the client's details are stamped into those
panels as **locked text tabs** — the PDF itself is never regenerated per
client, so what was reviewed is what is signed.

### Regenerating the template

- Clause content or styling: regenerate the body in Gamma (theme **aurum**
  gave the current black/gold serif look), export as PDF, replace
  `scripts/agreements/aurixa-sla-gamma-source.pdf`.
- Logo artwork: rebuild `aurixa-lockup.png` / `aurixa-mark.png` from the
  sources in the aurixa-systems repo (`brand-source/`), alpha-trimmed.
- Execution page layout: edit `scripts/agreements/build-sla-template.mjs`.
- Then:

  ```sh
  node scripts/agreements/build-sla-template.mjs
  ```

  which rewrites `public/agreements/aurixa-sla-template.pdf`. Keep the
  anchor tokens byte-identical to `ANCHORS` — the test fails if they drift.

## The pieces

- `src/server/agreements.server.ts` — the DocuSign engine: JWT-grant auth
  (RS256 via WebCrypto, PKCS#1 → PKCS#8 conversion for console-issued keys),
  envelope build (anchor tabs + locked field tabs, client first, optional
  countersigner second), status refresh with notifications, signed-PDF
  download, void.
- `src/lib/agreements.functions.ts` — operator server functions: config
  state, list/search, create (with CRM contact link), send, refresh,
  download, void, delete-draft.
- `src/routes/agreements.tsx` — the page: metrics, config banner, filters,
  lifecycle rows, the new-agreement dialog with CRM contact picker (shows
  journey stage), void dialog.
- `supabase/migrations/20260828010000_client_agreements.sql` —
  `client_agreements` (linked to `crm_contacts` / `crm_accounts`), RLS,
  indexes, `agreement_signed` / `agreement_declined` notification kinds.

## Rules that carry it

- **Status is TEXT, not an enum.** DocuSign's envelope vocabulary is theirs
  to extend; unknown statuses update `docusign_status` and leave the
  lifecycle untouched rather than guessing.
- **An envelope is sent once.** A row with `docusign_envelope_id` refuses a
  second send; a revision is a void plus a new agreement.
- **The record outlives the envelope.** Voided and declined agreements stay
  on the page — they are history on the client record, not clutter. Only
  never-sent drafts can be deleted.
- **The template is fetched from the deployed origin** and checked to be a
  PDF before it is sent anywhere — a missing asset fails loudly, not with an
  empty envelope.

## Provisioning on signature

The agreement now carries the COMMERCIAL SELECTION — tier plan
(`billing_plans`), modules in (`modules`), add-ons (`addon_modules`), and the
modules the negotiation explicitly took OUT — and, when **armed**, the moment
DocuSign reports the envelope signed, Mission Control provisions the clone
from exactly those parameters. Same pipeline as the operator wizard
(`provisionCloneCore` → repo, clone row, entitlements, module install,
API key, secrets, subdomain, deployment enqueue; then
`enqueueCloneBackendProvisioning` → dedicated backend for the drain worker).
No second implementation.

Operate it from `/agreements`: the ⚙ button on a pre-signature row opens the
selection (plan, modules, add-ons, exclusions, clone admin email, the arm
switch); a signed row offers **Provision now** (also the retry after a
failure, and the manual path for an agreement that was never armed); a
provisioned row links to the clone.

### How the signature arrives — two paths, one handler

Both funnel through `applyDocusignStatus` (the ONE place the lifecycle
moves), which on the `signed` transition hands the agreement to
`provisionCloneFromAgreement`:

1. **The agreements-refresh cron** (`/hooks/agreements-refresh`, every 10
   minutes) polls every sent/delivered envelope with the same JWT
   credentials the send path uses. Works the moment the five DocuSign
   secrets exist — **no extra configuration** — so signature-driven
   provisioning is at most ~10 minutes behind the pen.
2. **DocuSign Connect webhook** (`/api/public/hooks/docusign`) makes it
   instant. One extra secret (below). Fails closed: unconfigured → 503,
   bad HMAC → 401.

**The poll was dead from the day it was installed, and said nothing.**
Measured 29 Aug 2026: 37 × HTTP 401 across the ~6 hours pg_net retains a
response, while `cron.job_run_details` reported all 36 runs `succeeded` —
because what pg_cron reports on is the SQL that QUEUES the call, never the
call. Two independent faults, each sufficient on its own:

- The credential read vault entry `DRIFT_REFRESH_TOKEN`, which does not
  exist. `verifyCronAuth` accepts `CRON_SECRET` **or** `DRIFT_REFRESH_TOKEN`
  as *environment* names, and that is a different namespace from the vault —
  the vault holds `cron_secret`. A subselect on a missing name returns NULL,
  and `'Bearer ' || NULL` is NULL, so `jsonb_build_object` stored a null
  header rather than raising.
- The URL was the `aurixa-mission-control.lovable.app` origin, which 307s to
  the custom domain. pg_net follows it, but libcurl drops `Authorization`
  across hosts, so the request arrives unauthenticated however good the
  token is. Verified directly: identical body and a correct `cron_secret`
  answers **401** on the lovable.app origin and **200** on the custom domain.

Repaired in `20260829100000_fix_agreements_refresh_cron.sql`, which also
reschedules `airtable-waitlist-sync` and `crm-sweep-hourly` — both were fixed
directly on the deployment and never in a migration, so the corpus still
installed the broken form. `check-cron-auth.mjs` now fails on either fault:
a vault name that is not `cron_secret`, and a `/hooks/` post to the
redirecting origin.

The lesson is the one this codebase keeps relearning: **a green cron run is
not a delivered request.** Read `net._http_response`, not
`cron.job_run_details`.

### Safety model

- Every skip is a **named refusal** (`decideProvisionOnSignature`): not
  armed, not signed, already done, in flight, previous attempt failed,
  no plan, no attributable creator.
- The agreement is **claimed by compare-and-set** on `provision_status`
  (`armed → provisioning`), so the webhook, the cron and the button land on
  one clone however they race — and under the claim, the clone insert
  carries idempotency key `agreement:<id>`.
- A **failed attempt never auto-retries** — external resources (a Supabase
  project, a GitHub repo) are not retried into on a timer. The failure is a
  notification plus a red badge, and the operator's *Retry provision* is the
  deliberate second attempt.
- The webhook **ledger** (`docusign_connect_events`) stores a summary, never
  the raw Connect body (recipient PII; with `includeDocuments` on, whole
  signed PDFs). Envelopes this platform did not send are acknowledged and
  recorded as `not_ours` — the same DocuSign account also carries NPC's
  client paperwork.
- The clone's seed admin password is generated, encrypted for the drain
  worker, and shown to nobody — the platform's own password-reset flow is
  the front door.

### DocuSign Connect setup (one time, ~5 minutes)

1. DocuSign admin → **Settings → Connect → Add Configuration → Custom**.
2. URL to publish: `https://mission-control.aurixasystems.com.au/api/public/hooks/docusign`
3. Format: **REST v2.1 (JSON)**. Trigger events: envelope **Sent,
   Delivered, Completed, Declined, Voided**. Do NOT include documents.
4. Enable **HMAC signature**, generate a key, and store the same value as
   the `DOCUSIGN_CONNECT_HMAC_KEY` secret in Mission Control's environment.
5. Save. Send a test agreement; the delivery ledger is
   `docusign_connect_events`.

### Account facts (traced 2026-08-28)

The DocuSign account behind admin@npcservices.com.au is **production AU** —
not a demo sandbox:

| Fact | Value |
| --- | --- |
| API Account ID | `1e4503ea-6211-4ff4-84d4-521034fe47a8` |
| REST base | `https://au.docusign.net/restapi` (`DOCUSIGN_BASE_URL`) |
| OAuth host | `account.docusign.com` (production consent, not `account-d`) |
| Impersonated user id | `5f978ac8-d03e-4644-8a2c-92b969c734d2` (`DOCUSIGN_USER_ID`) |

The integration key + RSA private key cannot be traced from outside — create
them in Settings → Apps & Keys per the runbook above, grant one-time consent
on the **production** host, and note that production envelopes are billable
(demo watermarking only exists on `demo.docusign.net` accounts).
