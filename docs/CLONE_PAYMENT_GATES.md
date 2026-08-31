# The activation gate

A clone provisioned onto a **paid plan** boots with a clock on it. It works
normally until the window closes — 72 hours by default — and is then locked
behind a payment screen until Stripe captures the activation payment, at which
point it opens by itself.

**The prime and every clone that already exists are not gated, and cannot
become gated.** Everything below is arranged to protect that.

Operator surface: **Billing → Payment Gates** (`/billing/gates`), plus a card
on each clone's own page.

---

## The three-sentence version

1. `provisionClone` writes one `clone_payment_gates` row for a paid clone.
   Nothing else ever writes one.
2. The status is **derived on every read** from four stored facts — the
   operator's override, whether Stripe paid, when the window closes, and the
   time — by `src/lib/clonePaymentGate.pure.ts` and nowhere else.
3. The clone asks `GET /api/public/clones/gate` and renders the answer. The
   enforcement that protects revenue is `tokens/reserve` and `seats/reserve`
   answering **402** to a locked clone.

---

## Why the status is not stored

The obvious design is a `status` column a worker flips at the deadline. It is
rejected, on this repository's own evidence.

[`THE_CLONING_ENGINE.md`](./THE_CLONING_ENGINE.md) records six pg_cron jobs
that were **never scheduled at all** — silently, for months, with every check
green. Each had a migration that read an empty vault, raised a NOTICE nobody
reads, and returned; each was recorded as applied; and a job that does not
exist has no failing run to report.

A gate whose *closing* depends on a worker fails **open** under exactly that
fault, and nothing anywhere says so. So nothing closes a gate. There is no
worker in this feature at all, and the table has no `status` column to store
one in — pinned by `paymentGate.contract.test.ts`, because a column somebody
adds later is how a design quietly reverts.

## The resolution order

`resolveGateState` reads four facts and returns one of seven reasons. In order:

| # | Condition | Result | Why it is where it is |
| - | --------- | ------ | --------------------- |
| 0 | no row | `open` / `not_gated` | The prime, and every pre-existing clone |
| 1 | `manual_override = 'unlocked'` | `open` / `operator_unlocked` | How a customer whose payment is stuck keeps working — outranks the clock **and** non-payment |
| 2 | `manual_override = 'locked'` | `locked` / `operator_locked` | How a workspace is suspended **after** it has paid |
| 3 | `paid_at` set | `open` / `paid` | The automatic unlock. One stamp, so no second write can fail after Stripe has been paid |
| 4 | `locks_at` null | `open` / `no_deadline` | Gated, unpaid, deliberately not on a clock |
| 5 | now < `locks_at` | `open` / `within_grace` | Counting down |
| 6 | otherwise | `locked` / `grace_expired` | The window closed with no payment |

`manual_override` is **one column** holding `'locked' | 'unlocked' | null`. Two
booleans could both be true, and then an unwritten resolution order decides
whether a paying customer can work. One column with a CHECK makes the
contradiction unrepresentable rather than merely unlikely.

## Why nothing is backfilled

A row IS the gate.

- `armGate` has exactly two callers — `provisionClone`, and an explicit
  operator button for a paid clone that was somehow missed. A test enumerates
  them by filename.
- No migration inserts into the table or derives rows from `clones`, asserted
  by a test. A backfill added later would lock the whole fleet on deploy, with
  nobody watching.
- `gateEligibility` refuses to arm on an **unresolved** price. Gating a
  workspace that may owe nothing is an outage for somebody who did nothing
  wrong; leaving one ungated is a row the console lists as a **gap** for an
  operator to arm by hand. The visible failure is the safer one, and the
  console's "paid plan, no gate" filter is how it stays visible.
- Turning the master switch off stops *arming*. It does not unlock existing
  gates, and the panel says which one it is.

## What Stripe does

`checkout.session.completed` settles the gate at **one** place in the webhook —
after `isPaidSession` and after the purchase is finalised, which is exactly
where the platform has already concluded the money landed. Two call sites (one
per fulfilment branch) is how one of them comes to settle on a payment status
the other rejects.

Two more routes exist because money can arrive without a session:

- **`customer.subscription.created/updated` going active** — a subscription
  created in Stripe's own dashboard never sees a checkout session, and its
  clone would otherwise stay locked with money in the bank.
- **`invoice.paid`** — a renewal invoice Stripe mints on its own cycle carries
  no session, and for a subscription created outside our Checkout may carry no
  clone metadata either. `cloneIdForStripe` therefore also resolves through the
  subscription id, via the gate row and then `clone_seat_entitlements`.

`settleGatePayment` is idempotent (`paid_at IS NULL` in the filter, so a lost
race updates nothing) and merges Stripe references on a gate that is already
paid, so a gate settled from a session gains its subscription id later.

**A credit top-up does not activate a workspace.** `GATE_OPENING_MODES` is
`seat_plan` and `setup_package`. A $50 pack must not open a $2,015/month plan,
and the CTA a customer sees leads to their plan, not to credits.

**A refund records and warns but never re-locks.** `charge.refunded` fires for
a partial refund too, so auto-locking would take a live workspace down over a
goodwill credit. `noteGateRefund` writes a `payment_reversed` event and an
operator notification that says the workspace is still open; the manual lock is
the deliberate act it leaves to a person.

## The CTA charges what it quoted, and refuses if it cannot prove that

`POST /api/public/clones/gate/checkout` resolves the plan, the price and the
tenant from the gate row Mission Control already wrote, so the button charges
exactly what the clone was armed for and the browser is never told a price it
could edit. It refuses on a gate that is already paid — a CTA is the one place
that is easy to click twice.

