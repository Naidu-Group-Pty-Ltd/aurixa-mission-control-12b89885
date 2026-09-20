/**
 * Everything the /prime page reads, gathered in one pass.
 *
 * ## The shape, and why it is this shape
 *
 * Seven independent questions are asked of two systems, and **each one fails on
 * its own and names its own failure.** There is no combined try/catch and no
 * `Promise.all` that rejects: a repository whose pull requests cannot be listed
 * still has a head, a head whose checks cannot be read still has a cascade
 * ledger, and an operator opening this page during a GitHub incident should get
 * the six answers that are available rather than one error card.
 *
 * That is not defensive habit, it is this repository's own rule paid three
 * times over — `useAmlAccess` collapsing a failed read into the server's "no",
 * `uploads.length` reading `[]` in flight and `[]` on error, the Places lookup
 * storing `count: 0` for a provider that never answered. A failed read is never
 * an empty one, so every `*Error` field below is a separate channel from its
 * data.
 *
 * ## The call budget
 *
 * Six GitHub calls, and the count is deliberate. This installation's hourly
 * window is the scarcest resource in the system and has been exhausted twice
 * (see `githubUsageMeter.ts`), so the two obvious extravagances are both
 * refused:
 *
 *  - **CI per pull request** would be one call each. Instead every head — pull
 *    requests AND recent commits — is matched against ONE run window, and a
 *    head the window does not name reads `unobserved` rather than green.
 *  - **Checks per commit** would be one call per row of the commit ledger.
 *    Same window, same rule.
 *
 * The window's own bounds are returned (`trendWindow`) so the page can say what
 * it is reading rather than implying it read everything.
 *
 * The calls are attributed with `beginGithubLane` so they land in
 * `api_usage_events` under this lane instead of `unattributed` — the whole
 * point of that ledger is answering "what spent the window?", and an
 * operator-facing page that can be opened repeatedly is exactly the kind of
 * spend worth being able to see.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import { beginGithubLane, flushGithubUsage } from "./githubUsageMeter";
import { readGitHubRemaining } from "./githubAllowance.server";
import {
  assessCascadeCoverage,
  assessPosture,
  assessPrimeGate,
  checkOutcome,
  commitHeadline,
  readCiForHead,
  readPullRequests,
  sameCommit,
  summariseWorkflowRuns,
  type CascadeCoverage,
  type CascadeEventRef,
  type CheckRun,
  type HeadCheckReading,
  type PrimeGate,
  type PrimePosture,
  type PrimePullRequest,
  type PullRequestCi,
  type PullRequestReading,
  type WorkflowRun,
  type WorkflowTrend,
} from "./primeHealth.pure";

type SupabaseLike = SupabaseClient<Database>;
type CascadeEventStatus = Database["public"]["Enums"]["cascade_event_status"];
type CascadeResultStatus = Database["public"]["Enums"]["cascade_result_status"];
type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

/**
 * How many workflow runs the window holds.
 *
 * One page of the maximum GitHub serves. It is the whole budget for CI on the
 * commit ledger and on every open pull request, so a smaller page would buy
 * `unobserved` rows rather than calls saved.
 */
const RUN_WINDOW = 100;

/** Commits on the default branch shown in the ledger. */
const COMMIT_LEDGER = 15;

/** Cascade events consulted for coverage and for the ledger's cross-reference. */
const EVENT_WINDOW = 60;

/* ────────────────────────────── the payload ──────────────────────────────── */

export type PrimeRepoRef = {
  owner: string;
  repo: string;
  defaultBranch: string;
  htmlUrl: string;
  installationId: string | null;
  /** What a push to the default branch will do to the fleet. */
  cascadeMode: CascadeMode;
  /** Whether the cascade follows recorded lineage rather than raw head. */
  followsLineage: boolean;
  /** The prime BACKEND, a separate half — see docs/PRIME_HAS_TWO_HALVES.md. */
  supabaseProjectRef: string | null;
};

export type PrimeHeadCommit = {
  sha: string;
  shortSha: string;
  headline: string;
  author: string | null;
  authoredAt: string | null;
  htmlUrl: string;
  /** GitHub's own word: is the default branch protected? */
  branchProtected: boolean;
};

export type PrimeCommitReading = {
  sha: string;
  shortSha: string;
  headline: string;
  author: string | null;
  authoredAt: string | null;
  htmlUrl: string;
  /** Resolved from the run window. `unobserved` is never a pass. */
  ci: PullRequestCi;
  /** The cascade event naming this commit, when one exists. */
  cascadeEventId: string | null;
  cascadeStatus: CascadeEventStatus | null;
};

export type CloneDelivery = {
  cloneId: string;
  name: string;
  slug: string;
  status: CascadeResultStatus;
  prUrl: string | null;
  errorMessage: string | null;
  filesChanged: number;
};

