/**
 * What a pull request's own state means for Mission Control's record of it.
 *
 * ## The two systems disagreed, permanently, in both directions
 *
 * A cascade result reached `pr_opened` and stopped there for ever. Nothing
 * revisited it. The merge drain merged the pull request on GitHub and wrote an
 * audit row; a person merging one by hand wrote nothing at all. Neither reached
 * `cascade_results`, `cascade_events.summary` or `clones`.
 *
 * Measured on 30 Aug 2026: pull requests #66 and #67 were merged at 07:55 and
 * 08:35 by the drain. Both rows still read `pr_opened`. Both parent events
 * still read `0 merged · 1 PRs`. The clone still read `behind`, still
 * `140 commits behind`, with `last_synced_sha` frozen at a commit from before
 * either of them landed. Mission Control's whole account of the fleet was
 * stale, and nothing anywhere could have refreshed it.
 *
 * The mirror image shipped alongside it: a pull request left open kept the
 * reason it was given in the second it was opened — "No check has reported on
 * this pull request" — long after every check had reported.
 *
 * ## The rule
 *
 * **The pull request's own state is the truth, and it is READ rather than
 * remembered.**
 *
 * Not "what the drain did", which misses every merge a person performed, every
 * merge that landed while this control plane was down, and every proposal an
 * operator closed. One `pulls.get` answers all of them, so a record that is
 * behind can always be brought forward — including one that fell behind before
 * any of this code existed.
 *
 * ## A summary has a durable half and a perishable half
 *
 * `diff_summary` used to be written once as `<reason> <files>`, and the reason
 * was the half that expired within minutes. So the two halves are separated
 * here rather than blended: the engine writes the FILES, which stay true
 * whatever becomes of the pull request, and this module owns the leading
 * outcome sentence and rewrites it on every pass. The vocabulary it strips is
 * exactly the vocabulary it writes — it never tries to parse the engine's
 * prose, because a summary this could not parse would be a summary it deleted.
 *
 * ## Why a closed-unmerged pull request is `skipped`
 *
 * `cascade_result_status` has no value for "a person declined this", and
 * inventing one means migrating an enum every reader already switches over.
 * `failed` is worse than useless: nothing failed, and it would colour the fleet
 * red and raise an error notification about a decision somebody made on
 * purpose. `skipped` is what the engine already writes for a cascade that
 * correctly did not land, and the summary says in words what happened.
 *
 * Client-safe: pure, no imports.
 */

/** Terminal-enough facts about a pull request, from one `pulls.get`. */
export type PullRequestFacts = {
  state: "open" | "closed";
  merged: boolean;
  /** The merge commit, when there is one. */
  mergeCommitSha?: string | null;
};

/** The statuses a reconciled cascade result can hold. */
export type ReconciledStatus = "succeeded" | "pr_opened" | "skipped";

export type ResultReconciliation = {
  status: ReconciledStatus;
  /** Short merge SHA, or null when nothing merged. */
  commitSha: string | null;
  diffSummary: string;
  /**
   * Whether the clone's own pointer should move. True only for a merge: a
   * proposal that is open, or was declined, changed nothing on the clone's
   * default branch, and advancing the pointer would tell an operator the change
   * had shipped.
   */
  advanceClone: boolean;
  /** Whether anything actually changed. False means write nothing at all. */
  changed: boolean;
};

/**
 * The pull request number in a GitHub pull request URL.
 *
 * Returns null rather than guessing. `pr_url` is the only handle a cascade
 * result keeps on its pull request, and a row whose URL cannot be parsed has to
 * be left exactly as it is — reconciling the wrong pull request would stamp a
 * merge onto a record that never had one.
 */
