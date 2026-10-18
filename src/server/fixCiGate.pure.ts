/**
 * When a security fix may merge on its repository's own CI.
 *
 * ## Why this exists
 *
 * Fix pull requests are opened by the remediation workflow's `GITHUB_TOKEN`,
 * and GitHub starts no workflow for a pull request that token opens. So the
 * repository's CI — on Prime, every gate in `ci.yml` and the frozen
 * `bun.lockb` install Lovable publishes from — never ran on a fix, and a fix
 * merged on the workflow's own checks alone could break `main` the way #280
 * did: typecheck, lint and tests green, and no publish reaching the site.
 *
 * From workflow version 4 the remediation workflow names the CI it found in
 * the base (`verification.ci`). Mission Control dispatches that workflow on
 * the fix branch with its App token — events from an App token do start
 * workflows — and merges only once the run on the verified commit passed.
 *
 * ## The rule
 *
 * - No CI named (a workflow older than version 4, or a repository with no
 *   CI): the fix workflow's own checks are the gate, as before.
 * - CI named but without a `workflow_dispatch` trigger: the fix does not
 *   merge. A repository that has CI relies on it, and merging around it is
 *   how `main` breaks.
 * - Otherwise: no run on the commit yet → dispatch one (once); running →
 *   wait; passed → merge; finished any other way → do not merge. The wait is
 *   bounded: a CI that has not passed within `FIX_CI_WAIT_MS` of the first
 *   look does not merge either, and the finding is tried again another night.
 *
 * Pure: the GitHub reads and writes are the caller's (self-healing.server.ts).
 */
import { PASSING_CONCLUSIONS } from "./cascade/autoMergeGate.pure";

/** How long a fix waits for its CI before it is closed instead. */
export const FIX_CI_WAIT_MS = 3 * 60 * 60 * 1000;

export type FixCiSpec = {
  /** `.github/workflows/<file>`, or null when the repository has none. */
  workflow: string | null;
  /** Whether that workflow declares `workflow_dispatch`. */
  dispatchable: boolean;
};

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/;

/**
 * The CI a fix's workflow named in its verification, or null when it named
 * none (workflow versions before 4). A malformed path counts as no CI named
 * rather than as a file to dispatch.
 */
export function fixCiSpec(verification: unknown): FixCiSpec | null {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    return null;
  }
  const ci = (verification as { ci?: unknown }).ci;
  if (!ci || typeof ci !== "object" || Array.isArray(ci)) return null;
  const { workflow, dispatchable } = ci as { workflow?: unknown; dispatchable?: unknown };
  return {
    workflow: typeof workflow === "string" && WORKFLOW_PATH.test(workflow) ? workflow : null,
    dispatchable: dispatchable === true,
  };
}

/** One workflow run on the fix's head commit, as GitHub lists it. */
export type FixCiRun = {
  id: number;
  /** `.github/workflows/ci.yml`, sometimes followed by `@<ref>`. */
  path: string | null;
  /** `queued` | `in_progress` | `completed` | … */
  status: string | null;
  conclusion: string | null;
};

export type FixCiVerdict =
  | { kind: "merge"; why: string }
  | { kind: "dispatch"; why: string }
  | { kind: "wait"; why: string }
  | { kind: "refuse"; why: string };

export function decideFixCi(input: {
  spec: FixCiSpec | null;
  /** Workflow runs on the verified head commit. */
  runs: readonly FixCiRun[];
  /** Whether Mission Control has already dispatched the CI for this fix. */
  dispatched: boolean;
  /** When the merge was first attempted; the wait is measured from here. */
  firstLookAt: number;
  now: number;
}): FixCiVerdict {
  const { spec } = input;
  if (!spec?.workflow) {
    return {
      kind: "merge",
      why: "the repository names no CI, so the fix workflow's own checks are the gate",
    };
  }
  const workflow = spec.workflow;
  if (!spec.dispatchable) {
    return {
      kind: "refuse",
      why: `${workflow} has no workflow_dispatch trigger, so it cannot run on a fix PR`,
    };
  }

  // The newest run of this workflow on the commit: a re-run supersedes the
  // run it repeats.
  const latest = input.runs
    .filter((r) => (r.path ?? "").split("@")[0] === workflow)
    .reduce<FixCiRun | null>((best, r) => (!best || r.id > best.id ? r : best), null);
  const overdue = input.now - input.firstLookAt > FIX_CI_WAIT_MS;
  const limit = `${Math.round(FIX_CI_WAIT_MS / 3_600_000)} hours`;

  if (!latest) {
    if (!input.dispatched) return { kind: "dispatch", why: `starting ${workflow} on the fix` };
    return overdue
      ? { kind: "refuse", why: `${workflow} never started on the fix within ${limit}` }
      : { kind: "wait", why: `${workflow} has not started on the fix yet` };
  }
  if (latest.status !== "completed") {
    return overdue
      ? { kind: "refuse", why: `${workflow} did not finish on the fix within ${limit}` }
      : { kind: "wait", why: `${workflow} is ${latest.status ?? "queued"} on the fix` };
  }
  if (PASSING_CONCLUSIONS.has(latest.conclusion ?? "")) {
    return { kind: "merge", why: `${workflow} passed on the fix` };
  }
  return {
    kind: "refuse",
    why: `${workflow} ended ${latest.conclusion ?? "without a conclusion"} on the fix`,
  };
}
