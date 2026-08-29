# Per-clone email identity (dedicated Resend keys)

## Why the inherited model had to go

Every clone this platform provisions boots with the prime's vendor keys
forwarded into its Supabase project (`prime_secret_forwards`). For
`RESEND_API_KEY` that meant every clone's outbound mail — password-reset OTPs,
portal invites, appointment notifications, weekly reports; **22 edge functions**
on the prime read that one name — rode on a single shared credential.

That model failed in production on 2026-08-28: the prime's Resend key was
rotated, and the first clone's password-recovery flow answered
`Failed to send OTP email`. The function logs showed the real error —
`401 API key is invalid` — but nothing on the clone or in Mission Control could
say *why*, because the clone had no email identity of its own to reason about.
The blast radius was also wrong in the other direction: a key leaked from any
clone could send as **everyone**.

## The dedicated model

Each clone gets, from Mission Control:

1. **Its own sending domain**, registered at Resend under the platform's
   master account — `send.<clone-host>` by default (a subdomain, per Resend's
   guidance, so the flow never touches the root domain's existing mail
   posture). A tenant domain can be supplied instead.
2. **The DNS records Resend requires** (SPF TXT, DKIM TXT, MX). When the clone
   has a Cloudflare zone Mission Control manages (`clones.cloudflare_zone_id`),
   the records are **written automatically**; otherwise the operator gets them
   rendered with copy buttons, and the flow waits.
3. **A domain-scoped, sending-only API key** (`sending_access` +
   `domain_id`), minted only after the domain verifies and written straight
   onto the clone's Supabase project as `RESEND_API_KEY` — through
   `resolveCloneSecretTarget`, like every other clone-project secret write.

A leaked clone key can now send only as that clone; rotation and revocation are
per-clone buttons; and the prime rotating its own key affects nobody.

## Where things live

| Piece | Path |
|---|---|
| State table | `clone_email_identities` (migration `20260828060000`) — one row per clone, unique `clone_id` |
| Resend client (master key) | `src/server/resend-client.ts` |
| Pure rules + readiness path | `src/server/cloneEmailIdentity.pure.ts` (tests beside it) |
| Orchestration | `src/server/email-identity.server.ts` |
| Server functions (admin-only) | `src/lib/email-identity.functions.ts` |
| Operator UI | `CloneEmailIdentityCard`, mounted on `/clones/$cloneId/secrets` |

## Rules that carry it

- **The key token is never stored.** Resend returns it exactly once; it is
  written to the clone in the same flow that minted it, and only the key's
  Resend id and last four characters are kept. A mint whose delivery fails
  **deletes the minted key** — an undelivered token is an orphan credential,
  not a retry opportunity.
- **A key is minted only for a verified domain.** Resend would mint one
  earlier; every send would then 403. `canMintKey` converts that runtime
  surprise into a named precondition.
- **Rotation writes before it revokes.** New key → written to the clone →
  only then is the old key deleted. A half-run rotation leaves mail working on
  the old key, never stopped on a missing one.
- **Dormant without `RESEND_MASTER_API_KEY`.** Every entry point answers a
  named refusal; the UI shows the master-key step as the one open step. Add
  the key to Mission Control's environment (Settings → Secrets) and the same
  buttons work with no code change. Clones never receive this key — only
  sending-only, domain-scoped children of it.
- **Dedicated names never re-inherit.** Provisioning takes
  `dedicatedSecretNames`; a clone with an email identity records
  `RESEND_API_KEY` as `missing` on a re-provision (the token cannot be read
  back) instead of silently swapping back to the prime's shared key. The
  identity panel's *Rotate key* is the re-mint.
