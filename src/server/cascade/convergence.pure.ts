/**
 * Is this clone converging on prime? Asked of the two trees, never of the
 * ledger.
 *
 * ## Why a new reading was needed at all
 *
 * Every existing answer to "is this clone in sync" is derived from the record
 * the actor wrote:
 *
 *   `sync_status` ← `commits_behind` ← `last_synced_sha` ← the merge drain
 *                 ← `cascade_results` ← the engine
 *
 * So when the actor is wrong, the reading is wrong IN THE SAME DIRECTION.
 * That is not hypothetical: on 16 Sep 2026 `advanceClone` stamped a folded
 * carrier's provenance instead of the head its pass delivered, and the next
 * drift scan wrote "Critical Sync: 84 commits behind Prime" onto a clone whose
 * content matched prime's byte for byte. `choosePointerAdvance` made the
 * pointer honest and did not change the fact that the pointer is the only
 * thing anybody reads.
 *
 * **Sync is a property of two trees, and it is measured by comparing them.**
 * `owed` below is the same number `processClone` would compute if you asked it
 * to cascade right now — which is the only number that answers the question an
 * operator is actually asking, and the only one that is true independently of
 * how the ledger came to say what it says.
 *
 * It is also the only reading that can see divergence NO EVENT EVER CREATED: a
 * force-push, a reverted cascade merge, an exclusion pattern that grew too
 * broad, a Lovable edit made directly on a clone. None of those write a
 * `cascade_event`, so none of the existing machinery ever looks at them.
 *
 * ## The second rule: divergence is not a fault
 *
 * Measured 18 Sep 2026, the three most recent `drift_high` notifications:
 *
 *   08:45:06  "High drift on NPC Client Dashboard — Trigger Manual Sync PR"
 *   08:45:09  "High drift on Preflight — Manual Cascade Sync Required"
 *   09:00:13  "High drift on NPC Client Dashboard — Investigate Stalled
 *              Cascade Pipeline"
 *
 * All three clones converged at 09:00:45–09:00:46. Nothing was stalled.
 * Delivery is about seventeen minutes of CI plus drain latency, so a scan
 * running every fifteen minutes and reading a non-zero `commits_behind` fires
 * on THE NORMAL STATE OF A WORKING PIPELINE, several times per prime commit,
 * on every clone. That is the whole of the 1,253 unread `drift_high` rows, and
 * it is what made the notification channel — where `cascade_blocked` also
 * arrives — something an operator had already learned to filter out.
 *
 * **Divergence is the normal state of a working pipeline. The fault is
 * divergence that has stopped shrinking.** So nothing here alerts on a level.
 * `judgeConvergence` alerts on a derivative, and it needs two clocks rather
 * than one, for the reason recorded on `falling_behind` below.
 *
 * Client-safe: pure, and its only import is the partition the engine itself
 * uses — deliberately, because two implementations of "what the cascade owes"
 * is exactly how the auditor and the actor would come to disagree, and this
 * module's whole job is to be the independent check on the other one.
 */
import { partitionCascadePaths, type SyncExclusion } from "./syncExclusions.pure";

/**
 * How many SLO windows a clone may go without ever reaching `converged`
 * before that is a fault in its own right.
 *
 * This is the one the September freeze needed and a single clock would have
 * missed. From 14 to 16 Sep 2026 the fleet froze at prime@66c49f8 while prime
 * moved 118 commits. The owed set was CHANGING on every pass the whole time —
 * prime kept pushing — so "has the owed set moved since last time?" answered
 * yes, continuously, for two days, about a fleet that was receiving nothing.
 *
 * Movement is evidence of delivery only if it eventually reaches zero. This is
 * the clock that asks whether it ever does.
 */
export const FALLING_BEHIND_WINDOWS = 4;

/** What one pass of the auditor found by comparing the trees. */
export type ConvergenceMeasurement =
  | {
      kind: "measured";
      /** Paths the cascade WOULD write whose blob SHA differs. */
      owed: string[];
      /** Order-independent identity of that set. Empty set ⇒ null. */
      fingerprint: string | null;
      /** Paths the clone holds that prime does not. Informational — see below. */
      deletionCandidates: number;
      /** Paths withheld by this clone's own policy. Never part of `owed`. */
      held: number;
      /** Paths compared, after scope narrowing. */
      compared: number;
    }
  | { kind: "unmeasurable"; why: string };

