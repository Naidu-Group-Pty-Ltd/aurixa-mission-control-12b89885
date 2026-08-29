# A clone's own CAPTCHA — per-tenant Turnstile identity

Every clone gets its **own** Cloudflare Turnstile widget. It never renders the
prime's, and provisioning cannot hand it the prime's.

Modules: `src/server/cloneTurnstileIdentity.pure.ts` (the rules),
`src/server/turnstile-identity.server.ts` (the orchestration),
`src/lib/turnstile-identity.functions.ts` (the server functions),
`src/components/clone-turnstile-card.tsx` (the panel), and the
`clone_turnstile_identities` table
(`supabase/migrations/20260829030000_clone_turnstile_identities.sql`).

---

## Why not share the prime's widget

A Turnstile widget **is** a (site key, secret) pair. The site key is public and
is rendered by the browser; the secret is a Supabase function secret that
`siteverify` checks the resulting token against.

Three things follow, and the first is the one that matters.

**A token is bound to the pair, not to the site.** `siteverify` does return the
hostname a challenge was solved on, and no login handler in the prime repo — or
in any clone, since they are mirrors of it — reads that field. Give two tenants
the same pair and a token farmed from either login page (the prime's is public)
satisfies the CAPTCHA on the other. The control stops being per-deployment.

**One secret is one rotation.** Rotating a shared widget invalidates every
tenant's tokens at once. This deployment has already lived that failure with
`RESEND_API_KEY`, which is why `clone_email_identities` exists; this is the same
shape with a security control on the end of it.

**One widget is one domain allow-list.** Sharing forces every customer hostname
onto the prime's widget, so the prime's Cloudflare configuration becomes a list
of who the fleet's tenants are.

So `TURNSTILE_SECRET_KEY` is classified `tenant_scoped` in
`prime-backend.server.ts` — a class that exists for exactly this. A
`tenant_scoped` secret is recorded `missing` on a clone **whatever
`prime_secret_forwards` says**: adding a forwarding row must not be able to
re-share it, which is why this is a classification and not a default.

---

## What provisioning does

The widget is minted in the deployment drain's **`syncing_env`** step, and the
step is not interchangeable with any other. Vite inlines `VITE_*` at **build**
time, so a site key that arrives after `deploying` is a site key the bundle does
not have. `syncing_env` runs before `deploying`; nothing later does.

One pass does all of it, because Cloudflare returns the secret **once**:

1. `createTurnstileWidget` (or adopt this clone's existing one and re-sync its
   domain list) — `deriveWidgetName`, `deriveWidgetDomains`.
2. `deliverSecret` — writes `TURNSTILE_SECRET_KEY` **and**
   `REQUIRE_TURNSTILE=true` onto the clone's Supabase project, through
   `resolveCloneSecretTarget` so a mistyped ref cannot reach the prime.
3. `publishSiteKey` — writes `VITE_TURNSTILE_SITE_KEY` to the clone's hosting
   project; the drain also passes it through `buildCloneEnv`'s `extra`, so it is
   covered by `env_digest` and a changed key re-syncs on its own.
4. Store `site_key`, `domains`, `secret_last4`, `secret_written_at` — never the
   secret.

**Minting must never stop a deployment.** A clone that cannot get a widget
should reach production saying its security check is unconfigured, not fail to
deploy. The refusal is recorded on the identity row and rendered in the clone's
Turnstile panel, so it is visible rather than swallowed.

Without `CLOUDFLARE_API_TOKEN` the whole feature is dormant and says so.

---

## Rules that bite

**The secret exists in memory for one flow.** Cloudflare returns it on create
and on `rotate_secret` and never on a read. It is delivered in the same call
that obtained it. Only the last four characters are stored, which is enough to
tell two secrets apart and not enough to be one.

**A widget this code created and could not deliver is deleted.** An orphan
widget nobody holds the secret for is litter, not a retry. A widget that was
merely *adopted* is never deleted on failure — it may be the one currently
working.

**Fail closed, once it can.** The write that installs the secret sets
`REQUIRE_TURNSTILE=true` beside it. Until then a *missing* `TURNSTILE_SECRET_KEY`
makes the login handler skip the CAPTCHA entirely — the `if (turnstileSecret)`
branch in `_shared/customAuth/login.ts` — so an unprovisioned clone silently has
no CAPTCHA rather than visibly refusing. Fail-closed is only safe to turn on in
the same act that supplies the secret, which is why it is one write.

**A site key published after the build needs a redeploy.** `publishSiteKey`
returns "takes effect on the clone's next deployment" and the panel repeats it.
Provisioning from the drain does not have this problem because it happens before
`deploying`; provisioning from the panel on an already-live clone does.

**Rotation invalidates immediately** (`invalidate_immediately: true`), so the
new secret is delivered in the same flow or the clone is left unable to verify.
`canRotateSecret` refuses when there is nothing to rotate.

---

## The other half: the browser

A per-clone widget is inert while the site key is a literal in the bundle, and
it was: `src/components/auth/TurnstileWidget.tsx` in the prime repo carried
`0x4AAAAAAChQyb0ZxBORhxWq`, and `npc-client-dashboard` inherited it verbatim
when the repo was mirrored. Both repos now resolve it through
`src/lib/turnstileSiteKey.ts`:

- **The prime** keeps a built-in key — it is its own — but uses it **only while
  the build is talking to the Supabase project that key's secret lives in.** A
  fork pointed at its own project resolves to no key at all and says so. That is
  the same pairing rule `integrations/supabase/env.ts` already applies to the
  Supabase URL and its anon key, and it is what makes a built-in safe to
  inherit.
- **A clone** has no built-in at all. Unset, the login page says the security
  check is not configured and names `VITE_TURNSTILE_SITE_KEY`, rather than
  borrowing somebody else's widget. `turnstileIdentity.spec.ts` in each repo
  asserts no site key literal comes back.

An unconfigured clone therefore cannot be signed into. That is not a regression
on what it replaces: a browser holding the prime's site key against a clone's
own secret is refused by `siteverify` with `invalid-input-secret`, and the
sign-in never reaches the password check — which is exactly the fault that was
reported as "the admin password doesn't work".
