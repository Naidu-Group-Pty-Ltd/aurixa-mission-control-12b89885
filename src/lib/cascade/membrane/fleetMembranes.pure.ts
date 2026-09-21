/**
 * THE FLEET'S MEMBRANES — one per edge, as code.
 *
 * Code rather than rows, for the reason `CLONE_PROVISIONING_GAPS.md` already
 * paid for: provisioning copies a clone's schema and its migration LEDGER but
 * not the rows a migration INSERTs, so anything seeded by one is absent on
 * every clone while looking, from the ledger, exactly like it is present.
 * `canonicalRegistry.generated.ts` and `REPOSITORY_INVARIANTS` are both here
 * for that reason and this belongs beside them. A membrane that silently
 * resolved to "admit everything" on a deployment nobody had seeded is the
 * failure this whole module exists to prevent.
 *
 * ## The CRM distinction is measured, not declared
 *
 * Mission Control's `clones` row records no CRM provider. `tags` is `[]` on
 * both parents and `entitled_module_slugs` is `[]` on the CRM-independent one,
 * so nothing in the database can answer the question this membrane turns on.
 * It is therefore recorded here WITH ITS EVIDENCE, measured 21 Sep 2026 by
 * reading the two repositories:
 *
 *   npc-client-dashboard         0 `crm-*` functions · 37 `ghl-*` · no crmProvider module
 *   npc-crm-independent-6505dc   3 `crm-*` functions · 37 `ghl-*` · crmProvider routing table
 *
 * Both hold the GoHighLevel edge functions. That is not the difference, and
 * reading it as one is how this gets built wrong: the CRM-independent
 * deployment keeps all 37 and routes to them when `CRM_PROVIDER=ghl`. What it
 * does not permit is a ROUTED name spelled outside `crmFunction()`, which is
 * the whole routing table. So the channel is closed `within: "src/**"` and
 * open everywhere else.
 *
 * ## The channel mirrors the clone's own guard, and does not improve on it
 *
 * `src/lib/crm/__tests__/crmIndependence.spec.ts` on that clone is the
 * AUTHORITY — it is what actually turns its CI red — and
 * `ROUTED_CRM_FUNCTION_NAMES` is transcribed from it rather than composed
 * here. Six names, both columns of the routing table, plus the switch itself;
 * the router and every test exempt by rule.
 *
 * The first version of this channel was wider: 24 GoHighLevel names, no
 * exemptions, backticks matched. Measured against the live clone on 21 Sep
 * 2026, that would have held `ClientConversationsTab.tsx` on every pass —
 * a file whose CI is GREEN, because `'ghl-conversations'` and `'ghl-messages'`
 * there are React Query cache keys (`queryKey: ['ghl-messages', …]`) that
 * reach no network at all. It would also have held `crmProvider.ts` itself,
 * which is the one file a provider change has to deliver.
 *
 * Divergence has a direction and only one direction is cheap. NARROWER than
 * the authority lets a file cross that turns the clone's CI red — loudly, on
 * the clone, with the path named. WIDER holds a file the clone would have
 * accepted, on a fleet whose signature failure is stalling for reasons nobody
 * stated. So this mirrors, and `membrane.test.ts` pins the list, the two
 * exemptions and the quoting rather than trusting them.
 *
 * ## Why this is in `src/lib` and not in `src/server`
 *
 * Because the DIAGRAM reads it. TanStack Start's import-protection plugin
 * refuses a route whose chain reaches `src/server/**` for a VALUE, and it is
 * right to: a module under that root is allowed to grow an I/O dependency
 * tomorrow, and the boundary is the path rather than the current contents.
 * `tsc` cannot see the rule — it passed clean while `vite build` refused —
 * so the position is load-bearing rather than tidy. A type-only import of a
 * server module still erases and is still permitted, which is how
 * `membrane.pure.ts` reaches the engine's `HeldPath` vocabulary from here.
 *
 * The three modules under this directory are pure in the strict sense: no
 * clock, no network, no filesystem, and exactly one dependency between them
 * (`globToRegex`, itself client-safe and marked so in its own header).
 *
 * ## Layering
 *
 * A membrane is per EDGE, so an ion that crossed prime→parent is asked again
 * at parent→child. `npc-test-76b3b3` and `preflight-property-group` descend
 * from the CRM-dependent parent and inherit its openness; nothing reaches them
 * that did not first pass the boundary above.
 */

import type { Membrane, StandingOrgan } from "./membrane.pure";

/**
 * The prime's repository, which is the upstream side of the fleet's root edges.
 *
 * A membrane is keyed by REPOSITORY NAME rather than by clone slug, because
 * repository names are what `processClone` actually holds on both sides —
 * `primeRef.repo` upstream (already the PARENT'S repo for a lineage-routed
 * child) and `clone.github_repo` downstream. A slug would have to be threaded
 * through an argument that does not carry one today, and a key the engine
 * cannot supply is a membrane that never resolves.
 */
