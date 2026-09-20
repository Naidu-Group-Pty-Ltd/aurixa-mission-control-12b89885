/**
 * Is the prime's own tree fit to travel?
 *
 * ## The gap this answers
 *
 * The cascade is rigorous about what it puts INTO a clone. `decideCascadeMerge`
 * refuses to merge a proposal whose checks have not reported, refuses one where
 * anything is red, refuses one nothing has built at all, and
 * `reclassifyAgainstBase` goes further and works out whether a failure is the
 * proposal's or the clone's own. Every one of those rules was bought by a
 * freeze.
 *
 * Nothing asks the same question one step earlier, of the repository the
 * proposal is COPIED FROM.
 *
 * Read `hooks.github.tsx`: a `push` to prime's default branch resolves
 * `prime_config`, confirms the repo and ref, and calls
 * `createCascadeForAllClones` — an unconditional fan-out to every clone in the
 * fleet. Prime's own check runs are not consulted, and they are not unavailable:
 * the same webhook receives prime's `check_suite` events and discards them,
 * under a comment that says so in as many words —
 *
 *     // Not a clone. The prime's own check suites arrive here too, and
 *     // the prime is not in the merge drain's work list.
 *
 * So a commit that fails `verify` on prime is proposed to every clone within
 * seconds of landing. In `pr` mode each clone opens a pull request that then
 * sits red, and the merge drain correctly refuses it — N pull requests, each
 * reported as `failing`, none of which any clone caused. In `auto_merge` mode
 * the gate holds and the fleet simply stops receiving code, silently, which is
 * the September shape: proposals growing to several hundred files while every
 * clone ran the prime as it stood days earlier.
 *
 * ## What this module is, and what it is NOT
 *
 * It is the reading. It is **not** a gate, and the surface that renders it says
 * so on the page rather than in a comment. Adding a real gate means refusing a
 * cascade, which is a change to the fan-out with its own failure mode — a
 * prime whose CI is merely slow would stop the fleet — and it is deliberately
 * not made here. What is closed is that the condition was not OBSERVABLE: there
 * was no surface in Mission Control that could answer "is the prime green?"
 * without opening GitHub.
 *
 * ## Why the judgement is borrowed rather than written
 *
 * `assessPrimeGate` calls `decideCascadeMerge` with `REQUIRED_CHECKS`. That is
 * the point rather than a convenience: **the prime is judged by exactly the
 * standard its own output is judged by one step later.** A second
 * implementation here would be a second opinion, and the first time the two
 * disagreed the page would be reassuring an operator about a tree the drain
 * was about to refuse.
 *
 * Everything in this file is pure so the classifications can be pinned by test
 * rather than described. Reaching GitHub lives in `prime-health.server.ts`.
 */

import {
  decideCascadeMerge,
  PASSING_CONCLUSIONS,
  REQUIRED_CHECKS,
  type CheckRun,
  type MergeVerdict,
} from "./cascade/autoMergeGate.pure";

export type { CheckRun, MergeVerdict };
export { REQUIRED_CHECKS };

/* ───────────────────────────── the gate reading ───────────────────────────── */

/**
 * Whether prime's head has been PROVEN fit to travel.
 *
 * Five states rather than two, for the reason this repository keeps paying:
 * "not proven" and "proven bad" have opposite remedies, and an unreadable
 * signal is neither. Collapsing them into a boolean is how `unknown` comes to
 * render green.
 *
 * - `proven`    — the required checks ran and passed. This tree has been built.
 * - `refused`   — something finished red. Cascading copies it to every clone.
 * - `in_flight` — CI is still working. The answer is not in yet; it is not a no.
 * - `unproven`  — nothing built this tree, or the jobs never started. Not a
 *                 failure of the code and not evidence for it either.
 * - `unknown`   — the signal could not be read at all.
 */
export type PrimeSafety = "proven" | "refused" | "in_flight" | "unproven" | "unknown";

/** Spine tones, so no surface picks its own colour for a state. */
export type SafetyTone = "ok" | "warn" | "bad" | "live" | "idle";

export type PrimeGate = {
  /** The verdict, from the same module the cascade applies to every clone. */
  verdict: MergeVerdict;
  safety: PrimeSafety;
  /** The state in an operator's terms, one sentence. */
  headline: string;
  /** Where it is fixed. `null` only when nothing is owed. */
  remedy: string | null;
  /**
   * The colour and the may-this-read-as-good flag, decided HERE and travelling
   * with the verdict.
   *
   * They used to be two exported helpers the page called. It could not: a
   * route is bundled for the browser and TanStack Start refuses a client
   * import of `src/server/**` outright, which is the correct boundary. The
   * alternative to travelling is a second copy of the mapping living in JSX,
   * which is the defect `PASSING_CONCLUSIONS` was just hoisted to close.
   *
   * So the judgement is made once, on the server, and the page renders it.
   */
  tone: SafetyTone;
  proven: boolean;
};

