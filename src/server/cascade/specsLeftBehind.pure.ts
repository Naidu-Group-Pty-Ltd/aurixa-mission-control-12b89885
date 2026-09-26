/**
 * THE OTHER HALF OF THE SPEC CHANNEL — a spec this clone keeps, left behind
 * by the file it asserts about.
 *
 * The membrane's spec channel rests on one sentence, which the clones' own
 * CLAUDE.md states: *a spec and its subject travel together or neither does.*
 * Until this module only one direction of it was enforced. A spec the
 * delivery CARRIES either brings its subject in behind it or is held
 * (`strandedSubjects`, `planSubjectCarry`). Nothing looked the other way: a
 * subject the delivery carries, asserted about by a spec it does NOT carry.
 *
 * ## What that cost
 *
 * On a mirror nothing, because a mirror's candidates are every file whose
 * blob differs: a spec that is behind is delivered with everything else. On a
 * module-scoped clone it is the common case. The installed globs are drawn
 * around features, a test directory is shared by many features, and the
 * import closure and the subject carry both bring prime's files in from
 * outside the globs — so a file crosses while the clone's own copy of the spec
 * that tests it stays at an older version, and CI runs the old assertions
 * against the new file.
 *
 * Measured on `npc-crm-independent-6505dc`, cascade PR #26 (prime@885b324):
 * 254 files crossed and `verify` failed six assertions in four specs, every
 * one of them a spec the clone holds at an older version than prime's, not in
 * the delivery, whose subject was. Replayed through the current engine, two of
 * the four were already carried by the forward half's newer subject rules; the
 * other two — `geocoderWiring.spec.ts` and `osmGeocode.spec.ts` — are this.
 * `osmGeocode.spec.ts` is also why imports alone are not enough: it imports
 * `src/lib/geocode/osmGeocode.pure.ts`, which is byte-identical on both sides
 * and only re-exports the edge module that crossed.
 *
 * ## What counts as a subject here
 *
 * Three kinds, each read from the spec's own text:
 *
 *   · a path it NAMES — `subjectsNamedBy`, the forward half's rule, and
 *     `subjectsNamedOutsideRoots` for a file outside the content roots, so
 *     both directions agree on what a named subject is;
 *   · a module it IMPORTS, in either specifier form (`importsOf`,
 *     `resolveSpecifier` — the import closure's own reader); and
 *   · behind an imported module that does nothing but re-export, the module it
 *     re-exports. A shim adds no behaviour, so what the spec tests is its
 *     target; `src/lib/workflow/*` onto `_shared/workflow/` is the pattern.
 *
 * Deliberately NOT the transitive import graph. Measured on the same
 * cascade: following every import triggers 16 specs and would pull six more
 * files behind them, including `src/integrations/supabase/env.ts` — a
 * PROTECTED path naming the clone's own backend — while the three kinds above
 * trigger 14 and catch all four failing specs. A spec that imports an
 * unchanged module whose own dependency changed is asserting about that
 * module, not about the dependency.
 *
 * ## What this module does not decide
 *
 * Whether a left-behind spec may be REPLACED. That is `decideHoldRelease`'s
 * question, asked by the engine: the spec is not in this clone's scope and no
 * rule sent it, so it moves only where the clone's copy is byte-identical to a
 * version prime itself held — nothing of the clone's is lost — or an operator
 * recorded an overwrite approval. Everything else is held for a person, with
 * the subject that crossed named.
 *
 * ## What counts as crossing
 *
 * A file whose content on the clone CHANGES, and nothing else
 * (`pathsTheDeliveryChanges`). Three ways to change one:
 *
 *   · prime's file written verbatim — always a change, because a path whose
 *     blob already matches is never prepared at all;
 *   · a reconcile pump's merge, but only where the merge differs from the
 *     clone's file. A pump's steady state writes the clone's own bytes back,
 *     and the first replay read that as a change: it held the clone's own
 *     `crmConversations.spec.ts` under "this delivery updates
 *     supabase/config.toml" on a delivery that wrote no `config.toml`. The
 *     next draft excluded every pumped path instead, which was wrong the other
 *     way — a pump that DOES change `config.toml` changes it, and a spec about
 *     it must be judged. A pump that writes merges prime's additions into the
 *     clone's own file and keeps the clone's declarations by construction, so
 *     a spec about it is judged by the merge, as the forward half already
 *     judges one;
 *   · a removal — one the finished deletion plan makes. A deletion verdict is
 *     provisional until the reference check and the bulk cap have spoken, and
 *     either can withhold it: judged against the provisional set, a spec could
 *     be replaced for a file that then stayed exactly as it was.
 *
 * Not the forward half's `deliveredPaths`, which counts every path a pump
 * DECIDED — the right question for a spec the delivery carries, and the wrong
 * one here.
 *
 * ## Each copy is read against its own tree
 *
 * The clone's copy of a kept spec is the one CI runs, and what it imports is
 * resolved against the CLONE's tree and read from the clone. Resolved against
 * prime's, an import of a module only the clone holds resolves to nothing: a
 * deletion of that module then looked like no change to the spec that imports
 * it, and nothing else in the delivery holds such a spec — it is neither
 * clone-only nor held. Prime's copy is resolved against prime's tree, because
 * it is prime's version that would land. A module byte-identical on both
 * sides is read once.
 *
 * ## The spec prime's version replaces may need a file of its own
 *
 * Prime's current copy can assert about a file the clone holds at an older
 * version that no delivery would carry — `reportTypography.spec.ts` reads a
 * document under `.claude/`, outside every root the channel read. So before a
 * spec is brought across, the files outside the content roots that prime's
 * copy names are put to the same evidence question
 * (`outsideRootSubjects.pure.ts`); a spec whose question could not be asked
 * this pass stays where it is, held and saying why.
 *
 * Pure: no I/O. The engine reads the texts and asks prime's history.
 */

