// The pre-20261018090000 ingest path, kept for one purpose: a deployment
// whose code has shipped before the migration that adds
// `codex_ingest_scan_findings` / `codex_finalize_scan` has been applied.
// Migrations here are queued and applied by a pg_cron drain after merge, so
// the two can briefly disagree; a scan arriving in that window must still be
// recorded rather than lost.
//
// It is the old behaviour (one row per finding per scan, carry-forward by
// fingerprint, auto-resolve against the previous full scan) with two of its
// faults removed: every write's error is checked, and absence never resolves
// a finding when the summary says its scanner did not run.
//
// Nothing calls this once the migration has applied — the RPCs exist and the
// webhook uses them. Delete this module with the next migration that drops
// the per-scan unique constraint.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesInsert } from "@/integrations/supabase/types";
import { asJson } from "@/lib/json-cast";
import {
  FULL_TREE_KINDS,
  canAutoResolve,
  carryForwardState,
  countOpenBySeverity,
  earliestTimestamp,
  mostDecisiveState,
} from "@/lib/codex-finding-state";
import { eligibleScanners, type ScanSummaryLike } from "@/lib/codex-finding-lifecycle";

export type LegacyJob = {
  id: string;
  clone_id: string | null;
  target_kind: string;
  repo_full_name: string;
  kind: string;
};

export type IncomingFinding = {
  id: string;
  fingerprint?: string | null;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  description?: string | null;
  file?: string | null;
  line?: number | null;
  cwe?: string | null;
  cvss?: number | null;
  auto_fix_confidence?: number | null;
  scanner?: string | null;
  rule_id?: string | null;
  snippet?: string | null;
  raw?: Record<string, unknown>;
};

const admin = supabaseAdmin;

export async function legacyIngestFindings(
  job: LegacyJob,
  incoming: IncomingFinding[],
): Promise<{ ok: true; regressions: number } | { ok: false; error: string }> {
  if (!incoming.length) return { ok: true, regressions: 0 };
  const nowIso = new Date().toISOString();
  const fingerprints = incoming.map((f) => f.fingerprint || f.id);

  const priorQuery = admin
    .from("codex_findings")
    .select("fingerprint, state, first_seen_at")
    .in("fingerprint", fingerprints)
    .neq("scan_job_id", job.id);
  if (job.clone_id) priorQuery.eq("clone_id", job.clone_id);
  else priorQuery.is("clone_id", null);
  const { data: prior, error: priorErr } = await priorQuery;
  // Without prior verdicts every dismissal would be undone; refuse and let
  // the sender retry instead.
  if (priorErr) return { ok: false, error: priorErr.message };

  const priorByFingerprint = new Map<
    string,
    { state: string | null; first_seen_at: string | null }
  >();
  for (const p of prior ?? []) {
    if (!p.fingerprint) continue;
    const existing = priorByFingerprint.get(p.fingerprint);
    priorByFingerprint.set(p.fingerprint, {
      state: mostDecisiveState(existing?.state, p.state),
      first_seen_at: earliestTimestamp(existing?.first_seen_at, p.first_seen_at),
    });
  }

  let regressions = 0;
  const rows = incoming.map((f) => {
    const fingerprint = f.fingerprint || f.id;
    const previous = priorByFingerprint.get(fingerprint);
    const carried = carryForwardState(previous?.state);
    if (carried.regression) regressions += 1;
    return {
      scan_job_id: job.id,
      clone_id: job.clone_id,
      codex_finding_id: f.id,
      fingerprint,
      title: f.title.slice(0, 500),
      severity: f.severity,
      state: carried.state,
      description: f.description ?? null,
      affected_file: f.file ?? null,
      affected_line: f.line ?? null,
      cwe: f.cwe ?? null,
      cvss: f.cvss ?? null,
      auto_fix_confidence: f.auto_fix_confidence ?? null,
      scanner: f.scanner ?? null,
      rule_id: f.rule_id ?? null,
      snippet: f.snippet ?? null,
      source_slug: "codex",
      first_seen_at: previous?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
      raw: f.raw ?? {},
    };
  });

  const { error: upsertErr } = await admin
    .from("codex_findings")
    .upsert(rows as unknown as TablesInsert<"codex_findings">[], {
      onConflict: "scan_job_id,codex_finding_id",
    });
  if (upsertErr) return { ok: false, error: upsertErr.message };
  return { ok: true, regressions };
}

export async function legacyFinalizeScan(
  job: LegacyJob,
  summaryIn: ScanSummaryLike & Record<string, unknown>,
  engine: string | undefined,
): Promise<{ ok: true; summary: Record<string, unknown> } | { ok: false; error: string }> {
  const nowIso = new Date().toISOString();
  const { data: stored, error: storedErr } = await admin
    .from("codex_findings")
    .select("fingerprint, severity, state, scanner")
    .eq("scan_job_id", job.id);
  if (storedErr) return { ok: false, error: storedErr.message };

  const counts = countOpenBySeverity(stored ?? []);
  const currentFingerprints = new Set<string>();
  for (const f of stored ?? []) if (f.fingerprint) currentFingerprints.add(f.fingerprint);

  // Absence counts only for scanners that actually ran.
  const eligible = new Set(eligibleScanners(summaryIn));
  let autoResolved = 0;
  if (canAutoResolve(job.kind) && eligible.size > 0) {
    const previousQuery = admin
      .from("codex_scan_jobs")
      .select("id")
      .eq("repo_full_name", job.repo_full_name)
      .eq("target_kind", job.target_kind)
      .in(
        "kind",
        Array.from(FULL_TREE_KINDS) as Array<"manual" | "nightly_full" | "post_merge_revalidate">,
      )
      .eq("status", "completed")
      .neq("id", job.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (job.clone_id) previousQuery.eq("clone_id", job.clone_id);
    else previousQuery.is("clone_id", null);
    const { data: previous, error: prevErr } = await previousQuery;
    if (prevErr) return { ok: false, error: prevErr.message };

    const previousJobId = previous?.[0]?.id;
    if (previousJobId) {
      const { data: stale, error: staleErr } = await admin
        .from("codex_findings")
        .select("id, fingerprint, scanner")
        .eq("scan_job_id", previousJobId)
        .in("state", ["open", "triaging"]);
      if (staleErr) return { ok: false, error: staleErr.message };

      const goneIds = (stale ?? [])
        .filter(
          (f) =>
            f.fingerprint &&
            !currentFingerprints.has(f.fingerprint) &&
            f.scanner != null &&
            eligible.has(f.scanner) &&
            // A credential removed from the files is still leaked.
            f.scanner !== "gitleaks",
        )
        .map((f) => f.id);
      if (goneIds.length) {
        const { error: resolveErr } = await admin
          .from("codex_findings")
          .update({ state: "resolved", resolved_at: nowIso })
          .in("id", goneIds);
        if (resolveErr) return { ok: false, error: resolveErr.message };
        autoResolved = goneIds.length;
      }
    }
  }

  const summary = {
    ...summaryIn,
    ...counts,
    open_total: Object.values(counts).reduce((a, b) => a + b, 0),
    auto_resolved: autoResolved,
    confirmed_fixes: 0,
    engine: engine ?? "github_actions",
    ingest_path: "legacy",
  };

  const { error: jobErr } = await admin
    .from("codex_scan_jobs")
    .update({ status: "completed", completed_at: nowIso, result_summary: asJson(summary) })
    .eq("id", job.id);
  if (jobErr) return { ok: false, error: jobErr.message };
  return { ok: true, summary };
}