Finding the plan row is not `WHERE slug = plan_slug`, and that is the subtle
part. The catalogue reuses `seat_plans` rows through the tier rename —
`professional` becomes Growth, `growth` becomes Scale — so a row called
`growth` exists on both sides of the cutover and is a **different tier in
each**: Scale at $2,015 before, Growth at $860 after. A naive slug match shows
a Growth customer "$860" and sends them to a Stripe session for $2,015.

`seatPlanForTier.pure.ts` states the settling rule once, the same way
`stripe-catalog-sync.server.ts` reasons for the rename path, and is tested
against the pre-cutover catalogue, the post-cutover one, and a half-done
cutover where the naive match hands one row to two tiers.

The **price assertion** beside it is the actual guarantee rather than a second
opinion: the settling rule is inference about a cutover this request cannot
observe, so a row whose `price_cents` disagrees with what the gate quoted is
refused outright, and the buyer goes to the pricing page — where a person
chooses and sees the number before paying it. Refusing to charge is always
available; un-charging is not.

## Where the gate is enforced

| Layer | What it refuses | Fails how |
| ----- | --------------- | --------- |
| `POST /api/public/tokens/reserve` | **402 `workspace_locked`** | Open, on a DB read error only |
| `POST /api/public/seats/reserve` | **402 `workspace_locked`** | Open, on a DB read error only |
| The clone's dashboard shell | Renders the payment screen | Open, always |

`tokens/reserve` is the one that matters. A clone provisioned by Mission
Control runs on the **prime's forwarded vendor keys** (see
[`prime-repo-api-usage-metering.md`](./prime-repo-api-usage-metering.md)), so
an unpaid workspace generating reports spends Aurixa's own OpenAI and
property-data budget — and a browser lock screen does not stop a scripted
caller.

`commit`, `cancel` and `release` stay **open** on a locked workspace: it must
still be able to finish work it already reserved and unwind an in-flight
signup, or those rows are stranded with nobody able to clear them. A test pins
that too.

`assertGateOpen` fails **open** on a read error. A database blip must not stop
a paying customer working, and the gate exists to collect an activation payment
inside a window rather than to defend against an attacker who cannot cause
database errors anyway.

## What an operator can do

Every act demands a reason of at least five characters, enforced in the dialog
**and** on the server, and every act appends to `clone_payment_gate_events`
with the derived status either side of it.

- **Platform default window** and the arming switch (`prime_config`).
- **Per-clone window**, measured from `armed_at` rather than from now — so
  extending "72 hours" on a clone made yesterday means three days from
  creation, which is what the customer was told. Restarting the clock from now
  is a separate, explicit switch, because it is a larger act.
- **Lock / unlock / clear the override.** Clear is offered only when there is
  an override to clear; a button that undoes a decision nobody made reads as a
  third state.
- **Record a payment that arrived outside Stripe.** It writes the same
  `paid_at` stamp, so the unlock is the same act rather than a second kind of
  open, and it is attributed to `operator` so the ledger never claims Stripe
  captured money it did not.

Mutations are `requireAdmin`; reads are `requireOperator`, so support can see
why a workspace is locked without being able to change it.

## Two things the console shows that are absences

- **"paid plan, no gate"** — a clone that should have been armed and was not.
  Invisible from the clone itself, and this is the only place it can be seen.
- **"never checked by the clone"** — a gate no deployment has ever read. A gate
  that is never asked about is indistinguishable from one that is working, and
  this platform has shipped that particular silence before.

## The one part of the migration nothing verifies

`20260831000000_clone_payment_gates.sql` carries three `-- @asserts` claims —
both tables and `prime_config.clone_gate_default_hours` — and
`/hooks/migration-drift` resolves them against the live schema every hour.

It also adds four `notification_kind` enum values, and **an `enum` claim is
unassertable on this deployment**: `pg_type` is outside the schemas PostgREST
exposes, so the drift checker reports it rather than answering it
(`migration-drift.server.ts`). Nothing checks that those four values are really
there.

That matters because it is a failure this platform has already had.
`20260820120000_notification_kinds_never_declared.sql` records three kinds that
were being inserted and had never been added to the enum: Postgres refused every
write, the discarded error meant nobody found out, and the notification that a
client had handed over their Supabase PAT had never once arrived.

The exposure here is bounded and the symptom is specific. Arming, locking,
payment settlement and the derived status do not touch the enum, so the gate
works either way; what is lost is the four operator notifications. Because these
go through `notifyOperators`, a refused write is LOGGED rather than silent —
which is the difference that one cost us. **So if a gate arms and no
notification arrives, check the enum values before anything else**:

```sql
SELECT enumlabel FROM pg_enum
 WHERE enumtypid = 'public.notification_kind'::regtype
   AND enumlabel LIKE 'clone_gate_%';   -- expect 4 rows
```

## Files

| File | What it is |
| ---- | ---------- |
| `supabase/migrations/20260831000000_clone_payment_gates.sql` | The tables, the defaults, and why there is no `status` column |
| `src/lib/clonePaymentGate.pure.ts` | The state machine. The only thing that decides open or locked |
| `src/server/payment-gate.server.ts` | Arm, override, window, settle, and `assertGateOpen` |
| `src/server/payment-gate.functions.ts` | The operator RPCs |
| `src/routes/api.public.clones.gate.ts` | What a clone asks about itself |
| `src/routes/api.public.clones.gate.checkout.ts` | The CTA's destination |
| `src/routes/billing.gates.tsx` | The console |
| `src/components/clone-payment-gate-card.tsx` | The same state on the clone's own page |
| `src/server/paymentGate.contract.test.ts` | The absences: no backfill, one status rule, 402 where it belongs |
