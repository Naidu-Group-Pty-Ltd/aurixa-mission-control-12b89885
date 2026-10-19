// Server-only orchestration for Codex Security scans without a user context
// (pg_cron nightly job and the sweeper).
//
// Scans run on Prime only, once a night (src/lib/codex-scan-policy.ts), plus
// a person's explicit "Scan Prime now". The policy is checked here, at the
// one place a scan is queued, so no caller can route around it.
//
// This is the single insert-then-dispatch path for the whole feature; the
// authenticated `enqueueScan` server fn in src/lib/codex-security.functions.ts
// delegates here after its admin check rather than keeping a parallel copy
// that could drift.
//
// Dispatch is AWAITED, not fire-and-forget. The previous implementation
// kicked off a floating `(async () => {...})()` and returned immediately;
// on Cloudflare Workers the isolate can be reclaimed as soon as the response
// is written, so jobs were routinely left stranded at `queued` with no event
// row at all — a large part of why the pipeline looked dead.
//
// Each job is dispatched with its OWN callback key, derived from the master
// secret and the job id (see codex-callback-keys.server.ts). The master never
// leaves Mission Control; a key that leaks from one run's log opens that one
// run and nothing else.
import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import {
  dispatchCodexScan,
  resolveScanEngine,
  scanCallbackUrl,
} from "@/server/codex-security-client.server";
import {
  SCAN_CALLBACK_KEY_VERSION,
  deriveCallbackKey,
  pruneCallbackReceipts,
  resolveScanMasterSecrets,
} from "@/server/codex-callback-keys.server";
import { resolveDispatchTarget } from "@/server/codex-dispatch-target.server";
import {
  completePrCheckForJob,
  scanDetailsUrl,
  startScanCheckRun,
} from "@/server/codex-pr-checks.server";
import { alertOnScanFailed } from "@/server/codex-scan-alerts.server";
import { scanRequestAllowed } from "@/lib/codex-scan-policy";

export { resolveDispatchTarget, type DispatchTarget } from "@/server/codex-dispatch-target.server";

const admin = supabaseAdmin;

export type ScanKind =
  | "manual"
  | "nightly_full"
  | "pr_open"
  | "targeted_path"
  | "post_merge_revalidate";

export type EnqueueOpts = {
  kind: ScanKind;
  targetKind: "prime" | "clone";
  cloneId?: string | null;
  repoFullName: string;
  ref?: string | null;
  pathGlobs?: string[] | null;
  requestPayload?: Record<string, unknown>;
  dedupWindowHours?: number;
  requestedBy?: string | null;
  /** Only scan files changed against this ref (PR scans). */
  diffBase?: string | null;
  /**
   * Run the (slower, paid) Codex CLI review. Omitted, it follows
   * `prime_config.codex_deep_scan_scope`; manual scans always ask for it.
   */
  deepScan?: boolean;
};

export type EnqueueResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      jobId: string;
      engine: string;
      /** Set when the first dispatch attempt failed and a retry is pending. */
      dispatchError?: string;
    };

/** How long a STARTED scan may run before the sweeper gives up on it. */
const RUNNING_TIMEOUT_MINUTES = 75;
/**
 * How long a dispatched scan may wait for a runner before it is called lost.
 * A fleet-wide nightly can queue behind the organisation's concurrency limit
 * for a long time; failing those at 75 minutes threw away scans that were
 * merely waiting their turn.
 */
const NEVER_STARTED_TIMEOUT_MINUTES = 6 * 60;
/** How long a job may sit undispatched before the sweeper retries it. */
const QUEUED_STALL_MINUTES = 10;
/** Dispatch attempts (initial + sweeper retries) before a job is failed. */
const MAX_DISPATCH_ATTEMPTS = 3;

export type DeepScanScope = "off" | "prime" | "fleet";