/**
 * Compare two trees and report what the cascade still owes this clone.
 *
 * `prime` and `clone` are `path -> blob SHA`, exactly as `listTreeEntries`
 * returns them. A blob SHA is a hash of the content, so `prime[p] !== clone[p]`
 * IS "this file differs" — for two API calls total rather than two per file,
 * which is the same reason the mirror cascade compares SHAs and not content.
 *
 * Three things are deliberately NOT divergence:
 *
 * **A held path.** `partitionCascadePaths` puts `protected` and
 * `manual_reconcile` paths in `held`, and this reads `write` only. A held file
 * that has drifted is real and is `held-file-drift`'s job; counting it here
 * would make every clone permanently non-convergent on files this platform is
 * forbidden to write, which is the fastest possible way to teach somebody to
 * ignore this reading too.
 *
 * **A deletion.** A path the clone holds and prime does not is a CANDIDATE and
 * never on its own a reason to delete — the clone legitimately carries files of
 * its own, and only prime's own history can settle which is which
 * (`deletionPropagation.pure.ts`). Re-deriving that verdict here would be a
 * second implementation of the most destructive decision in the engine, so the
 * count travels and the verdict does not.
 *
 * **An unreadable tree.** A truncated listing cannot say a file is absent, only
 * that it was not listed — and a partial tree read as complete looks exactly
 * like a clone that is already in sync, which is the most expensive way for
 * this to be wrong. It refuses the whole reading.
 */
export function measureConvergence(input: {
  prime: ReadonlyMap<string, string>;
  clone: ReadonlyMap<string, string>;
  exclusions: readonly SyncExclusion[];
  primeTruncated: boolean;
  cloneTruncated: boolean;
  /**
   * For a module-scoped clone, the paths of prime that are this clone's
   * business at all. `null` for a mirror, whose section is the whole tree.
   */
  scopedTo?: ReadonlySet<string> | null;
}): ConvergenceMeasurement {
  const { prime, clone, exclusions, primeTruncated, cloneTruncated } = input;

  if (primeTruncated || cloneTruncated) {
    return {
      kind: "unmeasurable",
      why:
        `Tree listing truncated (prime=${primeTruncated}, clone=${cloneTruncated}) — ` +
        `a partial tree read as complete is indistinguishable from a clone in sync`,
    };
  }

  const scope = input.scopedTo ?? null;
  const differing: string[] = [];
  let compared = 0;
  for (const [path, sha] of prime) {
    if (scope && !scope.has(path)) continue;
    compared += 1;
    if (clone.get(path) !== sha) differing.push(path);
  }

  // The engine's own partition, against this clone's own policy. One
  // implementation — see the header.
  const { write, held } = partitionCascadePaths(differing, exclusions);

  let deletionCandidates = 0;
  for (const path of clone.keys()) {
    if (prime.has(path)) continue;
    if (scope && !scope.has(path)) continue;
    deletionCandidates += 1;
  }

  const owed = [...write].sort();
  return {
    kind: "measured",
    owed,
    fingerprint: owed.length === 0 ? null : fingerprintPaths(owed),
    deletionCandidates,
    held: held.length,
    compared,
  };
}

/**
 * One stable identity for one set of owed paths.
 *
 * Order-independent (the caller sorts), and a digest rather than the list
 * itself because an owed set can be several hundred paths wide and this is
 * compared on every pass. FNV-1a: no imports, deterministic across runtimes,
 * and a collision here costs one delayed alert rather than a wrong action.
 * The count is carried alongside so two different sets of the same size are
 * the only thing a collision could confuse.
 */
