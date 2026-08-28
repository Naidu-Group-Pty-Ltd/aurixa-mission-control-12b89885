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
