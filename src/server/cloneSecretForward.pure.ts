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
 * Decide what a push does with one authorised name.
 *
 * The order is the guarantee: class first, so no arrangement of rows can
 * forward a signing key; then fleet policy, so a deliberate "do not forward"
 * is not quietly overridden per clone; then the value, which is the only
 * question left once the name is allowed to travel at all.
 */
export function decideForward(facts: ForwardFacts): ForwardOutcome {
  const classRefusal = CLASS_REFUSAL[facts.secretClass];
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
