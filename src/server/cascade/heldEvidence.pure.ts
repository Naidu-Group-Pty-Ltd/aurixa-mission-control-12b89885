/**
 * A hold protects WORK, not a path.
 *
 * ## The state that proved it
 *
 * `manual_reconcile` exclusions are seeded from `DEFAULT_MIRROR_EXCLUSIONS`,
 * which was written from `npc-client-dashboard`'s real divergence — and then
 * seeded onto every mirror, because the seeding is a starting policy. On the
 * two clones that froze in September 2026, `src/lib/clientFacing.ts` and its
 * test were byte-identical to prime@fa6bed0d: nothing on either clone had ever
 * edited them. The hold was protecting stale prime content from newer prime
 * content, forever, while the note on the exclusion described a different
 * repository's divergence.
 *
 * That is not a misconfiguration an operator can be blamed for. The list is
 * seeded per clone precisely so it can be edited, and nobody edits sixteen
 * rows per clone against a question ("has anyone here actually diverged on
 * this?") that git already answers. So the engine asks git.
 *
 * ## The rule
 *
 * A `manual_reconcile` hold is honoured only where the clone's copy carries
 * work that would be lost. The evidence is the same evidence the deletion
 * rule runs on, in the same words:
 *
 *   - the clone's blob is byte-identical to a version prime itself held at
 *     that path → unmodified prime content is not work → the hold is vacuous
 *     and prime's current copy travels;
 *   - the clone's blob matches no version prime ever held → somebody here
 *     edited it → held, exactly as before;
 *   - the history could not be read, or the walk ran out → held. A read that
 *     FAILED is not a fact that is ABSENT, and unlike the deletion rule the
 *     safe side here is simply yesterday's behaviour.
 *
 * `protected` paths are NEVER released. They exclude identity — the Supabase
 * project, the deploy guards, the Turnstile pairing — where "the clone never
 * edited it" is precisely the dangerous state: an unedited `env.ts` is one
 * cascade away from serving another tenant's database, which is the accident
 * this whole area exists to prevent.
 *
 * ## The operator's override
 *
 * Blob evidence cannot release a file a person once hand-merged: the hybrid
 * matches no prime version even when every line of it is prime's. That is the
 * `src/App.tsx` case on the September clones — three lines from a prime
 * revision, none of them clone-authored, and permanently held. The release
 * for that state is a RECORDED operator decision (`cascade_path_approvals`,
 * kind `overwrite`): reviewed in Mission Control, written by a person,
 * expiring, revocable, and named in the pull request every time it is used.
 * It still releases only `manual_reconcile` holds — an approval cannot touch
 * `protected` — and the released file still runs the content holds
 * (`backendIdentityHold`, the judging-workflow rule) like any other write.
 *
 * Client-safe: pure, no imports.
 */
import type { HeldPath } from "./syncExclusions.pure";

/**
 * The most holds one pass will probe prime's history for.
 *
 * Each probe is one `listCommits` plus up to `MAX_VERSION_WALK` content
 * reads, against the same budget as everything else in the pass. Held sets
 * are small by design — the September clones held three source paths — so
 * this is a ceiling for a clone whose exclusion list has grown, not a
 * working limit. Overflow is carried, not dropped: unprobed holds stay held,
 * which is yesterday's behaviour.
 */
export const MAX_HOLD_RELEASE_PROBES = 8;

/** What prime's history says about a path it still holds. */
export type HeldPathEvidence =
  /**
   * The blobs prime has held at this path, newest first, as far back as the
   * probe walked. `versionsExhaustive` says whether the walk reached the end
   * of the path's history.
   */
  | { kind: "prime_versions"; versions: readonly string[]; versionsExhaustive: boolean }
  /** No commit in prime has ever touched this path. */
  | { kind: "never_primes" }
  /** The probe could not answer. Never an argument for releasing. */
  | { kind: "unsettled"; why: string };

