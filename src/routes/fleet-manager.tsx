import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, Activity, AlertTriangle, Sparkles, GitCommit, RefreshCw, Zap, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClones, type Clone } from "@/lib/queries";
import { useServerFn } from "@tanstack/react-start";
import { triggerFleetDriftScan } from "@/server/fleet-drift.functions";
import { refreshFleetDrift } from "@/server/drift-refresh.functions";
import { runCascade } from "@/server/cascade-engine.functions";
import { DriftListSkeleton } from "@/components/list-skeletons";
import { FleetMigrationSyncCard } from "@/components/fleet-migration-sync-card";
import { ReferenceDataSyncCard } from "@/components/reference-data-sync-card";
import { PrimeLedgerReconciliationCard } from "@/components/prime-ledger-reconciliation-card";
import { BulkLibraryPinsDialog } from "@/components/bulk-library-pins-dialog";
import { EmptyState } from "@/components/empty-state";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

const CASCADE_MODE_VALUES = ["pr", "auto_merge", "notify"] as const;

const searchSchema = z.object({
  mode: fallback(z.enum(CASCADE_MODE_VALUES), "pr").default("pr"),
  selected: fallback(z.string().array(), []).default([]),
});

export const Route = createFileRoute("/fleet-manager")({
  errorComponent: RouteError,
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <FleetManager />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "AI Manager — Aurixa Systems Mission Control" }] }),
});

type DriftSuggestion = {
  severity: "low" | "medium" | "high";
  title: string;
  rationale: string;
  recommended_action: "cascade_pr" | "cascade_auto_merge" | "notify" | "review";
};

function actionToMode(action: DriftSuggestion["recommended_action"]): CascadeMode | null {
  if (action === "cascade_pr") return "pr";
  if (action === "cascade_auto_merge") return "auto_merge";
  if (action === "notify") return "notify";
  return null;
}

