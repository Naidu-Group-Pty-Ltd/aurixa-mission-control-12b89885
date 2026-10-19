// Operator-facing diagnostics for the Codex Security scan engine.
//
// The failure mode this exists to kill: the pipeline stops running and the
// UI shows nothing but an empty job table, so there is no way to tell a
// missing GitHub App permission from an unconfigured webhook secret from a
// workflow file that was never copied into the target repo. Every check
// below reports a boolean plus the exact remediation step.
//
// Only presence/absence of secrets is ever reported — never their values.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  CODEX_REMEDIATION_WORKFLOW_VERSION,
  CODEX_SCAN_WORKFLOW_VERSION,
  reportedWorkflowVersion,
} from "@/lib/codex-workflow-contract";
import { degradedScanners } from "@/lib/codex-finding-lifecycle";

// GitHub reads are cached per server instance: the panel polls, and each poll
// used to spend App-installation calls on a file that changes once a month.
const GITHUB_CACHE_MS = 10 * 60_000;
const githubCache = new Map<string, { at: number; value: unknown }>();
async function cachedGitHub<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = githubCache.get(key);
  if (hit && Date.now() - hit.at < GITHUB_CACHE_MS) return hit.value as T;
  const value = await load();
  githubCache.set(key, { at: Date.now(), value });
  return value;
}

const CODEX_CRON_JOBS = ["codex-security-nightly", "codex-security-sweep"] as const;

export type HealthCheck = {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What an operator should do about it, when it is not ok. */
  fix?: string;
};

