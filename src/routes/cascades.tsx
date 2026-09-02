import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { useCascadeEvents, useClones } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Waves,
  GitMerge,
  Send,
  Bell,
  ChevronRight,
  Package,
  Bot,
  X,
  CalendarClock,
  Tag,
  Download,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { exportRowsAsCSV } from "@/lib/csv";
import { SavedViewsBar } from "@/components/saved-views-bar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { describeCascadeOutcome } from "@/lib/cascadeRunOutcome";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useServerFn } from "@tanstack/react-start";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";
import { runCascade } from "@/server/cascade-engine.functions";
import { BulkCascadeCard } from "@/components/bulk-cascade-card";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { EmptyState } from "@/components/empty-state";
import {
  CascadeTemplatesCard,
  type CascadeTemplateValue,
} from "@/components/cascade-templates-card";
import { CascadeDryRunCard } from "@/components/cascade-dryrun-card";
import { assessBlastRadius } from "@/lib/blast-radius";
import { ShieldAlert, Sparkles, Loader2 } from "lucide-react";
import { aiCascadeSummary } from "@/server/ai-features.functions";

const MODE_VALUES = ["pr", "auto_merge", "notify"] as const;
const SCOPE_VALUES = ["all", "tagged", "selected"] as const;

const searchSchema = z.object({
  mode: fallback(z.enum(MODE_VALUES), "pr").default("pr"),
  scope: fallback(z.enum(SCOPE_VALUES), "all").default("all"),
  tags: fallback(z.string(), "").default(""),
  schedule_id: fallback(z.string().uuid().optional(), undefined).optional(),
});

export const Route = createFileRoute("/cascades")({
  errorComponent: RouteError,
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <CascadesPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Cascades — Aurixa Systems Mission Control" }] }),
});

type Mode = (typeof MODE_VALUES)[number];

