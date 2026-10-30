// The live audit's runs: what each one covered, what it held back, what it
// spent and what it found — enough to tell a quiet Prime from a run that
// never got past the sign-in.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ExternalLink, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { RecordRow } from "@/components/record-row";
import { MetricCell } from "@/components/metric-bar";
import { useConfirm } from "@/components/confirm-dialog";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { cancelLiveAuditRunFn, getLiveAuditRun } from "@/lib/live-audit.functions";
import {
  KIND_LABEL,
  WORD,
  describeEvent,
  durationBetween,
  formatUsd,
  modelOf,
  runSpine,
  runStatusLabel,
  runStatusText,
  severityText,
  stateLabel,
} from "./labels";

export type RunRow = {
  id: string;
  kind: string;
  mode: string;
  status: string;
  ref: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  findings_reported: number;
  findings_new: number;
  regressions: number;
  findings_resolved: number;
  cost_usd: number | null;
  complete: boolean | null;
  auth_state: string | null;
  anthropic: unknown;
  last_error: string | null;
  workflow_run_url: string | null;
  dispatch_attempts: number;
};

export function LiveAuditRuns({
  runs,
  onOpen,
}: {
  runs: RunRow[];
  onOpen: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No run yet. Start one, or turn the nightly run on under Settings.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {runs.map((r) => {
        const m = modelOf(r.anthropic);
        return (
          <RecordRow
            key={r.id}
            spine={runSpine(r.status, r.complete)}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(r.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(r.id);
              }
            }}
            className="cursor-pointer px-4 py-3 transition-colors hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={cn(WORD, runStatusText(r.status, r.complete))}>
                {runStatusLabel(r.status, r.complete)}
              </span>
              <span className="font-medium">
                {KIND_LABEL[r.kind] ?? r.kind} ·{" "}
                {r.mode === "preview" ? `preview of ${r.ref ?? "main"}` : "production"}
              </span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {formatDistanceToNow(r.created_at)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-muted-foreground">
              <span>{r.findings_reported} reported</span>
              <span className={cn(r.findings_new > 0 && "text-foreground")}>
                · {r.findings_new} new
              </span>
              <span className={cn(r.regressions > 0 && "text-warning")}>
                · {r.regressions} back
              </span>
              <span>· {r.findings_resolved} resolved</span>
              <span>· {durationBetween(r.started_at, r.completed_at)}</span>
              <span>· {formatUsd(r.cost_usd)}</span>
              {m.model && m.available !== false && (
                <span>
                  · {m.model}
                  {m.chosen === false ? " (default)" : ""}
                </span>
              )}
              {m.available === false && <span className="text-warning">· without Claude</span>}
              {r.auth_state && r.auth_state !== "signed_in" && (
                <span className="text-warning">· {r.auth_state.replace(/_/g, " ")}</span>
              )}
            </div>
            {r.last_error && r.status !== "completed" && (
              <p className="mt-1 line-clamp-2 text-xs text-destructive">{r.last_error}</p>
            )}
          </RecordRow>
        );
      })}
    </div>
  );
}

const PHASE_ORDER = ["knowledge", "scope", "crawl", "explore", "triage", "report"];

