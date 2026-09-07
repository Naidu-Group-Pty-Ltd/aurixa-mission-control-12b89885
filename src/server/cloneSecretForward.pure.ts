/**
 * Forwarding one of the prime's credentials to ONE clone.
 *
 * ## Why this exists beside `prime_secret_forwards`
 *
 * That table is FLEET policy: a name marked `inherit` is copied into every
 * clone this platform ever provisions, and it is applied at provisioning time
 * only. Both halves are wrong for the case this serves — a credential one
 * tenant should hold and the next should not, wanted on a clone that was
 * provisioned days ago.
 *
 * GoHighLevel is the worked example. 36 of the prime's edge functions import
 * `_shared/ghl-account.ts` and 11 more read the environment directly; the
 * resolver THROWS `Missing GHL legacy API key` rather than degrading, so on a
 * clone without it every one of those functions 500s at its first call. And
 * `ghl_account_config` holds no row on this clone, so the resolver takes the
 * legacy branch — `GOHIGHLEVEL_API_KEY` and `GOHIGHLEVEL_LOCATION_ID`, not
 * the `_NEW` pair. But a GHL sub-account is a tenant's own commercial
 * relationship, so the ANSWER for the next tenant may well be "collect their
 * own", and marking it `inherit` fleet-wide would decide that for them.
 *
 * A per-clone row is therefore the authorisation, and its existence is the
 * whole of it: there is no `inherit` boolean here, because a row that is not
 * wanted is deleted. A false row would mean "considered and declined", which
 * is a statement fleet policy needs and a single clone does not.
 *
 * ## Where the value comes from, and why that is the sharp edge
 *
 * Mission Control never reads the prime's secret VALUES from its Supabase
 * project — the snapshot "carries schema + code only", and secret NAMES are
 * scraped out of the prime's source. The only value source is Mission
 * Control's own `process.env`, exactly as the fleet path uses.
 *
 * So a name can be authorised, correct, and still have nothing behind it.
 * Writing an empty shell in that case is the defect this platform has already
 * paid for — an unset name is a function that 500s, and a name set to "" is a
 * vendor call that fails authentication with a stranger message. `no_value`
 * is therefore its own outcome, never folded into success and never written.
 *
 * ## What a per-clone row may never do
 *
 * It may never overrule a classification. `classifySecret` calls
 * `JWT_SECRET` tenant-scoped because handing a clone the prime's signing key
 * would let that clone mint tokens the PRIME's database accepts, for any
 * `sub` and any role; `TURNSTILE_SECRET_KEY` is one half of a widget pair.
 * Those refusals are absolute here, ahead of every other question, so an
 * escape hatch for a vendor key cannot become a hole in them.
 *
 * It may never overrule a deliberate fleet refusal either. `inherit = false`
 * is recorded prose — "Prime-only Supabase management token — do not
 * forward", "Payment processor key — set per-tenant" — and a per-clone row
 * quietly winning over it is how `SB_MGMT_API_TOKEN`, which reaches every
 * project in the organisation, ends up on a tenant's project. Overriding one
 * is possible and is a visible edit to the fleet row.
 */

import type { SecretClass } from "./prime-backend.server";

/** What will happen to one authorised name on one push. */
export type ForwardOutcome =
  /** Mission Control holds a value and it will be written to this clone. */
  | { readonly act: "forward"; readonly name: string }
  /**
   * Authorised, but Mission Control's environment holds nothing under this
   * name. Never written — an empty shell is worse than an absent one.
   */
  | { readonly act: "no_value"; readonly name: string; readonly why: string }
  /** Refused, with the reason an operator has to read. */
  | { readonly act: "refuse"; readonly name: string; readonly why: string }
  /**
   * Already forwarded to every clone by fleet policy. Not an error and not
   * this row's doing — said plainly so nobody credits the row for it.
   */
  | { readonly act: "already_fleet_wide"; readonly name: string; readonly why: string };

export type ForwardFacts = {
  readonly name: string;
  /** `classifySecret(name)` — the absolute refusals live here. */
  readonly secretClass: SecretClass;
  /** The fleet row's `inherit`, or null when the name has no fleet row. */
  readonly fleetInherit: boolean | null;
  /** Whether Mission Control's own environment holds a non-empty value. */
  readonly presentInEnv: boolean;
};

const CLASS_REFUSAL: Partial<Record<SecretClass, string>> = {
  platform:
    "Supabase injects this into every function runtime; a project may not have it set by hand.",
  identity:
    "An identity secret is generated per clone, never copied — sharing one makes two deployments the same principal.",
  tenant_scoped:
    "This is the clone's OWN credential. Copying the prime's would let this clone mint tokens the prime accepts.",
};

