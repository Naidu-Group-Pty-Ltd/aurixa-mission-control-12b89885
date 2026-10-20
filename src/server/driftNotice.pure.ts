/**
 * When the fleet drift scan raises a `drift_high` notification.
 *
 * ## The defect
 *
 * The scan meant to notify when a clone ENTERS a behind state, not on every
 * scan while it stays there. Its guard read the clone's `sync_status`:
 * `behind` or `failed` meant "already behind", and anything else meant the
 * clone had just arrived. But a clone whose cascade is open, or cannot finish,
 * sits in `cascading` for days. So the guard never held there, and the
 * second half of it, "a high suggestion whose title the last scan did not
 * have", always holds: the titles are model-authored and are never the same
 * twice.
 *
 * Measured 20 Oct 2026: 4,625 unread `drift_high` notices, 1,934 of them in
 * the last seven days. NPC CRM Independent drew one at 08:30, 08:45, 09:01,
 * 09:15 (two) and 09:31 UTC, each about the same 939 commits, each in new
 * words. They made up 79% of the "Needs attention" inbox, beside the seven
 * notices that parked every clone's backend deploys on 12–13 Oct, which
 * nobody read for a week.
 *
 * ## The rule
 *
 * **A standing condition is announced once, when it begins.** The scan cannot
 * see the measurement change, because it no longer writes it (`drift-refresh`
 * does), but it can see what it said last time: the suggestions it stored on
 * the clone. A scan that stored a high suggestion has announced the episode,
 * so the next one raises nothing, whatever the model calls it now. An episode
 * ends when a scan stores no high suggestion: the clone caught up (the scan
 * stores none at zero behind), or the model rated it lower.
 *
 * The `behind` / `failed` guard stays exactly as it was, so nothing is raised
 * that was not raised before; this only stops the repeats.
 */

/** What this rule reads of a suggestion. */
export type DriftSuggestionLike = {
  readonly severity: string;
  readonly title: string;
};

/** The statuses the scan has always treated as "already behind". */
const ALREADY_BEHIND_STATUSES: ReadonlySet<string> = new Set(["behind", "failed"]);

/** Whether a scan's suggestions hold one rated high. */
function holdsHigh(suggestions: ReadonlyArray<DriftSuggestionLike> | null | undefined): boolean {
  return (suggestions ?? []).some((s) => s.severity === "high");
}

/**
 * The high suggestions this scan should notify about, or none.
 *
 * `previous` is what the last scan stored on the clone (`drift_suggestions`),
 * and `current` is this scan's answer.
 */
export function driftNoticesToRaise<T extends DriftSuggestionLike>(input: {
  syncStatus: string | null | undefined;
  previous: ReadonlyArray<DriftSuggestionLike> | null | undefined;
  current: ReadonlyArray<T>;
}): T[] {
  if (ALREADY_BEHIND_STATUSES.has(input.syncStatus ?? "")) return [];
  if (holdsHigh(input.previous)) return [];
  return input.current.filter((s) => s.severity === "high");
}
