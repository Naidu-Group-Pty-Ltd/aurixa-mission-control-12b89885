/**
 * The functions the prime has retired, which no clone should still run.
 *
 * ## Why this exists
 *
 * Deleting a function's directory does not undeploy it. The deploy lanes ship
 * what a tree declares and never remove anything, so a retired function stays
 * callable until something deletes it, and nothing that reads a repository can
 * see it. The prime deletes its own with two reviewed workflows. Each holds a
 * `RETIRED='…'` list and says, name by name, when and why the function was
 * retired:
 *
 * - `decommission-retired-functions.yml` (`street-view` and five more);
 * - `decommission-builder-portal-functions.yml` (the Builder / Developer
 *   Portal's twenty-eight).
 *
 * Both resolve the project from the repository they run in, "so a clone that
 * inherits this file deletes from ITS OWN project". No clone ever runs them:
 * its CI stands down because this platform deploys its project, and it holds
 * no deploy token. So nothing took them off a clone. Measured 27 Oct 2026, the
 * prime ran none of the thirty-four names. The three dependent clones each ran
 * twenty-eight: twenty-seven `builder-*` and `street-view`. Nineteen of those
 * answer without a JWT, `builder-portal-login` and
 * `builder-portal-reset-password` among them. The CRM line ran `street-view`.
 * That is a login and a password reset for a retired portal on three tenants'
 * projects, with no owner (`docs/DELIVERY_SYSTEM_PLAN.md`, D4).
 *
 * ## The rules
 *
 * - **The prime's lists are the register, and this module holds no copy.**
 *   They are read at the prime's head. A name is retired because a workflow
 *   the prime reviewed says so, and a name added to one tomorrow is taken off
 *   every clone with no change here.
 * - **A list is read the way the prime reads it, or not at all.** The prime's
 *   own delivery summary (`scripts/ops/deliverySummary.pure.mjs`) finds these
 *   workflows by name, `.github/workflows/decommission-*.yml`, and reads one
 *   single-line, quoted `RETIRED='…'` from each. This reads the same files in
 *   the same shape, and is stricter in two ways. A file assigning `RETIRED`
 *   more than once is refused. So is a list the file does not delete with
 *   `supabase functions delete`, because then its names are not known to be
 *   functions. A refused file is named, never read as an empty list: an
 *   unread list is not a list of nothing.
 * - **Never a name a tree still carries.** The prime's own workflow refuses a
 *   name whose source is still under `supabase/functions/`: "retiring a
 *   function means removing its code first, or the next deploy brings it
 *   back". This refuses the same, against the prime's tree and against the
 *   clone's own.
 *   - On the clone's side the two disagree while a cascade is still carrying
 *     the removal. The clone-owned lane deploys what the clone's tree holds
 *     and the prime's does not. That is how `street-view` came back onto all
 *     four clones on 16 and 17 Oct, after the prime had removed it, and why
 *     every clone's lane record still lists it as owned once (`retired`).
 *     Deleting it in that window would only see that lane put it back.
 * - **The ones anybody can call go first.** A pass deletes a bounded number
 *   from each project. A function answering without a JWT
 *   (`verify_jwt = false`) is open to anyone, so it goes before one that
 *   checks the caller.
 *
 * What a sweep does with the answer is `sweepPrimeOnlyFunctions`': it deletes
 * by exact name, never on the prime, and never throws.
 *
 * Pure: no network, no database.
 */

/**
 * Where the prime keeps a retired list: one of its decommission workflows.
 * The prime's own pattern (`DECOMMISSION_WORKFLOW` in its delivery summary).
 */
export const DECOMMISSION_WORKFLOW_PATH = /^\.github\/workflows\/decommission-[^/]+\.ya?ml$/;

/** What makes a decommission workflow one that deletes FUNCTIONS. */
const DELETES_FUNCTIONS = /\bsupabase\s+functions\s+delete\b/;

/** Every assignment of the list, in any shape, so a second one can be counted. */
const ANY_ASSIGNMENT = /\bRETIRED=/g;

/**
 * The shape both workflows write, as the prime's `retiredList` reads it: one
 * line, single- or double-quoted.
 */