/**
 * A reason this build has never heard of is `unknown`, never `proven`.
 *
 * `MergeVerdict["reason"]` is a closed union today, so TypeScript makes this
 * record total and a new member upstream fails the typecheck here. The `??`
 * below is for the other direction — a verdict arriving from a deployment
 * running a newer `autoMergeGate` than this file — and it fails closed, which
 * is the same rule `payingCanUnlock` is an allow-list for.
 */
const SAFETY_BY_REASON: Record<Extract<MergeVerdict, { merge: false }>["reason"], PrimeSafety> = {
  failing: "refused",
  // A prime's default branch has no base to inherit from, so this cannot arise
  // from `assessPrimeGate`. It is mapped rather than omitted because a verdict
  // is a value that can be passed in from anywhere, and an unmapped member
  // would silently take the `unknown` fallback and read as a lost signal
  // instead of as the red tree it is.
  base_broken: "refused",
  pending: "in_flight",
  awaiting_required: "in_flight",
  no_checks: "unproven",
  never_started: "unproven",
  checks_unreadable: "unknown",
};

const HEADLINE: Record<PrimeSafety, string> = {
  proven: "Prime's head has been built and passed.",
  refused: "Prime's head is red. A cascade from here carries the failure to every clone.",
  in_flight: "Prime's head is still building. Nothing has been proven either way yet.",
  unproven: "Nothing has built prime's head. It is not passing; it is unexamined.",
  unknown: "Prime's checks could not be read. This is no signal, not a good one.",
};

const REMEDY: Record<PrimeSafety, string | null> = {
  proven: null,
  refused:
    "Fix the failing job on prime before the next push. Every clone that receives this " +
    "commit inherits the same red result, and the merge drain will correctly refuse each " +
    "of the resulting pull requests.",
  in_flight: null,
  unproven:
    "No check has reported on this commit. Confirm prime's workflows are enabled and " +
    "triggered by pushes to the default branch — a tree nothing builds is a tree the " +
    "fleet receives unexamined.",
  unknown:
    "Grant the Aurixa GitHub App the read-only `Checks` permission on the prime " +
    "repository (App settings → Permissions → Repository → Checks: Read-only) and accept " +
    "the permission request on the installation.",
};

/**
 * Judge prime's head by the cascade's own standard.
 *
 * `null` means the check runs could not be READ — a thrown request, a missing
 * permission. It is deliberately a different argument from `[]`, which means
 * the read succeeded and nothing has built this commit. The two look identical
 * from a caller that flattens them and have different remedies.
 */
export function assessPrimeGate(checks: readonly CheckRun[] | null): PrimeGate {
  if (checks === null) {
    const verdict: MergeVerdict = {
      merge: false,
      reason: "checks_unreadable",
      why: "The check runs on prime's head could not be read.",
    };
    return {
      verdict,
      safety: "unknown",
      headline: HEADLINE.unknown,
      remedy: REMEDY.unknown,
      tone: safetyTone("unknown"),
      proven: isProven("unknown"),
    };
  }

  const verdict = decideCascadeMerge(checks, REQUIRED_CHECKS);
  if (verdict.merge) {
    return {
      verdict,
      safety: "proven",
      headline: HEADLINE.proven,
      remedy: null,
      tone: safetyTone("proven"),
      proven: isProven("proven"),
    };
  }

  const safety = SAFETY_BY_REASON[verdict.reason] ?? "unknown";
  return {
    verdict,
    safety,
    headline: HEADLINE[safety],
    remedy: REMEDY[safety],
    tone: safetyTone(safety),
    proven: isProven(safety),
  };
}

/** The one place a safety state becomes a colour. */
export function safetyTone(safety: PrimeSafety): SafetyTone {
  switch (safety) {
    case "proven":
      return "ok";
    case "refused":
      return "bad";
    case "in_flight":
      return "live";
    case "unproven":
      return "warn";
    default:
      return "idle";
  }
}

/**
 * The one place that decides whether a state may be presented as good.
 *
 * Exported so a surface asks rather than compares. `safety === "proven"` written
 * at a call site is one refactor away from `safety !== "refused"`, which answers
 * yes to `unknown` — the exact shape of the payment-gate defect where a reason
 * word nobody recognised drew a full-width demand for money.
 */