export function RunSheet({
  runId,
  onClose,
  onOpenFinding,
}: {
  runId: string | null;
  onClose: () => void;
  onOpenFinding: (findingId: string) => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["live-audit-run", runId],
    queryFn: () => getLiveAuditRun({ data: { runId: runId! } }),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = (query.state.data as any)?.run?.status;
      return status && ["queued", "dispatched", "running"].includes(status) ? 5_000 : false;
    },
  });
  const cancelFn = useServerFn(cancelLiveAuditRunFn);
  const cancel = useMutation({
    mutationFn: () => cancelFn({ data: { runId: runId! } }),
    onSuccess: () => {
      toast.success("Run canceled");
      qc.invalidateQueries({ queryKey: ["live-audit-run", runId] });
      qc.invalidateQueries({ queryKey: ["live-audit-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = q.data as any;
  const run = d?.run;
  const summary = (run?.summary ?? {}) as Record<string, any>;
  const phases = (run?.phases ?? {}) as Record<string, any>;
  const coverage = (summary.coverage ?? {}) as Record<string, any>;
  const guard = (summary.guard ?? {}) as Record<string, any>;
  const spend = (summary.anthropic ?? run?.anthropic ?? {}) as Record<string, any>;
  const m = modelOf(run?.anthropic ?? summary.anthropic);
  const open = run && ["queued", "dispatched", "running"].includes(run.status);

  return (
    <Sheet open={!!runId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {!run ? (
          <SheetHeader>
            <SheetTitle>Run</SheetTitle>
            <SheetDescription>{q.error ? (q.error as Error).message : "Reading…"}</SheetDescription>
          </SheetHeader>
        ) : (
          <div className="space-y-6">
            <SheetHeader className="space-y-2 text-left">
              <span className="label-mono">
                {KIND_LABEL[run.kind] ?? run.kind} run ·{" "}
                {run.mode === "preview" ? `preview of ${run.ref ?? "main"}` : "production"}
              </span>
              <SheetTitle className="font-display text-xl">
                {runStatusLabel(run.status, run.complete)}
                {run.complete === false && run.status === "completed" && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    nothing was resolved by its absence
                  </span>
                )}
              </SheetTitle>
              <SheetDescription className="font-mono text-[11px]">
                queued {formatDistanceToNow(run.created_at)} · ran{" "}
                {durationBetween(run.started_at, run.completed_at)}
                {run.runner_version ? ` · runner v${run.runner_version}` : ""}
                {run.auth_state ? ` · ${run.auth_state.replace(/_/g, " ")}` : ""}
              </SheetDescription>
              <div className="flex flex-wrap gap-2 pt-1">
                {run.workflow_run_url && (
                  <a
                    href={run.workflow_run_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    Workflow run <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {d.canAct && open && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cancel.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Cancel this run?",
                        description:
                          "Nothing it reports afterwards is believed. GitHub is asked to stop the workflow, and the session minted for it is revoked either way.",
                        confirmText: "Cancel run",
                        destructive: true,
                      });
                      if (ok) cancel.mutate();
                    }}
                  >
                    <Square className="mr-1.5 h-3.5 w-3.5" /> Cancel run
                  </Button>
                )}
              </div>
            </SheetHeader>

            {run.last_error && (
              <p className="border-l-2 border-destructive pl-3 text-sm">{run.last_error}</p>
            )}

            <div className="glass grid grid-cols-2 overflow-hidden md:grid-cols-4">
              <MetricCell label="reported" value={run.findings_reported} />
              <MetricCell label="new" value={run.findings_new} />
              <MetricCell
                label="back"
                value={run.regressions}
                alarm={run.regressions > 0}
                tone="warning"
              />
              <MetricCell label="resolved" value={run.findings_resolved} />
              <MetricCell
                label="pages"
                value={coverage.visited ?? "—"}
                size="sm"
                note={coverage.deferred ? `${coverage.deferred} deferred` : undefined}
              />
              <MetricCell
                label="withheld"
                value={guard.withheld ?? guard.blocked ?? "—"}
                size="sm"
                note="writes the guard stopped"
              />
              <MetricCell
                label="spend"
                value={formatUsd(spend.usd ?? run.cost_usd)}
                size="sm"
                note={m.model ? `${m.model}${m.chosen === false ? " (default)" : ""}` : "no model"}
              />
              <MetricCell
                label="templates"
                value={(coverage.templates_covered ?? []).length || "—"}
                size="sm"
                note="covered"
              />
            </div>

            <section className="space-y-2">
              <h3 className="label-mono">Phases</h3>
              <ul className="space-y-1 text-sm">
                {PHASE_ORDER.filter((p) => phases[p] || summary.phases?.[p]).map((p) => {
                  const ph = phases[p] ?? summary.phases?.[p] ?? {};
                  return (
                    <li key={p} className="flex gap-3">
                      <span className="w-24 shrink-0 font-mono text-[11px] uppercase text-muted-foreground">
                        {p}
                      </span>
                      <span
                        className={cn(
                          ph.status === "failed" || ph.status === "error" ? "text-destructive" : "",
                        )}
                      >
                        {ph.status ?? "—"}
                        {ph.detail ? ` — ${ph.detail}` : ""}
                        {ph.reason ? ` — ${ph.reason}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            {Array.isArray(guard.top) && guard.top.length > 0 && (
              <section className="space-y-2">
                <h3 className="label-mono">Held back by the guard</h3>
                <p className="text-xs text-muted-foreground">
                  Requests the audit refused to send because they could change Prime. A page that
                  needs one of these to load reads as broken to the audit: allow the function under
                  Settings if its code only reads.
                </p>
                <ul className="space-y-0.5 font-mono text-[11px]">
                  {(guard.top as Array<{ endpoint: string; count: number }>)
                    .slice(0, 12)
                    .map((t) => (
                      <li key={t.endpoint} className="flex gap-3">
                        <span className="w-10 shrink-0 text-right text-muted-foreground">
                          {t.count}×
                        </span>
                        <span className="truncate">{t.endpoint}</span>
                      </li>
                    ))}
                </ul>
              </section>
            )}

            {(d.newFindings ?? []).length > 0 && (
              <section className="space-y-2">
                <h3 className="label-mono">First seen in this run</h3>
                <ul className="space-y-1">
                  {(d.newFindings as any[]).map((f) => (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => onOpenFinding(f.id)}
                        className="flex w-full items-baseline gap-3 text-left text-sm hover:underline"
                      >
                        <span className={cn(WORD, "w-16 shrink-0", severityText(f.severity))}>
                          {f.severity}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{f.title}</span>
                        <span className="label-mono">{stateLabel(f.state)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="label-mono">Timeline</h3>
              <ul className="space-y-1">
                {(d.events as any[])
                  .filter((e) => !e.finding_id)
                  .map((e) => (
                    <li key={e.id} className="flex gap-3 text-xs">
                      <span className="w-28 shrink-0 font-mono text-muted-foreground">
                        {formatDistanceToNow(e.created_at)}
                      </span>
                      <span>{describeEvent(e)}</span>
                    </li>
                  ))}
              </ul>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
