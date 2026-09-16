/**
 * One queued commit cascade carries every prime commit behind it.
 *
 * ## The queue that grew faster than it drained
 *
 * Every push to prime's default branch creates one `commit` cascade event,
 * and prime takes ~50 a day. `executeCascade` reads the branch HEAD at run
 * time — an event never delivers the commit that created it, it delivers
 * prime as prime stands when the pass runs — so two pending commit events
 * are not two pieces of work. They are the same piece of work, twice, at
 * ~300 file reads and blob creates per clone each.
 *
 * In September 2026 that multiplication met a proposal that could not go
 * green (the builder-portal retirement) and the two compounded: nothing
 * merged, so every pass stayed maximally large; every prime commit queued
 * another full-cost repeat; the App's hourly budget rate-limited the passes
 * mid-flight; and the backlog grew while every proposal's title fell further
 * behind prime. The fleet froze for two days with the engine working
 * continuously.
 *
 * ## The rule
 *
 * **At most one commit cascade waits.** Two folds enforce it:
 *
 * - at CREATION, a new commit event stands down when an unclaimed pending
 *   commit event already exists — that event will deliver this push's
 *   content anyway, because it reads prime's head when it runs;
 * - at CLAIM, any backlog that predates the rule (or slipped through the
 *   creation race) is folded: the OLDEST unclaimed pending commit event is
 *   kept — its result rows are the ones carrying pass progress — and the
 *   rest are closed as superseded, results and all.
 *
 * ## What is never folded
 *
 * A `manual` event is an operator's explicit act — a re-run after fixing an
 * exclusion — and a `scheduled` one is a policy's. Both are kept. So is any
 * event awaiting a second-operator approval (folding it would silently
 * discharge a gate), any event a worker has claimed (it is running, not
 * waiting), any event carrying a scope filter (it delivers a named module,
 * not prime's head), and any event whose MODE differs from the survivor's
 * (folding a `pr` proposal into an `auto_merge` one would change what
 * happens to the tree, not just when).
 *
 * Client-safe: pure, no imports.
 */

export type FoldableEvent = {
  id: string;
  trigger: string;
  mode: string;
  status: string;
  requires_approval: boolean;
  worker_started_at: string | null;
  scope_filter: unknown;
  created_at: string;
  attempts: number;
};

/**
 * Mirrors the drain's own claim ceiling. An event at or past it is pending
 * in name only — no claim will ever take it — so it may neither SURVIVE a
 * fold (folding live work into a dead carrier stalls the queue behind a row
 * nothing will run) nor be superseded by one (its story is the drain's
 * failure handling, not this fold's).
 */
export const FOLD_MAX_ATTEMPTS = 3;

/** Whether a scope filter narrows anything. `{}` and null do not. */
export function scopeFilterIsEmpty(scopeFilter: unknown): boolean {
  if (scopeFilter == null) return true;
  if (typeof scopeFilter !== "object" || Array.isArray(scopeFilter)) return false;
  return Object.keys(scopeFilter as Record<string, unknown>).length === 0;
}

/** Whether one event is a fold candidate at all — see the module header. */
export function isFoldableCommitEvent(e: FoldableEvent): boolean {
  return (
    e.trigger === "commit" &&
    e.status === "pending" &&
    e.worker_started_at === null &&
    e.requires_approval === false &&
    e.attempts < FOLD_MAX_ATTEMPTS &&
    scopeFilterIsEmpty(e.scope_filter)
  );
}

export type FoldDecision = {
  /** The event that keeps the queue's place, or null when nothing is foldable. */
  keep: string | null;
  /** Events to close as superseded — same mode as the survivor, newer than it. */
  supersede: string[];
};

/**
 * Which pending commit events to fold, given the queue as it stands.
 *
 * The OLDEST foldable event survives: its result rows are the ones that may
 * carry a paused pass's prepared-blob list, and the creation-time fold means
 * the oldest is also the one the drain has been advancing. Only events of
 * the SAME MODE fold into it; a foldable event of another mode is left
 * alone, which at worst costs one redundant pass rather than changing what
 * lands on a clone.
 */
export function decideEventFold(events: readonly FoldableEvent[]): FoldDecision {
  const foldable = events
    .filter(isFoldableCommitEvent)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (foldable.length === 0) return { keep: null, supersede: [] };
  const survivor = foldable[0];
  return {
    keep: survivor.id,
    supersede: foldable
      .slice(1)
      .filter((e) => e.mode === survivor.mode)
      .map((e) => e.id),
  };
}

/**
 * The summary a superseded event carries. It names the survivor so the row
 * explains itself in the ledger — a closed event with no story is one an
 * operator re-arms by hand.
 */
export function supersededSummary(survivorId: string): string {
  return (
    `Superseded: folded into queued cascade ${survivorId.slice(0, 8)} — a commit cascade ` +
    `delivers prime's head at run time, so one queued event carries every commit behind it.`
  );
}
