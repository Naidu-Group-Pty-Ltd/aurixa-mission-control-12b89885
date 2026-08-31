/**
 * The activation gate — Mission Control's side.
 *
 * One clone, one gate row, and the row's presence IS the gate: no row means no
 * gate, which is the answer for the prime and for every clone that existed
 * before this shipped. Nothing in this module backfills, and `armGate` is
 * reached from exactly one place — `provisionClone` — so a gate can only ever
 * come into existence at the moment a paid clone is created.
 *
 * The gate's STATUS is not stored. `clonePaymentGate.pure.ts` derives it from
 * the row on every read; see that module's header for why a worker must not be
 * what closes a gate.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson, asRow } from "@/lib/json-cast";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { TIERS } from "@/lib/pricing/aurixa-catalog";
import {
  computeLocksAt,
  GATE_DEFAULT_HOURS,
  gateEligibility,
  normaliseGraceHours,
  resolveGateState,
  type GateOverride,
  type GateState,
} from "@/lib/clonePaymentGate.pure";

export type GateRow = Tables<"clone_payment_gates">;
export type GateEventKind = Tables<"clone_payment_gate_events">["kind"];

export type GateView = {
  gate: GateRow | null;
  state: GateState;
};

/** Facts the resolver reads, projected off a row. One place, so no caller can
 *  hand the resolver a different shape of the same row. */
export function factsOf(row: GateRow | null) {
  if (!row) return null;
  return {
    manualOverride: (row.manual_override as GateOverride | null) ?? null,
    paidAt: row.paid_at,
    locksAt: row.locks_at,
  };
}

export function viewOf(row: GateRow | null, now: Date = new Date()): GateView {
  return { gate: row, state: resolveGateState(factsOf(row), now) };
}

// ── Plan pricing ────────────────────────────────────────────────────────────

/**
 * What this clone's plan costs, and what it is called.
 *
 * Two sources, in this order, because they answer differently and only one of
 * them is what the tier picker wrote: `clones.entitled_plan_slug` comes from
 * `TIERS` in the Aurixa catalogue, while `seat_plans` is the Stripe-facing
 * catalogue whose slugs were remapped once already (Professional → Growth,
 * Growth → Scale). Falling through to `seat_plans` covers a plan the catalogue
 * does not name; returning nulls covers one neither does.
 *
 * A null price is NOT a zero price — `gateEligibility` refuses to arm on an
 * unresolved price rather than gating a workspace whose bill nobody could
 * find.
 */
export async function resolvePlanPricing(planSlug: string | null | undefined): Promise<{
  planSlug: string | null;
  planName: string | null;
  amountDueCents: number | null;
  currency: string;
}> {
  const slug = (planSlug ?? "").trim().toLowerCase();
  if (!slug) return { planSlug: null, planName: null, amountDueCents: null, currency: "AUD" };

  const tier = TIERS.find((t) => t.slug === slug);
  if (tier) {
    return {
      planSlug: slug,
      planName: tier.name,
      amountDueCents: tier.monthlyInclGstCents,
      currency: "AUD",
    };
  }

  const { data, error } = await supabaseAdmin
    .from("seat_plans")
    .select("slug, name, price_cents, currency")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    console.error("[gate] seat_plans lookup failed", { slug, error: error.message });
    return { planSlug: slug, planName: null, amountDueCents: null, currency: "AUD" };
  }
  if (!data) return { planSlug: slug, planName: null, amountDueCents: null, currency: "AUD" };
  return {
    planSlug: slug,
    planName: data.name ?? null,
    amountDueCents: typeof data.price_cents === "number" ? data.price_cents : null,
    currency: (data.currency ?? "AUD").toUpperCase(),
  };
}

/** The platform default window. Falls back to the module constant when
 *  `prime_config` cannot be read — never to "no deadline", which would arm a
 *  gate that nothing ever closes. */
