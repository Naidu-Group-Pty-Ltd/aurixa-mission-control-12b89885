import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import {
  ShieldAlert,
  PlayCircle,
  RefreshCw,
  GitPullRequest,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Activity,
} from "lucide-react";
import { getCodexEngineHealth } from "@/lib/codex-engine-health.functions";
import {
  compareRulesets,
  normalizeRuleset,
  readScannerCounts,
  readSemgrepRuleset,
  readSuppressionChanges,
} from "@/lib/codex-scan-provenance";
import { summarizeVerification } from "@/lib/codex-finding-state";
import {
  enqueueScan,
  listScanJobs,
  getScanDetail,
  getSchedulingConfig,
  updateSchedulingConfig,
  runNightlyNow,
  setNightlySchedule,
  rotateScanSigningKey,
  protectPrimeMainNow,
} from "@/lib/codex-security.functions";
import {
  CodexFindingsExplorer,
  type FindingsScope,
} from "@/components/security/codex-findings-explorer";
import { PrimePostureCard } from "@/components/security/prime-posture-card";
import { FIX_ENGINE_LABEL, isFixEngine } from "@/lib/codex-autofix-policy";
import { SCAN_POLICY_SUMMARY } from "@/lib/codex-scan-policy";
import { degradedScanners } from "@/lib/codex-finding-lifecycle";
import { reportedWorkflowVersion } from "@/lib/codex-workflow-contract";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { draftRemediationPR, listRemediations } from "@/lib/codex-remediation.functions";

import { ProtectedRoute } from "@/components/protected-route";
import { useConfirm } from "@/components/confirm-dialog";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";

type ScansSearch = { job?: string; overdue?: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/security/scans")({
  // `?job=<id>` opens that scan — the PR check's "Details" link lands here.
  // `?overdue=1` opens the findings explorer on overdue findings — the daily
  // digest notification links there.
  validateSearch: (s: Record<string, unknown>): ScansSearch => ({
    job: typeof s.job === "string" && UUID.test(s.job) ? s.job : undefined,
    overdue: s.overdue === true || s.overdue === 1 || s.overdue === "1" ? true : undefined,
  }),
  component: () => (
    <ProtectedRoute>
      <AppShell>
        <CodexScansPage />
      </AppShell>
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Codex Security Scans — Aurixa Systems" }] }),
});

const sevColor: Record<string, string> = {
  critical: "bg-red-600",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-blue-500",
  info: "bg-slate-500",
};