export function isProven(safety: PrimeSafety): boolean {
  return safety === "proven";
}

/**
 * What ONE check run says, in the three words a reader needs.
 *
 * The page draws a row per check and needs a tone for each, which it first did
 * by inlining `["success", "neutral", "skipped", "stale"].includes(...)` — a
 * third copy of `PASSING_CONCLUSIONS` living in JSX, where no test would ever
 * reach it. The set is imported from the gate instead, so the row a human
 * reads and the verdict the cascade acts on cannot disagree about what
 * `cancelled` means.
 */
export type CheckOutcome = "passing" | "failing" | "running";

/** A check run with its verdict attached, ready for a surface to draw. */
export type HeadCheckReading = CheckRun & { outcome: CheckOutcome };

export function checkOutcome(check: CheckRun): CheckOutcome {
  if (check.status !== "completed") return "running";
  return PASSING_CONCLUSIONS.has(check.conclusion ?? "") ? "passing" : "failing";
}

/* ──────────────────────── did anything carry this head? ──────────────────── */

export type CascadeEventStatus = "pending" | "running" | "completed" | "failed" | "partial";

/** The subset of a `cascade_events` row this module judges. */
export type CascadeEventRef = {
  id: string;
  sourceSha: string | null;
  status: CascadeEventStatus;
  createdAt: string;
};

export type CoverageState = "carried" | "in_flight" | "uncarried" | "unknown";

export type CascadeCoverage = {
  state: CoverageState;
  /** The event that carries this head, when one does. */
  eventId: string | null;
  eventStatus: CascadeEventStatus | null;
  why: string;
};

/**
 * Two SHAs name the same commit.
 *
 * Exported because the gather side asks the same question of the cascade
 * ledger, and a prefix rule that differs by one character between the two
 * would cross-reference a commit against the wrong event. A stub shorter than
 * seven characters matches NOTHING rather than matching loosely: GitHub's own
 * abbreviation floor is seven, and three characters would collide across a
 * corpus this size.
 */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Whether prime's current head is on its way to the fleet.
 *
 * ## The subtlety that makes this worth a function
 *
 * "No cascade event names this SHA" does NOT mean the commit is stranded, and
 * reading it that way would raise a false alarm on the fleet's most ordinary
 * state. `createCascadeForAllClones` folds a push into an already-pending
 * cascade rather than creating a second one, and says why:
 *
 *     that event reads prime's head when it runs, so it will deliver this
 *     push's content and a second event would only repeat the work at full cost
 *
 * So a pending or running event covers prime's head **whatever SHA it was
 * created for**. The order below is therefore: an exact match first, because it
 * is the specific answer; then any event still to run, because it will read
 * head; and only then `uncarried`.
 *
 * `uncarried` is the one worth surfacing. It means prime has moved, no event
 * names that commit, and none is queued that would pick it up — the webhook did
 * not arrive, or it was declined. Today nothing anywhere reports that.
 */
export function assessCascadeCoverage(args: {
  headSha: string | null;
  /** Most recent first. `null` when the read failed — never an empty array. */
  events: readonly CascadeEventRef[] | null;
}): CascadeCoverage {
  const { headSha, events } = args;

  if (!headSha) {
    return {
      state: "unknown",
      eventId: null,
      eventStatus: null,
      why: "Prime's head commit could not be read, so nothing can be said about what carries it.",
    };
  }
  if (events === null) {
    return {
      state: "unknown",
      eventId: null,
      eventStatus: null,
      why: "The cascade ledger could not be read. A failed read is not an absence of cascades.",
    };
  }

  const exact = events.find((e) => sameCommit(e.sourceSha, headSha));
  if (exact) {
    const inFlight = exact.status === "pending" || exact.status === "running";
    return {
      state: inFlight ? "in_flight" : "carried",
      eventId: exact.id,
      eventStatus: exact.status,
      why: inFlight
        ? `A cascade for this commit is ${exact.status}.`
        : `A cascade for this commit exists and reports ${exact.status}.`,
    };
  }

  const queued = events.find((e) => e.status === "pending" || e.status === "running");
  if (queued) {
    return {
      state: "in_flight",
      eventId: queued.id,
      eventStatus: queued.status,
      why:
        "No cascade names this commit, but one is still to run and reads prime's head when " +
        "it does — this push folds into it rather than opening a second event.",
    };
  }

  return {
    state: "uncarried",
    eventId: null,
    eventStatus: null,
    why:
      "Prime has moved and no cascade carries this commit, nor is one queued that would pick " +
      "it up. The push webhook did not arrive, or it was declined.",
  };
}

