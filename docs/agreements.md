# Agreements — Subscription Agreements, SLAs and Builder Partner Agreements via DocuSign

Three kinds of agreement are prepared on `/agreements` and signed through one
DocuSign flow and one lifecycle — `draft → sent → delivered → signed /
declined / voided`. Leads sign two of them:

- the **Subscription Agreement** — the approved Launch, Growth or Scale Word
  template, completed field by field from an offer the operator prepares in
  Mission Control. It *is* the commercial offer. See
  [Subscription Agreements](#subscription-agreements--launch-growth-and-scale).
- the **Service Level Agreement** — a fixed PDF with a handful of prefilled
  tabs, raised against a CRM contact. See
  [The Service Level Agreement template](#the-service-level-agreement-template).

Builders sign the third:

- the **Builder Partner Agreement** — the terms an admin registers, plus an
  Execution Schedule Mission Control generates, sent to a Builders Network
  organisation before the Builder Portal opens to it. A signature admits the
  builder; it never provisions anything. See
  [Builder Partner Agreements](#builder-partner-agreements--before-the-builder-portal).

All three live on `client_agreements`, told apart by `document_kind`. A signed
or declined transition raises an operator notification. Either of the leads'
kinds can provision the customer's clone on signature.

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
| `DOCUSIGN_COUNTERSIGNER_NAME` / `DOCUSIGN_COUNTERSIGNER_EMAIL` | *(optional)* on an SLA, an Aurixa signatory routed **second**, after the client signs. On a Subscription Agreement the same address receives a **copy** (routing 2) and does not sign — the agreement's clause 1.2 requires no Aurixa countersignature. On a Builder Partner Agreement the registered terms decide: it countersigns second when they require it, and receives a copy otherwise (terms that require it cannot be put in force without it). Omit both and the envelope is client-only |

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
  without-AML base. The figure is the price list's own
  (`COMMITMENT_DISCOUNT_BPS`), so the pricing page's annual plan and an
  agreement's annual prepayment agree to the cent.
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
25 September 2026. Two stand by decision and the third is resolved. Each is
named in code or a test rather than left to be found, and none stops an offer
being issued.

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
- **The commitment discount** — resolved. The agreement's is **15% of the
  base** for a 12-month commitment (clause 5.1), payable monthly or as one
  annual prepayment (5.2), and never applied to seats, modules, credit packs or
  support (5.4). The public price list's annual plan used to take 10% instead.
  *Decided: 15% everywhere* — the price list, the pricing page and the voice
  agents follow the agreement. `COMMITMENT_DISCOUNT_BPS` in `aurixa-catalog.ts`
  is now the one figure:
  - the agreement's arithmetic imports it rather than restating it;
  - the annual plan is priced as the agreement's annual prepayment — the
    discount comes off each month and the result is multiplied by twelve —
    and a test compares the two for every tier, with and without AML;
  - a template that ever states a different figure fails its test.

  Changing it mints new annual prices: after the code is published, an admin
  presses *Create Stripe prices & apply* on the seat plan price list card.
  It also changes the voice agents' knowledge base, which
  `scripts/voice/upload-knowledge-base.py` uploads.

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

## Builder Partner Agreements — before the Builder Portal

A builder signs the **Builder Partner Agreement** before the Builder Portal
opens to them. It is the same document engine as the other two kinds: one
`client_agreements` row (`document_kind = 'builder_partner'`), the same
DocuSign account, lifecycle, refresh cron, Connect webhook and
`agreement-records` bucket. Three things differ:

- **who it is with** — an organisation on the Builders Network, not a lead;
- **what a signature does** — it admits the builder to the Builder Portal on
  the network, and it never provisions a clone;
- **where its words come from** — a terms file an admin registers. The terms
  are supplied separately and plugged in; nothing in this repository writes a
  clause.

### Where it sits in the builder pipeline

```
website waitlist → /api/public/builders/apply → network submit_access_request
  → organisation (pending) + owner invitation                   [unchanged]
  → Builder Partner Agreement: drafted, sent, signed, retained  [new]
  → approve_organisation → Builder Portal access                [waits for the signature]
```

The waitlist pipeline is not touched. `src/routes/api.public.builders.apply.ts`,
`src/server/builderApplyGuard.pure.ts` and the network's `submit_access_request`
are unchanged, and nothing in them knows an agreement exists. That pipeline
already stops short of access on purpose: `approve_organisation` is the only
route from pending to `active`, and it has always been an admin's act on
`/builders-network`. The agreement is added at that act, which is the one point
where the pipeline already hands over to a person.

`src/server/builderPartnerAccessGate.contract.test.ts` holds this in the
source, in both directions:

- the call sites of `approve_organisation` are derived, not listed, and there
  are exactly two: the console's Approve and the grant from a signed agreement.
  A third way to approve an organisation fails the test the day it is added;
- the console reads the gate before it calls the network, refuses when the gate
  refuses, and refuses when the gate cannot be read;
- the grant claims the row, conditional on the agreement being signed, before
  it calls the network;
- reinstating a suspended organisation does not call the approval;
- only the application route submits an application, and neither it nor its
  guard imports or names anything agreement-shaped;
- the agreement machinery's only write to the network is the approval.

### The terms are plugged in

The terms live on `/agreements/builder-partner-terms` (from `/agreements` →
*Builder Partner terms*). An admin registers the file there with:

- a name and a version label;
- whether Aurixa countersigns;
- the **execution statement**, the sentence the Execution Schedule prints
  above the signatures (20–1,200 characters; a default that fits any terms is
  offered).

The file is read before anything is stored (`builderPartnerTermsFile.pure.ts`).
Nothing reads a clause; the checks are that DocuSign will carry the file and
that a builder can be bound to exactly it:

- It is a PDF or a Word (`.docx`) document **by its own bytes**, up to 15 MB. A
  name that claims the other type is refused, and so is a legacy `.doc`.
- A PDF must open, must not be encrypted, and must have pages. DocuSign refuses
  a protected PDF, and terms that failed at the send would stop every agreement.
- A Word document is refused if it carries macros or other active content, if
  it still has tracked changes in its body, headers, footers or notes, or if it
  is a master document whose sections live in other files. The fingerprint
  would not cover those sections.
- A Word document is also refused if a clause that **quotes another part of
  it** through a cross-reference (a `REF` field) no longer says what that part
  says (`staleCrossReferences`). A field prints the result Word stored the last
  time fields were updated, and the copy DocuSign shows a signer prints that
  stored result rather than recomputing it. So a fee edited on one page and not
  updated in the clause quoting it would be signed as two different figures —
  and the one in the clause is the one that binds. The refusal names the
  bookmark, what the clause shows and what the quoted text now reads, and says
  to press F9 in Word. A reference whose bookmark has gone (the marked text was
  retyped over) is refused the same way. BD1 v1.2 is the case this was written
  for: clauses 14.3 and 14.4 quote the New Build Fee and the Development Sale
  Fee from "Your transaction-fee arrangement" through the bookmarks
  `BD1_Fee_NewBuild_ExGST`, `BD1_Fee_NewBuild_IncGST`, `BD1_Fee_DevSale_ExGST`
  and `BD1_Fee_DevSale_IncGST`, so the fee page is where a fee is changed and
  the clauses follow it on F9.
- Comments, a linked (rather than embedded) picture or template, and a
  document with no text in it each raise a warning and stop nothing.

A registered file is stored in the private `agreement-templates` bucket at
`builder-partner/<sha256>.<ext>`: the path is its identity. It is checked
against that digest every time it is sent or served.

Terms move `staged → active → retired`.

- **Registering stages them.** Nothing is sent under staged terms, and a staged
  registration can be edited or deleted.
- **Putting them in force** retires the terms that were in force. Only one set
  is ever in force (a unique index, moved under an advisory lock by
  `activate_builder_partner_agreement_template`). Mission Control refuses to put
  terms in force while no agreement could be sent under them: DocuSign not
  configured, or a countersignature required and no countersigner configured.
  Terms in force make approval wait for a signature, and a signature nobody can
  collect is an outage, not a control.
- **Retiring** the terms in force asks why, in at least ten characters,
  because with none in force approval stops waiting for a signature.
- **Once in force, the terms are a record.** Their name, version,
  countersignature and execution statement are printed on schedules that were
  sent, so the database refuses to change them; only the notes can be edited.
  A correction is a new registration of the same file. Terms that have been in
  force are never deleted, and a retired set never returns to force.

### The Execution Schedule

The envelope carries two documents: the registered terms first, and the
**Execution Schedule** second (`builderPartnerSchedule.pure.ts`). Mission
Control writes the schedule, and it is the document DocuSign acts on. It
states:

- the agreement reference (`AUR-BPA-YYYYMMDD-XXXXXX`) and the issuing date;
- the parties — Aurixa Systems Pty Ltd and the Builder Partner's particulars;
- the terms, identified by name, version, file name, size, page count and
  SHA-256 fingerprint;
- the execution statement, and the signature blocks.

Signing the schedule is what enters the agreement, and the fingerprint ties
the signature to exactly the bytes that were sent. That is why any terms file
works the day it is supplied, with no anchors to author and no fields to map.

Four properties are guaranteed, and tested against the real PDF
(`builderPartnerSchedule.test.ts` reads the text back out of the page streams):

- **Deterministic.** The same input produces the same bytes, so the digest the
  snapshot records can be proved by regenerating the page.
- **Every anchor exactly once, and only those the envelope uses.** Anchors are
  painted in the colour of their panel, and the envelope's tabs are STRICT. An
  anchor that did not print refuses the envelope, rather than sending one with
  nowhere to sign. The send also checks the painted anchors against the ones
  it expects before anything leaves.
- **A preview cannot be signed.** It paints no anchors, and it is marked as a
  preview (masthead, watermark, footer) without moving the layout, so what a
  reviewer approves is what the builder receives.
- **The statement is never parted from the signatures.** They move to the next
  page together when they do not fit.

The builder's block asks for a title at signing only when the particulars do
not state one. Aurixa's block is a countersignature when the terms require one;
otherwise it says the agreement is entered when the builder signs and Aurixa
receives a copy.

### The flow

1. **Draft it from `/builders-network`.** Each organisation there shows its
   agreement standing, and *Send agreement* drafts one or opens the one in
   flight. There is at most one open agreement per organisation, enforced by a
   unique index. The draft is seeded from what the network already holds:
   - from the organisation: its legal and trading names, ABN and contact email;
   - from the website application: the contact's name and phone, and the
     locality.

   A street address, an ACN and the signatory's title are never guessed. An
   organisation that is closed, unknown, or cannot be confirmed because the
   network did not answer is not drafted for.
2. **Complete the particulars** at `/agreements/<id>`. The page lists what
   blocks a send and what is only worth a look, and the send refuses on the
   same list (`particularsGaps`).
   - Blockers: the legal name, the signatory's name and email, and any ABN,
     ACN or notice email that fails its check.
   - Warnings: no ABN, no address, no signatory title (DocuSign then asks the
     signer for it), and an ABN that does not contain the ACN. That last one is
     expected for a trust with a corporate trustee.
3. **Check the documents.** *Terms* downloads the terms in force. *Preview
   schedule* downloads the schedule the builder would receive, marked as a
   preview.
4. **Decide about access.** "Admit the builder automatically once signed" arms
   the agreement, so that a signature is enough; see below. Only an admin can
   arm an agreement, and only while it is open.
5. **Send it.** *Send for signature* is the Subscription Agreement's claimed
   send:
   - **claim** — on `issued_at`, so a double click produces one envelope;
   - **check** — the terms in force and the particulars again, and the network
     once more: an organisation it has since closed or removed is refused, while
     an unreachable network does not stop the send, because the approval it
     leads to asks again;
   - **snapshot** — `issued_snapshot` is written before the envelope exists. It
     holds the particulars, the terms' identity and digest, the generated
     schedule itself and its digest, who was sent what, and whether the
     agreement was armed;
   - **envelope** — the builder's signatory signs first. When the terms
     require it, `DOCUSIGN_COUNTERSIGNER_*` countersigns second; otherwise that
     address receives a copy. The hidden custom fields are `mc_agreement_id`,
     `mc_offer_reference` and `mc_builder_organisation_id`.

   An interrupted send is held for ten minutes, after which *Send* asks
   DocuSign whether the earlier attempt created the envelope before it sends
   anything.
6. **Signed.** The combined signed PDF, with DocuSign's certificate of
   completion, is copied into `agreement-records` at
   `builder-partner/<agreement id>/<envelope id>-signed.pdf`, and its SHA-256
   is recorded. Access follows, as below.

A draft can be deleted and a sent agreement voided. A **signed** one cannot be
voided: it is the record the builder was admitted on, and access is withdrawn
by suspending the organisation on the Builders Network, not by unmaking the
record.

### Access: the gate at approval

Approve on `/builders-network` asks the server, at that moment, whether the
organisation may be admitted (`assessBuilderAccessGate`,
`decideBuilderAccessGate`):

1. **A signed agreement** satisfies the gate, whatever terms it was signed on.
2. **With no terms in force the gate is not enforced.** Approval behaves
   exactly as it did before this feature existed. This is also the state until
   the terms arrive.
3. **An admin may waive it, in words.** The dialog Approve opens offers to draft
   the agreement (recommended) or to approve without one. The latter requires a
   reason of at least ten characters.
4. **Otherwise it refuses.** The refusal names the agreement in flight, with a
   link, or asks for one to be drafted.

A gate that cannot be read refuses: "Nothing was approved." A failed read is
not a missing agreement, and approving on a guess is what the gate exists to
stop.

The basis goes with every approval. It is sent to the network as the approval's
`reason`, where the network's activity log records it: the signed agreement's
reference, the waiver's words, or that no terms were in force. Mission Control's
audit log records it as `builders_network.organisation_approved`. So an
approval can be explained from the record alone.

Reinstating a suspended organisation is not gated. It restores an organisation
that was admitted, agreement and all, before it was suspended.

### Access: granted from a signature

- **Armed.** Once the signed copy is retained, `grantBuilderPortalAccess`
  approves the organisation on the network without waiting for anyone. The
  admin decided in advance, when arming, that a signature is enough.
- **Not armed.** An admin presses *Grant Builder Portal access* on the
  agreement, or approves from the console, where the signed agreement now
  satisfies the gate.

Evidence comes before action. The automatic path needs the agreement armed,
signed and its signed copy retained; the manual path needs only the signature,
because pressing the button is the decision. Either way the attempt is
**claimed on the row** (`portal_access_status = 'pending'`, conditional on the
agreement being signed), so a signature, the sweep and the button cannot
approve twice.

The network's answer is recorded on the row:

- `granted` — the builder is admitted. The organisation's metering account
  (tenant `builders-network:<organisation id>`) is ensured, the same one the
  console's Approve ensures.
- `refused` — the network said no about this organisation: it is closed, gone,
  or not awaiting approval (for example, suspended). This needs a person and is
  **never retried automatically**.
- `failed` — the cause is ours or transient: the console switched off, the
  signing key missing, the network unreachable. The sweep retries it.

A grant is always announced. A failure is announced once, never again on every
sweep that retries it, and a failure an admin just caused by pressing the
button is shown to them rather than broadcast.

### The Portal subscription: a payment link on signing

The agreement carries two kinds of fee, and only one of them is charged here.
The **monthly Builder / Developer Portal subscription** starts when the
agreement is signed and is paid through a Stripe **Payment Link**. The
**Transaction Fees** — the New Build Fee and the Development Sale Fee on "Your
transaction-fee arrangement" — are separate from it: each is earned only on its
qualifying event and invoiced after it, which no link opened at signing can
know. The email, the Stripe page and the confirmation all say so.

The Stripe objects were created once, in live mode, in the account Mission
Control's own key and webhook belong to, and are pinned in
`builderPortalPayment.pure.ts`:

| | |
|---|---|
| Product | `prod_VLz85NtQ6m8lgb` — Builder / Developer Portal |
| Price | `price_1ULHAu3tNhf9apmH3iSluzRZ` — A$699.00 a month, GST inclusive (A$63.55 GST), automatic tax |
| Payment Link | `plink_1ULHBH3tNhf9apmHbuT6AyZY` — `https://buy.stripe.com/00w00c5Ee22G1dZd8w0co1o` |

The price is the catalog's own figure for the `builder-developer-portal`
module (`aurixa-catalog.ts`), and a test holds the two equal. A price change is
a new Stripe price and link, and the pinned ids, together. A negotiated
monthly fee that differs from the catalog is not something this link can
charge: send that builder a Stripe invoice instead, and do not send the link.

**When it goes.** Once the signed agreement is **retained**
(`completeSignedBuilderPartnerAgreement`, after the access grant), Mission
Control emails the signatory their own copy of the link from the Graph mailbox
the agreements already send from. The copy carries `client_reference_id =
bpa_<agreement id>` and the signatory's address prefilled, so the webhook
knows whose payment it was without guessing. `decidePaymentLinkDispatch`
decides every send, automatic or manual:

- nothing goes before the signature and the retained copy, to a missing or
  invalid address, or to a builder who already has a live subscription;
- a send is **claimed on the row** (`portal_payment_link_status = 'sending'`,
  conditional on the status it read), so the signature, the sweep and the
  button cannot send twice;
- Graph's answer is recorded: `sent`; `failed` when Microsoft refused it or
  asked us to wait (retried by the sweep, at most five sends); or
  `unconfirmed` when Graph took the message without confirming it. An
  **unconfirmed send is never repeated automatically** — a retry would mail a
  builder the same demand for money twice. A `sending` claim older than
  fifteen minutes belonged to an invocation that died, and becomes
  `unconfirmed` for the same reason;
- `held` is an agreement signed before this was built. The migration holds
  those rather than letting the first sweep after deploy email every builder
  who already signed.

The agreement page has a **Portal subscription** section: the link's standing,
the subscription's Stripe status, *Send payment link* (an admin's act, which
confirms first and may send again after a sent, held, failed or unconfirmed
link) and *Copy the builder's link*. Every send is in the audit log as
`agreement.portal_payment_link_sent` or `agreement.portal_payment_link_not_sent`.

**When it is paid.** The Stripe webhook routes the link's sessions and
subscriptions to the agreement **before** anything else sees them — they carry
none of the `mode` / `item_id` metadata self-serve checkout relies on, and
`fulfillCheckout` would refuse them — and never into `clone_seat_entitlements`:

- `checkout.session.completed` and `async_payment_succeeded` record the
  subscription on the agreement with Stripe's **live** status, read at that
  moment, because the session's and the subscription's own events arrive in no
  fixed order. A session with no reference is matched by the signatory's email
  only when exactly one signed agreement without a subscription has it, and the
  notification says it was matched that way; anything else is left to a
  person, never guessed;
- a second subscription for an agreement that already has one is never
  written over the first: it is reported, for a refund or a cancellation;
- `customer.subscription.*` keeps the agreement's copy of Stripe's status in
  step, and tells operators when it becomes past due, unpaid, cancelled or
  expired. **Portal access is not changed automatically** by a payment or a
  lapse — access follows the signature, and withdrawing it is still
  suspending the organisation;
- `async_payment_failed` tells operators the payment did not clear.

### The sweep

The agreements refresh (`/hooks/agreements-refresh`) runs
`sweepBuilderPartnerAgreements` on every run. It never throws, and it:

- retains up to 25 signed records not yet copied out of DocuSign (only while
  DocuSign is configured);
- grants the armed access a signature could not;
- retries grants that failed, and takes over a pending attempt older than ten
  minutes;
- creates any metering account a grant left missing. It reads the `tenants`
  table itself for this, not a flag that could be wrong;
- sends the Portal payment link a signature could not (up to ten a run),
  retries a failed send that has sends left, and turns a `sending` claim older
  than fifteen minutes into `unconfirmed`.

### Rules that carry it

- **Only an admin admits a builder.** Every server function that drafts,
  saves, sends, arms, grants, voids or deletes a Builder Partner Agreement
  checks for an admin, including the send, void and delete it shares with the
  other kinds. `client_agreements` is writable by any operator session under
  its RLS policy, so a trigger (`client_agreements_builder_partner_admin_only`)
  refuses a Builder Partner write from any signed-in session that is not an
  admin's. The terms registry and its bucket have no browser write path at all.
- **A builder is admitted, never provisioned.** A check constraint refuses
  arming a Builder Partner Agreement for provisioning.
  `decideProvisionOnSignature` refuses it as `builder_partner_never_provisions`,
  and the provisioning panel refuses the kind.
- **An issued agreement is a record.** Once an envelope exists, the freeze
  trigger refuses any change to the particulars, reference, snapshot, terms or
  organisation. The keep trigger refuses deleting a sent or signed one, and a
  retained signed record is written once.
- **The terms are a file.** They are identified by digest and verified every
  time they are sent or served, and an agreement records the terms it was
  issued under (`template_id`, which cannot be deleted from under it).
- **Absent schema is not a failure; a failed read is.** Until the migration is
  applied, the registry reads as not installed and the gate as not enforced,
  because a registry that does not exist holds no terms. Any other failed read
  fails closed.

### Rolling it out

1. Merge. `.github/workflows/apply-migrations.yml` hands
   `supabase/migrations/20260928110000_builder_partner_agreements.sql` to the
   migration queue. Confirm that run is green before the code is published. The
   migration is additive, and with no terms registered the console approves
   exactly as it did before.
2. When the terms arrive, an admin registers the file on
   `/agreements/builder-partner-terms`, reads any warnings, and puts it in force.
   From that moment Approve waits for a signed agreement or a written waiver.
3. Before the first real builder, send one agreement to an internal address and
   read both documents as DocuSign shows them. On the production account an
   envelope is billable.
4. The Portal payment link needs
   `supabase/migrations/20260930100000_builder_portal_payment_link.sql` applied.
   Until it is, the page says the columns are not installed, nothing is sent,
   and a Portal payment arriving at the webhook is left unprocessed so Stripe
   retries it. The link is live: test it with a real card and refund, or send
   it only to a real builder.

### The pieces, for a Builder Partner Agreement

- `src/lib/agreements/`:
  - `builderPartner.pure.ts` — particulars, reference, terms checks, the
    envelope, the snapshot, the access gate and the grant rules;
  - `builderPartnerSchedule.pure.ts` — the Execution Schedule;
  - `builderPartnerTermsFile.pure.ts` — reading an uploaded terms file;
  - `builderPortalPayment.pure.ts` — the pinned Stripe objects, the builder's
    own link, whether to send it, and the email.
- `src/lib/buildersNetworkTenant.pure.ts` — the one spelling of an
  organisation's metering tenant.
- `src/server/builder-partner-agreements.server.ts` — the registry, drafting,
  the send and its recovery, retention, the grant, the gate and the sweep.
- `src/server/builder-portal-payment.server.ts` — sending the payment link,
  and recording the subscription Stripe reports (called from
  `src/routes/api.public.stripe.webhook.ts`).
- `src/lib/builderPartnerAgreements.functions.ts` — the server functions, with
  the send, refresh, download, void and delete in `agreements.functions.ts`.
- `src/server/builders-network.functions.ts` — `approveNetworkOrganisation`,
  gated.
- `src/routes/agreements.builder-partner-terms.tsx` — the terms page.
- `src/components/agreements/builder-partner-agreement.tsx` — the agreement
  page.
- `src/components/builders-network-agreements.tsx` and
  `src/lib/use-send-builder-agreement.ts` — the console's standing line, the
  drafting action and the approval dialog.
- `supabase/migrations/20260928110000_builder_partner_agreements.sql`:
  - `builder_partner_agreement_templates` and its freeze trigger;
  - `activate_builder_partner_agreement_template`;
  - the `client_agreements` columns (`builder_organisation_id`, `template_id`,
    `grant_access_on_signature`, `portal_access_*`) and their checks;
  - the one-open-agreement index;
  - the widened freeze and keep triggers, and the admin-only trigger;
  - the private `agreement-templates` bucket.
- `supabase/migrations/20260930100000_builder_portal_payment_link.sql` — the
  `portal_payment_link_*` and `portal_subscription_*` columns, their checks,
  the one-agreement-per-subscription index, and the `held` backfill.

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
  The Builder Partner functions are in `builderPartnerAgreements.functions.ts`
  ([The pieces, for a Builder Partner Agreement](#the-pieces-for-a-builder-partner-agreement)).
- `src/routes/agreements.index.tsx` — the list: metrics, config and
  issuing-profile banners, filters, one lifecycle row per agreement of
  any kind, the new-SLA dialog with CRM contact picker (shows journey
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
   It does the same for Builder Partner Agreements, where what a retained,
   armed signature releases is Builder Portal access — see
   [The sweep](#the-sweep).
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
  no plan, no attributable creator — and, for a Builder Partner Agreement,
  always (`builder_partner_never_provisions`): a builder is admitted to the
  Builder Portal, never given a clone.
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
