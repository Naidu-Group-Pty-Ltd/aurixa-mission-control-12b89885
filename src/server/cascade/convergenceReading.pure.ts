/**
 * What a card may say about a clone's convergence.
 *
 * ## Why this is a module and not four lines in a component
 *
 * Step 7 of `CASCADE_PIPELINE_HEALTH.md`, and the shipping order puts the
 * surface last for a stated reason: **a card is a claim that the reading under
 * it is true.** Everything upstream of here writes observations nobody acted
 * on; this is the first thing that shows one to a person, so the judgements it
 * makes — is this reading current, does it agree with the pointer, is this a
 * state somebody must do something about — are the judgements most worth
 * testing and least worth having twice.
 *
 * ## The thing it exists to make visible
 *
 * `clones.sync_status` and `clones.commits_behind` are the answer the ENGINE
 * wrote: `sync_status` ← `commits_behind` ← `last_synced_sha` ← the merge
 * drain ← the engine. The auditor's answer comes from comparing the two trees.
 * When those disagree, the disagreement is the whole point of the programme —
 * it is the 84-commit lie of 16 Sep, visible before anybody has to go looking
 * for it — so the card draws BOTH and names the disagreement rather than
 * quietly preferring one.
 *
 * Only the DIRECTION is comparable. `commits_behind` counts commits and `owed`
 * counts paths; one commit can touch two hundred files and two hundred commits
 * can touch one. Comparing the magnitudes would manufacture a contradiction
 * out of two correct readings, so nothing here does.
 */
import type { ConvergenceState } from "./convergence.pure";

/**
 * How often `/hooks/cascade-audit` runs, as its cron schedules it
 * (`7,22,37,52 * * * *`).
 *
 * Named here rather than inferred, and pinned by a test that reads the
 * migration — a staleness threshold derived from a cadence nobody states is
 * how the two come to disagree, which is `drainLimits.pure.ts`'s lesson.
 */
export const AUDIT_CADENCE_MINUTES = 15;

/**
 * How many passes may be missed before the reading stops being current.
 *
 * Three, because one missed pass is a slow run and two is a coincidence. The
 * audit yields below the scan floor when the installation budget is short, so
 * a skipped pass is ordinary operation rather than a fault — which is exactly
 * why the wording this produces states WHEN the reading was taken and never
 * diagnoses why the next one has not been.
 */
export const MISSED_PASSES_BEFORE_STALE = 3;

export const READING_STALE_AFTER_MINUTES = AUDIT_CADENCE_MINUTES * MISSED_PASSES_BEFORE_STALE;

/**
 * States that mean somebody has to do something.
 *
 * Declared once because step 3's escalation and this card must alarm on the
 * same set. Two copies is how a badge goes red on a page while the channel
 * stays silent, or the reverse.
 *
 * `unknown` is deliberately absent: it is "we could not check", not "you have
 * a problem", and colouring it like a fault is the defect `useAmlAccess` paid
 * for — a lost signal announced as the server's own "no".
 */
export const CONVERGENCE_ATTENTION_STATES: ReadonlySet<ConvergenceState> =
  new Set<ConvergenceState>(["stalled", "falling_behind"]);

export function convergenceNeedsAttention(state: ConvergenceState): boolean {
  return CONVERGENCE_ATTENTION_STATES.has(state);
}

/**
 * How the measured reading sits against the pointer the engine wrote.
 *
 * `ledger_optimistic` is the one this programme exists for: the pointer says
 * level and the repositories say otherwise. `ledger_pessimistic` is ordinary
 * and benign — a delivery has landed and the pointer has not caught up yet —
 * and is reported rather than hidden, because an operator who sees "4 behind"
 * beside "nothing owed" should be told which is which.
 */
export type LedgerAgreement =
  | "agree"
  | "ledger_optimistic"
  | "ledger_pessimistic"
  | "not_comparable";