export async function defaultGateSettings(): Promise<{ hours: number; enabled: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("prime_config")
    .select("clone_gate_default_hours, clone_gate_enabled")
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[gate] prime_config read failed", error.message);
    return { hours: GATE_DEFAULT_HOURS, enabled: true };
  }
  return {
    hours: data?.clone_gate_default_hours ?? GATE_DEFAULT_HOURS,
    enabled: data?.clone_gate_enabled ?? true,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * `failed` is carried separately from `row` for the reason
 * `docs/aml/CASE_TENANT_COLUMN.md` records in the prime repo: a read that
 * FAILED is not a row that is ABSENT, and treating the two the same is how a
 * database fault comes to read as "this clone has no gate" — which, here,
 * would unlock it.
 */
export type GateRead =
  | { ok: true; row: GateRow | null }
  | { ok: false; failed: true; error: string };

export async function readGate(cloneId: string): Promise<GateRead> {
  const { data, error } = await supabaseAdmin
    .from("clone_payment_gates")
    .select("*")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) return { ok: false, failed: true, error: error.message };
  return { ok: true, row: (data as GateRow | null) ?? null };
}

// ── The event log ───────────────────────────────────────────────────────────

export async function logGateEvent(input: {
  gateId: string;
  cloneId: string;
  kind: GateEventKind;
  statusBefore?: string | null;
  statusAfter?: string | null;
  reason?: string | null;
  actor?: "operator" | "stripe" | "system";
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("clone_payment_gate_events").insert(
    asRow<TablesInsert<"clone_payment_gate_events">>({
      gate_id: input.gateId,
      clone_id: input.cloneId,
      kind: input.kind,
      status_before: input.statusBefore ?? null,
      status_after: input.statusAfter ?? null,
      reason: input.reason ?? null,
      actor: input.actor ?? "operator",
      actor_id: input.actorId ?? null,
      metadata: asJson(input.metadata ?? {}),
    }),
  );
  if (error) {
    console.error(`[gate] event "${input.kind}" not recorded for ${input.cloneId}:`, error.message);
  }
}

// ── Arming ──────────────────────────────────────────────────────────────────

export type ArmResult =
  | { armed: true; gate: GateRow }
  | {
      armed: false;
      reason: "already_armed" | "disabled" | "not_eligible" | "write_failed";
      detail?: string;
    };

/**
 * Arm a new clone's gate. Called once, from `provisionClone`.
 *
 * Three independent things each stop it, and each is checked here rather than
 * at the call site so no future caller can skip one:
 *   • the platform switch is off,
 *   • the clone is not on a paid plan (`gateEligibility`), or
 *   • a gate already exists (the UNIQUE on `clone_id` makes this idempotent —
 *     a retried provisioning attempt must not restart somebody's clock).
 *
 * Never throws. A clone that fails to arm is a clone with no gate, which is
 * the pre-existing behaviour of every clone on the fleet; failing the
 * provisioning of a repo that has already been forked would be worse.
 */
export async function armGate(input: {
  cloneId: string;
  cloneName?: string | null;
  planSlug: string | null | undefined;
  /** Operator-chosen window for this clone. Undefined = platform default;
   *  null = deliberately no deadline. */
  graceHours?: number | null;
  actorId?: string | null;
}): Promise<ArmResult> {
  try {
    const defaults = await defaultGateSettings();
    if (!defaults.enabled) return { armed: false, reason: "disabled" };

    const pricing = await resolvePlanPricing(input.planSlug);
    const eligible = gateEligibility({
      planSlug: pricing.planSlug,
      amountDueCents: pricing.amountDueCents,
    });
    if (!eligible.eligible)
      return { armed: false, reason: "not_eligible", detail: eligible.reason };

    // Never trust the window this was handed. It travels from a text field in
    // the New Clone wizard, and `Number("soon")` is NaN — which used to reach
    // `computeLocksAt`, throw, and leave a paid clone silently ungated with
    // only a console line to say so. An unusable value falls back to the
    // platform default rather than to "no deadline", because the default is
    // what an operator who typed something meant.
    let hours: number | null;
    if (input.graceHours === undefined) {
      hours = defaults.hours;
    } else {
      const normalised = normaliseGraceHours(input.graceHours);
      if (normalised.ok) {
        hours = normalised.hours;
      } else {
        console.error("[gate] unusable window on arm — using the platform default", {
          cloneId: input.cloneId,
          given: input.graceHours,
          error: normalised.error,
        });
        hours = defaults.hours;
      }
    }
    const armedAt = new Date();
    const locksAt = computeLocksAt(armedAt, hours);

    const { data, error } = await supabaseAdmin
      .from("clone_payment_gates")
      .insert(
        asRow<TablesInsert<"clone_payment_gates">>({
          clone_id: input.cloneId,
          plan_slug: eligible.planSlug,
          plan_name: pricing.planName,
          amount_due_cents: eligible.amountDueCents,
          currency: pricing.currency,
          grace_hours: hours,
          armed_at: armedAt.toISOString(),
          locks_at: locksAt,
        }),
      )
      .select("*")
      .single();

    if (error) {
      // 23505 = the UNIQUE on clone_id. A retried provisioning attempt.
      if (error.code === "23505") return { armed: false, reason: "already_armed" };
      console.error("[gate] arm failed", { cloneId: input.cloneId, error: error.message });
      return { armed: false, reason: "write_failed", detail: error.message };
    }

    const row = data as GateRow;
    await logGateEvent({
      gateId: row.id,
      cloneId: input.cloneId,
      kind: "armed",
      statusAfter: resolveGateState(factsOf(row), armedAt).status,
      reason: `Armed on ${eligible.planSlug} for ${hours === null ? "no deadline" : `${hours}h`}`,
      actor: "system",
      actorId: input.actorId ?? null,
      metadata: {
        plan_slug: eligible.planSlug,
        amount_due_cents: eligible.amountDueCents,
        grace_hours: hours,
        locks_at: locksAt,
      },
    });

    await writeAuditLog({
      action: "clone_gate.armed",
      entityType: "clone_payment_gate",
      entityId: input.cloneId,
      actorUserId: input.actorId ?? null,
      metadata: { plan_slug: eligible.planSlug, grace_hours: hours, locks_at: locksAt },
    });

    await notifyOperators({
      kind: "clone_gate_armed",
      severity: "info",
      title: `Activation gate armed: ${input.cloneName ?? input.cloneId.slice(0, 8)}`,
      body:
        hours === null
          ? `On ${eligible.planSlug} with no deadline — it will not lock on its own.`
          : `On ${eligible.planSlug}. Locks in ${hours}h unless the activation payment lands.`,
      cloneId: input.cloneId,
      url: "/billing/gates",
      metadata: { plan_slug: eligible.planSlug, grace_hours: hours, locks_at: locksAt },
    });

    return { armed: true, gate: row };
  } catch (err) {
    console.error("[gate] arm threw", err);
    return { armed: false, reason: "write_failed", detail: (err as Error).message };
  }
}

// ── Operator acts ───────────────────────────────────────────────────────────

type MutateResult = { ok: true; gate: GateRow; state: GateState } | { ok: false; error: string };

async function applyPatch(
  cloneId: string,
  patch: TablesUpdate<"clone_payment_gates">,
): Promise<{ before: GateRow; after: GateRow } | { error: string }> {
  const before = await readGate(cloneId);
  if (!before.ok) return { error: before.error };
  if (!before.row) return { error: "no_gate" };
  const { data, error } = await supabaseAdmin
    .from("clone_payment_gates")
    .update(asRow<TablesUpdate<"clone_payment_gates">>(patch))
    .eq("clone_id", cloneId)
    .select("*")
    .single();
  if (error) return { error: error.message };
  return { before: before.row, after: data as GateRow };
}

/**
 * Set — or clear — the operator's standing decision.
 *
 * `override: null` hands the gate back to the clock and the payment. Locking
 * and unlocking both demand a reason: a gate is the difference between a
 * customer working and not, and "who decided this, and why" is the whole point
 * of the event log.
 */
export async function setGateOverride(input: {
  cloneId: string;
  override: GateOverride | null;
  reason: string;
  actorId: string;
  cloneName?: string | null;
}): Promise<MutateResult> {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, error: "reason_required" };

  const now = new Date();
  const applied = await applyPatch(input.cloneId, {
    manual_override: input.override,
    manual_override_reason: input.override ? reason : null,
    manual_override_by: input.override ? input.actorId : null,
    manual_override_at: input.override ? now.toISOString() : null,
  });
  if ("error" in applied) return { ok: false, error: applied.error };

  const before = resolveGateState(factsOf(applied.before), now);
  const after = resolveGateState(factsOf(applied.after), now);
  const kind: GateEventKind =
    input.override === "locked"
      ? "locked"
      : input.override === "unlocked"
        ? "unlocked"
        : "override_cleared";

  await logGateEvent({
    gateId: applied.after.id,
    cloneId: input.cloneId,
    kind,
    statusBefore: before.status,
    statusAfter: after.status,
    reason,
    actor: "operator",
    actorId: input.actorId,
    metadata: { override: input.override },
  });
  await writeAuditLog({
    action: `clone_gate.${kind}`,
    entityType: "clone_payment_gate",
    entityId: input.cloneId,
    actorUserId: input.actorId,
    metadata: { override: input.override, reason, status_after: after.status },
  });

  // Only announce a CHANGE of status. Clearing an override on a gate that was
  // going to be open anyway is bookkeeping, not news.
  if (before.status !== after.status) {
    await notifyOperators({
      kind: after.status === "locked" ? "clone_gate_locked" : "clone_gate_unlocked",
      severity: after.status === "locked" ? "warning" : "success",
      title: `Activation gate ${after.status === "locked" ? "locked" : "unlocked"}: ${input.cloneName ?? input.cloneId.slice(0, 8)}`,
      body: reason,
      cloneId: input.cloneId,
      url: "/billing/gates",
      metadata: { override: input.override, reason },
    });
  }

  return { ok: true, gate: applied.after, state: after };
}

