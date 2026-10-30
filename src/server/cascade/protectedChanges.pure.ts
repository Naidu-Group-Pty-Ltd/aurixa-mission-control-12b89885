/**
 * A FILE THIS CLONE KEEPS AS ITS OWN, AND PRIME CHANGED, IS NAMED.
 *
 * ## What it cost
 *
 * A path a `protected` exclusion row matches is never written, by design, and
 * every proposal counted those paths in one closing line: "N further path(s)
 * are owned by this clone and were withheld without comment". On 30 Oct 2026
 * prime ca5009825 changed `.gitleaks.toml` together with the script whose
 * planted key it allows. The script travelled, the allowance did not, and
 * `security` went red on all five clones' proposals. Not one line of any of
 * them pointed at the file. The silence was the cost, not the hold.
 *
 * ## The rule (the owner's decision, 30 Oct 2026)
 *
 * A proposal names every path that a protected exclusion row withheld and that
 * prime changed in the range it delivers: from the prime revision the clone
 * last took (`clones.last_synced_sha`) to the one this proposal carries. A
 * path that merely differs, because the clone has always kept its own copy,
 * stays in the count. A section naming every path that differs would fill on
 * every pass and teach readers to skip it.
 *
 * Only exclusion rows. A hold whose pattern the engine composed, in
 * parentheses, is a boundary rather than a copy this clone keeps: a prime-only
 * feature, another CRM line's feature or another deployment's own tree. A
 * spec the independent CRM line keeps is one of those too; where a file it
 * tests crosses, `keptSpecRelease.pure.ts` lists it with what it lacks. A path
 * a reconcile decided (`config.toml`, `.gitleaks.toml`, the deploy workflow)
 * has its own section, and a refusal is already under "Needs a human".
 *
 * ## A question that was not answered says so
 *
 * GitHub's comparison lists at most 300 changed files for a whole range. A
 * range that reaches the ceiling is not a range in which the other paths did
 * not change, so each protected path the list does not name is asked by its
 * blob at both ends. A path that cannot be asked, or a comparison that cannot
 * be read, is named as not asked, never as unchanged.
 */
import type { HeldPath } from "./syncExclusions.pure";

/** GitHub's ceiling on the files one comparison lists, for the whole range. */
export const COMPARE_FILE_CEILING = 300;

/** Paths asked one by one where the comparison reached its ceiling. */
export const MAX_PROTECTED_PROBES = 20;

/**
 * The holds this question is about: protected by an exclusion row, not
 * decided by a reconcile, not already named for a person. One per path,
 * in path order.
 */
export function protectedOwnCopies(
  held: readonly HeldPath[],
  decided: ReadonlySet<string>,
  named: ReadonlySet<string>,
): HeldPath[] {
  const out = new Map<string, HeldPath>();
  for (const h of held) {
    if (h.reason !== "protected" || h.pattern.startsWith("(")) continue;
    if (decided.has(h.path) || named.has(h.path) || out.has(h.path)) continue;
    out.set(h.path, h);
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** What the comparison's file list says about the candidates. */
export function readComparison(args: {
  candidates: readonly HeldPath[];
  /** Every path the comparison names, a rename's old name included. */
  files: Iterable<string>;
  /** Whether the list reached `COMPARE_FILE_CEILING`, and may be missing paths. */
  truncated: boolean;
}): { changed: HeldPath[]; unseen: HeldPath[] } {
  const listed = new Set(args.files);
  const changed = args.candidates.filter((h) => listed.has(h.path));
  const unseen = args.truncated ? args.candidates.filter((h) => !listed.has(h.path)) : [];
  return { changed, unseen };
}

export type ProtectedChanges = {
  /** The prime revisions compared, oldest first. */
  base: string;
  head: string;
  /** Paths prime changed in the range. */
  changed: HeldPath[];
  /** Paths whose answer is not known, with why. */
  notAsked: HeldPath[];
  why: string | null;
};

const short = (sha: string) => sha.slice(0, 7);

/**
 * The proposal's section. Empty where prime changed none of them and nothing
 * went unasked, so the section is left out.
 */
export function describeProtectedChanges(pc: ProtectedChanges | null): string {
  if (!pc || (pc.changed.length === 0 && pc.notAsked.length === 0)) return "";
  const range = `prime@${short(pc.base)} and prime@${short(pc.head)}`;
  const lines: string[] = [];
  if (pc.changed.length > 0) {
    lines.push(
      `Each path below is **protected** by this clone's exclusion policy, so prime's copy was ` +
        `not written, and prime changed it between ${range}. Nothing here is wrong by itself. ` +
        `If this proposal fails a check that reads one of these files, start here: prime may ` +
        `have changed the file and what it governs together, as it did with \`.gitleaks.toml\` ` +
        `on 30 Oct 2026.`,
      "",
      ...pc.changed.map((h) => `- \`${h.path}\`${h.note ? ` — ${h.note}` : ""}`),
    );
  }
  if (pc.notAsked.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `Whether prime changed ${pc.notAsked.length === 1 ? "this path" : `these ${pc.notAsked.length} paths`} ` +
        `between ${range} could not be asked${pc.why ? `: ${pc.why}` : ""}. Not asked is not ` +
        `unchanged.`,
      "",
      ...pc.notAsked.map((h) => `- \`${h.path}\``),
    );
  }
  return lines.join("\n");
}
