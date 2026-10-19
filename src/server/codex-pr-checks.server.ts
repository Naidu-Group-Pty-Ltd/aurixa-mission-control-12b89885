// GitHub check runs for PR scans. Server-only.
//
// The check is created when a PR scan is dispatched (so the PR shows the scan
// is running) and completed from the scan webhook with the PR's findings as
// annotations. Requires the App installation to hold `Checks: read & write`;
// without it GitHub answers 403 and the scan still runs — the refusal is
// recorded on the scan so engine health can name the missing permission.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getAppOctokit } from "@/server/github-app.server";
import { resolveDispatchTarget } from "@/server/codex-dispatch-target.server";
import { appPublicOrigin } from "@/server/codex-security-client.server";
import {
  PR_CHECK_NAME,
  buildPrCheckReport,
  type FailOn,
  type PrCheckFinding,
  type PrCheckReport,
} from "@/lib/codex-pr-check";
import { degradedScanners } from "@/lib/codex-finding-lifecycle";
import { readSuppressionChanges } from "@/lib/codex-scan-provenance";
import { asJson } from "@/lib/json-cast";

export type CheckRunTarget = {
  owner: string;
  repo: string;
  installationId?: string | null;
};

export type CheckRunResult =
  | { ok: true; id: number }
  | { ok: false; status?: number; error: string };

function describe(err: unknown): { status?: number; error: string } {
  const status = (err as { status?: number })?.status;
  const message =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  if (status === 403) {
    return {
      status,
      error:
        "GitHub refused to create a check run (403): the Aurixa App installation needs the " +
        `"Checks: read & write" permission. Detail: ${message}`,
    };
  }
  return { status, error: `Check run request failed${status ? ` [${status}]` : ""}: ${message}` };
}

export async function startScanCheckRun(
  target: CheckRunTarget & { headSha: string; jobId: string; detailsUrl: string },
): Promise<CheckRunResult> {
  try {
    const octokit = getAppOctokit(target.installationId ?? undefined);
    const res = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: target.owner,
      repo: target.repo,
      name: PR_CHECK_NAME,
      head_sha: target.headSha,
      status: "in_progress",
      external_id: target.jobId,
      details_url: target.detailsUrl,
      started_at: new Date().toISOString(),
      output: {
        title: "Scanning this change",
        summary:
          "gitleaks, semgrep, osv-scanner and (when enabled) the Codex review are running " +
          "against the files this pull request changes.",
      },
    });
    const id = (res.data as { id?: number }).id;
    if (typeof id !== "number") return { ok: false, error: "GitHub returned no check run id" };
    return { ok: true, id };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}

export async function finishScanCheckRun(
  target: CheckRunTarget & { checkRunId: number; report: PrCheckReport },
): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  try {
    const octokit = getAppOctokit(target.installationId ?? undefined);
    await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
      owner: target.owner,
      repo: target.repo,
      check_run_id: target.checkRunId,
      status: "completed",
      conclusion: target.report.conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: target.report.title,
        summary: target.report.summary,
        annotations: target.report.annotations,
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}

/** Where a PR check links back to: the scan's own page in Mission Control. */
export function scanDetailsUrl(jobId: string): string {
  return `${appPublicOrigin()}/security/scans?job=${jobId}`;
}

type PrScanJob = {
  id: string;
  target_kind: string;
  clone_id: string | null;
  repo_full_name: string;
  request_payload: unknown;
};

async function recordCheckEvent(
  jobId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin
    .from("codex_scan_events")
    .insert({ job_id: jobId, event_type: eventType, payload: asJson(payload) });
  if (error) console.warn(`[codex-pr-checks] could not record ${eventType}:`, error.message);
}

const FAIL_ON_VALUES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "never"]);

async function prCheckFailOn(): Promise<FailOn> {
  const { data, error } = await supabaseAdmin
    .from("prime_config")
    .select("codex_pr_check_fail_on")
    .limit(1)
    .maybeSingle();
  if (error || !data) return "high";
  const value = String((data as { codex_pr_check_fail_on?: string }).codex_pr_check_fail_on ?? "");
  return FAIL_ON_VALUES.has(value) ? (value as FailOn) : "high";
}

/**
 * Close the PR check a scan opened. Never throws: the scan's own result is
 * already recorded, and a check that cannot be updated is reported on the
 * scan rather than allowed to fail the webhook.
 */
export async function completePrCheckForJob(input: {
  job: PrScanJob;
  outcome:
    | { kind: "finished"; result: Record<string, unknown> | null; runUrl?: string | null }
    | { kind: "failed"; reason: string; runUrl?: string | null };
}): Promise<void> {
  const payload = (input.job.request_payload ?? {}) as Record<string, unknown>;
  const checkRunId = Number(payload.check_run_id);
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) return;

  try {
    const target = await resolveDispatchTarget({
      targetKind: input.job.target_kind === "clone" ? "clone" : "prime",
      cloneId: input.job.clone_id,
      repoFullName: input.job.repo_full_name,
    });

    let report: PrCheckReport;
    if (input.outcome.kind === "failed") {
      report = {
        conclusion: "neutral",
        title: "The security scan did not finish",
        summary:
          `${input.outcome.reason}\n\nNo result was recorded for this change, so this check ` +
          `cannot vouch for it.` +
          (input.outcome.runUrl ? `\n\n[Scan run log](${input.outcome.runUrl})` : ""),
        annotations: [],
      };
    } else {
      const result = input.outcome.result ?? {};
      const targetKey = typeof result.target_key === "string" ? result.target_key : null;
      let query = supabaseAdmin
        .from("codex_findings")
        .select("title, severity, affected_file, affected_line, scanner, rule_id, description")
        .eq("state", "open")
        .order("severity", { ascending: true })
        .limit(200);
      query = targetKey ? query.eq("target_key", targetKey) : query.eq("scan_job_id", input.job.id);
      const { data: findings, error } = await query;
      if (error) {
        await recordCheckEvent(input.job.id, "check_run_failed", { error: error.message });
        return;
      }
      report = buildPrCheckReport({
        findings: (findings ?? []) as PrCheckFinding[],
        failOn: await prCheckFailOn(),
        degraded: degradedScanners(result),
        incomplete: result.incomplete === true,
        suppressionChanges: readSuppressionChanges(result),
        scanUrl: scanDetailsUrl(input.job.id),
        runUrl: input.outcome.runUrl ?? null,
      });
    }

    const res = await finishScanCheckRun({
      owner: target.owner,
      repo: target.repo,
      installationId: target.installationId,
      checkRunId,
      report,
    });
    if (res.ok) {
      await recordCheckEvent(input.job.id, "check_run_completed", {
        check_run_id: checkRunId,
        conclusion: report.conclusion,
        title: report.title,
      });
    } else {
      await recordCheckEvent(input.job.id, "check_run_failed", {
        check_run_id: checkRunId,
        status: res.status ?? null,
        error: res.error,
      });
    }
  } catch (err) {
    await recordCheckEvent(input.job.id, "check_run_failed", {
      check_run_id: checkRunId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
