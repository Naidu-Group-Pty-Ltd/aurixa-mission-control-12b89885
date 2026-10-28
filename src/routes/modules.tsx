import { createFileRoute, Link } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { ADMIN_ROLES, hasAnyRole } from "@/integrations/supabase/roles";
import { useModules, useClones, usePrimeConfig } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Boxes,
  Check,
  Pencil,
  History,
  Settings2,
  AlertTriangle,
  Search,
  ChevronDown,
  BarChart3,
  GitBranch,
  FileWarning,
  CheckCircle2,
  Archive,
  Brain,
  Layers,
  Target,
  Rocket,
  XCircle,
  Loader2,
  Library,
  BookOpen,
  FileCode,
  Upload,
  Trash2,
  ShieldCheck,
  ShieldX,
  Clock,
  Cloud,
  Database,
  KeyRound,
  TriangleAlert,
  GitCommitHorizontal,
} from "lucide-react";
import { LibraryReingestDialog } from "@/components/library-reingest-dialog";
import { PricingMapPanel } from "@/components/pricing-map-panel";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AUTO_MERGE_THRESHOLD, HIGH_RISK_CLONE_COUNT } from "@/lib/blast-radius";
import { useState, useMemo, useCallback, useEffect } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useServerFn } from "@tanstack/react-start";
import {
  detectModules,
  getDetectionRuns,
  getDriftAlerts,
  batchUpdateModuleStatus,
  resolveDriftAlert,
  getModuleIntelligence,
  approveAndDeploy,
  publishToLibrary,
  getModuleLibrary,
  removeFromLibrary,
  deleteDetectionRun,
  clearDetectionHistory,
} from "@/server/ai-detect-modules.functions";
import { setLibraryApprovalStatus } from "@/server/library-admin.functions";
import { deprecateLibraryEntry, undeprecateLibraryEntry } from "@/server/reliability.functions";
import { ModuleGridSkeleton } from "@/components/list-skeletons";
import { EmptyState } from "@/components/empty-state";
import { FleetModuleSyncCard } from "@/components/fleet-module-sync-card";
import { ModuleCoverageStrip } from "@/components/module-coverage-strip";
import { ModuleDependencyGraphButton } from "@/components/module-dependency-graph";
import { MetricCell } from "@/components/metric-bar";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { primeCommitLabel } from "@/lib/libraryCommit.pure";
import type { DetectionStrategy } from "@/server/module-detection.server";