export type DeliveryReading = {
  eventId: string;
  sourceSha: string | null;
  status: CascadeEventStatus;
  mode: CascadeMode;
  summary: string | null;
  createdAt: string;
  clones: CloneDelivery[];
};

export type PrimeHealth =
  | {
      configured: false;
      /** Names the setting, never "something went wrong". */
      reason: string;
      readAt: string;
    }
  | {
      configured: true;
      repo: PrimeRepoRef;
      readAt: string;

      /** The commit the whole page describes. `null` when GitHub was unreachable. */
      head: PrimeHeadCommit | null;
      headError: string | null;

      gate: PrimeGate;
      /**
       * Every check run on the head, each carrying its own verdict.
       *
       * The outcome travels rather than being re-derived by the page: a route
       * is bundled for the browser and cannot import this module's judgement,
       * so the alternative is a copy of `PASSING_CONCLUSIONS` in JSX.
       */
      headChecks: HeadCheckReading[];
      /**
       * Why the check runs could not be read, when they could not.
       *
       * Separate from `gate.safety === "unknown"` on purpose: the gate says
       * what the reading MEANS and this says what went wrong, and a surface
       * that needs the second should not have to infer it from the first.
       */
      headChecksError: string | null;

      coverage: CascadeCoverage;
      posture: PrimePosture;

      trend: WorkflowTrend;
      trendWindow: { runs: number; oldest: string | null; newest: string | null };
      trendError: string | null;

      commits: PrimeCommitReading[];
      commitsError: string | null;

      pullRequests: PullRequestReading[];
      pullRequestsError: string | null;

      delivery: DeliveryReading | null;
      deliveryError: string | null;

      /** What is left of the App installation's hourly window. `null` = unread. */
      rateLimitRemaining: number | null;
    };

/* ─────────────────────────────── the gather ──────────────────────────────── */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

export async function getPrimeHealth(supabase: SupabaseLike): Promise<PrimeHealth> {
  const readAt = new Date().toISOString();

  // One literal string, deliberately. PostgREST's generated types resolve the
  // row shape from the select text itself, so a concatenated expression infers
  // `GenericStringError` and every field read below becomes a type error that
  // looks like a missing column. It is long; it is not splittable.
  const { data: prime, error: primeError } = await supabase
    .from("prime_config")
    .select(
      "github_owner, github_repo, default_branch, github_app_installation_id, default_cascade_mode, cascade_follows_lineage, supabase_project_ref",
    )
    .limit(1)
    .maybeSingle();

  // A read that FAILED is not a prime that is ABSENT, and the two send an
  // operator to opposite places — a database fault versus an unconfigured
  // fleet.
  if (primeError) {
    return {
      configured: false,
      reason: `The prime configuration could not be read: ${primeError.message}`,
      readAt,
    };
  }
  if (!prime) {
    return {
      configured: false,
      reason:
        "No prime is configured. Set `prime_config` (owner, repository and default branch) " +
        "on the GitHub settings page — until it is set there is no repository for this page " +
        "to describe and no source for any cascade.",
      readAt,
    };
  }

  const repo: PrimeRepoRef = {
    owner: prime.github_owner,
    repo: prime.github_repo,
    defaultBranch: prime.default_branch || "main",
    htmlUrl: `https://github.com/${prime.github_owner}/${prime.github_repo}`,
    installationId: prime.github_app_installation_id,
    cascadeMode: prime.default_cascade_mode,
    followsLineage: prime.cascade_follows_lineage,
    supabaseProjectRef: prime.supabase_project_ref,
  };

  beginGithubLane("prime-health");
  try {
    return await gather(supabase, repo, readAt);
  } finally {
    // The count is already captured; never let bookkeeping fail the read.
    await flushGithubUsage().catch(() => {});
  }
}

