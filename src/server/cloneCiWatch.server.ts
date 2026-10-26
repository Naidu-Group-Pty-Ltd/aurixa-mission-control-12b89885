/**
 * Read each clone repository's own CI back from GitHub, and say what nobody
 * has been told. The judgement is `cloneCiWatch.pure.ts`; this is the I/O.
 *
 * It reports and never repairs. A failing refresh is fixed by whoever can see
 * why it fails, and a protected workflow is protected precisely because this
 * platform may not write it.
 *
 * ## Cost
 *
 * Per clone: two run listings (scheduled; dispatched on the default branch),
 * one workflow listing and, where the clone protects any path at all, one
 * listing of its `.github/workflows`. One listing of the prime's, for the
 * whole pass. Seventeen calls for today's four clones, every thirty minutes,
 * against an hourly installation budget of 5,000 — and the hook asks
 * `decideSpend` first, so a cascade that needs the budget gets it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { globToRegex } from "@/lib/module-globs";
import { getAppOctokit } from "./github-app.server";
import { notifyOperators, writeAuditLog } from "./audit.server";
import {
  CLONE_CI_WATCH_ACTION,
  ciFingerprint,
  ciSeverity,
  declaresSchedule,
  describeCiFinding,
  findingsToAnnounce,
  isStoppedState,
  judgeCloneCi,
  readCiObservation,
  settleCiReport,
  type CiFinding,
  type CiObservation,
  type CloneCiOutcome,
  type CloneCiWatchReport,
  type ProtectedWorkflowFact,
  type WorkflowFact,
  type WorkflowRunFact,
} from "./cloneCiWatch.pure";

type Db = SupabaseClient<Database>;

const WORKFLOWS_DIR = ".github/workflows";

type RunRow = {
  path: string;
  name?: string | null;
  event: string;
  head_branch: string | null;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  html_url: string;
};

/**
 * The three calls this watch makes, and nothing else an installation client
 * can do. Structural, so a test hands in a fake rather than mocking a module.
 */
export type CiOctokit = {
  actions: {
    listWorkflowRunsForRepo(params: {
      owner: string;
      repo: string;
      event?: string;
      branch?: string;
      per_page?: number;
    }): Promise<{ data: { workflow_runs: RunRow[] } }>;
    listRepoWorkflows(params: {
      owner: string;
      repo: string;
      per_page?: number;
    }): Promise<{ data: { workflows: Array<{ path: string; name: string; state: string }> } }>;
  };
  repos: {
    getContent(params: {
      owner: string;
      repo: string;
      path: string;
      ref?: string;
    }): Promise<{ data: unknown }>;
  };
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const status = (e: unknown): number | null =>
  typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : null;

const toRun = (r: RunRow): WorkflowRunFact => ({
  path: r.path,
  name: r.name ?? r.path,
  event: r.event,
  headBranch: r.head_branch,
  status: r.status ?? "completed",
  conclusion: r.conclusion,
  createdAt: r.created_at,
  htmlUrl: r.html_url,
});

/** `null` is "could not be read", and is never handed on as an empty list. */
async function readRuns(
  octokit: CiOctokit,
  repo: { owner: string; repo: string },
  filter: { event: string; branch?: string },
): Promise<WorkflowRunFact[] | null> {
  try {
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      ...repo,
      ...filter,
      per_page: 100,
    });
    return (data.workflow_runs ?? []).map(toRun);
  } catch {
    return null;
  }
}

/**
 * The workflow list, and for each workflow GitHub has stopped, whether its file
 * declares a schedule — read from the file, because a stopped workflow leaves
 * no runs to say so. On a healthy repository that is no extra read at all.
 */
async function readWorkflows(
  octokit: CiOctokit,
  repo: { owner: string; repo: string; branch: string },
): Promise<WorkflowFact[] | null> {
  try {
    const { data } = await octokit.actions.listRepoWorkflows({
      owner: repo.owner,
      repo: repo.repo,
      per_page: 100,
    });
    const workflows: WorkflowFact[] = (data.workflows ?? []).map((w) => ({
      path: w.path,
      name: w.name,
      state: w.state,
    }));
    for (const w of workflows) {
      if (!isStoppedState(w.state)) continue;
      const text = await readText(octokit, { ...repo, path: w.path });
      // A file that could not be read is not a file without a schedule.
      if (text === null) return null;
      w.hasSchedule = text !== "" && declaresSchedule(text);
    }
    return workflows;
  } catch {
    return null;
  }
}

/** A file's text; "" when the file is gone (404), null when it could not be read. */
async function readText(
  octokit: CiOctokit,
  file: { owner: string; repo: string; branch: string; path: string },
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner: file.owner,
      repo: file.repo,
      path: file.path,
      ref: file.branch,
    });
    const f = data as { encoding?: string; content?: string };
    if (f.encoding !== "base64" || typeof f.content !== "string") return null;
    return Buffer.from(f.content, "base64").toString("utf8");
  } catch (e) {
    return status(e) === 404 ? "" : null;
  }
}