/**
 * Change the window.
 *
 * `graceHours` is measured from `armed_at`, not from now — an operator
 * extending "72 hours" on a clone armed yesterday means three days from
 * creation, which is what the customer was told. Re-arming the clock from now
 * would be a different, larger act, so it is a separate flag.
 */
export async function setGateWindow(input: {
  cloneId: string;
  graceHours: number | null;
  /** Restart the clock from this moment rather than from `armed_at`. */
  restartClock?: boolean;
  reason: string;
  actorId: string;
  cloneName?: string | null;
}): Promise<MutateResult> {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, error: "reason_required" };

  const current = await readGate(input.cloneId);
  if (!current.ok) return { ok: false, error: current.error };
  if (!current.row) return { ok: false, error: "no_gate" };

  const now = new Date();
  const anchor = input.restartClock ? now : new Date(current.row.armed_at);
  const locksAt = computeLocksAt(anchor, input.graceHours);

  const applied = await applyPatch(input.cloneId, {
    grace_hours: input.graceHours,
    locks_at: locksAt,
    ...(input.restartClock ? { armed_at: now.toISOString() } : {}),
  });
  if ("error" in applied) return { ok: false, error: applied.error };

  const before = resolveGateState(factsOf(applied.before), now);
  const after = resolveGateState(factsOf(applied.after), now);

  await logGateEvent({
    gateId: applied.after.id,
    cloneId: input.cloneId,
    kind: "extended",
    statusBefore: before.status,
    statusAfter: after.status,
    reason,
    actor: "operator",
    actorId: input.actorId,
    metadata: {
      grace_hours: input.graceHours,
      locks_at: locksAt,
      restarted_clock: input.restartClock === true,
      previous_locks_at: applied.before.locks_at,
    },
  });
  await writeAuditLog({
    action: "clone_gate.window_changed",
    entityType: "clone_payment_gate",
    entityId: input.cloneId,
    actorUserId: input.actorId,
    metadata: { grace_hours: input.graceHours, locks_at: locksAt, reason },
  });

  if (before.status !== after.status) {
    await notifyOperators({
      kind: after.status === "locked" ? "clone_gate_locked" : "clone_gate_unlocked",
      severity: after.status === "locked" ? "warning" : "info",
      title: `Activation window changed: ${input.cloneName ?? input.cloneId.slice(0, 8)}`,
      body: reason,
      cloneId: input.cloneId,
      url: "/billing/gates",
      metadata: { grace_hours: input.graceHours, locks_at: locksAt },
    });
  }

  return { ok: true, gate: applied.after, state: after };
}

