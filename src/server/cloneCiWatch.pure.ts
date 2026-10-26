/**
 * WHAT A CLONE'S OWN CI IS DOING, read back from GitHub rather than assumed.
 *
 * ## The gap this closes
 *
 * Mission Control configures a clone repository's CI — the deployer
 * declaration, the `supabase-production` credentials, the workflows the
 * cascade carries — and until this module it never once looked at what that CI
 * then did. Measured 26 Oct 2026, on all four clones:
 *
 *   - `aml-sanctions-refresh.yml` had failed 18 to 21 scheduled runs in a row,
 *     `rba-refresh.yml` 28 to 30, `migration-drift.yml` 19 to 21 and
 *     `aml-pep-officeholders-refresh.yml` every weekly run in the window. The
 *     CRM line's drift report had never passed: 35 runs, 35 failures. Each
 *     one is a clone serving stale sanctions lists, a stale cash rate or an
 *     unverified schema, and the sanctions one fails AML screening closed once
 *     the list is 72 hours old;
 *   - `vcr-prune.yml` failed every Sunday on two clones that should never have
 *     carried it: it is NPC Client Dashboard's own Vercel retention job, and it
 *     reached its two children by lineage cascade;
 *   - the CRM line's `apply-migration.yml` had fallen behind the prime's — no
 *     `environment: supabase-production`, so it could not read the credential
 *     this platform distributes — because the path is `protected`, and a
 *     protected path is withheld from every cascade without comment.
 *
 * Nothing said any of it. A configuration this platform writes is not a job
 * that runs: this reads the job.
 *
 * ## Three findings, and what each one is NOT
 *
 *  - `failing` — a scheduled workflow whose last FAILING_STREAK scheduled runs
 *    failed with no success of the same workflow on the default branch since.
 *    One failure is not a finding: a runner that died is not a job that is
 *    broken, and a channel that cries at every flake is one people mute.
 *  - `stopped` — a workflow with a schedule that GitHub has disabled
 *    (`disabled_inactivity` after 60 quiet days, or `disabled_manually`). It
 *    fails nothing, which is exactly why it needs saying.
 *  - `differs` — a `protected` workflow whose copy here is not the prime's.
 *    The cascade will never write it, by design; this says that a person has
 *    to decide whether the prime's change belongs here too. It is not a claim
 *    that the copy is wrong — protected paths may differ on purpose — so it is
 *    raised once per change on either side and never repeated.
 *
 * ## A success proven by hand counts
 *
 * The streak ends at the newest SUCCESSFUL run of the workflow on the default
 * branch, scheduled or dispatched. Measured the day this was written: every
 * clone's refresh had been repaired and proven by `workflow_dispatch` on main,
 * while its scheduled history was still solidly red, because the next scheduled
 * run had not come round. A watch reading the schedule alone would have opened
 * with eleven alarms about four jobs that already worked. A failed DISPATCH, on
 * the other hand, never extends a streak: somebody trying something by hand is
 * not the schedule failing.
 *
 * The cost of that rule is bounded and stated: a green dry run can end a streak
 * the schedule would have continued, which delays an alarm by FAILING_STREAK
 * runs and never loses one.
 *
 * ## A failed read is not a clean clone
 *
 * Every input arrives as a value or as `null` for "could not be read", and a
 * clone with any `null` input is `unreadable`: nothing is recorded for it, so
 * its last observed findings stand and the next pass asks again. Recording an
 * empty reading there would write a clearance nobody earned, and announce the
 * same failures afresh once the read came back.
 */

/** The audit action this watch records under, and how it reads its own past. */
export const CLONE_CI_WATCH_ACTION = "clone_ci_watch";

/** Consecutive failing scheduled runs before a workflow is called failing. */
export const FAILING_STREAK = 2;

/**
 * A workflow whose newest scheduled run is older than this is not judged.
 *
 * Its schedule has been removed from the file, or GitHub has stopped running
 * it — and when GitHub stops one it says so in the workflow's state, which is
 * read separately. The weekly jobs are the slowest on the fleet, so a fortnight
 * and a day is two missed weeks, not one late runner.
 */
export const STALE_AFTER_DAYS = 15;

const FAILING_CONCLUSIONS = new Set(["failure", "startup_failure", "timed_out"]);
const STOPPED_STATES = new Set(["disabled_inactivity", "disabled_manually"]);