/**
 * Path → blob sha for every file in a repository's `.github/workflows`.
 *
 * A 404 is a repository with no workflows, which is an answer. Anything else
 * is not one.
 */
async function readWorkflowBlobs(
  octokit: CiOctokit,
  repo: { owner: string; repo: string; branch: string },
): Promise<Map<string, string> | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner: repo.owner,
      repo: repo.repo,
      path: WORKFLOWS_DIR,
      ref: repo.branch,
    });
    if (!Array.isArray(data)) return null;
    const blobs = new Map<string, string>();
    for (const entry of data as Array<{ type?: string; path?: string; sha?: string }>) {
      if (entry.type === "file" && entry.path && entry.sha) blobs.set(entry.path, entry.sha);
    }
    return blobs;
  } catch (e) {
    return status(e) === 404 ? new Map() : null;
  }
}

/** What this clone was last observed to owe, and which of it somebody was told. */
async function lastObservation(supabase: Db, cloneId: string): Promise<CiObservation | null> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("action", CLONE_CI_WATCH_ACTION)
    .eq("entity_id", cloneId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A history that could not be read is not a history of nothing: treating it
  // as one would announce every standing finding in the fleet again.
  if (error) throw new Error(`Could not read the watch's history: ${error.message}`);
  return readCiObservation(data?.metadata ?? null);
}

function headline(label: string, findings: readonly CiFinding[]): string {
  const count = (kind: CiFinding["kind"]) => findings.filter((f) => f.kind === kind).length;
  const failing = count("failing");
  const stopped = count("stopped");
  const differs = count("differs");
  const parts = [
    failing && `${failing} scheduled workflow${failing === 1 ? "" : "s"} failing`,
    stopped && `${stopped} schedule${stopped === 1 ? "" : "s"} stopped`,
    differs &&
      `${differs} protected workflow${differs === 1 ? " differs" : "s differ"} from the prime's`,
  ].filter(Boolean);
  return `${label}: ${parts.join(", ")}`;
}

