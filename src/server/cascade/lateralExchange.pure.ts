/**
 * THE LATERAL LANE — what crosses between the two parents, which way, and why not.
 *
 * `lateralMembranes.pure.ts` declares the boundary: two membranes, one per
 * direction, in the vertical cascade's own vocabulary. This module is every
 * decision the lane takes across it. It reads nothing and writes nothing —
 * `lateral-exchange.server.ts` does the I/O and hands the answers here — so
 * every rule below is asserted against real trees without a token. Read
 * `docs/LATERAL_MEMBRANE.md` before changing one.
 *
 * ## Four questions, in order
 *
 * **1. Is it parent-level work?** Only a path the prime's default branch has
 * never held may cross (`lateralOrigin`). A path in the prime's current tree
 * is refused without asking; one the prime deleted is refused once its
 * history answers; one it never held is admitted. Refusal is the vertical
 * cascade's claim, not a judgement: that lane already owns the path on both
 * sides, and two lanes writing one path is how a cascade comes to argue with
 * itself. The two lanes' write sets are disjoint by this rule alone.
 *
 * **2. Which way?** (`decideLateral`) Neither parent is upstream, so direction
 * is read from each side's own history of the path:
 *
 *   one side holds it     the other side never did          → write it across
 *                         the other held THIS copy, removed → delete it here
 *                         the other held other copies only  → hold: deleted there, changed here
 *   both hold it          A once held B's copy, B never A's → write A → B
 *                         each has held the other's copy    → hold: one of them went back
 *                         neither has held the other's      → hold: both changed it
 *
 * A history that could not be read is `defer`: nothing is written, nothing is
 * held, and the next pass asks again. That is `decideDeletion`'s rule — a read
 * that FAILED is not a fact that is ABSENT — applied to a boundary with two
 * histories instead of one.
 *
 * A history that WAS read and cannot settle the question is different, and is
 * held as `undecidable`: one that runs back further than the walk without
 * finding the copy it needed, or one that contradicts its own tree. Asking
 * again does not change those answers — a history only grows — so deferring
 * them would re-walk the same commits every slot, and keep the lane
 * permanently "behind", for a question only a person can answer. Held, it is
 * named for that person and asked again when either copy changes, or after a
 * day.
 *
 * **3. May it enter?** (`judgeLateralWrites`) The destination's own rulebook,
 * in the order the vertical cascade applies it: module scope, then
 * `clone_sync_exclusions`, then the file's own shape (mode, size), then the
 * membrane's channels (`permeate`), then `judgingWorkflowHold`, and last the
 * three rules that need the whole delivery at once — a spec whose subject
 * would not be there to assert about, a file whose import would not resolve
 * on the destination, and an overwrite that would take away an export a file
 * the destination keeps still imports. Those are iterated to a fixed point,
 * because holding one file can strand another that depended on it.
 *
 * **4. May a deletion land?** (`planLateralDeletions`) Only inside scope,
 * only on a path no exclusion claims, never while a surviving file imports it,
 * and never more than `MAX_DELETIONS_PER_CASCADE` at once.
 *
 * ## What it deliberately does not do
 *
 * It never merges two copies into one. A file both parents changed is held and
 * named, because the lane cannot know which half of either change the other
 * deployment wants — and a wrong merge ships a file nobody wrote.
 *
 * It never carries a subject in behind a spec. Vertically that is the remedy;
 * here the subjects are, measured, files the prime owns, and a prime-owned
 * file is never this lane's to move.
 */

import { globToRegex, isSafeRepoPath } from "@/lib/module-globs";
import { isSpecPath } from "@/lib/cascade/membrane/ionSpecies.pure";
import {
  permeate,
  strandedSubjects,
  subjectsNamedBy,
  type Membrane,
} from "@/lib/cascade/membrane/membrane.pure";
import {
  CASCADE_MAX_FILE_BYTES,
  partitionCascadePaths,
  type ExclusionReason,
  type HeldPath,
  type SyncExclusion,
} from "./syncExclusions.pure";
import { judgingWorkflowHold } from "./judgingWorkflow.pure";
import { importsOf, resolveSpecifier, type TreeIndex } from "./importClosure.pure";
import { exportedNamesOf, findStaleHeldReferences, namedImportsOf } from "./heldFileStaleness.pure";
import {
  MAX_DELETIONS_PER_CASCADE,
  withholdReferencedDeletions,
  type DeletionVerdict,
} from "./deletionPropagation.pure";
import type { HeldPathEvidence } from "./heldEvidence.pure";
import { globsForModuleScopedClone } from "./repositoryInvariants.pure";

// ─────────────────────────────────────────────────────────────────────────────
// Naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The branch a lateral proposal lives on, one per ORIGIN.
 *
 * Deliberately not `aurixa/cascade-…`. Three things key on that prefix — the
 * vertical engine's own open-proposal lookup, the merge drain, and the
 * conflict resolver — and every one of them would treat a lateral proposal as
 * a prime cascade: force-push it with the prime's tree, merge it as the
 * prime's delivery, restate it over the head as the prime's paths. A prefix
 * none of them match is what keeps the two lanes from touching each other's
 * work.
 */
export const LATERAL_BRANCH_PREFIX = "aurixa/lateral-from-";

export function lateralBranchName(originRepo: string): string {
  return `${LATERAL_BRANCH_PREFIX}${originRepo}`;
}

/** The ledger action every exchange across a boundary is recorded under. */
export const LATERAL_LEDGER_ACTION = "cascade.lateral_exchange";

/** The ledger's entity type. The id is the boundary's own `ledgerId`. */
export const LATERAL_LEDGER_ENTITY = "lateral_boundary";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Candidates and origin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every path the two parents disagree on and the prime does not currently hold.
 *
 * Present on one side only, or on both with different blobs. Blob SHAs are
 * compared, never contents — a SHA is a hash of the bytes, so it settles a
 * binary as exactly as it settles text. A path in the prime's CURRENT tree is
 * dropped here without a question: the vertical cascade owns it on both sides,
 * and asking its history would spend a call to learn what the tree already said.
 */
export function lateralCandidates(args: {
  a: TreeIndex;
  b: TreeIndex;
  prime: TreeIndex;
}): string[] {
  const { a, b, prime } = args;
  const out = new Set<string>();
  for (const [path, sha] of a) {
    if (b.get(path) !== sha && !prime.has(path)) out.add(path);
  }
  for (const path of b.keys()) {
    if (!a.has(path) && !prime.has(path)) out.add(path);
  }
  return [...out].filter(isSafeRepoPath).sort();
}

/**
 * What the lane remembers about the prime's history, across passes.
 *
 * `held` is permanent: a history is append-only, so a path the prime once
 * held it held for ever. `never` is dated, because the prime may add a path
 * tomorrow — but it would then be in the prime's current tree, which is asked
 * every pass, so the date only bounds how long a stale answer can survive the
 * rarest case there is (added AND removed between two passes).
 */
export type LateralOriginMemo = {
  held: readonly string[];
  /** path → when the prime's history was last found empty for it. */
  never: Readonly<Record<string, string>>;
};

/** How long "the prime never held this" is trusted before it is asked again. */
export const ORIGIN_NEVER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OriginVerdict = "never" | "held";

/**
 * Is this parent-level work? Answered from memory where memory can.
 *
 * Returns null where the prime's history has to be asked. The answer to that
 * question is one `listCommits` page of one: an empty page is `never`, any
 * commit at all is `held`, and a failed read is neither — the path waits.
 */