/**
 * Which scans run the Codex CLI review. Manual scans are explicit operator
 * intent and always ask; everything automatic follows the configured scope.
 * The default (`prime`) stopped every clone running a 20-minute paid review
 * every night.
 */
export function deepScanFor(input: {
  kind: ScanKind;
  targetKind: "prime" | "clone";
  scope: DeepScanScope;
}): boolean {
  if (input.kind === "manual") return true;
  if (input.scope === "off") return false;
  if (input.scope === "prime") return input.targetKind === "prime";
  return true;
}

type ScanSettings = {
  deepScanScope: DeepScanScope;
  prCheckEnabled: boolean;
};

/**
 * Read the scan policy. `select("*")` on purpose: a column a deployment has
 * not migrated yet must read as its default, not fail the whole select.
 */
async function loadScanSettings(): Promise<ScanSettings> {
  const { data, error } = await admin.from("prime_config").select("*").limit(1).maybeSingle();
  if (error || !data) return { deepScanScope: "prime", prCheckEnabled: true };
  const row = data as Record<string, unknown>;
  const scope = row.codex_deep_scan_scope;
  return {
    deepScanScope: scope === "off" || scope === "fleet" ? scope : "prime",
    prCheckEnabled: row.codex_pr_check_enabled !== false,
  };
}

/**
 * The scan master secret. Prefers the deployment env var, then falls back to
 * the auto-generated secret on the built-in `codex` intake source — so a fresh
 * deployment authenticates its own scanners with no manual provisioning.
 * Never sent to a repository: per-job keys are derived from it.
 */
export async function resolveScanWebhookSecret(): Promise<string> {
  return (await resolveScanMasterSecrets()).current;
}

async function recordEvent(jobId: string, eventType: string, payload: Json = {}) {
  const { error } = await admin
    .from("codex_scan_events")
    .insert({ job_id: jobId, event_type: eventType, payload });
  // The event log is an audit convenience — never let it break a scan.
  if (error) console.warn(`[codex-scheduling] could not record ${eventType}:`, error.message);
}

/**
 * Skip if the same target already has a queued/running/completed scan of the
 * same kind within the dedup window. Prevents webhook floods (rapid PR
 * pushes) and cron overlap from stacking duplicate scans.
 */
async function recentDuplicate(opts: EnqueueOpts): Promise<boolean> {
  const window = opts.dedupWindowHours ?? 0;
  if (window <= 0) return false;
  const since = new Date(Date.now() - window * 60 * 60 * 1000).toISOString();
  const query = admin
    .from("codex_scan_jobs")
    .select("id")
    .eq("target_kind", opts.targetKind)
    .eq("kind", opts.kind)
    .eq("repo_full_name", opts.repoFullName)
    .gte("created_at", since)
    .in("status", ["queued", "running", "completed"])
    .limit(1);
  if (opts.cloneId) query.eq("clone_id", opts.cloneId);
  else query.is("clone_id", null);
  if (opts.ref) query.eq("ref", opts.ref);
  const { data } = await query;
  return !!data?.length;
}

type DispatchableJob = {
  id: string;
  kind: ScanKind;
  target_kind: "prime" | "clone";
  clone_id: string | null;
  repo_full_name: string;
  ref: string | null;
  path_globs: string[] | null;
  failure_count?: number | null;
  request_payload?: Json | null;
};

/**
 * The key this job's workflow signs its callbacks with. Jobs created before
 * per-job keys existed carry no `callback_key` and are dispatched with the
 * master, which is what their webhook verification expects.
 */
async function callbackKeyForJob(job: DispatchableJob): Promise<string> {
  const master = await resolveScanWebhookSecret();
  if (!master) return "";
  const payload = (job.request_payload ?? {}) as Record<string, unknown>;
  return payload.callback_key === SCAN_CALLBACK_KEY_VERSION
    ? deriveCallbackKey(master, "scan", job.id)
    : master;
}

