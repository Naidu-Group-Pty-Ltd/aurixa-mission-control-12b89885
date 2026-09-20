/**
 * WHOSE DATABASE IS THIS DEPLOYMENT SHIPPING?
 *
 * `backendIdentityHold` answers that question about ONE incoming file at
 * cascade time, and refuses the write. It is the last line, and it only runs
 * when something is being written — so a clone that was provisioned wrong and
 * has never been cascaded to is never asked.
 *
 * Measured 20 Sep 2026, and this is why the module exists: all three clones
 * shipped the PRIME's Supabase URL and anon key in `public/lead-magnet-embed.html`
 * and `src/integrations/supabase/env.ts`, byte-identical, from their first
 * commit. `public/` is copied into `dist/` untouched and served from the
 * clone's own domain, so every lead that embed captured was written into the
 * prime's database. Nothing anywhere said so. The cascade had held the file
 * correctly for weeks — holding a wrong file in place is not the same as
 * reporting that it is wrong.
 *
 * This is the standing reading: a fleet-wide answer, computed from what each
 * repository actually ships, that can be wrong on day one and still be seen.
 *
 * ## Four readings, and why none of them may be collapsed
 *
 * `own` is the only clean one. The other three are each a different sentence:
 *
 *  - `foreign` — a shipped file names a project that is not this clone's. A
 *    finding, with the paths and the refs that made it.
 *  - `no_backend` — the clone has no project ref recorded, so there is nothing
 *    to compare against. NOT clean: it is a clone whose backend nobody has
 *    provisioned, and the files it ships still name somebody.
 *  - `unreadable` — the repository could not be read. NOT clean, and not
 *    `foreign` either. "We could not check" is not "you do not have it" — the
 *    rule `useAmlAccess` paid for, and the rule `clone_sync_exclusions`'
 *    `requireExclusions` already answers to here.
 *
 * A reading that turned a lost signal into `own` would put a green mark on the
 * one screen whose whole purpose is to show this.
 *
 * ## Coverage travels with the answer
 *
 * `paths` on every reading, including a clean one, names exactly what was
 * looked at. These are the files that carry backend identity BY DESIGN — the
 * pair a deployment ships and the fallback its app boots on. They are not the
 * whole tree, and a reading that implied otherwise would be the
 * `layers=all` defect: an empty answer to a question nobody asked.
 *
 * The whole tree IS covered, at cascade time, by `backendIdentityHold` over
 * `isShippedPath`. The two are deliberately different instruments: that one
 * refuses a write, this one describes a deployment.
 */
import { backendRefsIn, isShippedPath } from "./syncExclusions.pure";

/**
 * The files probed for a standing reading.
 *
 * Deliberately a short, fixed list rather than a walk. A walk of every shipped
 * path is one GitHub request per file per clone on every render of a tree, and
 * the answer it would add is the one the cascade already gives. What these
 * three have that the rest do not is that they carry the pair on PURPOSE:
 * change any of them and you have changed which database this deployment talks
 * to.
 *
 * Asserted against `isShippedPath` below rather than trusted, because a path
 * this reading covers that the cascade would not hold is a reading nothing
 * enforces.
 */
export const IDENTITY_PROBE_PATHS = [
  "public/lead-magnet-embed.html",
  "src/integrations/supabase/env.ts",
] as const;

export type IdentityVerdict = "own" | "foreign" | "no_backend" | "unreadable";

export type IdentityFinding = {
  path: string;
  /** Every project this file names that is not this deployment's. */
  foreignRefs: string[];
};

export type BackendIdentityReading = {
  verdict: IdentityVerdict;
  /** This clone's own Supabase project, or null when none is recorded. */
  ownRef: string | null;
  /** The paths that were read. Empty when nothing could be. */
  paths: string[];
  /** Populated only on `foreign`. */
  findings: IdentityFinding[];
  /** One sentence, for a surface that has room for one. */
  summary: string;
};

