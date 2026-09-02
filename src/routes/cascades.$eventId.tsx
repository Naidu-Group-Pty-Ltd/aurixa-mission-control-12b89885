import { createFileRoute, Link, useRouter, useNavigate } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { useEffect, useMemo, useState, useCallback, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  GitMerge,
  Send,
  Bell,
  CircleDot,
  Loader2,
  CheckCircle2,
  XCircle,
  SkipForward,
  GitPullRequest,
  ChevronDown,
  RotateCcw,
  History,
  Package,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { toast } from "sonner";
import { describeCascadeOutcome } from "@/lib/cascadeRunOutcome";
import { useServerFn } from "@tanstack/react-start";
import { useConfirm } from "@/components/confirm-dialog";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";
import { runCascade, cancelCascade } from "@/server/cascade-engine.functions";
import { CascadeLineagePanel } from "@/components/cascade-lineage-panel";
import { InlineDiffSummary } from "@/components/inline-diff-summary";
const RichDiffViewer = lazy(() =>
  import("@/components/rich-diff-viewer").then((m) => ({ default: m.RichDiffViewer })),
);
import { CascadeApprovalBanner } from "@/components/cascade-approval-banner";
import { CascadeTriageCard } from "@/components/cascade-triage-card";
import { CopyButton } from "@/components/copy-button";
import { assessBlastRadius } from "@/lib/blast-radius";

type CascadeEvent = Database["public"]["Tables"]["cascade_events"]["Row"];
type CascadeResult = Database["public"]["Tables"]["cascade_results"]["Row"];
type Clone = Database["public"]["Tables"]["clones"]["Row"];
type PrimeConfig = Database["public"]["Tables"]["prime_config"]["Row"];
type ResultWithClone = CascadeResult & { clone?: Clone | null };

export const Route = createFileRoute("/cascades/$eventId")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <CascadeDetailPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Cascade — Aurixa Systems Mission Control" }] }),
});

