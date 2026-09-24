/**
 * THE LATERAL MEMBRANE — the boundary between the two parents, crossed both ways.
 *
 * Every membrane in `fleetMembranes.pure.ts` is VERTICAL: it sits on an edge
 * of the lineage tree and faces one way, from the prime (or a parent) down to
 * the deployment below it. The two parents have never had a boundary between
 * them at all, because nothing ever moved between them — each is fed by the
 * prime, and whatever either of them wrote for itself stayed where it was
 * written.
 *
 * That was measured, not assumed. On 23 Sep 2026 the two parents held 35
 * files between them that the prime does not:
 *
 *   npc-client-dashboard         14   reminders priority fix, backend-isolation
 *                                     tooling, a registry-prune workflow …
 *   npc-crm-independent-6505dc   21   16 of them the CRM routing layer, plus
 *                                     a native-CRM migration, a document, a
 *                                     spec and two scratch files
 *
 * Four of the 35 the prime's history once held, so they are the vertical
 * cascade's. Of the other 31, not one may cross under rules the fleet already
 * had, as a dry run of this lane at the real heads confirmed: the
 * CRM-independent parent's routing layer is what that deployment exists to
 * be, the dependent's clone-backend scripts name its own database by id, and
 * the rest is a migration, a spec whose subject the prime owns, or a file
 * outside the independent's installed modules. So on the day it shipped the
 * lane carried nothing. What it is for is the parent-level work written from
 * then on.
 *
 * The one piece a person might have wanted sideways, the dependent's
 * reminders fix, shows where this boundary stops. It edited two files the
 * prime owns, the next vertical cascade put both back the same day, and a
 * fix to a page every deployment serves belongs at the prime.
 * `docs/LATERAL_MEMBRANE.md` records the measurement.
 *
 * ## One boundary, two membranes
 *
 * A lateral boundary is not one membrane with a switch in it. It is the SAME
 * vocabulary as a vertical one — `IonChannel`, `StandingOrgan`, `permeate` —
 * declared once per direction, because what may enter a deployment is a fact
 * about the deployment being entered. The CRM distinction the vertical
 * membranes draw is therefore drawn here too, and from the same measurements:
 *
 *   · a ROUTED CRM NAME stays out of the independent's browser layer, exactly
 *     as `ROUTED_NAME_CLOSED` keeps it out on the prime→independent edge;
 *   · the independent's ROUTING LAYER stays out of the dependent, which holds
 *     no routing table and calls GoHighLevel directly.
 *
 * ## The difference from the vertical rulebook
 *
 * Two things, and only two.
 *
 * **What crosses is parent-level work and nothing else.** A vertical membrane
 * filters everything the prime has; this one carries only a file the PRIME'S
 * HISTORY HAS NEVER HELD. Anything the prime owns, or once owned, belongs to
 * the vertical cascade, which already decides it on both sides — carrying it
 * sideways as well would give one path two authors and a cascade that argued
 * with itself. The two lanes therefore write disjoint sets of paths by
 * construction, which is what lets them run without knowing about each other.
 *
 * **Direction is read, not declared.** Neither parent is upstream of the
 * other, so a file moves toward the side still holding the version the other
 * side left behind — read from each side's own history. Two sides that each
 * changed a file since they last agreed are held for a person; nothing here
 * merges two authors' work into one.
 *
 * Everything else is the existing rulebook: the destination's
 * `clone_sync_exclusions`, its module scope, `judgingWorkflowHold`, the
 * orphan-spec rule, the import rule, the deletion rules and the merge gate.
 * `lateralExchange.pure.ts` is where they run.
 *
 * ## Why this is in `src/lib`
 *
 * For the reason `fleetMembranes.pure.ts` gives: the diagram draws it, and a
 * route whose import chain reaches `src/server/**` for a value is refused by
 * the build. The only import here is a TYPE.
 */

import type { IonChannel, Membrane, StandingOrgan } from "./membrane.pure";

/** The CRM-dependent parent: a full mirror of the prime on GoHighLevel. */
export const CRM_DEPENDENT_PARENT = "npc-client-dashboard";

/** The CRM-independent parent: module-scoped, with its own CRM routing table. */
export const CRM_INDEPENDENT_PARENT = "npc-crm-independent-6505dc";

export type LateralBoundary = {
  /** The two repositories, joined in the order `sides` declares them. */
  id: string;
  /**
   * The row every exchange across this boundary is recorded against.
   *
   * `audit_log.entity_id` is a UUID column, so a boundary cannot be its own
   * key there; this is fixed rather than derived so the ledger survives a
   * repository rename. Nothing else reads it.
   */
  ledgerId: string;
  sides: readonly [string, string];
  label: string;
  /** Why this boundary exists and what it carries, in one paragraph. */
  rationale: string;
  /** The membrane a delivery INTO each side crosses, keyed by that side's repository. */
  toward: Readonly<Record<string, Membrane>>;
  /**
   * The organs the lateral lane runs beyond the channels, named here so the
   * boundary can be drawn whole. There are no pumps: nothing here rewrites a
   * file on its way across.
   */
  standing: readonly StandingOrgan[];
};

