// Queueing and dispatching a live audit of Prime. Server-only.
//
// A run is a row first and a dispatch second: the row exists before GitHub is
// asked, so a dispatch that fails is a run with an error a person can read and
// the sweep can retry — never a request that vanished. One run is in flight
// per target (`live_audit_runs_one_active`); the workflow's own concurrency
// group would only queue a second, holding its key open for nothing.
//
// The dispatch names the run, Prime's site and backend, the settings snapshot
// and a callback key derived for this run alone (live-audit-keys.server.ts).
// The workflow it starts, .github/workflows/live-audit.yml on Prime, is
// described in docs/LIVE_AUDIT.md.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";
import {
  liveAuditRequestAllowed,
  runSettingsFor,
  type LiveAuditKind,
  type LiveAuditMode,
  type LiveAuditSettingsRow,
} from "@/lib/live-audit-policy";
import { LIVE_AUDIT_WORKFLOW_FILE } from "@/lib/live-audit-contract";
import { getAppOctokit } from "@/server/github-app.server";
import { appPublicOrigin, checkScanWorkflowPresent } from "@/server/codex-security-client.server";
import { listEnvironmentSecretNames, listRepoSecretNames } from "@/server/github-secrets.server";
import {
  LIVE_AUDIT_RUN_KEY_VERSION,
  deriveLiveAuditKey,
  resolveLiveAuditMasterSecrets,
} from "@/server/live-audit-keys.server";

const admin = supabaseAdmin;

/** Re-dispatch attempts before a queued run is failed. */
export const MAX_DISPATCH_ATTEMPTS = 3;

export function liveAuditCallbackUrl(): string {
  return `${appPublicOrigin()}/api/public/hooks/live-audit`;
}

export function liveAuditFixCallbackUrl(): string {
  return `${appPublicOrigin()}/api/public/hooks/live-audit-fix`;
}

export type LiveAuditSettings = LiveAuditSettingsRow & {
  target_key: string;
  nightly_enabled: boolean;
  nightly_cron: string;
  mode: string;
  target_url: string;
  fix_model: string | null;
  fix_effort: string;
  autofix_enabled: boolean;
  autofix_max_per_run: number;
  autofix_min_confidence: number;
};

export async function loadLiveAuditSettings(
  targetKey = "prime",
): Promise<LiveAuditSettings | null> {
  const { data, error } = await admin
    .from("live_audit_settings")
    .select("*")
    .eq("target_key", targetKey)
    .maybeSingle();
  if (error) throw new Error(`The live audit settings could not be read: ${error.message}`);
  return (data as LiveAuditSettings | null) ?? null;
}

export type PrimeRepo = {
  owner: string;
  repo: string;
  defaultBranch: string;
  installationId: string | null;
  /** `https://<ref>.supabase.co`, or null when prime_config names no project. */
  backendOrigin: string | null;
};

export async function resolvePrimeRepo(): Promise<PrimeRepo> {
  const { data, error } = await admin
    .from("prime_config")
    .select(
      "github_owner, github_repo, default_branch, github_app_installation_id, supabase_project_ref",
    )
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`prime_config could not be read: ${error.message}`);
  if (!data?.github_owner || !data?.github_repo)
    throw new Error("prime_config names no GitHub repository");
  const ref = (data.supabase_project_ref ?? "").trim();
  return {
    owner: data.github_owner,
    repo: data.github_repo,
    defaultBranch: data.default_branch || "main",
    installationId: data.github_app_installation_id ?? null,
    backendOrigin: /^[a-z0-9]{20}$/.test(ref) ? `https://${ref}.supabase.co` : null,
  };
}

export type EnqueueResult =
  | { ok: true; runId: string; dispatchError?: string }
  | { ok: false; reason: string; runId?: string };

/**
 * Queue a run and dispatch it at once. A failed dispatch leaves the run
 * queued, with its error, for the sweep to retry.
 */
