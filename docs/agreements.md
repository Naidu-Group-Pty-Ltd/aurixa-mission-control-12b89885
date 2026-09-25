# Agreements — Subscription Agreements and SLAs via DocuSign

Leads sign two kinds of agreement from `/agreements`, through one DocuSign
flow and one lifecycle — `draft → sent → delivered → signed / declined /
voided`:

- the **Subscription Agreement** — the approved Launch, Growth or Scale Word
  template, completed field by field from an offer the operator prepares in
  Mission Control. It *is* the commercial offer. See
  [Subscription Agreements](#subscription-agreements--launch-growth-and-scale).
- the **Service Level Agreement** — a fixed PDF with a handful of prefilled
  tabs, raised against a CRM contact. See
  [The Service Level Agreement template](#the-service-level-agreement-template).

Both live on `client_agreements`, told apart by `document_kind`. A signed or
declined transition raises an operator notification, and either kind can
provision the customer's clone on signature.

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
| `DOCUSIGN_COUNTERSIGNER_NAME` / `DOCUSIGN_COUNTERSIGNER_EMAIL` | *(optional)* on an SLA, an Aurixa signatory routed **second**, after the client signs. On a Subscription Agreement the same address receives a **copy** (routing 2) and does not sign — the agreement's clause 1.2 requires no Aurixa countersignature. Omit both and the envelope is client-only |

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

## Subscription Agreements — Launch, Growth and Scale

The Subscription Agreement is the offer itself. Each tier has its own approved
Word template, and an issued offer is that template with every Order field
completed from an offer recorded in Mission Control: the customer, the package
and term, the price, the dates, the Schedule A4 purchase and usage records, and
the Schedule E5 service disclosures. It is sent through the same DocuSign
account, lifecycle, refresh cron, Connect webhook and provision-on-signature
pipeline as the SLA, on the same `client_agreements` row
(`document_kind = 'subscription'`), rather than through a parallel system.

The rules below are the agreement's own. Clause 1.2 says an offer is made "by
authorised issue of the completed document", that "an uncompleted template is
not an offer", and that "we retain the accepted document and commercial
snapshot before activating the purchase". Each rule enforces one of those
sentences.

### The flow

1. **Raise the offer**, either from `/agreements` → *New Subscription
   Agreement* or from a lead's row on `/leads` (*Agreement*). Choose the tier
   and who the offer is for: a waitlist lead, a CRM contact, or nobody yet.
   This creates a draft under a fresh reference, `AUR-SA-YYYYMMDD-XXXXXX`. The
   reference is printed beside the signature and is unique in the database.
   - The draft is prefilled from the issuing profile (below).
   - It is also prefilled from what Mission Control already knows: the lead's
     organisation, email, name and role. A linked CRM contact fills only what
     the lead left blank.
   - Every prefilled value is a starting point the operator confirms. The offer
     cannot be sent until the signatory is verified, the identifier passes its
     check digits, and the address is confirmed.
2. **Complete it** at `/agreements/<id>`.
   - The page follows the document's order: Order, Customer, Authorised
     representative, Schedule A4 lines, support and one-off charges, Schedule
     A4 authorities, Schedule E5 disclosures, negotiated departures.
   - Every input sits beside the gap that names it.
   - The side panel shows what is still missing, the price as the Order will
     print it, the dates it states, and what a signature will provision.
   - Nothing on the page calculates a price; the composer does
     (`subscriptionOffer.pure.ts`).
   - Changes are kept with *Save*. Leaving with unsaved changes asks first.
3. **Preview it.** *Preview .docx* downloads the completed document exactly as
   DocuSign would receive it, with three differences that mark it as a preview:
   - it is named `PREVIEW - Aurixa <Tier> Subscription Agreement <reference>.docx`;
   - the acceptance field reads "PREVIEW ONLY — an internal review copy, not an
     offer. Do not sign this copy.";
   - its document title starts with `PREVIEW —`.

   A preview is offered only once the offer is complete, because an incomplete
   template is not an offer. *Every field as it prints*, at the foot of the
   page, shows the same text without downloading anything.
4. **Send it.** *Send for signature* completes the template again on the
   server, writes the commercial snapshot, and then creates the envelope. The
   customer's authorised representative is the only signer. If
   `DOCUSIGN_COUNTERSIGNER_*` is set, that address receives a carbon copy.
5. **Signed.** The lifecycle moves exactly as it does for an SLA. When the
   envelope completes, the combined signed PDF is retained in Mission Control's
   own storage. If provisioning is armed, the clone is then provisioned from the
   offer's own selection.
6. **Revise.** An issued offer never changes. *Duplicate* (or *Prepare a
   revised offer*, on a voided or declined one) copies it into a new draft
   under a new reference.

### The templates

| Tier | File, under `public/agreements/subscription/` | Template id | SHA-256 | Tokens per cycle |
| --- | --- | --- | --- | --- |
| Launch | `aurixa-launch-subscription-agreement.docx` | `aurixa-subscription-launch-v8` | `f2fcd625…` | 7,000 |
| Growth | `aurixa-growth-subscription-agreement.docx` | `aurixa-subscription-growth-v8` | `cd14a5e1…` | 35,000 |
| Scale | `aurixa-scale-subscription-agreement.docx` | `aurixa-subscription-scale-v8` | `d8c6d20d…` | 75,000 |

These are the owner's final documents (C01 Launch, C02 Growth, C03 Scale).
Their text is committed exactly as approved; only their document properties
were amended (see *What the files carry*). Nothing in this repository
generates or edits them. `SUBSCRIPTION_TEMPLATES`
(`src/lib/agreements/subscriptionTemplates.ts`) pins each file's full digest.
The send fetches the template from the Worker's own origin and refuses any file
whose digest differs — a stale deploy, a CDN serving something else, or an
edit nobody reviewed — so no offer goes out on unapproved text.

The same module transcribes each template's Schedule A3 (the optional
catalogue, its reference prices and each tier's "Included" markers) and
Schedule A5. The tests read both tables back out of every committed file and
fail on any difference. As a result, the price an Order states is always the
price the same document's Schedule A3 prints.

**Replacing a template.** Commit the new file. In the same change, replace its
digest in `SUBSCRIPTION_TEMPLATES`, and its id and version if the title
changed. Then run the tests: they re-read every content control and the A3/A5
tables from the new file. They also fail if its document properties mention a
draft, or name anyone other than Aurixa Systems Pty Ltd as its author or last
editor. Word's Document Inspector (File › Info › Check for Issues) removes the
names; set the title (it must end with the version) and the status again
afterwards.

**What the files carry.** They are served publicly, as the SLA PDF is, and the
list page links to all three. Their document properties are final: status
*Final*, creator and last editor *Aurixa Systems Pty Ltd*, and a title that
names the tier and version.

- **The amendment.** On 25 September 2026 the approved files' `docProps/core.xml`
  was replaced — it described them as an "approval draft" and named the person
  who last edited them. That is the only part that changed. Every other part is
  byte-identical to the approved files, which were pinned as `769a86aa…`,
  `055d801b…` and `7c22dc9b…`.
- **The guard.** A test fails if a committed template's properties ever again
  carry a draft status or a person's name.
- **Issued documents** rebuild `docProps/core.xml` again, with the title, offer
  reference and template id.
- **The artwork.** The cover and divider images carry C2PA content credentials
  recording that Claude produced them. That is a provenance record, not
  personal information, and it is left as it is.

### Completing the document

The templates hold one plain-text Word content control per Order field (tagged
`customer.legal_name`, `order.payment_basis`, …) and one repeating section for
the Schedule A4 purchase records. `src/lib/agreements/docxFill.pure.ts` fills
them on `word/document.xml` as a string. This is deliberate: a Worker has no
DOM parser, and only the control spans are rewritten, so every other byte of
Word's markup passes through untouched.

The fill is strict in both directions, because the failures it prevents are
silent:

- A control with no value is an error, not a blank.
- A value for a tag the template does not contain is an error. It means the
  composer and the template disagree about the form.
- A control of a kind the engine does not understand is an error, rather than
  being left in place.

The controls are then removed, so what is issued is a document, not a form.
`assertIssuedDocument` is the last gate before a document leaves. It checks
that:

- no content control survives;
- no `[placeholder]` bracket survives (a test pins that the templates have no
  bracket outside their placeholders);
- each DocuSign anchor (`\sub_sig_client\`, `\sub_date_client\`) appears
  exactly once;
- the XML is well-formed.

The anchors are strict (`anchorIgnoreIfNotPresent: false`), so DocuSign also
refuses a document with no place to sign. The package is rebuilt by
`zipWriter.pure.ts` using `CompressionStream`, and hashed with WebCrypto;
nothing here needs Node.

### The offer and its price

The offer (`client_agreements.offer`) is a versioned, schema-validated working
copy (`subscriptionOfferSchema`). `composeSubscriptionOffer` turns it into:

- the text of every field;
- the lines and totals;
- the dates;
- a list of named **gaps**.

Any gap blocks the send. Every rule the arithmetic follows is the agreement's
own, quoted in `subscriptionPricing.pure.ts`:

- **5.1** — a 12-month commitment takes 15% off the complete with-AML or
  without-AML base.
- **5.4** — the discount applies to the base only. Seats, modules, credit packs
  and support stay at their accepted prices. The clause's own worked
  differences are reproduced in a test.
- **5.2** — the commitment is paid either as 12 monthly advance instalments or
  as one annual prepayment of the discounted base. Neither option increases the
  discount.
- **5.3** — renewals and the commitment's end keep the original anchor day, use
  the last day of a month that lacks it, and return to the anchor when it
  exists again. Activation on 31 October renews on 30 November, then on
  31 December.
- **7.3** — prices include GST; the GST is stated as contained, never added.

Money is integer cents throughout.

Additional lines are priced from the same document's Schedule A3. Items the
tier already includes are not offered. The Builder / Developer Portal needs its
own agreement, and Lenders is not for sale, so neither can be added.

Schedule A4's usage authorities are required as the template requires them:

- The variable-use, API and storage, and reservation-buffer rows are required
  on every offer.
- The AML rows are required on an offer With AML.
- The communications rows are required only where something sends email, SMS
  or voice: Email Copilot, Call Logs, Marketing, or the Scale tier itself.
  Otherwise they print a fixed "not selected" statement.

Schedule A4 also prints the **report rate card**: the token cost of each fixed
job. The editor reads it live. The snapshot keeps the version and rows as they
stood at the send, and an issued offer shows that copy.

### The issuing profile

`/agreements/issuing-profile` holds Aurixa's standing facts:

- the Schedule E5 service profile, and the hosting, processing and retention
  disclosures;
- the legal, support and privacy contacts;
- the correction route named in the DocuSign invitation;
- the default payment method;
- the default Schedule A4 usage wording.

It is one row (`agreement_issuing_profile`), which operators can read and only
an admin can change. Each new offer **copies** it, so every offer carries the
facts it was prepared with. When the profile has changed since an offer was
prepared, that offer's page says so and offers *Apply current profile*.

**Until an admin completes the profile, every new offer starts with the same
gaps** — about fifteen facts every offer prints. The list page says how many
are missing.

### Sending: one press, one envelope

A send (`sendSubscriptionEnvelope`, in `src/server/subscription-agreements.server.ts`)
runs in this order:

1. **Claim.** The offer is claimed by compare-and-set on `issued_at`. A double
   click, or two operators, therefore produce one envelope.
2. **Complete.** The template is completed and checked, as described above.
3. **Snapshot.** The commercial snapshot is written to `issued_snapshot`
   *before* the envelope is created. It holds:
   - the composed field text, lines, totals and dates;
   - the rate card;
   - the template id, version and digest;
   - the document name;
   - the SHA-256 of the exact `.docx` DocuSign receives, and of its
     `word/document.xml`.
4. **Envelope.** The envelope is created. It carries two hidden custom fields,
   `mc_agreement_id` and `mc_offer_reference`.

If a send dies part-way, the claim is kept. The page shows **send
interrupted** after ten minutes (`STALE_SEND_CLAIM_MS`) and offers *Finish
sending*. That action asks DocuSign, by the custom field, whether the earlier
send created an envelope:

- if it did, the envelope is recorded;
- only if none exists is the offer sent.

An ambiguous DocuSign failure is never retried blind, because releasing the
claim would let a retry send the customer a second offer.

Once an envelope exists, the database refuses any change to the offer, its
reference, its `issued_at` or its snapshot
(`client_agreements_freeze_issued_offer`). It also refuses to delete an issued
offer (`client_agreements_keep_issued_offer`). A correction is a new offer
under a new reference, which is also what clause 1.2 requires.

The **issued copy** can be downloaded again at any time. It is reproduced from
the stored offer and the snapshot, then checked against the snapshot's
`word/document.xml` digest. If the template or the composer has changed since
the send, nothing is served, and the page points to the document as sent in
DocuSign. A document that differs from the one the customer received is never
served.

### Signed: retention, then provisioning

When DocuSign reports the envelope completed, `retainSignedSubscriptionRecord`:

1. downloads the combined signed PDF, including DocuSign's certificate of
   completion;
2. checks that it is a PDF;
3. stores it in the private `agreement-records` bucket at
   `subscription/<agreement id>/<envelope id>-signed.pdf`;
4. records its SHA-256 and the time it was retained.

The bucket has no policy for authenticated users. Only the service role writes
it, and operators download through a server function that checks the digest
first. A retained record is written once: the freeze trigger refuses to replace
it.

**Nothing is provisioned from a Subscription Agreement whose signed record has
not been retained.** `decideProvisionOnSignature` refuses it as
`acceptance_not_retained`. If DocuSign is unavailable at the moment of
signature, the row shows "the signed copy has not been retained yet", and one
of three things retains it:

- the agreements-refresh sweep retries retention, newest signature first, ten
  a sweep;
- the next sweep **releases** each retained, still-armed agreement into
  provisioning, two a sweep. Provisioning creates a repository on the GitHub
  App installation, so the release asks the GitHub budget first
  (`decideSpend`, role `actor`). When the window is at its reserve floor, it
  stands down and leaves the rows armed for the next sweep (the response
  reports `release_deferred`). The sweep's GitHub calls are attributed to the
  `agreements-refresh` lane;
- an operator can press *Provision now*, which tries retention once more
  before provisioning.

What a signature provisions is **derived from the offer**:

- the plan is the tier;
- the add-ons are the offer's additional modules, plus any module the tier's
  own agreement includes that the catalogue does not bundle at that tier.

This means what the customer signed for is what they receive. Changing the
selection by saving the offer disarms provisioning, so it has to be re-armed
once the offer is final. On a voided or declined offer, the panel says nothing
will be provisioned.

### Where the approved text and Mission Control disagree

Each difference was put to the owner, who decided all three on
25 September 2026. Each is named in code or a test rather than left to be
found, and none stops an offer being issued.

- **Growth includes Market News Feed** in the agreement, but the catalogue
  (`aurixa-catalog.ts`) bundles it only at Scale. *Decided: it stays that
  way.* Market News Feed remains an extra that the Growth agreement includes,
  so a Growth signature provisions `market-updates` as an add-on and the
  catalogue is unchanged. `KNOWN_INCLUSION_DIFFERENCES` in
  `subscriptionTemplates.test.ts` names the difference, and any new one fails
  until it is decided and named there.
- **Advanced Forms Builder** is sold in Schedule A3, but the catalogue has no
  module for it. *Decided: a signature does not switch it on.* The line prices
  and prints, and the page says it is not provisioned automatically.
- **The commitment discount.** The agreement's is **15% of the base** for a
  12-month commitment (clause 5.1), payable monthly or as one annual
  prepayment (5.2), and never applied to seats, modules, credit packs or
  support (5.4). The public price list's annual option (`ANNUAL_DISCOUNT`)
  took 10% instead. *Decided: 15% everywhere* — the price list, the pricing
  page and the voice agents follow the agreement, not the other way round.
  That change ships on its own, because it mints new annual prices in Stripe
  and re-uploads the voice agents' knowledge base; the agreement prices only
  from its own text either way.

### Rolling it out

1. Merge. `.github/workflows/apply-migrations.yml` hands
   `supabase/migrations/20260925100000_subscription_agreements.sql` to the
   migration queue and fails unless it is applied
   ([`MIGRATION_QUEUE.md`](./MIGRATION_QUEUE.md)). Confirm that run is green
   before the code is published. The migration is additive and the SLA flow
   runs unchanged against it, so it is safe to land first. Details below.
2. As an admin, complete `/agreements/issuing-profile`.
3. Before the first real offer, issue one to an internal address and read the
   document DocuSign shows. On the production account an envelope is
   billable, and the recipient receives a real offer.

### The pieces, for a Subscription Agreement

- `public/agreements/subscription/` — the three approved templates.
- `src/lib/agreements/`:
  - `subscriptionTemplates.ts` — template digests, Schedule A3 and A5, anchors.
  - `subscriptionOffer.pure.ts` — the offer schema, the composer and the
    issuing-profile schema.
  - `subscriptionPricing.pure.ts` — the clause 5 and 7.3 arithmetic and dates.
  - `subscriptionIssue.pure.ts` — the envelope, snapshot, send claim, file
    names and provisioning selection.
  - `docxFill.pure.ts`, `docxPackage.pure.ts`, `zipWriter.pure.ts` —
    completing and packaging the document.
  - `offerEditor.pure.ts` — what the page shows about gaps, sections and the
    review.
- `src/server/subscription-agreements.server.ts` — the template fetch and
  digest check, preview and issued copies, the send and its recovery, and
  retention.
- Server functions in `src/lib/agreements.functions.ts`:
  - context: `getSubscriptionContext`, `saveIssuingProfile`;
  - leads and offers: `searchAgreementLeads`, `createSubscriptionAgreement`,
    `getAgreement`, `saveSubscriptionOffer`, `duplicateSubscriptionOffer`;
  - the document: `downloadSubscriptionAgreementDocument`.
- `src/routes/agreements.$agreementId.tsx` — the offer page.
- `src/routes/agreements.issuing-profile.tsx` — the profile.
- `src/components/agreements/` — the editor, the side panels, the
  new-offer dialog (also mounted on `/leads`) and the profile form.
- `supabase/migrations/20260925100000_subscription_agreements.sql`:
  - on `client_agreements`: `document_kind`, `lead_id`, `offer`,
    `offer_reference`, `issued_at`, `issued_snapshot` and the three
    signed-record columns;
  - the freeze and keep triggers;
  - `agreement_issuing_profile`;
  - the `agreement-records` bucket;
  - the `agreement_attention` notification kind — an envelope DocuSign
    accepted that could not be recorded, or a signed record that could not be
    retained.

## The Service Level Agreement template

The SLA every client sees is `public/agreements/aurixa-sla-template.pdf`:
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
  download, void, delete-draft — and the subscription functions listed
  under [The pieces, for a Subscription Agreement](#the-pieces-for-a-subscription-agreement).
- `src/routes/agreements.index.tsx` — the list: metrics, config and
  issuing-profile banners, filters, one lifecycle row per agreement of
  either kind, the new-SLA dialog with CRM contact picker (shows journey
  stage), void dialog.
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
   provisioning is at most ~10 minutes behind the pen. The same sweep
   retries retention of any signed Subscription Agreement whose record is
   not yet held, and releases retained, still-armed ones into provisioning —
   see [Signed: retention, then provisioning](#signed-retention-then-provisioning).
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
