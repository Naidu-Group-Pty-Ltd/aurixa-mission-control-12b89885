/**
 * AN EDGE FUNCTION THIS CLONE CARRIES IS KEPT CURRENT WITH WHAT IT IMPORTS.
 *
 * ## The asymmetry
 *
 * `supabase/functions/_shared/**` is in every module's globs, so on a
 * module-scoped clone the shared layer crosses on every pass. An Edge
 * Function's own directory crosses only where an installed module names it,
 * and the catalogue does not name every function: on
 * `npc-crm-independent-6505dc` (134 modules installed) 57 of the functions
 * prime deploys sit inside no module's globs. The clone was provisioned with
 * them, so it holds them, and from that day they stood still while the
 * modules they import moved underneath them.
 *
 * ## What that cost
 *
 * Measured on cascade PR #29 (prime@cdff4f2 onto the clone's main at
 * 1ae9288), fourteen function files outside every installed module differed
 * from prime, and every one was a version prime itself had held: nothing on
 * the clone had ever edited them. Two of the clone's own CI checks went red
 * over them:
 *
 *   - WP-14 (`check-edge-functions.mjs`) typechecks every entry point against
 *     the `_shared` layer the pass delivered. Seven `render-*-pdf` handlers
 *     written against the old layer carried errors the baseline had never
 *     seen.
 *   - `designRouteWiring.spec.ts`, which crossed inside a module's globs,
 *     reads those same seven handlers from disk and failed 29 of its 37
 *     tests, every one of them about a stale handler. The spec builds each
 *     path with `resolve(FUNCTIONS, route, 'index.ts')`, so no named-path
 *     rule could see what it asserts about.
 *
 * ## The rule
 *
 * A function file the clone already holds, outside every installed module's
 * globs, whose blob differs from prime's, travels at prime's current version
 * when prime's own history shows the clone's copy is a version prime held.
 * It is the hold-release question (`decideHoldRelease`) asked of a file that
 * was never held, only out of scope: unmodified prime content is not work, so
 * replacing it loses nothing of the clone's. A recorded `overwrite` approval
 * for the path answers the same question on a person's word.
 *
 * Four things bound it:
 *
 *   - **Never a function the clone lacks.** Adding a function adds deployable
 *     surface, which is an installation decision, not a refresh. The rule
 *     only updates files the clone already has.
 *   - **Never a copy the clone edited.** A copy that matches no version prime
 *     held carries work done here and stays the clone's own, named in the
 *     pull request so a person can decide.
 *   - **Never past the exclusions.** A refreshed file joins the candidates
 *     before `partitionCascadePaths`, so a protected or held path is held
 *     exactly as it would be inside a module, and before the import closure,
 *     so a refreshed handler brings what it imports.
 *   - **Bounded, and resumable.** At most `MAX_STRANDED_PROBES` histories are
 *     walked in one pass; every settled answer lands in the pass's
 *     `held_evidence` ledger, keyed by the clone's blob, so the next pass
 *     continues where this one stopped and never asks the same question twice.
 *
 * `_shared` itself is not a function, and is excluded by the pattern: it
 * already crosses on every clone.
 *
 * Pure: no I/O. The engine lists the trees and walks prime's history.
 */

import type { HeldPathEvidence } from "./heldEvidence.pure";

/**
 * A file inside one Edge Function's own directory. The directory name may not
 * start with `_`: `_shared` (and any other underscore directory) is a library,
 * not a function.
 */
export const EDGE_FUNCTION_FILE = /^supabase\/functions\/(?!_)[^/]+\/.+$/;

/**
 * The most stranded function files one pass walks prime's history for.
 *
 * Each walk is one commit listing plus a batched version read. Fourteen were
 * stranded on the independent at prime@cdff4f2, so one pass settles them all;
 * past the ceiling the rest wait for the next pass, which starts from the
 * ledger rather than from nothing.
 *
 * A walk reads at most `MAX_VERSION_WALK` versions, the same depth as every
 * other history question, and an answer beyond it is never guessed: on that
 * pass thirteen of the fourteen were proved and refreshed, and the fourteenth
 * (`builder-stock-marketplace`, prime's version fifteen commits back) stayed
 * the clone's own, named in the pull request for an operator's approval.
 */
export const MAX_STRANDED_PROBES = 16;

/** A function file the clone holds at a different blob from prime's. */
export type StrandedFunctionFile = { path: string; cloneSha: string; primeSha: string };

/**
 * The function files this clone holds, outside what its scope already sends,
 * whose blob differs from prime's. Sorted by path.
 *
 * `inScope` is every prime path the clone's scope sends before the tree
 * narrowing (the installed globs plus the repository invariants). A file in it
 * is the module's business and never stranded.
 */
