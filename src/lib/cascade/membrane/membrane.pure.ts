/**
 * THE MEMBRANE — what a cascade boundary admits, and what it does not.
 *
 * A cascade has edges, not one gradient. Prime feeds two parents; one parent
 * feeds two children; and until this module the fleet had exactly one answer
 * for all four boundaries. Every selective organ the cascade owns is keyed on
 * the DOWNSTREAM clone alone (`clone_sync_exclusions`) or on nothing at all
 * (`REPOSITORY_INVARIANTS`, `backendIdentityHold`). There was no way to say
 * "this crosses into that clone and not into this one", which is the only
 * sentence that describes the fleet as it actually is.
 *
 * ## The organs that already exist
 *
 * This module does not replace them and must never grow a second vocabulary
 * for what they already decide. A refusal here is an ordinary `HeldPath` with
 * an ordinary `ExclusionReason`, and it lands in the same `partition.held` the
 * pull request already reports from.
 *
 *   CHANNELS, passive and selective — they decide whether a species crosses:
 *     · `partitionCascadePaths` over `clone_sync_exclusions`   (per path, per clone)
 *     · `REPOSITORY_INVARIANTS`                                 (per path, fleet-wide)
 *     · `backendIdentityHold`      — a shipped file naming a foreign project
 *     · `securityInventoryHold`    — a baseline describing a different tree
 *
 *   PUMPS, active — they move content AGAINST the gradient, delivering prime's
 *   file in a changed form with the clone's own content carried back into it:
 *     · `configTomlReconcile`      — prime's config with the clone's project_id restored
 *     · `securityRegistryReconcile`— prime's registry with the clone's own entries kept
 *     · `deployWorkflowReconcile`  — prime's workflow with the clone's refs kept
 *
 * Those three are genuinely active: a passive filter can only subtract, and
 * each of them ADDS something the upstream file did not contain. They are
 * named in `fleetMembranes.pure.ts` rather than re-implemented, because a
 * membrane an operator can only see half of is one they cannot reason about.
 *
 * ## What this module adds
 *
 * Two channels, each closing a defect measured on this fleet, and both keyed
 * on the EDGE rather than the clone:
 *
 *   · `routed_crm_name` — 49 files on the prime invoke a GoHighLevel edge
 *     function, 17 of them under `src/`. Into the CRM-DEPENDENT parent that is
 *     correct and the channel is open. Into the CRM-INDEPENDENT parent it is
 *     the thing that deployment exists not to do: its whole architecture is
 *     one routing table (`crmFunction()`), guarded by its own
 *     `crmIndependence.spec.ts`, and a cascade wrote the literals back over it
 *     — PR #7's work reverted by PR #9's cascade, measured still-breached on
 *     21 Sep 2026 with eight names across four files.
 *
 *   · `spec` with a stranded subject — a spec crosses while the file it
 *     asserts about does not, so prime's new assertions run against the
 *     clone's old code. Measured 21 Sep 2026: 21 specs from
 *     `src/lib/reports/__tests__/` arrived without `market-sales-ingest` or
 *     `SCORING_V2_METHODOLOGY.md`, and `verify` has been red since. The
 *     clone's own CLAUDE.md states the rule — *a spec and its subject travel
 *     together or neither does* — and nothing enforced it.
 *
 * ## Why the orphan-spec rule is a channel and not a pump
 *
 * The pump would be the companion PULL: admit the subject alongside the spec,
 * against the scope gradient, because the spec's arrival demands it. It was
 * measured before it was rejected. Those 21 specs name **176 distinct
 * repository paths** between them, so a pull would widen a deliberately
 * module-scoped clone by 176 files on one delivery, chosen by a regex over
 * string literals. Holding the spec leaves the clone internally consistent —
 * old spec, old subject, green — and leaves the widening to a person who can
 * mean it.
 *
 * The same reasoning refuses a pump for `routed_crm_name`. Rewriting
 * `'send-ghl-message'` into `crmFunction("sendMessage")` inside a `.tsx` file
 * means synthesising an import, and a wrong rewrite ships broken source to a
 * customer's deployment. The channel closes and its note names the permitted
 * form, which is what a prohibition owes: `crmFunction()` is where that name
 * is allowed to be spelled.
 */

