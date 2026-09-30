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
 * The columns of a stored gate the resolver's facts come from. Structural
 * rather than the generated row type, so this module still imports nothing
 * and a browser component can hand it the row it already holds.
 */
export type GateFactsRow = {
  manual_override: string | null;
  paid_at: string | null;
  locks_at: string | null;
};

/**
 * A stored gate's facts — the one way a row is read, on the server and in the
 * browser alike.
 *
 * It lives here rather than beside the queries because the trial-extension
 * dialog plans from a row the console already fetched, and the act plans from
 * the row it re-reads: if the two read a row differently, the deadline an
 * operator previews is not the deadline that gets written. The column is
 * CHECK-constrained to the two override words; anything else reads as no
 * override, which is also how `resolveGateState` would treat it.
 */
export function gateFactsOf(row: GateFactsRow | null | undefined): GateFacts | null {
  if (!row) return null;
  const override = row.manual_override;
  return {
    manualOverride: override === "locked" || override === "unlocked" ? override : null,
    paidAt: row.paid_at,
    locksAt: row.locks_at,
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
export function computeLocksAt(armedAt: Date | string, graceHours: number | null): string | null {
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

// ── The event vocabulary ────────────────────────────────────────────────────

/**
 * Every value `clone_payment_gate_events.kind` accepts.
 *
 * The column is CHECK-constrained, and `logGateEvent` deliberately swallows a
 * refused insert — an audit write must never fail the act it records. Put
 * together, a kind the column does not know is not an error anybody sees: the
 * act happens and its history silently does not. So the vocabulary is written
 * down once, here, and the contract test holds it against the migration that
 * declares the constraint.
 *
 * `extended` is the Window act's name and predates trial extensions. It
 * records ANY change of window, a shorter one included. `trial_extended` is
 * the act that only ever adds time.
 */
export const GATE_EVENT_KINDS = [
  "armed",
  "extended",
  "trial_extended",
  "locked",
  "unlocked",
  "override_cleared",
  "payment_settled",
  "payment_reversed",
  "checkout_started",
  "disarmed",
] as const;

export type GateEventKind = (typeof GATE_EVENT_KINDS)[number];

/**
 * How each event reads in a gate's history. `extended` says what the Window
 * act actually does: "extended" over a window that was shortened is the
 * history contradicting itself.
 */
export const GATE_EVENT_LABEL: Readonly<Record<GateEventKind, string>> = {
  armed: "armed",
  extended: "window changed",
  trial_extended: "trial extended",
  locked: "locked",
  unlocked: "unlocked",
  override_cleared: "override cleared",
  payment_settled: "payment settled",
  payment_reversed: "payment reversed",
  checkout_started: "checkout started",
  disarmed: "disarmed",
};

/** The label for a kind read back from the database, which is typed `string`. */
export function gateEventLabel(kind: string): string {
  return (GATE_EVENT_LABEL as Readonly<Record<string, string>>)[kind] ?? kind.replace(/_/g, " ");
}

// ── Extending a trial ───────────────────────────────────────────────────────

/**
 * The quick choices an operator is offered, in days — the shapes a customer
 * actually asks for. Anything else is typed in hours.
 */
export const TRIAL_EXTENSION_PRESET_DAYS = [1, 3, 7, 14, 30] as const;

/**
 * How many times a gate's trial has been extended.
 *
 * The generated types say the column is always there, and once
 * `20260930100000_clone_gate_trial_extensions.sql` has applied it is. It is
 * read defensively all the same: code ships separately from that migration,
 * and a row read before the column exists has no such field — which must read
 * as "never extended", not as `NaN` extensions or the word "undefined" on the
 * console. One reader, here, because the fleet summary, the console row and
 * the clone card all count it.
 */
export function trialExtensionsOf(
  row: { trial_extension_count?: unknown } | null | undefined,
): number {
  const count = row?.trial_extension_count;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * A workspace running on time an operator gave it: extended at least once and
 * still unpaid. Once the payment lands there is no trial left to be on, so a
 * paid gate is never on one however often it was extended.
 *
 * One rule for the console's filter and the fleet count printed beside it — a
 * filter that disagrees with its own number is a page contradicting itself.
 */
export function isOnExtendedTrial(row: {
  gate: { trial_extension_count?: unknown } | null;
  state: { paid: boolean };
}): boolean {
  return !row.state.paid && trialExtensionsOf(row.gate) > 0;
}

/**
 * Validate an operator-typed extension.
 *
 * Unlike a window, an extension has no "blank means none": extending by
 * nothing is not an extension, and a blank that quietly became a default is
 * how an operator comes to believe they gave a customer a week they did not.
 * Past that it is the window's own rule — whole hours, one to a year.
 */
export function normaliseExtensionHours(
  input: number | string | null | undefined,
): { ok: true; hours: number } | { ok: false; error: string } {
  if (input === null || input === undefined || (typeof input === "string" && !input.trim())) {
    return { ok: false, error: "required" };
  }
  const parsed = normaliseGraceHours(input);
  if (!parsed.ok) return parsed;
  if (parsed.hours === null) return { ok: false, error: "required" };
  return { ok: true, hours: parsed.hours };
}

export type TrialExtensionRequest = {
  /** Whole hours to add. Validated here, not only at the RPC's door, because
   *  the dialog previews with this same function. */
  hours: number | string;
  /**
   * Also lift an operator's standing LOCK.
   *
   * An extension never lifts one by itself. A lock is a suspension somebody
   * decided on and recorded a reason for, and "give them another week" is a
   * different decision: the first must not be undone as a side effect of the
   * second. An operator's UNLOCK is another matter — see the planner.
   */
  liftOperatorLock?: boolean;
  /**
   * The gate as the operator saw it when this extension was previewed: its
   * deadline and its override. Given, a gate that no longer matches is
   * refused as `gate_changed` and nothing is planned from it.
   *
   * The dialog plans from the console's copy of the row, which can be a minute
   * old; the act re-reads the row before writing. Without this, an extension
   * previewed as "locks 10 Oct" would be planned by the act from whatever the
   * gate holds by then — so two operators answering the same ticket would each
   * add a week, and the deadline written would be one nobody was shown.
   */
  expected?: { locksAt: string | null; manualOverride: GateOverride | null };
};

/** Why an extension was refused. One word each, so the server, the dialog and
 *  the history cannot describe the same refusal three ways. */
export type TrialExtensionRefusal =
  | "no_gate"
  | "already_paid"
  | "gate_changed"
  | "no_deadline"
  | "operator_locked"
  | "invalid_hours"
  | "beyond_maximum";

/** Two stored timestamps name the same instant. PostgREST and a browser may
 *  spell one instant differently, so the comparison is by time, and an
 *  unparseable value only ever equals itself. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
}

export type TrialExtensionPlan =
  | {
      ok: true;
      hours: number;
      /** The new deadline — the only fact about the window the act writes. */
      locksAt: string;
      /** The deadline it replaces, which may already have passed. */
      previousLocksAt: string;
      /**
       * What the hours were added to. `deadline` while the trial is still
       * running: the customer keeps the time they had and gains the rest.
       * `now` once it has lapsed: seven more days means seven days they can
       * use, not seven measured from a deadline already behind them.
       */
      base: "deadline" | "now";
      /** The operator override this extension hands back to the clock, if any. */
      clearsOverride: GateOverride | null;
      before: GateState;
      /** Always open and counting down. An extension that could leave a gate
       *  locked would be a lock with a misleading name. */
      after: GateState;
    }
  | { ok: false; refusal: TrialExtensionRefusal };

/**
 * Plan a trial extension: the new deadline, or why there is none.
 *
 * This is the whole rule and the only copy of it. The server act writes what
 * it returns and the dialog previews what it returns, so the date an operator
 * reads before confirming is the date the gate is written with — not a second
 * calculation of it that could disagree.
 *
 * ## It moves the deadline, and only ever later
 *
 * An extension writes `locks_at` and nothing else about the window. The gate
 * stays derived: it reopens because the new deadline is in the future, and it
 * closes again by itself when that deadline passes — which is the entire
 * point. The alternative an operator had was to unlock by hand and then
 * remember to lock again, and a close that depends on somebody remembering is
 * a gate that fails open. Nothing here schedules anything, so there is nothing
 * to forget to schedule.
 *
 * It never shortens. Setting a window from scratch — shorter, longer or none —
 * is the Window act's job; an act called "extend" that could bring a deadline
 * forward is one an operator cannot trust from its name.
 *
 * ## What it refuses, and why each is not an extension
 *
 *   • no gate — the prime, and every clone that pre-dates gating;
 *   • paid — the money landed, so there is no trial left. Checked BEFORE the
 *     override, although the resolver ranks the override first: a paid
 *     workspace held open or shut by an operator is a question about the
 *     override, never about the trial;
 *   • no deadline — there is no clock to extend. Putting a gate onto one is a
 *     Window act, because it takes time away from somebody who had no limit;
 *   • an operator lock, unless `liftOperatorLock` — see the request type;
 *   • a deadline more than `GATE_MAX_HOURS` from now. A year is the longest
 *     honest window, and an extension past it is refused rather than clamped:
 *     a figure that silently becomes a smaller one is a date nobody chose;
 *   • a gate that is no longer the one the operator was shown, when the
 *     request says what that was — see `expected` on the request.
 *
 * ## An operator's unlock is converted, not refused
 *
 * A gate held open by hand is exactly what this act replaces: the trial ran
 * out, somebody unlocked it to give the customer time, and now somebody has to
 * remember to lock it again. Extending one clears the unlock and puts the gate
 * back on the clock at the new deadline, so the next close happens by itself.
 * That is a narrowing the operator asked for by name, and the dialog says so
 * before the click.
 */
export function planTrialExtension(
  facts: GateFacts | null,
  request: TrialExtensionRequest,
  now: Date = new Date(),
): TrialExtensionPlan {
  const refuse = (refusal: TrialExtensionRefusal): TrialExtensionPlan => ({ ok: false, refusal });
  if (!facts) return refuse("no_gate");

  const hours = normaliseExtensionHours(request.hours);
  if (!hours.ok) return refuse("invalid_hours");

  const before = resolveGateState(facts, now);
  if (before.paid) return refuse("already_paid");

  // After the payment, deliberately: "the money landed" is the more useful
  // thing to be told than "something changed".
  const expected = request.expected;
  if (
    expected &&
    (!sameInstant(facts.locksAt, expected.locksAt) ||
      facts.manualOverride !== (expected.manualOverride ?? null))
  ) {
    return refuse("gate_changed");
  }

  // An unparseable deadline is no deadline, exactly as the resolver reads it.
  const previousLocksAt = facts.locksAt;
  const deadline = parseTime(previousLocksAt);
  if (!previousLocksAt || deadline === null) return refuse("no_deadline");

  if (before.reason === "operator_locked" && request.liftOperatorLock !== true) {
    return refuse("operator_locked");
  }

  const nowMs = now.getTime();
  const lapsed = deadline <= nowMs;
  const next = (lapsed ? nowMs : deadline) + hours.hours * HOUR_MS;
  if (next - nowMs > GATE_MAX_HOURS * HOUR_MS) return refuse("beyond_maximum");

  const locksAt = new Date(next).toISOString();
  return {
    ok: true,
    hours: hours.hours,
    locksAt,
    previousLocksAt,
    base: lapsed ? "now" : "deadline",
    clearsOverride: facts.manualOverride,
    before,
    after: resolveGateState({ manualOverride: null, paidAt: facts.paidAt, locksAt }, now),
  };
}

/**
 * One operator-facing sentence per refusal — the planner's, and the ones the
 * server adds on top of them, since both arrive in the same dialog. An unknown
 * code is shown as itself rather than swallowed: a refusal nobody can read is
 * still better than a toast that says nothing happened.
 */
export function describeTrialExtensionRefusal(code: string): string {
  switch (code) {
    case "no_gate":
      return "This clone has no activation gate, so there is no trial to extend.";
    case "already_paid":
      return "The activation payment has landed — there is no trial left to extend.";
    case "no_deadline":
      return "This gate has no deadline, so there is no trial clock to extend. Use Window to put it on one.";
    case "operator_locked":
      return "An operator has locked this workspace. Extending its trial lifts that lock, so it has to be asked for explicitly.";
    case "invalid_hours":
      return `Enter a whole number of hours, from ${GATE_MIN_HOURS} to ${GATE_MAX_HOURS}.`;
    case "beyond_maximum":
      return "That would put the deadline more than a year away — the longest window a gate may run.";
    case "reason_required":
      return "A reason of at least five characters is required.";
    case "gate_changed":
      return "The gate changed while you were deciding — somebody else acted on it, or the payment landed. Nothing was written; look again and retry.";
    case "schema_pending":
      return "This deployment's database has not been migrated for trial extensions yet. Nothing was written.";
    default:
      return `The extension was refused (${code}).`;
  }
}