export const Route = createFileRoute("/modules")({
  component: () => (
    <ProtectedRoute>
      <ModulesPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Modules — Aurixa Systems Mission Control" }] }),
});

type DetectionConfig = {
  strategy: DetectionStrategy;
  maxModules: number;
  minModules: number;
  sampleFileContent: boolean;
  analyzeImports: boolean;
  deltaMode: boolean;
  detectBackend: boolean;
  includeBackendGlobs: boolean;
  synthesizeBackendModules: boolean;
};

function ModulesPage() {
  const { data: modules, loading, refresh } = useModules();
  const { data: prime } = usePrimeConfig();
  const [scanning, setScanning] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showDrift, setShowDrift] = useState(false);
  const [showIntel, setShowIntel] = useState(false);
  const [showPricingMap, setShowPricingMap] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [searchQ, setSearchQ] = useState("");

  const [activeTab, setActiveTab] = useState<"modules" | "library">("modules");

  const [config, setConfig] = useState<DetectionConfig>({
    strategy: "feature-first",
    maxModules: 30,
    minModules: 1,
    sampleFileContent: true,
    analyzeImports: true,
    deltaMode: false,
    detectBackend: true,
    includeBackendGlobs: true,
    synthesizeBackendModules: true,
  });

  const detectFn = useServerFn(detectModules);
  const batchStatusFn = useServerFn(batchUpdateModuleStatus);

  const runDetection = async () => {
    if (!prime) return toast.error("Configure prime repo in Settings first");
    setScanning(true);
    try {
      const res = await detectFn({ data: config });
      if (!res.ok) {
        toast.error(res.error);
      } else {
        toast.success(
          `Detection complete — ${res.proposed} proposed, ${res.inserted} new, ${res.updated} updated, ${res.orphanAlerts} drift alerts`,
        );
        refresh();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Detection failed");
    } finally {
      setScanning(false);
    }
  };

  const setStatus = async (
    id: string,
    status: "approved" | "archived" | "rejected",
    rejectionReason?: string,
  ) => {
    try {
      const res = await batchStatusFn({ data: { moduleIds: [id], status, rejectionReason } });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Module ${status}`);
        refresh();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const batchAction = async (
    status: "approved" | "archived" | "rejected",
    rejectionReason?: string,
  ) => {
    if (selectedIds.size === 0) return;
    try {
      const res = await batchStatusFn({
        data: { moduleIds: Array.from(selectedIds), status, rejectionReason },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`${res.count} module(s) ${status}`);
        setSelectedIds(new Set());
        refresh();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Batch update failed");
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredModules = useMemo(() => {
    let list = modules;
    if (filterStatus !== "all") list = list.filter((m) => m.status === filterStatus);
    if (searchQ) {
      const q = searchQ.toLowerCase();
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.slug.toLowerCase().includes(q) ||
          m.description?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [modules, filterStatus, searchQ]);

  const counts = useMemo(
    () => ({
      total: modules.length,
      proposed: modules.filter((m) => m.status === "proposed").length,
      approved: modules.filter((m) => m.status === "approved").length,
      archived: modules.filter((m) => m.status === "archived").length,
    }),
    [modules],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="label-mono">module catalog</p>
          <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">Modules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Feature-first detection: the repo is partitioned into product domains, each owning its
            files exactly once, plus the edge functions, schema and secrets behind them.
          </p>
          <div className="mt-3 flex gap-1">
            <Button
              size="sm"
              variant={activeTab === "modules" ? "default" : "ghost"}
              onClick={() => setActiveTab("modules")}
            >
              <Boxes className="mr-1.5 h-3.5 w-3.5" /> Modules
            </Button>
            <Button
              size="sm"
              variant={activeTab === "library" ? "default" : "ghost"}
              onClick={() => setActiveTab("library")}
            >
              <BookOpen className="mr-1.5 h-3.5 w-3.5" /> Library
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/modules/builder">
            <Button variant="outline" size="sm">
              <Boxes className="mr-2 h-3.5 w-3.5" />
              Builder
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={() => setShowHistory(!showHistory)}>
            <History className="mr-2 h-3.5 w-3.5" />
            History
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowDrift(!showDrift)}>
            <FileWarning className="mr-2 h-3.5 w-3.5" />
            Drift
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowIntel(!showIntel)}>
            <BarChart3 className="mr-2 h-3.5 w-3.5" />
            Intelligence
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowPricingMap(!showPricingMap)}>
            <Layers className="mr-2 h-3.5 w-3.5" />
            Pricing map
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowConfig(!showConfig)}>
            <Settings2 className="mr-2 h-3.5 w-3.5" />
            Config
          </Button>
          <LibraryReingestDialog onDone={refresh} />
          <Button onClick={runDetection} disabled={scanning} size="sm">
            <Brain className="mr-2 h-3.5 w-3.5" />
            {scanning ? "Detecting…" : "Run Detection"}
          </Button>
        </div>
      </header>

      {/* Detection Config Panel */}
      {showConfig && <DetectionConfigPanel config={config} onChange={setConfig} />}

      {/* Detection History */}
      {showHistory && <DetectionHistoryPanel />}

      {/* Drift Alerts */}
      {showDrift && <DriftAlertsPanel />}

      {/* Module Intelligence */}
      {showIntel && <ModuleIntelligencePanel />}

      {showPricingMap && <PricingMapPanel />}

      {activeTab === "library" ? (
        <ModuleLibraryPanel />
      ) : (
        <>
          {/* Stats strip */}
          {modules.length > 0 && (
            <div className="glass grid overflow-hidden md:grid-cols-4">
              <StatTile label="total" value={counts.total} />
              <StatTile label="proposed" value={counts.proposed} tone="warning" />
              <StatTile label="approved" value={counts.approved} tone="success" />
              <StatTile label="archived" value={counts.archived} />
            </div>
          )}

          {/* Filters + batch actions */}
          {modules.length > 0 && (
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder="Search modules…"
                    className="h-8 w-56 pl-9 font-mono text-xs"
                  />
                </div>
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger className="h-8 w-36 font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="proposed">Proposed</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
                {/* Publishing the catalogue again (D19) is one publication of
                    every module; ticking ~135 cards one by one is not a way to
                    make it. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 font-mono text-[10px]"
                  disabled={filteredModules.length === 0}
                  onClick={() => setSelectedIds(new Set(filteredModules.map((m) => m.id)))}
                >
                  Select {filteredModules.length} shown
                </Button>
              </div>
              {selectedIds.size > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    {selectedIds.size} selected
                  </Badge>
                  <ApproveAndDeployButton
                    moduleIds={Array.from(selectedIds)}
                    onDone={() => {
                      setSelectedIds(new Set());
                      refresh();
                    }}
                  />
                  <PublishToLibraryButton moduleIds={Array.from(selectedIds)} />
                  <Button size="sm" variant="outline" onClick={() => batchAction("approved")}>
                    <Check className="mr-1 h-3 w-3" /> Approve
                  </Button>
                  <BatchRejectButton onReject={(reason) => batchAction("rejected", reason)} />
                  <Button size="sm" variant="ghost" onClick={() => batchAction("archived")}>
                    <Archive className="mr-1 h-3 w-3" /> Archive
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                    Clear
                  </Button>
                </div>
              )}
            </div>
          )}

          {loading ? (
            <ModuleGridSkeleton count={4} />
          ) : modules.length === 0 ? (
            <EmptyState
              icon={<FileCode />}
              title="No modules detected"
              description="Run route-first detection to scan your prime repo. The engine finds each route file, traces its full import tree, and creates one module per page."
              action={
                <Button onClick={runDetection} disabled={scanning}>
                  <FileCode className="mr-2 h-4 w-4" />
                  {scanning ? "Scanning…" : "Scan Routes"}
                </Button>
              }
            />
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                {filteredModules.map((m) => (
                  <ModuleRow
                    key={m.id}
                    module={m}
                    selected={selectedIds.has(m.id)}
                    onToggleSelect={() => toggleSelect(m.id)}
                    onApprove={() => setStatus(m.id, "approved")}
                    onReject={(reason) => setStatus(m.id, "rejected", reason)}
                    onArchive={() => setStatus(m.id, "archived")}
                    onEdited={refresh}
                  />
                ))}
              </div>
              {filteredModules.length === 0 && (
                <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No modules match your filters.
                </div>
              )}
              <FleetModuleSyncCard />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Detection Config Panel ─────────────────────────────────────────

function DetectionConfigPanel({
  config,
  onChange,
}: {
  config: DetectionConfig;
  onChange: (c: DetectionConfig) => void;
}) {
  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Settings2 className="h-4 w-4" /> Detection Configuration
        </CardTitle>
        <CardDescription className="text-xs">
          Fine-tune how the AI analyzes your prime repo for module boundaries.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Strategy
            </label>
            <Select
              value={config.strategy}
              onValueChange={(v) => onChange({ ...config, strategy: v as DetectionStrategy })}
            >
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feature-first">
                  <span className="flex items-center gap-1.5">
                    <Target className="h-3 w-3" /> Feature-first (recommended)
                  </span>
                </SelectItem>
                <SelectItem value="hybrid">
                  <span className="flex items-center gap-1.5">
                    <Layers className="h-3 w-3" /> Hybrid
                  </span>
                </SelectItem>
                <SelectItem value="route-first">
                  <span className="flex items-center gap-1.5">
                    <GitBranch className="h-3 w-3" /> Route-first (legacy)
                  </span>
                </SelectItem>
                <SelectItem value="layer-first">
                  <span className="flex items-center gap-1.5">
                    <GitBranch className="h-3 w-3" /> Layer-first
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {config.strategy === "feature-first" || config.strategy === "hybrid"
                ? "One module per product domain; every file owned exactly once"
                : "One module per route — closures overlap heavily on large repos"}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Module count range
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={20}
                value={config.minModules}
                onChange={(e) => onChange({ ...config, minModules: Number(e.target.value) })}
                className="h-8 w-16 font-mono text-xs"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="number"
                min={1}
                max={30}
                value={config.maxModules}
                onChange={(e) => onChange({ ...config, maxModules: Number(e.target.value) })}
                className="h-8 w-16 font-mono text-xs"
              />
            </div>
          </div>

          <div className="space-y-3">
            <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Analysis features
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={config.sampleFileContent}
                  onCheckedChange={(v) => onChange({ ...config, sampleFileContent: Boolean(v) })}
                />
                Sample file contents (richer AI context)
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={config.analyzeImports}
                  onCheckedChange={(v) => onChange({ ...config, analyzeImports: Boolean(v) })}
                />
                Import graph analysis (cohesion/coupling)
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={config.deltaMode}
                  onCheckedChange={(v) => onChange({ ...config, deltaMode: Boolean(v) })}
                />
                Delta mode (skip if unchanged)
              </label>
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div>
            <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Backend architecture
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              Scans <code className="font-mono">supabase/functions</code> and{" "}
              <code className="font-mono">supabase/migrations</code>, then links edge functions,
              tables, secrets and migrations to each module. Without this, a cascade pushes UI with
              no backend behind it.
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={config.detectBackend}
                onCheckedChange={(v) => onChange({ ...config, detectBackend: Boolean(v) })}
              />
              Detect backend architecture
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={config.includeBackendGlobs}
                disabled={!config.detectBackend}
                onCheckedChange={(v) => onChange({ ...config, includeBackendGlobs: Boolean(v) })}
              />
              Cascade backend files to clones
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={config.synthesizeBackendModules}
                disabled={!config.detectBackend}
                onCheckedChange={(v) =>
                  onChange({ ...config, synthesizeBackendModules: Boolean(v) })
                }
              />
              Modules for backend-only functions
            </label>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Detection History Panel ────────────────────────────────────────

function DetectionHistoryPanel() {
  const [runs, setRuns] = useState<Array<Record<string, unknown>>>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [clearing, setClearing] = useState(false);
  const getRunsFn = useServerFn(getDetectionRuns);
  const clearFn = useServerFn(clearDetectionHistory);
  const deleteFn = useServerFn(deleteDetectionRun);

  const refresh = useCallback(async () => {
    setLoadingRuns(true);
    const res = await getRunsFn();
    if (res.ok) setRuns(res.runs as Array<Record<string, unknown>>);
    setLoadingRuns(false);
  }, [getRunsFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (runId: string) => {
    const res = await deleteFn({ data: { runId } });
    if (res.ok) {
      toast.success("Detection run deleted");
      void refresh();
    } else {
      toast.error(res.error ?? "Delete failed");
    }
  };

  const handleClear = async (opts: { keepLatest?: number; onlyFailed?: boolean }) => {
    setClearing(true);
    try {
      const res = await clearFn({ data: opts });
      if (res.ok) {
        toast.success(`Cleared ${res.deleted} run(s)`);
        void refresh();
      } else {
        toast.error(res.error ?? "Clear failed");
      }
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4" /> Detection History
            </CardTitle>
            <CardDescription className="text-xs">
              Past AI detection runs with parameters, pass details, and results.
            </CardDescription>
          </div>
          {runs.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-[10px]"
                  disabled={clearing}
                >
                  <Trash2 className="mr-1 h-3 w-3" /> clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear detection history?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Deletes detection runs along with their drift alerts and import edges. Modules
                    created by these runs are kept (unlinked from history). Pick a scope below.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="flex flex-wrap gap-2 sm:justify-end">
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-warning text-warning-foreground hover:bg-warning/90"
                    onClick={() => handleClear({ onlyFailed: true })}
                  >
                    Failed only
                  </AlertDialogAction>
                  <AlertDialogAction
                    className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
                    onClick={() => handleClear({ keepLatest: 5 })}
                  >
                    Keep latest 5
                  </AlertDialogAction>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => handleClear({})}
                  >
                    Delete all
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loadingRuns ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="border border-dashed p-4 text-center text-xs text-muted-foreground">
            No detection runs yet.
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <DetectionRunRow key={r.id as string} run={r} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DetectionRunRow({
  run: r,
  onDelete,
}: {
  run: Record<string, unknown>;
  onDelete: (runId: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const status = r.status as string;
  const passes = (r.passes ?? []) as Array<{
    pass: number;
    name: string;
    model: string;
    duration_ms: number;
    modules_proposed: number;
    summary: string;
  }>;

  const statusCls =
    status === "completed"
      ? "text-success border-success/40"
      : status === "failed"
        ? "text-destructive border-destructive/40"
        : "text-warning border-warning/40";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-stretch gap-1">
        <CollapsibleTrigger asChild>
          <div className="flex flex-1 cursor-pointer items-center gap-3 border border-border px-3 py-2 transition-colors hover:bg-muted/40">
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
            <Badge variant="outline" className={cn("text-[9px] uppercase", statusCls)}>
              {status}
            </Badge>
            <span className="font-mono text-xs">{r.strategy as string}</span>
            <span className="text-[10px] text-muted-foreground">
              {r.file_count as number} files · {r.proposed_modules as number} proposed ·{" "}
              {r.inserted_modules as number} new · {r.updated_modules as number} updated
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {r.created_at ? formatDistanceToNow(r.created_at as string) : ""}
            </span>
          </div>
        </CollapsibleTrigger>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-auto w-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={(e) => e.stopPropagation()}
              aria-label="Delete detection run"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this detection run?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes this run plus its drift alerts and import edges. Modules created by it are
                preserved (unlinked from history).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void onDelete(r.id as string)}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <CollapsibleContent>
        <div className="ml-8 mt-2 space-y-2 border-l-2 border-border pl-4">
          {typeof r.error_message === "string" && r.error_message && (
            <div className="flex items-start gap-2 border border-destructive/20 bg-destructive/5 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{r.error_message}</span>
            </div>
          )}
          {passes.length > 0 && (
            <div className="space-y-1.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                AI passes
              </div>
              {passes.map((p) => (
                <div key={p.pass} className="border border-border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[9px]">
                      Pass {p.pass}
                    </Badge>
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground">({p.model})</span>
                    <span className="ml-auto text-muted-foreground">
                      {(p.duration_ms / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div className="mt-1 text-muted-foreground">{p.summary}</div>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Sampled files:</span>{" "}
              {r.sampled_file_count as number}
            </div>
            <div>
              <span className="text-muted-foreground">Import edges:</span>{" "}
              {r.dependency_count as number}
            </div>
            <div>
              <span className="text-muted-foreground">Orphan alerts:</span>{" "}
              {r.orphan_files_found as number}
            </div>
            <div>
              <span className="text-muted-foreground">Delta mode:</span>{" "}
              {(r.delta_mode as boolean) ? "Yes" : "No"}
            </div>
            <div>
              <span className="text-muted-foreground">Tree hash:</span>{" "}
              <code className="font-mono text-[10px]">
                {(r.tree_hash as string)?.slice(0, 8) ?? "—"}
              </code>
            </div>
            <div>
              <span className="text-muted-foreground">Commit:</span>{" "}
              {primeCommitLabel(r.commit_sha as string | null) ? (
                <code className="font-mono text-[10px]">
                  {primeCommitLabel(r.commit_sha as string | null)}
                </code>
              ) : (
                <span className="text-warning">not recorded</span>
              )}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Drift Alerts Panel ─────────────────────────────────────────────

function DriftAlertsPanel() {
  const [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(true);
  const getAlertsFn = useServerFn(getDriftAlerts);
  const resolveFn = useServerFn(resolveDriftAlert);

  const loadAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    const res = await getAlertsFn({ data: { resolved: false } });
    if (res.ok) setAlerts(res.alerts as Array<Record<string, unknown>>);
    setLoadingAlerts(false);
  }, []);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  const resolve = async (id: string) => {
    const res = await resolveFn({ data: { alertId: id } });
    if (res.ok) {
      toast.success("Alert resolved");
      loadAlerts();
    } else {
      toast.error(res.error);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileWarning className="h-4 w-4 text-warning" /> Drift Alerts
        </CardTitle>
        <CardDescription className="text-xs">
          Orphan files, boundary expansions, and module drift detected during scans.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadingAlerts ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : alerts.length === 0 ? (
          <div className="border border-dashed p-4 text-center text-xs text-muted-foreground">
            <CheckCircle2 className="mx-auto mb-1 h-4 w-4 text-success" />
            No unresolved drift alerts.
          </div>
        ) : (
          <div className="space-y-1.5">
            {alerts.map((a) => (
              <div
                key={a.id as string}
                className="flex items-start gap-3 border border-warning/20 bg-warning/5 px-3 py-2 text-xs"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="text-[9px] uppercase text-warning border-warning/30"
                    >
                      {String(a.alert_type)}
                    </Badge>
                    <code className="truncate font-mono text-[10px]">{String(a.file_path)}</code>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    <span>{String(a.reasoning ?? "")}</span>
                    {typeof a.suggested_module_slug === "string" && a.suggested_module_slug && (
                      <span>
                        {" "}
                        → <code className="font-mono text-primary">{a.suggested_module_slug}</code>
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => resolve(a.id as string)}
                >
                  <Check className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Module Intelligence Panel ──────────────────────────────────────

function ModuleIntelligencePanel() {
  const [data, setData] = useState<{
    coInstallation: Array<{ module_a: string; module_b: string; coInstallRate: number }>;
    healthScores: Array<{
      moduleId: string;
      moduleName: string;
      score: number;
      breakdown: Record<string, number>;
    }>;
  } | null>(null);
  const [loadingIntel, setLoadingIntel] = useState(true);
  const getIntelFn = useServerFn(getModuleIntelligence);

  useEffect(() => {
    (async () => {
      const res = await getIntelFn();
      if (res.ok) setData({ coInstallation: res.coInstallation, healthScores: res.healthScores });
      setLoadingIntel(false);
    })();
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BarChart3 className="h-4 w-4 text-primary" /> Cross-Clone Intelligence
        </CardTitle>
        <CardDescription className="text-xs">
          Co-installation patterns, health scoring, and fleet-wide module analytics.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loadingIntel ? (
          <div className="text-xs text-muted-foreground">Analyzing fleet data…</div>
        ) : !data ? (
          <div className="text-xs text-muted-foreground">No data available.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {/* Health Scores */}
            <div className="space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Module health scores
              </div>
              {data.healthScores.length === 0 ? (
                <div className="text-xs text-muted-foreground">No modules scored yet.</div>
              ) : (
                <div className="space-y-1.5">
                  {data.healthScores.map((h) => (
                    <div key={h.moduleId} className="border border-border px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-medium">{h.moduleName}</span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-mono text-[10px]",
                            h.score >= 70
                              ? "text-success border-success/40"
                              : h.score >= 40
                                ? "text-warning border-warning/40"
                                : "text-destructive border-destructive/40",
                          )}
                        >
                          {h.score}/100
                        </Badge>
                      </div>
                      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                        <div
                          className={cn(
                            "h-full transition-all",
                            h.score >= 70
                              ? "bg-success"
                              : h.score >= 40
                                ? "bg-warning"
                                : "bg-destructive",
                          )}
                          style={{ width: `${h.score}%` }}
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0 font-mono text-[9px] text-muted-foreground">
                        <span>sync {h.breakdown.sync_rate}%</span>
                        <span>cohesion {h.breakdown.cohesion}%</span>
                        <span>coupling {h.breakdown.coupling}%</span>
                        <span>{h.breakdown.clone_count} clones</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Co-installation */}
            <div className="space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Co-installation patterns
              </div>
              {data.coInstallation.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  Not enough fleet data for co-installation analysis.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {data.coInstallation.map((p, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 border border-border px-3 py-2 text-xs"
                    >
                      <code className="font-mono text-[10px]">{p.module_a}</code>
                      <span className="text-muted-foreground">×</span>
                      <code className="font-mono text-[10px]">{p.module_b}</code>
                      <Badge variant="outline" className="ml-auto font-mono text-[9px]">
                        {Math.round(p.coInstallRate * 100)}%
                      </Badge>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground">
                    Modules installed together &gt;30% of the time. Consider merging pairs above
                    90%.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Stat Tile ──────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "destructive";
}) {
  return <MetricCell label={label} value={value} tone={tone} alarm={Boolean(tone)} />;
}

// ─── Module Row ─────────────────────────────────────────────────────

function ModuleRow({
  module: m,
  selected,
  onToggleSelect,
  onApprove,
  onReject,
  onArchive,
  onEdited,
}: {
  module: ReturnType<typeof useModules>["data"][number];
  selected: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onReject: (reason?: string) => void;
  onArchive: () => void;
  onEdited: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(m.name);
  const [desc, setDesc] = useState(m.description ?? "");
  const [showReasoning, setShowReasoning] = useState(false);

  const save = async () => {
    await supabase.from("modules").update({ name, description: desc }).eq("id", m.id);
    setEdit(false);
    toast.success("Saved");
    onEdited();
  };

  const tone =
    m.status === "approved"
      ? "border-success/40 text-success"
      : m.status === "archived"
        ? "border-muted text-muted-foreground"
        : "border-warning/40 text-warning";

  const cohesion = Number(m.cohesion_score) || 0;
  const coupling = Number(m.coupling_score) || 0;
  const reasoning = (m as Record<string, unknown>).ai_reasoning as string | null;

  const row = m as Record<string, unknown>;
  const edgeFnCount = ((row.edge_functions as string[] | null) ?? []).length;
  const tableCount = ((row.database_tables as string[] | null) ?? []).length;
  const secretCount = ((row.required_secrets as string[] | null) ?? []).length;
  const layer = (row.layer as string | null) ?? "fullstack";
  // Edge functions with no globs to carry them means the cascade ships UI only.
  const backendGlobsMissing =
    edgeFnCount > 0 && ((row.backend_file_globs as string[] | null) ?? []).length === 0;

  return (
    <Card
      className={cn(
        "border-border/80 transition-colors",
        selected && "border-primary/60 bg-primary/5",
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="flex items-start gap-2.5">
          <Checkbox checked={selected} onCheckedChange={onToggleSelect} className="mt-1" />
          <div className="flex-1">
            {edit ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            ) : (
              <Link to="/modules/$slug" params={{ slug: m.slug }} className="hover:underline">
                <CardTitle className="text-base font-mono">{m.name}</CardTitle>
              </Link>
            )}
            <CardDescription className="mt-1 font-mono text-[11px]">{m.slug}</CardDescription>
            {/* Backend surface — what has to ship alongside the UI for this
                module to actually work on a clone. */}
            {(edgeFnCount > 0 || tableCount > 0 || secretCount > 0) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {edgeFnCount > 0 && (
                  <Badge variant="secondary" className="gap-1 font-mono text-[9px]">
                    <Cloud className="h-2.5 w-2.5" />
                    {edgeFnCount} fn
                  </Badge>
                )}
                {tableCount > 0 && (
                  <Badge variant="secondary" className="gap-1 font-mono text-[9px]">
                    <Database className="h-2.5 w-2.5" />
                    {tableCount} tbl
                  </Badge>
                )}
                {secretCount > 0 && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-warning/50 font-mono text-[9px] text-warning"
                  >
                    <KeyRound className="h-2.5 w-2.5" />
                    {secretCount} secret{secretCount === 1 ? "" : "s"}
                  </Badge>
                )}
                {backendGlobsMissing && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-destructive/50 font-mono text-[9px] text-destructive"
                    title="Edge functions detected but no backend globs — a cascade would push UI without its backend."
                  >
                    <TriangleAlert className="h-2.5 w-2.5" />
                    no backend globs
                  </Badge>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            {layer === "backend" && (
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                backend
              </Badge>
            )}
            <Badge variant="outline" className={`text-[10px] uppercase ${tone}`}>
              {m.status}
            </Badge>
            {m.ai_confidence != null && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {Math.round(Number(m.ai_confidence) * 100)}%
              </Badge>
            )}
          </div>
          {(cohesion > 0 || coupling > 0) && (
            <div className="flex items-center gap-2 font-mono text-[9px] text-muted-foreground">
              <span
                className={cn(
                  cohesion >= 0.7
                    ? "text-success"
                    : cohesion >= 0.4
                      ? "text-warning"
                      : "text-destructive",
                )}
              >
                coh {Math.round(cohesion * 100)}%
              </span>
              <span
                className={cn(
                  coupling <= 0.3
                    ? "text-success"
                    : coupling <= 0.6
                      ? "text-warning"
                      : "text-destructive",
                )}
              >
                cpl {Math.round(coupling * 100)}%
              </span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {edit ? (
          <Textarea value={desc} rows={2} onChange={(e) => setDesc(e.target.value)} />
        ) : (
          <p className="text-sm text-muted-foreground">{m.description || "—"}</p>
        )}

        {/* AI Reasoning */}
        {reasoning && (
          <Collapsible open={showReasoning} onOpenChange={setShowReasoning}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-primary hover:underline"
              >
                <Brain className="h-3 w-3" />
                AI reasoning
                <ChevronDown
                  className={cn("h-3 w-3 transition-transform", showReasoning && "rotate-180")}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1.5 border border-primary/20 bg-primary/5 p-2.5 text-xs text-muted-foreground">
                {reasoning}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <ModuleCoverageStrip moduleId={m.id} moduleSlug={m.slug} />

        <div className="space-y-1">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            routes
          </div>
          <div className="flex flex-wrap gap-1">
            {(m.routes ?? []).map((r) => (
              <code key={r} className="bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {r}
              </code>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            files
          </div>
          <div className="flex flex-wrap gap-1">
            {(m.file_globs ?? []).slice(0, 3).map((f) => (
              <code key={f} className="bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {f}
              </code>
            ))}
            {(m.file_globs ?? []).length > 3 && (
              <span className="text-[11px] text-muted-foreground">
                +{(m.file_globs ?? []).length - 3} more
              </span>
            )}
          </div>
        </div>

        {/* Dependencies */}
        {(m.requires?.length > 0 || m.incompatible_with?.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {m.requires?.map((r) => (
              <Badge
                key={r}
                variant="outline"
                className="text-[9px] border-primary/30 text-primary"
              >
                requires: {r}
              </Badge>
            ))}
            {m.incompatible_with?.map((r) => (
              <Badge
                key={r}
                variant="outline"
                className="text-[9px] border-destructive/30 text-destructive"
              >
                conflicts: {r}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {edit ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={save}>
                Save
              </Button>
            </>
          ) : (
            <>
              <ModuleDependencyGraphButton moduleId={m.id} />
              <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              {m.status === "rejected" && (
                <Badge
                  variant="outline"
                  className="text-[9px] border-destructive/30 text-destructive self-center"
                >
                  rejected
                  {(m as Record<string, unknown>).rejection_reason
                    ? `: ${(m as Record<string, unknown>).rejection_reason}`
                    : ""}
                </Badge>
              )}
              {m.status !== "approved" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onApprove}
                  className="border-success/40 text-success hover:bg-success/10"
                >
                  <Check className="mr-1 h-3.5 w-3.5" /> Approve
                </Button>
              )}
              {m.status !== "rejected" && m.status !== "archived" && (
                <RejectButton onReject={onReject} />
              )}
              {m.status !== "archived" && (
                <Button size="sm" variant="ghost" onClick={onArchive}>
                  <Archive className="mr-1 h-3.5 w-3.5" /> Archive
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Reject Button with reason dialog ───────────────────────────────

function RejectButton({ onReject }: { onReject: (reason?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10">
          <XCircle className="mr-1 h-3.5 w-3.5" /> Reject
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Module</DialogTitle>
          <DialogDescription>
            Optionally provide a reason for rejecting this module boundary.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Too broad, overlaps with auth module…"
          rows={3}
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onReject(reason || undefined);
              setOpen(false);
              setReason("");
            }}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchRejectButton({ onReject }: { onReject: (reason?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-destructive">
          <XCircle className="mr-1 h-3 w-3" /> Reject
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject Selected Modules</DialogTitle>
          <DialogDescription>Optionally provide a reason.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Rejection reason…"
          rows={2}
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onReject(reason || undefined);
              setOpen(false);
              setReason("");
            }}
          >
            Reject All
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Approve & Deploy Button ────────────────────────────────────────

function ApproveAndDeployButton({
  moduleIds,
  onDone,
}: {
  moduleIds: string[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [cascadeMode, setCascadeMode] = useState("pr");
  const { data: clones } = useClones();
  const [selectedCloneIds, setSelectedCloneIds] = useState<Set<string>>(new Set());
  const deployFn = useServerFn(approveAndDeploy);

  const toggleClone = (id: string) => {
    setSelectedCloneIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedCloneIds.size === clones.length) setSelectedCloneIds(new Set());
    else setSelectedCloneIds(new Set(clones.map((c) => c.id)));
  };

  const run = async () => {
    if (selectedCloneIds.size === 0) return toast.error("Select at least one clone");
    setDeploying(true);
    try {
      const res = await deployFn({
        data: {
          moduleIds,
          cloneIds: Array.from(selectedCloneIds),
          cascadeMode,
        },
      });
      if (!res.ok) {
        toast.error(res.error);
      } else if (res.requiresApproval) {
        toast.warning(
          `Approved ${res.count} module(s). The cascade waits for a second operator: ${res.approvalReason ?? "approval required"}`,
        );
        setOpen(false);
        onDone();
      } else {
        toast.success(
          `Approved ${res.count} module(s) and queued a cascade of the selected clones`,
        );
        setOpen(false);
        onDone();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-primary">
          <Rocket className="mr-1 h-3 w-3" /> Approve & Deploy
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" /> Approve & Cascade Deploy
          </DialogTitle>
          <DialogDescription>
            Approve {moduleIds.length} module(s), then cascade the selected clones. Each clone
            receives its whole sync scope, as any cascade does: approving a module does not narrow
            what is delivered. An auto-merge across more than {AUTO_MERGE_THRESHOLD} clones, or any
            cascade across more than {HIGH_RISK_CLONE_COUNT}, waits for a second operator.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Target clones
              </label>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={selectAll}>
                {selectedCloneIds.size === clones.length ? "Deselect all" : "Select all"}
              </Button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1 border border-border p-2">
              {clones.length === 0 ? (
                <div className="text-xs text-muted-foreground p-2">No clones available</div>
              ) : (
                clones.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/40 cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedCloneIds.has(c.id)}
                      onCheckedChange={() => toggleClone(c.id)}
                    />
                    <span className="font-mono font-medium">{c.name}</span>
                    <span className="text-muted-foreground">{c.slug}</span>
                    <Badge variant="outline" className="ml-auto text-[9px]">
                      {c.sync_status}
                    </Badge>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Cascade mode
            </label>
            <Select value={cascadeMode} onValueChange={setCascadeMode}>
              <SelectTrigger className="h-8 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pr">Pull Request</SelectItem>
                <SelectItem value="auto_merge">Auto-merge</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={run} disabled={deploying || selectedCloneIds.size === 0}>
            {deploying ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Deploying…
              </>
            ) : (
              <>
                <Rocket className="mr-1 h-3.5 w-3.5" /> Approve & Deploy ({selectedCloneIds.size})
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Publish to Library Button ──────────────────────────────────────

/**
 * Publishing approves each entry, by an admin, at the prime commit its
 * module's files were detected at (`libraryApproval.server.ts`, D19). The
 * server refuses a module whose detection run recorded no commit and names it;
 * the dialog keeps those names on screen rather than in a toast that fades.
 */
function PublishToLibraryButton({ moduleIds }: { moduleIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Array<{ slug: string | null; reason: string }>>([]);
  const publishFn = useServerFn(publishToLibrary);

  const submit = async () => {
    setBusy(true);
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await publishFn({ data: { moduleIds, tags: tagList } });
      setRefused(res.refused);
      for (const w of res.warnings) toast.warning(w);
      if (!res.ok) {
        toast.error(res.error ?? "Publish failed");
        return;
      }
      const commits = [
        ...new Set(res.entries.map((e) => primeCommitLabel(e.source_commit_sha)).filter(Boolean)),
      ];
      const at = commits.length === 1 ? ` at ${commits[0]}` : "";
      if (res.refused.length > 0) {
        toast.warning(
          `Published and approved ${res.published} module(s)${at}; ${res.refused.length} refused`,
        );
        return;
      }
      toast.success(`Published and approved ${res.published} module(s)${at}`);
      setOpen(false);
      setTags("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setRefused([]);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Upload className="mr-1 h-3 w-3" /> Publish ({moduleIds.length})
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to library</DialogTitle>
          <DialogDescription>
            Snapshot {moduleIds.length} module(s) as versioned library entries. Publishing approves
            each entry at the prime commit its module&apos;s files were detected at, so it needs an
            admin, and a module whose detection run recorded no commit is refused by name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-xs font-mono text-muted-foreground">Tags (comma-separated)</label>
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="core, beta, customer-facing"
            className="font-mono text-xs"
          />
        </div>
        {refused.length > 0 && (
          <div className="max-h-48 space-y-1 overflow-y-auto border border-warning/40 bg-warning/5 p-2 text-[11px]">
            <div className="font-mono uppercase tracking-wider text-warning">
              refused · {refused.length}
            </div>
            {refused.map((r, i) => (
              <p key={`${r.slug ?? "unknown"}-${i}`} className="text-muted-foreground">
                {r.reason}
              </p>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Publishing…
              </>
            ) : (
              <>
                <Upload className="mr-1 h-3.5 w-3.5" /> Publish and approve
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Module Library Panel (with admin approval workflow) ──────────

function ModuleLibraryPanel() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [entries, setEntries] = useState<Array<Record<string, unknown>>>([]);
  // Approvers' display names by user id; an approver with none shows the id.
  const [approvers, setApprovers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) =>
    setSelected((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const getLibraryFn = useServerFn(getModuleLibrary);
  const removeFn = useServerFn(removeFromLibrary);
  const setApprovalFn = useServerFn(setLibraryApprovalStatus);

  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    void supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .then(({ data }) => {
        const roles = (data ?? []).map((r) => r.role as string);
        setIsAdmin(hasAnyRole(roles, ADMIN_ROLES));
      });
  }, [user]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getLibraryFn({ data: { latestOnly: false } });
      if (res.ok) {
        setEntries(res.entries as Array<Record<string, unknown>>);
        setApprovers(res.approvers);
        if (res.approversError)
          toast.warning(`Approvers' names unavailable: ${res.approversError}`);
      } else toast.error(res.error ?? "Could not read the library");
    } finally {
      setLoading(false);
    }
  }, [getLibraryFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string) => {
    const res = await removeFn({ data: { entryId: id } });
    if (res.ok) {
      toast.success("Removed from library");
      refresh();
    } else toast.error(res.error ?? "Remove failed");
  };

  const decide = async (id: string, status: "approved" | "rejected", reason?: string) => {
    const res = await setApprovalFn({ data: { entryId: id, status, reason } });
    if (res.ok) {
      toast.success(status === "approved" ? "Approved" : "Rejected");
      refresh();
    } else toast.error(res.error ?? "Action failed");
  };

  const filtered = entries.filter((e) => {
    if (filter === "all") return true;
    return (e.approval_status as string) === filter;
  });

  const counts = {
    all: entries.length,
    pending: entries.filter((e) => e.approval_status === "pending").length,
    approved: entries.filter((e) => e.approval_status === "approved").length,
    rejected: entries.filter((e) => e.approval_status === "rejected").length,
  };

  if (loading) return <ModuleGridSkeleton count={3} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "pending", "approved", "rejected"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
            className="font-mono text-[10px] uppercase tracking-wider"
          >
            {f} ({counts[f]})
          </Button>
        ))}
        {!isAdmin && (
          <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
            <ShieldX className="mr-1 h-3 w-3" /> Admin role required to publish or approve entries
          </Badge>
        )}
      </div>

      {selected.size > 0 && isAdmin && (
        <div className="flex flex-wrap items-center justify-between gap-2 border border-primary/40 bg-primary/5 p-2">
          <span className="font-mono text-xs text-muted-foreground">
            {selected.size} entry{selected.size === 1 ? "" : "s"} selected
          </span>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const { bulkSetLibraryApproval } = await import("@/server/bulk-ops.functions");
                const r = await bulkSetLibraryApproval({
                  data: { ids: Array.from(selected), status: "approved" },
                });
                if (r.ok) {
                  toast.success(`Approved ${r.count}`);
                  setSelected(new Set());
                  refresh();
                } else toast.error(r.error);
              }}
            >
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const reason = prompt("Rejection reason (optional)") ?? undefined;
                const { bulkSetLibraryApproval } = await import("@/server/bulk-ops.functions");
                const r = await bulkSetLibraryApproval({
                  data: { ids: Array.from(selected), status: "rejected", reason },
                });
                if (r.ok) {
                  toast.success(`Rejected ${r.count}`);
                  setSelected(new Set());
                  refresh();
                } else toast.error(r.error);
              }}
            >
              <XCircle className="mr-1 h-3.5 w-3.5" /> Reject
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const reason = prompt("Deprecation reason (optional)") ?? undefined;
                const replacementSlug = prompt("Replacement slug (optional)") ?? undefined;
                const { bulkDeprecateLibrary } = await import("@/server/bulk-ops.functions");
                const r = await bulkDeprecateLibrary({
                  data: { ids: Array.from(selected), reason, replacementSlug },
                });
                if (r.ok) {
                  toast.success(`Deprecated ${r.count}`);
                  setSelected(new Set());
                  refresh();
                } else toast.error(r.error);
              }}
            >
              <Clock className="mr-1 h-3.5 w-3.5" /> Deprecate
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                if (
                  !(await confirm({
                    title: `Permanently delete ${selected.size} library entries?`,
                    confirmText: "Delete",
                    destructive: true,
                  }))
                )
                  return;
                const { bulkDeleteLibraryEntries } = await import("@/server/bulk-ops.functions");
                const r = await bulkDeleteLibraryEntries({ data: { ids: Array.from(selected) } });
                if (r.ok) {
                  toast.success(`Deleted ${r.count}`);
                  setSelected(new Set());
                  refresh();
                } else toast.error(r.error);
              }}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Library />}
          title={filter === "all" ? "Library is empty" : `No ${filter} entries`}
          description="Select modules in the Modules tab and use Publish to snapshot them as versioned library entries. Publishing approves each entry at the prime commit its module was detected at, so an admin publishes, and an approved entry can be pinned to a clone."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((e) => {
            const tags = (e.tags as string[]) ?? [];
            const fileCount = (e.file_count as number) ?? 0;
            const status = (e.approval_status as string) ?? "pending";
            // The commit the entry was approved at (D19): every entry published
            // before commits were recorded has none, and cannot be approved.
            const commit = primeCommitLabel(e.source_commit_sha as string | null);
            const approvedBy = e.approved_by as string | null;
            const approver = approvedBy ? (approvers[approvedBy] ?? approvedBy.slice(0, 8)) : null;
            const statusTone =
              status === "approved"
                ? "border-success/40 text-success"
                : status === "rejected"
                  ? "border-destructive/40 text-destructive"
                  : "border-warning/40 text-warning";
            const statusIcon =
              status === "approved" ? (
                <CheckCircle2 className="mr-1 h-3 w-3" />
              ) : status === "rejected" ? (
                <XCircle className="mr-1 h-3 w-3" />
              ) : (
                <Clock className="mr-1 h-3 w-3" />
              );
            return (
              <Card key={e.id as string}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      {isAdmin && (
                        <input
                          type="checkbox"
                          checked={selected.has(e.id as string)}
                          onChange={() => toggleSel(e.id as string)}
                          className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                          aria-label="Select entry"
                        />
                      )}
                      <div className="min-w-0">
                        <CardTitle className="font-mono text-sm flex items-center gap-2">
                          <BookOpen className="h-3.5 w-3.5 text-primary" />
                          {e.name as string}
                          <Badge variant="outline" className="font-mono text-[10px]">
                            v{e.version as number}
                          </Badge>
                          {(e.is_latest as boolean) && (
                            <Badge variant="secondary" className="font-mono text-[9px]">
                              latest
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription className="mt-1 font-mono text-[11px]">
                          {(e.entry_file as string) ?? (e.slug as string)}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge
                        variant="outline"
                        className={cn("font-mono text-[10px] uppercase", statusTone)}
                      >
                        {statusIcon}
                        {status}
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => remove(e.id as string)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 pt-0">
                  {e.description ? (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {e.description as string}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-muted-foreground">
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      <FileCode className="mr-1 h-3 w-3" />
                      {fileCount} files
                    </Badge>
                    {e.route_path ? (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {e.route_path as string}
                      </Badge>
                    ) : null}
                    {tags.map((t) => (
                      <Badge key={t} variant="outline" className="font-mono text-[10px]">
                        #{t}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-muted-foreground">
                    {commit ? (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        <GitCommitHorizontal className="mr-1 h-3 w-3" />
                        {commit}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-warning/40 font-mono text-[10px] text-warning"
                      >
                        <GitCommitHorizontal className="mr-1 h-3 w-3" />
                        no commit recorded
                      </Badge>
                    )}
                    {status === "approved" && approver ? (
                      <span>
                        approved by {approver}
                        {e.approved_at ? ` · ${formatDistanceToNow(e.approved_at as string)}` : ""}
                      </span>
                    ) : null}
                  </div>
                  {status === "rejected" && e.rejection_reason ? (
                    <p className="text-[11px] text-destructive italic">
                      Reason: {e.rejection_reason as string}
                    </p>
                  ) : null}
                  {(e.deprecated_at as string | null) ? (
                    <div className="border border-warning/40 bg-warning/5 p-2 text-[11px]">
                      <div className="font-mono uppercase tracking-wider text-warning">
                        Deprecated
                      </div>
                      {e.deprecated_reason ? (
                        <div className="text-warning/90">{e.deprecated_reason as string}</div>
                      ) : null}
                      {e.replacement_slug ? (
                        <div className="font-mono text-[10px]">
                          replaced by: {e.replacement_slug as string}
                        </div>
                      ) : null}
                      {isAdmin && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="mt-1 h-6 text-[10px]"
                          onClick={async () => {
                            await undeprecateLibraryEntry({ data: { entryId: e.id as string } });
                            toast.success("Restored");
                            refresh();
                          }}
                        >
                          Undeprecate
                        </Button>
                      )}
                    </div>
                  ) : isAdmin && status === "approved" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] text-muted-foreground"
                      onClick={async () => {
                        const reason = prompt("Deprecation reason");
                        if (!reason) return;
                        const replacement = prompt("Replacement slug (optional)") || undefined;
                        const r = await deprecateLibraryEntry({
                          data: { entryId: e.id as string, reason, replacementSlug: replacement },
                        });
                        if (r.ok) {
                          toast.success("Marked deprecated");
                          refresh();
                        } else toast.error(r.error);
                      }}
                    >
                      Mark deprecated
                    </Button>
                  ) : null}

                  {isAdmin && status !== "approved" && (
                    <div className="flex justify-end gap-1.5 pt-1">
                      {status === "pending" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const reason = prompt("Reject reason (optional)") ?? undefined;
                            decide(e.id as string, "rejected", reason);
                          }}
                          className="border-destructive/40 text-destructive hover:bg-destructive/10"
                        >
                          <ShieldX className="mr-1 h-3 w-3" /> Reject
                        </Button>
                      )}
                      {commit ? (
                        <Button
                          size="sm"
                          onClick={() => decide(e.id as string, "approved")}
                          className="bg-success hover:bg-success/90"
                        >
                          <ShieldCheck className="mr-1 h-3 w-3" /> Approve
                        </Button>
                      ) : (
                        <span className="self-center text-[10px] text-muted-foreground">
                          Records no commit: publish its module again to approve it
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
