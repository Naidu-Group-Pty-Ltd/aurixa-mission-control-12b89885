/**
 * Repairing a secret only the clone's OWN backend can supply.
 *
 * Most of a clone's secrets arrive at provisioning: inherited from the prime,
 * generated, or derived from the clone's own hostnames. A tenant-scoped one
 * is deliberately none of those — `TURNSTILE_SECRET_KEY` is minted from an
 * identity panel, and `JWT_SECRET` is issued by Supabase when the clone's
 * project is created.
 *
 * `JWT_SECRET` is the one Mission Control can fetch for itself, from the
 * clone's own PostgREST config, which is why it can be repaired rather than
 * only requested. That matters for every clone provisioned before the
 * capture existed — the fleet as it stands — and for any project adopted
 * rather than created here.
 *
 * Pure so the rules can be asserted without a database or the Management API.
 */

/** What the reconcile needs to know about one clone. */
export type JwtRepairFacts = {
  /** The clone's Supabase project, if its backend has been provisioned. */
  projectRef: string | null;
  /** The ledger row for JWT_SECRET, absent when nothing has recorded it. */
  ledgerStatus: "missing" | "set" | "failed" | "inherited" | null;
  /** Stamped when a previous repair failed, for the cooling-off window. */
  lastError: string | null;
  updatedAt: string | null;
  now: number;
};

export type JwtRepairSkip = "no_backend" | "already_set" | "cooling_off";

export type JwtRepairVerdict =
  | { act: true; why: string }
  | { act: false; reason: JwtRepairSkip };

/**
 * How long to leave a failed repair alone. A project whose config the
 * Management API will not return is a permanent refusal until somebody
 * changes something, and retrying it every pass buys nothing.
 */
export const JWT_REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

export function decideJwtSecretRepair(facts: JwtRepairFacts): JwtRepairVerdict {
  // Nothing to read the key from. A clone mid-provisioning reaches this
  // legitimately and is not a fault.
  if (!facts.projectRef) return { act: false, reason: "no_backend" };

  // `inherited` cannot happen for a tenant-scoped name and would be a bug
  // elsewhere; treating it as set here would hide that, so only `set` stops.
  if (facts.ledgerStatus === "set") return { act: false, reason: "already_set" };

  if (facts.lastError && facts.updatedAt) {
    const since = facts.now - Date.parse(facts.updatedAt);
    if (Number.isFinite(since) && since >= 0 && since < JWT_REPAIR_COOLDOWN_MS) {
      return { act: false, reason: "cooling_off" };
    }
  }

  // A row that does not exist yet is as repairable as one that says missing:
  // the ledger is a record of what provisioning did, and a clone provisioned
  // before this name was tracked has no row at all.
  return {
    act: true,
    why: facts.ledgerStatus === null ? "no ledger row yet" : `ledger says ${facts.ledgerStatus}`,
  };
}