export function strandedFunctionFiles(args: {
  prime: ReadonlyMap<string, string>;
  clone: ReadonlyMap<string, string>;
  inScope: ReadonlySet<string>;
}): StrandedFunctionFile[] {
  const out: StrandedFunctionFile[] = [];
  for (const [path, cloneSha] of args.clone) {
    if (!EDGE_FUNCTION_FILE.test(path) || args.inScope.has(path)) continue;
    const primeSha = args.prime.get(path);
    if (primeSha === undefined || primeSha === cloneSha) continue;
    out.push({ path, cloneSha, primeSha });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The files to walk this pass: those no settled answer covers yet, at most
 * `max`, starting `rotation` places into the list, so two passes for
 * different prime commits do not always spend their window on the same names.
 */
export function strandedFilesToProbe(args: {
  files: readonly StrandedFunctionFile[];
  /** Paths already answered — by the resumed ledger or an approval. */
  settled: ReadonlySet<string>;
  max?: number;
  rotation?: number;
}): StrandedFunctionFile[] {
  const open = args.files.filter((f) => !args.settled.has(f.path));
  if (open.length === 0) return [];
  const shift = (((args.rotation ?? 0) % open.length) + open.length) % open.length;
  const rotated = [...open.slice(shift), ...open.slice(0, shift)];
  return rotated.slice(0, Math.max(0, args.max ?? MAX_STRANDED_PROBES));
}

/** What one stranded file does this pass, and why. */
export type StrandedVerdict =
  | { path: string; act: "refresh"; basis: "unedited" | "approved"; why: string }
  | { path: string; act: "keep"; settled: boolean; why: string };

/**
 * One stranded file, one answer.
 *
 * `settled` on a keep says whether the answer is about the file (its copy
 * carries work done here) or only about this pass (not walked yet, or the walk
 * failed) — the second clears by itself, the first needs a person.
 */
export function decideStrandedRefresh(args: {
  file: StrandedFunctionFile;
  evidence: HeldPathEvidence | null;
  /** True when an unexpired, unrevoked `overwrite` approval names this path. */
  approved: boolean;
}): StrandedVerdict {
  const { file, evidence, approved } = args;
  const path = file.path;
  if (approved) {
    return {
      path,
      act: "refresh",
      basis: "approved",
      why:
        "an operator recorded an overwrite approval for this path on this clone, so prime's " +
        "current copy travels",
    };
  }
  if (!evidence) {
    return {
      path,
      act: "keep",
      settled: false,
      why: "prime's history was not walked for it this pass; the next pass continues",
    };
  }
  if (evidence.kind === "unsettled") {
    return {
      path,
      act: "keep",
      settled: false,
      why: `prime's history for it could not be read (${evidence.why}); the next pass asks again`,
    };
  }
  if (evidence.kind === "never_primes") {
    // Defensive: a file prime holds at a different blob has at least one
    // commit touching it, so an honest walk cannot answer this.
    return {
      path,
      act: "keep",
      settled: true,
      why: "prime's history shows no commit touching it, so there is nothing of prime's to restore",
    };
  }
  if (evidence.versions.includes(file.cloneSha)) {
    return {
      path,
      act: "refresh",
      basis: "unedited",
      why:
        "this clone's copy is byte-identical to a version prime itself held, so it carries no " +
        "work of the clone's and prime's current copy replaces it",
    };
  }
  return {
    path,
    act: "keep",
    settled: true,
    why: evidence.versionsExhaustive
      ? "this clone's copy matches no version prime ever held, so it carries work done here and stays the clone's own"
      : `this clone's copy matches none of the ${evidence.versions.length} version(s) walked, and the walk did not reach the beginning of the history, so it stays the clone's own`,
  };
}

/** The paths a pass refreshes, sorted. */
export function strandedRefreshPaths(verdicts: readonly StrandedVerdict[]): string[] {
  return verdicts
    .filter((v) => v.act === "refresh")
    .map((v) => v.path)
    .sort();
}

/**
 * The pull request body's section on stranded function files. Empty when the
 * pass found none. Refreshed files first; then any the pass kept as the
 * clone's own because the copy carries work, which is a person's decision;
 * then a count of those left for a later pass.
 */
export function describeStrandedFunctions(verdicts: readonly StrandedVerdict[]): string {
  if (verdicts.length === 0) return "";
  const refreshed = verdicts.filter(
    (v): v is Extract<StrandedVerdict, { act: "refresh" }> => v.act === "refresh",
  );
  const kept = verdicts.filter(
    (v): v is Extract<StrandedVerdict, { act: "keep" }> => v.act === "keep",
  );
  const edited = kept.filter((v) => v.settled);
  const later = kept.filter((v) => !v.settled);
  const lines: string[] = [];
  for (const v of refreshed) {
    lines.push(
      `- \`${v.path}\` — ${v.basis === "approved" ? "by a recorded operator approval" : "on evidence"}: ${v.why}.`,
    );
  }
  for (const v of edited) lines.push(`- \`${v.path}\` — kept as this clone's own: ${v.why}.`);
  if (later.length > 0) {
    lines.push(
      `- ${later.length} more function file(s) behind prime were not settled this pass (${later[0].why}).`,
    );
  }
  return lines.join("\n");
}

/** The one phrase a result summary uses for refreshed function files. */
export function strandedSuffixFor(verdicts: readonly StrandedVerdict[]): string {
  const n = verdicts.filter((v) => v.act === "refresh").length;
  return n > 0 ? ` · ${n} Edge Function file(s) kept current` : "";
}