/* ───────────────────────────── the workflow trend ─────────────────────────── */

/** One workflow run, as GitHub reports it. */
export type WorkflowRun = {
  id: number;
  name: string;
  /** `completed` | `in_progress` | `queued` | `requested` | `waiting` */
  status: string;
  /** `success` | `failure` | `cancelled` | `skipped` | `neutral` | … | null */
  conclusion: string | null;
  headSha: string;
  headBranch: string | null;
  event: string;
  createdAt: string;
  htmlUrl: string;
};

/**
 * Conclusions that are not a verdict on the tree.
 *
 * Deliberately WIDER than the merge gate's `PASSING`, and the difference is the
 * question being asked. The gate asks "may this merge?", where a cancelled run
 * is not evidence the tree is good and must therefore block. A trend asks "how
 * often does prime break?", where counting operator-cancelled and
 * path-filtered runs as failures reports a repository as unreliable because
 * somebody pressed cancel.
 *
 * So they are a third bucket rather than either of the first two, and the
 * success rate is computed over decided runs alone.
 */
const INCONCLUSIVE = new Set(["cancelled", "skipped", "neutral", "stale"]);

export type WorkflowSummary = {
  name: string;
  total: number;
  succeeded: number;
  failed: number;
  inconclusive: number;
  running: number;
  /** `null` when nothing in the window DECIDED. A rate over zero runs is not 0%. */
  successRate: number | null;
  lastConclusion: string | null;
  lastFailureAt: string | null;
};

export type WorkflowTrend = {
  workflows: WorkflowSummary[];
  totals: {
    runs: number;
    succeeded: number;
    failed: number;
    inconclusive: number;
    running: number;
    successRate: number | null;
  };
  /**
   * How many of the most recent decided runs failed before the first success.
   * A standing red is a different condition from an occasional one, and the
   * difference is invisible in a rate.
   */
  consecutiveFailures: number;
  /** True when the window contains no decided run at all. */
  empty: boolean;
};

function isFailure(run: WorkflowRun): boolean {
  if (run.status !== "completed") return false;
  const c = run.conclusion ?? "";
  if (c === "success") return false;
  return !INCONCLUSIVE.has(c);
}

function isSuccess(run: WorkflowRun): boolean {
  return run.status === "completed" && run.conclusion === "success";
}

/**
 * Roll a window of runs into a per-workflow reading and one streak.
 *
 * `runs` must be newest first — GitHub returns them that way and the streak
 * depends on it. Sorting here would hide a caller that passed them the other
 * way round, so the order is a documented precondition and the caller keeps it.
 */
export function summariseWorkflowRuns(runs: readonly WorkflowRun[]): WorkflowTrend {
  const byName = new Map<string, WorkflowRun[]>();
  for (const run of runs) {
    const list = byName.get(run.name);
    if (list) list.push(run);
    else byName.set(run.name, [run]);
  }

  const workflows: WorkflowSummary[] = [...byName.entries()]
    .map(([name, list]) => {
      const succeeded = list.filter(isSuccess).length;
      const failed = list.filter(isFailure).length;
      const running = list.filter((r) => r.status !== "completed").length;
      const inconclusive = list.length - succeeded - failed - running;
      const decided = succeeded + failed;
      const lastFailure = list.find(isFailure);
      const lastDecided = list.find((r) => isSuccess(r) || isFailure(r));
      return {
        name,
        total: list.length,
        succeeded,
        failed,
        inconclusive,
        running,
        successRate: decided === 0 ? null : Math.round((succeeded / decided) * 100),
        lastConclusion: lastDecided?.conclusion ?? null,
        lastFailureAt: lastFailure?.createdAt ?? null,
      };
    })
    // Worst first: the reason to open this section is to find what is breaking,
    // and a null rate (nothing decided) sorts beside a bad one rather than at
    // the healthy end, because "unmeasured" is not "fine".
    .sort((a, b) => {
      const ra = a.successRate ?? -1;
      const rb = b.successRate ?? -1;
      if (ra !== rb) return ra - rb;
      return b.total - a.total;
    });

  const succeeded = workflows.reduce((n, w) => n + w.succeeded, 0);
  const failed = workflows.reduce((n, w) => n + w.failed, 0);
  const inconclusive = workflows.reduce((n, w) => n + w.inconclusive, 0);
  const running = workflows.reduce((n, w) => n + w.running, 0);
  const decided = succeeded + failed;

  let consecutiveFailures = 0;
  for (const run of runs) {
    if (isSuccess(run)) break;
    if (isFailure(run)) consecutiveFailures++;
    // Running and inconclusive runs are stepped over rather than breaking the
    // streak: a cancelled run between two failures does not make prime healthy
    // for an instant, and a job still running has not yet had an opinion.
  }

  return {
    workflows,
    totals: {
      runs: runs.length,
      succeeded,
      failed,
      inconclusive,
      running,
      successRate: decided === 0 ? null : Math.round((succeeded / decided) * 100),
    },
    consecutiveFailures,
    empty: decided === 0,
  };
}