export const PRIME_REPO = "npc-property-dashbord";

/**
 * The organs that already run, named on every membrane.
 *
 * They are not executed from here — each runs where it always has — but a
 * boundary described without them is a boundary described wrongly, and the
 * operator surface draws this list.
 */
const STANDING: readonly StandingOrgan[] = [
  {
    kind: "channel",
    name: "clone_sync_exclusions",
    where: "partitionCascadePaths",
    does: "Per-path rules recorded against this clone. `protected` never crosses; `manual_reconcile` waits for a person.",
  },
  {
    kind: "channel",
    name: "REPOSITORY_INVARIANTS",
    where: "repositoryInvariants.pure.ts",
    does: "Thirteen fleet-wide patterns a module may not own, because the repository's own CI reads them.",
  },
  {
    kind: "channel",
    name: "backendIdentityHold",
    where: "syncExclusions.pure.ts",
    does: "Refuses a shipped file naming a Supabase project that is not this deployment's.",
  },
  {
    kind: "channel",
    name: "securityInventoryHold",
    where: "securityInventoryHold.pure.ts",
    does: "Refuses the prime's security baseline where this clone holds edge functions the prime does not.",
  },
  {
    kind: "channel",
    name: "judgingWorkflowHold",
    where: "judgingWorkflow.pure.ts",
    does: "Refuses a workflow that judges the whole repository where this clone receives only part of one.",
  },
  {
    kind: "channel",
    name: "withholdReferencedDeletions",
    where: "deletionPropagation.pure.ts",
    does: "Refuses a deletion while a surviving file still imports what it would remove.",
  },
  {
    kind: "pump",
    name: "reconcileConfigToml",
    where: "configTomlReconcile.pure.ts",
    does: "Delivers the prime's config with this clone's own `project_id` and its own function declarations carried back in.",
  },
  {
    kind: "pump",
    name: "reconcileSecurityRegistry",
    where: "securityRegistryReconcile.pure.ts",
    does: "Delivers the prime's registry with this clone's own function entries kept.",
  },
  {
    kind: "pump",
    name: "reconcileDeployWorkflow",
    where: "deployWorkflowReconcile.pure.ts",
    does: "Delivers the prime's deploy workflow with this clone's own project references kept.",
  },
];

/**
 * The orphan-spec channel. Identical on every membrane — it is a statement
 * about consistency, not about any one deployment — and `gated` because one
 * file cannot settle it.
 */
/**
 * The one channel whose answer is not a property of the file in front of it.
 *
 * `permeate` therefore declines to guess on it — a `gated` channel is skipped
 * there — and the engine settles it once over the FINISHED delivery, where
 * `strandedSubjects` can compare the two trees.
 *
 * It resolves by CARRYING. A spec and its subject travel together or neither
 * does, and bringing both satisfies that as well as leaving both — better, on
 * a clone that already holds the subject and is merely behind on it, which is
 * every one of the fleet's measured 176. Anything carried in is judged by the
 * same `prepareOne` every other write goes through, and a subject an existing
 * rule holds is never released by being named.
 */
const SPEC_CHANNEL = {
  species: "spec" as const,
  state: "gated" as const,
  within: "**",
  reason: "manual_reconcile" as const,
  note:
    "A spec crosses only with the subject it asserts about, so this delivery carries the subject " +
    "in behind it — judged by the same rules as any other file, and never releasing one another " +
    "rule holds. Where a subject cannot travel, both stay, and the hold names which rule stopped it.",
};

/** A routed CRM name may be spelled anywhere in the browser layer. */
const ROUTED_NAME_OPEN = {
  species: "routed_crm_name" as const,
  state: "open" as const,
  within: "src/**",
  reason: "manual_reconcile" as const,
  note:
    "This deployment's CRM is GoHighLevel and it holds no routing table, so a function name in " +
    "the browser layer is an ordinary call and is what this deployment is supposed to say.",
};

/** It may not. */
const ROUTED_NAME_CLOSED = {
  species: "routed_crm_name" as const,
  state: "closed" as const,
  within: "src/**",
  reason: "manual_reconcile" as const,
  note:
    "This deployment routes its CRM through `crmFunction()` in `src/lib/crm/crmProvider.ts`, which " +
    "is the one place an edge function name may be spelled — `crmIndependence.spec.ts` fails on any " +
    "other. A cascade wrote these literals back over that work once already (PR #7, reverted by the " +
    "cascade in PR #9). Bring the change across through the routing table.",
};

