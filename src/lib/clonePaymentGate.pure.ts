/**
 * The activation gate's state machine, and the only place that decides whether
 * a clone is open or locked.
 *
 * ## The state is derived, never stored
 *
 * There is no `status` column and no worker that closes a gate. The status is
 * a pure function of four facts — the operator's standing override, whether
 * Stripe captured the money, when the window closes, and the current time —
 * evaluated on every read, by this module, in Mission Control and inside every
 * clone alike.
 *
 * That shape is chosen against a defect this repository has already had.
 * `docs/THE_CLONING_ENGINE.md` records six pg_cron jobs that were never
 * scheduled, for months, with every check reporting healthy: a migration read
 * an empty vault and returned, the job was never created, and a job that does
 * not exist has no failing run to report. A gate whose CLOSING depended on a
 * worker would fail OPEN under exactly that fault, and nothing would say so.
 * Nothing closes a gate here, so nothing can fail to close one.
 *
 * ## What each layer may conclude
 *
 * `status` is the answer. `reason` says which rule produced it, and the two
 * vocabularies do not overlap — an obligation ("this clone owes an activation
 * payment"), a method ("Stripe captured it") and an operator's decision are
 * different questions, and collapsing them into one badge is how "unlocked by
 * an operator" comes to read as "paid".
 */

/** Values `clone_payment_gates.manual_override` may hold. */
export type GateOverride = "locked" | "unlocked";

export type GateStatus = "open" | "locked";

/**
 * Why the gate is where it is. Ordered here as the resolver evaluates them.
 * `not_gated` is the answer for the prime and for every clone provisioned
 * before this feature existed: there is no row, so there is no gate.
 */
export type GateReason =
  | "not_gated"
  | "operator_unlocked"
  | "operator_locked"
  | "paid"
  | "no_deadline"
  | "within_grace"
  | "grace_expired";

/** The stored facts the resolver reads. Nothing else may influence the answer. */
export type GateFacts = {
  manualOverride: GateOverride | null;
  /** ISO timestamp Stripe's capture was recorded, or null. */
  paidAt: string | null;
  /** ISO timestamp the window closes. Null = no deadline. */
  locksAt: string | null;
};

export type GateState = {
  status: GateStatus;
  reason: GateReason;
  /** Convenience mirror of `status === "locked"`. */
  locked: boolean;
  /** Whether Stripe has captured the activation payment. */
  paid: boolean;
  locksAt: string | null;
  /** Milliseconds until the window closes; null when there is no deadline or
   *  the deadline is irrelevant (paid, or overridden). Never negative. */
  msRemaining: number | null;
  /** True while the gate is open, unpaid, and running out. This — not
   *  `!paid` — is what makes a countdown appear. */
  counting: boolean;
};

/** Three days. The window a paid clone gets before it must be activated. */
export const GATE_DEFAULT_HOURS = 72;

/** An hour is the shortest useful window; a year is the longest honest one. */
export const GATE_MIN_HOURS = 1;
export const GATE_MAX_HOURS = 8760;

const HOUR_MS = 60 * 60 * 1000;

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The whole decision.
 *
 * `facts` being null means there is no gate row — which is the prime, and every
 * clone that existed before this shipped. That answer is `open` / `not_gated`
 * and it is the one case that must never be reachable by any other route.
 */
export function resolveGateState(facts: GateFacts | null, now: Date = new Date()): GateState {
  if (!facts) {
    return {
      status: "open",
      reason: "not_gated",
      locked: false,
      paid: false,
      locksAt: null,
      msRemaining: null,
      counting: false,
    };
  }

  const paidAt = parseTime(facts.paidAt);
  const paid = paidAt !== null;
  const locksAt = parseTime(facts.locksAt);
  const open = (reason: GateReason, msRemaining: number | null, counting = false): GateState => ({
    status: "open",
    reason,
    locked: false,
    paid,
    locksAt: facts.locksAt ?? null,
    msRemaining,
    counting,
  });

  // 1. An operator's standing decision outranks everything, in both
  //    directions. Unlocking is how a customer whose payment is stuck keeps
  //    working; locking is how a workspace is suspended even though it once
  //    paid. They are one column, so they cannot both be set.
  if (facts.manualOverride === "unlocked") return open("operator_unlocked", null);
  if (facts.manualOverride === "locked") {
    return {
      status: "locked",
      reason: "operator_locked",
      locked: true,
      paid,
      locksAt: facts.locksAt ?? null,
      msRemaining: null,
      counting: false,
    };
  }

  // 2. Money landed. This is the automatic unlock, and it is a single stamp
  //    rather than a stamp plus a state write — so there is no second write
  //    that could fail after Stripe has been paid.
  if (paid) return open("paid", null);

  // 3. No deadline was set (or an operator removed it). The gate exists, is
  //    unpaid, and is deliberately not on a clock.
  if (locksAt === null) return open("no_deadline", null);

  const msRemaining = locksAt - now.getTime();
  if (msRemaining > 0) return open("within_grace", msRemaining, true);

  return {
    status: "locked",
    reason: "grace_expired",
    locked: true,
    paid: false,
    locksAt: facts.locksAt ?? null,
    msRemaining: 0,
    counting: false,
  };
}