export function lateralOrigin(
  path: string,
  memo: LateralOriginMemo,
  nowMs: number,
): OriginVerdict | null {
  if (memo.held.includes(path)) return "held";
  const at = memo.never[path];
  if (at && nowMs - Date.parse(at) < ORIGIN_NEVER_TTL_MS) return "never";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Direction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One side's history of one path — the walk `probePrimeVersions` does, asked
 * of a parent instead of the prime (`sideHistory` in the lateral engine, which
 * is stricter about a revision it could not read: here a skipped version can
 * make a path move, where on the vertical lane it can only make one stay). The
 * kind names are the prime's because the type is shared; `never_primes` reads
 * here as "this side never held it".
 */
export type SideHistory = HeldPathEvidence;

export type LateralSide = {
  repo: string;
  /** The blob this side holds at the path now, or null where it holds none. */
  sha: string | null;
  history?: SideHistory;
};

export type LateralDecision =
  | { act: "write"; path: string; from: string; to: string }
  | { act: "delete"; path: string; on: string; deletedOn: string }
  | {
      act: "hold";
      path: string;
      kind: "both_changed" | "went_back" | "deleted_and_changed" | "undecidable";
      why: string;
    }
  | { act: "defer"; path: string; why: string };

/** The histories a decision needs, and the blob each walk may stop at. */
export function historyProbesFor(
  a: LateralSide,
  b: LateralSide,
): Array<{ repo: string; stopAt: string }> {
  if (a.sha && !b.sha) return [{ repo: b.repo, stopAt: a.sha }];
  if (b.sha && !a.sha) return [{ repo: a.repo, stopAt: b.sha }];
  if (a.sha && b.sha && a.sha !== b.sha) {
    return [
      { repo: a.repo, stopAt: b.sha },
      { repo: b.repo, stopAt: a.sha },
    ];
  }
  return [];
}

/**
 * Which way one path moves, if at all. See the module header for the table.
 *
 * The rule is the deletion rule's, extended to two sides: a copy that is
 * byte-identical to some version the other side itself held is unmodified
 * work of that side's — it was carried across, or it was never changed — and
 * a copy that matches nothing the other side ever held is work that would be
 * lost. Only the first may be overwritten or removed.
 */
export function decideLateral(args: {
  path: string;
  a: LateralSide;
  b: LateralSide;
}): LateralDecision {
  const { path, a, b } = args;

  // One side only.
  if (!a.sha || !b.sha) {
    const holder = a.sha ? a : b;
    const lacker = a.sha ? b : a;
    if (!holder.sha) return { act: "defer", path, why: "Neither side holds this path." };
    const h = lacker.history;
    if (!h) return { act: "defer", path, why: `${lacker.repo}'s history has not been asked yet.` };
    if (h.kind === "unsettled") {
      return {
        act: "defer",
        path,
        why: `${lacker.repo}'s history for this path could not be read (${h.why}), and an unreadable history is not an absent one.`,
      };
    }
    if (h.kind === "never_primes") {
      return { act: "write", path, from: holder.repo, to: lacker.repo };
    }
    if (h.versions.length === 0) {
      return {
        act: "hold",
        path,
        kind: "undecidable",
        why:
          `${lacker.repo} once held this path, but no version of it could be recovered from its ` +
          `history to compare against — so the lane cannot tell a removal from a copy it never saw.`,
      };
    }
    if (h.versions.includes(holder.sha)) {
      return { act: "delete", path, on: holder.repo, deletedOn: lacker.repo };
    }
    if (!h.versionsExhaustive) {
      return {
        act: "hold",
        path,
        kind: "undecidable",
        why:
          `${lacker.repo} removed this, and ${holder.repo}'s copy matches none of the ` +
          `${h.versions.length} version(s) walked back — but the walk did not reach the beginning, ` +
          `so it cannot be told apart from a copy that is simply older than that.`,
      };
    }
    return {
      act: "hold",
      path,
      kind: "deleted_and_changed",
      why:
        `${lacker.repo} removed this, and ${holder.repo}'s copy is not any version ${lacker.repo} ` +
        `ever held — it was changed there after the two last agreed, or written there on its own. ` +
        `Deleting it would destroy that work and carrying it would undo the removal, so a person decides.`,
    };
  }

  // Both sides, different blobs.
  if (a.sha === b.sha) return { act: "defer", path, why: "Both sides already hold the same copy." };
  const ha = a.history;
  const hb = b.history;
  if (!ha || !hb) {
    return {
      act: "defer",
      path,
      why: "Both sides' histories are needed and one has not been asked yet.",
    };
  }
  for (const [side, h] of [
    [a, ha],
    [b, hb],
  ] as const) {
    if (h.kind === "unsettled") {
      return {
        act: "defer",
        path,
        why: `${side.repo}'s history for this path could not be read (${h.why}).`,
      };
    }
    if (h.kind === "never_primes") {
      // A path at a side's head with no commit touching it is a reading that
      // contradicts itself — a case-folded path, a history the API would not
      // walk. Acting on a contradiction is guessing, and asking again returns
      // the same contradiction.
      return {
        act: "hold",
        path,
        kind: "undecidable",
        why: `${side.repo} holds this path but its history names no commit that wrote it.`,
      };
    }
  }
  if (ha.kind !== "prime_versions" || hb.kind !== "prime_versions") {
    return { act: "defer", path, why: "A history could not be read." };
  }

  const aHeldB = ha.versions.includes(b.sha);
  const bHeldA = hb.versions.includes(a.sha);

  if (aHeldB && bHeldA) {
    return {
      act: "hold",
      path,
      kind: "went_back",
      why:
        `Each side has held the other's current copy, so one of them went back to an earlier ` +
        `version after the other moved on. Neither history says which change is the one to keep.`,
    };
  }
  if (aHeldB) {
    if (!hb.versionsExhaustive) {
      return {
        act: "hold",
        path,
        kind: "undecidable",
        why:
          `${a.repo} once held ${b.repo}'s copy, but ${b.repo}'s history runs back further than the ` +
          `lane walks, so it cannot be shown never to have held ${a.repo}'s — which is the difference ` +
          `between moving ahead and going back.`,
      };
    }
    return { act: "write", path, from: a.repo, to: b.repo };
  }
  if (bHeldA) {
    if (!ha.versionsExhaustive) {
      return {
        act: "hold",
        path,
        kind: "undecidable",
        why:
          `${b.repo} once held ${a.repo}'s copy, but ${a.repo}'s history runs back further than the ` +
          `lane walks, so it cannot be shown never to have held ${b.repo}'s — which is the difference ` +
          `between moving ahead and going back.`,
      };
    }
    return { act: "write", path, from: b.repo, to: a.repo };
  }
  if (!ha.versionsExhaustive || !hb.versionsExhaustive) {
    return {
      act: "hold",
      path,
      kind: "undecidable",
      why:
        "Neither side's walk found the other's copy, and at least one history runs back further " +
        'than the lane walks — so neither "both changed it" nor a direction can be shown.',
    };
  }
  return {
    act: "hold",
    path,
    kind: "both_changed",
    why:
      `Neither side has ever held the other's copy: both changed this since they last agreed, or ` +
      `each wrote it on its own. The lane never merges two authors' work — a person decides which ` +
      `side's version both should carry.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. May it enter?
// ─────────────────────────────────────────────────────────────────────────────

/** A regular file, or an executable one. Anything else is not a file this lane carries. */
const CARRIABLE_MODES = new Set(["100644", "100755"]);

/** Only these are read for imports, as `importClosure` reads them. */
const WALKABLE = /\.(?:ts|tsx|js|jsx|mjs|mts)$/;

/**
 * Whether a path is source the import rules read — and so an overwrite of it
 * waits on the destination's own work being read in full. The engine asks it
 * to tell an overwrite held back by a capacity bound (asked again only when a
 * head moves) from one held back by a read that failed (asked again next
 * slot).
 */
export function isWalkablePath(path: string): boolean {
  return WALKABLE.test(path);
}

export type LateralDestination = {
  repo: string;
  tree: TreeIndex;
  scope: "mirror" | "modules";
  /** The globs a module-scoped destination is offered; null for a mirror. */
  scopeGlobs: readonly string[] | null;
  exclusions: readonly SyncExclusion[];
};

export type LateralWriteJudgement = {
  /** Paths to write, sorted. */
  write: string[];
  /** Paths refused, with the rule that refused each. */
  held: HeldPath[];
  /** Paths the destination is not offered at all. Reported, never held. */
  outOfScope: string[];
  /** Paths that could not be judged this pass because a read was missing. */
  unread: string[];
};

/** Whether a module-scoped destination is offered a path. A mirror is offered everything. */
export function inLateralScope(
  dest: Pick<LateralDestination, "scope" | "scopeGlobs">,
  path: string,
): boolean {
  if (dest.scope === "mirror") return true;
  const globs = dest.scopeGlobs ?? [];
  return globs.some((g) => globToRegex(g).test(path));
}

/**
 * One destination, read two ways — the vertical cascade's own line.
 *
 * For a module-scoped clone the engine states it in a sentence: "Invariants
 * widen what is SENT; they never widen what is REMOVED." A repository
 * invariant (`package.json`, `scripts/**`, `.github/workflows/**` …) says the
 * destination needs the file whatever it installed. It says nothing about
 * removing one, and a `scripts/**` entry that also authorised deletion would
 * put the destination's own tooling inside the destructive half of a pass
 * that only ever needed to add.
 *
 * So what may be WRITTEN is the installed modules plus the invariants, and
 * what may be DELETED is the installed modules alone. A mirror is offered the
 * whole tree for both, as it is vertically.
 */
export function lateralDestinations(args: {
  repo: string;
  tree: TreeIndex;
  scope: "mirror" | "modules";
  installedGlobs: readonly string[];
  exclusions: readonly SyncExclusion[];
}): { writes: LateralDestination; deletes: LateralDestination } {
  const base = {
    repo: args.repo,
    tree: args.tree,
    scope: args.scope,
    exclusions: args.exclusions,
  };
  if (args.scope === "mirror") {
    return { writes: { ...base, scopeGlobs: null }, deletes: { ...base, scopeGlobs: null } };
  }
  return {
    writes: { ...base, scopeGlobs: globsForModuleScopedClone(args.installedGlobs) },
    deletes: { ...base, scopeGlobs: [...args.installedGlobs] },
  };
}

/** A file past what one invocation reads. Nothing here streams, so it stays. */
function lateralOversizeHold(path: string, bytes: number): HeldPath {
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
  return {
    path,
    pattern: "(size: over the lateral read ceiling)",
    reason: "oversize",
    note:
      `${mb(bytes)} — larger than the ${mb(CASCADE_MAX_FILE_BYTES)} this lane reads into one ` +
      `invocation, and every rule here judges a file by its text. It stays where it was written; ` +
      `copy it by hand if both parents should hold it.`,
  };
}

/**
 * Hold a written file whose imports would not resolve on the destination.
 *
 * The rule `importClosure.pure.ts` states for the vertical cascade — a payload
 * must contain what it imports — with the one difference that this lane
 * cannot widen a payload: the files a parent-level module imports are, as
 * often as not, files the prime owns. So the failure the vertical lane repairs
 * by carrying, this lane prevents by holding.
 *
 * Two readings, and only certain ones:
 *
 *   · the target is ABSENT on the destination (or being deleted there) and
 *     not crossing in this delivery — the bundler's "Could not load";
 *   · the target is present but DIFFERENT, and a NAMED import is not exported
 *     by the destination's copy — the bundler's "is not exported by". A
 *     module ending in `export * from` cannot be enumerated and is skipped,
 *     exactly as `findStaleHeldReferences` skips it.
 *
 * A target whose destination copy was not read leaves the importer UNREAD
 * rather than written: a read that failed is not a copy that is compatible.
 */
export function lateralImportHold(args: {
  path: string;
  text: string;
  originTree: TreeIndex;
  destination: LateralDestination;
  crossing: ReadonlySet<string>;
  deletingOnDestination: ReadonlySet<string>;
  /** The destination's copy of a differing target, null for binary, absent when unread. */
  destinationText: ReadonlyMap<string, string | null>;
}): { held: HeldPath } | { unread: true } | null {
  const { path, text, originTree, destination, crossing, deletingOnDestination, destinationText } =
    args;
  if (!WALKABLE.test(path)) return null;

  const named = namedImportsOf(text);
  for (const specifier of importsOf(text)) {
    const target = resolveSpecifier(specifier, path, originTree);
    // Unresolved where it was written: not a defect this delivery introduces,
    // and nothing this lane could deliver would resolve it.
    if (target === null) continue;
    if (crossing.has(target)) continue;

    const destSha = destination.tree.get(target);
    if (destSha === undefined || deletingOnDestination.has(target)) {
      return {
        held: {
          path,
          pattern: "(import: not on the destination)",
          reason: "manual_reconcile",
          note:
            `Imports \`${target}\`, which ${destination.repo} does not hold and this delivery ` +
            `does not carry — the build would fail on it. It crosses once what it imports does.`,
        },
      };
    }
    if (destSha === originTree.get(target)) continue;

    const names = named.filter((n) => n.specifier === specifier).flatMap((n) => n.names);
    if (names.length === 0) continue;
    const destText = destinationText.get(target);
    if (destText === undefined) return { unread: true };
    if (destText === null) continue;
    const exports = exportedNamesOf(destText);
    if (!exports.exhaustive) continue;
    const missing = [...new Set(names.filter((n) => !exports.names.has(n)))].sort();
    if (missing.length > 0) {
      return {
        held: {
          path,
          pattern: "(import: not exported on the destination)",
          reason: "manual_reconcile",
          note:
            `Imports ${missing.map((m) => `\`${m}\``).join(", ")} from \`${target}\`, and ` +
            `${destination.repo}'s copy of that file does not export ${missing.length === 1 ? "it" : "them"}. ` +
            `The two parents hold different versions of it, and this lane does not move a file ` +
            `the prime owns.`,
        },
      };
    }
  }
  return null;
}

/**
 * The subjects a spec names that the destination will not hold after this
 * delivery: present where the spec was written, and absent on the destination
 * (or being deleted there) and not crossing.
 *
 * The vertical rule deliberately declines this case — a subject a module-scoped
 * clone never had is outside its scope, and holding the spec on it would hold
 * it for ever with no act an operator can perform. Sideways the cost runs the
 * other way. A held file here stays where it was written and is named in the
 * proposal, which is the whole of its cost; a spec delivered without its
 * subject reads a file that is not there, turns `verify` red, and holds every
 * other file in the proposal behind it. A subject the ORIGIN lacks is not
 * counted at all: a spec that asserts a path is absent is true on both sides.
 */
export function absentSubjects(args: {
  specText: string;
  originTree: TreeIndex;
  destinationTree: TreeIndex;
  crossing: ReadonlySet<string>;
  deletingOnDestination: ReadonlySet<string>;
}): string[] {
  const { originTree, destinationTree, crossing, deletingOnDestination } = args;
  return subjectsNamedBy(args.specText).filter(
    (subject) =>
      originTree.has(subject) &&
      !crossing.has(subject) &&
      (!destinationTree.has(subject) || deletingOnDestination.has(subject)),
  );
}

/** The held row for a spec whose subjects would not be what it asserts about on the destination. */
function lateralSpecHold(
  membrane: Membrane,
  specPath: string,
  stranded: readonly string[],
  absent: readonly string[],
): HeldPath {
  const list = (paths: readonly string[]) =>
    paths
      .slice(0, 3)
      .map((p) => `\`${p}\``)
      .join(", ") + (paths.length > 3 ? ` (and ${paths.length - 3} more)` : "");
  const parts: string[] = [];
  if (stranded.length > 0) {
    parts.push(
      `Asserts about ${list(stranded)}, which the two parents hold in different versions and ` +
        `this delivery is not carrying, so delivered alone it would assert ${membrane.from}'s ` +
        `version against ${membrane.to}'s.`,
    );
  }
  if (absent.length > 0) {
    parts.push(
      `Asserts about ${list(absent)}, which ${membrane.to} does not hold and this delivery is ` +
        `not carrying, so delivered alone it would read a file that is not there.`,
    );
  }
  const channelNote = membrane.channels.find((c) => c.species === "spec")?.note ?? "";
  return {
    path: specPath,
    pattern: `(membrane: ${membrane.from}→${membrane.to} · spec channel gated on its subject)`,
    reason: "manual_reconcile",
    note: [...parts, channelNote].filter(Boolean).join(" "),
  };
}

/**
 * The most destination files one pass reads to learn what they import.
 *
 * Only a file that differs from BOTH the prime's copy and the origin's can
 * import a path this lane moves — see `lateralSurvivorCandidates` — and on
 * the two parents that set is their own work plus the handful of files each
 * keeps different from the prime. Past this bound the set could not be read
 * in full, and a partial read cannot say an overwrite or a deletion is safe.
 */
export const SURVIVOR_READ_CEILING = 150;

/**
 * The destination files whose imports decide whether an overwrite or a
 * deletion is safe.
 *
 * Every path this lane writes over or deletes is one the prime's history never
 * held, so a destination file byte-identical to the PRIME'S copy cannot import
 * it — the prime compiles without it. And a destination file byte-identical to
 * the ORIGIN'S copy compiles on the origin against exactly what is being
 * delivered, and cannot import a path the origin deleted. What is left is the
 * destination's own work: the only files that can break.
 */
export function lateralSurvivorCandidates(args: {
  destinationTree: TreeIndex;
  originTree: TreeIndex;
  primeTree: TreeIndex;
}): string[] {
  const out: string[] = [];
  for (const [path, sha] of args.destinationTree) {
    if (!WALKABLE.test(path)) continue;
    if (args.primeTree.get(path) === sha) continue;
    if (args.originTree.get(path) === sha) continue;
    out.push(path);
  }
  return out.sort();
}

/**
 * Whether a delivery needs the destination's own work read at all.
 *
 * Only an overwrite of a source file or a deletion can break an importer; a
 * NEW file cannot, because nothing on the destination imports a path it does
 * not hold. So a delivery that only adds files spends nothing on survivors —
 * and the empty set handed on in their place is exact rather than assumed,
 * because no rule that reads it has anything to judge. A deletion of any kind
 * asks, since `?raw` and friends can import a file that is not source.
 */
export function survivorsNeeded(args: {
  writes: readonly string[];
  deletes: readonly string[];
  destinationTree: TreeIndex;
}): boolean {
  if (args.deletes.length > 0) return true;
  return args.writes.some((p) => args.destinationTree.has(p) && WALKABLE.test(p));
}

/**
 * Hold an overwrite that would take away something the destination still uses.
 *
 * `findStaleHeldReferences` is the vertical cascade's own rule for exactly
 * this — a file it may not touch importing a symbol a delivered file stopped
 * exporting — asked here with the destination's own work as the files that
 * stay. A survivor this delivery is itself overwriting is not one: it arrives
 * as the origin's copy, which compiles against what is being delivered.
 */
function lateralOverwriteHolds(args: {
  overwrites: readonly string[];
  originText: ReadonlyMap<string, string | null>;
  survivors: Readonly<Record<string, string>>;
  crossing: ReadonlySet<string>;
  destinationRepo: string;
}): Map<string, HeldPath> {
  const cascadedFiles: Record<string, string> = {};
  for (const path of args.overwrites) {
    const text = args.originText.get(path);
    if (typeof text === "string" && WALKABLE.test(path)) cascadedFiles[path] = text;
  }
  const heldFiles: Record<string, string> = {};
  for (const [path, text] of Object.entries(args.survivors)) {
    if (!args.crossing.has(path)) heldFiles[path] = text;
  }
  const out = new Map<string, HeldPath>();
  for (const ref of findStaleHeldReferences({ heldFiles, cascadedFiles })) {
    const existing = out.get(ref.cascadedPath);
    const line = `\`${ref.heldPath}\` imports ${ref.missing.map((m) => `\`${m}\``).join(", ")} from it`;
    out.set(ref.cascadedPath, {
      path: ref.cascadedPath,
      pattern: "(import: an export the destination still uses)",
      reason: "manual_reconcile",
      note: existing
        ? `${existing.note}; ${line}`
        : `This version no longer exports what ${args.destinationRepo} still imports — ${line}. ` +
          `Written over the destination's copy it would break that build, so the file waits ` +
          `until the importer is changed on this side too.`,
    });
  }
  return out;
}