// ── Payment ─────────────────────────────────────────────────────────────────

export type SettleInput = {
  cloneId: string;
  source: "stripe_checkout" | "stripe_subscription" | "stripe_invoice" | "operator";
  amountPaidCents?: number | null;
  currency?: string | null;
  checkoutSessionId?: string | null;
  paymentIntentId?: string | null;
  subscriptionId?: string | null;
  customerId?: string | null;
  actorId?: string | null;
  reason?: string | null;
};

/**
 * Record that Stripe captured this clone's activation payment — which IS the
 * unlock, because the state is derived from `paid_at`.
 *
 * Idempotent by construction: the `paid_at IS NULL` filter means a redelivered
 * webhook, or a second event family reporting the same money (session →
 * subscription → invoice all carry `clone_id`), updates nothing and reports
 * `already_paid`. The Stripe references are still merged on, so a gate settled
 * from a session gains its subscription id when the subscription event arrives.
 *
 * Never throws, and never fails its caller: the webhook has already taken the
 * customer's money, and 5xx-ing it would have Stripe retry a delivery whose
 * only outstanding work is a stamp this function will make on the next attempt.
 */
export async function settleGatePayment(
  input: SettleInput,
): Promise<
  | { ok: true; settled: boolean; reason?: "already_paid" | "no_gate"; gate?: GateRow }
  | { ok: false; error: string }