/**
 * `armed_at + graceHours`, or null when there is no deadline.
 *
 * Both inputs are checked because `new Date(NaN).toISOString()` THROWS rather
 * than producing a bad string, and the caller that would hit it is
 * provisioning — where an operator typing letters into the window field would
 * otherwise take out the arming step and leave a paid clone silently ungated.
 * A value this cannot use is no deadline, which is safe; `armGate` refuses it
 * earlier and substitutes the platform default, which is correct.
 */
export function computeLocksAt(
  armedAt: Date | string,
  graceHours: number | null,
): string | null {
  if (graceHours === null || !Number.isFinite(graceHours)) return null;
  const base = typeof armedAt === "string" ? Date.parse(armedAt) : armedAt.getTime();
  if (!Number.isFinite(base)) return null;
  const at = base + graceHours * HOUR_MS;
  if (!Number.isFinite(at)) return null;
  return new Date(at).toISOString();
}

/**
 * Validate an operator-typed window.
 *
 * `null` is a legitimate answer meaning "no deadline" and is returned as such.
 * Anything unparseable is an error rather than a silent fallback to 72 — a
 * typed value that quietly becomes something else is how an operator comes to
 * believe they set a window they did not.
 */
export function normaliseGraceHours(
  input: number | string | null | undefined,
): { ok: true; hours: number | null } | { ok: false; error: string } {
  if (input === null || input === undefined || input === "") return { ok: true, hours: null };
  const n = typeof input === "string" ? Number(input.trim()) : input;
  if (!Number.isFinite(n)) return { ok: false, error: "not_a_number" };
  if (!Number.isInteger(n)) return { ok: false, error: "not_whole_hours" };
  if (n < GATE_MIN_HOURS) return { ok: false, error: "below_minimum" };
  if (n > GATE_MAX_HOURS) return { ok: false, error: "above_maximum" };
  return { ok: true, hours: n };
}

/**
 * Is this clone one the gate applies to at all?
 *
 * Two independent things must be true and BOTH are checked here rather than at
 * the call site: the clone is on a named plan, and that plan actually costs
 * money. A clone with no plan is not a customer; a clone on a zero-price plan
 * owes nothing.
 *
 * `amountDueCents` being null is deliberately NOT eligible. An unknown price
 * means the caller could not resolve the plan, and gating a workspace that may
 * owe nothing is an outage for somebody who has done nothing wrong, while
 * failing to gate one that does owe money is a row the console lists as
 * ungated for an operator to arm by hand. The visible gap is the safer error.
 */
export type GateEligibility =
  | { eligible: true; planSlug: string; amountDueCents: number }
  | { eligible: false; reason: "no_plan" | "unknown_price" | "free_plan" };

export function gateEligibility(input: {
  planSlug: string | null | undefined;
  amountDueCents: number | null | undefined;
}): GateEligibility {
  const slug = (input.planSlug ?? "").trim().toLowerCase();
  if (!slug) return { eligible: false, reason: "no_plan" };
  const cents = input.amountDueCents;
  if (cents === null || cents === undefined || !Number.isFinite(cents)) {
    return { eligible: false, reason: "unknown_price" };
  }
  if (cents <= 0) return { eligible: false, reason: "free_plan" };
  return { eligible: true, planSlug: slug, amountDueCents: Math.round(cents) };
}

/**
 * "2 days 4 hours", "3 hours", "12 minutes", "less than a minute".
 *
 * Deliberately coarse above an hour: a countdown to the minute on a
 * three-day window reads as an emergency for two and a half days.
 */
export function formatRemaining(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms <= 0) return "none";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  const dayPart = `${days} day${days === 1 ? "" : "s"}`;
  return restHours > 0 ? `${dayPart} ${restHours} hour${restHours === 1 ? "" : "s"}` : dayPart;
}

/**
 * One operator-facing sentence per reason. Kept here rather than in the page so
 * the fleet table, the clone card and the audit log cannot describe the same
 * state three different ways.
 */
export function describeGateReason(state: GateState): string {
  switch (state.reason) {
    case "not_gated":
      return "No activation gate — this workspace is not gated.";
    case "operator_unlocked":
      return "Unlocked by an operator. The clock and the payment no longer apply.";
    case "operator_locked":
      return "Locked by an operator. Payment does not reopen it until the lock is lifted.";
    case "paid":
      return "Activation payment captured — the gate opened automatically.";
    case "no_deadline":
      return "Open with no deadline. Unpaid, and nothing will close it on its own.";
    case "within_grace": {
      const left = formatRemaining(state.msRemaining);
      return left ? `Open — ${left} left before it locks.` : "Open — inside the activation window.";
    }
    case "grace_expired":
      return "Locked — the activation window closed without a payment.";
  }
}

/** Badge tone for the console. `within_grace` is a warning, not a success:
 *  it is a debt with a deadline on it. */
export function gateTone(state: GateState): "neutral" | "success" | "warning" | "danger" {
  switch (state.reason) {
    case "not_gated":
      return "neutral";
    case "paid":
      return "success";
    case "operator_unlocked":
    case "no_deadline":
      return "warning";
    case "within_grace":
      return "warning";
    case "operator_locked":
    case "grace_expired":
      return "danger";
  }
}