export function parsePrNumber(url: string | null | undefined): number | null {
  if (typeof url !== "string") return null;
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The owner/repo a pull request URL names, so a row can be checked against it. */
export function parsePrRepo(url: string | null | undefined): { owner: string; repo: string } | null {
  if (typeof url !== "string") return null;
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The outcome sentences this module writes — and therefore the only ones it
 * will strip. Anything else in a summary is the engine's, and is kept.
 */
const OUTCOME_PREFIX =
  /^(?:Merged(?: as [0-9a-f]{7,40})?\.|Closed without merging — this proposal was declined\.|Open · [^.]*\.)\s+/;

/** A summary with any previous outcome sentence removed. Idempotent. */
export function durableSummary(summary: string | null | undefined): string {
  if (typeof summary !== "string") return "";
  let s = summary.trim();
  // A loop, not a single strip: a row written by an earlier version of this
  // could carry two, and leaving one behind would contradict the one in front.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(OUTCOME_PREFIX, "");
    if (next === s) break;
    s = next.trim();
  }
  return s;
}

/**
 * Bring one `pr_opened` cascade result up to date with its pull request.
 *
 * `openReason` is what the caller has just learned about a pull request that is
 * still open — "verify is still running", "a required check is failing". It
 * replaces whatever this module said last time, and it is the reason a reader
 * sees, rather than one frozen at the moment the pull request was opened.
 */
export function reconcileResultToPr(input: {
  pr: PullRequestFacts;
  /** Whatever the row's `diff_summary` says now. */
  currentSummary: string | null;
  /** Why the pull request has not merged, when it is still open. */
  openReason?: string | null;
}): ResultReconciliation {
  const { pr, currentSummary } = input;
  const detail = durableSummary(currentSummary);

  if (pr.merged) {
    const short = pr.mergeCommitSha ? pr.mergeCommitSha.slice(0, 7) : null;
    const summary = join(`Merged${short ? ` as ${short}` : ""}.`, detail);
    return {
      status: "succeeded",
      commitSha: short,
      diffSummary: summary,
      advanceClone: true,
      changed: true,
    };
  }

  if (pr.state === "closed") {
    return {
      status: "skipped",
      commitSha: null,
      diffSummary: join("Closed without merging — this proposal was declined.", detail),
      advanceClone: false,
      changed: true,
    };
  }

  // An open pull request keeps its status and gets a current reason. The full
  // stop is part of the vocabulary above, so a reason carrying one of its own
  // would strip badly next pass — hence the trim.
  const reason = (input.openReason ?? "").trim().replace(/\.+$/, "");
  const summary = join(`Open · ${reason || "awaiting checks"}.`, detail);
  return {
    status: "pr_opened",
    commitSha: null,
    diffSummary: summary,
    advanceClone: false,
    // A still-open pull request is only worth a write when what can be said
    // about it has changed. Rewriting an identical row every five minutes
    // churns the realtime subscription every clone page holds open.
    changed: summary !== (currentSummary ?? "").trim(),
  };
}

function join(reason: string, detail: string): string {
  return detail ? `${reason} ${detail}` : reason;
}

export type CascadeCounts = {
  succeeded: number;
  opened: number;
  failed: number;
  skipped: number;
  total: number;
  owedReconcile: number;
};

/**
 * The one composer of a cascade event's summary line.
 *
 * It lived inline in the engine, which was fine while the engine was the only
 * thing that could ever write it. It is not any more — reconciliation changes
 * the counts after the run has finished — and two copies of this format is how
 * "0 merged" and "1 merged" come to be rendered by two writers in two shapes.
 */
export function summariseCascade(counts: CascadeCounts): string {
  return (
    `${counts.succeeded} merged · ${counts.opened} PRs · ${counts.failed} failed · ` +
    `${counts.skipped} skipped (of ${counts.total})` +
    (counts.owedReconcile > 0 ? ` · ${counts.owedReconcile} awaiting manual reconcile` : "")
  );
}

/** The event status those counts imply. The rule the engine has always used. */
export function cascadeEventStatus(
  counts: Pick<CascadeCounts, "succeeded" | "opened" | "failed">,
): "completed" | "failed" | "partial" {
  if (counts.failed > 0 && counts.succeeded + counts.opened === 0) return "failed";
  return counts.failed > 0 ? "partial" : "completed";
}

/** Tally a set of result rows into the counts the summary is composed from. */
export function countResults(
  rows: ReadonlyArray<{ status: string | null; diff_summary: string | null }>,
  owesReconcile: (summary: string | null) => boolean,
): CascadeCounts {
  const counts: CascadeCounts = {
    succeeded: 0,
    opened: 0,
    failed: 0,
    skipped: 0,
    total: rows.length,
    owedReconcile: 0,
  };
  for (const r of rows) {
    if (r.status === "succeeded") counts.succeeded += 1;
    else if (r.status === "pr_opened") counts.opened += 1;
    else if (r.status === "failed") counts.failed += 1;
    else if (r.status === "skipped") counts.skipped += 1;
    if (owesReconcile(r.diff_summary)) counts.owedReconcile += 1;
  }
  return counts;
}