/**
 * The absolute refusals, as one function.
 *
 * Extracted so the per-clone decision and the FLEET decision below cannot
 * hold different ideas of what may never travel. Two copies of the security
 * boundary is exactly the shape this file's own header warns about, and it
 * would be invisible from outside: both paths would keep working, and only
 * one of them would refuse a signing key.
 */
export function classRefusalFor(secretClass: SecretClass): string | undefined {
  return CLASS_REFUSAL[secretClass];
}

/**
 * Decide what a push does with one authorised name.
 *
 * The order is the guarantee: class first, so no arrangement of rows can
 * forward a signing key; then fleet policy, so a deliberate "do not forward"
 * is not quietly overridden per clone; then the value, which is the only
 * question left once the name is allowed to travel at all.
 */
export function decideForward(facts: ForwardFacts): ForwardOutcome {
  const classRefusal = classRefusalFor(facts.secretClass);
  if (classRefusal) return { act: "refuse", name: facts.name, why: classRefusal };

  if (facts.fleetInherit === false) {
    return {
      act: "refuse",
      name: facts.name,
      why:
        "Fleet policy marks this name as not forwarded. Change it on the prime forwarding list " +
        "if that is wrong — a per-clone row does not override a deliberate refusal.",
    };
  }

  if (facts.fleetInherit === true) {
    return {
      act: "already_fleet_wide",
      name: facts.name,
      why: "Fleet policy already forwards this name to every clone; this row adds nothing.",
    };
  }

  if (!facts.presentInEnv) {
    return {
      act: "no_value",
      name: facts.name,
      why:
        "Mission Control's environment holds no value under this name, so there is nothing to " +
        "forward. Set it on this deployment and push again — an empty secret is not written, " +
        "because a name set to the empty string fails authentication rather than reporting as unset.",
    };
  }

  return { act: "forward", name: facts.name };
}

/** The names a push will actually write, in the order they were authorised. */
export function namesToWrite(outcomes: readonly ForwardOutcome[]): string[] {
  return outcomes.filter((o) => o.act === "forward").map((o) => o.name);
}

/**
 * Whether a push accomplished anything.
 *
 * A push that wrote nothing is reported as such rather than as a success over
 * an empty set — the shape every silent-success defect in this platform has
 * taken. `already_fleet_wide` does not count: the clone may well hold the
 * value, but this push did not put it there.
 */
export function pushChangedSomething(outcomes: readonly ForwardOutcome[]): boolean {
  return outcomes.some((o) => o.act === "forward");
}

/**
 * Every authorised name for one clone, decided together.
 *
 * One function because there are two callers and they must not drift: the
 * push writes to a live project, and provisioning folds the same names into
 * the inherited set so a re-provision does not silently drop them. Two copies
 * of "which names may travel" is how a class refusal comes to be reachable in
 * one path and not the other — and the refusals here are the whole security
 * boundary, so that is not a difference anyone would notice from the outside.
 *
 * `envHas` is injected rather than read, so the decision is testable without
 * a process environment and cannot be tempted into reading a value it has no
 * business holding.
 */
export function planCloneForwards(input: {
  /** Names authorised for this clone, in the order they should be written. */
  readonly authorised: readonly string[];
  /** Every fleet row, INCLUDING the `inherit = false` ones — see `decideForward`. */
  readonly fleet: ReadonlyMap<string, boolean>;
  readonly classOf: (name: string) => SecretClass;
  readonly envHas: (name: string) => boolean;
}): ForwardOutcome[] {
  return input.authorised.map((name) =>
    decideForward({
      name,
      secretClass: input.classOf(name),
      fleetInherit: input.fleet.has(name) ? (input.fleet.get(name) as boolean) : null,
      presentInEnv: input.envHas(name),
    }),
  );
}

/* ─────────────────────────── fleet-wide forwards ──────────────────────────
 *
 * `decideForward` above answers a per-clone row's question and, for a name
 * fleet policy already carries, returns `already_fleet_wide` — "fleet policy
 * already forwards this name to every clone; this row adds nothing."
 *
 * That sentence is true of PROVISIONING and false of the fleet. Fleet policy
 * is applied when a clone is built, and nothing re-applies it, so a name added
 * to `prime_secret_forwards` after a clone was provisioned reaches that clone
 * never — while every surface that asks the per-clone path reports the name as
 * already handled. Measured 7 Sep 2026: the five Didit names were marked
 * `inherit` fleet-wide and read `missing` on all three clones, and identity
 * verification on each of them refused as unconfigured.
 *
 * The remedy that existed was a full convergence pass over the whole engine —
 * minutes and vendor calls against a live tenant, refused outright unless the
 * backend is `ready`, to deliver five environment variables. So the ordinary
 * act of adding a fleet credential had no ordinary lever.
 *
 * This is that lever, and it is deliberately the same shape as the per-clone
 * sweep: the ledger is the filter so it settles, an absent value is never
 * written, and the class refusals are the SAME function rather than a second
 * copy that agrees today.
 */