- **Never ask Resend to verify a record that is not there yet.** Its verifier
  resolves through a caching resolver, and a MISS is cached for the zone's SOA
  negative TTL — 1800s on `aurixasystems.com.au`. Measured on the first clone:
  the domain was registered at 11:15 and its records installed at 12:32, while
  the drain asked for verification every five minutes throughout, so roughly
  seventeen lookups returned NXDOMAIN and the last of them held "this does not
  exist" until half an hour after the records were already correct and
  resolving publicly. The delay was entirely self-inflicted, and it is the kind
  that reads as a vendor being slow. The poll is now gated on the records
  actually resolving (one DoH lookup per distinct name — `expectedDnsProbes`),
  and "not visible yet" is reported rather than being indistinguishable from
  "Resend says no". Values are not compared: Resend is the authority on its own
  DKIM key, and re-implementing TXT chunk joining here is a way to be subtly
  wrong. The probe fails OPEN — an unreachable resolver reports present — since
  a wasted verify call costs nothing and a false "missing" would stop us asking
  at all.
- **Resend's record names are relative; every consumer here wanted FQDNs.**
  For `send.npc.aurixasystems.com.au` the API answers `send.send.npc` and
  `resend._domainkey.send.npc` — the registrable domain cut off.
  `planDnsInstallation` asks whether a name ends with the zone, which is false
  for all of them, so the first live provisioning run registered the domain
  correctly and then handed all three records to an operator anyway, for a
  domain sitting squarely inside a zone this platform manages. The zone fix
  below was right and was defeated one line later. `absoluteRecordName`
  restores the root from the SENDING DOMAIN rather than a public suffix list
  (`.com.au` is multi-label, and guessing where a name ends is how a record
  gets written in the wrong place): the relative name's trailing labels
  overlap the sending domain's leading labels, so the missing labels are the
  remainder and nothing is inferred the two names do not already agree on.
  Longest overlap wins — a single `send` label also matches, and appending
  from there yields a real record in the wrong place. A name that resolves to
  nothing is left alone and stays the operator's, because a name that cannot
  be placed confidently is not one to write on a guess. Applied where records
  are STORED, so the planner, the Cloudflare writer and the table an operator
  copies from all read the same names instead of each re-deriving them.
- **The DNS zone is resolved from where DNS actually lives.** This gate used
  to be `clone.cloudflare_enabled ? clone.cloudflare_zone_id : null`, which
  asks the wrong question: those two columns are set by ATTACHING AN EDGE
  PROVIDER (the WAF/CDN wrapper in `cloudflare_clone_config`), a table that is
  empty across the fleet — the same thing the Edge card means by "No edge
  provider attached". Every clone subdomain meanwhile lives in the fleet zone
  recorded in `platform_hosting_config`, which Mission Control writes to
  routinely. So `send.<clone-fqdn>` — whose SPF, DKIM and MX records all fall
  inside that fleet zone — was handed to an operator to install by hand, into
  a zone this platform had written to minutes earlier. `resolveEmailDnsZone`
  now takes the clone's own zone when one is genuinely attached (a tenant that
  brought its own domain) and the fleet zone otherwise. **Resolving a zone is
  candidacy, never licence**: `planDnsInstallation` still decides record by
  record whether a name falls inside it, which is exactly what makes the
  fallback safe — a tenant-owned sending domain resolves to the fleet zone and
  then installs nothing.
- **Handing the records over is an outcome; a transient failure is not.** The
  step used to settle only on `via === "cloudflare" || !zoneId`, so a zone that
  existed but could not carry every record left `dns_installed_via` null — the
  path reported DNS as the open step forever and every advance re-ran the whole
  attempt. It now settles when the outcome is DETERMINED (no zone at all, or
  records that fall outside the resolved one — Resend's required records for a
  domain do not move, so retrying cannot change either) and deliberately stays
  open when it is not (Cloudflare unreachable, or a partial write). Settling on
  a transient error would permanently downgrade a clone to manual DNS because
  Cloudflare happened to be down for one click.
