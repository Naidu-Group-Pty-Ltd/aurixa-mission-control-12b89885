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
 * A file whose content on the clone CHANGES: prime's file written verbatim,
 * or a file removed. Not the forward half's `deliveredPaths`, which also
 * counts every path a reconcile pump decided — including a pump's steady
 * state, where the merged file IS the clone's own and nothing is written. The
 * first replay read that as a change and held the clone's own
 * `crmConversations.spec.ts` under "this delivery updates
 * supabase/config.toml" on a delivery that wrote no `config.toml` at all. A
 * pump that does write merges prime's additions into the clone's own file and
 * keeps the clone's declarations by construction, so a spec about it is
 * judged by the merge, as the forward half already judges one.
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

/** Every `@/` or relative specifier in `source`, resolved against prime's tree. */
function resolvedImports(source: string, importer: string, prime: TreeIndex): string[] {
  const out: string[] = [];
  for (const specifier of importsOf(source)) {
    const target = resolveSpecifier(specifier, importer, prime);
    if (target !== null) out.push(target);
  }
  return out;
}

/**
 * The files a spec asserts about, as far as its own text says.
 *
 * `readText` answers for the modules it imports, so a re-export shim can be
 * looked through; a module it cannot read is kept as a subject and simply not
 * looked through, which can only narrow what is found, never invent it.
 * `onUnread` names each module whose text was asked for and not available,
 * so a caller can read those and ask again.
 */
export function specSubjects(args: {
  specPath: string;
  specText: string;
  prime: TreeIndex;
  readText: (path: string) => string | undefined;
  onUnread?: (path: string) => void;
}): string[] {
  const { specPath, specText, prime, readText, onUnread } = args;
  const found = new Set<string>([
    ...subjectsNamedBy(specText, specPath),
    ...subjectsNamedOutsideRoots(specText, specPath),
  ]);

  const direct = resolvedImports(specText, specPath, prime);
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
      for (const target of resolvedImports(text, module, prime)) {
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

/** A spec this clone keeps, and the files crossing now that it asserts about. */
export type LeftBehindSpec = { spec: string; touchedBy: string[] };

/**
 * The kept specs a delivery would leave behind: not crossing themselves, with
 * at least one subject that is. Sorted by spec, and each `touchedBy` sorted,
 * so a pass asks the same questions in the same order every time.
 */
export function specsLeftBehind(args: {
  /** Kept spec → its subjects, as `specSubjects` read them. */
  kept: ReadonlyMap<string, readonly string[]>;
  /** Every path the delivery writes or removes. */
  crossing: ReadonlySet<string>;
}): LeftBehindSpec[] {
  const out: LeftBehindSpec[] = [];
  for (const spec of [...args.kept.keys()].sort()) {
    if (args.crossing.has(spec)) continue;
    const touchedBy = [...new Set(args.kept.get(spec) ?? [])]
      .filter((subject) => subject !== spec && args.crossing.has(subject))
      .sort();
    if (touchedBy.length > 0) out.push({ spec, touchedBy });
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
 * The held row for a spec this clone keeps whose subject crossed without it.
 *
 * `manual_reconcile`, so it is reported under "Needs a human" and an operator
 * may approve overwriting it — which is the one act that settles it when the
 * clone's copy carries work of its own. The note names the subjects that
 * crossed, because that is what the operator has to reconcile the spec
 * against, and says why prime's copy stayed put.
 */
export function leftBehindSpecHold(args: {
  membrane: Pick<Membrane, "from" | "to">;
  spec: string;
  touchedBy: readonly string[];
  /** A refusal from `decideHoldRelease`, in its own words. */
  why?: string;
  cutShort?: LeftBehindCutShort;
}): HeldPath {
  const { membrane, spec, touchedBy } = args;
  const named = touchedBy.slice(0, 3).join(", ");
  const more = touchedBy.length > 3 ? ` (and ${touchedBy.length - 3} more)` : "";
  const reason = args.cutShort
    ? `Prime's version did not travel with them because ${LEFT_BEHIND_CUT_SHORT[args.cutShort]}.`
    : `Prime's version did not travel with them: ${args.why ?? "prime's history for this spec was not read this pass."}`;
  return {
    path: spec,
    pattern: `(membrane: ${membrane.from}→${membrane.to} · spec channel: left behind by its subject)`,
    reason: "manual_reconcile",
    note:
      `This clone keeps its own version of this spec, and this delivery updates ` +
      `${touchedBy.length} file(s) it asserts about: ${named}${more}. ${reason} Until it is ` +
      `reconciled, this spec's older assertions run against the updated files — a spec and its ` +
      `subject travel together or neither does, so bring prime's version across or update this ` +
      `clone's to match.`,
  };
}

/**
 * A spec the forward half held after it was brought in behind its subject.
 *
 * That hold's note speaks for PRIME's copy — which of its own subjects could
 * not travel. It cannot know the spec was only brought in because this
 * clone's older copy was being left behind, and that the older copy is what
 * stays. Both halves are said, so the operator reconciles against the right
 * files.
 */
export function withLeftBehindNote(hold: HeldPath, touchedBy: readonly string[]): HeldPath {
  const named = touchedBy.slice(0, 3).join(", ");
  const more = touchedBy.length > 3 ? ` (and ${touchedBy.length - 3} more)` : "";
  const addition =
    `It was brought in because this delivery updates ${named}${more}, which this clone's own ` +
    `older copy asserts about; that older copy is what stays, so reconcile it against the ` +
    `updated files.`;
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
 * reader of the diff would otherwise meet them with no reason given.
 */
export function describeSpecsBroughtAcross(args: {
  specs: ReadonlyArray<{ spec: string; touchedBy: readonly string[]; basis: CarryBasis }>;
  outside: ReadonlyArray<{ path: string; specs: readonly string[]; basis: CarryBasis }>;
}): string {
  const lines: string[] = [];
  for (const s of [...args.specs].sort((a, b) => a.spec.localeCompare(b.spec))) {
    lines.push(
      `- \`${s.spec}\` — follows ${nameSome(s.touchedBy)}, which this delivery updates; ${BASIS_WORDS[s.basis]}.`,
    );
  }
  for (const o of [...args.outside].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(
      `- \`${o.path}\` — carried beside ${nameSome(o.specs)}, which asserts about it; ${BASIS_WORDS[o.basis]}.`,
    );
  }
  return lines.join("\n");
}