/**
 * What runs at this boundary besides the channels.
 *
 * Each `where` is where it really runs. The lateral-only organs are in
 * `lateralExchange.pure.ts`; the rest are the vertical cascade's own, called
 * rather than copied.
 */
const LATERAL_STANDING: readonly StandingOrgan[] = [
  {
    kind: "channel",
    name: "lateralOrigin",
    where: "lateralExchange.pure.ts",
    does:
      "Carries only a file the prime's history has never held. Anything the prime owns, or " +
      "once owned, belongs to the vertical cascade on both sides.",
  },
  {
    kind: "channel",
    name: "decideLateral",
    where: "lateralExchange.pure.ts",
    does:
      "Moves a file toward the side still holding the version the other left behind, as each " +
      "side's own history records it. A file both sides changed is held for a person, never merged.",
  },
  {
    kind: "channel",
    name: "clone_sync_exclusions",
    where: "partitionCascadePaths",
    does: "The destination's own per-path rules, applied exactly as the vertical cascade applies them.",
  },
  {
    kind: "channel",
    name: "globsForModuleScopedClone",
    where: "repositoryInvariants.pure.ts",
    does:
      "A module-scoped destination receives only what its installed modules and the repository " +
      "invariants cover. Anything else is reported, not written.",
  },
  {
    kind: "channel",
    name: "judgingWorkflowHold",
    where: "judgingWorkflow.pure.ts",
    does: "Refuses a workflow that judges the whole repository where the destination holds only part of one.",
  },
  {
    kind: "channel",
    name: "lateralImportHold",
    where: "lateralExchange.pure.ts",
    does:
      "Refuses a file whose import resolves where it was written and on neither the destination " +
      "nor this delivery — or names something the destination's copy does not export.",
  },
  {
    kind: "channel",
    name: "withholdReferencedDeletions",
    where: "deletionPropagation.pure.ts",
    does:
      "A deletion crosses only where the deleting side held the exact copy the other still has, " +
      "and never while a surviving file imports it.",
  },
  {
    kind: "channel",
    name: "decideCascadeMerge",
    where: "autoMergeGate.pure.ts",
    does: "Lands a proposal only once `verify` and `security` have passed on it.",
  },
];

/**
 * The orphan-spec channel, worded for a boundary that cannot carry a subject.
 *
 * Vertically a stranded subject is CARRIED in behind its spec. Sideways it
 * cannot be: the subjects a parent-level spec asserts about are, measured,
 * mostly files the prime owns (`src/App.tsx`, `supabase/config.toml`,
 * `src/integrations/supabase/env.ts`), and a file the prime owns is never
 * this lane's to move.
 */
const LATERAL_SPEC: IonChannel = {
  species: "spec",
  state: "gated",
  within: "**",
  reason: "manual_reconcile",
  note:
    "A spec crosses only with the subject it asserts about. This boundary carries only files the " +
    "prime has never held, so a subject the prime owns cannot come with it: the spec waits until " +
    "both parents hold the same copy of its subject, or a person brings the two across together.",
};

const EDGE_FUNCTION_CLOSED: IonChannel = {
  species: "edge_function",
  state: "closed",
  within: "**",
  reason: "protected",
  note:
    "A function's source is half of it. The other half is its declaration in " +
    "`supabase/config.toml` — the prime's file, never this boundary's — and its deployment into " +
    "this project by this deployment's own pipeline, so a directory carried alone is a function " +
    "that exists in the tree and nowhere else. Bring a function across with its declaration, by hand.",
};

const MIGRATION_CLOSED: IonChannel = {
  species: "migration",
  state: "closed",
  within: "**",
  reason: "protected",
  note:
    "A migration records one database's history and is applied by that deployment's own " +
    "pipeline. Written into the other parent it would run against a different tenant's schema " +
    "under a version its ledger never recorded. A schema both deployments need is authored once, " +
    "at the prime.",
};

const BACKEND_REF_CLOSED: IonChannel = {
  species: "backend_ref",
  state: "closed",
  within: "**",
  reason: "manual_reconcile",
  note:
    "Across this boundary a Supabase project is always another tenant's database, and a bare ref " +
    "handed to the Management API by a script acts on it exactly as a URL in a bundle does. Make " +
    "the file read its project from the deployment's own configuration, and it crosses.",
};

const HOSTING_REF_CLOSED: IonChannel = {
  species: "hosting_ref",
  state: "closed",
  within: "**",
  reason: "manual_reconcile",
  note:
    "Names a hosting project or team by id, so a workflow carrying it would act on the other " +
    "parent's deployments with this repository's credentials. Read the id from a repository " +
    "variable, and it crosses.",
};