- **Provisioning starts it, and the panel is where operators look.** The
  identity panel lived only on `/clones/$cloneId/secrets`, a route nothing in
  the product linked to — grep for it found its own definition and nothing
  else — so it was reachable only by typing a URL. It now sits on the clone's
  page beside the Turnstile panel, because both are per-clone credentials
  Mission Control mints; the secrets page carries a pointer in the same style
  as the one `TURNSTILE_SECRET_KEY` already had, and the clone page finally
  links to it. And the deployment drain STARTS an identity during
  `syncing_env`, beside the widget mint: `subdomain_fqdn` is reserved at
  enrolment so the sending domain is derivable by then, the records go in
  while the build runs, and the drain mints the key once Resend verifies.
  Both are best-effort — a clone that cannot get one still reaches production
  and says so on its own panel. `cloneCredentialArming.contract.test.ts`
  asserts the call stays there, because deleting it fails silently: clones
  would deploy perfectly and simply never be able to send.
- **The drain advances; it never starts.** Every other provisioning pipeline
  here has a scheduled drain and this one did not, so an identity waiting on
  DNS propagation sat still until a person reopened the page and pressed
  *Advance* — which is how a clone ends up registered, with its records
  installed and its domain verified, and still holding no key, one click short
  of the outage being over. `email-identity-drain` (every 5 minutes) carries
  started identities forward. It acts only on a row that already has a
  `resend_domain_id`, because registering a sending domain chooses a hostname
  and a region and creates a resource at Resend — an operator's decision, not
  a sweep's. That refusal is also what makes it safe for the drain to use the
  same `provision` mode the button uses: `advanceEmailIdentity` creates a
  domain only when `resend_domain_id` is null, and `refresh` deliberately
  mints nothing, so a drain restricted to `refresh` would poll verification
  forever and never close the gap. A failed identity is left alone for thirty
  minutes; a healthy one mid-propagation is not, because the window is for
  failures and applying it to everything would stall every normal run.
- **Sender alignment repairs a default, never a choice.** The clone's
  from-headers all derive from `global_report_settings.contact_details.email`
  (see the prime's `_shared/brand-config.ts`); while that still carries the
  prime's legacy address, the dedicated key answers
  `403 from address not authorized`. *Align sender address* fills in
  `notifications@<sending-domain>` — but only over an empty value or one on
  the prime's legacy domain. A tenant's own configured domain is never
  overwritten.

## Ledger fix carried in the same change

`clone_backend_secrets.status` is CHECK-constrained to
`missing | set | failed | inherited`, but provisioning wrote the planner's own
vocabulary (`generated`, `skipped_platform`, …) straight into it. One such row
invalidated the entire upsert, the error was discarded, and **every clone's
secret ledger stayed empty** while the secrets page read "no secrets".
`ledgerStatusForShell` now maps planner words onto ledger words (`generated`/
`derived` → `set`; the `skipped_*` kinds store no row), and the upsert's error
is checked and logged.

## Operating it

1. Open a clone → **Secrets** → the *Email identity* card.
2. **Provision** — registers the domain, installs or hands over DNS, polls
   verification, and (once verified) mints + writes the key. Safe to click
   repeatedly; it advances whatever is ready and stops where it must wait.
3. **Re-check** — polls Resend after DNS changes. Verification typically lands
   within minutes of the records resolving.
4. When live: **Align sender address**, then prove the loop end-to-end with a
   password-reset OTP request on the clone.
5. **Rotate key** after any re-provision of the clone's backend, or on
   suspicion of exposure. **Revoke** kills sending for the clone at Resend.

## Deliberate limits

- No true per-tenant Resend *accounts*: Resend has no API for creating
  isolated accounts, so isolation is per-domain scoped keys under the
  platform's account — which is also what keeps billing consolidated and
  revocation instant.
- The flow never edits a tenant's own DNS. Records for domains outside a
  Mission-Control-managed Cloudflare zone are always handed to the operator.
- `advanceEmailIdentity` never deletes anything; teardown is an explicit
  revoke.