import { globToRegex } from "@/lib/module-globs";
import type { ExclusionReason, HeldPath } from "@/server/cascade/syncExclusions.pure";
import {
  classify,
  isSpecPath,
  readingFor,
  type IonReading,
  type IonSpeciesName,
} from "./ionSpecies.pure";

/** A passive, selective pore. Open admits the species; closed refuses it. */
export type IonChannel = {
  species: IonSpeciesName;
  /**
   * `open` admits the species, `closed` refuses it, and `gated` means the
   * answer depends on the delivery rather than on the species alone — the
   * orphan-spec rule cannot be settled by looking at one file, so `permeate`
   * declines to guess and `strandedSubjects` decides with the trees in hand.
   * A gated channel is still drawn, because a boundary an operator can only
   * see part of is one they cannot reason about.
   */
  state: "open" | "closed" | "gated";
  /** A glob bounding where the channel has an opinion. `**` is everywhere. */
  within: string;
  /** The reason a refusal carries, in the vocabulary the cascade already has. */
  reason: ExclusionReason;
  /**
   * What a person reading the held row is told. A closed channel must name
   * the PERMITTED form, not only the prohibition — a rule with no demonstrated
   * alternative is one somebody routes around.
   */
  note: string;
};

/**
 * An organ that lives elsewhere, named here so the boundary can be described
 * whole. Nothing in this module executes one; `where` is where it really runs.
 */
export type StandingOrgan = {
  kind: "channel" | "pump";
  name: string;
  where: string;
  does: string;
};

export type Membrane = {
  /** The upstream side: `"prime"` or a clone slug. */
  from: string;
  /** The downstream side: a clone slug. */
  to: string;
  label: string;
  /** Why this boundary is shaped the way it is, in one paragraph. */
  rationale: string;
  channels: readonly IonChannel[];
  standing: readonly StandingOrgan[];
};

export type PermeationVerdict =
  | { kind: "crosses"; readings: IonReading[] }
  | { kind: "blocked"; held: HeldPath; readings: IonReading[] };

/**
 * What the boundary does with one crossing chunk.
 *
 * `text` is null for a binary file, and a binary file is never blocked here:
 * every species this module refuses is a statement about source.
 */
export function permeate(
  membrane: Membrane,
  chunk: { path: string; text: string | null },
): PermeationVerdict {
  const readings = classify(chunk);

  for (const channel of membrane.channels) {
    if (channel.state !== "closed") continue;
    if (!globToRegex(channel.within).test(chunk.path)) continue;
    const reading = readingFor(readings, channel.species);
    if (!reading) continue;
    return {
      kind: "blocked",
      readings,
      held: {
        path: chunk.path,
        pattern: `(membrane: ${membrane.from}→${membrane.to} · ${channel.species} channel closed)`,
        reason: channel.reason,
        note: `${reading.evidence}. ${channel.note}`,
      },
    };
  }

  return { kind: "crosses", readings };
}

/**
 * The repository paths a spec asserts about.
 *
 * Read from the literal path strings a spec contains, which is how every
 * orphaned spec measured here names its subject — `readFileSync(join(ROOT,
 * 'supabase/migrations/…'))`, a heading pinned against `docs/reports/…`.
 *
 * Deliberately narrow. Only a literal beginning at a known top-level
 * directory AND carrying a file extension counts: `scripts/template-library`
 * is a directory the specs also mention, and treating it as a subject would
 * strand a spec on a path no delivery ever carries as one file.
 */
