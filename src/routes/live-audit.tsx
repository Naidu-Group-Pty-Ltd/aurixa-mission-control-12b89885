// The live audit of Prime (docs/LIVE_AUDIT.md): Chromium drives Prime's
// production application as a member of staff while Claude reads its
// repository, for bugs and errors only. Prime is the acid test; the clones
// follow once it has been cycled through enough times.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { GitBranch, PlayCircle, ScanSearch } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { MetricBar } from "@/components/metric-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LIVE_AUDIT_POLICY_SUMMARY } from "@/lib/live-audit-policy";
import { getLiveAuditOverview, startLiveAuditRun } from "@/lib/live-audit.functions";
import { FindingSheet, LiveAuditFindings } from "@/components/live-audit/findings";
import { LiveAuditRuns, RunSheet, type RunRow } from "@/components/live-audit/runs";
import { LiveAuditFixes, type FixRow } from "@/components/live-audit/fixes";
import { LiveAuditSettingsPanel } from "@/components/live-audit/settings";
import { LiveAuditHealth } from "@/components/live-audit/health";
import { formatUsd, runStatusLabel } from "@/components/live-audit/labels";
import { formatDistanceToNow } from "@/lib/format";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS = ["findings", "runs", "fixes", "settings", "health"] as const;
type Tab = (typeof TABS)[number];
type LiveAuditSearch = { run?: string; finding?: string; tab?: Tab };