/**
 * Open the PR's "Codex Security" check as soon as its scan is on its way, so
 * the pull request shows a scan is running. Once per job: a sweeper retry
 * finds the id already recorded.
 */
async function openPrCheck(
  job: DispatchableJob,
  target: { owner: string; repo: string; installationId: string | null },
) {
  const payload = (job.request_payload ?? {}) as Record<string, unknown>;
  if (job.kind !== "pr_open" || payload.pr_check !== true || payload.check_run_id) return;
  if (!job.ref || !/^[0-9a-f]{40}$/i.test(job.ref)) return;

  const res = await startScanCheckRun({
    owner: target.owner,
    repo: target.repo,
    installationId: target.installationId,
    headSha: job.ref,
    jobId: job.id,
    detailsUrl: scanDetailsUrl(job.id),
  });
  if (!res.ok) {
    await recordEvent(
      job.id,
      "check_run_unavailable",
      asJson({ http_status: res.status ?? null, error: res.error }),
    );
    return;
  }
  const { error } = await admin
    .from("codex_scan_jobs")
    .update({ request_payload: asJson({ ...payload, check_run_id: res.id }) })
    .eq("id", job.id);
  if (error) {
    await recordEvent(
      job.id,
      "check_run_unrecorded",
      asJson({ check_run_id: res.id, error: error.message }),
    );
  } else {
    payload.check_run_id = res.id;
    job.request_payload = asJson(payload);
  }
}

/**
 * Send an already-inserted job to the scan engine and record the outcome.
 * Shared by the initial enqueue and by the sweeper's retry path.
 */
async function dispatchJob(
  job: DispatchableJob,
): Promise<{ ok: true } | { ok: false; error: string; terminal: boolean }> {
  const attempt = (job.failure_count ?? 0) + 1;
  const payload = (job.request_payload ?? {}) as Record<string, unknown>;

  try {
    const target = await resolveDispatchTarget({
      targetKind: job.target_kind,
      cloneId: job.clone_id,
      repoFullName: job.repo_full_name,
    });

    const res = await dispatchCodexScan({
      jobId: job.id,
      repoFullName: job.repo_full_name,
      ref: job.ref ?? null,
      pathGlobs: job.path_globs ?? null,
      kind: job.kind,
      callbackUrl: scanCallbackUrl(),
      callbackSecret: await callbackKeyForJob(job),
      owner: target.owner,
      repo: target.repo,
      installationId: target.installationId,
      dispatchRef: target.defaultBranch,
      diffBase: (payload.diffBase as string) ?? null,
      deepScan: payload.deepScan !== false,
      metadata: payload,
    });

    const { error: updErr } = await admin
      .from("codex_scan_jobs")
      .update({
        external_scan_id: res.externalScanId,
        status: "running",
        started_at: new Date().toISOString(),
        next_attempt_at: null,
        last_error: null,
      })
      .eq("id", job.id);
    if (updErr)
      console.error("[codex-scheduling] dispatched but could not mark running:", updErr.message);

    await recordEvent(
      job.id,
      "dispatched",
      asJson({ engine: res.engine, externalScanId: res.externalScanId, kind: job.kind, attempt }),
    );
    await openPrCheck(job, target);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const terminal = attempt >= MAX_DISPATCH_ATTEMPTS;

    const { error: updErr } = await admin
      .from("codex_scan_jobs")
      .update({
        status: terminal ? "failed" : "queued",
        failure_count: attempt,
        last_error: message,
        // Exponential-ish backoff before the sweeper tries again.
        next_attempt_at: terminal
          ? null
          : new Date(Date.now() + attempt * 5 * 60 * 1000).toISOString(),
        completed_at: terminal ? new Date().toISOString() : null,
      })
      .eq("id", job.id);
    if (updErr)
      console.error("[codex-scheduling] could not record dispatch failure:", updErr.message);

    await recordEvent(
      job.id,
      terminal ? "dispatch_failed" : "dispatch_retry_scheduled",
      asJson({ error: message, kind: job.kind, attempt }),
    );
    return { ok: false, error: message, terminal };
  }
}

