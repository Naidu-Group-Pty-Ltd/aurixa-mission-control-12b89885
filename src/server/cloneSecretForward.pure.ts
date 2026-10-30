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
import { crmLineSecretRefusal } from "./crmLineFeatures.pure";
import { primeOnlyRefusal } from "./primeOnlySecrets.pure";

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
  /**
   * The clone's recorded CRM line. A line's withheld credential is refused
   * straight after the class refusals (`crmLineSecretRefusal`). Absent or
   * unknown withholds nothing, as for every other line rule.
   */
  readonly crmMode?: string | null;
};

const CLASS_REFUSAL: Partial<Record<SecretClass, string>> = {
  platform:
    "Supabase injects this into every function runtime; a project may not have it set by hand.",
  identity:
    "An identity secret is generated per clone, never copied — sharing one makes two deployments the same principal.",
  tenant_scoped:
    "This is the clone's OWN credential. Copying the prime's would let this clone mint tokens the prime accepts.",
  brokered:
    "Mission Control brokers this credential and never forwards it. A clone reaches the vendor through " +
    "Mission Control's own endpoint with the key it already has, so the credential stops here and the CALL " +
    "travels. Forwarding it would hand a tenant a scope it must not hold.",
  /*
   * The only class that is also SWEPT.
   *
   * Every other refusal here stops Mission Control putting something on a
   * clone. This one additionally removes it when something else already has:
   * `npc-client-dashboard` held `SB_MANAGEMENT_ACCESS_TOKEN` while this
   * ledger recorded it `missing`, because Mission Control never wrote it and
   * therefore could not see it. A refusal that only governs the forward path
   * defends the door and not the room.
   */
  prime_only:
    "This grants administrative control over Supabase projects. A personal access token is scoped to an " +
    "ACCOUNT rather than a project, so a copy here would reach the prime, Mission Control and every other " +
    "tenant, and Supabase publishes no way to narrow one. It is never forwarded, and the clone-secrets " +
    "reconcile sweep removes it from any workspace found holding it.",
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
 * The class refusal for one name, in that name's own words where it has them.
 *
 * `prime_only` covers two kinds of credential (`primeOnlySecrets.pure.ts`):
 * Supabase management tokens, which the class text describes, and Mission
 * Control's own control-plane secrets, which it does not. An operator reading
 * "administrative control over Supabase projects" beside the Vapi key would be
 * told the wrong reason for a right refusal.
 */
export function refusalFor(name: string, secretClass: SecretClass): string | undefined {
  const refusal = classRefusalFor(secretClass);
  if (!refusal) return undefined;
  return secretClass === "prime_only" ? (primeOnlyRefusal(name) ?? refusal) : refusal;
}

/**
 * Decide what a push does with one authorised name.
 *
 * The order is the guarantee: class first, so no arrangement of rows can
 * forward a signing key; then the clone's CRM line, so a per-clone row cannot
 * put a GoHighLevel key on the line that carries none; then fleet policy, so a
 * deliberate "do not forward" is not quietly overridden per clone; then the
 * value, which is the only question left once the name is allowed to travel
 * at all.
 */
export function decideForward(facts: ForwardFacts): ForwardOutcome {
  const classRefusal = refusalFor(facts.name, facts.secretClass);
  if (classRefusal) return { act: "refuse", name: facts.name, why: classRefusal };

  const lineRefusal = crmLineSecretRefusal(facts.name, facts.crmMode);
  if (lineRefusal) return { act: "refuse", name: facts.name, why: lineRefusal };

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
  /** The clone's recorded CRM line — see `ForwardFacts.crmMode`. */
  readonly crmMode?: string | null;
}): ForwardOutcome[] {
  return input.authorised.map((name) =>
    decideForward({
      name,
      secretClass: input.classOf(name),
      fleetInherit: input.fleet.has(name) ? (input.fleet.get(name) as boolean) : null,
      presentInEnv: input.envHas(name),
      crmMode: input.crmMode,
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
 *
 * ## A setting follows Mission Control; a credential is delivered once
 *
 * The ledger as a filter had a second blind spot: it records THAT a name was
 * delivered, not WHAT was delivered. On 15 Oct 2026 Mission Control's listings
 * moved to the rebuilt Airtable base and its `AIRTABLE_TABLE_NAME` changed with
 * them; all four clones' rows read `inherited` from September, so no pass ever
 * sent the new value, and every clone asked the broker for the retired table
 * and was refused (`table_not_allowed`) every fifteen minutes, its marketplace
 * frozen at 8 Sep.
 *
 * So the names in `FLEET_CONFIGURATION` are sent again on every pass where the
 * clone's row is `inherited` and Mission Control holds a value. The write
 * compares digests first (`secretWriteDiff.pure.ts`), so a clone that already
 * holds the value is sent nothing and keeps its set time, and a changed value
 * arrives within one pass.
 *
 * Credentials are deliberately not in the set. A key written onto every tenant
 * at once breaks every tenant at once when it is wrong: on 19 Oct 2026 the
 * Anthropic key Mission Control held was organisation-scoped, which the
 * Messages API refuses without a workspace header, and following it would have
 * put that key on every clone whatever each held. Replacing a credential across
 * the fleet stays a deliberate act.
 */

/**
 * Fleet names whose VALUE follows Mission Control's, not only their presence.
 *
 * Configuration only — what a clone reads to find Mission Control's data, never
 * what authenticates it. `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` are `brokered`
 * and never reach a clone at all; these four are what a clone needs to ask the
 * broker for the right table.
 */
export const FLEET_CONFIGURATION: ReadonlySet<string> = new Set([
  "AIRTABLE_TABLE_NAME",
  "AIRTABLE_TABLE_ALLOWLIST",
  "AIRTABLE_TABLE_ALIASES",
  "AIRTABLE_IMAGE_LIBRARY_FIELD",
]);

/** What a fleet pass does with one fleet-policy name on one clone. */
export type FleetForwardOutcome =
  /** Marked inheritable, held here, not yet on this clone — will be written. */
  | { readonly act: "forward"; readonly name: string }
  /**
   * Delivered by the forward, and a setting whose value follows Mission
   * Control's (`FLEET_CONFIGURATION`): sent again, and written only where the
   * clone holds a different value.
   */
  | { readonly act: "refresh"; readonly name: string }
  /** Fleet policy declines this name. Never written. */
  | { readonly act: "not_inherited"; readonly name: string; readonly why: string }
  /** Refused on class, or on the clone's CRM line, ahead of every other question. */
  | { readonly act: "refuse"; readonly name: string; readonly why: string }
  /** Mission Control's own environment holds nothing under this name. */
  | { readonly act: "no_value"; readonly name: string; readonly why: string }
  /** The clone's ledger already records it. Not rewritten — this settles. */
  | { readonly act: "already_set"; readonly name: string; readonly why: string }
  /**
   * Fleet policy forwards it and THIS clone has had it deliberately taken
   * away. Never written back.
   *
   * A separate outcome from `already_set` because the two say opposite things
   * about the project: `already_set` means the clone holds the value, this
   * means it must not. Folding them together would make the sweep's report
   * read as a delivered credential.
   */
  | { readonly act: "withheld"; readonly name: string; readonly why: string };

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
  /**
   * Whether the ledger records it as delivered BY THE FORWARD (`inherited`),
   * rather than set on this clone by a person (`set`) or minted for it. Only a
   * forwarded value is the forward's to replace.
   */
  readonly inheritedOnClone?: boolean;
  /**
   * Whether this clone's ledger records the name as deliberately withheld.
   *
   * Asked BEFORE `settledOnClone`, and it is the reason `withheld` is not one
   * of the settled statuses: settled would silence the sweep by claiming the
   * clone holds the value, which is the opposite of true, and the operator's
   * secret list would then show a credential the project does not have.
   */
  readonly withheldOnClone: boolean;
  /** The clone's recorded CRM line — see `ForwardFacts.crmMode`. */
  readonly crmMode?: string | null;
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
  const classRefusal = refusalFor(facts.name, facts.secretClass);
  if (classRefusal) return { act: "refuse", name: facts.name, why: classRefusal };

  // Ahead of fleet policy, for the reason it is ahead of it per clone: a
  // fleet row marked `inherit` must not be the way a line's withheld
  // credential reaches it.
  const lineRefusal = crmLineSecretRefusal(facts.name, facts.crmMode);
  if (lineRefusal) return { act: "refuse", name: facts.name, why: lineRefusal };

  if (!facts.inherit) {
    return {
      act: "not_inherited",
      name: facts.name,
      why: "Fleet policy records this name as not forwarded.",
    };
  }

  // Ahead of everything but the class refusal and fleet policy itself: a
  // withdrawal that a later question could overturn is a credential that
  // flaps back onto a tenant on the next sweep.
  if (facts.withheldOnClone) {
    return {
      act: "withheld",
      name: facts.name,
      why:
        "This clone has had the name deliberately taken away, so fleet policy does not " +
        "put it back. Remove the `withheld` ledger row to forward it again.",
    };
  }

  if (facts.settledOnClone) {
    // Still the ledger before the environment: with no value here, a setting
    // the clone holds stays `already_set` rather than reading as missing.
    if (facts.inheritedOnClone && facts.presentInEnv && FLEET_CONFIGURATION.has(facts.name)) {
      return { act: "refresh", name: facts.name };
    }
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
  /** Of those, the ones the forward itself delivered (`inherited`). */
  readonly inherited?: ReadonlySet<string>;
  /** The names this clone's ledger records as deliberately withheld. */
  readonly withheld?: ReadonlySet<string>;
  /** The clone's recorded CRM line — see `ForwardFacts.crmMode`. */
  readonly crmMode?: string | null;
}): FleetForwardOutcome[] {
  const withheld = input.withheld ?? new Set<string>();
  const inherited = input.inherited ?? new Set<string>();
  return [...input.fleet.keys()].sort().map((name) =>
    decideFleetForward({
      name,
      secretClass: input.classOf(name),
      inherit: input.fleet.get(name) === true,
      presentInEnv: input.envHas(name),
      settledOnClone: input.settled.has(name),
      inheritedOnClone: inherited.has(name),
      withheldOnClone: withheld.has(name),
      crmMode: input.crmMode,
    }),
  );
}

/**
 * The names a fleet pass will send, in a stable order: the ones a clone is
 * missing, and the settings it holds that follow Mission Control's value (the
 * write leaves out any the clone already holds, value for value).
 */
export function fleetNamesToWrite(outcomes: readonly FleetForwardOutcome[]): string[] {
  return outcomes.filter((o) => o.act === "forward" || o.act === "refresh").map((o) => o.name);
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

/* ────────────────────────────────────────────────────────────────────────
 * Taking a forwarded credential back off ONE clone.
 *
 * The fleet withdrawal above answers "this name should stop travelling".
 * This answers the different question the Didit key actually posed: the name
 * still travels — two tenants keep it and their verification depends on it —
 * and ONE tenant must not hold it, because that clone reaches the vendor
 * through Mission Control's broker instead.
 *
 * Deleting the value is not enough on its own, and this is the whole reason
 * the act needs a decision module rather than one Management API call:
 * `pushFleetSecretForwards` writes every fleet name a clone is not settled
 * on, every thirty minutes, so a deleted value is back before anybody looks.
 * The withdrawal is therefore a LEDGER act that happens to delete a value,
 * not a delete that happens to be recorded.
 *
 * Three rules.
 *
 * **Only what the forward delivered**, exactly as the fleet withdrawal has
 * it: a name whose ledger says anything but `inherited` is not this lever's
 * to remove. A clone's own peppers, push keys and signing secret are `set` or
 * `generated`, and deleting one breaks the clone in a way no forward could
 * have caused.
 *
 * **`withheld` is not settled.** It would be easy to silence the sweep by
 * calling the name delivered, and it would be a lie in the one register an
 * operator reads to answer "what does this project hold". The status says the
 * project does NOT hold it and no sweep may write it — two facts, one word,
 * neither of them "delivered".
 *
 * **A withdrawal is recorded prose.** The fleet rows carry their reasons in
 * words ("Prime-only Supabase management token — do not forward") because a
 * policy nobody can read is one somebody undoes. A per-clone withdrawal is
 * rarer and more surprising than a fleet one, so it is refused without a
 * reason rather than accepting a blank.
 * ──────────────────────────────────────────────────────────────────────── */

/** What withholding one name from one clone will do. */
export type CloneWithholdOutcome =
  /** Delete the value from the project and record the withdrawal. */
  | { readonly act: "withhold"; readonly name: string; readonly reason: string }
  /** Already withheld from this clone. Nothing to do, and not an error. */
  | { readonly act: "already_withheld"; readonly name: string; readonly why: string }
  /** Refused, with the reason an operator has to read. */
  | { readonly act: "refuse"; readonly name: string; readonly why: string };

export type CloneWithholdFacts = {
  readonly name: string;
  /** This clone's ledger status for the name, or null when it has no row. */
  readonly ledgerStatus: string | null;
  /** Why this tenant must not hold it. Required — see the third rule above. */
  readonly reason: string;
};

/** The shortest reason that is an explanation rather than a shrug. */
export const MIN_WITHHOLD_REASON = 12;

export function decideCloneWithhold(facts: CloneWithholdFacts): CloneWithholdOutcome {
  const reason = (facts.reason ?? "").trim();
  if (reason.length < MIN_WITHHOLD_REASON) {
    return {
      act: "refuse",
      name: facts.name,
      why:
        `Withholding a forwarded credential from one clone needs a reason of at least ` +
        `${MIN_WITHHOLD_REASON} characters. It is rarer and more surprising than a fleet ` +
        `decision, and the next operator reads it to decide whether to undo it.`,
    };
  }

  if (facts.ledgerStatus === "withheld") {
    return {
      act: "already_withheld",
      name: facts.name,
      why: "This clone already has the name withheld; the project does not hold a value.",
    };
  }

  if (facts.ledgerStatus !== "inherited") {
    return {
      act: "refuse",
      name: facts.name,
      why:
        `This clone's ledger records the name as \`${facts.ledgerStatus ?? "absent"}\` rather ` +
        "than `inherited`, so the fleet forward did not put it there and this lever may not " +
        "take it away. A clone's own secrets are removed by whatever created them.",
    };
  }

  return { act: "withhold", name: facts.name, reason };
}

/* ────────────────────────────────────────────────────────────────────────
 * What a forward never writes over.
 *
 * The owner decided D6 on 30 Oct 2026: a platform key keeps running after
 * handover and is withdrawn only when the client brings its own. The client's
 * own value is recorded `set` (the Integrations broker records it so, and so
 * does an operator setting a value for this clone), and a key minted for this
 * clone on Aurixa's own vendor account is recorded `minted`.
 *
 * The fleet sweep has never written over either (`SETTLED` in
 * `fleetSecretForward.server.ts`). The per-clone push and a repair read no
 * ledger at all: each wrote Mission Control's value back over the client's
 * key, or over the minted one, and recorded it `inherited`, which restarts
 * the recharge and ends the per-clone attribution, with nothing saying so.
 *
 * `withheld` and `federated` join them for the reason the fleet sweep keeps
 * them off the project (`NOT_ON_THE_PROJECT` there): written by a forward, a
 * credential somebody took off the clone is back, or the clone silently stops
 * federating.
 *
 * Read from the ledger at the write, and kept whether or not Mission Control
 * holds a value: a repair that finds none writes a row (`authorised_no_value`,
 * `missing`) that would replace the clone's own, and the next sweep then reads
 * the name as owed. A ledger that could not be read is not an empty one, and
 * a name the project does not hold may be one taken off it on purpose, so no
 * forwarded value is written at all: the fleet sweep and the per-clone push
 * stand down on an unread ledger too. Each forward sweep reads the ledger
 * itself and delivers what is missing once it reads.
 * ──────────────────────────────────────────────────────────────────────── */

/** The ledger statuses no forwarded value is written over, each with why. */
export const NEVER_FORWARDED_OVER: ReadonlyMap<string, string> = new Map([
  ["set", "this clone's ledger records its own value (`set`)"],
  ["minted", "this clone's ledger records a key minted for it (`minted`)"],
  ["withheld", "this clone's ledger records it as taken off the clone (`withheld`)"],
  [
    "federated",
    "this clone's ledger records it as federated, with no value on the project (`federated`)",
  ],
]);

/** A ledger read as supabase-js answers one: the rows, or `{ data: null, error }`. */
export type CloneLedgerRead = {
  data: ReadonlyArray<{ name: string; status: string | null }> | null;
  error: { message: string } | null;
};

/** What the ledger keeps from a forward, or that it could not be read. */
export type ForwardLedger =
  | { read: true; kept: ReadonlyMap<string, { status: string; why: string }> }
  | { read: false; why: string };

export function readForwardLedger(ledger: CloneLedgerRead): ForwardLedger {
  if (ledger.error) return { read: false, why: ledger.error.message };
  // Neither rows nor an error is not an empty ledger either.
  if (!ledger.data) return { read: false, why: "the read returned neither rows nor an error" };
  const kept = new Map<string, { status: string; why: string }>();
  for (const row of ledger.data) {
    const status = row.status ?? "";
    const why = NEVER_FORWARDED_OVER.get(status);
    if (why) kept.set(row.name, { status, why });
  }
  return { read: true, kept };
}

/**
 * The names among `names` no forwarded value may be written over, each with
 * why.
 *
 * With the ledger read: every name it records `set`, `minted`, `withheld` or
 * `federated`. With it unread: every name, and no row for any of them, since
 * the row there may be the clone's own. Asked by the writer only where a
 * forwarded value would go, so a name another step owns, or one its class
 * decides, is decided as it always was.
 */
export function keptFromForward(input: {
  names: readonly string[];
  ledger: ForwardLedger;
}): Map<string, string> {
  const { ledger } = input;
  const kept = new Map<string, string>();
  for (const name of input.names) {
    if (ledger.read) {
      const own = ledger.kept.get(name);
      if (own) kept.set(name, own.why);
    } else {
      kept.set(
        name,
        `the secret ledger could not be read (${ledger.why}), so no platform value was written and this name's row is left as it is`,
      );
    }
  }
  return kept;
}

const listed = (names: readonly string[], cap = 6) =>
  names.length <= cap
    ? names.join(", ")
    : `${names.slice(0, cap).join(", ")} and ${names.length - cap} more`;

/**
 * The status line for the forwarded names a write left alone, or null when
 * there is nothing to say. `kept` is what the writer actually kept, so the
 * line counts only names a forwarded value would have gone to.
 */
export function describeKeptForwards(input: {
  kept: readonly string[];
  ledger: ForwardLedger;
}): string | null {
  const { ledger, kept } = input;
  if (ledger.read) {
    if (kept.length === 0) return null;
    return `No platform value written over ${kept.length} forwarded name(s) this clone's ledger keeps: ${listed(
      kept.map((n) => `${n} (${ledger.kept.get(n)?.status ?? "kept"})`),
    )}`;
  }
  return (
    `Secret ledger unreadable (${ledger.why}): no platform value was written, ` +
    "and the forward sweeps deliver what is missing once the ledger reads"
  );
}
