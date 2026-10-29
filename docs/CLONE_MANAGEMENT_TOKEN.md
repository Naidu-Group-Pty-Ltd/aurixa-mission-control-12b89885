# A clone can never hold a Supabase management token

_Refused by CLASS in code; removed by EFFECT on a sweep. Not by a data row,
not by a ledger entry, and not by anybody remembering._

Read this before touching `primeOnlySecrets.pure.ts`, `classifySecret`,
`CLASS_REFUSAL` or `cloneProhibitedSecrets.server.ts`.

## What happened

On 12 Sep 2026 the clone `npc-client-dashboard` held a value under
`SB_MANAGEMENT_ACCESS_TOKEN`. It was dead — the Management API answers
`JWT could not be decoded` when the bearer is neither a PAT nor a JWT — but
its **presence** was enough. The prime's `resolveIntegrationSecretRoute`
picks its route on `if (token && projectRef)`, so every save on that
deployment's Integrations page took the direct path, dead-ended on a 401, and
told the operator to *"rotate it at supabase.com/dashboard/account/tokens"* —
advice no tenant can act on, for a credential no tenant should hold.

The remedy was a person opening one project's Secrets page. Once per clone,
for ever.

## Four things were wrong, and each was sufficient

1. **The name was not classified.** `classifySecret` knew nothing of
   `SB_MANAGEMENT_ACCESS_TOKEN`, so it fell through every set to `vendor` —
   the class that TRAVELS. `SUPABASE_ACCESS_TOKEN` escaped only by accident,
   caught by the `SUPABASE_` prefix meant for auto-injected values. One name
   was safe by coincidence; the other was not safe at all.

2. **The only real defence was a data row.** `prime_secret_forwards` carried
   `SB_MGMT_API_TOKEN` and `SB_ORG_ID` at `inherit = false` with the prose
   "Prime-only Supabase management token — do not forward". Those are Mission
   Control's OWN environment names. The name the prime's edge function
   actually reads was in no row at all — and a row is deletable from a page.

3. **The ledger recorded intent, never fact.** `clone_backend_secrets` read
   `status: missing`, `last_set_at: null` for that name on all three clones
   while the project held a value. Mission Control never wrote it, so Mission
   Control could not see it, and `decideCloneWithhold` can only withdraw what
   the ledger says was forwarded.

4. **Nothing swept.** Every reconcile lane asked "does this clone hold what
   belongs to it?" and none asked the inverse.

## What a management token actually grants

A Supabase personal access token is scoped to an **account**, not a project.
It reaches every project in every organisation that account belongs to, with
full administrative rights — on this fleet, the prime, Mission Control's own
backend and every other tenant. Supabase publishes no way to mint a narrowed
one. That is the same reasoning that made `DIDIT_API_KEY` and `AIRTABLE_TOKEN`
brokered: **the credential stops here and the CALL travels.**

## The implementation

**`primeOnlySecrets.pure.ts`** is the policy and the only place these names
are written down. Exact names for what exists today, two patterns for the
name nobody has written yet. It defers to the clone's own platform values
FIRST — `SUPABASE_SERVICE_ROLE_KEY` and friends are the clone's own project's,
and a rule that could name one would take every workspace off the air on its
first pass. That ordering is load-bearing, and a test pins it.

**`classifySecret` returns `prime_only`**, checked ahead of everything
including the `SUPABASE_` prefix. **`CLASS_REFUSAL`** gains the class, which
closes the per-clone AND fleet forward paths at once — that map is deliberately
the single authority, so the two paths cannot hold different ideas of what may
never travel.

**`cloneProhibitedSecrets.server.ts`** is the sweep, run first by
`/hooks/clone-secrets-reconcile` (twice an hour) and never allowed to fail it.

## Four rules the sweep keeps

**A failed read is never a clean project.** `listProjectSecretNames` answers
`[]` on an API failure — right for the parity report that owns it, and
catastrophic here, where it would read as "holds nothing prohibited" for a
project nobody managed to look at. `readHeldSecretNames` carries the failure,
and an unreadable clone reports `unreadable`, never `clean`.

**Deletion is bounded by the policy, never by a pattern run over the live
list.** The names removed are exactly `prohibitedHoldings(held)` — the
intersection of what the project holds with a list this platform wrote. A
sweep that computed its own targets from the project's own names is one regex
away from deleting a service-role key.

**It is asserted by effect.** After deleting, the names are read back, and the
outcome reports what the SECOND read saw. A delete the API accepted and did
not perform is `still_present`, not `removed`.

**It can never reach the prime.** The ref comes from
`resolveCloneSecretTarget`, which refuses the prime's project, refuses Mission
Control's own, and refuses when it cannot tell. The prime is *supposed* to
hold a management token; a sweep that could reach it would disable the control
plane.

## Why the ledger stamp says `withheld`

After a removal the sweep upserts `clone_backend_secrets` to `withheld`.
That word rather than a new one for three reasons: it is already in
`clone_backend_secrets_status_check` (a ninth value needs a migration, on the
lane this same engagement found unable to apply one — so the code would assume
a state the database silently rejects); `cloneSecretForward` already refuses
on `ledgerStatus === "withheld"`, so the stamp hardens the forward path rather
than only recording history; and it is true — the name is deliberately not on
this clone.

The stamp can never undo the removal: the credential is gone before it runs,
and a failure is logged rather than thrown.

## Mission Control's own control-plane secrets (29 Oct 2026)

The class has a second member list, `CONTROL_PLANE_SECRETS`, for credentials
that are not Supabase tokens and are refused for the same reason: whoever
holds one acts on every tenant at once, and no narrower copy can be minted for
a clone. Each carries its own reason, which is what an operator reads on a
refused forward (`refusalFor`) and on a refused Integrations save.

- **`GITHUB_WEBHOOK_SECRET`** — Mission Control's GitHub webhook signing
  secret. `/hooks/github` trusts anything signed with it as GitHub's own, and
  those requests start cascade work. Nothing a clone runs reads it.
- **`VAPI_API_KEY`** — Aurixa's organisation-wide Vapi key, which reaches every
  tenant's assistants, numbers, calls and recordings and the prime's. Each
  clone's own Vapi organisation is held by Mission Control
  (`cloneVapiCustody.pure.ts`), and the owner's rule is that a tenant never
  gets into it.

Both were fleet rows marked `inherit` and sat `inherited` on all five clones
(key audit S1 and S2). Since this change they are refused by class on both
forward paths and by the Integrations broker, provisioning records them
`withheld` instead of inheriting them — its fleet values are read from every
row marked `inherit` without asking the class, so a `prime_only` name there
used to rest on its data row alone — and this sweep removes them from every
clone. `20261029230000` sets their fleet rows to `inherit = false` so the
forwarding page says the same. The GitHub secret still has to be rotated at
GitHub and in Mission Control's environment: removing a copy does not un-leak
it.

## What is deliberately not covered

Ordinary vendor keys, including one a tenant sets to supersede a forwarded
fleet key. Superseding is the product, and a sweep that took those away would
be protecting the wrong side. The Didit webhook secret is the fleet's one
Didit application and stays forwarded until the owner decides how Didit's
callbacks are routed (decision D3).