import { isSpecPath } from "@/lib/cascade/membrane/ionSpecies.pure";
import { subjectsNamedBy, type Membrane } from "@/lib/cascade/membrane/membrane.pure";
import { importsOf, resolveSpecifier, stripComments, type TreeIndex } from "./importClosure.pure";
import { MAX_OUTSIDE_ROOT_PROBES, subjectsNamedOutsideRoots } from "./outsideRootSubjects.pure";
import type { HeldPath } from "./syncExclusions.pure";

/** Source a spec's subjects can be read from. A fixture is data, not a spec. */
const WALKABLE = /\.[cm]?[jt]sx?$/;

/** How far a chain of re-export shims is followed from one import. */
export const MAX_SHIM_HOPS = 4;

/**
 * One re-export statement: `export * from '…'`, `export * as ns from '…'`,
 * `export { a, b as c } from '…'`, `export type { T } from '…'`. The brace
 * list may span lines.
 */
const RE_EXPORT =
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]\s*;?/g;

/**
 * Whether a module does nothing but re-export.
 *
 * Every statement left once comments are gone must be a re-export, and there
 * must be at least one. A module that re-exports AND adds anything — a
 * default, a wrapper, a constant — has behaviour of its own and is a subject
 * in its own right, so it is not looked through.
 */
export function isReExportShim(source: string): boolean {
  let found = 0;
  const rest = stripComments(source).replace(RE_EXPORT, () => {
    found += 1;
    return "";
  });
  return found > 0 && /^[\s;]*$/.test(rest);
}

/** Every `@/` or relative specifier in `source`, resolved against `tree`. */
function resolvedImports(source: string, importer: string, tree: TreeIndex): string[] {
  const out: string[] = [];
  for (const specifier of importsOf(source)) {
    const target = resolveSpecifier(specifier, importer, tree);
    if (target !== null) out.push(target);
  }
  return out;
}

/**
 * The files a spec asserts about, as far as its own text says.
 *
 * `tree` is the tree the text belongs to: its imports resolve there and
 * nowhere else, and `readText` answers from the same side. `readText` answers
 * for the modules it imports, so a re-export shim can be looked through; a
 * module it cannot read is kept as a subject and simply not looked through,
 * which can only narrow what is found, never invent it. `onUnread` names each
 * module whose text was asked for and not available, so a caller can read
 * those and ask again.
 */