export const Route = createFileRoute("/live-audit")({
  // `?run=<id>` opens a run (the alerts link there); `?finding=<id>` a finding.
  validateSearch: (s: Record<string, unknown>): LiveAuditSearch => ({
    run: typeof s.run === "string" && UUID.test(s.run) ? s.run : undefined,
    finding: typeof s.finding === "string" && UUID.test(s.finding) ? s.finding : undefined,
    tab:
      typeof s.tab === "string" && (TABS as readonly string[]).includes(s.tab)
        ? (s.tab as Tab)
        : undefined,
  }),
  component: () => (
    <ProtectedRoute requireRole="operator">
      <LiveAuditPage />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({
    meta: [
      { title: "Live Audit — Aurixa Systems Mission Control" },
      {
        name: "description",
        content:
          "Prime's production application driven in Chromium while Claude reads its code: defects found, triaged and fixed.",
      },
    ],
  }),
});

function LiveAuditPage() {
  const qc = useQueryClient();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/live-audit" });
  const setSearch = (patch: Partial<LiveAuditSearch>) =>
    navigate({ search: (prev: LiveAuditSearch) => ({ ...prev, ...patch }) });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRef, setPreviewRef] = useState("");

  const q = useQuery({
    queryKey: ["live-audit-overview"],
    queryFn: () => getLiveAuditOverview(),
    refetchInterval: (query) => {
      const runs = ((query.state.data as any)?.runs ?? []) as RunRow[];
      return runs.some((r) => ["queued", "dispatched", "running"].includes(r.status))
        ? 5_000
        : 30_000;
    },
  });
  const d = q.data as any;
  const runs = (d?.runs ?? []) as RunRow[];
  const fixes = (d?.fixes ?? []) as FixRow[];
  const active = runs.find((r) => ["queued", "dispatched", "running"].includes(r.status));
  const lastDone = runs.find((r) => ["completed", "failed"].includes(r.status));
  const bySeverity = (d?.open?.bySeverity ?? {}) as Record<string, number>;
  const severe = (bySeverity.critical ?? 0) + (bySeverity.high ?? 0);
  const fixesInFlight = fixes.filter((f) =>
    ["queued", "dispatched", "pr_opened", "pr_updated"].includes(f.status),
  ).length;

  const runFn = useServerFn(startLiveAuditRun);
  const run = useMutation({
    mutationFn: (input: { mode?: "live" | "preview"; ref?: string }) => runFn({ data: input }),
    onSuccess: (r: { runId: string; dispatchError?: string }) => {
      if (r.dispatchError) toast.warning(`Run queued, but the dispatch failed: ${r.dispatchError}`);
      else toast.success("Run dispatched to Prime's Actions");
      setPreviewOpen(false);
      qc.invalidateQueries({ queryKey: ["live-audit-overview"] });
      setSearch({ run: r.runId });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <PageHeader
        eyebrow="observability · prime"
        title="Live Audit"
        icon={<ScanSearch className="h-6 w-6" />}
        description={
          <>
            Chromium drives Prime's production application as a member of staff while Claude reads
            its repository — for bugs and errors only. Every request that could change Prime is held
            back, and every defect is fixed by Claude.{" "}
            <span className="text-muted-foreground">{LIVE_AUDIT_POLICY_SUMMARY}</span>
          </>
        }
        actions={
          d?.canAct ? (
            <>
              <Button
                variant="outline"
                onClick={() => setPreviewOpen(true)}
                disabled={!!active || run.isPending}
              >
                <GitBranch className="mr-1.5 h-4 w-4" /> Preview a branch
              </Button>
              <Button onClick={() => run.mutate({})} disabled={!!active || run.isPending}>
                <PlayCircle className="mr-1.5 h-4 w-4" />
                {active ? "A run is in progress" : run.isPending ? "Dispatching…" : "Run audit now"}
              </Button>
            </>
          ) : undefined
        }
      />

      {d && !d.claudeEnabled && (
        <div className="glass spine spine-warn px-4 py-3 text-sm">
          <span className="font-medium">Claude is off.</span>{" "}
          <span className="text-muted-foreground">
            Runs drive Prime in the browser and report what it saw, with no Anthropic call. Claude's
            reading of the code, its exploring and judging, and every fix, start when you turn on
            Use Claude under Settings, once the live audit's key is provisioned.
          </span>
        </div>
      )}
      {d && d.claudeEnabled && !d.anthropicKey && (
        <div className="glass spine spine-warn px-4 py-3 text-sm">
          <span className="font-medium">Claude is on, but there is no Anthropic key.</span>{" "}
          <span className="text-muted-foreground">
            Set ANTHROPIC_API_KEY in Mission Control, publish, and sync it to Prime. Until then runs
            still go without Claude.
          </span>
        </div>
      )}
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      <MetricBar
        metrics={[
          { label: "open defects", value: d?.open?.total ?? "—" },
          {
            label: "critical + high",
            value: d ? severe : "—",
            alarm: severe > 0,
            tone: "destructive",
          },
          {
            label: "back again",
            value: lastDone?.regressions ?? "—",
            alarm: (lastDone?.regressions ?? 0) > 0,
            tone: "warning",
            note: "in the last run",
          },
          { label: "fixes in flight", value: d ? fixesInFlight : "—" },
          {
            label: "last run",
            value: active
              ? active.status
              : lastDone
                ? runStatusLabel(lastDone.status, lastDone.complete)
                : "none",
            alarm: lastDone?.status === "failed" && !active,
            tone: "destructive",
            note: active
              ? `started ${formatDistanceToNow(active.created_at)}`
              : lastDone
                ? `${formatDistanceToNow(lastDone.created_at)} · ${formatUsd(lastDone.cost_usd)}`
                : undefined,
          },
        ]}
      />

      <Tabs value={search.tab ?? "findings"} onValueChange={(v) => setSearch({ tab: v as Tab })}>
        {/* Wraps at phone width rather than running off the page. */}
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          <TabsTrigger value="findings">Findings</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="fixes">Fixes</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="health">Engine health</TabsTrigger>
        </TabsList>
        <TabsContent value="findings" className="pt-4">
          <LiveAuditFindings onOpen={(id) => setSearch({ finding: id })} />
        </TabsContent>
        <TabsContent value="runs" className="pt-4">
          <LiveAuditRuns runs={runs} onOpen={(id) => setSearch({ run: id })} />
        </TabsContent>
        <TabsContent value="fixes" className="pt-4">
          <LiveAuditFixes fixes={fixes} onOpenFinding={(id) => setSearch({ finding: id })} />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <LiveAuditSettingsPanel settings={d?.settings ?? null} canAct={!!d?.canAct} />
        </TabsContent>
        <TabsContent value="health" className="pt-4">
          <LiveAuditHealth />
        </TabsContent>
      </Tabs>

      <RunSheet
        runId={search.run ?? null}
        onClose={() => setSearch({ run: undefined })}
        onOpenFinding={(id) => setSearch({ run: undefined, finding: id })}
      />
      <FindingSheet
        findingId={search.finding ?? null}
        onClose={() => setSearch({ finding: undefined })}
      />

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preview a branch</DialogTitle>
            <DialogDescription>
              Builds the branch against Prime's staging backend inside the workflow and audits that
              build, so a change can be audited before it reaches production. Production is not
              touched.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="la-preview-ref">Branch</Label>
            <Input
              id="la-preview-ref"
              value={previewRef}
              onChange={(e) => setPreviewRef(e.target.value)}
              placeholder="main"
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={run.isPending || !/^[A-Za-z0-9._/-]{0,200}$/.test(previewRef.trim())}
              onClick={() => run.mutate({ mode: "preview", ref: previewRef.trim() || undefined })}
            >
              Run preview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
