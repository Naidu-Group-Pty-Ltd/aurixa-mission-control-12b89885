/**
 * A SPEC'S SUBJECT OUTSIDE THE CONTENT ROOTS — carried beside it only where
 * nothing of the clone's is lost.
 *
 * The spec channel reads a spec's subjects from its own text, and
 * `subjectsNamedBy` reads them under five roots only — `src`, `supabase`,
 * `docs`, `scripts`, `public`. A subject there that is behind on the clone is
 * carried in with its spec, or the spec is held. A file anywhere else is not
 * read at all, so a spec that asserts about one crosses without it and
 * nothing notices.
 *
 * ## What that cost
 *
 * Found by replaying cascade PR #26 to `npc-crm-independent-6505dc`
 * (prime@885b324) through the engine that also brings a kept spec up to date
 * with its subject (`specsLeftBehind.pure.ts`). `reportTypography.spec.ts`
 * followed `charts.pure.ts` across, as it should, and its current version
 * reads `.claude/skills/npc-services-design/reports/REPORT_RULES.md` and
 * checks the document against the font list the code exports. The clone held
 * that document one version behind prime's, so three of its eighty tests
 * failed `verify`: `Cinzel is installed; the doc says otherwise`. The channel never
 * looked, because `.claude` is not one of its roots. The same gap exists for
 * any spec a delivery carries by any route; the reverse half is simply where
 * it first cost a red check.
 *
 * Across prime's 1,565 specs on the same day, read by the rule below, 17 name
 * a file that exists in the tree outside the five roots — 22 references to 16
 * distinct files: `.github` 15, `weasyprint-service` 3, `services` 2,
 * `support-kb` and `.claude` one each.
 *
 * ## Why it is not simply a sixth root
 *
 * Outside the content roots are the files a clone is EXPECTED to keep its own
 * version of: its CI, its build, its per-deployment workflows. On the
 * independent, specs it holds name three such files that differ from prime's.
 * Two are older versions of prime's — `REPORT_RULES.md`, and
 * `.github/workflows/apply-migration.yml`, which the clone protects. The third,
 * `.github/workflows/ci.yml`, matches none of the 143 versions prime ever held:
 * it is the clone's own, and `geocoderWiring.spec.ts` reads it and PASSES
 * against it. Carrying by name alone would have overwritten the CI workflow of
 * the one clone this was measured on, to satisfy a spec that did not need it.
 *
 * So a file here travels on EVIDENCE — the rule a held path is released by
 * (`decideHoldRelease`). Prime's own history must show the clone's copy is
 * byte-identical to a version prime held, or an operator must have recorded an
 * overwrite approval. Then carrying it loses nothing of the clone's, and it is
 * treated as the spec's subject like any other: carried through the same path
 * and content rules as every write, or the spec is held with the rule that
 * stopped it. A file the clone keeps its own version of stays the clone's,
 * and the spec is judged against it there, as every spec already was.
 *
 * Two more bounds, both about what a spec's text may make travel.
 *
 *   · A bare file at the repository root never counts. `package.json`
 *     travels with its lockfile or not at all, and the root is where a
 *     repository keeps its own configuration — `REPOSITORY_INVARIANTS`
 *     decides which of those travel, one by one, with a reason each.
 *   · A mention in a comment does not count here. Outside the content roots,
 *     prose names workflows and skills constantly, and what would travel is
 *     infrastructure. `subjectsNamedBy` reads comments too; that is kept as
 *     it is, because under its roots a false subject costs a check, not a
 *     write.
 *
 * And the path must exist in both trees, which is what keeps model-written
 * text from ever naming a filesystem path: a git tree listing holds no `..`
 * and no absolute path.
 *
 * Pure: no I/O. The engine asks prime's history and decides.
 */

import { isSpecPath } from "@/lib/cascade/membrane/ionSpecies.pure";
import { resolveFromSpec, SUBJECT_ROOTS } from "@/lib/cascade/membrane/membrane.pure";
import { stripComments } from "../sourceComments.pure";

