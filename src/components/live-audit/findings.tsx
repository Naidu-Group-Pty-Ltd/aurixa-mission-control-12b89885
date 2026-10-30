// The live audit's findings: the list, and one finding's whole record — how a
// person reaches it, what the browser saw, where the code is, what Claude did
// about it, and every decision a person made.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ExternalLink, RefreshCw, Search, Wrench, RotateCcw, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RecordRow } from "@/components/record-row";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SEVERITIES, triageTransition } from "@/lib/live-audit-policy";
import {
  getLiveAuditFinding,
  listLiveAuditFindings,
  startLiveAuditFixFn,
  startLiveAuditRun,
  triageLiveAuditFinding,
} from "@/lib/live-audit.functions";
import {
  FIX_STATUS_LABEL,
  WORD,
  describeEvent,
  fixSpine,
  severitySpine,
  severityText,
  stateLabel,
  stateText,
} from "./labels";

export type FindingsView = "open" | "fixing" | "resolved" | "dismissed" | "all";

const VIEWS: Array<{ value: FindingsView; label: string }> = [
  { value: "open", label: "Open" },
  { value: "fixing", label: "Being fixed" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

type FindingRow = {
  id: string;
  title: string;
  severity: string;
  state: string;
  category: string;
  detector: string;
  route: string | null;
  route_template: string | null;
  confidence: number | null;
  deterministic: boolean;
  reproduced: boolean | null;
  occurrences: number;
  runs_seen: number;
  first_seen_at: string;
  last_seen_at: string;
  judged_by: string | null;
};

export function LiveAuditFindings({
  onOpen,
  runId,
}: {
  onOpen: (findingId: string) => void;
  /** Only the findings a run saw. */
  runId?: string;
}) {
  const [view, setView] = useState<FindingsView>("open");
  const [severities, setSeverities] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");

  const q = useQuery({
    queryKey: ["live-audit-findings", view, severities, term, runId ?? null],
    queryFn: () =>
      listLiveAuditFindings({
        data: {
          view,
          severities: severities.length ? (severities as (typeof SEVERITIES)[number][]) : undefined,
          search: term || undefined,
          runId,
        },
      }),
    refetchInterval: 30_000,
  });
  const rows = (q.data?.findings ?? []) as FindingRow[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex flex-wrap gap-px border border-border"
          role="tablist"
          aria-label="Which findings"
        >
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="tab"
              aria-selected={view === v.value}
              onClick={() => setView(v.value)}
              className={cn(
                WORD,
                "px-3 py-1.5 transition-colors",
                view === v.value
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04]",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-px border border-border" aria-label="Severity">
          {SEVERITIES.map((s) => {
            const on = severities.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setSeverities((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))
                }
                className={cn(
                  WORD,
                  "px-2.5 py-1.5 transition-colors",
                  on
                    ? cn("bg-foreground/10", severityText(s))
                    : "text-muted-foreground hover:bg-foreground/[0.04]",
                )}
              >
                {s}
              </button>
            );
          })}
        </div>
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(search.trim());
          }}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title, page or detector"
              aria-label="Search findings"
              className="h-8 w-60 pl-7"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => q.refetch()}
            aria-label="Refresh findings"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} />
          </Button>
        </form>
      </div>

      {q.error ? (
        <p className="text-sm text-destructive">
          The findings could not be read: {(q.error as Error).message}
        </p>
      ) : q.isLoading ? (
        <p className="label-mono">reading findings…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {view === "open"
            ? "No open defects. The next run will say whether that still holds."
            : "Nothing here."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((f) => (
            <RecordRow
              key={f.id}
              spine={severitySpine(f.severity)}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(f.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(f.id);
                }
              }}
              className="cursor-pointer px-4 py-3 transition-colors hover:bg-foreground/[0.04] focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={cn(WORD, severityText(f.severity))}>{f.severity}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{f.title}</span>
                <span className={cn(WORD, stateText(f.state))}>{stateLabel(f.state)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-muted-foreground">
                <span>{f.route_template ?? f.route ?? "—"}</span>
                <span>· {f.detector}</span>
                <span>
                  · {f.deterministic ? "every visit" : f.reproduced ? "reproduced" : "seen once"}
                </span>
                <span>
                  · seen {f.occurrences}× over {f.runs_seen} run{f.runs_seen === 1 ? "" : "s"}
                </span>
                <span>· last {formatDistanceToNow(f.last_seen_at)}</span>
              </div>
            </RecordRow>
          ))}
          {q.data && q.data.total > rows.length && (
            <p className="pt-2 text-center font-mono text-[11px] text-muted-foreground">
              Showing {rows.length} of {q.data.total}. Narrow by severity or search to see the rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── One finding ──────────────────────────────────────────────────────────

type Step = {
  action: string;
  path?: string;
  role?: string;
  name?: string;
  value?: string;
  key?: string;
};

function stepText(s: Step): string {
  if (s.action === "navigate") return `Open ${s.path ?? ""}`;
  const target = `${s.role ?? "element"}${s.name ? ` “${s.name}”` : ""}`;
  if (s.action === "fill") return `Fill the ${target} with “${s.value ?? ""}”`;
  if (s.action === "press") return `Press ${s.key ?? ""}`;
  if (s.action === "select") return `Choose “${s.value ?? ""}” in the ${target}`;
  if (s.action === "back") return "Go back";
  if (s.action === "scroll") return "Scroll";
  if (s.action === "wait") return "Wait";
  return `${s.action[0]?.toUpperCase() ?? ""}${s.action.slice(1)} the ${target}`;
}

const TRIAGE_ACTIONS: Array<{ to: string; label: string; needsReason: boolean }> = [
  { to: "triaging", label: "Mark triaging", needsReason: false },
  { to: "resolved", label: "Resolve by hand", needsReason: false },
  { to: "dismissed", label: "Dismiss", needsReason: true },
  { to: "false_positive", label: "False positive", needsReason: true },
  { to: "open", label: "Reopen", needsReason: false },
];

export function FindingSheet({
  findingId,
  onClose,
}: {
  findingId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const q = useQuery({
    queryKey: ["live-audit-finding", findingId],
    queryFn: () => getLiveAuditFinding({ data: { findingId: findingId! } }),
    enabled: !!findingId,
    refetchInterval: 20_000,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["live-audit-finding", findingId] });
    qc.invalidateQueries({ queryKey: ["live-audit-findings"] });
    qc.invalidateQueries({ queryKey: ["live-audit-overview"] });
  };

  const fixFn = useServerFn(startLiveAuditFixFn);
  const fix = useMutation({
    mutationFn: () => fixFn({ data: { findingId: findingId! } }),
    onSuccess: (r: { reused: boolean }) => {
      toast.success(r.reused ? "A fix for this is already in flight" : "Claude is drafting a fix");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const retestFn = useServerFn(startLiveAuditRun);
  const retest = useMutation({
    mutationFn: () => retestFn({ data: { verifyFindingId: findingId! } }),
    onSuccess: (r: { dispatchError?: string }) => {
      if (r.dispatchError)
        toast.warning(`Re-test queued, but the dispatch failed: ${r.dispatchError}`);
      else toast.success("Re-test dispatched: its page goes first");
      qc.invalidateQueries({ queryKey: ["live-audit-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const triageFn = useServerFn(triageLiveAuditFinding);
  const triage = useMutation({
    mutationFn: (input: { state: string; severity?: string }) =>
      triageFn({
        data: {
          findingId: findingId!,
          state: input.state as never,
          reason: reason.trim() || undefined,
          severity: input.severity as never,
        },
      }),
    onSuccess: () => {
      toast.success("Recorded");
      setReason("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = q.data as any;
  const f = d?.finding;
  const evidence = (f?.evidence ?? {}) as Record<string, any>;
  const steps = (Array.isArray(f?.repro_steps) ? f.repro_steps : []) as Step[];
  const files = (Array.isArray(f?.suspected_files) ? f.suspected_files : []) as Array<{
    path: string;
    line?: number | null;
    reason?: string;
  }>;
  const fixing = f ? ["fix_queued", "fix_in_progress", "fix_pr_open"].includes(f.state) : false;
  const fixable = f
    ? ["open", "triaging"].includes(f.state) && f.category !== "environment"
    : false;

  return (
    <Sheet open={!!findingId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {q.isLoading || !f ? (
          <SheetHeader>
            <SheetTitle>Finding</SheetTitle>
            <SheetDescription>{q.error ? (q.error as Error).message : "Reading…"}</SheetDescription>
          </SheetHeader>
        ) : (
          <div className="space-y-6">
            <SheetHeader className="space-y-2 text-left">
              <div className="flex flex-wrap items-center gap-3">
                <span className={cn(WORD, severityText(f.severity))}>{f.severity}</span>
                <span className={cn(WORD, stateText(f.state))}>{stateLabel(f.state)}</span>
                <span className="label-mono">{f.category}</span>
                <span className="label-mono">{f.detector}</span>
              </div>
              <SheetTitle className="font-display text-xl leading-tight">{f.title}</SheetTitle>
              <SheetDescription className="font-mono text-[11px]">
                {f.route ?? "—"}
                {f.route_template && f.route_template !== f.route
                  ? ` (route ${f.route_template})`
                  : ""}{" "}
                · first seen {formatDistanceToNow(f.first_seen_at)} · last{" "}
                {formatDistanceToNow(f.last_seen_at)} · {f.occurrences}× over {f.runs_seen} run
                {f.runs_seen === 1 ? "" : "s"}
                {f.confidence != null ? ` · confidence ${Number(f.confidence).toFixed(2)}` : ""}
                {f.judged_by ? ` · judged by ${f.judged_by}` : ""}
              </SheetDescription>
            </SheetHeader>

            {d.canAct && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => fix.mutate()}
                  disabled={!fixable || !d.anthropicKey || fix.isPending}
                  title={
                    !d.anthropicKey
                      ? "Waiting on the Anthropic key: every live-audit fix is written by Claude"
                      : !fixable
                        ? fixing
                          ? "A fix is already in flight"
                          : "Only an open defect is fixed"
                        : undefined
                  }
                >
                  <Wrench className="mr-1.5 h-3.5 w-3.5" />
                  {fix.isPending ? "Dispatching…" : "Fix with Claude"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => retest.mutate()}
                  disabled={retest.isPending}
                >
                  <ScanSearch className="mr-1.5 h-3.5 w-3.5" />
                  Re-test now
                </Button>
              </div>
            )}
            {d.canAct && !d.anthropicKey && (
              <p className="border-l-2 border-warning pl-3 text-xs text-muted-foreground">
                Waiting on the Anthropic key. Every live-audit fix is written by Claude Code with
                the key Mission Control syncs into Prime's Actions secrets; until it is set, nothing
                is dispatched.
              </p>
            )}

            {f.description && <p className="text-sm leading-relaxed">{f.description}</p>}

            {steps.length > 0 && (
              <section className="space-y-2">
                <h3 className="label-mono">How a person reaches it</h3>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {steps.map((s, i) => (
                    <li key={i}>{stepText(s)}</li>
                  ))}
                </ol>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {f.deterministic
                    ? "Recurs every time the page is opened."
                    : f.reproduced
                      ? "Reproduced by replaying these steps in a fresh browser."
                      : "Seen while exploring; replay did not confirm it, so it may depend on timing or data."}
                </p>
              </section>
            )}

            {d.screenshotUrl && (
              <section className="space-y-2">
                <h3 className="label-mono">What the browser showed</h3>
                <a href={d.screenshotUrl} target="_blank" rel="noreferrer">
                  <img
                    src={d.screenshotUrl}
                    alt={`The page when the audit saw: ${f.title}`}
                    className="w-full border border-border"
                    loading="lazy"
                  />
                </a>
              </section>
            )}

            {(evidence.console?.length ||
              evidence.stack ||
              evidence.requests?.length ||
              evidence.notes?.length) && (
              <section className="space-y-2">
                <h3 className="label-mono">Evidence</h3>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap border border-border p-3 font-mono text-[11px] leading-relaxed">
                  {[
                    ...(evidence.console ?? []).map((c: string) => `console  ${c}`),
                    evidence.stack ? `stack    ${evidence.stack}` : "",
                    ...(evidence.requests ?? []).map((r: string) => `request  ${r}`),
                    ...(evidence.notes ?? []).map((n: string) => `note     ${n}`),
                  ]
                    .filter(Boolean)
                    .join("\n")}
                </pre>
              </section>
            )}

            {files.length > 0 && (
              <section className="space-y-2">
                <h3 className="label-mono">Where the code is</h3>
                <ul className="space-y-1.5">
                  {files.map((file, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-mono text-[12px]">
                        {file.path}
                        {file.line ? `:${file.line}` : ""}
                      </span>
                      {file.reason && (
                        <span className="text-muted-foreground"> — {file.reason}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {f.fix_hint && (
                  <p className="text-sm text-muted-foreground">Suggested direction: {f.fix_hint}</p>
                )}
              </section>
            )}

            {(d.fixes ?? []).length > 0 && (
              <section className="space-y-2">
                <h3 className="label-mono">Fixes</h3>
                {(d.fixes as any[]).map((x) => (
                  <RecordRow key={x.id} spine={fixSpine(x.status)} className="px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <span className="label-mono">{FIX_STATUS_LABEL[x.status] ?? x.status}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {x.model ?? "default model"} · {x.source} ·{" "}
                        {formatDistanceToNow(x.created_at)}
                      </span>
                      {x.pr_url && (
                        <a
                          href={x.pr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          PR #{x.pr_number} <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    {x.summary && <p className="mt-1 text-xs text-muted-foreground">{x.summary}</p>}
                    {x.last_error && (
                      <p className="mt-1 text-xs text-destructive">{x.last_error}</p>
                    )}
                    {x.fix_confirmed_at && (
                      <p className="mt-1 text-xs text-success">
                        Confirmed {formatDistanceToNow(x.fix_confirmed_at)}: the defect is gone from
                        a complete run.
                      </p>
                    )}
                  </RecordRow>
                ))}
              </section>
            )}

            {d.canAct && (
              <section className="space-y-2">
                <h3 className="label-mono">Decide</h3>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why — required to dismiss or call it a false positive, and kept on its history"
                  rows={2}
                  aria-label="Reason"
                />
                <div className="flex flex-wrap gap-2">
                  {TRIAGE_ACTIONS.filter((a) => triageTransition(f.state, a.to, "x").ok).map(
                    (a) => (
                      <Button
                        key={a.to}
                        size="sm"
                        variant={
                          a.to === "dismissed" || a.to === "false_positive"
                            ? "outline"
                            : "secondary"
                        }
                        disabled={triage.isPending || (a.needsReason && !reason.trim())}
                        onClick={() => triage.mutate({ state: a.to })}
                      >
                        {a.to === "open" && <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}
                        {a.label}
                      </Button>
                    ),
                  )}
                  <Select
                    value={f.severity}
                    onValueChange={(v) =>
                      v !== f.severity && triage.mutate({ state: f.state, severity: v })
                    }
                  >
                    <SelectTrigger className="h-8 w-36" aria-label="Severity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SEVERITIES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {f.triage_reason && (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    Last reason: {f.triage_reason}
                  </p>
                )}
              </section>
            )}

            <section className="space-y-2">
              <h3 className="label-mono">History</h3>
              <ul className="space-y-1">
                {(d.events as any[]).map((e) => (
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