/** Into the CRM-independent parent. */
const INTO_INDEPENDENT: readonly IonChannel[] = [
  {
    species: "routed_crm_name",
    state: "closed",
    within: "src/**",
    reason: "manual_reconcile",
    note:
      "This deployment routes its CRM through `crmFunction()` in `src/lib/crm/crmProvider.ts`, and " +
      "`crmIndependence.spec.ts` fails on a routed name spelled anywhere else. The GoHighLevel " +
      "parent calls those functions by name because it has no routing table — bring the change " +
      "across through `crmFunction()`.",
  },
  {
    species: "crm_routing_layer",
    state: "open",
    within: "**",
    reason: "protected",
    note:
      "The routing layer is this deployment's own architecture, so a file of it has nothing here " +
      "to contradict. The GoHighLevel parent holds none of it, so in practice nothing crosses this pore.",
  },
  EDGE_FUNCTION_CLOSED,
  MIGRATION_CLOSED,
  BACKEND_REF_CLOSED,
  HOSTING_REF_CLOSED,
  LATERAL_SPEC,
];

/**
 * Into the CRM-dependent parent.
 *
 * The routing layer is FIRST: `permeate` reports the first closed channel a
 * chunk trips, and a native `crm-*` function is both an edge function and the
 * routing layer. Held as the second, an operator would be told to bring it
 * across with its declaration — a remedy for a file that must never arrive.
 */
const INTO_DEPENDENT: readonly IonChannel[] = [
  {
    species: "crm_routing_layer",
    state: "closed",
    within: "**",
    reason: "protected",
    note:
      "This deployment's CRM is GoHighLevel and it holds no routing table. The CRM-independent " +
      "parent's router, adapters and native `crm-*` functions are what that deployment exists to " +
      "be; written here they would install a second CRM architecture beside the one this " +
      "deployment runs.",
  },
  {
    species: "routed_crm_name",
    state: "open",
    within: "src/**",
    reason: "manual_reconcile",
    note:
      "This deployment calls GoHighLevel directly and holds no routing table, so a function name " +
      "in the browser layer is an ordinary call — what this deployment is supposed to say.",
  },
  EDGE_FUNCTION_CLOSED,
  MIGRATION_CLOSED,
  BACKEND_REF_CLOSED,
  HOSTING_REF_CLOSED,
  LATERAL_SPEC,
];

export const FLEET_LATERALS: readonly LateralBoundary[] = [
  {
    id: `${CRM_DEPENDENT_PARENT}~${CRM_INDEPENDENT_PARENT}`,
    ledgerId: "c59eca15-f994-4d78-8325-015997c668d6",
    sides: [CRM_DEPENDENT_PARENT, CRM_INDEPENDENT_PARENT],
    label: "NPC Client Dashboard ⇄ NPC CRM Independent",
    rationale:
      "The two parents are siblings, not source and follower: each receives the prime through its " +
      "own membrane and writes work of its own on top. This boundary carries that parent-level " +
      "work — a file the prime's history has never held — in both directions, toward the side " +
      "still holding the version the other left behind. The CRM line the vertical membranes draw " +
      "holds here too: no routed name enters the independent's browser layer, and the " +
      "independent's routing layer never enters the dependent.",
    toward: {
      [CRM_INDEPENDENT_PARENT]: {
        from: CRM_DEPENDENT_PARENT,
        to: CRM_INDEPENDENT_PARENT,
        label: "NPC Client Dashboard → NPC CRM Independent",
        rationale:
          "Parent-level work of the GoHighLevel mirror, entering the deployment with a CRM of its " +
          "own. It arrives only through the routing table: a routed name in the browser layer is " +
          "refused exactly as it is on the prime's edge.",
        channels: INTO_INDEPENDENT,
        standing: LATERAL_STANDING,
      },
      [CRM_DEPENDENT_PARENT]: {
        from: CRM_INDEPENDENT_PARENT,
        to: CRM_DEPENDENT_PARENT,
        label: "NPC CRM Independent → NPC Client Dashboard",
        rationale:
          "Parent-level work of the CRM-independent deployment, entering a mirror that runs on " +
          "GoHighLevel. Everything that makes the sender CRM-independent stays behind; what is " +
          "left is ordinary work both deployments can use.",
        channels: INTO_DEPENDENT,
        standing: LATERAL_STANDING,
      },
    },
    standing: LATERAL_STANDING,
  },
];

/**
 * The membrane a lateral delivery from one repository into another crosses,
 * or null where no lateral boundary joins them.
 *
 * Null is not the vertical DEFAULT membrane on purpose. An unknown vertical
 * edge must behave as every edge did yesterday; an unknown LATERAL pair must
 * carry nothing at all, because nothing ever moved sideways before a
 * boundary was declared.
 */
export function lateralMembrane(from: string, to: string): Membrane | null {
  if (from === to) return null;
  for (const boundary of FLEET_LATERALS) {
    if (!boundary.sides.includes(from) || !boundary.sides.includes(to)) continue;
    return boundary.toward[to] ?? null;
  }
  return null;
}

/** Every lateral boundary a deployment sits on. Keyed by REPOSITORY, as a membrane is. */
export function lateralsTouching(repo: string): readonly LateralBoundary[] {
  return FLEET_LATERALS.filter((boundary) => boundary.sides.includes(repo));
}

/** The repository across a boundary from this one, or null if it is not a side. */
export function otherSide(boundary: LateralBoundary, repo: string): string | null {
  if (boundary.sides[0] === repo) return boundary.sides[1];
  if (boundary.sides[1] === repo) return boundary.sides[0];
  return null;
}
