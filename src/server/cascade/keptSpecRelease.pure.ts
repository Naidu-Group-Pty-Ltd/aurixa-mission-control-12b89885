/**
 * A SPEC THE INDEPENDENT LINE KEEPS, LEFT BEHIND BY THE FILE IT TESTS.
 *
 * ## What it cost
 *
 * The independent CRM line keeps `src/lib/agent/__tests__/**` whole
 * (`CRM_LINE_KEPT_PATTERNS`, the owner's decision of 28 Oct 2026 for D15),
 * because prime's agent specs import `src/lib/agent/parityRegister.ts`, which
 * the line's head removed (b2809b77), so delivered they would fail to load:
 * D15 recorded 115 of them, and at prime@f0c9a35 100 of the 182 spec files
 * there import it directly. A kept spec is held `protected`, and the
 * left-behind half of the spec channel (`specsLeftBehind.pure.ts`) passed over
 * every spec a rule already held.
 *
 * Measured on cascade PR #160 to `npc-crm-independent-6505dc` (prime@6000690,
 * 30 Oct 2026): prime@33816f9 changed `supabase/functions/agent-speech/index.ts`
 * and `supabase/functions/_shared/voice/transcriptQuality.pure.ts` together
 * with `aurixaVoice.spec.ts` and `transcriptQuality.spec.ts`. The two files
 * crossed; the line's specs stayed at prime@040e0ae's and prime@6c2180a's
 * text, byte for byte; `verify (platform, build and agent)` failed three
 * assertions; and the proposal said nothing about either spec, because a
 * protected hold is withheld without comment. Neither spec imports
 * `parityRegister.ts`. The drain merges no red proposal, so 165 files waited
 * on two specs nobody had been told about.
 *
 * ## The rule
 *
 * A kept spec that a crossing file leaves behind is judged by the left-behind
 * channel like any other, with one more condition:
 *
 *   · it may travel only where prime's copy needs nothing the line will not
 *     have once this delivery lands — every module it imports and every file
 *     it names (`whatKeptSpecLacks`). A copy that imports `parityRegister.ts`
 *     lacks it and stays the line's, which is the decision D15 recorded;
 *   · and then only on the channel's own terms: prime's history shows the
 *     line's copy is a version prime held, or an operator approved prime's
 *     copy for the path. A spec the line edited, with no approval, is held for
 *     a person with the left-behind note, naming the file that crossed — and
 *     that approval is one the next pass honours, so it is never a dead button;
 *   · a kept spec whose prime copy lacks something is never offered for
 *     approval. Its hold stays `protected`, as D15 made it, because approving
 *     prime's copy there would ship a spec that cannot load. It is listed
 *     instead (`describeKeptSpecsLeftBehind`), with what it lacks and what
 *     crossed, so a proposal that goes red says why.
 *
 * Nothing changes for a kept spec no crossing file leaves behind: the tree
 * stays the line's, silently, exactly as D15 set it.
 *
 * ## Replayed
 *
 * The PR #160 pass, replayed (`cascadePassReplay.test.ts`) at prime@f0c9a35
 * against the line before the merge (ba33d8e9). On this rule the proposal
 * carries `aurixaVoice.spec.ts` and `transcriptQuality.spec.ts` at prime's
 * blobs, which are the bytes the hand fix carried (842b6efd). It also carries
 * `workTrace.spec.ts`, on the evidence that the line's copies were versions
 * prime held. It holds `forwardsThePerson.spec.ts` for a person, because the
 * line's copy is none of prime's last ten versions. And it lists thirteen
 * that stay: twelve for `parityRegister.ts`, and one for
 * `supabase/functions/ghl-calendar/index.ts`, which the line does not carry.
 * Before this rule the same pass named none of those seventeen specs.
 *
 * ## Not built: holding the code a kept spec tests
 *
 * The other way to keep a spec and its subject together is to hold the
 * subject when the spec cannot travel. Measured at prime@f0c9a35, the 100
 * specs that import `parityRegister.ts` name or import 674 other files between
 * them (362 under `src/`, 309 under `supabase/`; a median of 14 each). That
 * rule would hold most of what the line receives for as long as
 * `parityRegister.ts` stays off it, which is for good. Such a spec is listed
 * instead, and the line's copy is updated on the line.
 */