export function specSubjects(args: {
  specPath: string;
  specText: string;
  tree: TreeIndex;
  readText: (path: string) => string | undefined;
  onUnread?: (path: string) => void;
}): string[] {
  const { specPath, specText, tree, readText, onUnread } = args;
  const found = new Set<string>([
    ...subjectsNamedBy(specText, specPath),
    ...subjectsNamedOutsideRoots(specText, specPath),
  ]);

  const direct = resolvedImports(specText, specPath, tree);
  for (const path of direct) found.add(path);

  // Through shims only. Each hop reads modules the previous hop reached, and
  // only a module that is nothing but re-exports is followed further.
  const seen = new Set<string>(direct);
  let frontier = direct;
  for (let hop = 0; hop < MAX_SHIM_HOPS && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const module of frontier) {
      if (!WALKABLE.test(module)) continue;
      const text = readText(module);
      if (text === undefined) {
        onUnread?.(module);
        continue;
      }
      if (!isReExportShim(text)) continue;
      for (const target of resolvedImports(text, module, tree)) {
        if (seen.has(target)) continue;
        seen.add(target);
        found.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }

  return [...found].sort();
}

/** One repository's copy of a kept spec, and how to read that repository. */
export type SpecSide = {
  /** Which repository this is: where its modules are read from. */
  side: "prime" | "clone";
  /** This side's text of the spec, or undefined where it was not read. */
  text: string | undefined;
  /** This side's tree. The text's imports resolve here and nowhere else. */
  tree: TreeIndex;
  /** This side's text of a module, for looking through a shim. */
  readText: (path: string) => string | undefined;
};

/**
 * A kept spec's subjects: what either copy asserts about, each read against
 * its own tree.
 *
 * Both copies, because either may name what the other does not — prime's is
 * the version that would land, the clone's is the one CI runs now. Each
 * against its OWN tree, because an import resolves where its text lives: the
 * clone's copy importing a module only the clone holds names that module,
 * and read against prime's tree it named nothing. `onUnread` says which side
 * a module was not read from, so the caller reads it from that repository.
 */
export function subjectsOfKeptSpec(args: {
  specPath: string;
  sides: readonly SpecSide[];
  onUnread?: (side: SpecSide["side"], path: string) => void;
}): string[] {
  const found = new Set<string>();
  for (const s of args.sides) {
    if (s.text === undefined) continue;
    const onUnread = args.onUnread;
    for (const subject of specSubjects({
      specPath: args.specPath,
      specText: s.text,
      tree: s.tree,
      readText: s.readText,
      onUnread: onUnread ? (path) => onUnread(s.side, path) : undefined,
    })) {
      found.add(subject);
    }
  }
  return [...found].sort();
}

/**
 * What this delivery changes on the clone — the one set every question this
 * half asks about crossing is asked against.
 *
 * A write counts where it changes the clone's file: every verbatim write does,
 * and a reconcile pump's does only where its merge differs from the clone's
 * copy (`reconcileWrites`). A rehearsal composes no entry for three of the
 * pumps, so what those would write arrives as `rehearsed`, and a dry run
 * answers as the real pass would. A removal counts only where the finished
 * deletion plan makes it; an entry that removes is not read here, because the
 * plan, not the tree being composed, is where a removal is decided.
 */
export function pathsTheDeliveryChanges(args: {
  /** The tree the delivery composes. `sha: null` removes; anything else writes. */
  entries: ReadonlyArray<{ path: string; sha?: string | null }>;
  /** Every path a reconcile pump decided, whether or not its merge changed the file. */
  reconciled: ReadonlySet<string>;
  /** The decided paths whose merge differs from the clone's copy: a real write. */
  reconcileWrites: ReadonlySet<string>;
  /** A rehearsal's pump writes that composed no tree entry. */
  rehearsed: ReadonlySet<string>;
  /** The removals the finished deletion plan makes. Never a provisional verdict. */
  removing: ReadonlySet<string>;
}): Set<string> {
  const out = new Set<string>();
  for (const e of args.entries) {
    if (e.sha === null) continue;
    if (args.reconciled.has(e.path) && !args.reconcileWrites.has(e.path)) continue;
    out.add(e.path);
  }
  for (const path of args.rehearsed) out.add(path);
  for (const path of args.removing) out.add(path);
  return out;
}

/**
 * The specs this clone keeps at a different version from prime's.
 *
 * Both sides hold the path and the blobs differ — the only specs a delivery
 * can leave behind. A spec the clone lacks is not run there; a spec prime
 * lacks has no newer version to bring. Source files only, sorted.
 */
export function specsBothSidesHoldDifferently(args: {
  primeSha: TreeIndex;
  cloneSha: TreeIndex;
}): string[] {
  const out: string[] = [];
  for (const [path, onClone] of args.cloneSha) {
    if (!isSpecPath(path) || !WALKABLE.test(path)) continue;
    const onPrime = args.primeSha.get(path);
    if (onPrime === undefined || onPrime === onClone) continue;
    out.push(path);
  }
  return out.sort();
}

/**
 * A spec this clone keeps, and the files crossing now that it asserts about.
 * `removed` is the part of `touchedBy` the delivery removes rather than writes.
 */
export type LeftBehindSpec = { spec: string; touchedBy: string[]; removed: string[] };

/**
 * The kept specs a delivery would leave behind: not crossing themselves, with
 * at least one subject that is. Sorted by spec, and each list sorted, so a
 * pass asks the same questions in the same order every time.
 */
export function specsLeftBehind(args: {
  /** Kept spec → its subjects, as `subjectsOfKeptSpec` read them. */
  kept: ReadonlyMap<string, readonly string[]>;
  /** Every path the delivery changes: written or removed. */
  crossing: ReadonlySet<string>;
  /** The paths in `crossing` the delivery removes. */
  removing?: ReadonlySet<string>;
}): LeftBehindSpec[] {
  const out: LeftBehindSpec[] = [];
  for (const spec of [...args.kept.keys()].sort()) {
    if (args.crossing.has(spec)) continue;
    const touchedBy = [...new Set(args.kept.get(spec) ?? [])]
      .filter((subject) => subject !== spec && args.crossing.has(subject))
      .sort();
    if (touchedBy.length === 0) continue;
    const removed = touchedBy.filter((subject) => args.removing?.has(subject) ?? false);
    out.push({ spec, touchedBy, removed });
  }
  return out;
}

/**
 * How many left-behind specs one pass checks against prime's history.
 *
 * Each check is the hold-release probe — one commit listing and a read per
 * version walked, newest first, stopping at the clone's copy. Measured on
 * `npc-crm-independent-6505dc` at prime@885b324: every left-behind spec was
 * one to three versions behind, so a check costs two to four requests and a
 * pass that meets this ceiling has spent about a hundred. Past it the spec is
 * held and says so; nothing is carried unchecked.
 */
export const MAX_LEFT_BEHIND_PROBES = 32;

/**
 * Why a left-behind spec did not follow its subject this pass, where the
 * reason is not a verdict about the spec's own history.
 *
 * "We could not" and "we did not get to" send an operator to opposite places,
 * so these are said in words of their own rather than folded into the
 * evidence rule's refusal: each clears by itself on a later pass.
 */
export type LeftBehindCutShort = "budget" | "ceiling" | "probes" | "outside_probes";

const LEFT_BEHIND_CUT_SHORT: Record<LeftBehindCutShort, string> = {
  budget:
    "this pass ran out of its time budget before it could bring prime's version across; the next one resumes from here",
  ceiling:
    "this pass reached the ceiling on how many files one delivery may carry in behind another; the next one continues",
  probes: `this pass reached its limit of ${MAX_LEFT_BEHIND_PROBES} specs checked against prime's history; the next one continues`,
  outside_probes: `prime's version also asserts about a file outside the content roots, and this pass reached its limit of ${MAX_OUTSIDE_ROOT_PROBES} such files checked against prime's history before it got to that one; the next one continues`,
};

/**
 * What a kept spec's subjects are doing in the finished delivery, which is
 * what every note about the spec has to say.
 */
export type LeftBehindTouch = {
  /** Subjects this delivery changes: written or removed. */
  touchedBy: readonly string[];
  /** The part of `touchedBy` this delivery removes rather than writes. */
  removed?: readonly string[];
  /**
   * Subjects prime deleted whose removal this delivery withholds, because a
   * file this clone keeps still imports them. Known only once the delivery is
   * final: the removals are narrowed after every spec has been judged.
   */
  withheld?: readonly string[];
};

/** Up to three paths, then how many more. */
function listSome(paths: readonly string[], shown = 3): string {
  const named = paths.slice(0, shown).join(", ");
  return paths.length > shown ? `${named} (and ${paths.length - shown} more)` : named;
}

/** `touchedBy` split into what the delivery writes and what it removes. */
function splitTouch(touch: LeftBehindTouch): { updated: string[]; gone: string[] } {
  const removed = new Set(touch.removed ?? []);
  return {
    updated: touch.touchedBy.filter((path) => !removed.has(path)),
    gone: touch.touchedBy.filter((path) => removed.has(path)),
  };
}

const WITHHELD_BECAUSE =
  "that removal is withheld this pass because a file this clone keeps still imports it";

/**
 * The held row for a spec this clone keeps whose subject crossed without it.
 *
 * `manual_reconcile`, so it is reported under "Needs a human" and an operator
 * may approve overwriting it — which is the one act that settles it when the
 * clone's copy carries work of its own. The note names the subjects that
 * crossed, because that is what the operator has to reconcile the spec
 * against; says which of them the delivery removes, because "runs against
 * the updated files" is false of a file that is gone; and says why prime's
 * copy stayed put.
 *
 * Written again once the delivery is final, from what it finally does. A
 * removal withheld after the spec was judged is named as withheld, and the
 * hold stays: the clone's older copy still asserts about a file prime deleted,
 * and bringing prime's version across is how that is settled.
 */
export function leftBehindSpecHold(
  args: {
    membrane: Pick<Membrane, "from" | "to">;
    spec: string;
    /** A refusal from `decideHoldRelease`, in its own words. */
    why?: string;
    cutShort?: LeftBehindCutShort;
  } & LeftBehindTouch,
): HeldPath {
  const { membrane, spec } = args;
  const { updated, gone } = splitTouch(args);
  const withheld = args.withheld ?? [];
  const reason = args.cutShort
    ? `Prime's version did not travel with them because ${LEFT_BEHIND_CUT_SHORT[args.cutShort]}.`
    : `Prime's version did not travel with them: ${args.why ?? "prime's history for this spec was not read this pass."}`;

  let change: string;
  if (updated.length > 0 && gone.length === 0) {
    change = `this delivery updates ${updated.length} file(s) it asserts about: ${listSome(updated)}.`;
  } else if (updated.length > 0) {
    change =
      `this delivery updates ${updated.length} file(s) it asserts about (${listSome(updated)}) ` +
      `and removes ${gone.length} that prime deleted (${listSome(gone)}).`;
  } else if (gone.length > 0) {
    change = `this delivery removes ${gone.length} file(s) it asserts about, which prime deleted: ${listSome(gone)}.`;
  } else if (withheld.length > 0) {
    change = `it asserts about ${withheld.length} file(s) prime deleted: ${listSome(withheld)}.`;
  } else {
    change = "this delivery changes nothing it asserts about.";
  }

  const touched = updated.length + gone.length > 0;
  const withheldNote =
    withheld.length === 0
      ? ""
      : touched
        ? ` Prime also deleted ${listSome(withheld)}, which it asserts about; ${WITHHELD_BECAUSE}.`
        : ` This delivery withholds that removal because a file this clone keeps still imports it.`;
  const closing = !touched
    ? "Nothing it asserts about changes on this pass. A spec and its subject travel together " +
      "or neither does, so bring prime's version across or update this clone's to match."
    : `Until it is reconciled, this spec's older assertions run against ` +
      `${updated.length > 0 ? "the updated files" : "a tree without them"} — a spec and its ` +
      `subject travel together or neither does, so bring prime's version across or update this ` +
      `clone's to match.`;

  return {
    path: spec,
    pattern: `(membrane: ${membrane.from}→${membrane.to} · spec channel: left behind by its subject)`,
    reason: "manual_reconcile",
    note: `This clone keeps its own version of this spec, and ${change}${withheldNote} ${reason} ${closing}`,
  };
}

/**
 * A spec the forward half held after it was brought in behind its subject.
 *
 * That hold's note speaks for PRIME's copy — which of its own subjects could
 * not travel. It cannot know the spec was only brought in because this
 * clone's older copy was being left behind, and that the older copy is what
 * stays. Both halves are said, so the operator reconciles against the right
 * files. Written again once the delivery is final, like every hold this half
 * makes; a touch with nothing in it leaves the hold as it was.
 */
export function withLeftBehindNote(hold: HeldPath, touch: LeftBehindTouch): HeldPath {
  const { updated, gone } = splitTouch(touch);
  const withheld = touch.withheld ?? [];
  let addition: string;
  if (updated.length + gone.length > 0) {
    const what =
      gone.length === 0
        ? `updates ${listSome(updated)}`
        : updated.length === 0
          ? `removes ${listSome(gone)}`
          : `updates ${listSome(updated)} and removes ${listSome(gone)}`;
    addition =
      `It was brought in because this delivery ${what}, which this clone's own older copy ` +
      `asserts about; that older copy is what stays, so reconcile it against ` +
      `${updated.length > 0 ? "the updated files" : "a tree without them"}.`;
    if (withheld.length > 0) {
      addition += ` Prime also deleted ${listSome(withheld)}, which it asserts about; ${WITHHELD_BECAUSE}.`;
    }
  } else if (withheld.length > 0) {
    addition =
      `It was brought in because prime deleted ${listSome(withheld)}, which this clone's own ` +
      `older copy asserts about. That older copy is what stays, and ${WITHHELD_BECAUSE}.`;
  } else {
    return hold;
  }
  return { ...hold, note: hold.note ? `${hold.note} ${addition}` : addition };
}

/** How a file came to be carried on evidence: never edited here, or an operator's approval. */
export type CarryBasis = "unedited" | "approved";

const BASIS_WORDS: Record<CarryBasis, string> = {
  unedited: "this clone's copy was byte-identical to an older version of prime's",
  approved: "an operator recorded an overwrite approval for it",
};

/** One file, then how many more: the list a note names without running long. */
function nameSome(paths: readonly string[], shown = 3): string {
  const named = paths
    .slice(0, shown)
    .map((p) => `\`${p}\``)
    .join(", ");
  return paths.length > shown ? `${named} (and ${paths.length - shown} more)` : named;
}

/**
 * The pull request body's section on specs brought up to date with the files
 * they test, and on files carried beside a spec because it asserts about them.
 * Empty when neither happened.
 *
 * Neither is in this clone's scope and no rule of its own sent them, so a
 * reader of the diff would otherwise meet them with no reason given. A spec
 * is named for what the FINISHED delivery does to the files it follows —
 * which can be less than when it was brought across, because a file can be
 * held later in the pass or a removal withheld; those are named as
 * `unchanged`, since prime's version still landed.
 */
export function describeSpecsBroughtAcross(args: {
  specs: ReadonlyArray<{
    spec: string;
    touchedBy: readonly string[];
    removed?: readonly string[];
    unchanged?: readonly string[];
    basis: CarryBasis;
  }>;
  outside: ReadonlyArray<{ path: string; specs: readonly string[]; basis: CarryBasis }>;
}): string {
  const lines: string[] = [];
  for (const s of [...args.specs].sort((a, b) => a.spec.localeCompare(b.spec))) {
    const { updated, gone } = splitTouch(s);
    const unchanged = s.unchanged ?? [];
    let follows: string;
    if (updated.length + gone.length > 0) {
      follows =
        gone.length === 0
          ? `follows ${nameSome(updated)}, which this delivery updates`
          : updated.length === 0
            ? `follows ${nameSome(gone)}, which this delivery removes`
            : `follows ${nameSome(updated)}, which this delivery updates, and ${nameSome(gone)}, which it removes`;
      if (unchanged.length > 0) {
        follows += ` (it was also brought across for ${nameSome(unchanged)}, which this delivery no longer changes)`;
      }
    } else if (unchanged.length > 0) {
      follows = `was brought across for ${nameSome(unchanged)}, which this delivery no longer changes`;
    } else {
      follows = "was brought across with the files it asserts about";
    }
    lines.push(`- \`${s.spec}\` — ${follows}; ${BASIS_WORDS[s.basis]}.`);
  }
  for (const o of [...args.outside].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(
      `- \`${o.path}\` — carried beside ${nameSome(o.specs)}, which asserts about it; ${BASIS_WORDS[o.basis]}.`,
    );
  }
  return lines.join("\n");
}