async function gather(
  supabase: SupabaseLike,
  repo: PrimeRepoRef,
  readAt: string,
): Promise<PrimeHealth> {
  const { owner, repo: name, defaultBranch } = repo;

  let octokit: ReturnType<typeof getAppOctokit>;
  try {
    octokit = getAppOctokit(repo.installationId ?? undefined);
  } catch (e) {
    // No App credentials at all. Every GitHub half is unavailable; the ledger
    // half still is, so the page is assembled from what the database knows.
    return assemble({
      supabase,
      repo,
      readAt,
      head: null,
      headError: `The Aurixa GitHub App is not configured: ${message(e)}`,
      checks: null,
      checksError: `The Aurixa GitHub App is not configured: ${message(e)}`,
      runs: null,
      runsError: `The Aurixa GitHub App is not configured: ${message(e)}`,
      commits: null,
      commitsError: `The Aurixa GitHub App is not configured: ${message(e)}`,
      prs: null,
      prsError: `The Aurixa GitHub App is not configured: ${message(e)}`,
      rateLimitRemaining: null,
    });
  }

  // The branch is resolved FIRST and everything else is keyed on the SHA it
  // returns, so the whole page describes one commit. Asking each endpoint for
  // `main` independently would let a push land mid-read and produce a page
  // whose checks, commits and coverage silently describe two different trees.
  let head: PrimeHeadCommit | null = null;
  let headError: string | null = null;
  try {
    const { data: branch } = await octokit.repos.getBranch({
      owner,
      repo: name,
      branch: defaultBranch,
    });
    head = {
      sha: branch.commit.sha,
      shortSha: branch.commit.sha.slice(0, 7),
      headline: commitHeadline(branch.commit.commit?.message ?? ""),
      author: branch.commit.author?.login ?? branch.commit.commit?.author?.name ?? null,
      authoredAt: branch.commit.commit?.author?.date ?? null,
      htmlUrl: branch.commit.html_url,
      branchProtected: Boolean(branch.protected),
    };
  } catch (e) {
    const err = e as { status?: number };
    headError =
      err.status === 404
        ? `The App cannot see ${owner}/${name}, or the branch "${defaultBranch}" does not ` +
          `exist. Check the installation covers the prime repository.`
        : message(e);
  }

  const [checksRes, runsRes, commitsRes, prsRes, remaining] = await Promise.all([
    head
      ? octokit.checks
          .listForRef({ owner, repo: name, ref: head.sha, per_page: 100 })
          .then((r) => ({ ok: true as const, data: r.data }))
          .catch((e: unknown) => ({ ok: false as const, error: message(e) }))
      : Promise.resolve({ ok: false as const, error: "No head commit to read checks for." }),
    octokit.actions
      .listWorkflowRunsForRepo({ owner, repo: name, per_page: RUN_WINDOW })
      .then((r) => ({ ok: true as const, data: r.data }))
      .catch((e: unknown) => ({ ok: false as const, error: message(e) })),
    octokit.repos
      .listCommits({ owner, repo: name, sha: defaultBranch, per_page: COMMIT_LEDGER })
      .then((r) => ({ ok: true as const, data: r.data }))
      .catch((e: unknown) => ({ ok: false as const, error: message(e) })),
    octokit.pulls
      .list({
        owner,
        repo: name,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 30,
      })
      .then((r) => ({ ok: true as const, data: r.data }))
      .catch((e: unknown) => ({ ok: false as const, error: message(e) })),
    // Free — `GET /rate_limit` counts against nothing — and already fails soft.
    readGitHubRemaining(),
  ]);

  const checks: CheckRun[] | null = checksRes.ok
    ? (checksRes.data.check_runs ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        started_at: c.started_at,
        completed_at: c.completed_at,
      }))
    : null;

  const runs: WorkflowRun[] | null = runsRes.ok
    ? (runsRes.data.workflow_runs ?? []).map((r) => ({
        id: r.id,
        name: r.name ?? "(unnamed workflow)",
        status: r.status ?? "completed",
        conclusion: r.conclusion,
        headSha: r.head_sha,
        headBranch: r.head_branch,
        event: r.event,
        createdAt: r.created_at,
        htmlUrl: r.html_url,
      }))
    : null;

  const commits = commitsRes.ok
    ? commitsRes.data.map((c) => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        headline: commitHeadline(c.commit?.message ?? ""),
        author: c.author?.login ?? c.commit?.author?.name ?? null,
        authoredAt: c.commit?.author?.date ?? null,
        htmlUrl: c.html_url,
      }))
    : null;

  const prs: PrimePullRequest[] | null = prsRes.ok
    ? prsRes.data.map((p) => ({
        number: p.number,
        title: p.title,
        author: p.user?.login ?? null,
        draft: Boolean(p.draft),
        headSha: p.head.sha,
        headRef: p.head.ref,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        htmlUrl: p.html_url,
      }))
    : null;

  return assemble({
    supabase,
    repo,
    readAt,
    head,
    headError,
    checks,
    checksError: checksRes.ok ? null : checksRes.error,
    runs,
    runsError: runsRes.ok ? null : runsRes.error,
    commits,
    commitsError: commitsRes.ok ? null : commitsRes.error,
    prs,
    prsError: prsRes.ok ? null : prsRes.error,
    rateLimitRemaining: remaining,
  });
}

/* ────────────────────── folding it into one reading ──────────────────────── */