export const getCodexEngineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  // `context` is typed by the auth middleware at runtime; the project's
  // non-strict tsconfig cannot infer it through createServerFn's builder.
  .handler(async ({ context }: { context: any }) => {
    const { supabase, userId } = context;
    const { data: isOperator } = await supabase.rpc("is_operator", { _user_id: userId });
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isOperator && !isAdmin) throw new Error("Forbidden: operator or admin only");

    const {
      resolveScanEngine,
      scanWorkflowFile,
      scanCallbackUrl,
      appPublicOrigin,
      checkScanWorkflowPresent,
    } = await import("@/server/codex-security-client.server");
    const { resolveScanMasterSecrets } = await import("@/server/codex-callback-keys.server");

    const engine = resolveScanEngine();
    const checks: HealthCheck[] = [];

    checks.push({
      key: "engine",
      label: "Scan engine",
      status: "ok",
      detail:
        engine === "github_actions"
          ? `GitHub Actions — dispatches .github/workflows/${scanWorkflowFile()} in each target repo`
          : `Hosted HTTP API — ${process.env.CODEX_SECURITY_BASE_URL || "(default base URL)"}`,
    });

    // ── Callback plumbing ────────────────────────────────────────────────
    const origin = appPublicOrigin();
    const originExplicit = !!(process.env.APP_PUBLIC_URL || process.env.PUBLIC_APP_URL);
    checks.push({
      key: "callback_url",
      label: "Callback URL",
      status: originExplicit ? "ok" : "warn",
      detail: scanCallbackUrl(),
      fix: originExplicit
        ? undefined
        : `Neither APP_PUBLIC_URL nor PUBLIC_APP_URL is set — falling back to ${origin}. Scanners post results to this URL, so set it if that host is wrong.`,
    });

    // Only the mode and the presence of a previous key are reported — never
    // a value.
    const masters = await resolveScanMasterSecrets();
    checks.push({
      key: "webhook_secret",
      label: "Callback signing key",
      status: masters.current ? "ok" : "fail",
      detail: masters.current
        ? `${
            masters.mode === "env"
              ? "Master from CODEX_SECURITY_WEBHOOK_SECRET"
              : "Auto-generated master on the built-in `codex` intake source"
          }; every scan and fix signs with its own key derived from it` +
          (masters.previous.length
            ? ". A previous master is still accepted (rotation grace window)."
            : ".")
        : "No signing secret available — scans are refused before dispatch",
      fix: masters.current
        ? undefined
        : "Set CODEX_SECURITY_WEBHOOK_SECRET, or ensure the built-in `codex` row in security_intake_sources has an hmac_secret.",
    });

    checks.push({
      key: "cron_secret",
      label: "Cron shared secret",
      status: process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN ? "ok" : "fail",
      detail:
        process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN
          ? "Configured — scheduled nightly scans and the sweeper can authenticate"
          : "Missing — every pg_cron call to /hooks/* is rejected with 401",
      fix:
        process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN
          ? undefined
          : "Set CRON_SECRET, and mirror it into Postgres so pg_cron can send it: ALTER DATABASE postgres SET app.settings.cron_secret = '<value>';",
    });

    // ── GitHub App ───────────────────────────────────────────────────────
    if (engine === "github_actions") {
      const appConfigured =
        !!process.env.GITHUB_APP_ID &&
        !!process.env.GITHUB_APP_PRIVATE_KEY &&
        !!process.env.GITHUB_APP_INSTALLATION_ID;
      checks.push({
        key: "github_app",
        label: "GitHub App credentials",
        status: appConfigured ? "ok" : "fail",
        detail: appConfigured
          ? "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID are set"
          : "Incomplete — scan dispatch cannot authenticate to GitHub",
        fix: appConfigured
          ? undefined
          : "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID. The App installation needs Actions: read & write.",
      });
    } else {
      checks.push({
        key: "api_key",
        label: "Codex API key",
        status: process.env.CODEX_SECURITY_API_KEY ? "ok" : "fail",
        detail: process.env.CODEX_SECURITY_API_KEY
          ? "CODEX_SECURITY_API_KEY is set"
          : "CODEX_SECURITY_API_KEY is not set — every HTTP-engine dispatch throws",
        fix: process.env.CODEX_SECURITY_API_KEY
          ? undefined
          : "Set CODEX_SECURITY_API_KEY, or switch back to the GitHub Actions engine by unsetting CODEX_SECURITY_ENGINE.",
      });
    }

    // ── The two fix engines' keys (synced into Prime's Actions secrets) ────
    checks.push({
      key: "openai_key",
      label: "Codex key (P2 and below fixes, reasoning pass)",
      status: process.env.OPENAI_API_KEY ? "ok" : "fail",
      detail: process.env.OPENAI_API_KEY
        ? "OPENAI_API_KEY available to sync into Prime's Actions secrets"
        : "No OPENAI_API_KEY in Mission Control — medium and low findings cannot be fixed, and scans skip the reasoning pass",
      fix: process.env.OPENAI_API_KEY
        ? undefined
        : "Set OPENAI_API_KEY, then run the Actions secret sync for Prime in Settings.",
    });
    checks.push({
      key: "anthropic_key",
      label: "Claude key (P0 and P1 fixes)",
      status: process.env.ANTHROPIC_API_KEY ? "ok" : "fail",
      detail: process.env.ANTHROPIC_API_KEY
        ? "ANTHROPIC_API_KEY available to sync into Prime's Actions secrets"
        : "No ANTHROPIC_API_KEY in Mission Control — critical and high findings cannot be fixed",
      fix: process.env.ANTHROPIC_API_KEY
        ? undefined
        : "Set ANTHROPIC_API_KEY, then run the Actions secret sync for Prime in Settings.",
    });

    // ── Prime repo + workflow presence ───────────────────────────────────
    // `*`: settings arrive with 20261018090000 and 20261018120000.
    const { data: primeRow } = await supabase
      .from("prime_config")
      .select("*")
      .limit(1)
      .maybeSingle();
    const prime = primeRow as
      | (Record<string, any> & {
          github_owner: string | null;
          github_repo: string | null;
          default_branch: string | null;
          github_app_installation_id: string | null;
        })
      | null;

    const primeRepo = prime ? `${prime.github_owner}/${prime.github_repo}` : null;
    checks.push({
      key: "prime_repo",
      label: "Prime repository",
      status: primeRepo ? "ok" : "fail",
      detail: primeRepo ?? "prime_config has no GitHub repo configured",
      fix: primeRepo ? undefined : "Set github_owner / github_repo in prime_config.",
    });

    if (engine === "github_actions" && prime?.github_owner && prime?.github_repo) {
      // Network call — the single most common cause of a silently dead
      // pipeline is the workflow file never having been copied to the repo;
      // the next is a copy older than this Mission Control expects.
      const where = {
        owner: prime.github_owner,
        repo: prime.github_repo,
        ref: prime.default_branch || undefined,
        installationId: prime.github_app_installation_id ?? null,
      };
      const unread = (err: unknown) => ({
        present: false,
        detail: (err as Error).message,
        version: null,
        dispatchable: null,
      });
      const [scanWf, remWf, ciWf] = await cachedGitHub(
        `workflows:${primeRepo}:${where.ref ?? ""}`,
        () =>
          Promise.all([
            checkScanWorkflowPresent(where).catch(unread),
            checkScanWorkflowPresent({ ...where, workflowFile: "codex-remediation.yml" }).catch(
              unread,
            ),
            // The CI every fix must pass before it merges (fixCiGate.pure.ts).
            checkScanWorkflowPresent({ ...where, workflowFile: "ci.yml" }).catch(unread),
          ]),
      );
      const branch = prime.default_branch || "main";
      const scanCurrent = (scanWf.version ?? 1) >= CODEX_SCAN_WORKFLOW_VERSION;
      checks.push({
        key: "workflow_file",
        label: "Scan workflow in Prime repo",
        status: !scanWf.present ? "fail" : scanCurrent ? "ok" : "warn",
        detail: scanWf.present
          ? `${scanWf.detail} — version ${scanWf.version ?? 1}${scanCurrent ? "" : ` (this Mission Control ships version ${CODEX_SCAN_WORKFLOW_VERSION})`}`
          : scanWf.detail,
        fix: !scanWf.present
          ? `Commit .github/workflows/${scanWorkflowFile()} to ${primeRepo} on branch ${branch} (a reference copy lives in this repo).`
          : scanCurrent
            ? undefined
            : `Copy .github/workflows/${scanWorkflowFile()} from Mission Control into ${primeRepo}. Older copies leak their callback key into Actions logs, report failed scanners as clean, and let a change's own ignore-file edits exempt it.`,
      });
      const remCurrent = (remWf.version ?? 1) >= CODEX_REMEDIATION_WORKFLOW_VERSION;
      checks.push({
        key: "remediation_workflow_file",
        label: "Fix workflow in Prime repo",
        status: !remWf.present ? "warn" : remCurrent ? "ok" : "warn",
        detail: remWf.present
          ? `${remWf.detail} — version ${remWf.version ?? 1}${remCurrent ? "" : ` (this Mission Control ships version ${CODEX_REMEDIATION_WORKFLOW_VERSION})`}`
          : `${remWf.detail} — “Draft Fix PR” cannot run there`,
        fix: remCurrent
          ? undefined
          : `Copy .github/workflows/codex-remediation.yml from Mission Control into ${primeRepo}. Older copies write every fix with Codex (no Claude for P0/P1), accept fixes that silence a scanner, and do not ask for the repository's CI before a fix merges.`,
      });
      // A fix PR opened by the workflow's token starts no CI, so the merge
      // lane dispatches ci.yml itself — which needs a workflow_dispatch
      // trigger. Without one no fix can merge.
      checks.push({
        key: "fix_ci",
        label: "CI that fixes must pass",
        status: !ciWf.present ? "warn" : ciWf.dispatchable === false ? "fail" : "ok",
        detail: !ciWf.present
          ? `${ciWf.detail} — fixes merge on the fix workflow's own checks alone`
          : ciWf.dispatchable === false
            ? ".github/workflows/ci.yml has no workflow_dispatch trigger, so it cannot run on a fix PR and no fix merges"
            : ".github/workflows/ci.yml runs on every fix PR before it merges",
        fix: !ciWf.present
          ? undefined
          : ciWf.dispatchable === false
            ? `Add \`workflow_dispatch:\` to the \`on:\` block of .github/workflows/ci.yml in ${primeRepo}.`
            : undefined,
      });
    }

    // ── Prime's default branch (prime-branch-protection.server.ts) ────────
    // Read-only here: the nightly run applies it, and "Protect main now" does
    // so on demand. Fixes merge with nobody reading them, and this ruleset is
    // what holds every merge to CI.
    if (
      prime?.github_owner &&
      prime?.github_repo &&
      process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY
    ) {
      const { ensurePrimeBranchProtection } =
        await import("@/server/prime-branch-protection.server");
      // Cached only while it is in order. A problem is read fresh each time,
      // so the panel shows the result of “Protect main now” at once.
      const key = `protection:${primeRepo}`;
      const hit = githubCache.get(key);
      const fresh = !!hit && Date.now() - hit.at < GITHUB_CACHE_MS;
      const protection = fresh
        ? (hit!.value as Awaited<ReturnType<typeof ensurePrimeBranchProtection>>)
        : await ensurePrimeBranchProtection({ apply: false });
      if (!fresh) {
        if (protection.ok) githubCache.set(key, { at: Date.now(), value: protection });
        else githubCache.delete(key);
      }
      const pending = protection.status === "would_create" || protection.status === "would_update";
      checks.push({
        key: "branch_protection",
        label: `Protection on ${prime.default_branch || "main"}`,
        status: protection.ok ? "ok" : pending ? "warn" : "fail",
        detail: protection.detail,
        fix: protection.ok
          ? undefined
          : (protection.fix ??
            (pending ? "Press “Protect main now”, or wait for tonight's run." : undefined)),
      });
    }

    // ── Recent activity ──────────────────────────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [recentRes, lastCompletedRes, stalledRes] = await Promise.all([
      supabase.from("codex_scan_jobs").select("status").gte("created_at", since),
      supabase
        .from("codex_scan_jobs")
        .select("id, repo_full_name, completed_at, result_summary")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1),
      supabase
        .from("codex_scan_jobs")
        .select("id")
        .in("status", ["queued", "running"])
        .lte("created_at", new Date(Date.now() - 75 * 60 * 1000).toISOString()),
    ]);

    const byStatus: Record<string, number> = {};
    for (const j of recentRes.data ?? []) {
      byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    }

    const lastCompleted = lastCompletedRes.data?.[0] ?? null;
    checks.push({
      key: "last_completed",
      label: "Last completed scan",
      status: lastCompleted ? "ok" : "warn",
      detail: lastCompleted
        ? `${lastCompleted.repo_full_name} at ${lastCompleted.completed_at}`
        : "No scan has ever completed",
      fix: lastCompleted
        ? undefined
        : "Fix any failing check above, then use “Scan Prime Now” to verify the pipeline end to end.",
    });

    const stalledCount = (stalledRes.data ?? []).length;
    checks.push({
      key: "stalled",
      label: "Stalled jobs",
      status: stalledCount === 0 ? "ok" : "warn",
      detail:
        stalledCount === 0
          ? "No jobs stuck in queued/running"
          : `${stalledCount} job(s) stuck for over 75 minutes`,
      fix:
        stalledCount === 0
          ? undefined
          : "The sweeper (/hooks/codex-sweep, every 10 minutes) retries or retires these. Check that the pg_cron job exists and CRON_SECRET matches.",
    });

    // ── What Prime's scans actually ran, and how well ────────────────────
    // Prime only: clones are no longer scanned (src/lib/codex-scan-policy.ts).
    const fortnight = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentCompleted } = await supabase
      .from("codex_scan_jobs")
      .select("repo_full_name, completed_at, result_summary")
      .eq("status", "completed")
      .eq("target_kind", "prime")
      .gte("completed_at", fortnight)
      .order("completed_at", { ascending: false })
      .limit(100);
    const latestByRepo = new Map<string, any>();
    for (const j of recentCompleted ?? []) {
      if (!latestByRepo.has(j.repo_full_name)) latestByRepo.set(j.repo_full_name, j);
    }
    const outdated = [...latestByRepo.values()].filter(
      (j) => reportedWorkflowVersion(j.result_summary) < CODEX_SCAN_WORKFLOW_VERSION,
    );
    checks.push({
      key: "reported_workflow_version",
      label: "Workflow version Prime's scans ran",
      status: latestByRepo.size === 0 || outdated.length === 0 ? "ok" : "warn",
      detail:
        latestByRepo.size === 0
          ? "No completed scans in the last 14 days to read versions from"
          : outdated.length === 0
            ? `The latest scan ran scan workflow version ${CODEX_SCAN_WORKFLOW_VERSION}`
            : `${outdated.length} of ${latestByRepo.size} repositories still report an older scan workflow: ` +
              outdated
                .slice(0, 5)
                .map((j) => j.repo_full_name)
                .join(", ") +
              (outdated.length > 5 ? ` and ${outdated.length - 5} more` : ""),
      fix:
        outdated.length === 0
          ? undefined
          : "Update Prime's copy (see above). Until then its scans sign with the shared master and cannot resolve dependency or AI findings by absence.",
    });

    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const degraded = new Map<string, { count: number; reason: string }>();
    let weekScans = 0;
    for (const j of recentCompleted ?? []) {
      if (!j.completed_at || j.completed_at < week) continue;
      weekScans += 1;
      for (const d of degradedScanners(j.result_summary as any)) {
        const cur = degraded.get(d.name);
        degraded.set(d.name, { count: (cur?.count ?? 0) + 1, reason: cur?.reason ?? d.reason });
      }
    }
    checks.push({
      key: "degraded_scanners",
      label: "Scanner reliability (7 days)",
      status: degraded.size === 0 ? "ok" : "warn",
      detail:
        degraded.size === 0
          ? weekScans
            ? `Every scanner reported success in all ${weekScans} completed scans`
            : "No completed scans this week"
          : [...degraded.entries()]
              .map(
                ([name, d]) =>
                  `${name} failed in ${d.count} of ${weekScans} scans (latest: ${d.reason})`,
              )
              .join("; "),
      fix:
        degraded.size === 0
          ? undefined
          : "A failed scanner never resolves findings by their absence, so its findings stay as they were until it runs cleanly. Open the scan's run to see why.",
    });

    // ── Automatic fixes (src/lib/codex-autofix-policy.ts) ────────────────
    const autofixOn = prime ? prime.codex_autofix_enabled !== false : false;
    const { data: lastAutofix } = await supabase
      .from("codex_scan_events")
      .select("payload, created_at")
      .eq("event_type", "autofix.summary")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastRun = lastAutofix?.payload as
      | { dispatched?: number; by_engine?: Record<string, number>; failed?: unknown[] }
      | undefined;
    checks.push({
      key: "autofix",
      label: "Automatic fixes",
      status: !autofixOn ? "warn" : (lastRun?.failed?.length ?? 0) > 0 ? "warn" : "ok",
      detail: !autofixOn
        ? "Switched off — findings are not fixed until someone drafts a fix"
        : lastAutofix
          ? `After the last nightly scan (${String(lastAutofix.created_at).slice(0, 16).replace("T", " ")}): ` +
            `${lastRun?.dispatched ?? 0} dispatched (Claude ${lastRun?.by_engine?.claude_code ?? 0}, ` +
            `Codex ${lastRun?.by_engine?.codex_cli ?? 0})` +
            ((lastRun?.failed?.length ?? 0) > 0
              ? `, ${lastRun?.failed?.length} could not be dispatched`
              : "")
          : "On — the first nightly scan of Prime will dispatch fixes",
      fix: !autofixOn
        ? "Turn automatic fixes on in the scheduling card below."
        : (lastRun?.failed?.length ?? 0) > 0
          ? "See the autofix.summary event on the last nightly scan for each failure."
          : undefined,
    });

    // pg_cron, read with the service role: `cron` is not exposed to users.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: cronRows, error: cronErr } = await supabaseAdmin.rpc("cron_delivery_health", {
        _since_hours: 24,
      });
      if (!cronErr) {
        const rows = (cronRows ?? []) as Array<{
          jobname: string;
          active: boolean;
          runs: number;
          delivered: boolean;
          last_http_status: number | null;
          last_run_at: string | null;
        }>;
        for (const name of CODEX_CRON_JOBS) {
          const row = rows.find((r) => r.jobname === name);
          const label =
            name === "codex-security-nightly" ? "Nightly scan schedule" : "Sweeper schedule";
          checks.push({
            key: `cron_${name}`,
            label,
            status: !row || !row.active ? "fail" : row.runs > 0 && !row.delivered ? "warn" : "ok",
            detail: !row
              ? `pg_cron has no ${name} job`
              : !row.active
                ? `${name} is scheduled but inactive`
                : row.runs > 0
                  ? `${row.runs} run(s) in 24h, last HTTP ${row.last_http_status ?? "—"}${row.delivered ? "" : " — not delivering"}`
                  : `${name} is active; it has not fired in the last 24 hours`,
            fix:
              !row || !row.active
                ? "Re-apply the codex scheduling migration, or reschedule from the settings card; the job needs the vault entry cron_secret."
                : row.runs > 0 && !row.delivered
                  ? "Check CRON_SECRET matches the vault's cron_secret and the app URL pg_cron calls."
                  : undefined,
          });
        }
      }
    } catch (err) {
      console.warn("[codex-engine-health] cron health unavailable:", (err as Error).message);
    }

    const failedCount = (byStatus.failed ?? 0) + 0;
    const summary = {
      engine,
      last24h: byStatus,
      healthy: checks.every((c) => c.status !== "fail"),
      failing: checks.filter((c) => c.status === "fail").length,
      warnings: checks.filter((c) => c.status === "warn").length,
      nightlyEnabled: prime?.codex_nightly_enabled ?? null,
      autofixEnabled: prime ? prime.codex_autofix_enabled !== false : null,
      recentFailures: failedCount,
      signingKeyMode: masters.mode,
      signingKeyRotatable: masters.mode === "intake_source",
      signingKeyInGrace: masters.previous.length > 0,
      // Shown as a button when the protection is missing or has drifted.
      branchProtectionApplicable: checks.some(
        (c) => c.key === "branch_protection" && c.status !== "ok",
      ),
    };

    return { checks, summary };
  });
