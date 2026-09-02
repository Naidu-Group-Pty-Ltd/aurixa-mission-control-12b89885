import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Waves,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Rocket,
  RotateCcw,
  Eye,
  Undo2,
  Filter,
  Search,
  AlertTriangle,
  Save,
  Trash2,
  Radio,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { useClones, type Clone } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { describeCascadeOutcome } from "@/lib/cascadeRunOutcome";
import { useServerFn } from "@tanstack/react-start";
import { runCascade } from "@/server/cascade-engine.functions";
import { assessBlastRadius } from "@/lib/blast-radius";

type CloneProgress = {
  clone_id: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  error?: string;
  pr_url?: string;
  previous_sha?: string;
};

type SyncFilter = "all" | "synced" | "behind" | "diverged" | "unknown";
type TimeFilter = "all" | "24h" | "7d" | "30d";
type ErrorTypeFilter = "all" | "auth" | "conflict" | "timeout" | "network" | "other";

const STORAGE_KEY = "aurixa:bulk-cascade-filters";
const PRESETS_KEY = "aurixa:bulk-cascade-presets";

function classifyError(err?: string): ErrorTypeFilter {
  if (!err) return "other";
  const lower = err.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("auth") ||
    lower.includes("permission") ||
    lower.includes("token")
  )
    return "auth";
  if (lower.includes("conflict") || lower.includes("merge") || lower.includes("422"))
    return "conflict";
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline"))
    return "timeout";
  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("dns")
  )
    return "network";
  return "other";
}

const ERROR_TYPE_LABELS: Record<ErrorTypeFilter, string> = {
  all: "All errors",
  auth: "Auth / permission",
  conflict: "Merge conflict",
  timeout: "Timeout",
  network: "Network",
  other: "Other",
};

type SavedFilters = {
  nameFilter: string;
  statusFilter: SyncFilter;
  timeFilter: TimeFilter;
  errorTypeFilter: ErrorTypeFilter;
};

type FilterPreset = SavedFilters & {
  id: string;
  label: string;
  dryRun: boolean;
  selectAll: boolean;
};

function loadSavedFilters(): SavedFilters | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedFilters;
  } catch {
    return null;
  }
}

function saveFilters(f: SavedFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
  } catch {
    // ignore
  }
}

function loadPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as FilterPreset[];
  } catch {
    return [];
  }
}

function persistPresets(presets: FilterPreset[]) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    // ignore
  }
}