/**
 * Everything the destination's rulebook says about the paths decided to cross.
 *
 * `originText` carries each path's text (null for binary, absent where the
 * read did not happen). `destinationText` carries the destination's copy of
 * the targets `lateralImportHold` needs, which the caller reads for exactly
 * the targets `differingImportTargets` names.
 */
export function judgeLateralWrites(args: {
  membrane: Membrane;
  paths: readonly string[];
  originTree: TreeIndex;
  originModes: ReadonlyMap<string, string>;
  originSizes: ReadonlyMap<string, number>;
  originText: ReadonlyMap<string, string | null>;
  destination: LateralDestination;
  destinationText: ReadonlyMap<string, string | null>;
  deletingOnDestination: ReadonlySet<string>;
  /**
   * The destination's own work, read — `lateralSurvivorCandidates`' paths
   * with their text. Null where that set could not be read in full, which
   * leaves every OVERWRITE unread; a new file cannot break an importer.
   */
  destinationSurvivors: Readonly<Record<string, string>> | null;
  knownRefs: readonly string[];
}): LateralWriteJudgement {
  const { membrane, originTree, originModes, originSizes, originText, destination } = args;

  const outOfScope: string[] = [];
  const inScope: string[] = [];
  for (const path of [...new Set(args.paths)].sort()) {
    if (inLateralScope(destination, path)) inScope.push(path);
    else outOfScope.push(path);
  }

  const partition = partitionCascadePaths(inScope, destination.exclusions);
  const held: HeldPath[] = [...partition.held];
  const unread: string[] = [];
  let write: string[] = [];

  for (const path of partition.write) {
    const mode = originModes.get(path) ?? "100644";
    if (!CARRIABLE_MODES.has(mode)) {
      held.push({
        path,
        pattern: `(mode: ${mode})`,
        reason: "protected",
        note:
          mode === "120000"
            ? "A symbolic link. Where it points is a fact about the repository it was made in, so it is never carried."
            : "Not a regular file, so this lane does not carry it.",
      });
      continue;
    }
    const bytes = originSizes.get(path);
    if (typeof bytes === "number" && bytes > CASCADE_MAX_FILE_BYTES) {
      held.push(lateralOversizeHold(path, bytes));
      continue;
    }
    if (!originText.has(path)) {
      unread.push(path);
      continue;
    }
    const text = originText.get(path) ?? null;

    const verdict = permeate(membrane, { path, text, knownRefs: args.knownRefs });
    if (verdict.kind === "blocked") {
      held.push(verdict.held);
      continue;
    }
    if (text !== null) {
      const judged = judgingWorkflowHold({ path, primeContent: text, scope: destination.scope });
      if (judged) {
        held.push(judged);
        continue;
      }
    }
    write.push(path);
  }

  // The rules that need the whole delivery, to a fixed point: a file held here
  // leaves the crossing set, and a file that imported it, asserted about it or
  // was imported BY it on the destination may no longer be able to cross.
  for (;;) {
    const crossing = new Set(write);
    const overwrites = write.filter((p) => destination.tree.has(p));
    const overwriteHolds = args.destinationSurvivors
      ? lateralOverwriteHolds({
          overwrites,
          originText,
          survivors: args.destinationSurvivors,
          crossing,
          destinationRepo: destination.repo,
        })
      : new Map<string, HeldPath>();
    const next: string[] = [];
    let changed = false;
    for (const path of write) {
      const text = originText.get(path) ?? null;
      if (destination.tree.has(path)) {
        if (args.destinationSurvivors === null && WALKABLE.test(path)) {
          unread.push(path);
          changed = true;
          continue;
        }
        const overwriteHold = overwriteHolds.get(path);
        if (overwriteHold) {
          held.push(overwriteHold);
          changed = true;
          continue;
        }
      }
      if (text === null) {
        next.push(path);
        continue;
      }
      if (isSpecPath(path)) {
        const stranded = strandedSubjects({
          specPath: path,
          specText: text,
          primeSha: originTree,
          cloneSha: destination.tree,
          crossing,
        });
        const absent = absentSubjects({
          specText: text,
          originTree,
          destinationTree: destination.tree,
          crossing,
          deletingOnDestination: args.deletingOnDestination,
        });
        if (stranded.length > 0 || absent.length > 0) {
          held.push(lateralSpecHold(membrane, path, stranded, absent));
          changed = true;
          continue;
        }
      }
      const imported = lateralImportHold({
        path,
        text,
        originTree,
        destination,
        crossing,
        deletingOnDestination: args.deletingOnDestination,
        destinationText: args.destinationText,
      });
      if (imported && "held" in imported) {
        held.push(imported.held);
        changed = true;
        continue;
      }
      if (imported && "unread" in imported) {
        unread.push(path);
        changed = true;
        continue;
      }
      next.push(path);
    }
    write = next;
    if (!changed) break;
  }

  return {
    write: write.sort(),
    held: held.sort((x, y) => x.path.localeCompare(y.path)),
    outOfScope,
    unread: [...new Set(unread)].sort(),
  };
}