/** A file as it was found, or the fact that it could not be. */
export type ProbedFile =
  | { path: string; kind: "read"; content: string }
  | { path: string; kind: "absent" }
  | { path: string; kind: "error"; message: string };

/**
 * Turn a set of probed files into one reading about a deployment.
 *
 * Pure. The GitHub reads and the database lookup happen in the caller, so this
 * — the part that decides what an operator is told — is testable without
 * either.
 *
 * ## An absent file is not a finding
 *
 * A repository that does not carry the embed is not shipping anybody's
 * database from it. Absence is counted as covered-and-clean and named in
 * `paths` only if it was read; a file nobody has is not evidence either way.
 *
 * ## One error is enough to stop the answer being `own`
 *
 * If any probe errored, the reading is `unreadable` even when every file that
 * DID come back was clean — because the one that did not is exactly where a
 * finding would be. A `foreign` finding still outranks it: something known to
 * be wrong is more useful than the fact that something else could not be
 * checked.
 */
export function readBackendIdentity(args: {
  ownRef: string | null;
  files: readonly ProbedFile[];
}): BackendIdentityReading {
  const { ownRef, files } = args;

  const readPaths = files.filter((f) => f.kind !== "error").map((f) => f.path);
  const errored = files.filter((f) => f.kind === "error");

  const findings: IdentityFinding[] = [];
  for (const f of files) {
    if (f.kind !== "read") continue;
    const foreignRefs = backendRefsIn(f.content).filter((r) => r !== ownRef);
    if (foreignRefs.length > 0) findings.push({ path: f.path, foreignRefs });
  }

  // A finding first, whatever else is true. `ownRef` being null does not make
  // a foreign ref unknowable — it makes EVERY ref foreign, which is a louder
  // statement, not a quieter one, so it is reported as `no_backend` below
  // only when nothing was found to say.
  if (ownRef !== null && findings.length > 0) {
    const refs = [...new Set(findings.flatMap((f) => f.foreignRefs))];
    return {
      verdict: "foreign",
      ownRef,
      paths: readPaths,
      findings,
      summary:
        `Ships Supabase project ${refs.join(", ")} in ${findings.length} file(s) ` +
        `while its own backend is ${ownRef}.`,
    };
  }

  if (ownRef === null) {
    const named = [
      ...new Set(files.flatMap((f) => (f.kind === "read" ? backendRefsIn(f.content) : []))),
    ];
    return {
      verdict: "no_backend",
      ownRef: null,
      paths: readPaths,
      findings: [],
      summary:
        named.length > 0
          ? `No Supabase project is recorded for this clone, and its shipped files name ${named.join(", ")}.`
          : "No Supabase project is recorded for this clone, so there is nothing to compare its shipped files against.",
    };
  }

  if (errored.length > 0) {
    return {
      verdict: "unreadable",
      ownRef,
      paths: readPaths,
      findings: [],
      summary: `Could not read ${errored.length} of ${files.length} shipped file(s): ${errored
        .map((e) => e.path)
        .join(", ")}.`,
    };
  }

  return {
    verdict: "own",
    ownRef,
    paths: readPaths,
    findings: [],
    summary:
      readPaths.length > 0
        ? `Every shipped file read names this deployment's own project ${ownRef}.`
        : `Carries none of the files that ship a Supabase pair.`,
  };
}

/** Whether a reading is one an operator should be shown as a problem. */
export function isIdentityDrift(reading: BackendIdentityReading): boolean {
  return reading.verdict === "foreign";
}

/**
 * Every probe path is one the cascade would also hold.
 *
 * Exported so a test asserts it rather than a comment claiming it. If a path
 * is added here that `isShippedPath` does not cover, this reading would report
 * drift on a file no cascade guard protects — a finding with no remedy.
 */
export function probePathsAreShipped(): boolean {
  return IDENTITY_PROBE_PATHS.every((p) => isShippedPath(p));
}
