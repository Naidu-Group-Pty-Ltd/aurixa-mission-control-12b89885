/**
 * Where one clone's Anthropic attribution stands — decided in ONE place.
 *
 * ## Why this module exists at all
 *
 * The question "is this clone's model spend landing on its own workspace?" was
 * answered independently in five places, and six review rounds were spent
 * finding them one at a time. Every one of those findings had the same shape:
 * a repair moved the dependency and left a copy of the old dependency behind.
 *
 *   - readiness counted identity ROWS, which is true of a clone that never
 *     received anything;
 *   - corrected to `delivered_at`, which is false for a federated clone that
 *     needs no delivery;
 *   - the clone card blocked FEDERATION on delivery, which `federateClone`
 *     does not require;
 *   - the card called a clone federated on a rule alone, which is stamped
 *     before the key is withdrawn;
 *   - and the card told an operator a cleared stamp meant "never written",
 *     when the correction that cleared it could not tell the two apart.
 *
 * Each was fixed where it was found. That is why there were five: the concept
 * had no home, so a fix could only ever be local. It has one now, and a
 * consumer that asks a different question is a visible edit to this file
 * rather than a private opinion in a component.
 *
 * ## The two routes, and why neither is "the" answer
 *
 * A clone's spend reaches its own workspace by either:
 *
 *  - **delivery** — `ANTHROPIC_WORKSPACE_ID` was written onto its project, and
 *    the prime sends it as the `anthropic-workspace-id` header; or
 *  - **federation** — `ensureRule` binds the token to `workspace_id` AT THE
 *    VENDOR, so the workspace is named by the credential itself and no header
 *    is needed.
 *
 * Either settles it. Requiring both reports a working clone as broken;
 * requiring only the first is what round eight caught.
 *
 * ## The rule that keeps biting
 *
 * **Federation is COMPLETE only when the key ledger says `federated`.**
 * `federateClone` stamps `federated_at` and `federation_rule_id` and THEN
 * calls `withdrawAnthropicKey`, which is what writes the status. A clone whose
 * federation stopped between those two carries a rule, an issuer, a service
 * account and a timestamp — everything except the fact. Reading any of them as
 * completion is the same error in a new place.
 *
 * Pure: no network, no database, no Node globals.
 */

/** The ledger status a clone carries once it reaches Anthropic by federation. */
export const FEDERATED_STATUS = "federated";

/** A person took the credential off. Never undone on a schedule. */
export const WITHHELD_STATUS = "withheld";

/** The tenant brought its own key, so nothing here is billed to the prime. */
export const TENANT_SUPPLIED_STATUS = "set";

/**
 * The raw facts, exactly as the two tables hold them.
 *
 * Every field is what a column contains, never a judgement about it — the
 * judgements are the functions below, so a caller cannot form half of one.
 */
export interface AnthropicIdentityFacts {
  /** `clone_anthropic_identity.workspace_id` — recorded at the vendor. */
  readonly workspaceId: string | null;
  /** `clone_anthropic_identity.delivered_at` — id written onto the project. */
  readonly deliveredAt: string | null;
  /** `clone_anthropic_identity.federation_rule_id`. */
  readonly federationRuleId: string | null;
  /** `clone_backend_secrets.status` for `ANTHROPIC_API_KEY`, or null. */
  readonly anthropicKeyStatus: string | null;
}

/*
 * Each predicate takes only the facts it actually reads.
 *
 * Not a style choice. A caller holding two of the four facts had to invent
 * `null` for the others to satisfy one wide parameter — `decideWorkspaceProvision`
 * has no federation rule, `decideFederation` has no delivery stamp, a
 * stand-down is decided by the key alone — and an invented `null` is a caller
 * asserting something it does not know. That is the shape of every finding
 * this module exists to end, so the types refuse it: a narrow parameter cannot
 * be satisfied by guessing, and `AnthropicIdentityFacts` still satisfies all
 * of them structurally for a caller that holds everything.
 */

/** What `deliveryPending` / `delivered` / `workspaceRecorded` read. */
export type DeliveryFacts = Pick<AnthropicIdentityFacts, "workspaceId" | "deliveredAt">;

/** What `federationComplete` reads. */
export type FederationFacts = Pick<
  AnthropicIdentityFacts,
  "federationRuleId" | "anthropicKeyStatus"
>;

/** What `standsDown` reads. */
export type KeyStatusFacts = Pick<AnthropicIdentityFacts, "anthropicKeyStatus">;

/**
 * One reading, ordered from nothing to settled.
 *
 * `recorded` is deliberately its own state rather than a kind of absence: a
 * workspace exists at the vendor, this clone is the only thing attributed to
 * it, and what is missing is one idempotent write.
 */
export type AttributionState = "none" | "recorded" | "delivered" | "federated";

/** A workspace exists at the vendor for this clone. */
export function workspaceRecorded(f: DeliveryFacts): boolean {
  return Boolean(f.workspaceId);
}

/**
 * A workspace is recorded and its id has not reached the project.
 *
 * This is the retry's precondition. It needs no Anthropic credential — the
 * delivery step reuses the recorded id rather than asking the vendor again —
 * which is why `decideWorkspaceProvision` lets it past the admin-key gate.
 */
export function deliveryPending(f: DeliveryFacts): boolean {
  return workspaceRecorded(f) && !f.deliveredAt;
}

/** The id reached the project, so the header names the workspace. */
export function delivered(f: DeliveryFacts): boolean {
  return workspaceRecorded(f) && Boolean(f.deliveredAt);
}

/**
 * Federation FINISHED — rule recorded and the key gone.
 *
 * Both halves, never either: the status alone would credit a ledger row with
 * no rule behind it, and the rule alone is stamped before the key is
 * withdrawn.
 */
export function federationComplete(f: FederationFacts): boolean {
  return Boolean(f.federationRuleId) && f.anthropicKeyStatus === FEDERATED_STATUS;
}

/**
 * The clone's spend lands on its own workspace, by either route.
 *
 * This is the only question a coverage count may ask.
 */
export function isAttributed(f: AnthropicIdentityFacts): boolean {
  return delivered(f) || federationComplete(f);
}

/** The single reading, for a surface that must render one. */
export function attributionOf(f: AnthropicIdentityFacts): AttributionState {
  if (federationComplete(f)) return "federated";
  if (delivered(f)) return "delivered";
  if (workspaceRecorded(f)) return "recorded";
  return "none";
}

/**
 * A clone that should never carry a workspace of ours.
 *
 * A tenant's own key is bound to THEIR organisation, where a workspace we
 * created does not exist; a withheld key is somebody's decision. Both leave
 * the coverage denominator rather than failing it — counting them makes the
 * check permanently false on a healthy fleet.
 */
export function standsDown(f: KeyStatusFacts): boolean {
  return (
    f.anthropicKeyStatus === TENANT_SUPPLIED_STATUS || f.anthropicKeyStatus === WITHHELD_STATUS
  );
}
