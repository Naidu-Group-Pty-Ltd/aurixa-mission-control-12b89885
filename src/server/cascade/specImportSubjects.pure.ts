/**
 * The repository files a spec IMPORTS, as subjects of that spec.
 *
 * `subjectsNamedBy` (the membrane) reads the paths a spec spells out. This
 * reads the modules it loads. They are different evidence and both are
 * subjects: a spec that `import`s a module asserts about that module exactly
 * as much as one that `readFileSync`s it, and more often, because it calls
 * the functions.
 *
 * ## What went wrong
 *
 * Cascade #81 on `npc-crm-independent-6505dc`, measured 8 Oct 2026.
 * `src/lib/aml/regulatedActs.test.ts` asserts that `isElevationRefusal`
 * accepts three new step-up codes, and it reaches that function as
 * `import { isElevationRefusal } from "@/lib/secureInvoke"`. There is no
 * extension, so no literal rule reads it. `secureInvoke.ts` is a CRM head
 * variant held for a person to reconcile, so the import closure found it
 * stale and the hold kept the clone's copy. The spec crossed alone, and
 * `verify` went red with `step_up_invalid: expected false to be true` while
 * every membrane rule said nothing.
 *
 * ## Why it lives here
 *
 * Resolution is the import closure's own (`importsOf`, `resolveSpecifier`),
 * not a second reading of specifiers. The closure decides what a payload
 * must carry and this decides what a spec may not leave behind; two
 * resolvers answering one question differently is how a spec crosses that
 * the closure would have held, or the reverse.
 *
 * The membrane is drawn in a browser and must never import a server module
 * for a value, so it cannot call the resolver itself. Its callers do, here,
 * and hand the answer to `strandedSubjects` as `imported`.
 *
 * ## The rule
 *
 * Only the two project forms are followed, `@/` and relative, so a package
 * import contributes nothing. A specifier that names nothing in prime
 * contributes nothing either, because prime states nothing about it. What it
 * resolves to answers to the same rule as every other subject: a content root
 * and an extension (`isSubjectPath`).
 */

import { isSubjectPath } from "@/lib/cascade/membrane/membrane.pure";
import { importsOf, resolveSpecifier, type TreeIndex } from "./importClosure.pure";

/** The repository files a spec imports, resolved against prime's tree, sorted. */
export function subjectsImportedBy(text: string, specPath: string, prime: TreeIndex): string[] {
  const found = new Set<string>();
  for (const specifier of importsOf(text)) {
    const resolved = resolveSpecifier(specifier, specPath, prime);
    if (resolved === null || resolved === specPath) continue;
    if (!isSubjectPath(resolved)) continue;
    found.add(resolved);
  }
  return [...found].sort();
}