export async function enqueueLiveAuditRun(input: {
  kind: LiveAuditKind;
  requestedBy: string | null;
  mode?: LiveAuditMode;
  ref?: string | null;
  focusRoutes?: string[];
  focusFingerprints?: string[];
}): Promise<EnqueueResult> {
  const settings = await loadLiveAuditSettings("prime");
  if (!settings)
    return {
      ok: false,
      reason: "the live audit has no settings row for Prime; apply its migration",
    };
  const mode = (input.mode ?? settings.mode) as LiveAuditMode;
  const verdict = liveAuditRequestAllowed({ targetKey: "prime", kind: input.kind, mode });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const ref = (input.ref ?? "").trim() || null;
  if (ref && !/^[A-Za-z0-9._/-]{1,200}$/.test(ref))
    return { ok: false, reason: "that is not a branch name" };

  const prime = await resolvePrimeRepo();
  const { data, error } = await admin
    .from("live_audit_runs")
    .insert({
      target_key: "prime",
      kind: input.kind,
      mode,
      status: "queued",
      repo_full_name: `${prime.owner}/${prime.repo}`,
      dispatch_ref: prime.defaultBranch,
      ref,
      target_url: settings.target_url,
      settings: asJson(
        runSettingsFor(settings, {
          kind: input.kind,
          focusRoutes: input.focusRoutes,
          focusFingerprints: input.focusFingerprints,
        }),
      ),
      requested_by: input.requestedBy,
      callback_key_version: LIVE_AUDIT_RUN_KEY_VERSION,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: active } = await admin
        .from("live_audit_runs")
        .select("id")
        .eq("target_key", "prime")
        .in("status", ["queued", "dispatched", "running"])
        .limit(1)
        .maybeSingle();
      return {
        ok: false,
        reason: "a live audit of Prime is already in progress",
        runId: active?.id,
      };
    }
    return { ok: false, reason: error.message };
  }

  const { error: evErr } = await admin.from("live_audit_events").insert({
    run_id: data.id,
    actor: input.requestedBy,
    event_type: "run.queued",
    payload: asJson({ kind: input.kind, mode, ref }),
  });
  if (evErr) console.warn("[live-audit] run event not recorded:", evErr.message);

  const dispatched = await dispatchLiveAuditRun(data.id);
  return dispatched.ok
    ? { ok: true, runId: data.id }
    : { ok: true, runId: data.id, dispatchError: dispatched.error };
}

type QueuedRun = {
  id: string;
  mode: string;
  ref: string | null;
  target_url: string;
  settings: unknown;
  dispatch_attempts: number;
  status: string;
};

/** Dispatch (or re-dispatch) one queued run. Never throws. */
export async function dispatchLiveAuditRun(
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: run, error } = await admin
    .from("live_audit_runs")
    .select("id, mode, ref, target_url, settings, dispatch_attempts, status")
    .eq("id", runId)
    .maybeSingle();
  if (error || !run) return { ok: false, error: error?.message ?? "run not found" };
  const r = run as QueuedRun;
  if (r.status !== "queued") return { ok: false, error: `the run is ${r.status}` };

  const attempts = r.dispatch_attempts + 1;
  try {
    const prime = await resolvePrimeRepo();
    const master = (await resolveLiveAuditMasterSecrets()).current;
    if (!master) {
      throw new Error(
        "No callback master is configured (LIVE_AUDIT_WEBHOOK_SECRET, or the Codex scan master): " +
          "the run would have no way to report back.",
      );
    }
    if (r.mode === "live" && !prime.backendOrigin) {
      throw new Error(
        "prime_config names no Supabase project, so the audit cannot mint its session or read the backend.",
      );
    }
    const callbackSecret = await deriveLiveAuditKey(master, "run", r.id);
    const octokit = getAppOctokit(prime.installationId ?? undefined);
    const inputs: Record<string, string> = {
      run_id: r.id,
      mode: r.mode,
      target_url: r.target_url,
      backend_origin: prime.backendOrigin ?? "",
      settings: JSON.stringify(r.settings ?? {}),
      ref: r.ref ?? "",
      callback_url: liveAuditCallbackUrl(),
      callback_secret: callbackSecret,
    };
    await withRetry(
      () =>
        octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: prime.owner,
          repo: prime.repo,
          workflow_id: LIVE_AUDIT_WORKFLOW_FILE,
          ref: prime.defaultBranch,
          inputs,
        }),
      { attempts: 3, shouldRetry: isTransientHttpError },
    );
    const { error: upErr } = await admin
      .from("live_audit_runs")
      .update({
        status: "dispatched",
        dispatched_at: new Date().toISOString(),
        dispatch_attempts: attempts,
        next_attempt_at: null,
        last_error: null,
      })
      .eq("id", r.id)
      .eq("status", "queued");
    if (upErr) console.error("[live-audit] dispatched but not recorded:", upErr.message);
    const { error: evErr } = await admin.from("live_audit_events").insert({
      run_id: r.id,
      event_type: "run.dispatched",
      payload: asJson({ attempt: attempts }),
    });
    if (evErr) console.warn("[live-audit] run event not recorded:", evErr.message);
    return { ok: true };
  } catch (err) {
    const message = describeDispatchError(err);
    // Back off 5, 10, 15 minutes; past the last attempt the sweep fails it.
    const { error: upErr } = await admin
      .from("live_audit_runs")
      .update({
        dispatch_attempts: attempts,
        last_error: message.slice(0, 2000),
        next_attempt_at: new Date(Date.now() + attempts * 5 * 60_000).toISOString(),
      })
      .eq("id", r.id);
    if (upErr) console.error("[live-audit] dispatch failure not recorded:", upErr.message);
    return { ok: false, error: message };
  }
}

function describeDispatchError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const message =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  if (status === 404) {
    return (
      `GitHub returned 404 dispatching ${LIVE_AUDIT_WORKFLOW_FILE} on Prime: check that ` +
      `.github/workflows/${LIVE_AUDIT_WORKFLOW_FILE} is on Prime's default branch and the Aurixa GitHub App ` +
      "has Actions: read & write."
    );
  }
  if (status === 422) {
    return `GitHub rejected the dispatch inputs (${message}): Prime's live-audit.yml is an older revision.`;
  }
  return `The live audit could not be dispatched${status ? ` [${status}]` : ""}: ${message}`;
}