function CascadesPage() {
  const { data: events, loading: eventsLoading, error: eventsError, refresh } = useCascadeEvents();
  const { data: clones } = useClones();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/cascades" });
  const mode = search.mode;
  const scope = search.scope;
  const scheduleId = search.schedule_id;
  const selectedTags = (search.tags ?? "").split(",").filter(Boolean);

  // Collect all unique tags from the fleet
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of clones) for (const t of c.tags ?? []) set.add(t);
    return Array.from(set).sort();
  }, [clones]);

  // Filter clones by selected tags
  const tagFilteredClones = useMemo(() => {
    if (scope !== "tagged" || selectedTags.length === 0) return clones;
    return clones.filter((c) => selectedTags.some((t: string) => (c.tags ?? []).includes(t)));
  }, [clones, scope, selectedTags]);

  type SearchState = typeof search;
  const setMode = useCallback(
    (m: Mode) =>
      void navigate({
        search: (prev: SearchState) => ({ ...prev, mode: m }),
        replace: true,
      }),
    [navigate],
  );
  const setScope = useCallback(
    (s: (typeof SCOPE_VALUES)[number]) =>
      void navigate({
        search: (prev: SearchState) => ({ ...prev, scope: s }),
        replace: true,
      }),
    [navigate],
  );
  const setTags = useCallback(
    (tags: string[]) =>
      void navigate({
        search: (prev: SearchState) => ({ ...prev, tags: tags.join(",") }),
        replace: true,
      }),
    [navigate],
  );
  const toggleTag = useCallback(
    (tag: string) => {
      const set = new Set(selectedTags);
      if (set.has(tag)) set.delete(tag);
      else set.add(tag);
      setTags(Array.from(set) as string[]);
    },
    [selectedTags, setTags],
  );
  const clearScheduleFilter = useCallback(
    () =>
      void navigate({
        search: (prev: SearchState) => ({ ...prev, schedule_id: undefined }),
        replace: true,
      }),
    [navigate],
  );

  // When filtering by schedule_id, look up cascade_event_ids from audit_log
  // (schedule.executed rows) and intersect with the events list.
  const [scheduleEventIds, setScheduleEventIds] = useState<Set<string> | null>(null);
  const [scheduleName, setScheduleName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!scheduleId) {
      setScheduleEventIds(null);
      setScheduleName(null);
      return;
    }
    (async () => {
      const [{ data: audit }, { data: sched }] = await Promise.all([
        supabase
          .from("audit_log")
          .select("metadata")
          .eq("action", "schedule.executed")
          .eq("entity_type", "cascade_schedule")
          .eq("entity_id", scheduleId)
          .order("created_at", { ascending: false })
          .limit(500),
        supabase.from("cascade_schedules").select("name").eq("id", scheduleId).maybeSingle(),
      ]);
      if (cancelled) return;
      const ids = new Set<string>();
      for (const a of audit ?? []) {
        const m = (a.metadata ?? {}) as { cascade_event_id?: string | null };
        if (m.cascade_event_id) ids.add(m.cascade_event_id);
      }
      setScheduleEventIds(ids);
      setScheduleName(sched?.name ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  const visibleEvents = scheduleEventIds
    ? events.filter((e) => scheduleEventIds.has(e.id))
    : events;

  const [busy, setBusy] = useState(false);
  const runCascadeFn = useServerFn(runCascade);

  // Realtime: when any operator inserts/updates/deletes a cascade event
  // (e.g. another operator approves and the engine flips status to running),
  // refresh the list so we don't show stale "pending" rows. Debounced so a
  // busy cascade (many row updates in a burst) coalesces into one refetch.
  const debouncedRefresh = useDebouncedCallback(() => refresh(), 400);
  useEffect(() => {
    const channel = supabase
      .channel("cascades-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "cascade_events" }, () =>
        debouncedRefresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [debouncedRefresh]);

  // Effective target list based on scope
  const targets = scope === "tagged" && selectedTags.length > 0 ? tagFilteredClones : clones;

  // Live blast-radius preview based on current scope/mode + clone count.
  const blast = assessBlastRadius(mode, targets.length);

  const fire = async () => {
    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: ev, error } = await supabase
      .from("cascade_events")
      .insert({
        trigger: "manual",
        mode,
        status: "pending",
        scope_filter: {
          scope,
          ...(scope === "tagged" ? { tags: selectedTags } : {}),
        },
        initiated_by: user?.id,
        requires_approval: blast.requiresApproval,
      })
      .select()
      .single();
    if (error || !ev) {
      toast.error(error?.message || "Failed to start cascade");
      setBusy(false);
      return;
    }
    if (targets.length > 0) {
      await supabase.from("cascade_results").insert(
        targets.map((c) => ({
          cascade_event_id: ev.id,
          clone_id: c.id,
          status: "queued" as const,
        })),
      );
    }

    if (blast.requiresApproval) {
      // Pin a workspace-wide notification so other operators see it immediately.
      await supabase.from("notifications").insert({
        kind: "cascade_awaiting_approval",
        severity: "warning",
        title: `Approval needed · ${mode.replace("_", " ")} cascade`,
        body: `${blast.reason} Initiated by you — needs a second operator to approve.`,
        cascade_event_id: ev.id,
        url: `/cascades/${ev.id}`,
        metadata: { mode, clone_count: targets.length },
      });
      await supabase.from("audit_log").insert({
        action: "cascade.awaiting_approval",
        entity_type: "cascade_event",
        entity_id: ev.id,
        actor_user_id: user?.id,
        metadata: { mode, clone_count: targets.length, reason: blast.reason },
      });
      toast.warning("Approval required — second operator must approve before this runs.");
      void navigate({ to: "/cascades/$eventId", params: { eventId: ev.id } });
      setBusy(false);
      refresh();
      return;
    }

    toast.info(`Queued ${targets.length} clones — executing…`);
    refresh();

    try {
      const res = await runCascadeFn({ data: { cascadeEventId: ev.id } });
      const outcome = describeCascadeOutcome(res);
      toast[outcome.level](outcome.message);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Engine failed");
    }
    setBusy(false);
    refresh();
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="label-mono">waterfall</p>
        <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">Cascades</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Push prime updates downstream. Strictly one-direction — clones never push back.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New cascade</CardTitle>
          <CardDescription>
            Filter by module is automatic — only files belonging to modules each clone has installed
            get applied.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              mode
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <ModeCard
                active={mode === "pr"}
                icon={<GitMerge />}
                title="Open PR"
                desc="Safe — review before merging."
                onClick={() => setMode("pr")}
              />
              <ModeCard
                active={mode === "auto_merge"}
                icon={<Send />}
                title="Auto-merge"
                desc="Push & merge automatically."
                onClick={() => setMode("auto_merge")}
              />
              <ModeCard
                active={mode === "notify"}
                icon={<Bell />}
                title="Notify only"
                desc="No commits — just flag drift."
                onClick={() => setMode("notify")}
              />
            </div>
          </div>
          <div>
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              scope
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={scope === "all" ? "default" : "outline"}
                onClick={() => setScope("all")}
              >
                All clones ({clones.length})
              </Button>
              <Button
                variant={scope === "tagged" ? "default" : "outline"}
                onClick={() => setScope("tagged")}
              >
                <Tag className="mr-1.5 h-3.5 w-3.5" /> By tag
                {scope === "tagged" && selectedTags.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px]">
                    {tagFilteredClones.length}
                  </Badge>
                )}
              </Button>
              <Button
                variant={scope === "selected" ? "default" : "outline"}
                onClick={() => setScope("selected")}
              >
                Manual select
              </Button>
            </div>
            {scope === "tagged" && (
              <div className="mt-3 space-y-2">
                {allTags.length === 0 ? (
                  <div className="border border-dashed p-3 text-center font-mono text-[11px] text-muted-foreground">
                    No tags found. Tag your clones first from the fleet overview.
                  </div>
                ) : (
                  <>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      select tags · {selectedTags.length} active → {tagFilteredClones.length} clone
                      {tagFilteredClones.length === 1 ? "" : "s"}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {allTags.map((tag) => {
                        const active = selectedTags.includes(tag);
                        const count = clones.filter((c) => (c.tags ?? []).includes(tag)).length;
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                              active
                                ? "border-primary/50 bg-primary/10 text-primary"
                                : "border-border bg-surface text-muted-foreground hover:border-primary/30 hover:text-foreground",
                            )}
                          >
                            <Tag className="h-3 w-3" />#{tag}
                            <span
                              className={cn(
                                "ml-0.5 rounded-full px-1 text-[9px]",
                                active ? "bg-primary/20" : "bg-muted",
                              )}
                            >
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {selectedTags.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] text-muted-foreground"
                        onClick={() => setTags([])}
                      >
                        Clear all tags
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          {blast.requiresApproval && (
            <div className="flex items-start gap-2 border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <div className="font-mono uppercase tracking-wider">Approval gate</div>
                <div className="mt-0.5 font-mono text-[11px] text-warning/90">
                  {blast.reason} The cascade will queue and wait — no GitHub changes happen until a
                  different operator approves on the cascade detail page.
                </div>
              </div>
            </div>
          )}
          <AiPreflightSummary
            scope={scope}
            mode={mode}
            cloneCount={targets.length}
            tags={selectedTags}
          />
          <div className="flex items-center justify-between">
            <div className="font-mono text-[11px] text-muted-foreground">
              {scope === "tagged" && selectedTags.length > 0
                ? `${tagFilteredClones.length} clone${tagFilteredClones.length === 1 ? "" : "s"} matching tags`
                : `${clones.length} clone${clones.length === 1 ? "" : "s"} in fleet`}
            </div>
            <Button onClick={fire} disabled={busy || targets.length === 0}>
              <Waves className="mr-2 h-4 w-4" />
              {busy
                ? "Queueing…"
                : blast.requiresApproval
                  ? `Queue for approval (${targets.length})`
                  : `Fire cascade (${targets.length})`}
            </Button>
          </div>
        </CardContent>
      </Card>

      <BulkCascadeCard />

      <CascadeDryRunCard />

      <CascadeTemplatesCard
        current={{
          mode,
          scope: scope as "all" | "tagged" | "selected",
          tags: selectedTags,
          cloneIds: [],
        }}
        onApply={(v: CascadeTemplateValue) => {
          setMode(v.mode);
          if (v.scope === "all" || v.scope === "tagged" || v.scope === "selected")
            setScope(v.scope as (typeof SCOPE_VALUES)[number]);
          else setScope("selected");
          if (v.tags.length > 0) setTags(v.tags);
        }}
      />

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="label-mono">history</h2>
          <div className="flex items-center gap-2">
            {scheduleId && (
              <button
                type="button"
                onClick={clearScheduleFilter}
                className="inline-flex items-center gap-1.5 border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/20"
              >
                <CalendarClock className="h-3 w-3" />
                schedule · {scheduleName ?? scheduleId.slice(0, 8)}
                <X className="h-3 w-3" />
              </button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={visibleEvents.length === 0}
              onClick={() => {
                exportRowsAsCSV(
                  `cascades-${new Date().toISOString().slice(0, 10)}.csv`,
                  visibleEvents.map((e) => ({
                    id: e.id,
                    created_at: e.created_at,
                    trigger: e.trigger,
                    mode: e.mode,
                    status: e.status,
                    requires_approval: e.requires_approval,
                    initiated_by: e.initiated_by ?? "",
                    scope_filter: e.scope_filter,
                  })),
                );
                toast.success(`Exported ${visibleEvents.length} cascades`);
              }}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export
            </Button>
          </div>
        </div>
        <div className="mb-3">
          <SavedViewsBar<{ mode: Mode; scope: typeof scope; tags: string }>
            storageKey="cascades"
            current={{ mode, scope, tags: selectedTags.join(",") }}
            onApply={(v) => {
              setMode(v.mode);
              setScope(v.scope);
              setTags(v.tags ? v.tags.split(",").filter(Boolean) : []);
            }}
          />
        </div>
        {eventsLoading ? (
          <div className="space-y-2">
            <CardRowSkeleton />
            <CardRowSkeleton />
            <CardRowSkeleton />
          </div>
        ) : eventsError ? (
          <EmptyState
            icon={<AlertTriangle />}
            title="Couldn't load cascades"
            description={eventsError}
            action={
              <Button variant="outline" onClick={() => void refresh()}>
                <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
              </Button>
            }
          />
        ) : visibleEvents.length === 0 ? (
          <EmptyState
            icon={<Waves />}
            title={scheduleId ? "No fires for this schedule" : "No cascades yet"}
            description={
              scheduleId
                ? "This schedule has not produced any cascade events yet, or they have been cleaned up."
                : "Fire your first cascade above to push prime updates downstream. Every run lands in this history."
            }
          />
        ) : (
          <div className="space-y-2">
            {visibleEvents.map((e) => (
              <Link key={e.id} to="/cascades/$eventId" params={{ eventId: e.id }} className="block">
                <Card className="transition-colors hover:border-primary/40">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center bg-info/15 text-info">
                        <Waves className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium">
                            {e.mode.replace("_", " ")}
                          </span>
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {e.trigger}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={cn("text-[10px] uppercase", statusTone(e.status))}
                          >
                            {e.status}
                          </Badge>
                          {(() => {
                            const sf = (e.scope_filter ?? {}) as {
                              scope?: string;
                              module_name?: string;
                              module_globs?: string[];
                              auto_applied?: boolean;
                            };
                            return sf.auto_applied ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="inline-flex items-center gap-1 border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent"
                                    onClick={(ev) => ev.preventDefault()}
                                  >
                                    <Bot className="h-3 w-3" />
                                    auto-applied
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Triggered by a per-clone AI auto-apply policy
                                </TooltipContent>
                              </Tooltip>
                            ) : null;
                          })()}
                          {(() => {
                            const sf = (e.scope_filter ?? {}) as {
                              scope?: string;
                              module_name?: string;
                              module_globs?: string[];
                            };
                            if (sf.scope !== "module_sync") return null;
                            const globCount = sf.module_globs?.length ?? 0;
                            return (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="inline-flex items-center gap-1 border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary"
                                    onClick={(ev) => ev.preventDefault()}
                                  >
                                    <Package className="h-3 w-3" />
                                    module · {sf.module_name ?? "scoped"}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  Scoped module sync — pushes only {globCount} glob
                                  {globCount === 1 ? "" : "s"}
                                </TooltipContent>
                              </Tooltip>
                            );
                          })()}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {formatDistanceToNow(e.created_at)}
                          {e.summary && <> · {e.summary}</>}
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function statusTone(s: string) {
  switch (s) {
    case "completed":
      return "border-success/40 text-success";
    case "failed":
      return "border-destructive/40 text-destructive";
    case "running":
      return "border-info/40 text-info animate-pulse";
    case "partial":
      return "border-warning/40 text-warning";
    default:
      return "border-muted text-muted-foreground";
  }
}

function ModeCard({
  active,
  icon,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border p-3 text-left transition-colors",
        active ? "border-primary bg-primary/5" : "border-border hover:border-primary/40",
      )}
    >
      <div
        className={cn(
          "mb-2 [&>svg]:h-4 [&>svg]:w-4",
          active ? "text-primary" : "text-muted-foreground",
        )}
      >
        {icon}
      </div>
      <div className="font-mono text-sm font-semibold">{title}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
    </button>
  );
}

function AiPreflightSummary({
  scope,
  mode,
  cloneCount,
  tags,
}: {
  scope: string;
  mode: string;
  cloneCount: number;
  tags: string[];
}) {
  const fn = useServerFn(aiCascadeSummary);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const r = await fn({
        data: {
          scope: tags.length > 0 ? `${scope}:${tags.join(",")}` : scope,
          mode,
          cloneCount,
          affectedModules: [],
        },
      });
      setSummary(r.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI failed");
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="border bg-surface/50 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI pre-flight briefing
        </div>
        <Button size="sm" variant="ghost" disabled={loading || cloneCount === 0} onClick={run}>
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          {summary ? "Re-summarize" : "Summarize"}
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      {summary && (
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
          {summary}
        </pre>
      )}
    </div>
  );
}
