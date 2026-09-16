/**
 * A proposal that cannot go green is a fact a person is owed, once.
 *
 * ## The two silent days
 *
 * From 14 September 2026 every clone's cascade proposal failed `verify` and
 * `security` on every rebuilt head — prime's builder-portal retirement needed
 * a held file and a deletion set the engine refuses on purpose — and the
 * auto-merge gate correctly declined, on every pass, for two days. Every
 * signal was individually correct: the pull request body named the held
 * files, the run notifications said "1 awaiting manual reconcile" (the same
 * words they say on a healthy run), and the drain held the proposal with a
 * true sentence about failing checks. Nothing distinguished "waiting on CI"
 * from "will fail forever until a person acts", so nobody acted, and the
 * fleet froze at a two-day-old prime with the engine working continuously.
 *
 * This is the platform's own oldest lesson — a green (or calmly yellow)
 * signal about the wrong question — so the escalation asks the right one:
 * **is this proposal failing the same way it failed before?** A first
 * failure is CI doing its job. The SAME failure on a REBUILT head is a
 * standing condition, and a standing condition gets exactly one loud
 * notification until it changes shape or clears.
 *
 * ## The dedupe is a fingerprint, not a timer
 *
 * The fingerprint is the pull request number plus the gate's own verdict
 * sentence — which names each failing check and its conclusion, so a failure
 * that changes shape (a new check joins, one clears) re-alerts, and the same
 * shape never alerts twice while the first notification is unread. Clearing
 * is the merge: a proposal that landed marks its blocked notifications read,
 * so the next freeze starts loud again. This is `decideDriftReport`'s rule
 * — compare against what was last OBSERVED — applied to the merge drain.
 *
 * Client-safe: pure, no imports.
 */

/** One stable identity for one way of being blocked. */
export function blockedFingerprint(prNumber: number, verdictWhy: string): string {
  return `${prNumber}:${verdictWhy}`;
}

/**
 * The notification a blocked proposal raises. The body leads with the
 * failing checks and carries the result row's own durable summary, because
 * that is where the engine already wrote what a person is owed — the
 * hand-reconcile paths and any refused deletion set.
 */
export function describeBlockedProposal(args: {
  cloneLabel: string;
  prNumber: number;
  prUrl: string | null;
  verdictWhy: string;
  /** The newest result row's diff_summary, when there is one. */
  durableSummary: string | null;
}): { title: string; body: string } {
  const { cloneLabel, prNumber, prUrl, verdictWhy, durableSummary } = args;
  const lines = [
    `Cascade PR #${prNumber} on ${cloneLabel} is failing the same way on a rebuilt head — ` +
      `this does not clear on its own.`,
    verdictWhy,
  ];
  if (durableSummary) lines.push(`The proposal carries: ${durableSummary}`);
  lines.push(
    `Act in Mission Control: reconcile or approve the held paths, approve the refused ` +
      `deletion set if one is named, or close the proposal.` +
      (prUrl ? ` ${prUrl}` : ""),
  );
  return {
    title: `Cascade blocked · ${cloneLabel} · PR #${prNumber}`,
    body: lines.join("\n\n"),
  };
}