/**
 * A person stops a run. The row closes first, so nothing the workflow says
 * afterwards is believed (its callbacks get 409); then GitHub is asked to
 * cancel the workflow run when one is known. The workflow's `revoke` job runs
 * whatever happened to the audit, so the session minted for it is revoked
 * either way.
 */
export async function cancelLiveAuditRun(input: {
  runId: string;
  by: string;
}): Promise<{ ok: true; workflowCanceled: boolean | null } | { ok: false; reason: string }> {
  const { data: run, error } = await admin
    .from("live_audit_runs")
    .select("id, status, workflow_run_id, repo_full_name")
    .eq("id", input.runId)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!run) return { ok: false, reason: "run not found" };
  if (!["queued", "dispatched", "running"].includes(run.status)) {
    return { ok: false, reason: `the run is already ${run.status}` };
  }
  const { data: moved, error: upErr } = await admin
    .from("live_audit_runs")
    .update({
      status: "canceled",
      completed_at: new Date().toISOString(),
      last_error: "Canceled by a person.",
    })
    .eq("id", run.id)
    .eq("status", run.status)
    .select("id");
  if (upErr) return { ok: false, reason: upErr.message };
  if (!moved?.length)
    return { ok: false, reason: "the run changed while you were looking; reload and try again" };

  let workflowCanceled: boolean | null = null;
  if (run.workflow_run_id) {
    const [owner, repo] = run.repo_full_name.split("/");
    try {
      const prime = await resolvePrimeRepo();
      await getAppOctokit(prime.installationId ?? undefined).request(
        "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
        { owner, repo, run_id: Number(run.workflow_run_id) },
      );
      workflowCanceled = true;
    } catch (err) {
      // 409: it had already finished. Either way the row is closed.
      console.warn("[live-audit] workflow run not canceled:", (err as Error).message);
      workflowCanceled = false;
    }
  }
  const { error: evErr } = await admin.from("live_audit_events").insert({
    run_id: run.id,
    actor: input.by,
    event_type: "run.canceled",
    from_state: run.status,
    to_state: "canceled",
    payload: asJson({ workflow_canceled: workflowCanceled }),
  });
  if (evErr) console.warn("[live-audit] run event not recorded:", evErr.message);
  return { ok: true, workflowCanceled };
}

export type LiveAuditPrimeSetup = {
  repo: string;
  branch: string;
  workflow: {
    present: boolean;
    version: number | null;
    dispatchable: boolean | null;
    detail: string;
  };
  remediation: {
    present: boolean;
    version: number | null;
    dispatchable: boolean | null;
    detail: string;
  };
  /** Names only, never values; null where GitHub could not be asked. */
  repoSecrets: string[] | null;
  repoVariables: string[] | null;
  productionSecrets: string[] | null;
};

/**
 * What Prime's repository holds for the live audit: the two workflow files,
 * and the NAMES of the secrets and variables they read. For engine health;
 * five GitHub reads, which its caller caches.
 */
export async function readLiveAuditPrimeSetup(): Promise<LiveAuditPrimeSetup> {
  const prime = await resolvePrimeRepo();
  const where = {
    owner: prime.owner,
    repo: prime.repo,
    ref: prime.defaultBranch,
    installationId: prime.installationId,
  };
  const unread = (err: unknown) => ({
    present: false,
    version: null,
    dispatchable: null,
    detail: err instanceof Error ? err.message : String(err),
  });
  const [workflow, remediation, repoSecrets, repoVariables, productionSecrets] = await Promise.all([
    checkScanWorkflowPresent({ ...where, workflowFile: LIVE_AUDIT_WORKFLOW_FILE }).catch(unread),
    checkScanWorkflowPresent({ ...where, workflowFile: "codex-remediation.yml" }).catch(unread),
    listRepoSecretNames(where),
    listRepoVariableNames(where),
    listEnvironmentSecretNames({ ...where, environment: "supabase-production" }),
  ]);
  return {
    repo: `${prime.owner}/${prime.repo}`,
    branch: prime.defaultBranch,
    workflow,
    remediation,
    repoSecrets,
    repoVariables,
    productionSecrets,
  };
}

/** The NAMES of a repository's Actions variables; null where GitHub could not be asked. */
async function listRepoVariableNames(input: {
  owner: string;
  repo: string;
  installationId?: string | null;
}): Promise<string[] | null> {
  try {
    const { data } = await getAppOctokit(input.installationId ?? undefined).request(
      "GET /repos/{owner}/{repo}/actions/variables",
      { owner: input.owner, repo: input.repo, per_page: 30 },
    );
    return (data.variables ?? []).map((v: { name: string }) => v.name);
  } catch (err) {
    console.warn("[live-audit] variable names not read:", (err as Error).message);
    return null;
  }
}