/** What a fleet pass does with one fleet-policy name on one clone. */
export type FleetForwardOutcome =
  /** Marked inheritable, held here, not yet on this clone — will be written. */
  | { readonly act: "forward"; readonly name: string }
  /** Fleet policy declines this name. Never written. */
  | { readonly act: "not_inherited"; readonly name: string; readonly why: string }
  /** Refused on class, ahead of every other question. */
  | { readonly act: "refuse"; readonly name: string; readonly why: string }
  /** Mission Control's own environment holds nothing under this name. */
  | { readonly act: "no_value"; readonly name: string; readonly why: string }
  /** The clone's ledger already records it. Not rewritten — this settles. */
  | { readonly act: "already_set"; readonly name: string; readonly why: string };

export type FleetForwardFacts = {
  readonly name: string;
  readonly secretClass: SecretClass;
  /** The fleet row's `inherit`. */
  readonly inherit: boolean;
  /** Whether Mission Control's own environment holds a non-empty value. */
  readonly presentInEnv: boolean;
  /**
   * Whether this clone's ledger already records the name as delivered.
   *
   * `failed` must NOT count as settled — that is the state a retry exists for,
   * the same rule the per-clone sweep follows.
   */
  readonly settledOnClone: boolean;
};

/**
 * Decide what a fleet pass does with one name on one clone.
 *
 * Same order as `decideForward`, for the same reason: class first, so no
 * arrangement of rows or sweeps can forward a signing key; then policy; then
 * the ledger; then the value.
 *
 * The ledger is asked BEFORE the environment so a settled name reports as
 * settled even on a deployment that has since dropped the value — otherwise a
 * clone that legitimately holds a credential would be reported as missing it
 * because Mission Control's own environment changed.
 */
export function decideFleetForward(facts: FleetForwardFacts): FleetForwardOutcome {
  const classRefusal = classRefusalFor(facts.secretClass);
  if (classRefusal) return { act: "refuse", name: facts.name, why: classRefusal };

  if (!facts.inherit) {
    return {
      act: "not_inherited",
      name: facts.name,
      why: "Fleet policy records this name as not forwarded.",
    };
  }

  if (facts.settledOnClone) {
    return {
      act: "already_set",
      name: facts.name,
      why: "This clone's secret ledger already records the name as delivered.",
    };
  }

  if (!facts.presentInEnv) {
    return {
      act: "no_value",
      name: facts.name,
      why:
        "Fleet policy forwards this name and Mission Control's environment holds no value " +
        "under it, so there is nothing to forward. Set it on this deployment — an empty " +
        "secret is not written, because a name set to the empty string fails authentication " +
        "rather than reporting as unset.",
    };
  }

  return { act: "forward", name: facts.name };
}

/** Every fleet name decided together for one clone. */
export function planFleetForwards(input: {
  /** Every fleet row, including the `inherit = false` ones. */
  readonly fleet: ReadonlyMap<string, boolean>;
  readonly classOf: (name: string) => SecretClass;
  readonly envHas: (name: string) => boolean;
  /** The names this clone's ledger records as delivered. */
  readonly settled: ReadonlySet<string>;
}): FleetForwardOutcome[] {
  return [...input.fleet.keys()].sort().map((name) =>
    decideFleetForward({
      name,
      secretClass: input.classOf(name),
      inherit: input.fleet.get(name) === true,
      presentInEnv: input.envHas(name),
      settledOnClone: input.settled.has(name),
    }),
  );
}

/** The names a fleet pass will actually write, in a stable order. */
export function fleetNamesToWrite(outcomes: readonly FleetForwardOutcome[]): string[] {
  return outcomes.filter((o) => o.act === "forward").map((o) => o.name);
}

/**
 * Fleet names this deployment cannot deliver because it holds no value.
 *
 * Reported rather than counted as settled: a name that is fleet policy, is
 * allowed to travel, and has nothing behind it is an operator action — and it
 * is precisely the state that reads as healthy everywhere else.
 */