export const FLEET_MEMBRANES: readonly Membrane[] = [
  {
    from: PRIME_REPO,
    to: "npc-client-dashboard",
    label: "Prime → NPC Client Dashboard",
    rationale:
      "A full mirror on GoHighLevel. It holds no `crm-*` function and no provider routing table, so " +
      "a GoHighLevel name in the browser layer is what this deployment is supposed to say.",
    channels: [ROUTED_NAME_OPEN, SPEC_CHANNEL],
    standing: STANDING,
  },
  {
    from: PRIME_REPO,
    to: "npc-crm-independent-6505dc",
    label: "Prime → NPC CRM Independent",
    rationale:
      "The one deployment with a CRM of its own: three `crm-*` edge functions and a routing table the " +
      "browser layer must go through. It keeps all 37 GoHighLevel functions and calls them when " +
      "configured to — what it refuses is a name spelled outside `crmFunction()`.",
    channels: [ROUTED_NAME_CLOSED, SPEC_CHANNEL],
    standing: STANDING,
  },
  {
    from: "npc-client-dashboard",
    to: "npc-test-76b3b3",
    label: "NPC Client Dashboard → NPC Test",
    rationale:
      "A mirror of a mirror. Nothing reaches it that did not first cross the boundary above, and it " +
      "inherits that parent's CRM.",
    channels: [ROUTED_NAME_OPEN, SPEC_CHANNEL],
    standing: STANDING,
  },
  {
    from: "npc-client-dashboard",
    to: "preflight-property-group",
    label: "NPC Client Dashboard → Preflight Property Group",
    rationale:
      "As above: a mirror descending from the GoHighLevel parent, carrying that parent's CRM with it.",
    channels: [ROUTED_NAME_OPEN, SPEC_CHANNEL],
    standing: STANDING,
  },
];

/**
 * The boundary between two deployments.
 *
 * An edge nothing describes gets the DEFAULT membrane — the standing organs
 * and the orphan-spec rule, with no opinion about any species this fleet has
 * not measured on it. It is deliberately not a refusal: a clone provisioned
 * tomorrow must behave exactly as every clone behaved yesterday, and a
 * membrane that closed on an unknown edge would stop the fleet rather than
 * filter it.
 */
export function resolveMembrane(from: string, to: string): Membrane {
  const found = FLEET_MEMBRANES.find((m) => m.from === from && m.to === to);
  if (found) return found;
  return {
    from,
    to,
    label: `${from} → ${to}`,
    rationale:
      "No membrane is recorded for this edge, so it carries the standing organs and nothing more. " +
      "Selectivity beyond them is only ever added from a measured defect.",
    channels: [SPEC_CHANNEL],
    standing: STANDING,
  };
}

/** Every membrane that touches a deployment, in and out. */
/**
 * The membrane a DELIVERY to this repository crosses.
 *
 * Keyed on the destination, which is the only identifier every caller
 * reliably holds. `processClone` used to ask `resolveMembrane(primeRef.repo,
 * …)`, and that is right on the live cascade — `primeRef` is already the
 * PARENT'S repository for a clone routed by lineage — and wrong on the two
 * other callers, which build `primeRef` straight from `prime.github_*` and
 * resolve no lineage at all:
 *
 *   cascade-dryrun.server.ts:132   { owner: prime.github_owner, repo: prime.github_repo, … }
 *   cascade-engine.server.ts:1213  regenerateCloneProposal, same shape
 *
 * With lineage on (migration `20260920140000_switch_cascade_lineage_on.sql`),
 * `npc-test-76b3b3` and `preflight-property-group` are parented under
 * `npc-client-dashboard`, so those two callers resolved the PRIME→child edge
 * — which this fleet does not have — and fell through to the default
 * membrane. Behaviourally that is the same today, because the parent→child
 * membranes close nothing the default leaves open. What it does NOW is print
 * an edge that does not exist: `orphanSpecHold` interpolates
 * `${from}→${to}` into the held row's `pattern`, and the repair path
 * persists that row.
 *
 * Asking the DESTINATION removes the question from the caller. A repository
 * the registry does not describe falls back to the caller's own reading,
 * which is the default membrane — never a refusal, for the reason the
 * fallback exists at all.
 */
export function membraneInto(repo: string, fallbackFrom: string): Membrane {
  return membranesTouching(repo).inbound ?? resolveMembrane(fallbackFrom, repo);
}

export function membranesTouching(repo: string): {
  inbound: Membrane | null;
  outbound: readonly Membrane[];
} {
  // `repo`, not `slug`. A membrane is keyed by REPOSITORY NAME for the reason
  // the header gives — it is what `processClone` holds on both sides — and a
  // parameter named for the other identifier is how a caller comes to pass
  // one. The prime has no inbound edge; a leaf has no outbound ones, and both
  // of those are states this reads correctly rather than absences it hides.
  return {
    inbound: FLEET_MEMBRANES.find((m) => m.to === repo) ?? null,
    outbound: FLEET_MEMBRANES.filter((m) => m.from === repo),
  };
}
