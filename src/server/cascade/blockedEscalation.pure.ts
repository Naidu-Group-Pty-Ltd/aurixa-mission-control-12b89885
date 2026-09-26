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
 * shape never alerts twice while the first notification is unread.
 *
 * ## Clearing is the proposal CLOSING, not only the merge
 *
 * A proposal that landed marks its blocked notifications read, so the next
 * freeze starts loud again. That was the whole clearing rule, and it assumed
 * the only way a proposal stops being open is by merging. It is not: the
 * lateral lane closes a proposal that has nothing left to offer, an operator
 * closes one — which the notice's own last line tells them to do — and a
 * person merges one by hand. None of those went through the drain's merge, so
 * none cleared anything, and the notice stood for ever over a pull request
 * that no longer existed as a proposal.
 *
 * It did not stand quietly. The blockage ledger reads every unread notice as
 * the gate's verdict on the clone's CURRENT proposal, so it reported `ci_red`
 * on three clones for days over pull requests that had closed: NPC Test on
 * #115 and Preflight on #114, both closed unmerged two minutes after they
 * opened on 20 Sep 2026, and the independent on #23, closed unmerged on
 * 24 Sep — with #11 standing behind it, merged outside the drain on 20 Sep
 * and still unread six days later. A standing alarm about a closed pull
 * request describes nothing anybody can act on, and a list carrying one is a
 * list that has stopped being a list of what needs doing.
 *
 * So a proposal clears its alarm however it closes. What stays loud is the
 * CONDITION: if the successor proposal fails the same way, it raises its own
 * notice under its own number, and a clone that is still behind with nothing
 * to explain it is the ledger's `unclassified`, which is louder still. This is
 * `decideDriftReport`'s rule — compare against what was last OBSERVED —
 * applied to the merge drain.
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

/**
 * A standing blocked notice as the drain reads it back.
 *
 * `pr` is `metadata.pr` exactly as stored, so it is typed wide: every notice
 * this drain raises carries a number there, and anything else is a notice
 * this helper declines to act on rather than one it guesses about.
 */
export type StandingBlockedNotice = {
  pr: unknown;
  /** The repository the notice's URL names, or null when it has no URL. */
  urlRepo: { owner: string; repo: string } | null;
  /** The pull request number the notice's URL names, or null. */
  urlPr: number | null;
};

/**
 * The pull requests a clone's standing blocked notices name that this drain
 * pass has NOT already read — the ones it must look up to learn whether they
 * closed.
 *
 * Four refusals, each on the side of leaving a notice standing, because the
 * failure worth avoiding is clearing an alarm about a proposal that is still
 * open and still failing:
 *
 * - **A number it cannot read is left alone.** No `metadata.pr`, or one that
 *   is not a positive integer, names no pull request to ask about.
 * - **A notice naming another repository is left alone.** This clone was once
 *   re-pointed off a personal fork, and `pull/42` read in the new repository
 *   answers about a real, unrelated pull request — the hazard the drain's row
 *   handling already refuses for the same reason.
 * - **A notice whose URL and metadata disagree is left alone.** Two numbers
 *   for one pull request is a record nobody should act on by picking one.
 * - **A pull request this pass already read is not asked about again.** The
 *   per-proposal handling clears the notice itself when it finds the pull
 *   request closed, so a second read would spend a request to learn nothing.
 *   The set is what was READ, never what the work list carries: a proposal
 *   the per-run cap left out is on the work list and unread, and excluding it
 *   let an alarm about a closed pull request stand for as long as twenty-five
 *   newer proposals stayed open ahead of it.
 *
 * Returned ascending and without repeats: several notices — one per failure
 * shape — can name the same pull request, and one read answers all of them.
 */
export function blockedNoticesToRecheck(
  notices: readonly StandingBlockedNotice[],
  ctx: { owner: string; repo: string; alreadyRead: ReadonlySet<number> },
): number[] {
  const out = new Set<number>();
  for (const n of notices) {
    const pr =
      typeof n.pr === "number"
        ? n.pr
        : typeof n.pr === "string" && /^\d+$/.test(n.pr)
          ? Number(n.pr)
          : NaN;
    if (!Number.isInteger(pr) || pr <= 0) continue;
    if (n.urlRepo && (n.urlRepo.owner !== ctx.owner || n.urlRepo.repo !== ctx.repo)) continue;
    if (n.urlPr !== null && n.urlPr !== pr) continue;
    if (ctx.alreadyRead.has(pr)) continue;
    out.add(pr);
  }
  return [...out].sort((a, b) => a - b);
}