import { subjectsNamedBy } from "@/lib/cascade/membrane/membrane.pure";
import { importsOf, resolveSpecifier, type TreeIndex } from "./importClosure.pure";
import { CRM_LINE_KEPT_HOLD_PREFIX, type HeldPath } from "./syncExclusions.pure";

/** Whether a hold is the line's kept-tree hold (`partitionCascadePaths`). */
export function isCrmLineKeptHold(hold: Pick<HeldPath, "pattern">): boolean {
  return hold.pattern.startsWith(CRM_LINE_KEPT_HOLD_PREFIX);
}

/**
 * The clone's tree as a delivery leaves it: what it holds, plus what the
 * delivery writes, less what it removes. Built once per question, not per
 * spec — a mirror's tree is twelve thousand paths.
 */
export function treeAfterDelivery(args: {
  clone: TreeIndex;
  writes: Iterable<string>;
  removes: ReadonlySet<string>;
}): TreeIndex {
  const out = new Map<string, string>();
  for (const [path, sha] of args.clone) if (!args.removes.has(path)) out.set(path, sha);
  for (const path of args.writes) {
    if (!args.removes.has(path) && !out.has(path)) out.set(path, "(written by this delivery)");
  }
  return out;
}

/**
 * What prime's copy of a kept spec needs that the clone will not have: each
 * relative or `@/` import that resolves in prime's tree and not in the
 * clone's, named by the path it resolves to in prime, and each repository
 * file it names that prime holds and the clone will not. Sorted, each once.
 * `[]` means prime's copy can run on the line.
 *
 * The same two readers the channel already trusts — the import closure's
 * (`importsOf`, `resolveSpecifier`) and the membrane's (`subjectsNamedBy`) — so
 * "what this spec needs" means one thing everywhere in the cascade.
 *
 * Only what PRIME holds counts. Both readers read more than a spec loads: a
 * spec that asserts about an import line holds it as text
 * (`toContain("from '../../../supabase/…/schedule.pure.ts';")`), and read
 * from the spec's own directory that is `src/supabase/…`, which no tree has.
 * Replayed on cascade PR #160, five of the thirteen kept specs listed as
 * staying were said to need a path like that. A path prime does not hold is nothing
 * prime's copy needs to run, because it runs on prime without it, so it is
 * never a reason to keep the line's copy, and never named as one.
 */
export function whatKeptSpecLacks(args: {
  specPath: string;
  primeText: string;
  /** Prime's tree, where prime's copy runs. */
  prime: TreeIndex;
  /** The clone's tree as the delivery leaves it (`treeAfterDelivery`). */
  present: TreeIndex;
}): string[] {
  const lacks = new Set<string>();
  for (const specifier of importsOf(args.primeText)) {
    const atPrime = resolveSpecifier(specifier, args.specPath, args.prime);
    if (atPrime === null) continue;
    if (resolveSpecifier(specifier, args.specPath, args.present) === null) lacks.add(atPrime);
  }
  for (const named of subjectsNamedBy(args.primeText, args.specPath)) {
    if (args.prime.has(named) && !args.present.has(named)) lacks.add(named);
  }
  return [...lacks].sort();
}

/** A kept spec that stays the line's although a file it tests crossed. */
export type KeptSpecLeftBehind = {
  spec: string;
  /** The files it asserts about that this delivery changes. */
  touchedBy: readonly string[];
  /** What prime's copy needs that the line will not have (`whatKeptSpecLacks`). */
  lacks: readonly string[];
};

const MAX_NAMED = 3;

function nameFew(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_NAMED).map((p) => `\`${p}\``);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * The proposal's section for kept specs that stay the line's while a file
 * they test crosses. Empty when there are none, so the section is omitted.
 */
export function describeKeptSpecsLeftBehind(specs: readonly KeptSpecLeftBehind[]): string {
  return [...specs]
    .sort((a, b) => a.spec.localeCompare(b.spec))
    .map(
      (s) =>
        `- \`${s.spec}\` — tests ${nameFew(s.touchedBy)}, which this delivery changes; ` +
        `prime's copy needs ${nameFew(s.lacks)}, which this line does not carry, so the line's ` +
        `copy stays and runs its older assertions against the new file(s) until it is updated here.`,
    )
    .join("\n");
}