function FleetManager() {
  const { data: clones, loading: clonesLoading, error: clonesError, refresh } = useClones();
  const drift = useMemo(
    () => clones.filter((c) => c.sync_status === "behind" || c.sync_status === "failed"),
    [clones],
  );
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/fleet-manager" });
  type SearchState = typeof search;

  const [scanning, setScanning] = useState(false);
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const [bulkApplying, setBulkApplying] = useState(false);
  const scanFn = useServerFn(triggerFleetDriftScan);
  const driftRefreshFn = useServerFn(refreshFleetDrift);
  const cascadeFn = useServerFn(runCascade);

  // Silent drift refresh: real GitHub commits-behind compare on mount + every 5 min.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await driftRefreshFn();
        if (!cancelled && res.ok && res.updated > 0) {
          refresh();
        }
      } catch {
        // Silent — failures are surfaced via per-clone sync_status updates
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const driftIds = useMemo(() => drift.map((c) => c.id), [drift]);

  const selected = useMemo<Set<string>>(
    () => new Set((search.selected as string[]).filter((id) => driftIds.includes(id))),
    [search.selected, driftIds],
  );
  const bulkMode = search.mode;

  // Prune stale selection ids from the URL once the drift list resolves.
  useEffect(() => {
    if (search.selected.length === 0) return;
    const filtered = (search.selected as string[]).filter((id) => driftIds.includes(id));
    if (filtered.length !== search.selected.length) {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, selected: filtered }),
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driftIds.join("|")]);

  const setSelected = useCallback(
    (next: Set<string>) => {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, selected: Array.from(next) }),
        replace: true,
      });
    },
    [navigate],
  );

  const setBulkMode = useCallback(
    (m: CascadeMode) =>
      void navigate({
        search: (prev: SearchState) => ({ ...prev, mode: m }),
        replace: true,
      }),
    [navigate],
  );

  const lastScan = clones
    .map((c) => c.last_drift_check_at)
    .filter(Boolean)
    .sort()
    .at(-1) as string | undefined;

  const allSelected = driftIds.length > 0 && driftIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(driftIds));
  };

  const clearSelection = () => setSelected(new Set());

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await scanFn();
      if (!res.ok) toast.error(res.error);
      else toast.success(`Scanned ${res.scanned} clones — ${res.updated} updated`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const applySuggestion = async (
    cloneId: string,
    cloneName: string,
    suggestionIndex: number,
    action: DriftSuggestion["recommended_action"],
  ) => {
    const key = `${cloneId}:${suggestionIndex}`;
    const mode = actionToMode(action);
    if (!mode) {
      toast.info("This suggestion is review-only — no cascade to apply.");
      return;
    }

    setApplyingKey(key);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data: ev, error } = await supabase
        .from("cascade_events")
        .insert({
          trigger: "manual",
          mode,
          status: "pending",
          scope_filter: { scope: "selected", clone_ids: [cloneId], source: "drift_suggestion" },
          initiated_by: user?.id,
        })
        .select()
        .single();
      if (error || !ev) throw new Error(error?.message ?? "Failed to create cascade");

      const { error: insErr } = await supabase
        .from("cascade_results")
        .insert({ cascade_event_id: ev.id, clone_id: cloneId, status: "queued" });
      if (insErr) throw new Error(insErr.message);

      toast.info(`Applying ${mode.replace("_", " ")} to ${cloneName}…`);
      const res = await cascadeFn({ data: { cascadeEventId: ev.id } });
      if (!res.ok) {
        toast.error(res.error);
      } else {
        toast.success(`Cascade ${res.status} for ${cloneName}`);
        navigate({ to: "/cascades/$eventId", params: { eventId: ev.id } });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setApplyingKey(null);
      refresh();
    }
  };

  const applyBulk = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkApplying(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data: ev, error } = await supabase
        .from("cascade_events")
        .insert({
          trigger: "manual",
          mode: bulkMode,
          status: "pending",
          scope_filter: {
            scope: "selected",
            clone_ids: ids,
            source: "fleet_manager_bulk",
          },
          initiated_by: user?.id,
        })
        .select()
        .single();
      if (error || !ev) throw new Error(error?.message ?? "Failed to create cascade");

      const rows = ids.map((cloneId) => ({
        cascade_event_id: ev.id,
        clone_id: cloneId,
        status: "queued" as const,
      }));
      const { error: insErr } = await supabase.from("cascade_results").insert(rows);
      if (insErr) throw new Error(insErr.message);

      toast.info(
        `Applying ${bulkMode.replace("_", " ")} to ${ids.length} clone${ids.length === 1 ? "" : "s"}…`,
      );
      const res = await cascadeFn({ data: { cascadeEventId: ev.id } });
      if (!res.ok) toast.error(res.error);
      else toast.success(`Bulk cascade ${res.status} (${ids.length})`);

      clearSelection();
      navigate({ to: "/cascades/$eventId", params: { eventId: ev.id } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk apply failed");
    } finally {
      setBulkApplying(false);
      refresh();
    }
  };

  const totalSuggestions = clones.reduce(
    (n, c) => n + ((c.drift_suggestions as DriftSuggestion[] | null)?.length ?? 0),
    0,
  );

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
          <Bot className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="label-mono">ai</p>
          <h1 className="font-display text-[2.125rem] leading-[1.05]">Fleet Manager</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="border-success/40 text-success">
            <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            background sweep active
          </Badge>
          <BulkLibraryPinsDialog clones={clones} defaultSelected={Array.from(selected)} />
          <Button size="sm" onClick={runScan} disabled={scanning}>
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", scanning && "animate-spin")} />
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-3">
        <SignalCard
          icon={<Activity />}
          label="Last sweep"
          value={lastScan ? formatDistanceToNow(lastScan) : "—"}
          tone="info"
        />
        <SignalCard
          icon={<AlertTriangle />}
          label="Drift detected"
          value={String(drift.length)}
          tone="warning"
        />
        <SignalCard
          icon={<GitCommit />}
          label="AI suggestions"
          value={String(totalSuggestions)}
          tone="success"
        />
      </div>

      <FleetMigrationSyncCard />
      {/*
        Directly under the sync, because it answers the question the sync
        raises. `withheld (not applied on the prime)` is a count on that card
        and a count is all it can be: a version absent from the prime's ledger
        is either one the prime never ran or one it ran untracked, and the two
        have opposite remedies. This is the reading that tells them apart.
      */}
      <PrimeLedgerReconciliationCard />
      <ReferenceDataSyncCard />

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-accent" /> Suggested cascades
              </CardTitle>
              <CardDescription>
                AI inspects each clone vs prime and recommends concrete next actions.
              </CardDescription>
            </div>
            {drift.length > 0 && (
              <label className="flex shrink-0 cursor-pointer items-center gap-2 border border-border bg-surface px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleAll}
                />
                Select all ({drift.length})
              </label>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {clonesLoading ? (
            <DriftListSkeleton count={3} />
          ) : clonesError ? (
            <EmptyState
              icon={<AlertTriangle />}
              title="Couldn't load the fleet"
              description={clonesError}
              action={
                <Button variant="outline" onClick={() => void refresh()}>
                  <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
                </Button>
              }
            />
          ) : drift.length === 0 ? (
            <EmptyState
              icon={<Activity />}
              title="Fleet in sync"
              description="No drift detected. The autonomous sweeper will surface new findings here as they emerge."
            />
          ) : (
            <ul className="space-y-3">
              {drift.map((c) => (
                <DriftCloneRow
                  key={c.id}
                  clone={c}
                  selected={selected.has(c.id)}
                  onToggle={() => toggleOne(c.id)}
                  applyingKey={applyingKey}
                  onApply={applySuggestion}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected.size > 0 && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-full max-w-3xl items-center gap-3 border border-primary/40 bg-background/95 p-3 shadow-lg supports-[backdrop-filter]:bg-background/80">
          <Badge variant="outline" className="border-primary/40 text-primary">
            {selected.size} selected
          </Badge>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            Apply the same cascade to all selected clones
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Select
              value={bulkMode}
              onValueChange={(v) => setBulkMode(v as CascadeMode)}
              disabled={bulkApplying}
            >
              <SelectTrigger className="h-8 w-[150px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pr">Open PRs</SelectItem>
                <SelectItem value="auto_merge">Auto-merge</SelectItem>
                <SelectItem value="notify">Notify only</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={applyBulk} disabled={bulkApplying}>
              <Zap className={cn("mr-1.5 h-3.5 w-3.5", bulkApplying && "animate-pulse")} />
              {bulkApplying ? "Applying…" : `Apply to ${selected.size}`}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={clearSelection}
              disabled={bulkApplying}
              aria-label="Clear selection"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DriftCloneRow({
  clone,
  selected,
  onToggle,
  applyingKey,
  onApply,
}: {
  clone: Clone;
  selected: boolean;
  onToggle: () => void;
  applyingKey: string | null;
  onApply: (
    cloneId: string,
    cloneName: string,
    suggestionIndex: number,
    action: DriftSuggestion["recommended_action"],
  ) => void;
}) {
  const sugg = (clone.drift_suggestions as DriftSuggestion[] | null) ?? [];
  return (
    <li
      className={cn(
        "rounded-md border bg-surface p-3 transition-colors",
        selected ? "border-primary/60 ring-1 ring-primary/30" : "border-border",
      )}
    >
      <div className="flex items-center gap-3">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Select ${clone.name}`}
        />
        <div className="flex-1">
          <div className="font-mono text-sm">{clone.name}</div>
          <div className="text-xs text-muted-foreground">
            {clone.commits_behind} commits behind prime
            {clone.last_drift_check_at && (
              <> · checked {formatDistanceToNow(clone.last_drift_check_at)}</>
            )}
          </div>
        </div>
        <Badge variant="outline" className="border-warning/40 text-warning">
          {clone.sync_status}
        </Badge>
      </div>
      {sugg.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t pt-2">
          {sugg.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <Badge
                variant="outline"
                className={cn(
                  "mt-0.5 text-[9px] uppercase",
                  s.severity === "high"
                    ? "border-destructive/40 text-destructive"
                    : s.severity === "medium"
                      ? "border-warning/40 text-warning"
                      : "border-muted text-muted-foreground",
                )}
              >
                {s.severity}
              </Badge>
              <div className="flex-1">
                <div className="font-mono font-medium text-foreground">{s.title}</div>
                <div className="text-muted-foreground">{s.rationale}</div>
                <div className="mt-0.5 font-mono text-[10px] text-accent">
                  → {s.recommended_action.replace("_", " ")}
                </div>
              </div>
              <Button
                size="sm"
                variant={s.recommended_action === "review" ? "ghost" : "outline"}
                disabled={applyingKey === `${clone.id}:${i}` || s.recommended_action === "review"}
                onClick={() => onApply(clone.id, clone.name, i, s.recommended_action)}
                className="shrink-0"
              >
                <Zap
                  className={cn(
                    "mr-1 h-3 w-3",
                    applyingKey === `${clone.id}:${i}` && "animate-pulse",
                  )}
                />
                {applyingKey === `${clone.id}:${i}` ? "Applying…" : "Apply"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SignalCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "info" | "warning" | "success";
}) {
  const c = { info: "text-info", warning: "text-warning", success: "text-success" }[tone];
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className={`mt-2 font-mono text-2xl font-semibold ${c}`}>{value}</div>
        </div>
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-md bg-muted ${c} [&>svg]:h-4 [&>svg]:w-4`}
        >
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}