export function fleetNamesWithoutValue(outcomes: readonly FleetForwardOutcome[]): string[] {
  return outcomes.filter((o) => o.act === "no_value").map((o) => o.name);
}

/* ────────────────────────────────────────────────────────────────────────
 * Taking a forwarded credential back off the fleet.
 *
 * The forward has always been one-way. A name marked `inherit` travels to
 * every clone; unmarking it stops FUTURE clones receiving it and leaves it on
 * every clone that already has it, for ever, with the ledger still reading
 * `inherited`. So a credential could be authorised fleet-wide and never
 * withdrawn — and the case that made that matter is the Didit key, which is
 * scoped to an APPLICATION and so lets any holder read every other tenant's
 * customers' identity documents. Brokering the call (the verification
 * endpoint) is only half of closing that: the other half is the key ceasing
 * to sit on three tenant projects.
 *
 * Three rules, and the first is the one that protects a tenant.
 *
 * **Only what the forward itself delivered.** A withdrawal may touch a name
 * whose ledger says `inherited` and nothing else. A clone's OWN secrets — its
 * peppers, its push keys, its signing secret, its CAPTCHA pair, its derived
 * hostnames — are `set`, `generated` or `skipped_*`, and deleting one would
 * break the clone in a way no forward could have caused. The status is the
 * whole guard, and it is asked before anything else.
 *
 * **Fleet policy has to have STOPPED authorising it.** A name still marked
 * `inherit` is not withdrawable, however it looks: the forward would simply
 * put it back on the next sweep, and a lever that fights another lever is how
 * a credential flaps rather than leaves.
 *
 * **Absence of a row is withdrawal.** A fleet row that has been deleted
 * authorises nothing, which has to mean the same as `inherit = false` — or
 * removing the row (the obvious way to revoke a forward) would be the one
 * spelling that leaves the credential in place.
 * ──────────────────────────────────────────────────────────────────────── */

/** What a withdrawal pass does with one delivered name on one clone. */
export type FleetWithdrawOutcome =
  /** Delivered by the forward, no longer authorised — will be deleted. */
  | { readonly act: "withdraw"; readonly name: string }
  /** Fleet policy still forwards it. Left alone. */
  | { readonly act: "still_authorised"; readonly name: string; readonly why: string }
  /** Not something the forward delivered. Never touched. */
  | { readonly act: "not_forwarded"; readonly name: string; readonly why: string };

export type FleetWithdrawFacts = {
  readonly name: string;
  /** The clone's ledger status for this name. */
  readonly ledgerStatus: string;
  /** The fleet row's `inherit`, or undefined where no row exists at all. */
  readonly inherit: boolean | undefined;
};

/**
 * Decide whether one name is taken back off one clone.
 *
 * The ledger is asked FIRST and it is the protective question: a name the
 * forward did not deliver is not this lever's to remove, whatever fleet
 * policy now says about it.
 */
export function decideFleetWithdraw(facts: FleetWithdrawFacts): FleetWithdrawOutcome {
  if (facts.ledgerStatus !== "inherited") {
    return {
      act: "not_forwarded",
      name: facts.name,
      why:
        `This clone's ledger records the name as \`${facts.ledgerStatus}\` rather than ` +
        "`inherited`, so the fleet forward did not put it there and this lever may not " +
        "take it away. A clone's own secrets are removed by whatever created them.",
    };
  }

  // Undefined — no fleet row at all — authorises nothing, exactly as
  // `inherit = false` does. Anything else would make deleting the row the one
  // spelling of "stop forwarding this" that leaves the credential in place.
  if (facts.inherit === true) {
    return {
      act: "still_authorised",
      name: facts.name,
      why: "Fleet policy still forwards this name, so withdrawing it would only be undone.",
    };
  }

  return { act: "withdraw", name: facts.name };
}

/** Every delivered name decided together for one clone. */
export function planFleetWithdrawals(input: {
  /** The clone's ledger, name → status. */
  readonly ledger: ReadonlyMap<string, string>;
  /** Every fleet row, including the `inherit = false` ones. */
  readonly fleet: ReadonlyMap<string, boolean>;
}): FleetWithdrawOutcome[] {
  return [...input.ledger.keys()].sort().map((name) =>
    decideFleetWithdraw({
      name,
      ledgerStatus: input.ledger.get(name) ?? "",
      inherit: input.fleet.get(name),
    }),
  );
}

/** The names a withdrawal pass will actually delete, in a stable order. */
export function fleetNamesToWithdraw(outcomes: readonly FleetWithdrawOutcome[]): string[] {
  return outcomes.filter((o) => o.act === "withdraw").map((o) => o.name);
}
