// Phase 10 — Cascade approvals queue: bulk approve/reject pending events.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ShieldCheck, ShieldAlert, RefreshCw, Inbox, AlertTriangle } from "lucide-react";
import { listPendingApprovals } from "@/server/operator-ux.functions";
import { approveCascade, rejectCascade } from "@/server/cascade-approvals.functions";
import { toast } from "sonner";
import { formatDistanceToNow } from "@/lib/format";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { CardRowSkeleton } from "@/components/list-skeletons";

export const Route = createFileRoute("/approvals")({
  component: () => (
    <ProtectedRoute>
      <ApprovalsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Approvals — Aurixa Systems Mission Control" }] }),
});

function ApprovalsPage() {
  const listFn = useServerFn(listPendingApprovals);
  const approveFn = useServerFn(approveCascade);
  const rejectFn = useServerFn(rejectCascade);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pending-approvals"], queryFn: () => listFn() });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");

  const events = q.data?.ok ? q.data.events : [];
  const loadError = q.isError
    ? q.error instanceof Error
      ? q.error.message
      : "Failed to load approvals."
    : q.data && !q.data.ok
      ? q.data.error
      : null;

  const toggle = (id: string) => {
    setPicked((p) => {
      const n = new Set(p);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const bulk = useMutation({
    mutationFn: async (decision: "approve" | "reject") => {
      const ids = Array.from(picked);
      const results = await Promise.allSettled(
        ids.map((id) =>
          decision === "approve"
            ? approveFn({ data: { cascadeEventId: id, reason: reason || undefined } })
            : rejectFn({ data: { cascadeEventId: id, reason: reason || undefined } }),
        ),
      );
      return { decision, results };
    },
    onSuccess: ({ decision, results }) => {
      const ok = results.filter(
        (r) => r.status === "fulfilled" && (r.value as any)?.ok !== false,
      ).length;
      const fail = results.length - ok;
      toast.success(
        `${decision === "approve" ? "Approved" : "Rejected"} ${ok}/${results.length}${fail ? ` · ${fail} failed` : ""}`,
      );
      setPicked(new Set());
      setReason("");
      qc.invalidateQueries({ queryKey: ["pending-approvals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="queue"
        icon={<ShieldCheck className="h-7 w-7 text-warning" />}
        title="Approvals"
        description="High-blast-radius cascades waiting for a second operator."
        actions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh approvals"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">
              {q.isPending ? "…" : events.length} awaiting review
            </CardTitle>
            <CardDescription>
              Select multiple events to approve or reject in one shot.
            </CardDescription>
          </div>
          {picked.size > 0 && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => bulk.mutate("reject")}
                disabled={bulk.isPending}
              >
                <ShieldAlert className="mr-1 h-4 w-4" /> Reject {picked.size}
              </Button>
              <Button size="sm" onClick={() => bulk.mutate("approve")} disabled={bulk.isPending}>
                <ShieldCheck className="mr-1 h-4 w-4" /> Approve {picked.size}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {picked.size > 0 && (
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional reason (applied to all selected)"
              className="mb-3"
              rows={2}
            />
          )}
          {q.isPending ? (
            <div className="space-y-2">
              <CardRowSkeleton />
              <CardRowSkeleton />
              <CardRowSkeleton />
            </div>
          ) : loadError ? (
            <EmptyState
              icon={<AlertTriangle />}
              title="Couldn't load approvals"
              description={loadError}
              action={
                <Button variant="outline" onClick={() => void q.refetch()}>
                  <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
                </Button>
              }
            />
          ) : events.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title="No cascades waiting"
              description="Cascades that need a second operator — high blast radius, a security hold, or an unattended self-healing merge — appear here."
            />
          ) : (
            <div className="space-y-2">
              {events.map((e) => (
                <label
                  key={e.id}
                  className="flex items-start gap-3 border border-border bg-surface p-3 hover:bg-sidebar-accent/40 cursor-pointer"
                >
                  <Checkbox
                    checked={picked.has(e.id)}
                    onCheckedChange={() => toggle(e.id)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {e.mode}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatDistanceToNow(e.created_at)}
                      </span>
                      {e.source_branch && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          @ {e.source_branch}
                        </span>
                      )}
                    </div>
                    {e.summary && <p className="mt-1 text-sm">{e.summary}</p>}
                    {e.hold_reason ? (
                      <p className="mt-1 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          <span className="font-medium">Held:</span> {e.hold_reason}
                        </span>
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {e.trigger === "commit"
                          ? "Gated by blast radius."
                          : "Operator-started cascade above the auto-merge threshold."}
                      </p>
                    )}
                  </div>
                  <Link
                    to="/cascades/$eventId"
                    params={{ eventId: e.id }}
                    className="font-mono text-[11px] text-primary hover:underline"
                  >
                    inspect →
                  </Link>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