> {
  try {
    const read = await readGate(input.cloneId);
    if (!read.ok) return { ok: false, error: read.error };
    if (!read.row) return { ok: true, settled: false, reason: "no_gate" };

    const refs: TablesUpdate<"clone_payment_gates"> = {
      ...(input.checkoutSessionId ? { stripe_checkout_session_id: input.checkoutSessionId } : {}),
      ...(input.paymentIntentId ? { stripe_payment_intent_id: input.paymentIntentId } : {}),
      ...(input.subscriptionId ? { stripe_subscription_id: input.subscriptionId } : {}),
      ...(input.customerId ? { stripe_customer_id: input.customerId } : {}),
    };

    if (read.row.paid_at) {
      if (Object.keys(refs).length > 0) {
        const { error } = await supabaseAdmin
          .from("clone_payment_gates")
          .update(asRow<TablesUpdate<"clone_payment_gates">>(refs))
          .eq("clone_id", input.cloneId);
        if (error) console.error("[gate] ref merge failed", error.message);
      }
      return { ok: true, settled: false, reason: "already_paid", gate: read.row };
    }

    const now = new Date();
    const before = resolveGateState(factsOf(read.row), now);

    const { data, error } = await supabaseAdmin
      .from("clone_payment_gates")
      .update(
        asRow<TablesUpdate<"clone_payment_gates">>({
          ...refs,
          paid_at: now.toISOString(),
          payment_source: input.source,
          amount_paid_cents: input.amountPaidCents ?? null,
          ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
        }),
      )
      .eq("clone_id", input.cloneId)
      // Lost-race guard: two Stripe events settling the same gate at once.
      .is("paid_at", null)
      .select("*")
      .maybeSingle();

    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: true, settled: false, reason: "already_paid" };

    const row = data as GateRow;
    const after = resolveGateState(factsOf(row), now);

    await logGateEvent({
      gateId: row.id,
      cloneId: input.cloneId,
      kind: "payment_settled",
      statusBefore: before.status,
      statusAfter: after.status,
      reason: input.reason ?? `Activation payment captured via ${input.source}`,
      actor: input.source === "operator" ? "operator" : "stripe",
      actorId: input.actorId ?? null,
      metadata: {
        source: input.source,
        amount_paid_cents: input.amountPaidCents ?? null,
        checkout_session_id: input.checkoutSessionId ?? null,
        subscription_id: input.subscriptionId ?? null,
        payment_intent_id: input.paymentIntentId ?? null,
      },
    });
    await writeAuditLog({
      action: "clone_gate.payment_settled",
      entityType: "clone_payment_gate",
      entityId: input.cloneId,
      actorUserId: input.actorId ?? null,
      metadata: { source: input.source, amount_paid_cents: input.amountPaidCents ?? null },
    });

    // Worth announcing even though it is the happy path: it is the moment a
    // customer stopped being blocked, and an operator fielding "am I live yet"
    // needs to see it without opening a table.
    await notifyOperators({
      kind: "clone_gate_unlocked",
      severity: "success",
      title: "Activation payment captured — gate unlocked",
      body: `${row.plan_name ?? row.plan_slug ?? "Plan"} activated via ${input.source.replace("stripe_", "Stripe ")}.`,
      cloneId: input.cloneId,
      url: "/billing/gates",
      metadata: { source: input.source, amount_paid_cents: input.amountPaidCents ?? null },
    });

    return { ok: true, settled: true, gate: row };
  } catch (err) {
    console.error("[gate] settle threw", err);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Resolve a clone id from what a Stripe event actually carries.
 *
 * `clone_id` is on the shared metadata that `startCheckoutCore` stamps onto the
 * session, the subscription and the invoice — but an invoice minted by Stripe
 * on a later renewal cycle carries only the subscription, so the subscription
 * id is the second route.
 */
export async function cloneIdForStripe(input: {
  metadataCloneId?: string | null;
  subscriptionId?: string | null;
}): Promise<string | null> {
  const fromMeta = (input.metadataCloneId ?? "").trim();
  if (fromMeta) return fromMeta;
  if (!input.subscriptionId) return null;

  const byGate = await supabaseAdmin
    .from("clone_payment_gates")
    .select("clone_id")
    .eq("stripe_subscription_id", input.subscriptionId)
    .maybeSingle();
  if (byGate.data?.clone_id) return byGate.data.clone_id;

  const byEntitlement = await supabaseAdmin
    .from("clone_seat_entitlements")
    .select("clone_id")
    .eq("stripe_subscription_id", input.subscriptionId)
    .maybeSingle();
  return byEntitlement.data?.clone_id ?? null;
}

// ── Observability ───────────────────────────────────────────────────────────

/**
 * Stamp that the clone asked. Best-effort and deliberately unawaited by its
 * caller: a gate whose deployment has never once read it is otherwise
 * indistinguishable from one that is working, and that is exactly the class of
 * silence this platform has shipped before.
 */
export async function recordGateCheck(cloneId: string, locked: boolean): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("clone_payment_gates")
    .select("check_count, first_locked_seen_at")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error || !data) return;
  const patch: TablesUpdate<"clone_payment_gates"> = {
    last_checked_at: now,
    check_count: (data.check_count ?? 0) + 1,
    ...(locked && !data.first_locked_seen_at ? { first_locked_seen_at: now } : {}),
  };
  const { error: updateError } = await supabaseAdmin
    .from("clone_payment_gates")
    .update(asRow<TablesUpdate<"clone_payment_gates">>(patch))
    .eq("clone_id", cloneId);
  if (updateError) console.error("[gate] check stamp failed", updateError.message);
}