async function assemble(args: {
  supabase: SupabaseLike;
  repo: PrimeRepoRef;
  readAt: string;
  head: PrimeHeadCommit | null;
  headError: string | null;
  checks: CheckRun[] | null;
  checksError?: string | null;
  runs: WorkflowRun[] | null;
  runsError: string | null;
  commits: Array<Omit<PrimeCommitReading, "ci" | "cascadeEventId" | "cascadeStatus">> | null;
  commitsError: string | null;
  prs: PrimePullRequest[] | null;
  prsError: string | null;
  rateLimitRemaining: number | null;
}): Promise<PrimeHealth> {
  const { supabase, repo, readAt, head, headError, checks, runs, commits, prs } = args;

  // ── the cascade ledger ───────────────────────────────────────────────────
  const { data: eventRows, error: eventsError } = await supabase
    .from("cascade_events")
    .select("id, source_sha, status, created_at, mode, summary")
    .order("created_at", { ascending: false })
    .limit(EVENT_WINDOW);

  // `null` rather than `[]` on a failed read, so `assessCascadeCoverage`
  // answers `unknown` instead of `uncarried`. An unreadable ledger must never
  // be reported as a fleet that has stopped cascading.
  const events: CascadeEventRef[] | null = eventsError
    ? null
    : (eventRows ?? []).map((e) => ({
        id: e.id,
        sourceSha: e.source_sha,
        status: e.status,
        createdAt: e.created_at,
      }));

  const gate = assessPrimeGate(checks);
  const coverage = assessCascadeCoverage({ headSha: head?.sha ?? null, events });
  const posture = assessPosture(gate, coverage);

  // ── the workflow window ──────────────────────────────────────────────────
  // The trend describes the DEFAULT BRANCH. Runs from pull requests share the
  // window (they are what gives every open pull request a CI reading for no
  // extra call) but must not be mixed into "how often does prime break?" —
  // a contributor's branch failing is not prime failing.
  const allRuns = runs ?? [];
  const branchRuns = allRuns.filter((r) => r.headBranch === repo.defaultBranch);
  const trend = summariseWorkflowRuns(branchRuns);
  const times = allRuns
    .map((r) => r.createdAt)
    .filter(Boolean)
    .sort();
  const trendWindow = {
    runs: allRuns.length,
    oldest: times[0] ?? null,
    newest: times[times.length - 1] ?? null,
  };

  // ── the commit ledger, cross-referenced both ways ────────────────────────
  const commitReadings: PrimeCommitReading[] = (commits ?? []).map((c) => {
    const event = events?.find((e) => sameCommit(e.sourceSha, c.sha)) ?? null;
    return {
      ...c,
      // The same rule the open pull requests go through, imported rather than
      // repeated: two copies would let one section of this page call a SHA
      // green while the section under it called it unobserved.
      ci: readCiForHead(c.sha, allRuns),
      cascadeEventId: event?.id ?? null,
      cascadeStatus: event?.status ?? null,
    };
  });

  // ── what is waiting to become the next payload ───────────────────────────
  const pullRequests = prs ? readPullRequests(prs, allRuns) : [];

  // ── did the last cascade actually land? ──────────────────────────────────
  let delivery: DeliveryReading | null = null;
  let deliveryError: string | null = eventsError ? eventsError.message : null;
  const latest = (eventRows ?? [])[0];
  if (latest) {
    // `clones(name, slug)` names the embed target explicitly, and that is
    // load-bearing rather than stylistic: `cascade_results.clone_id` resolves
    // to TWO relations — the `clones` table and the
    // `clones_missing_isolated_backend` view that shares its foreign key — so
    // an unqualified embed has two candidates. Naming the table picks one.
    // `support_tickets` carries the identical pair and embeds it this way in
    // production, which is the precedent this follows.
    const { data: results, error: resultsError } = await supabase
      .from("cascade_results")
      .select("clone_id, status, pr_url, error_message, files_changed, clones(name, slug)")
      .eq("cascade_event_id", latest.id);
    if (resultsError) {
      deliveryError = resultsError.message;
    } else {
      delivery = {
        eventId: latest.id,
        sourceSha: latest.source_sha,
        status: latest.status,
        mode: latest.mode,
        summary: latest.summary,
        createdAt: latest.created_at,
        clones: (results ?? []).map((r) => {
          const clone = r.clones as { name?: string; slug?: string } | null;
          return {
            cloneId: r.clone_id,
            name: clone?.name ?? "(unknown clone)",
            slug: clone?.slug ?? "",
            status: r.status,
            prUrl: r.pr_url,
            errorMessage: r.error_message,
            filesChanged: r.files_changed,
          };
        }),
      };
    }
  }

  return {
    configured: true,
    repo,
    readAt,
    head,
    headError,
    gate,
    headChecks: (checks ?? []).map((c) => ({ ...c, outcome: checkOutcome(c) })),
    headChecksError: args.checksError ?? null,
    coverage,
    posture,
    trend,
    trendWindow,
    trendError: args.runsError,
    commits: commitReadings,
    commitsError: args.commitsError,
    pullRequests,
    pullRequestsError: args.prsError,
    delivery,
    deliveryError,
    rateLimitRemaining: args.rateLimitRemaining,
  };
}