function CascadeDetailPage() {
  const { eventId } = Route.useParams();
  const router = useRouter();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [event, setEvent] = useState<CascadeEvent | null>(null);
  const [results, setResults] = useState<ResultWithClone[]>([]);
  const [prime, setPrime] = useState<PrimeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const runCascadeFn = useServerFn(runCascade);
  const cancelCascadeFn = useServerFn(cancelCascade);

  const refresh = useCallback(async () => {
    const [{ data: ev }, { data: res }, { data: pr }] = await Promise.all([
      supabase.from("cascade_events").select("*").eq("id", eventId).maybeSingle(),
      supabase
        .from("cascade_results")
        .select("*, clone:clones(*)")
        .eq("cascade_event_id", eventId)
        .order("created_at", { ascending: true }),
      supabase.from("prime_config").select("*").limit(1).maybeSingle(),
    ]);
    setEvent(ev ?? null);
    setResults((res as ResultWithClone[] | null) ?? []);
    setPrime(pr ?? null);
    setLoading(false);
  }, [eventId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Realtime subscription on cascade_results scoped to this event. The results
  // stream fires rapidly while a cascade runs, so debounce the refetch to
  // coalesce bursts instead of hammering the DB on every row change.
  const debouncedRefresh = useDebouncedCallback(() => refresh(), 400);
  useEffect(() => {
    const channel = supabase
      .channel(`cascade-results-${eventId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "cascade_results",
          filter: `cascade_event_id=eq.${eventId}`,
        },
        () => debouncedRefresh(),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "cascade_events",
          filter: `id=eq.${eventId}`,
        },
        (payload) => setEvent(payload.new as CascadeEvent),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, refresh]);

  const retryFailed = async () => {
    if (!event) return;
    const failedIds = results.filter((r) => r.status === "failed").map((r) => r.id);
    if (failedIds.length === 0) return toast.info("No failed clones to retry");

    setRetrying(true);
    // Reset failed rows to queued
    const { error } = await supabase
      .from("cascade_results")
      .update({
        status: "queued",
        error_message: null,
        started_at: null,
        completed_at: null,
      })
      .in("id", failedIds);

    if (error) {
      toast.error(error.message);
      setRetrying(false);
      return;
    }

    // Reopen the event
    await supabase
      .from("cascade_events")
      .update({ status: "pending", completed_at: null })
      .eq("id", event.id);

    toast.info(`Retrying ${failedIds.length} clone(s)…`);
    try {
      const res = await runCascadeFn({ data: { cascadeEventId: event.id } });
      if (!res.ok) toast.error(res.error);
      else toast.success(`Retry ${res.status}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retry failed");
    }
    setRetrying(false);
    refresh();
  };

  // Helper: create a brand-new cascade event scoped to a set of clones,
  // queue cascade_results, and execute. Used by per-result retry-with-mode
  // and the whole-event rollback action.
  const spawnSubCascade = useCallback(
    async (opts: {
      mode: CascadeEvent["mode"];
      cloneIds: string[];
      summary?: string;
      scopeMeta?: Record<string, unknown>;
      navigateAfter?: boolean;
    }) => {
      if (opts.cloneIds.length === 0) {
        toast.info("No clones to act on");
        return null;
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data: ev, error } = await supabase
        .from("cascade_events")
        .insert({
          trigger: "manual",
          mode: opts.mode,
          status: "pending",
          scope_filter: {
            scope: "selected",
            clone_ids: opts.cloneIds,
            ...(opts.scopeMeta ?? {}),
          },
          summary: opts.summary,
          initiated_by: user?.id,
        })
        .select()
        .single();
      if (error || !ev) {
        toast.error(error?.message || "Failed to start cascade");
        return null;
      }
      const { error: rerr } = await supabase.from("cascade_results").insert(
        opts.cloneIds.map((id) => ({
          cascade_event_id: ev.id,
          clone_id: id,
          status: "queued" as const,
        })),
      );
      if (rerr) {
        toast.error(rerr.message);
        return null;
      }
      try {
        const res = await runCascadeFn({ data: { cascadeEventId: ev.id } });
        const outcome = describeCascadeOutcome(res);
        toast[outcome.level](outcome.message);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Cascade failed");
      }
      if (opts.navigateAfter) {
        void navigate({ to: "/cascades/$eventId", params: { eventId: ev.id } });
      }
      return ev.id;
    },
    [navigate, runCascadeFn],
  );

  const retryWithMode = useCallback(
    async (cloneId: string, mode: CascadeEvent["mode"]) => {
      await spawnSubCascade({
        mode,
        cloneIds: [cloneId],
        summary: `Retry of cascade ${eventId.slice(0, 8)} for one clone in ${mode.replace("_", " ")} mode`,
        scopeMeta: { retry_of: eventId },
        navigateAfter: true,
      });
    },
    [spawnSubCascade, eventId],
  );

  // Rollback: reverse-apply prime by re-running cascade against clones that
  // were touched by this event. We default to PR mode so the rollback is
  // reviewable before landing.
  const rollbackEvent = useCallback(
    async (mode: CascadeEvent["mode"]) => {
      if (!event) return;
      setRolling(true);
      try {
        const touched = results
          .filter((r) => r.status === "succeeded" || r.status === "pr_opened")
          .map((r) => r.clone_id);
        if (touched.length === 0) {
          toast.info("Nothing to roll back — no clones were updated.");
          return;
        }
        await spawnSubCascade({
          mode,
          cloneIds: touched,
          summary: `Rollback of cascade ${eventId.slice(0, 8)} (${touched.length} clones, ${mode.replace("_", " ")})`,
          scopeMeta: { rollback_of: eventId, source_mode: event.mode },
          navigateAfter: true,
        });
      } finally {
        setRolling(false);
        setRollbackOpen(false);
      }
    },
    [event, results, spawnSubCascade, eventId],
  );

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading cascade…
      </div>
    );
  }

  if (!event) {
    return (
      <div className="space-y-3">
        <Link
          to="/cascades"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to cascades
        </Link>
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Cascade event not found
          </CardContent>
        </Card>
      </div>
    );
  }

  const counts = {
    queued: results.filter((r) => r.status === "queued").length,
    pushing: results.filter((r) => r.status === "pushing").length,
    succeeded: results.filter((r) => r.status === "succeeded").length,
    pr_opened: results.filter((r) => r.status === "pr_opened").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
  const failedCount = counts.failed;
  const inFlight = event.status === "running" || event.status === "pending";
  const touchedCount = counts.succeeded + counts.pr_opened;
  const canRollback =
    !inFlight && touchedCount > 0 && (event.status === "completed" || event.status === "partial");

  const scopeMeta = (event.scope_filter ?? {}) as {
    rollback_of?: string;
    retry_of?: string;
    scope?: string;
    module_id?: string;
    module_name?: string;
    module_globs?: string[];
    clone_ids?: string[];
  };
  const isModuleSync = scopeMeta.scope === "module_sync" && !!scopeMeta.module_id;

  return (
    <div className="space-y-6">
      <Link
        to="/cascades"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to cascades
      </Link>

      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-info/15 text-info">
            <ModeIcon mode={event.mode} />
          </div>
          <div>
            <p className="label-mono">cascade · {event.trigger}</p>
            <h1 className="mt-1 font-display text-[1.75rem] leading-[1.1]">
              {event.mode.replace("_", " ")} cascade
            </h1>
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <span className="opacity-60">id</span>
              <code>{eventId.slice(0, 12)}…</code>
              <CopyButton value={eventId} label="cascade event id" />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge
                variant="outline"
                className={cn("text-[10px] uppercase", statusTone(event.status))}
              >
                {event.status}
              </Badge>
              {event.source_sha &&
                (prime ? (
                  <a
                    href={`https://github.com/${prime.github_owner}/${prime.github_repo}/commit/${event.source_sha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono hover:text-foreground hover:underline"
                    title={`View on GitHub · ${prime.github_owner}/${prime.github_repo}`}
                  >
                    prime@{event.source_sha.slice(0, 7)}
                  </a>
                ) : (
                  <code className="font-mono">prime@{event.source_sha.slice(0, 7)}</code>
                ))}
              {event.source_branch &&
                (prime ? (
                  <a
                    href={`https://github.com/${prime.github_owner}/${prime.github_repo}/tree/${event.source_branch}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono hover:text-foreground hover:underline"
                    title={`View branch on GitHub · ${prime.github_owner}/${prime.github_repo}@${event.source_branch}`}
                  >
                    ({event.source_branch})
                  </a>
                ) : (
                  <code className="font-mono">({event.source_branch})</code>
                ))}
              <span>· started {formatDistanceToNow(event.created_at)}</span>
              {event.completed_at && (
                <span>· finished {formatDistanceToNow(event.completed_at)}</span>
              )}
              {scopeMeta.rollback_of && (
                <Link
                  to="/cascades/$eventId"
                  params={{ eventId: scopeMeta.rollback_of }}
                  className="inline-flex items-center gap-1 border border-warning/40 px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning hover:bg-warning/10"
                >
                  <History className="h-3 w-3" /> rollback of {scopeMeta.rollback_of.slice(0, 8)}
                </Link>
              )}
              {scopeMeta.retry_of && (
                <Link
                  to="/cascades/$eventId"
                  params={{ eventId: scopeMeta.retry_of }}
                  className="inline-flex items-center gap-1 border border-info/40 px-1.5 py-0.5 font-mono text-[10px] uppercase text-info hover:bg-info/10"
                >
                  <RotateCcw className="h-3 w-3" /> retry of {scopeMeta.retry_of.slice(0, 8)}
                </Link>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => router.invalidate()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          {inFlight && (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={cancelling}
              onClick={async () => {
                const ok = await confirm({
                  title: "Cancel this cascade?",
                  description: "Queued clones will be skipped.",
                  confirmText: "Cancel cascade",
                  destructive: true,
                });
                if (!ok) return;
                setCancelling(true);
                try {
                  const r = await cancelCascadeFn({ data: { cascadeEventId: eventId } });
                  if (r.ok) {
                    toast.success("Cascade cancelled");
                    refresh();
                  } else toast.error(r.error);
                } finally {
                  setCancelling(false);
                }
              }}
            >
              <XCircle className={cn("mr-1.5 h-3.5 w-3.5", cancelling && "animate-spin")} /> Cancel
            </Button>
          )}
          {failedCount > 0 && !inFlight && (
            <Button size="sm" onClick={retryFailed} disabled={retrying}>
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", retrying && "animate-spin")} />
              Retry {failedCount} failed
            </Button>
          )}
          {canRollback && (
            <AlertDialog open={rollbackOpen} onOpenChange={setRollbackOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-warning/40 text-warning hover:bg-warning/10 hover:text-warning"
                  disabled={rolling}
                >
                  <History className={cn("mr-1.5 h-3.5 w-3.5", rolling && "animate-spin")} />
                  Roll back ({touchedCount})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Roll back this cascade?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This creates a <strong>reverse cascade event</strong> against {touchedCount}{" "}
                    clone{touchedCount === 1 ? "" : "s"} that were updated by this run. Pick a
                    delivery mode — PR is recommended so the rollback diff is reviewable before
                    landing.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
                  <AlertDialogCancel disabled={rolling}>Cancel</AlertDialogCancel>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rolling}
                    onClick={() => void rollbackEvent("notify")}
                  >
                    <Bell className="mr-1.5 h-3.5 w-3.5" /> Notify only
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rolling}
                    onClick={() => void rollbackEvent("auto_merge")}
                  >
                    <Send className="mr-1.5 h-3.5 w-3.5" /> Auto-merge
                  </Button>
                  <AlertDialogAction disabled={rolling} onClick={() => void rollbackEvent("pr")}>
                    <GitMerge className="mr-1.5 h-3.5 w-3.5" /> Open PRs
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </header>

      {event.summary && (
        <Card>
          <CardContent className="p-4 font-mono text-xs text-muted-foreground">
            {event.summary}
          </CardContent>
        </Card>
      )}

      {isModuleSync && (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader className="space-y-1 p-4 pb-2">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-primary" />
              <CardTitle className="text-sm">
                Scoped module sync · {scopeMeta.module_name ?? "module"}
              </CardTitle>
              <Badge variant="outline" className="ml-auto font-mono text-[10px] uppercase">
                {scopeMeta.clone_ids?.length ?? results.length} clone
                {(scopeMeta.clone_ids?.length ?? results.length) === 1 ? "" : "s"}
              </Badge>
            </div>
            <CardDescription className="font-mono text-[11px]">
              This cascade only pushes files matching the module's globs.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            {(scopeMeta.module_globs ?? []).length === 0 ? (
              <div className="font-mono text-[11px] text-muted-foreground">No globs recorded.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(scopeMeta.module_globs ?? []).map((g) => (
                  <code
                    key={g}
                    className="border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {g}
                  </code>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <CascadeApprovalBanner
        cascadeEventId={event.id}
        initiatedBy={event.initiated_by}
        requiresApproval={event.requires_approval}
        approvedAt={event.approved_at}
        approvedBy={event.approved_by}
        reasonHint={
          assessBlastRadius(event.mode, results.length).reason ??
          "This cascade exceeds the safety threshold."
        }
        onChange={refresh}
      />

      <CascadeLineagePanel event={event} />

      <CascadeTriageCard cascadeEventId={event.id} failureCount={failedCount} />

      <div className="grid gap-2 md:grid-cols-6">
        <CountTile label="Queued" value={counts.queued} icon={<CircleDot />} tone="muted" />
        <CountTile
          label="Pushing"
          value={counts.pushing}
          icon={<Loader2 className="animate-spin" />}
          tone="info"
        />
        <CountTile label="Merged" value={counts.succeeded} icon={<CheckCircle2 />} tone="success" />
        <CountTile label="PRs" value={counts.pr_opened} icon={<GitPullRequest />} tone="accent" />
        <CountTile label="Failed" value={counts.failed} icon={<XCircle />} tone="destructive" />
        <CountTile label="Skipped" value={counts.skipped} icon={<SkipForward />} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-clone results</CardTitle>
          <CardDescription>
            Live updates via Realtime — no refresh needed. Sections collapse for noise control.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {results.length === 0 ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              No clones queued for this cascade.
            </div>
          ) : (
            <GroupedResults
              results={results}
              eventInFlight={inFlight}
              eventMode={event.mode}
              onChange={refresh}
              onRetryWithMode={retryWithMode}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const GROUP_ORDER: { status: CascadeResult["status"]; label: string; tone: string }[] = [
  { status: "failed", label: "Failed", tone: "text-destructive" },
  { status: "queued", label: "Queued", tone: "text-muted-foreground" },
  { status: "pushing", label: "In flight", tone: "text-info" },
  { status: "pr_opened", label: "PRs opened", tone: "text-accent" },
  { status: "succeeded", label: "Succeeded", tone: "text-success" },
  { status: "skipped", label: "Skipped", tone: "text-muted-foreground" },
];

function GroupedResults({
  results,
  eventInFlight,
  eventMode,
  onChange,
  onRetryWithMode,
}: {
  results: ResultWithClone[];
  eventInFlight: boolean;
  eventMode: CascadeEvent["mode"];
  onChange: () => void;
  onRetryWithMode: (cloneId: string, mode: CascadeEvent["mode"]) => Promise<void>;
}) {
  const groups = useMemo(() => {
    const map = new Map<CascadeResult["status"], ResultWithClone[]>();
    for (const r of results) {
      if (!map.has(r.status)) map.set(r.status, []);
      map.get(r.status)!.push(r);
    }
    return GROUP_ORDER.filter((g) => map.has(g.status)).map((g) => ({
      ...g,
      items: map.get(g.status)!,
    }));
  }, [results]);

  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <ResultsGroup
          key={g.status}
          status={g.status}
          label={g.label}
          tone={g.tone}
          items={g.items}
          defaultOpen={g.status === "failed" || g.status === "queued" || g.status === "pushing"}
          eventInFlight={eventInFlight}
          eventMode={eventMode}
          onChange={onChange}
          onRetryWithMode={onRetryWithMode}
        />
      ))}
    </div>
  );
}

function ResultsGroup({
  status,
  label,
  tone,
  items,
  defaultOpen,
  eventInFlight,
  eventMode,
  onChange,
  onRetryWithMode,
}: {
  status: CascadeResult["status"];
  label: string;
  tone: string;
  items: ResultWithClone[];
  defaultOpen: boolean;
  eventInFlight: boolean;
  eventMode: CascadeEvent["mode"];
  onChange: () => void;
  onRetryWithMode: (cloneId: string, mode: CascadeEvent["mode"]) => Promise<void>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 border px-3 py-2 text-left transition-colors hover:bg-muted/40"
        >
          <ResultStatusIcon status={status} />
          <span className={cn("font-mono text-xs uppercase tracking-wider", tone)}>{label}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {items.length}
          </Badge>
          <ChevronDown
            className={cn(
              "ml-auto h-4 w-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {items.map((r) => (
          <ResultRow
            key={r.id}
            result={r}
            eventInFlight={eventInFlight}
            eventMode={eventMode}
            onChange={onChange}
            onRetryWithMode={onRetryWithMode}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ResultRow({
  result,
  eventInFlight,
  eventMode,
  onChange,
  onRetryWithMode,
}: {
  result: ResultWithClone;
  eventInFlight: boolean;
  eventMode: CascadeEvent["mode"];
  onChange: () => void;
  onRetryWithMode: (cloneId: string, mode: CascadeEvent["mode"]) => Promise<void>;
}) {
  const clone = result.clone;
  const [skipping, setSkipping] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const canSkip = result.status === "queued";
  // Allow per-result retry once the row has settled (success/PR/failed/skipped)
  // and we have a clone id to target. Disabled while parent event in flight.
  const canRetry =
    !!clone &&
    !eventInFlight &&
    (result.status === "failed" ||
      result.status === "succeeded" ||
      result.status === "pr_opened" ||
      result.status === "skipped");

  const skip = async () => {
    if (!canSkip) return;
    setSkipping(true);
    const { error } = await supabase
      .from("cascade_results")
      .update({
        status: "skipped",
        diff_summary: "Skipped by operator",
        completed_at: new Date().toISOString(),
      })
      .eq("id", result.id);
    if (error) {
      toast.error(error.message);
      setSkipping(false);
      return;
    }
    toast.success(`Skipped ${clone?.name ?? "clone"}`);
    setSkipping(false);
    onChange();
  };

  const handleRetry = async (mode: CascadeEvent["mode"]) => {
    if (!clone) return;
    setRetryBusy(true);
    try {
      await onRetryWithMode(clone.id, mode);
    } finally {
      setRetryBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border bg-surface p-3 md:flex-row md:items-center">
      <div className="flex flex-1 items-center gap-3 min-w-0">
        <ResultStatusIcon status={result.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm font-medium">
              {clone?.name ?? "Unknown clone"}
            </span>
            <Badge
              variant="outline"
              className={cn("shrink-0 text-[10px] uppercase", resultTone(result.status))}
            >
              {result.status.replace("_", " ")}
            </Badge>
          </div>
          {clone && (
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {clone.github_owner}/{clone.github_repo}
            </div>
          )}
          {result.diff_summary && (
            <div className="mt-2">
              <InlineDiffSummary
                summary={result.diff_summary}
                filesChanged={result.files_changed}
              />
            </div>
          )}
          {clone && result.previous_sha && result.commit_sha && (
            <div className="mt-2">
              <Suspense
                fallback={<div className="text-xs text-muted-foreground">Loading diff viewer…</div>}
              >
                <RichDiffViewer
                  cloneOwner={clone.github_owner}
                  cloneRepo={clone.github_repo}
                  baseSha={result.previous_sha}
                  headSha={result.commit_sha}
                  filesChanged={result.files_changed}
                />
              </Suspense>
            </div>
          )}
          {result.error_message && (
            <div className="mt-1 font-mono text-xs text-destructive">{result.error_message}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 md:flex-col md:items-end">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {result.files_changed} file{result.files_changed === 1 ? "" : "s"}
        </div>
        {result.commit_sha && clone && (
          <a
            href={`https://github.com/${clone.github_owner}/${clone.github_repo}/commit/${result.commit_sha}`}
            target="_blank"
            rel="noreferrer"
            className="bg-muted px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted/70 hover:underline"
            title="View commit on GitHub"
          >
            {result.commit_sha.slice(0, 7)}
          </a>
        )}
        {result.commit_sha && !clone && (
          <code className="bg-muted px-1.5 py-0.5 font-mono text-[10px]">
            {result.commit_sha.slice(0, 7)}
          </code>
        )}
        {result.pr_url && (
          <a
            href={result.pr_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
          >
            {eventMode === "notify" ? (
              <>
                View drift issue <ExternalLink className="h-3 w-3" />
              </>
            ) : (
              <>
                View PR <ExternalLink className="h-3 w-3" />
              </>
            )}
          </a>
        )}
        {canSkip && (
          <Button
            size="sm"
            variant="ghost"
            disabled={skipping || eventInFlight}
            onClick={skip}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            title={
              eventInFlight
                ? "Cascade in flight — wait for it to settle before skipping"
                : "Drop this clone from the run"
            }
          >
            <SkipForward className="mr-1 h-3 w-3" />
            {skipping ? "Skipping…" : "Skip"}
          </Button>
        )}
        {canRetry && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={retryBusy}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                title="Re-run this clone with a different delivery mode"
              >
                <RotateCcw className={cn("mr-1 h-3 w-3", retryBusy && "animate-spin")} />
                {retryBusy ? "Retrying…" : "Retry as"}
                <ChevronDown className="ml-0.5 h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Re-run with mode
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleRetry("pr")} disabled={retryBusy}>
                <GitMerge className="mr-2 h-3.5 w-3.5" />
                <span className="flex-1">Open PR</span>
                {eventMode === "pr" && (
                  <span className="font-mono text-[9px] uppercase text-muted-foreground">same</span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void handleRetry("auto_merge")}
                disabled={retryBusy}
              >
                <Send className="mr-2 h-3.5 w-3.5" />
                <span className="flex-1">Auto-merge</span>
                {eventMode === "auto_merge" && (
                  <span className="font-mono text-[9px] uppercase text-muted-foreground">same</span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleRetry("notify")} disabled={retryBusy}>
                <Bell className="mr-2 h-3.5 w-3.5" />
                <span className="flex-1">Notify only</span>
                {eventMode === "notify" && (
                  <span className="font-mono text-[9px] uppercase text-muted-foreground">same</span>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function ResultStatusIcon({ status }: { status: CascadeResult["status"] }) {
  const cls = "h-4 w-4 shrink-0";
  switch (status) {
    case "queued":
      return <CircleDot className={cn(cls, "text-muted-foreground")} />;
    case "pushing":
      return <Loader2 className={cn(cls, "animate-spin text-info")} />;
    case "succeeded":
      return <CheckCircle2 className={cn(cls, "text-success")} />;
    case "pr_opened":
      return <GitPullRequest className={cn(cls, "text-accent")} />;
    case "failed":
      return <XCircle className={cn(cls, "text-destructive")} />;
    case "skipped":
      return <SkipForward className={cn(cls, "text-muted-foreground")} />;
  }
}

function CountTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: "info" | "success" | "destructive" | "muted" | "accent";
}) {
  const map = {
    info: "text-info",
    success: "text-success",
    destructive: "text-destructive",
    muted: "text-muted-foreground",
    accent: "text-accent",
  };
  return (
    <div className="border p-3">
      <div className={cn("mb-1 flex items-center gap-1.5 [&>svg]:h-3.5 [&>svg]:w-3.5", map[tone])}>
        {icon}
        <span className="font-mono text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <div className={cn("font-mono text-2xl font-semibold", map[tone])}>{value}</div>
    </div>
  );
}

function ModeIcon({ mode }: { mode: CascadeEvent["mode"] }) {
  switch (mode) {
    case "pr":
      return <GitMerge className="h-5 w-5" />;
    case "auto_merge":
      return <Send className="h-5 w-5" />;
    case "notify":
      return <Bell className="h-5 w-5" />;
  }
}

function statusTone(s: CascadeEvent["status"]) {
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

function resultTone(s: CascadeResult["status"]) {
  switch (s) {
    case "succeeded":
      return "border-success/40 text-success";
    case "pr_opened":
      return "border-accent/40 text-accent";
    case "failed":
      return "border-destructive/40 text-destructive";
    case "pushing":
      return "border-info/40 text-info";
    case "skipped":
      return "border-muted text-muted-foreground";
    default:
      return "border-border text-muted-foreground";
  }
}