// ── Enforcement ─────────────────────────────────────────────────────────────

export type GateGuard =
  | { open: true }
  | {
      open: false;
      reason: string;
      locksAt: string | null;
      planSlug: string | null;
      amountDueCents: number | null;
      currency: string;
    };

/**
 * May this clone spend?
 *
 * This is where the gate is ENFORCED. The clone's own lock screen is
 * presentation — a browser is not a place to keep a commercial control — and
 * Mission Control is the one authority a clone cannot talk its way past.
 *
 * It matters most on `tokens/reserve`: a workspace provisioned by Mission
 * Control boots with the PRIME'S forwarded vendor keys, so an unpaid clone
 * generating reports spends Aurixa's own OpenAI and property-data budget. The
 * frontend gate does not stop a scripted caller; this does.
 *
 * ## It fails OPEN on a read error, deliberately
 *
 * A database blip must not stop a paying customer working. The gate exists to
 * collect an activation payment inside a window, not to defend against an
 * attacker who cannot cause database errors anyway — and the failure it would
 * otherwise cause is an outage for somebody who has paid. The error is logged
 * so the blip is visible rather than absorbed.
 */
export async function assertGateOpen(cloneId: string | null): Promise<GateGuard> {
  if (!cloneId) return { open: true };
  const read = await readGate(cloneId);
  if (!read.ok) {
    console.error("[gate] guard read failed — allowing through", {
      clone_id: cloneId,
      error: read.error,
    });
    return { open: true };
  }
  if (!read.row) return { open: true };

  const state = resolveGateState(factsOf(read.row));
  if (!state.locked) return { open: true };

  return {
    open: false,
    reason: state.reason,
    locksAt: state.locksAt,
    planSlug: read.row.plan_slug,
    amountDueCents: read.row.amount_due_cents,
    currency: read.row.currency ?? "AUD",
  };
}

/** The 402 body every guarded endpoint returns, written once so a clone can
 *  recognise the refusal by shape rather than by which endpoint it hit. */
export function gateLockedBody(guard: Extract<GateGuard, { open: false }>) {
  return {
    ok: false as const,
    error: "workspace_locked" as const,
    gate_reason: guard.reason,
    locks_at: guard.locksAt,
    plan_slug: guard.planSlug,
    amount_due_cents: guard.amountDueCents,
    currency: guard.currency,
    checkout_path: "/api/public/clones/gate/checkout",
  };
}