export async function enqueueScanNoAuth(opts: EnqueueOpts): Promise<EnqueueResult> {
  const allowed = scanRequestAllowed({ kind: opts.kind, targetKind: opts.targetKind });
  if (!allowed.ok) return { skipped: true, reason: allowed.reason };
  if (!opts.repoFullName) return { skipped: true, reason: "missing_repo" };
  if (await recentDuplicate(opts)) {
    return { skipped: true, reason: "duplicate_within_window" };
  }

  const settings = await loadScanSettings();
  const deepScan =
    opts.deepScan ??
    deepScanFor({ kind: opts.kind, targetKind: opts.targetKind, scope: settings.deepScanScope });

  const requestPayload = {
    source: opts.kind,
    ...(opts.requestPayload ?? {}),
    ...(opts.diffBase ? { diffBase: opts.diffBase } : {}),
    ...(deepScan === false ? { deepScan: false } : {}),
    ...(opts.kind === "pr_open" ? { pr_check: settings.prCheckEnabled } : {}),
    callback_key: SCAN_CALLBACK_KEY_VERSION,
  };

  const { data: job, error } = await admin
    .from("codex_scan_jobs")
    .insert({
      kind: opts.kind,
      target_kind: opts.targetKind,
      clone_id: opts.cloneId ?? null,
      repo_full_name: opts.repoFullName,
      ref: opts.ref ?? null,
      path_globs: opts.pathGlobs ?? null,
      requested_by: opts.requestedBy ?? null,
      request_payload: asJson(requestPayload),
      engine: resolveScanEngine(),
    })
    .select(
      "id, kind, target_kind, clone_id, repo_full_name, ref, path_globs, failure_count, request_payload",
    )
    .single();
  if (error) throw error;

  // Awaited on purpose — see the module header.
  const result = await dispatchJob({ ...job, target_kind: job.target_kind as "prime" | "clone" });
  if (!result.ok && result.terminal) {
    return { skipped: true, reason: result.error };
  }

  return {
    skipped: false,
    jobId: job.id,
    engine: resolveScanEngine(),
    // Surfaced so an operator clicking "Scan now" learns immediately that
    // the dispatch bounced, rather than watching a job sit at `queued`.
    ...(result.ok ? {} : { dispatchError: result.error }),
  };
}

export type NightlyResult = {
  enqueued: Array<{ target: string; jobId: string; kind: string }>;
  skipped: Array<{ target: string; reason: string }>;
};

/**
 * Enqueue the nightly scan of Prime, unless `prime_config.codex_nightly_enabled`
 * is off. Clones are not scanned (src/lib/codex-scan-policy.ts): they receive
 * Prime's fixes through the cascade.
 */
export async function runNightlyScans(): Promise<NightlyResult> {
  const enqueued: NightlyResult["enqueued"] = [];
  const skipped: NightlyResult["skipped"] = [];

  const { data: prime } = await admin
    .from("prime_config")
    .select(
      "github_owner, github_repo, default_branch, codex_nightly_enabled, codex_scan_dedup_hours",
    )
    .limit(1)
    .maybeSingle();

  if (!prime) {
    skipped.push({ target: "prime", reason: "prime_not_configured" });
    return { enqueued, skipped };
  }
  if (!prime.codex_nightly_enabled) {
    skipped.push({ target: "prime", reason: "nightly_disabled" });
    return { enqueued, skipped };
  }

  const repo = `${prime.github_owner}/${prime.github_repo}`;
  try {
    const r = await enqueueScanNoAuth({
      kind: "nightly_full",
      targetKind: "prime",
      repoFullName: repo,
      ref: prime.default_branch || "main",
      dedupWindowHours: prime.codex_scan_dedup_hours ?? 6,
      requestPayload: { source: "nightly" },
    });
    if (r.skipped) skipped.push({ target: `prime:${repo}`, reason: r.reason });
    else enqueued.push({ target: `prime:${repo}`, jobId: r.jobId, kind: "nightly_full" });
  } catch (err) {
    skipped.push({ target: `prime:${repo}`, reason: (err as Error).message });
  }
  return { enqueued, skipped };
}