/**
 * A top-level segment: an optional leading dot, then a name. `.github`,
 * `weasyprint-service`, `support-kb`.
 */
const SEGMENT = String.raw`\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*`;

/** `"weasyprint-service/app.py"`, `".claude/skills/…/REPORT_RULES.md"`. */
const WHOLE = new RegExp(String.raw`['"\`](${SEGMENT}/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)['"\`]`, "g");

/** `read(".github", "workflows", "ci.yml")` — the segments of one path, in order. */
const SEGMENTED = new RegExp(
  String.raw`['"\`](${SEGMENT})['"\`]((?:\s*,\s*['"\`][A-Za-z0-9_.-]+['"\`])+)`,
  "g",
);

/** `resolve(__dirname, "../../../../weasyprint-service/app.py")`. */
const RELATIVE = /['"`]((?:\.\.?\/)+[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)['"`]/g;

const ROOTS = new Set(SUBJECT_ROOTS);

/** A path this rule reads: in a directory, outside the content roots, with an extension. */
function isOutsideRootPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.length < 2) return false;
  if (ROOTS.has(segments[0])) return false;
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return /\.[A-Za-z0-9]+$/.test(segments[segments.length - 1]);
}

/**
 * The repository paths outside the content roots a spec names in its code.
 *
 * The three forms `subjectsNamedBy` reads — a whole literal, the segments of
 * one path, and (given the spec's own path) a relative literal — over the
 * spec's text with its comments removed, keeping only what lies in a
 * directory outside `SUBJECT_ROOTS`. Sorted.
 */
export function subjectsNamedOutsideRoots(text: string, specPath?: string): string[] {
  const code = stripComments(text);
  const found = new Set<string>();

  for (const m of code.matchAll(WHOLE)) {
    if (isOutsideRootPath(m[1])) found.add(m[1]);
  }

  for (const m of code.matchAll(SEGMENTED)) {
    const tail = [...m[2].matchAll(/['"`]([A-Za-z0-9_.-]+)['"`]/g)].map((x) => x[1]);
    const path = [m[1], ...tail].join("/");
    if (isOutsideRootPath(path)) found.add(path);
  }

  if (specPath !== undefined) {
    for (const m of code.matchAll(RELATIVE)) {
      const resolved = resolveFromSpec(specPath, m[1]);
      if (resolved !== null && isOutsideRootPath(resolved)) found.add(resolved);
    }
  }

  return [...found].sort();
}

/**
 * The files outside the content roots that a spec names and that would stay
 * behind it: on both sides, at different versions, and not in the delivery.
 *
 * These are the only ones worth a question to prime's history. A file only
 * one side holds has no older version of prime's to be; identical copies owe
 * nothing; a file that is crossing is already beside the spec. Sorted.
 */
export function outsideRootCandidates(args: {
  specPath: string;
  specText: string;
  primeSha: ReadonlyMap<string, string>;
  cloneSha: ReadonlyMap<string, string>;
  /** Every path the delivery covers. */
  crossing: ReadonlySet<string>;
}): string[] {
  const { specPath, specText, primeSha, cloneSha, crossing } = args;
  if (!isSpecPath(specPath)) return [];
  return subjectsNamedOutsideRoots(specText, specPath).filter((path) => {
    if (crossing.has(path)) return false;
    const onPrime = primeSha.get(path);
    const onClone = cloneSha.get(path);
    return onPrime !== undefined && onClone !== undefined && onPrime !== onClone;
  });
}

/**
 * How many such files one pass asks prime's history about.
 *
 * Each question is the hold-release probe: one commit listing and a read per
 * version walked, stopping at the clone's copy — so a file the clone keeps its
 * own version of costs the whole walk, eleven requests. Measured on the
 * independent's delivery: two files were asked about, `REPORT_RULES.md` (the
 * clone's copy is the version before prime's current one) and `ci.yml` (the
 * clone's own, matching none of the ten versions walked). A file not asked
 * about this pass is not carried; see the engine for what that means for its
 * spec.
 */
export const MAX_OUTSIDE_ROOT_PROBES = 16;