export type LedgerPosition = {
  syncStatus: string | null;
  commitsBehind: number | null;
};

export function compareToLedger(input: {
  state: ConvergenceState;
  owed: number;
  ledger: LedgerPosition;
}): LedgerAgreement {
  const { state, owed, ledger } = input;
  // An `unknown` measurement is not a reading, so it contradicts nothing.
  if (state === "unknown") return "not_comparable";
  // A pointer nobody has written is not a disagreeing opinion.
  if (ledger.commitsBehind === null) return "not_comparable";

  const ledgerSaysBehind = ledger.commitsBehind > 0 || ledger.syncStatus === "drifted";
  const treesSayOwed = owed > 0;

  if (treesSayOwed && !ledgerSaysBehind) return "ledger_optimistic";
  if (!treesSayOwed && ledgerSaysBehind) return "ledger_pessimistic";
  return "agree";
}

/** One observation, as the card's server function read it. */
export type ObservationRow = {
  observedAt: string;
  state: ConvergenceState;
  owedCount: number;
  heldCount: number;
  oversizeHeld: number;
  comparedCount: number;
  deletionCandidates: number;
  owedSample: readonly string[];
  unchangedSince: string | null;
  lastConvergedAt: string | null;
  sloMinutes: number | null;
  why: string | null;
};

export type ConvergenceCardReading =
  | {
      kind: "measured";
      state: ConvergenceState;
      /** False when the newest observation is older than the audit's own cadence allows. */
      current: boolean;
      observedAt: string;
      ageMinutes: number;
      owed: number;
      held: number;
      oversizeHeld: number;
      compared: number;
      deletionCandidates: number;
      owedSample: readonly string[];
      /** How long the CURRENT owed set has stood, where one is standing. */
      unchangedMinutes: number | null;
      lastConvergedAt: string | null;
      sloMinutes: number | null;
      needsAttention: boolean;
      agreement: LedgerAgreement;
      /** The auditor's own words for an `unknown`, carried through unedited. */
      why: string | null;
    }
  /**
   * No observation exists for this clone.
   *
   * Distinct from `unavailable` on purpose, and distinct from `converged`
   * with more purpose still: an empty read is not a clean bill of health, and
   * every clone reads this way until the audit's first pass.
   */
  | { kind: "never_measured" }
  /**
   * The read itself failed.
   *
   * "We could not check" is not "there is nothing to report" — the rule this
   * repository has now paid for on feature flags, on AML access and on every
   * geocoder. A card that rendered this as converged would be the most
   * expensive lie on the page.
   */
  | { kind: "unavailable"; why: string };

function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((a.getTime() - b.getTime()) / 60_000));
}

export function readConvergenceForCard(input: {
  now: Date;
  observation: ObservationRow | null;
  ledger: LedgerPosition;
}): ConvergenceCardReading {
  const { now, observation, ledger } = input;
  if (!observation) return { kind: "never_measured" };

  const observedAt = new Date(observation.observedAt);
  const ageMinutes = minutesBetween(now, observedAt);
  const unchangedMinutes = observation.unchangedSince
    ? minutesBetween(now, new Date(observation.unchangedSince))
    : null;

  return {
    kind: "measured",
    state: observation.state,
    current: ageMinutes <= READING_STALE_AFTER_MINUTES,
    observedAt: observation.observedAt,
    ageMinutes,
    owed: observation.owedCount,
    held: observation.heldCount,
    oversizeHeld: observation.oversizeHeld,
    compared: observation.comparedCount,
    deletionCandidates: observation.deletionCandidates,
    owedSample: observation.owedSample,
    unchangedMinutes,
    lastConvergedAt: observation.lastConvergedAt,
    sloMinutes: observation.sloMinutes,
    needsAttention: convergenceNeedsAttention(observation.state),
    agreement: compareToLedger({
      state: observation.state,
      owed: observation.owedCount,
      ledger,
    }),
    why: observation.why,
  };
}