export function fingerprintPaths(sortedPaths: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const p of sortedPaths) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${sortedPaths.length}:${h.toString(16).padStart(8, "0")}`;
}

export type ConvergenceState =
  | "converged"
  | "delivering"
  | "stalled"
  | "falling_behind"
  | "unknown";

export type ConvergenceReading = {
  state: ConvergenceState;
  /** One sentence, for an operator, never a database word. */
  why: string;
  /** When the CURRENT owed set was first seen. Null when converged/unknown. */
  unchangedSince: string | null;
  /** Last moment this clone was observed holding everything it is owed. */
  lastConvergedAt: string | null;
  /** True exactly when this reading is one a person should be told about. */
  escalates: boolean;
};

/** What the previous pass recorded for this clone, if there was one. */
export type PriorObservation = {
  state: ConvergenceState;
  fingerprint: string | null;
  unchangedSince: string | null;
  lastConvergedAt: string | null;
};

/**
 * Turn one measurement into a verdict, against the clock and the pass before
 * it.
 *
 * The state machine, and the reasoning for each edge:
 *
 *   owed = ∅                          → `converged`. Both clocks reset.
 *   owed ≠ ∅, fingerprint CHANGED     → `delivering`. Work is moving; the
 *                                        unchanged-clock restarts and the
 *                                        converged-clock does NOT.
 *   owed ≠ ∅, same set, age < SLO     → `delivering`. This is the window the
 *                                        1,253 false alarms all fired inside.
 *   owed ≠ ∅, same set, age ≥ SLO     → `stalled`. Nothing has moved for
 *                                        longer than a delivery takes.
 *   never converged within N windows  → `falling_behind`, whatever the
 *                                        fingerprint is doing. See
 *                                        FALLING_BEHIND_WINDOWS.
 *   unmeasurable                      → `unknown`, and unknown is NEVER
 *                                        converged.
 *
 * `falling_behind` is checked BEFORE `delivering` is granted, because its whole
 * purpose is to overrule the appearance of movement.
 */
export function judgeConvergence(input: {
  now: Date;
  measurement: ConvergenceMeasurement;
  prior: PriorObservation | null;
  sloMinutes: number;
}): ConvergenceReading {
  const { now, measurement, prior, sloMinutes } = input;
  const nowIso = now.toISOString();
  const sloMs = Math.max(1, sloMinutes) * 60_000;

  if (measurement.kind === "unmeasurable") {
    // A read that FAILED is not a clone that is in sync. It keeps whatever the
    // last pass knew rather than inventing a fresh clock, so an outage cannot
    // launder a stall into a delivery by resetting its age.
    return {
      state: "unknown",
      why: measurement.why,
      unchangedSince: prior?.unchangedSince ?? null,
      lastConvergedAt: prior?.lastConvergedAt ?? null,
      escalates: false,
    };
  }

  if (measurement.owed.length === 0) {
    return {
      state: "converged",
      why: `Holds everything the cascade owes it (${measurement.compared} path(s) compared).`,
      unchangedSince: null,
      lastConvergedAt: nowIso,
      escalates: false,
    };
  }

  const changed = prior?.fingerprint !== measurement.fingerprint;
  const unchangedSince = changed ? nowIso : (prior?.unchangedSince ?? nowIso);
  const lastConvergedAt = prior?.lastConvergedAt ?? null;
  const unchangedMs = now.getTime() - new Date(unchangedSince).getTime();

  // Overrules movement. A fleet receiving nothing while prime pushes shows an
  // owed set that changes on every pass — which reads as progress and is not.
  if (lastConvergedAt !== null) {
    const sinceConverged = now.getTime() - new Date(lastConvergedAt).getTime();
    if (sinceConverged >= sloMs * FALLING_BEHIND_WINDOWS) {
      return {
        state: "falling_behind",
        why:
          `${measurement.owed.length} path(s) owed, and this clone has not held everything ` +
          `it is owed since ${lastConvergedAt} — over ${FALLING_BEHIND_WINDOWS} delivery ` +
          `windows ago. The owed set is moving; it is not reaching zero.`,
        unchangedSince,
        lastConvergedAt,
        escalates: true,
      };
    }
  }

  if (unchangedMs >= sloMs) {
    return {
      state: "stalled",
      why:
        `The same ${measurement.owed.length} path(s) have been owed since ${unchangedSince}, ` +
        `longer than one delivery window (${sloMinutes}m). Nothing is moving.`,
      unchangedSince,
      lastConvergedAt,
      escalates: true,
    };
  }

  return {
    state: "delivering",
    why:
      `${measurement.owed.length} path(s) owed` +
      (changed
        ? " and the set moved this pass"
        : `, unchanged for ${Math.round(unchangedMs / 60_000)}m`) +
      ` — inside the ${sloMinutes}m delivery window.`,
    unchangedSince,
    lastConvergedAt,
    escalates: false,
  };
}

/**
 * The first few owed paths, for a card and a notification body.
 *
 * A sample, explicitly labelled as one wherever it is rendered: a truncated
 * list that reads as complete is this repository's most repeated defect, and
 * `owed_count` beside it is the number that is true.
 */
export const OWED_SAMPLE_SIZE = 12;

export function owedSample(owed: readonly string[]): string[] {
  return owed.slice(0, OWED_SAMPLE_SIZE);
}