export type SweepResult = {
  retried: string[];
  failed: Array<{ jobId: string; reason: string }>;
  timedOut: string[];
  receiptsPruned: number;
};

type SweepJob = {
  id: string;
  kind: string;
  target_kind: string;
  clone_id: string | null;
  repo_full_name: string;
  request_payload: unknown;
  workflow_run_url: string | null;
};

async function failHungJob(job: SweepJob, reason: string, eventType: string, payload: Json) {
  const { error } = await admin
    .from("codex_scan_jobs")
    .update({ status: "failed", last_error: reason, completed_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "running");
  if (error) {
    console.error("[codex-scheduling] could not retire hung scan:", error.message);
    return false;
  }
  await recordEvent(job.id, eventType, payload);
  if (job.kind === "pr_open") {
    await completePrCheckForJob({
      job,
      outcome: { kind: "failed", reason, runUrl: job.workflow_run_url },
    });
  }
  await alertOnScanFailed({ ...job, last_error: reason });
  return true;
}

/**
 * Reconcile jobs the happy path lost track of:
 *
 *  - `queued` past the stall window → the dispatch never landed (isolate
 *    reclaimed mid-flight, GitHub outage, missing workflow). Re-dispatch,
 *    then fail once the attempt budget is spent.
 *  - `running` and STARTED (a `scan.started` callback named its run) past
 *    the timeout → the workflow died without a terminal callback.
 *  - `running` but never started past the much longer runner-wait window →
 *    the run was lost before it began.
 *
 * Without this, a single lost dispatch left a job "queued" forever and the
 * dedup window then suppressed every subsequent scan of that target.
 */
export async function sweepStalledScans(options?: {
  queuedStallMinutes?: number;
  runningTimeoutMinutes?: number;
  neverStartedTimeoutMinutes?: number;
  limit?: number;
}): Promise<SweepResult> {
  const queuedStall = options?.queuedStallMinutes ?? QUEUED_STALL_MINUTES;
  const runningTimeout = options?.runningTimeoutMinutes ?? RUNNING_TIMEOUT_MINUTES;
  const neverStarted = options?.neverStartedTimeoutMinutes ?? NEVER_STARTED_TIMEOUT_MINUTES;
  const limit = options?.limit ?? 50;
  const now = Date.now();

  const retried: string[] = [];
  const failed: SweepResult["failed"] = [];
  const timedOut: string[] = [];

  // 1) Stranded queued jobs — re-dispatch or retire.
  const { data: stranded } = await admin
    .from("codex_scan_jobs")
    .select(
      "id, kind, target_kind, clone_id, repo_full_name, ref, path_globs, failure_count, request_payload, next_attempt_at, last_error",
    )
    .eq("status", "queued")
    .lte("created_at", new Date(now - queuedStall * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  for (const job of stranded ?? []) {
    // Respect the backoff window set by the previous failed attempt.
    if (job.next_attempt_at && new Date(job.next_attempt_at).getTime() > now) continue;

    if ((job.failure_count ?? 0) >= MAX_DISPATCH_ATTEMPTS) {
      const { error } = await admin
        .from("codex_scan_jobs")
        .update({
          status: "failed",
          last_error: job.last_error || "dispatch_attempts_exhausted",
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (error) {
        console.error("[codex-scheduling] could not retire stranded scan:", error.message);
        continue;
      }
      await recordEvent(job.id, "sweep_failed", { reason: "dispatch_attempts_exhausted" });
      await alertOnScanFailed({
        ...job,
        last_error: job.last_error || "dispatch_attempts_exhausted",
      });
      failed.push({ jobId: job.id, reason: "dispatch_attempts_exhausted" });
      continue;
    }

    await recordEvent(job.id, "sweep_retry", { failureCount: job.failure_count ?? 0 });
    const r = await dispatchJob({
      ...job,
      kind: job.kind as ScanKind,
      target_kind: job.target_kind as "prime" | "clone",
    });
    if (r.ok) retried.push(job.id);
    else if (r.terminal) failed.push({ jobId: job.id, reason: r.error });
  }

  // 2) Started runs that never reported a terminal callback. `started_at` is
  // reset by the `scan.started` callback, so this clock starts when the run
  // did, not when it was dispatched.
  const { data: hung } = await admin
    .from("codex_scan_jobs")
    .select("id, kind, target_kind, clone_id, repo_full_name, request_payload, workflow_run_url")
    .eq("status", "running")
    .not("workflow_run_id", "is", null)
    .lte("started_at", new Date(now - runningTimeout * 60 * 1000).toISOString())
    .limit(limit);

  for (const job of hung ?? []) {
    const ok = await failHungJob(
      job,
      `Scan timed out after ${runningTimeout} minutes with no completion callback.`,
      "sweep_timeout",
      { runningTimeoutMinutes: runningTimeout },
    );
    if (ok) timedOut.push(job.id);
  }

  // 3) Dispatched runs that never started at all.
  const { data: lost } = await admin
    .from("codex_scan_jobs")
    .select("id, kind, target_kind, clone_id, repo_full_name, request_payload, workflow_run_url")
    .eq("status", "running")
    .is("workflow_run_id", null)
    .lte("started_at", new Date(now - neverStarted * 60 * 1000).toISOString())
    .limit(limit);

  for (const job of lost ?? []) {
    const ok = await failHungJob(
      job,
      `The scan was dispatched but its workflow never started within ${Math.round(neverStarted / 60)} hours.`,
      "sweep_never_started",
      { neverStartedTimeoutMinutes: neverStarted },
    );
    if (ok) timedOut.push(job.id);
  }

  const receiptsPruned = await pruneCallbackReceipts();

  return { retried, failed, timedOut, receiptsPruned };
}

/**
 * Resolve a repo full-name to (targetKind, cloneId) so webhook-driven scans
 * are stored against the right owner. Returns null if the repo is neither
 * Prime nor a known clone (the webhook is still verified, there is just
 * nothing to do).
 */
export async function resolveScanTarget(
  repoFullName: string,
): Promise<{ targetKind: "prime" | "clone"; cloneId?: string } | null> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return null;

  const { data: prime } = await admin
    .from("prime_config")
    .select("github_owner, github_repo")
    .limit(1)
    .maybeSingle();
  if (
    prime &&
    prime.github_owner?.toLowerCase() === owner.toLowerCase() &&
    prime.github_repo?.toLowerCase() === repo.toLowerCase()
  ) {
    return { targetKind: "prime" };
  }

  // Matched on owner/repo rather than the generated `repo_full_name` column:
  // those two always exist, whereas an `.or()` naming a column a deployment
  // has not migrated yet fails the whole query — which silently disabled
  // PR-driven scans for every clone. `ilike` with the LIKE wildcards escaped:
  // GitHub names may contain `_`, which would otherwise match any character
  // and could attribute one clone's PR to another.
  const { data: clones } = await admin
    .from("clones")
    .select("id, github_owner, github_repo")
    .ilike("github_owner", escapeLike(owner))
    .ilike("github_repo", escapeLike(repo))
    .limit(5);
  const match = (clones ?? []).find(
    (c) =>
      c.github_owner?.toLowerCase() === owner.toLowerCase() &&
      c.github_repo?.toLowerCase() === repo.toLowerCase(),
  );
  if (match?.id) return { targetKind: "clone", cloneId: match.id };
  return null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