/**
 * The destination copies `lateralImportHold` will need, for the paths about
 * to be judged: every import target that exists on BOTH sides in different
 * versions. Asked before judging, so the caller reads each at most once.
 */
export function differingImportTargets(args: {
  paths: readonly string[];
  originTree: TreeIndex;
  originText: ReadonlyMap<string, string | null>;
  destinationTree: TreeIndex;
}): string[] {
  const out = new Set<string>();
  for (const path of args.paths) {
    if (!WALKABLE.test(path)) continue;
    const text = args.originText.get(path);
    if (typeof text !== "string") continue;
    const named = new Set(namedImportsOf(text).map((n) => n.specifier));
    for (const specifier of importsOf(text)) {
      if (!named.has(specifier)) continue;
      const target = resolveSpecifier(specifier, path, args.originTree);
      if (!target) continue;
      const dest = args.destinationTree.get(target);
      if (dest !== undefined && dest !== args.originTree.get(target)) out.add(target);
    }
  }
  return [...out].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Deletions
// ─────────────────────────────────────────────────────────────────────────────

export type LateralDeletionPlan = {
  deletes: string[];
  kept: Array<{ path: string; why: string }>;
  outOfScope: string[];
  /** Set when the whole set was refused. */
  refusal: string | null;
};

/**
 * The deletions that may land on one destination.
 *
 * `survivingFiles` is every file on the destination that could still import
 * a deleted path once this delivery lands: `lateralSurvivorCandidates`' set,
 * read, less what this delivery writes over (it arrives as the origin's copy,
 * which compiles without the path). It INCLUDES the deletion targets' own
 * text: a target differs from the prime and from the origin, so it is one of
 * those candidates by construction.
 *
 * That matters because keeping is contagious. A target the plan keeps is a
 * file that survives, and if it imports another target, deleting that one
 * breaks the build the first keep was protecting. So the plan runs to a fixed
 * point — every target being deleted leaves the surviving set, and every
 * target kept re-enters it — rather than judging each deletion against the
 * files that happen to be staying before it decides.
 *
 * Null means that set could not be read in full, and a deletion judged
 * against part of it is a deletion that might break a build, so null
 * withholds every one.
 */
export function planLateralDeletions(args: {
  deletes: ReadonlyArray<{ path: string; deletedOn: string }>;
  destination: LateralDestination;
  survivingFiles: Readonly<Record<string, string>> | null;
  cap?: number;
}): LateralDeletionPlan {
  const { destination } = args;
  const cap = args.cap ?? MAX_DELETIONS_PER_CASCADE;
  const outOfScope: string[] = [];
  const kept: Array<{ path: string; why: string }> = [];
  const byPath = new Map<string, string>();

  for (const d of args.deletes) {
    if (!inLateralScope(destination, d.path)) {
      outOfScope.push(d.path);
      continue;
    }
    byPath.set(d.path, d.deletedOn);
  }

  // A path an exclusion claims is the destination's to keep, whoever deleted
  // it elsewhere — the same reason the vertical cascade never deletes one.
  const partition = partitionCascadePaths([...byPath.keys()].sort(), destination.exclusions);
  for (const h of partition.held) {
    kept.push({ path: h.path, why: `Claimed on ${destination.repo} by \`${h.pattern}\`.` });
  }

  if (args.survivingFiles === null) {
    for (const path of partition.write) {
      kept.push({
        path,
        why:
          `The files on ${destination.repo} that could still import this were not all read ` +
          `this pass, and a deletion judged against part of them could break the build.`,
      });
    }
    return { deletes: [], kept, outOfScope, refusal: null };
  }

  // Every deletion onto one destination came from the other side of the
  // boundary, so the sentence names that parent rather than the prime.
  const removers = [...new Set(args.deletes.map((d) => d.deletedOn))];
  const remover = removers.length === 1 ? `\`${removers[0]}\`` : "The other parent";

  // To a fixed point. Each round judges the targets still marked for deletion
  // against every file that is not: a kept target joins the survivors, so a
  // target IT imports is withheld on the next round. The set only shrinks, so
  // this ends within one round per target.
  let deleting = new Set(partition.write);
  const survivors = args.survivingFiles;
  for (;;) {
    const surviving: Record<string, string> = {};
    for (const [path, text] of Object.entries(survivors)) {
      if (!deleting.has(path)) surviving[path] = text;
    }
    const verdicts: DeletionVerdict[] = [...deleting].sort().map((path) => ({
      act: "delete",
      path,
      deletedIn: byPath.get(path) ?? "",
    }));
    const judged = withholdReferencedDeletions(verdicts, surviving, remover);
    const next = new Set<string>();
    for (const v of judged) {
      if (v.act === "delete") next.add(v.path);
      else kept.push({ path: v.path, why: v.why });
    }
    if (next.size === deleting.size) break;
    deleting = next;
  }

  const deletes = [...deleting].sort();
  if (deletes.length > cap) {
    return {
      deletes: [],
      kept,
      outOfScope,
      refusal:
        `${deletes.length} file(s) would be deleted from ${destination.repo}, above the ${cap} ` +
        `this lane removes at once. Nothing was deleted: a set that size is more likely to be ` +
        `evidence gone wrong than one parent's retirement, so it is refused whole.`,
    };
  }
  return { deletes, kept, outOfScope, refusal: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// When a pass runs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How often the lane may look, in minutes of the clock.
 *
 * A clock slot rather than a timer, so the lane needs no state to know whether
 * it is due: the drain ticks every minute and the lane runs on the idle tick
 * that falls in a slot. A busy slot is skipped, not queued — the vertical
 * cascade has the tick, and parent-level work is never more urgent than the
 * prime's.
 */
export const LATERAL_CADENCE_MINUTES = 10;

export function isLateralSlot(nowMs: number, cadence = LATERAL_CADENCE_MINUTES): boolean {
  return Math.floor(nowMs / 60_000) % cadence === 0;
}

/** How long an unchanged fleet goes before the lane re-reads it anyway. */
export const LATERAL_RECHECK_MS = 24 * 60 * 60 * 1000;

/** The heads a pass reads, as one string: any head moving is a new question. */
export function lateralFingerprint(heads: Readonly<Record<string, string>>): string {
  return Object.keys(heads)
    .sort()
    .map((k) => `${k}@${heads[k]}`)
    .join("|");
}

export type LateralRunDecision = { run: true; why: string } | { run: false; why: string };

/**
 * Whether a due slot should spend a pass.
 *
 * It costs three branch reads to ask, and a whole pass to answer. So a pass
 * runs where something could have changed — a head moved, a proposal was
 * merged or declined, work was deferred — and otherwise once a day, which is
 * what re-reads a history an earlier pass could not.
 *
 * A proposal merely WAITING on its checks is not a reason: nothing a pass
 * reads has changed, and the reconcile that runs before this question is what
 * lands it. A pause stops every pass except one an operator asks for.
 */
export function decideLateralRun(args: {
  nowMs: number;
  force: boolean;
  fingerprint: string;
  /** Recorded proposals this slot's reconcile found merged or declined. */
  proposalsSettled: number;
  last: {
    fingerprint: string | null;
    at: string;
    deferred: number;
    paused: boolean;
  } | null;
}): LateralRunDecision {
  const { nowMs, force, fingerprint, last } = args;
  if (force) return { run: true, why: "requested by an operator" };
  if (!last) return { run: true, why: "no exchange has been recorded across this boundary" };
  if (last.paused) return { run: false, why: "paused by an operator" };
  if (last.fingerprint !== fingerprint)
    return { run: true, why: "a head moved since the last exchange" };
  if (args.proposalsSettled > 0) {
    return { run: true, why: "a proposal was merged or declined since the last exchange" };
  }
  if (last.deferred > 0) return { run: true, why: "the last exchange deferred work" };
  const age = nowMs - Date.parse(last.at);
  if (!Number.isFinite(age) || age >= LATERAL_RECHECK_MS) {
    return { run: true, why: "a day has passed since the last exchange" };
  }
  return { run: false, why: "nothing has moved since the last exchange" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory across passes
// ─────────────────────────────────────────────────────────────────────────────

/** How long a settled direction is trusted for the same pair of blobs. */
export const DECISION_TTL_MS = 24 * 60 * 60 * 1000;

/** Bounds on what the ledger carries, so a row never grows with the tree. */
const MAX_MEMO_ENTRIES = 2_000;

export type SettledLateralDecision = Exclude<LateralDecision, { act: "defer" }>;

/** What a proposal offers one path: the origin's blob, or its removal. */
export type ProposalItem = { path: string; sha: string };

/** The `sha` a removal is offered and declined under. No blob is ever this word. */
export const DECLINED_DELETION = "delete";

/** A copy a person declined to take, and where they declined it. */
export type LateralDecline = { sha: string; url: string; at: string };

export type LateralMemo = {
  v: 1;
  origin: LateralOriginMemo;
  /** `${path}|${aSha}|${bSha}` → the decision and when it was taken. */
  decisions: Readonly<Record<string, { at: string; d: SettledLateralDecision }>>;
  /**
   * destination repository → path → the copy a person declined there.
   *
   * A pull request closed without merging is a person saying "not this". The
   * vertical cascade has no memory of that and re-proposes on its next event;
   * sideways, the next event is ten minutes away, so a lane without it would
   * re-open what somebody just closed while they watched. A decline holds for
   * THAT copy only: the origin changing the file again is a new offer, and is
   * made. The lasting way to refuse a path is the destination's own
   * `clone_sync_exclusions`, exactly as it is for the prime.
   */
  declined: Readonly<Record<string, Readonly<Record<string, LateralDecline>>>>;
};

export const EMPTY_LATERAL_MEMO: LateralMemo = {
  v: 1,
  origin: { held: [], never: {} },
  decisions: {},
  declined: {},
};

export function decisionKey(path: string, aSha: string | null, bSha: string | null): string {
  return `${path}|${aSha ?? "-"}|${bSha ?? "-"}`;
}

/** A decision still good for this exact pair of blobs, or null. */
export function recalledDecision(
  memo: LateralMemo,
  key: string,
  nowMs: number,
): SettledLateralDecision | null {
  const hit = memo.decisions[key];
  if (!hit) return null;
  const age = nowMs - Date.parse(hit.at);
  return Number.isFinite(age) && age < DECISION_TTL_MS ? hit.d : null;
}

/** Split an offer into what may be proposed and what a person already declined. */
export function withoutDeclined(args: {
  to: string;
  items: readonly ProposalItem[];
  memo: LateralMemo;
}): { offer: ProposalItem[]; declined: Array<{ path: string; url: string; at: string }> } {
  const here = args.memo.declined[args.to] ?? {};
  const offer: ProposalItem[] = [];
  const declined: Array<{ path: string; url: string; at: string }> = [];
  for (const item of args.items) {
    const d = here[item.path];
    if (d && d.sha === item.sha) declined.push({ path: item.path, url: d.url, at: d.at });
    else offer.push(item);
  }
  return { offer, declined };
}

/**
 * Read a memo back from a ledger row, tolerating anything.
 *
 * A malformed memo is an empty one — every answer in it would be asked
 * again, which costs calls and never costs correctness. Refusing the pass
 * over it would stop the lane on its own bookkeeping.
 */
export function readLateralMemo(raw: unknown): LateralMemo {
  if (!raw || typeof raw !== "object") return EMPTY_LATERAL_MEMO;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return EMPTY_LATERAL_MEMO;
  const origin = (r.origin ?? {}) as Record<string, unknown>;
  const held = Array.isArray(origin.held)
    ? origin.held.filter((p): p is string => typeof p === "string")
    : [];
  const never: Record<string, string> = {};
  if (origin.never && typeof origin.never === "object") {
    for (const [k, v] of Object.entries(origin.never as Record<string, unknown>)) {
      if (typeof v === "string") never[k] = v;
    }
  }
  const decisions: Record<string, { at: string; d: SettledLateralDecision }> = {};
  if (r.decisions && typeof r.decisions === "object") {
    for (const [k, v] of Object.entries(r.decisions as Record<string, unknown>)) {
      const entry = v as { at?: unknown; d?: unknown };
      const d = entry?.d as { act?: unknown; path?: unknown } | undefined;
      if (
        typeof entry?.at === "string" &&
        d &&
        typeof d.path === "string" &&
        (d.act === "write" || d.act === "delete" || d.act === "hold")
      ) {
        decisions[k] = { at: entry.at, d: d as SettledLateralDecision };
      }
    }
  }
  const declined: Record<string, Record<string, LateralDecline>> = {};
  if (r.declined && typeof r.declined === "object") {
    for (const [repo, paths] of Object.entries(r.declined as Record<string, unknown>)) {
      if (!paths || typeof paths !== "object") continue;
      const here: Record<string, LateralDecline> = {};
      for (const [path, v] of Object.entries(paths as Record<string, unknown>)) {
        const d = v as { sha?: unknown; url?: unknown; at?: unknown };
        if (typeof d?.sha === "string" && typeof d.url === "string" && typeof d.at === "string") {
          here[path] = { sha: d.sha, url: d.url, at: d.at };
        }
      }
      declined[repo] = here;
    }
  }
  return { v: 1, origin: { held, never }, decisions, declined };
}

/** The memo to write back: this pass's answers in, expired ones out, bounded. */
export function nextLateralMemo(args: {
  previous: LateralMemo;
  nowMs: number;
  originAnswers: ReadonlyMap<string, OriginVerdict>;
  decisions: ReadonlyMap<string, SettledLateralDecision>;
  /** Proposals this slot found closed without merging. */
  declines?: ReadonlyArray<{ to: string; items: readonly ProposalItem[]; url: string }>;
}): LateralMemo {
  const { previous, nowMs } = args;
  const nowIso = new Date(nowMs).toISOString();

  const held = new Set(previous.origin.held);
  const never: Record<string, string> = {};
  for (const [path, at] of Object.entries(previous.origin.never)) {
    if (nowMs - Date.parse(at) < ORIGIN_NEVER_TTL_MS) never[path] = at;
  }
  for (const [path, verdict] of args.originAnswers) {
    if (verdict === "held") {
      held.add(path);
      delete never[path];
    } else if (!held.has(path)) {
      never[path] = nowIso;
    }
  }

  const decisions: Record<string, { at: string; d: SettledLateralDecision }> = {};
  for (const [key, entry] of Object.entries(previous.decisions)) {
    if (nowMs - Date.parse(entry.at) < DECISION_TTL_MS) decisions[key] = entry;
  }
  for (const [key, d] of args.decisions) decisions[key] = { at: nowIso, d };

  const cap = <T>(entries: Array<[string, T]>): Record<string, T> =>
    Object.fromEntries(entries.slice(-MAX_MEMO_ENTRIES));

  const declined: Record<string, Record<string, LateralDecline>> = {};
  for (const [repo, paths] of Object.entries(previous.declined)) declined[repo] = { ...paths };
  for (const d of args.declines ?? []) {
    const here = (declined[d.to] ??= {});
    for (const item of d.items) here[item.path] = { sha: item.sha, url: d.url, at: nowIso };
  }
  for (const repo of Object.keys(declined)) declined[repo] = cap(Object.entries(declined[repo]));

  return {
    v: 1,
    origin: {
      held: [...held].sort().slice(0, MAX_MEMO_ENTRIES),
      never: cap(Object.entries(never)),
    },
    decisions: cap(Object.entries(decisions)),
    declined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────────────────────

/** A proposal left open by an exchange, as the next slot needs to find it again. */
export type LateralProposalRecord = {
  from: string;
  to: string;
  pr: number;
  url: string;
  /** What it offers, so a decline can be remembered path by path. */
  items: ProposalItem[];
};

/** What the next slot reads back from the last row: everything a decision needs. */
export type LateralLedgerState = {
  fingerprint: string | null;
  paused: boolean;
  deferred: number;
  proposals: LateralProposalRecord[];
  memo: LateralMemo;
};

export const EMPTY_LATERAL_LEDGER: LateralLedgerState = {
  fingerprint: null,
  paused: false,
  deferred: 0,
  proposals: [],
  memo: EMPTY_LATERAL_MEMO,
};

/**
 * Read the last row back, tolerating anything — the memo's rule, for the row.
 *
 * Two readings are deliberately NOT tolerant in the lenient direction. A
 * `paused` that cannot be read as `true` is `false`, which is the default the
 * lane had before anyone paused it. And a proposal record that cannot be read
 * is dropped, which costs one reconcile rather than acting on a pull request
 * nobody can name.
 */
export function readLateralLedger(raw: unknown): LateralLedgerState {
  if (!raw || typeof raw !== "object") return EMPTY_LATERAL_LEDGER;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return EMPTY_LATERAL_LEDGER;
  const proposals: LateralProposalRecord[] = [];
  if (Array.isArray(r.proposals)) {
    for (const p of r.proposals) {
      const q = p as Record<string, unknown>;
      if (
        typeof q?.from !== "string" ||
        typeof q.to !== "string" ||
        typeof q.pr !== "number" ||
        !Number.isInteger(q.pr) ||
        typeof q.url !== "string"
      ) {
        continue;
      }
      const items = Array.isArray(q.items)
        ? (q.items as unknown[]).filter(
            (i): i is ProposalItem =>
              !!i &&
              typeof (i as ProposalItem).path === "string" &&
              typeof (i as ProposalItem).sha === "string",
          )
        : [];
      proposals.push({ from: q.from, to: q.to, pr: q.pr, url: q.url, items });
    }
  }
  return {
    fingerprint: typeof r.fingerprint === "string" ? r.fingerprint : null,
    paused: r.paused === true,
    deferred: typeof r.deferred === "number" && Number.isFinite(r.deferred) ? r.deferred : 0,
    proposals,
    memo: readLateralMemo(r.memo),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The proposal
// ─────────────────────────────────────────────────────────────────────────────

/** Operator words for a hold reason. Database vocabulary never reaches a reader. */
const REASON_WORDS: Record<ExclusionReason, string> = {
  protected: "never crosses",
  manual_reconcile: "needs a person",
  oversize: "too large to carry",
};

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * The one commit shape the lateral lane writes.
 *
 * `proposalRepair.pure.ts`' `ENGINE_COMMIT_PREFIX` is the vertical engine's
 * statement of the same thing and is deliberately not this: a prefix both
 * lanes wrote is a branch each would recognise as its own.
 */
export const LATERAL_COMMIT_PREFIX = "chore(aurixa): lateral ";

/**
 * Whether an open proposal is still entirely the lane's own work.
 *
 * `isEngineOnlyBranch`'s rule, for this lane's branch: the lane writes exactly
 * one commit whose message it controls, so anything else is somebody's — a
 * fix pushed to get a check green, a merge of the base from GitHub's own
 * button. Rebuilding over it would force-push their commit away. Erring
 * strict costs a proposal left as it is; erring loose deletes a person's work.
 */
export function isLaneOnlyProposal(commits: ReadonlyArray<{ message: string }>): boolean {
  if (commits.length !== 1) return false;
  return commits[0].message.startsWith(LATERAL_COMMIT_PREFIX);
}

/**
 * The commit message, the pull request title and its body.
 *
 * The body says WHERE the change came from and why it is allowed to cross,
 * then what did not cross and why — because a held file nobody is told about
 * is indistinguishable from one that never changed.
 */
export function describeLateralProposal(args: {
  boundaryLabel: string;
  from: string;
  to: string;
  originHead: string;
  writes: readonly string[];
  deletes: readonly string[];
  held: readonly HeldPath[];
  conflicts: ReadonlyArray<{ path: string; why: string }>;
  outOfScope: readonly string[];
  keptDeletions: ReadonlyArray<{ path: string; why: string }>;
  deletionRefusal: string | null;
  /** Copies a person already declined here, withheld from this proposal. */
  declined?: ReadonlyArray<{ path: string; url: string }>;
  mode: string;
}): { title: string; commitMessage: string; body: string } {
  const n = args.writes.length + args.deletes.length;
  const title = `Aurixa lateral · ${args.from} → ${args.to} · ${n} file(s)`;
  const commitMessage =
    `${LATERAL_COMMIT_PREFIX}${n} file(s) from ${args.from}@${shortSha(args.originHead)}\n\n` +
    [...args.writes.map((p) => `- ${p}`), ...args.deletes.map((p) => `- DELETE ${p}`)].join("\n");

  const lines: string[] = [];
  lines.push(
    args.mode === "auto_merge"
      ? "Auto-merge: this lands once `verify` and `security` pass, and waits otherwise."
      : "Proposed for review — this boundary is set to open proposals and leave them.",
  );
  lines.push("");
  lines.push(
    `Parent-level work crossing the lateral membrane **${args.boundaryLabel}**, from ` +
      `\`${args.from}@${shortSha(args.originHead)}\`. Only files the prime's history has never held ` +
      `cross this boundary, and each moves toward the side still holding the version the other ` +
      `side left behind. Everything the prime owns stays with the vertical cascade.`,
  );
  if (args.writes.length > 0) {
    lines.push("", `### Carried (${args.writes.length})`, "");
    lines.push(...args.writes.map((p) => `- \`${p}\``));
  }
  if (args.deletes.length > 0) {
    lines.push("", `### Removed (${args.deletes.length})`, "");
    lines.push(
      `\`${args.from}\` deleted these, and this repository's copies were byte-identical to a ` +
        `version \`${args.from}\` itself held:`,
      "",
      ...args.deletes.map((p) => `- \`${p}\``),
    );
  }
  const reportable = args.held.filter((h) => h.reason !== "protected");
  if (reportable.length > 0) {
    lines.push("", `### Held — ${reportable.length} file(s) that did not cross`, "");
    lines.push(
      ...reportable.map(
        (h) => `- \`${h.path}\` — ${REASON_WORDS[h.reason]}${h.note ? `: ${h.note}` : ""}`,
      ),
    );
  }
  const quiet = args.held.length - reportable.length;
  if (quiet > 0) {
    lines.push(
      "",
      `_${quiet} further file(s) never cross this boundary and were withheld without comment._`,
    );
  }
  if (args.conflicts.length > 0) {
    // Not only "both changed": a removal against an edit, a revert, and a
    // history the lane could not settle are all held the same way.
    lines.push(
      "",
      `### For a person — ${args.conflicts.length} file(s) the lane will not decide`,
      "",
    );
    lines.push(...args.conflicts.map((c) => `- \`${c.path}\` — ${c.why}`));
  }
  if (args.deletionRefusal) {
    lines.push("", `**Deletions refused.** ${args.deletionRefusal}`);
  }
  if (args.keptDeletions.length > 0) {
    lines.push("", `### Deleted there, kept here (${args.keptDeletions.length})`, "");
    lines.push(...args.keptDeletions.map((k) => `- \`${k.path}\` — ${k.why}`));
  }
  if (args.outOfScope.length > 0) {
    lines.push(
      "",
      `_${args.outOfScope.length} file(s) are outside this deployment's installed modules and were ` +
        `not offered: ${args.outOfScope
          .slice(0, 5)
          .map((p) => `\`${p}\``)
          .join(", ")}` +
        `${args.outOfScope.length > 5 ? ` (+${args.outOfScope.length - 5} more)` : ""}._`,
    );
  }
  const declined = args.declined ?? [];
  if (declined.length > 0) {
    lines.push("", `### Declined here before (${declined.length})`, "");
    lines.push(
      `A person closed an earlier proposal carrying these exact copies, so they are not offered ` +
        `again. They will be, if \`${args.from}\` changes them:`,
      "",
      ...declined.map((d) => `- \`${d.path}\` — ${d.url}`),
    );
  }
  lines.push(
    "",
    "---",
    "",
    `_Closing this without merging declines these copies: they are not proposed again until ` +
      `\`${args.from}\` changes them. To keep a path from crossing into \`${args.to}\` for good, add it ` +
      `to this deployment's sync exclusions in Mission Control — the same rule that keeps a prime ` +
      `file out._`,
  );
  return { title, commitMessage, body: lines.join("\n") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Acting on a proposal
// ─────────────────────────────────────────────────────────────────────────────

/** The three ways the rulebook lands work, from `prime_config.default_cascade_mode`. */
export type LateralMode = "pr" | "auto_merge" | "notify";

/**
 * The mode a pass acts in: the rulebook's own, except that a paused boundary
 * never merges.
 *
 * A pause stops the slot from running at all. An operator may still ask for a
 * pass while paused — to see what would cross, or to refresh an open proposal
 * — and that pass proposes and leaves: landing work across a boundary
 * somebody paused is the one thing the pause exists to stop.
 */
export function effectiveLateralMode(configured: LateralMode, paused: boolean): LateralMode {
  return paused && configured === "auto_merge" ? "pr" : configured;
}

/**
 * Written into a proposal the lane closes itself.
 *
 * A proposal closed without merging is how a person declines it, and a
 * decline is remembered. The lane also closes proposals — ones a later pass
 * found it no longer has anything to offer — and those must not be read back
 * as a person's refusal, or the lane would teach itself to withhold copies
 * nobody declined. An HTML comment is invisible where the body is rendered.
 */
export const SUPERSEDED_MARKER = "<!-- aurixa-lateral:superseded -->";

export type ProposalState = "merged" | "declined" | "superseded" | "open";

/** What a recorded proposal's pull request now says about it. */
export function readProposalState(pr: {
  state: string;
  merged_at: string | null;
  body: string | null;
}): ProposalState {
  if (pr.merged_at) return "merged";
  if (pr.state !== "closed") return "open";
  return (pr.body ?? "").includes(SUPERSEDED_MARKER) ? "superseded" : "declined";
}

/**
 * Whether an open proposal already carries exactly this offer.
 *
 * Judged on what the pull request CHANGES — each path's resulting blob, or its
 * removal — never on its tree, because the tree also carries the
 * destination's own head. Every vertical cascade that lands on a parent moves
 * that head, and a proposal rebuilt whenever it moved would restart its
 * checks each time: on a parent the prime cascades into several times a day, a
 * proposal whose `verify` takes seventeen minutes might never finish one.
 *
 * A text file inlined into `createTree` becomes the blob its origin held — a
 * blob id is the hash of the bytes, and text travels byte for byte — so the
 * origin's id is what the pull request reports. A listing that may have been
 * cut short, or any rename, is not evidence of equality: the proposal is then
 * rebuilt, which costs a push and never a wrong file.
 */
export function proposalCarries(args: {
  items: readonly ProposalItem[];
  files: ReadonlyArray<{ filename: string; status: string; sha: string | null }>;
  listingComplete: boolean;
}): boolean {
  if (!args.listingComplete) return false;
  if (args.files.length !== args.items.length) return false;
  const want = new Map(args.items.map((i) => [i.path, i.sha]));
  for (const f of args.files) {
    if (f.status === "renamed" || f.status === "copied") return false;
    const expected = want.get(f.filename);
    if (expected === undefined) return false;
    if (expected === DECLINED_DELETION) {
      if (f.status !== "removed") return false;
    } else if (f.status === "removed" || f.sha !== expected) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// What a pass reports
// ─────────────────────────────────────────────────────────────────────────────

export type LateralDirectionOutcome =
  /** A pull request was opened. */
  | "proposed"
  /** An open proposal was moved to this offer. */
  | "updated"
  /** An open proposal already carries exactly this offer. */
  | "unchanged"
  /** Notify mode: decided and recorded, nothing proposed. */
  | "recorded"
  /** A rehearsal: decided, nothing written anywhere. */
  | "dry_run"
  /** Nothing may cross this way. */
  | "nothing"
  /** A proposal no longer matched anything to offer, and was closed. */
  | "closed_stale"
  /** Not settled this pass; asked again on the next slot. */
  | "deferred"
  /** The destination's rulebook could not be read, so nothing was judged. */
  | "refused"
  | "failed";

export type LateralDirectionReport = {
  from: string;
  to: string;
  outcome: LateralDirectionOutcome;
  why: string;
  writes: string[];
  deletes: string[];
  held: HeldPath[];
  keptDeletions: Array<{ path: string; why: string }>;
  deletionRefusal: string | null;
  outOfScope: string[];
  declined: Array<{ path: string; url: string; at: string }>;
  unread: string[];
  pr: { number: number; url: string } | null;
  /** What the merge gate said, where this pass asked it. */
  merge: string | null;
};

export type LateralReconcileState = ProposalState | "unreadable";

export type LateralReconcile = {
  from: string;
  to: string;
  pr: number;
  url: string;
  state: LateralReconcileState;
  why: string | null;
};

export type LateralBoundaryOutcome =
  | "ran"
  | "skipped"
  | "paused"
  | "refused"
  | "deferred"
  | "failed";

export type LateralBoundaryReport = {
  boundary: string;
  label: string;
  outcome: LateralBoundaryOutcome;
  why: string;
  mode: LateralMode | null;
  /** Paths the two parents disagree on that the prime's current tree does not hold. */
  candidates: number;
  /** Of those, paths the prime's history once held — the vertical lane's, left alone. */
  primeOwned: number;
  /** Paths both sides changed, or one removed and the other changed: a person decides. */
  conflicts: Array<{ path: string; kind: string; why: string }>;
  /** Paths not settled this pass, and why. */
  deferred: Array<{ path: string; why: string }>;
  reconcile: LateralReconcile[];
  directions: LateralDirectionReport[];
  /** Whether the pass's ledger row was written. Null where nothing was to be written. */
  ledgerWritten: boolean | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// The ledger row
// ─────────────────────────────────────────────────────────────────────────────

/** Why a row was written: a pass, or an operator pausing or resuming the boundary. */
export type LateralLedgerEvent = "exchange" | "paused" | "resumed";

/** Bounds on the report a row carries, so a row never grows with a delivery. */
const REPORT_LIST_CAP = 60;
const REPORT_NOTE_CAP = 400;

const clip = (text: string, n = REPORT_NOTE_CAP) =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;

/** The report as a row keeps it: every list bounded, every note clipped. */
export function compactLateralReport(report: LateralBoundaryReport): LateralBoundaryReport {
  const cap = <T>(xs: readonly T[]) => xs.slice(0, REPORT_LIST_CAP);
  const why = <T extends { why: string }>(xs: readonly T[]) =>
    cap(xs).map((x) => ({ ...x, why: clip(x.why) }));
  return {
    ...report,
    why: clip(report.why),
    conflicts: why(report.conflicts),
    deferred: why(report.deferred),
    reconcile: cap(report.reconcile).map((r) => ({
      ...r,
      why: r.why === null ? null : clip(r.why),
    })),
    directions: report.directions.map((d) => ({
      ...d,
      why: clip(d.why),
      writes: cap(d.writes),
      deletes: cap(d.deletes),
      held: cap(d.held).map((h) => ({ ...h, note: h.note === null ? null : clip(h.note) })),
      keptDeletions: why(d.keptDeletions),
      deletionRefusal: d.deletionRefusal === null ? null : clip(d.deletionRefusal),
      outOfScope: cap(d.outOfScope),
      declined: cap(d.declined),
      unread: cap(d.unread),
      merge: d.merge === null ? null : clip(d.merge),
    })),
  };
}

/**
 * One ledger row: the state the next slot reads back, and the report a person reads.
 *
 * Both halves in ONE row, because they are one fact. A state row beside a
 * separate report row is two writes that can disagree about which pass they
 * describe — and the panel would then show one exchange while the lane acted
 * on another.
 */
export function composeLateralLedgerRow(args: {
  event: LateralLedgerEvent;
  state: LateralLedgerState;
  report: LateralBoundaryReport | null;
  trigger: string | null;
  heads: Readonly<Record<string, string>> | null;
}): Record<string, unknown> {
  return {
    v: 1,
    event: args.event,
    fingerprint: args.state.fingerprint,
    paused: args.state.paused,
    deferred: args.state.deferred,
    proposals: args.state.proposals,
    memo: args.state.memo,
    trigger: args.trigger,
    heads: args.heads,
    report: args.report ? compactLateralReport(args.report) : null,
  };
}

/**
 * The report a row carries, or null where it cannot be read as one.
 *
 * Shallow and tolerant, like every reader of this ledger: a row this build
 * cannot fully parse is shown as no report rather than half of one, because a
 * panel that draws part of an exchange draws an exchange that did not happen.
 */
export function readLateralReport(raw: unknown): LateralBoundaryReport | null {
  if (!raw || typeof raw !== "object") return null;
  const report = (raw as Record<string, unknown>).report;
  if (!report || typeof report !== "object") return null;
  const r = report as Record<string, unknown>;
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (
    typeof r.boundary !== "string" ||
    typeof r.outcome !== "string" ||
    typeof r.why !== "string"
  ) {
    return null;
  }
  if (!Array.isArray(r.directions) || !Array.isArray(r.reconcile)) return null;
  for (const d of r.directions as unknown[]) {
    const x = d as Record<string, unknown>;
    if (
      typeof x?.from !== "string" ||
      typeof x.to !== "string" ||
      typeof x.outcome !== "string" ||
      !strings(x.writes) ||
      !strings(x.deletes) ||
      !Array.isArray(x.held)
    ) {
      return null;
    }
  }
  return report as LateralBoundaryReport;
}