export function subjectsNamedBy(text: string): string[] {
  const found = new Set<string>();

  // One quoted literal: `readFileSync("src/lib/a.ts")`.
  const whole = /['"`]((?:src|supabase|docs|scripts|public)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)['"`]/g;
  for (const m of text.matchAll(whole)) found.add(m[1]);

  // The SEGMENT form: `readFileSync(join(ROOT, "docs", "reports", "X.md"))`.
  //
  // Measured over the prime's 1,431 spec files on 21 Sep 2026: 18 of them
  // name their subject ONLY this way, 47 subjects between them, and the whole
  // -literal rule above returns `[]` for every one. The live case is the
  // incident's own — `scoringMethodology.spec.ts` reads
  // `docs/reports/SCORING_V2_METHODOLOGY.md`, which prime holds at version
  // 3.0.0 and `npc-crm-independent-6505dc` at 2.1.0 — so the channel was
  // blind to an instance of the exact failure it exists to refuse.
  //
  // Anchored on a known root, so a relative `join(__dirname, "..", "a.ts")`
  // matches nothing, and the last segment must carry an extension, so a
  // directory walk does not become a subject.
  const segmented =
    /['"`](src|supabase|docs|scripts|public)['"`]((?:\s*,\s*['"`][A-Za-z0-9_.-]+['"`])+)/g;
  for (const m of text.matchAll(segmented)) {
    const tail = [...m[2].matchAll(/['"`]([A-Za-z0-9_.-]+)['"`]/g)].map((x) => x[1]);
    if (tail.length === 0) continue;
    const last = tail[tail.length - 1];
    if (!/\.[A-Za-z0-9]+$/.test(last)) continue;
    found.add([m[1], ...tail].join("/"));
  }

  return [...found].sort();
}

/**
 * Whether a spec is arriving without the subject it asserts about.
 *
 * A subject strands a spec only when all three are true:
 *   1. prime and the clone hold DIFFERENT copies of it — an unchanged subject
 *      cannot contradict an updated spec;
 *   2. this delivery is not carrying it — otherwise they travel together,
 *      which is the whole rule; and
 *   3. the clone HAS it — a subject the clone never had is a different
 *      defect (a spec for a feature that is not installed), and holding the
 *      spec for it would be a guess about scope.
 *
 * Returns the stranded subjects, sorted. Empty means the spec may cross.
 */
export function strandedSubjects(args: {
  specPath: string;
  specText: string;
  /** Prime's blob sha by path, or null when the tree could not be listed. */
  primeSha: ReadonlyMap<string, string> | null;
  /** The clone's blob sha by path, or null when the tree could not be listed. */
  cloneSha: ReadonlyMap<string, string> | null;
  /** Every path this delivery is writing. */
  crossing: ReadonlySet<string>;
}): string[] {
  const { specPath, specText, primeSha, cloneSha, crossing } = args;
  if (!isSpecPath(specPath)) return [];
  // A tree that could not be listed is not a tree with nothing in it. With no
  // evidence about what differs, the conservative answer is to change nothing.
  if (!primeSha || !cloneSha) return [];

  return subjectsNamedBy(specText).filter((subject) => {
    // Crossing beside it. Nothing is stranded.
    if (crossing.has(subject)) return false;

    // NOT on the clone at all — out of its module scope, and deliberately not
    // stranded. The 20 Sep evidence is the stale case in its own words: "Both
    // subjects EXIST on the clone, at their older versions." Extending to the
    // absent case would hold a spec FOREVER, with no act an operator can
    // perform: widening a clone's scope is a configuration decision with its
    // own review, and a contract test names repository paths as DATA — those
    // 21 specs name 176 distinct paths between them, so nearly every spec in
    // the fleet would become a permanent hold. A channel whose refusals
    // cannot be discharged is the stall this module exists to prevent.
    const onClone = cloneSha.get(subject);
    if (onClone === undefined) return false;

    // Named but not in prime's tree either — a path that has moved or a
    // string this reader took for a path. Prime states nothing about it, so
    // neither does this.
    const onPrime = primeSha.get(subject);
    if (onPrime === undefined) return false;

    // Held only where the clone's copy is genuinely behind: the spec would
    // assert prime's new properties against this repository's older file.
    return onPrime !== onClone;
  });
}

/** The held row for a spec whose subjects were left behind. */
export function orphanSpecHold(args: {
  membrane: Membrane;
  specPath: string;
  stranded: readonly string[];
}): HeldPath {
  const { membrane, specPath, stranded } = args;
  const named = stranded.slice(0, 3).join(", ");
  const more = stranded.length > 3 ? ` (and ${stranded.length - 3} more)` : "";
  return {
    path: specPath,
    pattern: `(membrane: ${membrane.from}→${membrane.to} · spec channel gated on its subject)`,
    reason: "manual_reconcile",
    note:
      `This spec asserts about ${stranded.length} file(s) this delivery is not carrying and which ` +
      `differ upstream: ${named}${more}. Delivered alone it would assert the prime's new ` +
      `properties against this repository's older copies. A spec and its subject travel together ` +
      `or neither does — bring the subject into this clone's scope, or leave both.`,
  };
}