/* ─────────────────── what is waiting to become the next payload ───────────── */

export type PrimePullRequest = {
  number: number;
  title: string;
  author: string | null;
  draft: boolean;
  headSha: string;
  headRef: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
};

/**
 * `unobserved` is a first-class reading and never a pass.
 *
 * CI for an open pull request is resolved from the SAME run window the trend is
 * built from rather than by fetching per pull request, which would cost one
 * GitHub call each against an hourly allowance this fleet has already exhausted
 * twice. The trade is that a pull request whose head has no run in the window —
 * older than the window, or never built — cannot be judged, and it says so
 * rather than defaulting to green.
 */
export type PullRequestCi = "passing" | "failing" | "running" | "unobserved";

export type PullRequestReading = PrimePullRequest & { ci: PullRequestCi };

/**
 * What the run window says about ONE commit.
 *
 * Shared by the open pull requests and by the commit ledger, because they are
 * the same question asked of two lists and a second copy is how two surfaces
 * on one page come to disagree about the same SHA.
 */
export function readCiForHead(headSha: string, runs: readonly WorkflowRun[]): PullRequestCi {
  const mine = runs.filter((r) => sameCommit(r.headSha, headSha));
  if (mine.length === 0) return "unobserved";
  if (mine.some(isFailure)) return "failing";
  if (mine.some((r) => r.status !== "completed")) return "running";
  if (mine.some(isSuccess)) return "passing";
  // Everything that reported was inconclusive — cancelled or skipped. Nothing
  // built this head, which is `unobserved` rather than a pass.
  return "unobserved";
}

export function readPullRequests(
  prs: readonly PrimePullRequest[],
  runs: readonly WorkflowRun[],
): PullRequestReading[] {
  return prs.map((pr) => ({ ...pr, ci: readCiForHead(pr.headSha, runs) }));
}

/* ─────────────────────────── the one-line posture ─────────────────────────── */

export type PrimePosture = {
  tone: SafetyTone;
  /** One uppercase mono word for the spine's label. */
  word: string;
  sentence: string;
};

/**
 * The single answer at the top of the page.
 *
 * Precedence is stated rather than emergent, because two conditions can be true
 * at once and the page has one headline:
 *
 * 1. **A red head outranks everything.** It is the condition that breaks clones,
 *    and it is the reason this surface exists.
 * 2. **Then an uncarried head.** Prime's work is not travelling, which is a
 *    fleet-wide stall wearing the costume of a quiet day.
 * 3. **Then anything unproven or unreadable**, because neither is a pass.
 * 4. Only a proven head with something carrying it reads as settled.
 */
export function assessPosture(gate: PrimeGate, coverage: CascadeCoverage): PrimePosture {
  if (gate.safety === "refused") {
    return {
      tone: "bad",
      word: "red",
      sentence: gate.headline,
    };
  }

  if (coverage.state === "uncarried") {
    return {
      tone: "warn",
      word: "stranded",
      sentence:
        "Prime's head is not travelling. " +
        (isProven(gate.safety) ? "The tree is good and nothing is carrying it." : gate.headline),
    };
  }

  if (gate.safety === "unknown") {
    return { tone: "idle", word: "unreadable", sentence: gate.headline };
  }
  if (gate.safety === "unproven") {
    return { tone: "warn", word: "unproven", sentence: gate.headline };
  }
  if (gate.safety === "in_flight") {
    return { tone: "live", word: "building", sentence: gate.headline };
  }

  return {
    tone: "ok",
    word: coverage.state === "in_flight" ? "cascading" : "clear",
    sentence:
      coverage.state === "in_flight"
        ? "Prime's head has passed and a cascade is carrying it to the fleet."
        : "Prime's head has passed and a cascade has carried it.",
  };
}

/** First line of a commit message, bounded. Commit bodies reach the page. */
export function commitHeadline(message: string, max = 120): string {
  const first = message.split("\n", 1)[0]?.trim() ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