function CodexScansPage() {
  const qc = useQueryClient();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/security/scans" });
  const openJob = search.job ?? null;
  const setOpenJob = (job: string | null) =>
    navigate({ search: (prev: ScansSearch) => ({ ...prev, job: job ?? undefined }) });
  const [findingsScope, setFindingsScope] = useState<FindingsScope>("all");
  const findingsRef = useRef<HTMLDivElement>(null);
  const jobsQ = useQuery({
    queryKey: ["codex-scan-jobs"],
    queryFn: () => listScanJobs(),
    refetchInterval: 15000,
  });
  const enqueue = useServerFn(enqueueScan);
  const runScan = useMutation({
    mutationFn: () => enqueue({ data: { kind: "manual", targetKind: "prime" } }),
    onSuccess: (r: any) => {
      if (r?.dispatchError) {
        // The job exists and the sweeper will retry, but the operator needs
        // to see why the first attempt bounced.
        toast.warning(`Scan queued, but dispatch failed: ${r.dispatchError}`);
      } else {
        toast.success("Scan queued");
      }
      qc.invalidateQueries({ queryKey: ["codex-scan-jobs"] });
      qc.invalidateQueries({ queryKey: ["codex-engine-health"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        eyebrow="security"
        icon={<ShieldAlert className="h-6 w-6 text-primary" />}
        title="Scans & Findings"
        description={`Gitleaks, semgrep, osv-scanner and a Codex reasoning pass, run in GitHub Actions. ${SCAN_POLICY_SUMMARY} Findings are fixed by Claude (P0/P1) or Codex (P2 and below), and every fix merges by itself once its checks pass.`}
        actions={
          <>
            <Button variant="outline" onClick={() => jobsQ.refetch()}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
            <Button onClick={() => runScan.mutate()} disabled={runScan.isPending}>
              <PlayCircle className="h-4 w-4 mr-1" />
              {runScan.isPending ? "Queuing…" : "Scan Prime Now"}
            </Button>
          </>
        }
      />

      <EngineHealthPanel />

      <PrimePostureCard
        onShowFindings={() => {
          setFindingsScope("prime");
          findingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onOpenScan={(jobId) => setOpenJob(jobId)}
      />

      <FixesInFlight />

      <div ref={findingsRef}>
        <CodexFindingsExplorer
          scope={findingsScope}
          onScopeChange={setFindingsScope}
          initialOverdue={search.overdue === true}
        />
      </div>

      <SchedulingPanel />

      <Card>
        <CardHeader>
          <CardTitle>Recent scans</CardTitle>
          <CardDescription>
            The last 100 scans. Prime is scanned nightly; clone rows are from before clones stopped
            being scanned.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobsQ.data?.jobs ?? []).map((j: any) => (
                <TableRow key={j.id}>
                  <TableCell className="font-mono text-xs">{j.repo_full_name}</TableCell>
                  <TableCell>{j.kind}</TableCell>
                  <TableCell>
                    <Badge variant={j.status === "failed" ? "destructive" : "outline"}>
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {j.started_at?.slice(0, 19).replace("T", " ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {j.completed_at?.slice(0, 19).replace("T", " ") || "—"}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setOpenJob(j.id)}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!jobsQ.isLoading && (jobsQ.data?.jobs ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No scans yet. Trigger one to get started.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Sheet open={!!openJob} onOpenChange={(v) => !v && setOpenJob(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {openJob && <ScanDetail jobId={openJob} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ScanDetail({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["codex-scan-detail", jobId],
    queryFn: () => getScanDetail({ data: { jobId } }),
    refetchInterval: 10000,
  });
  const remQ = useQuery({
    queryKey: ["codex-remediations", jobId],
    queryFn: () => listRemediations({ data: { jobId } }),
    refetchInterval: 10000,
  });
  const draftFn = useServerFn(draftRemediationPR);
  const draft = useMutation({
    mutationFn: (findingId: string) => draftFn({ data: { findingId } }),
    onSuccess: (r: any) => {
      toast.success(r?.reused ? "Existing remediation reused" : "Draft fix PR dispatched");
      qc.invalidateQueries({ queryKey: ["codex-remediations", jobId] });
      qc.invalidateQueries({ queryKey: ["codex-scan-detail", jobId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const d = q.data;
  const remByFinding: Record<string, any> = {};
  for (const r of remQ.data?.remediations ?? []) {
    if (!remByFinding[r.finding_id]) remByFinding[r.finding_id] = r;
  }
  return (
    <div className="space-y-4">
      <SheetHeader>
        <SheetTitle>Scan Detail</SheetTitle>
      </SheetHeader>
      {!d?.job ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <>
          <ScanSummary job={d.job} source={(d as any).source} previousRules={d.previousRules} />
          <div>
            <h3 className="font-semibold mb-2">Findings this scan saw ({d.findings.length})</h3>
            {d.findings.length > 0 && <RemediationExplainer />}
            <div className="space-y-2">
              {d.findings.map((f: any) => {
                const rem = remByFinding[f.id];
                // A finding only on a pull request is fixed in that PR, and a
                // decided one has nothing to fix — the server refuses both.
                const fixable =
                  !f.pr_number && !["resolved", "dismissed", "false_positive"].includes(f.state);
                const canDraft = fixable && (!rem || ["failed", "closed"].includes(rem.status));
                return (
                  <div key={f.id} className="border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${sevColor[f.severity]}`}
                      />
                      <span className="font-medium">{f.title}</span>
                      <Badge variant="outline" className="ml-auto">
                        {f.state}
                      </Badge>
                    </div>
                    {f.affected_file && (
                      <div className="text-xs font-mono text-muted-foreground">
                        {f.affected_file}
                        {f.affected_line ? `:${f.affected_line}` : ""}
                      </div>
                    )}
                    {f.description && <p className="text-xs">{f.description}</p>}
                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      <Button
                        size="sm"
                        variant={canDraft ? "default" : "outline"}
                        onClick={() => draft.mutate(f.id)}
                        disabled={draft.isPending || !canDraft}
                      >
                        <GitPullRequest className="h-3 w-3 mr-1" />
                        {!fixable
                          ? f.pr_number
                            ? "Fix it in its PR"
                            : f.state.replace("_", " ")
                          : rem
                            ? canDraft
                              ? "Retry Fix PR"
                              : "Fix in flight"
                            : "Draft Fix PR"}
                      </Button>
                      {rem && (
                        <Badge variant="outline" className="text-[10px]">
                          rem: {rem.status}
                        </Badge>
                      )}
                      {rem?.pr_url && (
                        <a
                          href={rem.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs inline-flex items-center gap-1 text-blue-500 hover:underline"
                        >
                          PR #{rem.pr_number} <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {rem?.workflow_run_url && (
                        <a
                          href={rem.workflow_run_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs inline-flex items-center gap-1 text-muted-foreground hover:underline"
                        >
                          run <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {rem?.last_error && (
                        <span className="text-[10px] text-red-500">{rem.last_error}</span>
                      )}
                    </div>
                    {rem && <RemediationEvidence remediation={rem} />}
                    {rem && <AutoMergeNote remediation={rem} />}
                  </div>
                );
              })}
              {d.findings.length === 0 && (
                <p className="text-xs text-muted-foreground">No findings recorded yet.</p>
              )}
            </div>
          </div>
          <div>
            <h3 className="font-semibold mb-2">Event log</h3>
            <div className="text-xs font-mono space-y-1 max-h-64 overflow-y-auto">
              {d.events.map((e: any) => (
                <div key={e.id} className="break-words">
                  <span className="text-muted-foreground">
                    {e.created_at.slice(0, 19).replace("T", " ")}
                  </span>{" "}
                  {e.event_type}
                  {eventNote(e) && <span className="text-muted-foreground"> — {eventNote(e)}</span>}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Every security fix in flight, in one place: what wrote it, where its PR
 * is, and what happens to it next. Nothing here waits on a person — a fix
 * merges by itself once its checks pass, or is closed.
 */
function FixesInFlight() {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["codex-remediations", "in-flight"],
    queryFn: () => listRemediations({ data: { inFlight: true } }),
    refetchInterval: 30_000,
  });
  const rows: any[] = q.data?.remediations ?? [];
  if (q.isLoading) return null;
  return (
    <Card id="fix-prs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4" /> Fixes in flight
          <Badge variant="outline">{rows.length}</Badge>
        </CardTitle>
        <CardDescription>
          Written by Claude for P0/P1 findings and by Codex for P2 and below, after each nightly
          scan. Each PR merges by itself once its checks and the repository&apos;s CI pass on it —
          or is closed and retried on a later night — and the cascade delivers merged fixes to the
          clones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No fixes in flight.</p>}
        {rows.map((r) => (
          <div key={r.id} className="border p-2 text-xs">
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-2 text-left"
              onClick={() => setOpen(open === r.id ? null : r.id)}
            >
              {r.finding?.severity && (
                <span
                  className={`inline-block h-2 w-2 rounded-full ${sevColor[r.finding.severity]}`}
                />
              )}
              <span className="font-medium">{r.finding?.title ?? "Finding"}</span>
              <Badge variant="outline" className="text-[10px]">
                {isFixEngine(r.engine) ? FIX_ENGINE_LABEL[r.engine] : "Codex"}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {r.status.replace("_", " ")}
              </Badge>
              <span className="ml-auto text-muted-foreground">
                {open === r.id ? "hide" : "details"}
              </span>
            </button>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {r.pr_url && (
                <a
                  href={r.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-500 hover:underline"
                >
                  PR #{r.pr_number} <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {r.finding?.affected_file && (
                <span className="font-mono text-muted-foreground">
                  {r.finding.affected_file}
                  {r.finding.affected_line ? `:${r.finding.affected_line}` : ""}
                </span>
              )}
            </div>
            <AutoMergeNote remediation={r} />
            {open === r.id && <RemediationEvidence remediation={r} />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** The one detail of an event worth a line in the log. */
function eventNote(e: any): string {
  const p = e.payload ?? {};
  if (p.error) return String(p.error).slice(0, 200);
  if (p.batch && typeof p.count === "number")
    return `batch ${p.batch.index + 1}/${p.batch.count}, ${p.count} finding(s)`;
  if (typeof p.count === "number") return `${p.count}`;
  if (p.signature === "legacy") return "signed without a timestamp (older workflow)";
  return "";
}

const scannerTone: Record<string, string> = {
  ok: "border-emerald-500/40 text-emerald-500",
  failed: "border-red-500/40 text-red-500",
  skipped: "text-muted-foreground",
};

/**
 * What a scan actually was: where it ran, against what, which scanners
 * worked, and whether its results were complete. The drawer used to show a
 * repository name and a status, so a scan whose scanners had all failed read
 * exactly like a clean one.
 */
function ScanSummary({
  job,
  source,
  previousRules,
}: {
  job: any;
  source?: string;
  previousRules?: { jobId: string; completedAt: string | null; semgrep: unknown } | null;
}) {
  const s = job.result_summary ?? null;
  const scanners: Record<string, any> = s?.scanners ?? {};
  const version = s ? reportedWorkflowVersion(s) : null;
  const degraded = s ? degradedScanners(s) : [];
  const suppressed = s?.suppressions ?? null;
  const controlChanges = readSuppressionChanges(s);
  const perScanner = readScannerCounts(s);
  const ts = (v?: string | null) => (v ? v.slice(0, 19).replace("T", " ") : "—");
  return (
    <div className="space-y-2 text-xs">
      <div className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Repository</span>
        <span className="font-mono break-all">{job.repo_full_name}</span>
        <span className="text-muted-foreground">Kind</span>
        <span>
          {job.kind}
          {s?.scope?.mode ? ` · ${s.scope.mode} scope` : ""}
          {s?.scope?.files ? ` (${s.scope.files} file${s.scope.files === 1 ? "" : "s"})` : ""}
        </span>
        <span className="text-muted-foreground">Status</span>
        <span>{job.status}</span>
        <span className="text-muted-foreground">Commit</span>
        <span className="font-mono break-all">
          {job.ref ?? "default branch"}
          {s?.head_sha && s.head_sha !== job.ref ? ` @ ${s.head_sha.slice(0, 12)}` : ""}
          {s?.base_sha ? ` (compared with ${s.base_sha.slice(0, 12)})` : ""}
        </span>
        <span className="text-muted-foreground">Started / completed</span>
        <span>
          {ts(job.started_at)} / {ts(job.completed_at)}
        </span>
        {job.workflow_run_url && (
          <>
            <span className="text-muted-foreground">Run</span>
            <a
              href={job.workflow_run_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-blue-500 hover:underline"
            >
              GitHub Actions run <ExternalLink className="h-3 w-3" />
            </a>
          </>
        )}
        {version != null && (
          <>
            <span className="text-muted-foreground">Workflow</span>
            <span>
              version {version}
              {s?.signature_scheme === "legacy" ? " · signed without a timestamp" : ""}
            </span>
          </>
        )}
      </div>
      {job.last_error && <div className="text-red-500 whitespace-pre-wrap">{job.last_error}</div>}
      {s?.incomplete === true && (
        <div className="border border-amber-500/40 bg-amber-500/5 p-2">
          Results incomplete: {s.observed ?? 0} of {s.expected ?? "?"} findings arrived
          {s.callback_failures
            ? `, and ${s.callback_failures} report batch(es) were not delivered`
            : ""}
          . Nothing was resolved by its absence.
        </div>
      )}
      {Object.keys(scanners).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(scanners).map(([name, r]) => {
            const status =
              (version ?? 1) >= 2
                ? String(r?.status ?? "failed")
                : r?.ok === false
                  ? r?.skipped
                    ? "skipped"
                    : "failed"
                  : "reported";
            return (
              <Badge
                key={name}
                variant="outline"
                className={`text-[10px] ${scannerTone[status] ?? ""}`}
                title={r?.reason ?? undefined}
              >
                {name}: {status}
                {typeof r?.count === "number" ? ` (${r.count})` : ""}
              </Badge>
            );
          })}
        </div>
      )}
      {degraded.length > 0 && (
        <div className="text-amber-500">
          {degraded.map((d) => `${d.name}: ${d.reason}`).join(" · ")} — a scanner that failed
          resolves nothing by absence.
        </div>
      )}
      {s && (s.auto_resolved > 0 || s.confirmed_fixes > 0 || s.absent_secrets > 0) && (
        <div className="text-muted-foreground">
          {s.auto_resolved > 0 && `${s.auto_resolved} resolved (no longer reported) · `}
          {s.confirmed_fixes > 0 && `${s.confirmed_fixes} merged fix(es) confirmed · `}
          {s.absent_secrets > 0 &&
            `${s.absent_secrets} secret(s) gone from the files — still to rotate`}
        </div>
      )}
      {perScanner.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          {perScanner.map(({ scanner, counts }) => (
            <span key={scanner}>
              <span className="font-mono">{scanner}</span>:{" "}
              {(["critical", "high", "medium", "low", "info"] as const)
                .filter((sev) => counts[sev] > 0)
                .map((sev) => `${counts[sev]} ${sev}`)
                .join(" · ")}
            </span>
          ))}
        </div>
      )}
      <RulesetNote summary={s} previous={previousRules ?? null} />
      {controlChanges && (
        <div className="border border-amber-500/40 bg-amber-500/5 p-2">
          <div className="font-medium">This change edits what the scanners ignore</div>
          {controlChanges.changed.length > 0 && (
            <>
              <ul className="mt-1 list-disc pl-4 font-mono">
                {controlChanges.changed.map((c) => (
                  <li key={c.path}>
                    {c.change} {c.path}
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-muted-foreground">
                This scan used the base branch&apos;s copies; the edits apply to every scan after it
                merges.
              </div>
            </>
          )}
          {(controlChanges.semgrepIgnoresAdded > 0 || controlChanges.gitleaksAllowsAdded > 0) && (
            <div className="mt-1">
              Adds inline suppressions —{" "}
              {[
                controlChanges.semgrepIgnoresAdded > 0
                  ? `semgrep will skip ${controlChanges.semgrepIgnoresAdded} more line(s)`
                  : null,
                controlChanges.gitleaksAllowsAdded > 0
                  ? `gitleaks will skip ${controlChanges.gitleaksAllowsAdded} more line(s)`
                  : null,
              ]
                .filter(Boolean)
                .join(", ")}
              . They are part of the code, so they hid findings from this scan too.
            </div>
          )}
        </div>
      )}
      {suppressed &&
        ((suppressed.files ?? []).length > 0 ||
          suppressed.nosemgrep > 0 ||
          suppressed.gitleaks_allow > 0) && (
          <div className="text-muted-foreground">
            The repository tells the scanners to ignore:{" "}
            {(suppressed.files ?? []).map((f: any) => f.path).join(", ") || "—"}
            {suppressed.nosemgrep > 0
              ? `; semgrep skips ${suppressed.nosemgrep} line(s) marked to ignore`
              : ""}
            {suppressed.gitleaks_allow > 0
              ? `; gitleaks skips ${suppressed.gitleaks_allow} line(s) marked to allow`
              : ""}
          </div>
        )}
      {source === "first_reported" && (
        <div className="text-muted-foreground">
          Showing the findings this scan reported first. Migration 20261018090000 records every scan
          that sees a finding.
        </div>
      )}
    </div>
  );
}

/**
 * Which semgrep rules this scan ran, and whether they were the ones the
 * previous scan of the same repository ran. Registry packs move between
 * nights, so the same code can gain or lose findings with no commit at all.
 */
function RulesetNote({
  summary,
  previous,
}: {
  summary: unknown;
  previous: { jobId: string; completedAt: string | null; semgrep: unknown } | null;
}) {
  const current = readSemgrepRuleset(summary);
  if (!current) return null;
  const cmp = compareRulesets(current, normalizeRuleset(previous?.semgrep));
  const when = previous?.completedAt ? previous.completedAt.slice(0, 10) : null;
  const source =
    current.source === "vendored"
      ? `rules committed in the repository${current.ref ? ` (read at ${current.ref.slice(0, 12)})` : ""}`
      : current.source === "registry"
        ? "registry packs, downloaded and hashed"
        : current.source === "registry-unrecorded"
          ? "registry packs — a download failed, so not every rule was hashed"
          : current.source;
  return (
    <div className="text-muted-foreground">
      Semgrep ran {source} · <span className="font-mono">{current.digest}</span>
      {cmp.status === "same" && (
        <> · the same rules as the previous scan{when ? ` (${when})` : ""}</>
      )}
      {cmp.status === "changed" && (
        <div className="text-amber-500">
          The rules changed since the previous scan{when ? ` (${when})` : ""}:{" "}
          {[
            cmp.added.length ? `${cmp.added.length} added` : null,
            cmp.removed.length ? `${cmp.removed.length} removed` : null,
            cmp.modified.length ? `${cmp.modified.length} changed` : null,
            cmp.sourceChanged ? "a different source" : null,
          ]
            .filter(Boolean)
            .join(", ") || "different content"}
          {[...cmp.modified, ...cmp.added, ...cmp.removed].length > 0 &&
            ` (${[...cmp.modified, ...cmp.added, ...cmp.removed].slice(0, 4).join(", ")})`}
          . New or vanished semgrep findings may come from the rules, not the code.
        </div>
      )}
      {cmp.status === "unknown" && <> · not compared: {cmp.reason}</>}
    </div>
  );
}

/**
 * Spells out what "Draft Fix PR" actually does. Operators were being asked
 * to trigger autonomous code changes against production repositories with
 * no in-product statement of what writes the code or what stops it.
 */
function RemediationExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 border bg-muted/20 p-2 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left font-medium"
      >
        <GitPullRequest className="h-3 w-3" />
        How a finding gets fixed
        <span className="ml-auto text-muted-foreground">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>
            After each nightly scan of Prime, Mission Control dispatches{" "}
            <code>codex-remediation.yml</code> on Prime for the open findings, worst first, up to
            the nightly limit. &ldquo;Draft Fix PR&rdquo; starts one now. It never edits code
            itself.
          </li>
          <li>
            On that runner, <strong>Claude</strong> writes the fix for a P0 or P1 finding (critical,
            high) and the <strong>OpenAI Codex CLI</strong> for P2 and below, info included. Either
            may only read and edit files in the checkout, with no network; it is given the title,
            severity, file, line, CWE and the offending code excerpt. When the fix changes{" "}
            <code>package.json</code>, the lockfiles are regenerated without running any install
            script.
          </li>
          <li>
            The patch is measured and refused if it touches CI, package-manager, git or agent
            configuration, changes <code>package.json</code> scripts, adds a package the project did
            not use or installs one from somewhere new, or silences a scanner. The lines it adds are
            scanned with gitleaks.
            <strong> A patch that introduces a secret is never pushed.</strong>
          </li>
          <li>
            The repo&apos;s own checks — install, typecheck, lint, test, build, whichever exist —
            run against the base plus the patch, exactly the tree that is committed, as a user of
            their own. A fix that fails them is not pushed. Neither the agent nor those checks ever
            hold a push token.
          </li>
          <li>
            A pull request is opened. Mission Control runs the repository&apos;s CI (
            <code>ci.yml</code>) on it and it <strong>merges by itself</strong> once that passes on
            the commit that was checked, provided the patch stays within the size bounds. Otherwise
            it is closed and the finding retried on a later night. No person reviews it, by policy.
          </li>
          <li>
            The merge on Prime cascades to every clone, and the next nightly scan confirms the
            finding is gone — or reopens it as &ldquo;fix ineffective&rdquo;. Committed credentials
            are not fixed automatically: they must be rotated.
          </li>
        </ol>
      )}
    </div>
  );
}

/**
 * What produced this patch and whether it holds up. Reviewers were
 * previously asked to approve a PR link with no visibility into what wrote
 * it, whether the patched tree still builds, or how much it touched.
 */
function RemediationEvidence({ remediation: rem }: { remediation: any }) {
  const v = rem.verification ?? {};
  const checks: any[] = Array.isArray(v.checks) ? v.checks : [];
  const ran = checks.filter((c) => !c.skipped);
  const { failed } = summarizeVerification(v);
  const hasRadius = rem.files_changed != null;

  // Nothing reported back yet (still dispatching, or a pre-migration row).
  if (!hasRadius && checks.length === 0 && rem.verified == null) return null;

  return (
    <div className="mt-2 space-y-1 border bg-muted/20 p-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-muted-foreground">
          patched by{" "}
          <span className="font-mono text-foreground">
            {rem.engine === "claude_code"
              ? "Claude (Claude Code)"
              : rem.engine === "codex_cli"
                ? "OpenAI Codex CLI"
                : (rem.engine ?? "unknown")}
          </span>
        </span>
        {hasRadius && (
          <span className="text-muted-foreground">
            {rem.files_changed} file{rem.files_changed === 1 ? "" : "s"}{" "}
            <span className="text-emerald-500">+{rem.lines_added ?? 0}</span>{" "}
            <span className="text-red-500">-{rem.lines_removed ?? 0}</span>
          </span>
        )}
        {v.secrets_clean === true && (
          <Badge variant="outline" className="text-[9px] border-emerald-500/40 text-emerald-500">
            no secrets
          </Badge>
        )}
        {v.secrets_clean === false && (
          <Badge variant="destructive" className="text-[9px]">
            secret leak — not pushed
          </Badge>
        )}
        {rem.verified === true && (
          <Badge className="bg-emerald-600 text-[9px]">checks passing</Badge>
        )}
        {rem.verified === false && (
          <Badge variant="destructive" className="text-[9px]">
            checks failing
          </Badge>
        )}
        {rem.fix_confirmed_at && (
          <Badge
            className="bg-blue-600 text-[9px]"
            title="A later full scan no longer reports this finding"
          >
            fix confirmed by re-scan
          </Badge>
        )}
      </div>

      {ran.length > 0 && (
        <div className="flex flex-wrap gap-2 text-muted-foreground">
          {ran.map((c) => (
            <span key={c.name} className={c.ok ? "text-emerald-500" : "text-red-500"}>
              {c.ok ? "✓" : "✗"} {c.name}
            </span>
          ))}
        </div>
      )}

      {failed.length > 0 && failed[0].detail && (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words border border-destructive/20 bg-destructive/5 p-1 font-mono text-[10px] text-destructive">
          {failed[0].detail.slice(-600)}
        </pre>
      )}

      {rem.verified === false && (
        <p className="text-muted-foreground">
          The checks failed on the patched tree, so this fix does not merge.
        </p>
      )}
    </div>
  );
}

/**
 * What happens to a fix PR next. There is no review: it merges by itself
 * once its checks pass, or is closed (src/lib/remediation-policy.ts).
 */
function AutoMergeNote({ remediation: rem }: { remediation: any }) {
  const engine = isFixEngine(rem.engine) ? FIX_ENGINE_LABEL[rem.engine] : "Codex";
  let text: string;
  let tone = "text-muted-foreground";
  if (rem.status === "merged") {
    text = `Merged by itself${rem.merged_at ? ` at ${String(rem.merged_at).slice(0, 16).replace("T", " ")}` : ""}; the cascade delivers it to the clones.`;
  } else if (rem.status === "closed" || rem.status === "rejected") {
    text = rem.last_error ?? "Closed without merging; the finding is retried on a later night.";
    tone = "text-amber-500";
  } else if (rem.status === "failed") {
    text = rem.last_error ?? `${engine} could not produce a fix.`;
    tone = "text-red-500";
  } else if (!rem.pr_number) {
    text = `${engine} is writing the fix in GitHub Actions.`;
  } else if (rem.verified === false) {
    text = "Its checks failed: it will be closed and the finding retried on a later night.";
    tone = "text-amber-500";
  } else if (String(rem.merge_run?.last_error ?? "").startsWith("waiting: ")) {
    // The merge lane started the repository's CI on the fix and is waiting
    // for it (fixCiGate.pure.ts).
    text = `Waiting for CI — ${String(rem.merge_run.last_error).slice(9)}. Merges by itself once it passes.`;
  } else {
    text =
      "Merges by itself once the repository's CI passes on it — Mission Control starts the run. " +
      "No review needed.";
  }
  return (
    <p className={`mt-1 text-[11px] ${tone}`}>
      {text}
      {rem.cascade_event_id && (
        <>
          {" "}
          <a
            href={`/cascades/${rem.cascade_event_id}`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            cascade →
          </a>
        </>
      )}
    </p>
  );
}

const healthIcon: Record<string, ReactElement> = {
  ok: <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />,
  warn: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
  fail: <XCircle className="h-4 w-4 text-red-500 shrink-0" />,
};

/**
 * Engine health. Every reason the pipeline can silently stop running —
 * missing secret, missing GitHub App permission, workflow file never copied
 * into the target repo — surfaces here with the exact fix, instead of the
 * operator staring at an empty job table.
 */
function EngineHealthPanel() {
  const confirm = useConfirm();
  const healthQ = useQuery({
    queryKey: ["codex-engine-health"],
    queryFn: () => getCodexEngineHealth(),
    // Several checks read GitHub; once every five minutes is plenty for a
    // panel whose inputs change on deploys, not by the second.
    refetchInterval: 5 * 60_000,
  });
  const rotateFn = useServerFn(rotateScanSigningKey);
  const rotate = useMutation({
    mutationFn: () => rotateFn({}),
    onSuccess: (r: any) => {
      toast.success(
        `Signing key rotated. Scans already running keep reporting for ${r.graceHours} hours.`,
      );
      healthQ.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const protectFn = useServerFn(protectPrimeMainNow);
  const protect = useMutation({
    mutationFn: () => protectFn({}),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.detail);
      else toast.error(r.fix ? `${r.detail} ${r.fix}` : r.detail);
      healthQ.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const checks = healthQ.data?.checks ?? [];
  const summary = healthQ.data?.summary;
  const problems = checks.filter((c: any) => c.status !== "ok");

  if (healthQ.isLoading) return null;
  if (healthQ.isError) {
    return (
      <Card className="border-red-500/40">
        <CardHeader>
          <CardTitle className="text-base">Engine health unavailable</CardTitle>
          <CardDescription>{(healthQ.error as Error)?.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const healthy = summary?.healthy && problems.length === 0;

  return (
    <Card className={healthy ? undefined : "border-amber-500/40"}>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Engine health
            {healthy ? (
              <Badge className="bg-emerald-600">operational</Badge>
            ) : summary?.failing ? (
              <Badge variant="destructive">{summary.failing} blocking</Badge>
            ) : (
              <Badge variant="outline" className="text-amber-500 border-amber-500/40">
                {summary?.warnings ?? problems.length} warning
                {(summary?.warnings ?? problems.length) === 1 ? "" : "s"}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Engine: <span className="font-mono">{summary?.engine}</span>
            {summary?.last24h && Object.keys(summary.last24h).length > 0 && (
              <>
                {" · "}last 24h:{" "}
                {Object.entries(summary.last24h)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(", ")}
              </>
            )}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          {summary?.branchProtectionApplicable && (
            <Button
              size="sm"
              variant="outline"
              disabled={protect.isPending}
              title="Create or repair the ruleset that protects Prime's default branch"
              onClick={async () => {
                const ok = await confirm({
                  title: "Protect Prime's main branch now?",
                  description:
                    "Mission Control's GitHub App creates or repairs the ruleset “Mission Control: protect the default branch”: changes reach main only through pull requests whose two CI jobs passed. Lovable and repository admins can still push directly. Auto-merge is switched on for the repository so the digest refresh can land itself. Tonight's run does the same if you leave it.",
                  confirmText: "Protect main",
                });
                if (ok) protect.mutate();
              }}
            >
              {protect.isPending ? "Protecting…" : "Protect main now"}
            </Button>
          )}
          {summary?.signingKeyRotatable && (
            <Button
              size="sm"
              variant="outline"
              disabled={rotate.isPending}
              title="New scans and fixes get keys derived from a new master"
              onClick={async () => {
                const ok = await confirm({
                  title: "Rotate the callback signing key?",
                  description:
                    "Every scan and fix dispatched from now on signs with keys derived from a new master. Scans already running keep reporting under the old one for its grace window. Do this after every repository runs workflow version 2 or later: older copies printed the old key in their Actions logs.",
                  confirmText: "Rotate",
                });
                if (ok) rotate.mutate();
              }}
            >
              {rotate.isPending ? "Rotating…" : "Rotate signing key"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => healthQ.refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Re-check
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Healthy checks collapse to a single line; problems stay expanded. */}
        {problems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All {checks.length} checks passing — scans dispatch, authenticate, and report back.
          </p>
        ) : (
          problems.map((c: any) => (
            <div key={c.key} className="flex gap-2 border p-3">
              {healthIcon[c.status]}
              <div className="space-y-1 min-w-0">
                <div className="text-sm font-medium">{c.label}</div>
                <div className="text-xs text-muted-foreground break-words">{c.detail}</div>
                {c.fix && <div className="text-xs break-words">{c.fix}</div>}
              </div>
            </div>
          ))
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
          {checks
            .filter((c: any) => c.status === "ok")
            .map((c: any) => (
              <span key={c.key} className="inline-flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                {c.label}
              </span>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SettingSelect({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="border p-3 space-y-2">
      <Label className="font-medium">{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function SchedulingPanel() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const cfgQ = useQuery({
    queryKey: ["codex-scheduling-config"],
    queryFn: () => getSchedulingConfig(),
  });
  const updateFn = useServerFn(updateSchedulingConfig);
  const runNowFn = useServerFn(runNightlyNow);
  const scheduleFn = useServerFn(setNightlySchedule);
  const [dedup, setDedup] = useState<number | null>(null);
  const [cron, setCron] = useState<string | null>(null);
  const [perNight, setPerNight] = useState<number | null>(null);

  const cfg = cfgQ.data?.config;
  const migrated = cfgQ.data?.migrated ?? false;
  const autofixMigrated = cfgQ.data?.autofixMigrated ?? false;

  const save = useMutation({
    mutationFn: (patch: any) => updateFn({ data: patch }),
    onSuccess: () => {
      toast.success("Settings updated");
      qc.invalidateQueries({ queryKey: ["codex-scheduling-config"] });
      qc.invalidateQueries({ queryKey: ["codex-engine-health"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reschedule = useMutation({
    mutationFn: (expr: string) => scheduleFn({ data: { cron: expr } }),
    onSuccess: (r: any) => {
      if (r?.applied) toast.success(`Nightly scans now run at “${r.schedule}” (UTC)`);
      else
        toast.warning(
          `Saved “${r?.schedule}”, but pg_cron was not changed: ${r?.reason ?? "unknown"}`,
        );
      setCron(null);
      qc.invalidateQueries({ queryKey: ["codex-scheduling-config"] });
      qc.invalidateQueries({ queryKey: ["codex-engine-health"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runNow = useMutation({
    mutationFn: () => runNowFn({}),
    onSuccess: (r: any) => {
      if (r.enqueued?.length) toast.success("Prime's nightly scan queued");
      else toast.info(`Not queued: ${r.skipped?.[0]?.reason ?? "unknown"}`);
      qc.invalidateQueries({ queryKey: ["codex-scan-jobs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!cfg) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle>Scheduling and fixes</CardTitle>
          <CardDescription>
            {SCAN_POLICY_SUMMARY} After each nightly scan, Claude fixes P0/P1 findings and Codex
            fixes P2 and below; every fix merges by itself once its checks pass.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => runNow.mutate()}
          disabled={runNow.isPending}
        >
          <PlayCircle className="h-4 w-4 mr-1" />
          {runNow.isPending ? "Queuing…" : "Run nightly scan now"}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="flex items-center justify-between border p-3">
          <div>
            <Label className="font-medium">Nightly scan of Prime</Label>
            <p className="text-xs text-muted-foreground">
              The only scheduled scan. Clones are not scanned; Prime&apos;s fixes reach them through
              the cascade.
            </p>
          </div>
          <Switch
            checked={!!cfg.codex_nightly_enabled}
            onCheckedChange={(v) => save.mutate({ codex_nightly_enabled: v })}
          />
        </div>
        <div className="border p-3 space-y-2">
          <Label className="font-medium">Dedup window (hours)</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              max={168}
              defaultValue={cfg.codex_scan_dedup_hours ?? 6}
              onChange={(e) => setDedup(Number(e.target.value))}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={dedup === null || dedup === cfg.codex_scan_dedup_hours}
              onClick={() => save.mutate({ codex_scan_dedup_hours: dedup })}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A second nightly scan inside this window is skipped.
          </p>
        </div>

        {!autofixMigrated && (
          <p className="md:col-span-2 border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            The automatic-fix settings arrive with migration 20261018120000_codex_autofix_settings.
            Until it is applied, fixes run with their defaults (on, ten a night) and the settings
            cannot be changed.
          </p>
        )}
        <div className="flex items-center justify-between border p-3">
          <div>
            <Label className="font-medium">Automatic fixes</Label>
            <p className="text-xs text-muted-foreground">
              After each nightly scan: Claude for P0/P1, Codex for P2 and below. Fix PRs merge by
              themselves once their checks and the repository&apos;s CI pass — no review. Committed
              credentials are not fixed: they must be rotated.
            </p>
          </div>
          <Switch
            checked={cfg.codex_autofix_enabled !== false}
            disabled={!autofixMigrated}
            onCheckedChange={async (v) => {
              if (v) {
                const ok = await confirm({
                  title: "Fix and merge findings automatically?",
                  description:
                    "After each nightly scan, AI-written fixes are opened against Prime and merged with nobody reviewing them, once the repository's checks and CI pass. Each merge then cascades to every clone.",
                  confirmText: "Turn on",
                  destructive: true,
                });
                if (!ok) return;
              }
              save.mutate({ codex_autofix_enabled: v });
            }}
          />
        </div>
        <div className="border p-3 space-y-2">
          <Label className="font-medium">Fixes per night</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              max={50}
              disabled={!autofixMigrated}
              defaultValue={cfg.codex_autofix_max_per_night ?? 10}
              onChange={(e) => setPerNight(Number(e.target.value))}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={
                !autofixMigrated ||
                perNight === null ||
                perNight === cfg.codex_autofix_max_per_night
              }
              onClick={() => save.mutate({ codex_autofix_max_per_night: perNight })}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Worst first, then oldest. Each fix is an Actions run, model spend and — once merged — a
            cascade, so a large backlog drains over several nights.
          </p>
        </div>

        {!migrated && (
          <p className="md:col-span-2 border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            The settings below arrive with migration 20261018090000_codex_findings_canonical. Until
            it is applied they show their defaults and cannot be changed.
          </p>
        )}
        <SettingSelect
          label="Codex reasoning pass"
          hint="Whether the nightly scan also runs the AI review. Manual scans always do. It spends OpenAI credit on every scan it runs on."
          value={cfg.codex_deep_scan_scope === "off" ? "off" : "prime"}
          disabled={!migrated}
          onChange={(v) => save.mutate({ codex_deep_scan_scope: v })}
          options={[
            { value: "off", label: "Off (manual scans only)" },
            { value: "prime", label: "On, every night" },
          ]}
        />
        <SettingSelect
          label="Cascade security gate"
          hint="Hold automatic fleet cascades for approval while Prime has open findings at this severity. Merged security fixes always go through — they are what clears the gate."
          value={cfg.codex_cascade_gate ?? "off"}
          disabled={!migrated}
          onChange={(v) => save.mutate({ codex_cascade_gate: v })}
          options={[
            { value: "off", label: "Off" },
            { value: "critical", label: "Hold while Prime has open criticals" },
            { value: "high", label: "Hold while Prime has open high or critical" },
          ]}
        />

        <div className="border p-3 space-y-2 md:col-span-2">
          <Label className="font-medium">Nightly cron schedule (UTC)</Label>
          <div className="flex gap-2">
            <Input
              defaultValue={cfg.codex_nightly_cron ?? "0 7 * * *"}
              placeholder="0 7 * * *"
              onChange={(e) => setCron(e.target.value)}
              className="font-mono"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={cron === null || cron === cfg.codex_nightly_cron || reschedule.isPending}
              onClick={() => cron && reschedule.mutate(cron)}
            >
              {reschedule.isPending ? "Saving…" : "Reschedule"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Five fields, minute hour day month weekday — once a day. Saving reschedules the pg_cron
            job itself.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