const ONE_LINE_LIST = /^[ \t]*RETIRED=(['"])([^'"\n]*)\1[ \t]*$/m;

/** A function name as the Management API spells one. */
const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** What one decommission workflow says. */
export type RetiredListReading =
  | { kind: "list"; names: string[] }
  /** A decommission workflow with no list and no function delete: not this register's. */
  | { kind: "not_functions" }
  | { kind: "refused"; why: string };

/**
 * The function names one decommission workflow retires.
 *
 * Read off the raw text, comments included, so a commented-out second list
 * counts as a second list. A file this cannot read with certainty is refused.
 */
export function readRetiredList(text: string): RetiredListReading {
  const deletesFunctions = DELETES_FUNCTIONS.test(text);
  const assignments = text.match(ANY_ASSIGNMENT)?.length ?? 0;
  if (assignments === 0) {
    return deletesFunctions
      ? { kind: "refused", why: "it deletes functions but states no RETIRED list" }
      : { kind: "not_functions" };
  }
  if (assignments > 1) {
    return {
      kind: "refused",
      why: `it assigns RETIRED ${assignments} times, so which list it deletes cannot be told from its text`,
    };
  }
  const line = ONE_LINE_LIST.exec(text);
  if (!line) {
    return {
      kind: "refused",
      why: "its RETIRED list is not the single-line, quoted list the prime's own summary reads",
    };
  }
  if (!deletesFunctions) {
    return {
      kind: "refused",
      why: "it states a RETIRED list but deletes nothing with `supabase functions delete`, so its names are not known to be functions",
    };
  }
  const names = line[2].split(/\s+/).filter((n) => n.length > 0);
  if (names.length === 0) return { kind: "refused", why: "its RETIRED list names nothing" };
  const odd = names.filter((n) => !FUNCTION_NAME.test(n));
  if (odd.length > 0) {
    return {
      kind: "refused",
      why: `its RETIRED list holds ${odd.map((n) => JSON.stringify(n)).join(", ")}, which no function is called`,
    };
  }
  return { kind: "list", names: [...new Set(names)] };
}

/**
 * The function directories a tree carries: the first segment under
 * `supabase/functions/` of every path below it.
 *
 * Any file counts, an entrypoint or not, because the prime's workflow refuses
 * on any file (`[ -e supabase/functions/$fn ]`). The shared folders come out
 * too (`_shared`), and no function is called that.
 */
export function functionDirectoriesIn(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith("supabase/functions/")) continue;
    const rest = path.slice("supabase/functions/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) out.add(rest.slice(0, slash));
  }
  return out;
}

/** The prime's retired functions, as one pass read them. */
export type RetiredFunctionRegister = {
  /** `owner/repo@sha` the lists and the tree were read at. */
  readAt: string;
  /** Every retired name, with the workflow that retires it. */
  retiredBy: ReadonlyMap<string, string>;
  /** The function directories the prime's tree still carries at that commit. */
  primeCarries: ReadonlySet<string>;
  /** Decommission workflows whose list could not be read, each with the reason. */
  unreadable: ReadonlyArray<{ path: string; why: string }>;
};

/**
 * Put the register together from what was read at one commit.
 *
 * A name two workflows both retire keeps the first, in path order, so the
 * reason a sweep records does not depend on the order a listing came back in.
 */
export function assembleRetiredRegister(input: {
  readAt: string;
  workflows: ReadonlyArray<{ path: string; reading: RetiredListReading }>;
  primeTreePaths: Iterable<string>;
}): RetiredFunctionRegister {
  const retiredBy = new Map<string, string>();
  const unreadable: Array<{ path: string; why: string }> = [];
  for (const { path, reading } of [...input.workflows].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    if (reading.kind === "refused") unreadable.push({ path, why: reading.why });
    if (reading.kind !== "list") continue;
    for (const name of reading.names) if (!retiredBy.has(name)) retiredBy.set(name, path);
  }
  return {
    readAt: input.readAt,
    retiredBy,
    primeCarries: functionDirectoriesIn(input.primeTreePaths),
    unreadable,
  };
}

/** One deployed function, as a project's list names it. */
export type DeployedFunction = { slug: string; verifyJwt?: boolean };

/** The retired functions a project runs, before any tree has been asked. */
export function retiredCandidatesIn(
  deployed: readonly DeployedFunction[],
  register: RetiredFunctionRegister,
): DeployedFunction[] {
  const seen = new Set<string>();
  return deployed.filter((fn) => {
    if (seen.has(fn.slug) || !register.retiredBy.has(fn.slug)) return false;
    seen.add(fn.slug);
    return true;
  });
}

/**
 * Which retired functions a project may lose, and which it keeps and why.
 *
 * `found` is ordered for the delete cap: those answering without a JWT first,
 * then by name. A list that did not say whether a function checks the caller
 * is not read as saying that it does not.
 */
export function retiredFunctionsToDelete(
  candidates: readonly DeployedFunction[],
  register: RetiredFunctionRegister,
  cloneCarries: ReadonlySet<string>,
): {
  found: Array<{ slug: string; reason: string }>;
  kept: Array<{ slug: string; why: string }>;
} {
  const deletable: DeployedFunction[] = [];
  const kept: Array<{ slug: string; why: string }> = [];
  for (const fn of candidates) {
    if (register.primeCarries.has(fn.slug)) {
      kept.push({
        slug: fn.slug,
        why:
          `the prime's tree still carries supabase/functions/${fn.slug}/ at ${register.readAt}, ` +
          "so it is retired on paper only: the next deploy would bring it back",
      });
    } else if (cloneCarries.has(fn.slug)) {
      kept.push({
        slug: fn.slug,
        why:
          `the clone's own tree still carries supabase/functions/${fn.slug}/, ` +
          "and the clone's lane would deploy it again: it goes once the source has left the clone's repository",
      });
    } else {
      deletable.push(fn);
    }
  }
  const open = (fn: DeployedFunction) => (fn.verifyJwt === false ? 0 : 1);
  const found = deletable
    .sort((a, b) => open(a) - open(b) || a.slug.localeCompare(b.slug))
    .map((fn) => ({
      slug: fn.slug,
      reason:
        `retired by the prime's ${register.retiredBy.get(fn.slug)}, and no tree carries its source` +
        (fn.verifyJwt === false ? "; it answers without a JWT" : ""),
    }));
  return { found, kept: kept.sort((a, b) => a.slug.localeCompare(b.slug)) };
}