export async function sweepCloneCi(
  supabase: Db,
  deps: { octokit?: CiOctokit; now?: number } = {},
): Promise<CloneCiWatchReport> {
  const report: CloneCiWatchReport = {
    clones: 0,
    attention: 0,
    announced: 0,
    undelivered: 0,
    cleared: 0,
    unreadable: 0,
    failed: 0,
    detail: [],
  };

  const primeRes = await supabase.from("prime_config").select("*").limit(1).maybeSingle();
  if (primeRes.error) throw new Error(`Could not read prime config: ${primeRes.error.message}`);
  const prime = primeRes.data;
  if (!prime?.github_owner || !prime?.github_repo) {
    throw new Error("Prime not configured — nothing to compare a protected workflow against");
  }

  const { data: clones, error } = await supabase
    .from("clones")
    .select("id, name, github_owner, github_repo, default_branch")
    .not("github_owner", "is", null)
    .not("github_repo", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clones: ${error.message}`);

  const octokit = deps.octokit ?? (getAppOctokit() as unknown as CiOctokit);
  const now = deps.now ?? Date.now();

  // Read once, and only if some clone protects a path at all.
  let primeBlobs: Map<string, string> | null | undefined;
  const primeWorkflowBlobs = async () => {
    if (primeBlobs === undefined) {
      primeBlobs = await readWorkflowBlobs(octokit, {
        owner: prime.github_owner as string,
        repo: prime.github_repo as string,
        branch: prime.default_branch || "main",
      });
    }
    return primeBlobs;
  };

  for (const clone of clones ?? []) {
    if (!clone.github_owner || !clone.github_repo) continue;
    const label = clone.name ?? `${clone.github_owner}/${clone.github_repo}`;
    const repo = { owner: clone.github_owner, repo: clone.github_repo };
    const branch = clone.default_branch || "main";
    report.clones += 1;

    try {
      const outcome = await watchOneClone({
        supabase,
        octokit,
        now,
        label,
        cloneId: clone.id,
        repo,
        branch,
        primeWorkflowBlobs,
      });
      report.detail.push(outcome);
      if (outcome.outcome === "attention") {
        report.attention += 1;
        report.announced += outcome.announced;
        report.undelivered += outcome.undelivered;
      } else if (outcome.outcome === "cleared") {
        report.cleared += 1;
      } else if (outcome.outcome === "unreadable") {
        report.unreadable += 1;
      }
    } catch (e) {
      // One unreachable repository must not blind the watch to the rest of the
      // fleet. Nothing here writes to a repository, so nothing is half done.
      report.failed += 1;
      report.detail.push({ clone: label, outcome: "failed", error: msg(e) });
    }
  }

  return report;
}

async function watchOneClone(args: {
  supabase: Db;
  octokit: CiOctokit;
  now: number;
  label: string;
  cloneId: string;
  repo: { owner: string; repo: string };
  branch: string;
  primeWorkflowBlobs: () => Promise<Map<string, string> | null>;
}): Promise<CloneCiOutcome> {
  const { supabase, octokit, now, label, cloneId, repo, branch } = args;

  const [scheduledRuns, dispatchedRuns, workflows, protectedWorkflows] = await Promise.all([
    readRuns(octokit, repo, { event: "schedule" }),
    readRuns(octokit, repo, { event: "workflow_dispatch", branch }),
    readWorkflows(octokit, { ...repo, branch }),
    readProtectedWorkflows({
      supabase,
      octokit,
      cloneId,
      repo,
      branch,
      prime: args.primeWorkflowBlobs,
    }),
  ]);

  const reading = judgeCloneCi({
    defaultBranch: branch,
    scheduledRuns,
    dispatchedRuns,
    workflows,
    protectedWorkflows,
    now,
  });
  if (reading.kind === "unreadable") {
    return { clone: label, outcome: "unreadable", missing: reading.missing };
  }

  const previous = await lastObservation(supabase, cloneId);
  const announce = findingsToAnnounce({ previous, findings: reading.findings });

  // Announced first, and the record says whether it LANDED. `notifyOperators`
  // answers false on a failed insert rather than throwing; a record written
  // regardless would read "already told" and silence a standing failure until
  // it changed. Undelivered findings stay out of `announced`, so the next pass
  // tries them again.
  const delivered =
    announce.length === 0 ||
    (await notifyOperators({
      kind: "clone_ci_attention",
      severity: ciSeverity(announce),
      title: headline(label, announce),
      // Named in full. "CI is failing" would send an operator to open four
      // repositories to find out which job, since when, and where the log is.
      body: announce.map(describeCiFinding).join("\n"),
      cloneId,
      url: `/clones/${cloneId}`,
      metadata: {
        fingerprint: ciFingerprint(reading.findings),
        findings: announce,
        source: CLONE_CI_WATCH_ACTION,
      },
    }));

  const settled = settleCiReport({
    previous,
    findings: reading.findings,
    announced: announce,
    delivered,
  });
  // `writeAuditLog` logs a failed insert rather than throwing, so a lost record
  // means the next pass announces these again: noise, the safe direction.
  if (settled.record) {
    await writeAuditLog({
      action: CLONE_CI_WATCH_ACTION,
      entityType: "clone",
      entityId: cloneId,
      metadata: {
        fingerprint: settled.observation.fingerprint,
        announced: settled.observation.announced,
        findings: reading.findings,
        lines: reading.findings.map(describeCiFinding),
        repo: `${repo.owner}/${repo.repo}`,
      },
    });
  }

  if (reading.findings.length === 0) {
    return { clone: label, outcome: settled.record ? "cleared" : "clean" };
  }
  return {
    clone: label,
    outcome: "attention",
    findings: reading.findings,
    announced: delivered ? announce.length : 0,
    undelivered: delivered ? 0 : announce.length,
  };
}

/**
 * Every workflow this clone holds `protected`, with the blob each side has.
 *
 * Only `protected`: a `manual_reconcile` path is already named under "Needs a
 * human" on every cascade that holds it back. A protected one is withheld
 * without comment, which is the silence this reading exists to break.
 */
async function readProtectedWorkflows(args: {
  supabase: Db;
  octokit: CiOctokit;
  cloneId: string;
  repo: { owner: string; repo: string };
  branch: string;
  prime: () => Promise<Map<string, string> | null>;
}): Promise<ProtectedWorkflowFact[] | null> {
  const { data, error } = await args.supabase
    .from("clone_sync_exclusions")
    .select("pattern, reason")
    .eq("clone_id", args.cloneId)
    .eq("reason", "protected");
  if (error) return null;
  const patterns = (data ?? []).map((r) => globToRegex(r.pattern));
  if (patterns.length === 0) return [];

  const [primeBlobs, cloneBlobs] = await Promise.all([
    args.prime(),
    readWorkflowBlobs(args.octokit, { ...args.repo, branch: args.branch }),
  ]);
  if (primeBlobs === null || cloneBlobs === null) return null;

  const paths = new Set([...primeBlobs.keys(), ...cloneBlobs.keys()]);
  return [...paths]
    .filter((path) => patterns.some((rx) => rx.test(path)))
    .sort()
    .map((path) => ({
      path,
      primeSha: primeBlobs.get(path) ?? null,
      cloneSha: cloneBlobs.get(path) ?? null,
    }));
}