export function BulkCascadeCard() {
  const { data: clones } = useClones();
  const runCascadeFn = useServerFn(runCascade);
  const [running, setRunning] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CloneProgress[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [selectAllFiltered, setSelectAllFiltered] = useState(true);
  const [showSelectAllConfirm, setShowSelectAllConfirm] = useState(false);

  // Rollback confirmation
  const [rollbackTarget, setRollbackTarget] = useState<{
    clone_id: string;
    name: string;
    previous_sha: string;
  } | null>(null);
  const [rollbackConfirmText, setRollbackConfirmText] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");

  // Presets
  const [presets, setPresets] = useState<FilterPreset[]>(() => loadPresets());
  const [newPresetName, setNewPresetName] = useState("");
  const [showPresetSave, setShowPresetSave] = useState(false);

  // Filters — initialise from localStorage
  const saved = useMemo(() => loadSavedFilters(), []);
  const [nameFilter, setNameFilter] = useState(saved?.nameFilter ?? "");
  const [statusFilter, setStatusFilter] = useState<SyncFilter>(saved?.statusFilter ?? "all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(saved?.timeFilter ?? "all");
  const [errorTypeFilter, setErrorTypeFilter] = useState<ErrorTypeFilter>(
    saved?.errorTypeFilter ?? "all",
  );

  // Persist filters on change
  useEffect(() => {
    saveFilters({ nameFilter, statusFilter, timeFilter, errorTypeFilter });
  }, [nameFilter, statusFilter, timeFilter, errorTypeFilter]);

  const filteredClones = useMemo(() => {
    let result = clones;
    if (nameFilter) {
      const q = nameFilter.toLowerCase();
      result = result.filter(
        (c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q),
      );
    }
    if (statusFilter !== "all") {
      result = result.filter((c) => c.sync_status === statusFilter);
    }
    if (timeFilter !== "all") {
      const now = Date.now();
      const cutoffs: Record<string, number> = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = cutoffs[timeFilter];
      if (cutoff) {
        result = result.filter((c) => {
          const updated = c.updated_at ? new Date(c.updated_at).getTime() : 0;
          return now - updated <= cutoff;
        });
      }
    }
    return result;
  }, [clones, nameFilter, statusFilter, timeFilter]);

  // The actual target set respects the "select all filtered" checkbox
  const targetClones = selectAllFiltered ? filteredClones : [];

  // Filter progress rows by error type (for retry targeting)
  const filteredProgress = useMemo(() => {
    if (errorTypeFilter === "all") return progress;
    return progress.filter((p) => {
      if (p.status !== "failed") return true;
      return classifyError(p.error) === errorTypeFilter;
    });
  }, [progress, errorTypeFilter]);

  const completed = progress.filter(
    (p) => p.status === "succeeded" || p.status === "failed" || p.status === "skipped",
  ).length;
  const total = progress.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const succeeded = progress.filter((p) => p.status === "succeeded").length;
  const failed = progress.filter((p) => p.status === "failed").length;
  const failedClones = progress.filter((p) => p.status === "failed");

  // Error type breakdown
  const errorBreakdown = useMemo(() => {
    const counts: Record<ErrorTypeFilter, number> = {
      all: 0,
      auth: 0,
      conflict: 0,
      timeout: 0,
      network: 0,
      other: 0,
    };
    for (const p of failedClones) {
      const t = classifyError(p.error);
      counts[t]++;
      counts.all++;
    }
    return counts;
  }, [failedClones]);

  // Realtime subscription
  useEffect(() => {
    if (!eventId) return;
    const channel = supabase
      .channel(`bulk-cascade-${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "cascade_results",
          filter: `cascade_event_id=eq.${eventId}`,
        },
        (payload) => {
          const row = payload.new as {
            clone_id: string;
            status: string;
            error_message?: string;
            pr_url?: string;
            previous_sha?: string;
          };
          setProgress((prev) =>
            prev.map((p) =>
              p.clone_id === row.clone_id
                ? {
                    ...p,
                    status: row.status as CloneProgress["status"],
                    error: row.error_message,
                    pr_url: row.pr_url,
                    previous_sha: row.previous_sha,
                  }
                : p,
            ),
          );
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [eventId]);

  const fireBulk = async () => {
    const targets = targetClones;
    if (targets.length === 0)
      return toast.error("No clones selected — check your filters or enable 'Select all filtered'");
    setRunning(true);
    setExpanded(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (dryRun) {
        const initialProgress: CloneProgress[] = targets.map((c) => ({
          clone_id: c.id,
          name: c.name,
          status: "queued",
        }));
        setProgress(initialProgress);
        toast.info(
          `Dry run: ${targets.length} clones would be updated. Review below, then disable dry-run to execute.`,
        );
        setRunning(false);
        return;
      }

      const { data: ev, error } = await supabase
        .from("cascade_events")
        .insert({
          trigger: "manual",
          mode: "pr",
          status: "pending",
          scope_filter: {
            scope: "filtered",
            bulk: true,
            clone_ids: targets.map((c) => c.id),
          },
          initiated_by: user?.id,
        })
        .select()
        .single();
      if (error || !ev) throw new Error(error?.message || "Failed to create cascade event");
      setEventId(ev.id);

      const initialProgress: CloneProgress[] = targets.map((c) => ({
        clone_id: c.id,
        name: c.name,
        status: "queued",
        previous_sha: c.last_synced_sha ?? undefined,
      }));
      setProgress(initialProgress);

      await supabase.from("cascade_results").insert(
        targets.map((c) => ({
          cascade_event_id: ev.id,
          clone_id: c.id,
          status: "queued" as const,
          previous_sha: c.last_synced_sha,
        })),
      );

      await supabase.from("audit_log").insert({
        action: "cascade.bulk_fired",
        entity_type: "cascade_event",
        entity_id: ev.id,
        actor_user_id: user?.id,
        metadata: { clone_count: targets.length, mode: "pr" },
      });

      toast.info(`Bulk cascade started — ${targets.length} clones queued`);

      const res = await runCascadeFn({ data: { cascadeEventId: ev.id } });
      const outcome = describeCascadeOutcome(res);
      toast[outcome.level](outcome.message);

      const { data: results } = await supabase
        .from("cascade_results")
        .select("clone_id, status, error_message, pr_url, previous_sha")
        .eq("cascade_event_id", ev.id);

      if (results) {
        setProgress((prev) =>
          prev.map((p) => {
            const r = results.find((x: { clone_id: string }) => x.clone_id === p.clone_id);
            if (!r) return p;
            return {
              ...p,
              status: r.status as CloneProgress["status"],
              error: r.error_message ?? undefined,
              pr_url: r.pr_url ?? undefined,
              previous_sha: r.previous_sha ?? undefined,
            };
          }),
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk cascade failed");
    } finally {
      setRunning(false);
    }
  };

  const retryFailed = async () => {
    if (!eventId || failedClones.length === 0) return;
    const toRetry =
      errorTypeFilter === "all"
        ? failedClones
        : failedClones.filter((p) => classifyError(p.error) === errorTypeFilter);
    if (toRetry.length === 0) return toast.error("No failures match the selected error type");

    setProgress((prev) =>
      prev.map((p) =>
        toRetry.some((r) => r.clone_id === p.clone_id)
          ? { ...p, status: "queued", error: undefined }
          : p,
      ),
    );
    for (const fc of toRetry) {
      await supabase
        .from("cascade_results")
        .update({ status: "queued", error_message: null })
        .eq("cascade_event_id", eventId)
        .eq("clone_id", fc.clone_id);
    }
    toast.info(`Retrying ${toRetry.length} failed clone${toRetry.length > 1 ? "s" : ""}…`);
    try {
      const res = await runCascadeFn({ data: { cascadeEventId: eventId } });
      const outcome = describeCascadeOutcome(res);
      toast[outcome.level](outcome.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retry failed");
    }
    const { data: results } = await supabase
      .from("cascade_results")
      .select("clone_id, status, error_message, pr_url, previous_sha")
      .eq("cascade_event_id", eventId);
    if (results) {
      setProgress((prev) =>
        prev.map((p) => {
          const r = results.find((x: { clone_id: string }) => x.clone_id === p.clone_id);
          if (!r) return p;
          return {
            ...p,
            status: r.status as CloneProgress["status"],
            error: r.error_message ?? undefined,
            pr_url: r.pr_url ?? undefined,
            previous_sha: r.previous_sha ?? undefined,
          };
        }),
      );
    }
  };

  const executeRollback = async () => {
    if (!rollbackTarget) return;
    const trimmed = rollbackReason.trim();
    if (trimmed.length < 10) {
      toast.error("Rollback reason must be at least 10 characters");
      return;
    }
    if (trimmed.length > 500) {
      toast.error("Rollback reason must be 500 characters or fewer");
      return;
    }
    const { clone_id: cloneId, previous_sha: previousSha } = rollbackTarget;
    toast.info("Rolling back clone…");
    const {
      data: { user },
    } = await supabase.auth.getUser();
    await supabase.from("audit_log").insert({
      action: "cascade.rollback",
      entity_type: "clone",
      entity_id: cloneId,
      actor_user_id: user?.id,
      metadata: {
        previous_sha: previousSha,
        cascade_event_id: eventId,
        reason: rollbackReason.trim(),
      },
    });
    await supabase.from("clones").update({ last_synced_sha: previousSha }).eq("id", cloneId);
    setProgress((prev) =>
      prev.map((p) =>
        p.clone_id === cloneId ? { ...p, status: "skipped", error: "Rolled back" } : p,
      ),
    );
    setRollbackTarget(null);
    setRollbackConfirmText("");
    setRollbackReason("");
    toast.success("Clone rolled back to previous version");
  };

  // Preset management
  const saveCurrentPreset = () => {
    const name = newPresetName.trim();
    if (!name) return toast.error("Enter a preset name");
    if (presets.some((p) => p.label === name)) return toast.error("Preset name already exists");
    const preset: FilterPreset = {
      id: crypto.randomUUID(),
      label: name,
      nameFilter,
      statusFilter,
      timeFilter,
      errorTypeFilter,
      dryRun,
      selectAll: selectAllFiltered,
    };
    const updated = [...presets, preset];
    setPresets(updated);
    persistPresets(updated);
    setNewPresetName("");
    setShowPresetSave(false);
    toast.success(`Preset "${name}" saved`);
  };

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setNameFilter(preset.nameFilter);
    setStatusFilter(preset.statusFilter);
    setTimeFilter(preset.timeFilter);
    setErrorTypeFilter(preset.errorTypeFilter);
    setDryRun(preset.dryRun);
    setSelectAllFiltered(preset.selectAll);
    toast.info(`Preset "${preset.label}" applied`);
  };

  const deletePreset = (id: string) => {
    const updated = presets.filter((p) => p.id !== id);
    setPresets(updated);
    persistPresets(updated);
    toast.success("Preset deleted");
  };

  const hasActiveFilters = nameFilter || statusFilter !== "all" || timeFilter !== "all";

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Rocket className="h-4 w-4" /> Bulk cascade
              </CardTitle>
              <CardDescription>
                Push prime codebase upgrades to filtered clones. Track per-clone progress and
                failures in real time.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowFilters(!showFilters)}
                className={cn(showFilters && "bg-muted")}
              >
                <Filter className="mr-1.5 h-3.5 w-3.5" />
                Filters
                {hasActiveFilters && (
                  <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[9px] text-primary-foreground">
                    ●
                  </span>
                )}
              </Button>
              <Button
                variant={dryRun ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setDryRun(!dryRun)}
              >
                <Eye className="mr-1.5 h-3.5 w-3.5" />
                {dryRun ? "Dry-run ON" : "Dry-run"}
              </Button>
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                  {targetClones.length === clones.length
                    ? `${targetClones.length} clones`
                    : `${targetClones.length} of ${clones.length} selected`}
                </span>
                <Button
                  onClick={fireBulk}
                  disabled={running || targetClones.length === 0}
                  size="sm"
                >
                  {running ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Waves className="mr-2 h-3.5 w-3.5" />
                  )}
                  {running
                    ? "Running…"
                    : dryRun
                      ? `Preview (${targetClones.length})`
                      : `Cascade (${targetClones.length})`}
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>

        {/* Filters */}
        {showFilters && (
          <CardContent className="border-t border-border pt-4 pb-0">
            {/* Preset bar */}
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              {presets.length > 0 && (
                <Select onValueChange={applyPreset} value="">
                  <SelectTrigger className="h-8 w-auto min-w-[140px] text-xs">
                    <SelectValue placeholder="Load preset…" />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((p) => {
                      const details: string[] = [];
                      if (p.dryRun) details.push("dry-run");
                      if (p.statusFilter !== "all") details.push(p.statusFilter);
                      if (p.timeFilter !== "all") details.push(p.timeFilter);
                      if (p.errorTypeFilter !== "all")
                        details.push(ERROR_TYPE_LABELS[p.errorTypeFilter]);
                      if (p.nameFilter) details.push(`"${p.nameFilter}"`);
                      return (
                        <SelectItem key={p.id} value={p.id}>
                          <span className="flex items-center gap-2">
                            <span>{p.label}</span>
                            {details.length > 0 && (
                              <span className="text-muted-foreground text-[9px]">
                                {details.join(" · ")}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
              {presets.length > 0 && (
                <Select onValueChange={deletePreset} value="">
                  <SelectTrigger className="h-8 w-auto min-w-[40px] text-xs text-destructive border-destructive/30">
                    <Trash2 className="h-3 w-3" />
                  </SelectTrigger>
                  <SelectContent>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        Delete "{p.label}"
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {showPresetSave ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    placeholder="Preset name…"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    className="h-8 w-36 text-xs"
                    onKeyDown={(e) => e.key === "Enter" && saveCurrentPreset()}
                    autoFocus
                  />
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 px-2"
                    onClick={saveCurrentPreset}
                  >
                    <Save className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => {
                      setShowPresetSave(false);
                      setNewPresetName("");
                    }}
                  >
                    ✕
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => setShowPresetSave(true)}
                >
                  <Save className="mr-1 h-3 w-3" />
                  Save preset
                </Button>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Clone name
                </label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search clones…"
                    value={nameFilter}
                    onChange={(e) => setNameFilter(e.target.value)}
                    className="pl-8 h-9 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Sync status
                </label>
                <Select
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as SyncFilter)}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="synced">Synced</SelectItem>
                    <SelectItem value="behind">Behind</SelectItem>
                    <SelectItem value="diverged">Diverged</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Last updated
                </label>
                <Select value={timeFilter} onValueChange={(v) => setTimeFilter(v as TimeFilter)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any time</SelectItem>
                    <SelectItem value="24h">Last 24 hours</SelectItem>
                    <SelectItem value="7d">Last 7 days</SelectItem>
                    <SelectItem value="30d">Last 30 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Error type
                </label>
                <Select
                  value={errorTypeFilter}
                  onValueChange={(v) => setErrorTypeFilter(v as ErrorTypeFilter)}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ERROR_TYPE_LABELS) as ErrorTypeFilter[]).map((k) => (
                      <SelectItem
                        key={k}
                        value={k}
                        disabled={k !== "all" && errorBreakdown[k] === 0}
                      >
                        {ERROR_TYPE_LABELS[k]}
                        {k !== "all" && errorBreakdown[k] > 0 && (
                          <span className="ml-1 text-muted-foreground">({errorBreakdown[k]})</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Error category breakdown row */}
            {errorBreakdown.all > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {(["auth", "conflict", "timeout", "network", "other"] as const).map((k) =>
                  errorBreakdown[k] > 0 ? (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setErrorTypeFilter(k === errorTypeFilter ? "all" : k)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors",
                        k === errorTypeFilter
                          ? "border-destructive/60 bg-destructive/10 text-destructive"
                          : "border-border text-muted-foreground hover:border-destructive/40 hover:text-destructive",
                      )}
                    >
                      <span className="font-semibold">{errorBreakdown[k]}</span>
                      {ERROR_TYPE_LABELS[k]}
                    </button>
                  ) : null,
                )}
              </div>
            )}

            <div className="mt-2 mb-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={selectAllFiltered}
                    onCheckedChange={(checked) => {
                      if (checked === true && !selectAllFiltered) {
                        setShowSelectAllConfirm(true);
                      } else {
                        setSelectAllFiltered(false);
                      }
                    }}
                  />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Select all filtered ({filteredClones.length})
                  </span>
                </label>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {filteredClones.length} of {clones.length} clones match
                </span>
                {/* Inline confirmation for select-all */}
                {showSelectAllConfirm && (
                  <div className="flex items-center gap-2 border border-warning/40 bg-warning/5 px-2.5 py-1.5 animate-in fade-in slide-in-from-left-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
                    <span className="font-mono text-[10px] text-warning">
                      Include <strong>{filteredClones.length}</strong> clone
                      {filteredClones.length !== 1 ? "s" : ""} in cascade?
                    </span>
                    <Button
                      size="sm"
                      variant="default"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => {
                        setSelectAllFiltered(true);
                        setShowSelectAllConfirm(false);
                      }}
                    >
                      Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => setShowSelectAllConfirm(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setNameFilter("");
                    setStatusFilter("all");
                    setTimeFilter("all");
                    setErrorTypeFilter("all");
                  }}
                  className="font-mono text-[10px] text-primary hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          </CardContent>
        )}

        {/* Dry-run preview */}
        {dryRun && progress.length > 0 && !running && (
          <CardContent className="border-t border-border pt-4">
            <div className="border border-info/30 bg-info/5 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Eye className="h-4 w-4 text-info" />
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-info">
                  Dry-run preview
                </span>
              </div>
              <p className="text-xs text-muted-foreground mb-2">
                These {progress.length} clones would be updated. Disable dry-run and click Cascade
                to execute.
              </p>
              <ul className="space-y-1">
                {progress.map((p) => (
                  <li
                    key={p.clone_id}
                    className="flex items-center gap-2 border border-border px-2 py-1.5 text-xs"
                  >
                    <div className="h-2 w-2 rounded-full bg-info" />
                    <span className="font-mono">{p.name}</span>
                    <Badge variant="outline" className="ml-auto text-[9px]">
                      will update
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        )}

        {progress.length > 0 && !dryRun && (
          <CardContent className="space-y-4">
            {/* Progress bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  Progress
                  {running && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-info/40 bg-info/10 px-1.5 py-0.5 text-[9px] text-info">
                      <Radio className="h-2.5 w-2.5 animate-pulse" /> live
                    </span>
                  )}
                  {eventId && (
                    <CopyButton
                      value={eventId}
                      label="cascade event id"
                      size="xs"
                      showValue
                      truncate={10}
                    />
                  )}
                </div>
                <div className="flex items-center gap-3 font-mono text-[11px]">
                  <span className="text-success">{succeeded} ok</span>
                  {failed > 0 && <span className="text-destructive">{failed} failed</span>}
                  <span className="text-muted-foreground">
                    {completed}/{total} · {pct}%
                  </span>
                </div>
              </div>
              <Progress value={pct} className="h-2" />
            </div>

            {/* Retry failed */}
            {failed > 0 && !running && (
              <div className="flex items-center justify-between border border-destructive/30 bg-destructive/5 px-3 py-2">
                <span className="font-mono text-xs text-destructive">
                  {errorTypeFilter !== "all"
                    ? `${errorBreakdown[errorTypeFilter]} ${ERROR_TYPE_LABELS[errorTypeFilter].toLowerCase()} failure${errorBreakdown[errorTypeFilter] !== 1 ? "s" : ""}`
                    : `${failed} clone${failed > 1 ? "s" : ""} failed`}
                </span>
                <Button variant="destructive" size="sm" onClick={retryFailed}>
                  <RotateCcw className="mr-1.5 h-3 w-3" />
                  {errorTypeFilter !== "all"
                    ? `Retry ${ERROR_TYPE_LABELS[errorTypeFilter].toLowerCase()} (${errorBreakdown[errorTypeFilter]})`
                    : `Retry failed (${failed})`}
                </Button>
              </div>
            )}

            {/* Toggle details */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              className="w-full"
            >
              {expanded ? (
                <ChevronUp className="mr-2 h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="mr-2 h-3.5 w-3.5" />
              )}
              {expanded ? "Hide details" : "Show per-clone details"}
            </Button>

            {/* Per-clone rows */}
            {expanded && (
              <ul className="space-y-1">
                {filteredProgress.map((p) => (
                  <li
                    key={p.clone_id}
                    className="flex items-center gap-3 border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <StatusIcon status={p.status} />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs font-medium truncate">{p.name}</div>
                      {p.error && (
                        <div className="flex items-center gap-1.5">
                          <div className="font-mono text-[10px] text-destructive truncate">
                            {p.error}
                          </div>
                          {p.status === "failed" && (
                            <Badge
                              variant="outline"
                              className="text-[8px] uppercase shrink-0 border-destructive/30 text-destructive"
                            >
                              {classifyError(p.error)}
                            </Badge>
                          )}
                        </div>
                      )}
                      {p.pr_url && (
                        <a
                          href={p.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-[10px] text-primary hover:underline"
                        >
                          View PR →
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {(p.status === "failed" || p.status === "succeeded") &&
                        p.previous_sha &&
                        p.error !== "Rolled back" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={() =>
                              setRollbackTarget({
                                clone_id: p.clone_id,
                                name: p.name,
                                previous_sha: p.previous_sha!,
                              })
                            }
                          >
                            <Undo2 className="mr-1 h-3 w-3" />
                            Rollback
                          </Button>
                        )}
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[9px] uppercase",
                          p.status === "succeeded" && "border-success/40 text-success",
                          p.status === "failed" && "border-destructive/40 text-destructive",
                          p.status === "running" && "border-info/40 text-info animate-pulse",
                          (p.status === "queued" || p.status === "skipped") &&
                            "border-muted text-muted-foreground",
                        )}
                      >
                        {p.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        )}
      </Card>

      {/* Rollback confirmation dialog */}
      <AlertDialog
        open={!!rollbackTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRollbackTarget(null);
            setRollbackConfirmText("");
            setRollbackReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Confirm rollback
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This will revert{" "}
                  <strong className="text-foreground">{rollbackTarget?.name}</strong> to SHA{" "}
                  <code className="bg-muted px-1 py-0.5 text-[11px]">
                    {rollbackTarget?.previous_sha?.slice(0, 12)}
                  </code>
                  .
                </p>
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Reason for rollback <span className="text-destructive">*</span>
                    <span className="ml-2 normal-case tracking-normal text-muted-foreground">
                      ({rollbackReason.trim().length}/500)
                    </span>
                  </label>
                  <Textarea
                    placeholder="e.g. Cascade introduced a breaking change in auth module…"
                    value={rollbackReason}
                    onChange={(e) => {
                      if (e.target.value.length <= 500) setRollbackReason(e.target.value);
                    }}
                    className={cn(
                      "text-sm min-h-[60px]",
                      rollbackReason.trim().length > 0 &&
                        rollbackReason.trim().length < 10 &&
                        "border-destructive focus-visible:ring-destructive",
                    )}
                    rows={2}
                  />
                  {rollbackReason.trim().length > 0 && rollbackReason.trim().length < 10 && (
                    <p className="mt-1 font-mono text-[10px] text-destructive">
                      Reason must be at least 10 characters ({10 - rollbackReason.trim().length}{" "}
                      more needed)
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Type clone name to confirm
                  </label>
                  <Input
                    placeholder={rollbackTarget?.name ?? ""}
                    value={rollbackConfirmText}
                    onChange={(e) => setRollbackConfirmText(e.target.value)}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                rollbackConfirmText !== rollbackTarget?.name ||
                rollbackReason.trim().length < 10 ||
                rollbackReason.trim().length > 500
              }
              onClick={executeRollback}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Undo2 className="mr-1.5 h-3.5 w-3.5" />
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StatusIcon({ status }: { status: CloneProgress["status"] }) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
    case "running":
      return <Loader2 className="h-3.5 w-3.5 shrink-0 text-info animate-spin" />;
    default:
      return (
        <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/30" />
      );
  }
}
