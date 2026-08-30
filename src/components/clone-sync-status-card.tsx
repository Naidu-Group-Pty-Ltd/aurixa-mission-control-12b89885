// Compact "sync status" card: shows the last synced SHA, sync state,
// commits behind, last cascade run for this clone, and quick retry links.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { StatusPill } from "@/components/status-pill";
import {
  GitCommit,
  RefreshCw,
  Waves,
  ChevronRight,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  GitPullRequest,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import type { Database } from "@/integrations/supabase/types";
import type { Clone } from "@/lib/queries";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { runCascade } from "@/server/cascade-engine.functions";

type CascadeResult = Database["public"]["Tables"]["cascade_results"]["Row"];
type CascadeEvent = Database["public"]["Tables"]["cascade_events"]["Row"];
type LatestRun = CascadeResult & { event: CascadeEvent | null };

export function CloneSyncStatusCard({ clone }: { clone: Clone }) {
  const [latest, setLatest] = useState<LatestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const runCascadeFn = useServerFn(runCascade);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("cascade_results")
      .select("*, event:cascade_events(*)")
      .eq("clone_id", clone.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setLatest((data as LatestRun) ?? null);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    const channel = supabase
      .channel(`clone-sync-${clone.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "cascade_results",
          filter: `clone_id=eq.${clone.id}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clone.id]);

  const retry = async () => {
    if (!latest?.event) return;
    setRetrying(true);
    try {
      await supabase
        .from("cascade_results")
        .update({ status: "queued", error_message: null, started_at: null, completed_at: null })
        .eq("id", latest.id);
      const res = await runCascadeFn({ data: { cascadeEventId: latest.event.id } });
      if (!res.ok) toast.error(res.error);
      else toast.success("Cascade re-queued");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  };

  const isInFlight = latest?.status === "pushing" || latest?.status === "queued";
  // `pr_opened` is NOT `succeeded`, and drawing them with the same green tick
  // is what made this card say a cascade had landed while the pull request was
  // still sitting open on GitHub. A proposal is a proposal until it merges —
  // the cascade detail page has always drawn it as one, and this is the
  // per-clone surface an operator actually looks at.
  const StatusIcon =
    latest?.status === "succeeded"
      ? CheckCircle2
      : latest?.status === "pr_opened"
        ? GitPullRequest
        : latest?.status === "failed"
          ? XCircle
          : isInFlight
            ? Loader2
            : AlertTriangle;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitCommit className="h-4 w-4 text-info" /> Sync status
          </CardTitle>
          <CardDescription>
            Latest cascade run, current commit pointer, and retry shortcuts.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Tile label="Sync state">
            <div className="flex items-center gap-2">
              <StatusPill status={clone.sync_status} behind={clone.commits_behind} />
              {clone.commits_behind > 0 && (
                <Badge
                  variant="outline"
                  className="border-warning/40 font-mono text-[10px] uppercase text-warning"
                >
                  {clone.commits_behind} behind
                </Badge>
              )}
            </div>
          </Tile>
          <Tile label="Last synced SHA">
            {clone.last_synced_sha ? (
              <div className="flex items-center gap-1.5">
                <code className="font-mono text-sm">{clone.last_synced_sha.slice(0, 10)}</code>
                <CopyButton value={clone.last_synced_sha} label="commit SHA" />
              </div>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">never synced</span>
            )}
          </Tile>
          <Tile label="Last cascade fired">
            {clone.last_cascade_at ? (
              <span className="inline-flex items-center gap-1 font-mono text-xs">
                <Clock className="h-3 w-3 text-muted-foreground" />
                {formatDistanceToNow(clone.last_cascade_at)}
              </span>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">no runs yet</span>
            )}
          </Tile>
        </div>

        <div className="border border-border bg-surface p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              latest cascade run
            </span>
            {latest?.event && (
              <CopyButton
                value={latest.event.id}
                label="cascade event id"
                size="xs"
                showValue
                truncate={10}
              />
            )}
          </div>
          {loading ? (
            <p className="font-mono text-xs text-muted-foreground">Loading…</p>
          ) : !latest ? (
            <p className="font-mono text-xs text-muted-foreground">
              No cascade run for this clone yet. Use “Cascade now” to push the latest prime.
            </p>
          ) : (
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-start gap-3">
                <StatusIcon
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    statusTone(latest.status),
                    isInFlight && "animate-spin",
                  )}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn("font-mono text-[10px] uppercase", statusBorder(latest.status))}
                    >
                      {statusLabel(latest.status)}
                    </Badge>
                    {latest.event?.mode && (
                      <Badge variant="outline" className="font-mono text-[10px] uppercase">
                        {latest.event.mode.replace("_", " ")}
                      </Badge>
                    )}
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {formatDistanceToNow(latest.created_at)}
                    </span>
                  </div>
                  {latest.error_message && (
                    <p className="mt-1 line-clamp-2 font-mono text-[11px] text-destructive">
                      {latest.error_message}
                    </p>
                  )}
                  {latest.pr_url && (
                    <a
                      href={latest.pr_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
                    >
                      open PR <ChevronRight className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {latest.event && (
                  <Button asChild variant="outline" size="sm">
                    <Link to="/cascades/$eventId" params={{ eventId: latest.event.id }}>
                      <Waves className="mr-1.5 h-3.5 w-3.5" />
                      View cascade
                    </Link>
                  </Button>
                )}
                {latest.status === "failed" && latest.event && (
                  <Button size="sm" onClick={retry} disabled={retrying}>
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", retrying && "animate-spin")} />
                    Retry this clone
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-surface p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 text-sm">{children}</div>
    </div>
  );
}

/**
 * What a status is called on screen.
 *
 * The raw enum used to be rendered, so this card read `PR_OPENED` beside a mode
 * badge reading `AUTO MERGE` under a green tick — three signals that together
 * say "merged" about a pull request nobody had merged.
 */
function statusLabel(s: CascadeResult["status"]): string {
  switch (s) {
    case "pr_opened":
      return "PR open";
    case "succeeded":
      return "merged";
    case "pushing":
      return "running";
    default:
      return s;
  }
}

function statusTone(s: CascadeResult["status"]) {
  switch (s) {
    case "succeeded":
      return "text-success";
    case "pr_opened":
      return "text-accent";
    case "failed":
      return "text-destructive";
    case "skipped":
      return "text-muted-foreground";
    default:
      return "text-info";
  }
}

function statusBorder(s: CascadeResult["status"]) {
  switch (s) {
    case "succeeded":
      return "border-success/40 text-success";
    case "pr_opened":
      return "border-accent/40 text-accent";
    case "failed":
      return "border-destructive/40 text-destructive";
    case "skipped":
      return "border-border text-muted-foreground";
    default:
      return "border-info/40 text-info";
  }
}