export type HoldRelease =
  | {
      act: "release";
      path: string;
      /** What justified it — evidence, or a recorded operator approval. */
      basis: "unedited" | "approved";
      why: string;
    }
  | { act: "hold"; path: string; why: string };

/**
 * One held path, one answer.
 *
 * `cloneSha` is the blob the clone holds at this path right now, or null when
 * the clone does not have the file — which always holds: a hold on a file the
 * clone lacks is the content rules' business (`backendIdentityHold` decides
 * whether a NEW file may arrive), not this one's.
 */
export function decideHoldRelease(args: {
  held: HeldPath;
  cloneSha: string | null;
  evidence: HeldPathEvidence | null;
  /** True when an unexpired, unrevoked `overwrite` approval names this path. */
  approved: boolean;
}): HoldRelease {
  const { held, cloneSha, evidence, approved } = args;
  const path = held.path;

  // The line that must never move: an approval releases judgement, never
  // identity. `protected` is checked before anything else so no combination
  // of inputs below can reach a release.
  if (held.reason !== "manual_reconcile") {
    return {
      act: "hold",
      path,
      why: "Protected paths are never released — they exclude this deployment's identity.",
    };
  }

  if (approved) {
    return {
      act: "release",
      path,
      basis: "approved",
      why:
        "An operator recorded an overwrite approval for this path on this clone, so prime's " +
        "current copy travels. The approval expires and is revocable in Mission Control.",
    };
  }

  if (cloneSha === null) {
    return {
      act: "hold",
      path,
      why: "The clone has no copy at this path, so there is no vacuous hold to release.",
    };
  }

  if (!evidence) {
    return {
      act: "hold",
      path,
      why: "Prime's history was not probed this pass, and an unprobed hold stays a hold.",
    };
  }

  if (evidence.kind === "unsettled") {
    return {
      act: "hold",
      path,
      why: `Prime's history for this path could not be read (${evidence.why}), and an unreadable history is not evidence of anything.`,
    };
  }

  if (evidence.kind === "never_primes") {
    // A held path prime has never touched cannot be a candidate in the first
    // place — candidates are paths where prime's blob differs — so this is a
    // defensive answer, not an expected one.
    return {
      act: "hold",
      path,
      why: "Prime's history shows no commit touching this path, so there is nothing of prime's to restore.",
    };
  }

  if (evidence.versions.includes(cloneSha)) {
    return {
      act: "release",
      path,
      basis: "unedited",
      why:
        "This clone's copy is byte-identical to a version prime itself held at this path — " +
        "unmodified prime content is not work, so the hold protects nothing and prime's " +
        "current copy travels.",
    };
  }

  // Matches no walked version. Whether the walk was exhaustive changes the
  // wording, never the verdict: unlike a deletion, holding costs only
  // yesterday's behaviour, so "staler than we looked" and "edited here" both
  // hold.
  return {
    act: "hold",
    path,
    why: evidence.versionsExhaustive
      ? "This clone's copy matches no version prime ever held at this path — it carries work done here."
      : `This clone's copy matches none of the ${evidence.versions.length} version(s) walked, and the walk did not reach the beginning of the history.`,
  };
}

/** The pull request body's section on released holds. Empty when none. */
export function describeHoldReleases(releases: readonly HoldRelease[]): string {
  const released = releases.filter(
    (r): r is Extract<HoldRelease, { act: "release" }> => r.act === "release",
  );
  if (released.length === 0) return "";
  return released
    .map(
      (r) =>
        `- \`${r.path}\` — ${
          r.basis === "approved"
            ? "released by a recorded operator approval"
            : "released on evidence"
        }: ${r.why}`,
    )
    .join("\n");
}

/** The one phrase a result summary uses for released holds. */
export function holdReleaseSuffixFor(releases: readonly HoldRelease[]): string {
  const n = releases.filter((r) => r.act === "release").length;
  return n > 0 ? ` · ${n} hold(s) released` : "";
}