/** One workflow run, as `GET /repos/{o}/{r}/actions/runs` reports it. */
export type WorkflowRunFact = {
  /** The workflow file, `.github/workflows/<name>.yml`. */
  path: string;
  name: string;
  event: string;
  headBranch: string | null;
  status: string;
  conclusion: string | null;
  createdAt: string;
  htmlUrl: string;
};

/** Whether GitHub has stopped running a workflow, as opposed to it being gone. */
export function isStoppedState(state: string): boolean {
  return STOPPED_STATES.has(state);
}

/**
 * Whether a workflow file declares a schedule.
 *
 * `schedule` takes a list of crons, so it is always written as a key; the flow
 * form `on: [push, schedule]` cannot carry one.
 */
export function declaresSchedule(workflowText: string): boolean {
  return /^\s*["']?schedule["']?\s*:/m.test(workflowText);
}

/** One workflow, as `GET /repos/{o}/{r}/actions/workflows` reports it. */
export type WorkflowFact = {
  path: string;
  name: string;
  state: string;
  /**
   * Whether the file itself declares a schedule. Read only for a workflow
   * GitHub has stopped — usually none — because a stopped workflow runs
   * nothing, so the run listing cannot say whether it ever had a schedule
   * once its last runs have aged out of the window.
   */
  hasSchedule?: boolean;
};

/** A protected workflow path, and the blob each side holds (null: absent). */
export type ProtectedWorkflowFact = {
  path: string;
  primeSha: string | null;
  cloneSha: string | null;
};

export type CiFinding =
  | {
      kind: "failing";
      path: string;
      name: string;
      /** Scheduled runs failed since the last success. A lower bound: the window ends. */
      streak: number;
      lastRunUrl: string;
      /** Newest success on the default branch in the window, or null when there is none. */
      lastSuccessAt: string | null;
    }
  | { kind: "stopped"; path: string; name: string; state: string }
  | { kind: "differs"; path: string; primeSha: string; cloneSha: string };

export type CloneCiInputs = {
  defaultBranch: string;
  /** Scheduled runs, newest first, or null when they could not be read. */
  scheduledRuns: readonly WorkflowRunFact[] | null;
  /** Dispatched runs, newest first, or null when they could not be read. */
  dispatchedRuns: readonly WorkflowRunFact[] | null;
  workflows: readonly WorkflowFact[] | null;
  /** Null when either side's workflow listing or the exclusions could not be read. */
  protectedWorkflows: readonly ProtectedWorkflowFact[] | null;
  /** The reading's clock, as epoch milliseconds. */
  now: number;
};

export type CloneCiReading =
  | { kind: "read"; findings: CiFinding[] }
  | { kind: "unreadable"; missing: string[] };

const byNewest = (a: WorkflowRunFact, b: WorkflowRunFact) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * Judge one clone's CI from what GitHub reported about it.
 *
 * Pure: the reads happen in `cloneCiWatch.server.ts`, so the part that decides
 * what an operator is told is testable without a token.
 */
export function judgeCloneCi(input: CloneCiInputs): CloneCiReading {
  const missing: string[] = [];
  if (input.scheduledRuns === null) missing.push("scheduled runs");
  if (input.dispatchedRuns === null) missing.push("dispatched runs");
  if (input.workflows === null) missing.push("workflows");
  if (input.protectedWorkflows === null) missing.push("protected workflows");
  if (
    input.scheduledRuns === null ||
    input.dispatchedRuns === null ||
    input.workflows === null ||
    input.protectedWorkflows === null
  ) {
    return { kind: "unreadable", missing };
  }

  const stateOf = new Map(input.workflows.map((w) => [w.path, w]));
  const findings: CiFinding[] = [];

  const scheduledByPath = new Map<string, WorkflowRunFact[]>();
  for (const run of input.scheduledRuns) {
    const list = scheduledByPath.get(run.path) ?? [];
    list.push(run);
    scheduledByPath.set(run.path, list);
  }

  // Stopped is judged from the workflow listing, which is not bounded by the
  // run window. A stopped workflow produces no runs, so the window would lose
  // it within weeks and the finding would read as cleared while GitHub still
  // had it switched off. A disabled workflow with no schedule (dispatch-only)
  // stops nothing that was going to run, and is not a finding.
  for (const w of input.workflows) {
    if (!STOPPED_STATES.has(w.state)) continue;
    if (scheduledByPath.has(w.path) || w.hasSchedule === true) {
      findings.push({ kind: "stopped", path: w.path, name: w.name, state: w.state });
    }
  }

  for (const [path, scheduled] of scheduledByPath) {
    const workflow = stateOf.get(path);
    // A workflow the repository no longer lists, or lists as deleted, cannot
    // be failing: its red history belongs to a file that is gone. Without this
    // a workflow removed BECAUSE it was wrong would be reported until its runs
    // aged out of the window. A stopped one was judged above.
    if (!workflow || workflow.state !== "active") continue;

    const newestScheduled = [...scheduled].sort(byNewest)[0];
    if (input.now - Date.parse(newestScheduled.createdAt) > STALE_AFTER_DAYS * 86_400_000) continue;

    const onDefault = [...scheduled, ...input.dispatchedRuns.filter((r) => r.path === path)]
      .filter((r) => r.event === "schedule" || r.headBranch === input.defaultBranch)
      .filter((r) => r.status === "completed")
      .sort(byNewest);

    let streak = 0;
    let lastRunUrl: string | null = null;
    let lastSuccessAt: string | null = null;
    for (const run of onDefault) {
      if (run.conclusion === "success") {
        lastSuccessAt = run.createdAt;
        break;
      }
      // Only the schedule extends the streak. Cancelled, skipped and neutral
      // runs say nothing about the job either way, and are stepped over.
      if (run.event === "schedule" && FAILING_CONCLUSIONS.has(run.conclusion ?? "")) {
        streak += 1;
        lastRunUrl ??= run.htmlUrl;
      }
    }

    if (streak >= FAILING_STREAK && lastRunUrl) {
      findings.push({
        kind: "failing",
        path,
        name: workflow.name,
        streak,
        lastRunUrl,
        lastSuccessAt,
      });
    }
  }

  for (const p of input.protectedWorkflows) {
    // Absent on either side is not drift. A protected workflow a clone does
    // not carry is a decision (the CRM line holds two of those by its owner's
    // word), and one the prime does not carry was never the prime's to send.
    if (p.primeSha === null || p.cloneSha === null) continue;
    if (p.primeSha !== p.cloneSha) {
      findings.push({ kind: "differs", path: p.path, primeSha: p.primeSha, cloneSha: p.cloneSha });
    }
  }

  return {
    kind: "read",
    findings: findings.sort((a, b) => findingKey(a).localeCompare(findingKey(b))),
  };
}

/**
 * One finding's identity across passes.
 *
 * The streak is deliberately NOT part of it. A job failing once a day would
 * otherwise be a new finding once a day, and announced as one. `differs`
 * carries both blobs, so a change on EITHER side is news again: the prime
 * moving is the moment somebody must decide, and so is the clone's copy being
 * edited without becoming the prime's.
 */
export function findingKey(f: CiFinding): string {
  switch (f.kind) {
    case "failing":
      return `failing:${f.path}`;
    case "stopped":
      return `stopped:${f.path}:${f.state}`;
    case "differs":
      return `differs:${f.path}@${f.primeSha}:${f.cloneSha}`;
  }
}

export function ciFingerprint(findings: readonly CiFinding[]): string {
  return [...new Set(findings.map(findingKey))].sort().join("|");
}

/**
 * What a clone's record says, as two separate facts.
 *
 * `fingerprint` is what was OBSERVED. `announced` is the part of it somebody
 * has actually been TOLD — the keys whose notification landed. They are kept
 * apart because a notification can fail where the observation does not: a
 * notification that never arrived must be tried again, and a record that
 * conflated the two would read "already announced" for ever.
 */
export type CiObservation = { fingerprint: string; announced: readonly string[] };

/**
 * The observation an audit row carries, or null when it carries none.
 *
 * A row written before `announced` existed claimed its whole fingerprint as
 * told, which is how it is read back.
 */
export function readCiObservation(metadata: unknown): CiObservation | null {
  const m = metadata as { fingerprint?: unknown; announced?: unknown } | null;
  if (typeof m?.fingerprint !== "string") return null;
  const announced = Array.isArray(m.announced)
    ? m.announced.filter((k): k is string => typeof k === "string")
    : m.fingerprint.split("|").filter(Boolean);
  return { fingerprint: m.fingerprint, announced };
}

/**
 * The findings nobody has been told about yet, or `previous` null when this
 * clone has never been watched. A standing finding whose last notification did
 * not land is in here again, which is the point.
 */
export function findingsToAnnounce(input: {
  previous: CiObservation | null;
  findings: readonly CiFinding[];
}): CiFinding[] {
  const told = new Set(input.previous?.announced ?? []);
  return input.findings.filter((f) => !told.has(findingKey(f)));
}

/**
 * What to write down once the announcement has been attempted.
 *
 * `announced` keeps only findings still standing, so a clearance forgets it:
 * a failure that clears and comes back is news again. Nothing is written for
 * a clean clone that was clean, nor for a pass that changed neither fact — so
 * a notification that keeps failing is retried every pass without a row per
 * attempt. A clearance is recorded and never announced (whoever fixed it
 * knows), and losing one of two failures repeats nothing about the other.
 */
export function settleCiReport(input: {
  previous: CiObservation | null;
  findings: readonly CiFinding[];
  announced: readonly CiFinding[];
  delivered: boolean;
}): { record: boolean; observation: CiObservation } {
  const fingerprint = ciFingerprint(input.findings);
  const standing = new Set(input.findings.map(findingKey));
  const told = new Set(input.previous?.announced ?? []);
  if (input.delivered) for (const f of input.announced) told.add(findingKey(f));
  const announced = [...told].filter((k) => standing.has(k)).sort();

  const previous = input.previous ?? { fingerprint: "", announced: [] };
  const record =
    fingerprint !== previous.fingerprint ||
    announced.join("|") !== [...previous.announced].sort().join("|");
  return { record, observation: { fingerprint, announced } };
}

export type CloneCiOutcome =
  | { clone: string; outcome: "clean" }
  | {
      clone: string;
      outcome: "attention";
      findings: CiFinding[];
      announced: number;
      /** Findings whose notification did not land this pass, and will be retried. */
      undelivered: number;
    }
  | { clone: string; outcome: "cleared" }
  | { clone: string; outcome: "unreadable"; missing: string[] }
  | { clone: string; outcome: "failed"; error: string };

export type CloneCiWatchReport = {
  clones: number;
  /** Clones with at least one standing finding. */
  attention: number;
  /** Findings announced this pass. */
  announced: number;
  /** Findings whose notification did not land this pass. */
  undelivered: number;
  /** Clones whose findings cleared this pass. */
  cleared: number;
  /** Clones the watch could not read this pass, and so did not judge. */
  unreadable: number;
  failed: number;
  detail: CloneCiOutcome[];
};

/**
 * Whether a pass deserves a row of its own beside the per-clone records.
 *
 * Every finding already lands on its clone's own history, and a quiet pass is
 * almost every pass. What has no other record is the watch failing to look,
 * or failing to tell.
 */
export function ciWatchIsNoteworthy(report: CloneCiWatchReport): boolean {
  return report.unreadable > 0 || report.failed > 0 || report.undelivered > 0;
}

const short = (sha: string) => sha.slice(0, 7);
const file = (path: string) => path.replace(/^\.github\/workflows\//, "");

/** One line per finding, named in full: a notification is read without the repository open. */
export function describeCiFinding(f: CiFinding): string {
  switch (f.kind) {
    case "failing":
      return (
        `${file(f.path)} — the last ${f.streak} scheduled run${f.streak === 1 ? "" : "s"} failed` +
        (f.lastSuccessAt
          ? `; last success ${f.lastSuccessAt.slice(0, 16).replace("T", " ")} UTC`
          : "; no success on the default branch in the window") +
        `. ${f.lastRunUrl}`
      );
    case "stopped":
      return `${file(f.path)} — GitHub has stopped scheduling it (${f.state}). Nothing fails, and nothing runs.`;
    case "differs":
      return (
        `${file(f.path)} — protected here, and this copy (${short(f.cloneSha)}) is not the prime's ` +
        `(${short(f.primeSha)}). No cascade will carry the prime's change: carry it by hand, or ` +
        `record why this copy differs.`
      );
  }
}

/** The severity of an announcement: a job that does not run outranks a copy that differs. */
export function ciSeverity(findings: readonly CiFinding[]): "error" | "warning" {
  return findings.some((f) => f.kind !== "differs") ? "error" : "warning";
}
