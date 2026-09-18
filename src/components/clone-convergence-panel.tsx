/**
 * The measured reading, drawn inside the sync card rather than beside it.
 *
 * Step 7 of `CASCADE_PIPELINE_HEALTH.md`. The placement is the argument: a
 * separate card would let an operator read the pointer's green pill and never
 * scroll to the measurement that contradicts it. These two answer the same
 * question — *is this clone in sync?* — and the only useful thing to do with
 * two answers to one question is show them together and say when they differ.
 *
 * Four things it will not do. It never draws an absent reading as a converged
 * one; it never draws a failed read as an absent one; it never alarms on
 * `unknown`, because "we could not check" is not "you have a problem"; and it
 * never prints a class name, because the taxonomy already carries a sentence
 * for every one of them.
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CircleCheck, CircleHelp, Loader2, Scale, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { readCloneConvergence, type CloneConvergenceView } from "@/server/convergence.functions";
import {
  AGREEMENT_NOTE,
  BLOCKAGE_OWNER_LABEL,
  CONVERGENCE_LABEL,
  CONVERGENCE_MEANING,
} from "@/lib/convergenceLabels";
import type { ConvergenceState } from "@/server/cascade/convergenceReading.types";

function stateTone(state: ConvergenceState): string {
  switch (state) {
    case "converged":
      return "text-success";
    case "delivering":
      return "text-info";
    case "stalled":
    case "falling_behind":
      return "text-destructive";
    case "unknown":
      return "text-muted-foreground";
  }
}

function stateBorder(state: ConvergenceState): string {
  switch (state) {
    case "converged":
      return "border-success/40 text-success";
    case "delivering":
      return "border-info/40 text-info";
    case "stalled":
    case "falling_behind":
      return "border-destructive/40 text-destructive";
    case "unknown":
      return "border-border text-muted-foreground";
  }
}

function StateIcon({ state, className }: { state: ConvergenceState; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", stateTone(state), className);
  switch (state) {
    case "converged":
      return <CircleCheck className={cls} />;
    case "delivering":
      return <Truck className={cls} />;
    case "stalled":
    case "falling_behind":
      return <AlertTriangle className={cls} />;
    case "unknown":
      return <CircleHelp className={cls} />;
  }
}

/** Minutes as something a person reads. Never "210". */
function spanOf(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function CloneConvergencePanel({ cloneId }: { cloneId: string }) {
  const readFn = useServerFn(readCloneConvergence);
  const [view, setView] = useState<CloneConvergenceView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const data = await readFn({ data: { cloneId } });
        if (!cancelled) setView(data);
      } catch (e) {
        // A transport failure is a failure to READ, and reads that failed are
        // the one thing this panel exists to keep separate from "nothing here".
        if (!cancelled)
          setView({
            reading: {
              kind: "unavailable",
              why: e instanceof Error ? e.message : "The measurement could not be reached.",
            },
            ledger: { syncStatus: null, commitsBehind: null },
            blockages: null,
          });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneId]);

  return (
    <div className="border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <Scale className="h-3 w-3" /> measured convergence
        </span>
        {view?.reading.kind === "measured" && (
          <Badge
            variant="outline"
            className={cn("font-mono text-[10px] uppercase", stateBorder(view.reading.state))}
          >
            {CONVERGENCE_LABEL[view.reading.state]}
          </Badge>
        )}
      </div>

      {loading && !view ? (
        <p className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Comparing the two trees…
        </p>
      ) : !view ? null : (
        <Body view={view} />
      )}
    </div>
  );
}

function Body({ view }: { view: CloneConvergenceView }) {
  const { reading } = view;

  if (reading.kind === "unavailable") {
    return (
      <div className="space-y-1">
        <p className="font-mono text-xs text-warning">The measurement could not be read.</p>
        <p className="font-mono text-[11px] text-muted-foreground">{reading.why}</p>
        <p className="text-xs text-muted-foreground">
          Nothing is claimed about this clone either way — the reading above is the pointer the
          engine wrote, which is what this comparison exists to check.
        </p>
      </div>
    );
  }

  if (reading.kind === "never_measured") {
    return (
      <div className="space-y-1">
        <p className="font-mono text-xs text-muted-foreground">No measurement recorded yet.</p>
        <p className="text-xs text-muted-foreground">
          The audit compares this clone&rsquo;s tree with prime&rsquo;s and writes what a cascade
          would still owe it. Until it has run once, the sync state above is the only reading there
          is.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <StateIcon state={reading.state} />
          <span className={cn("font-mono text-sm font-semibold", stateTone(reading.state))}>
            {reading.owed === 0 ? "nothing owed" : `${reading.owed.toLocaleString()} owed`}
          </span>
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {reading.compared.toLocaleString()} paths compared
          {reading.held > 0 ? ` · ${reading.held} held` : ""}
          {reading.oversizeHeld > 0 ? ` · ${reading.oversizeHeld} over the size ceiling` : ""}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{CONVERGENCE_MEANING[reading.state]}</p>

      {reading.state === "unknown" && reading.why && (
        <p className="font-mono text-[11px] text-muted-foreground">{reading.why}</p>
      )}

      {reading.unchangedMinutes !== null && reading.owed > 0 && (
        <p className="font-mono text-[11px] text-muted-foreground">
          unchanged for {spanOf(reading.unchangedMinutes)}
          {reading.sloMinutes !== null
            ? ` against a ${spanOf(reading.sloMinutes)} delivery window`
            : ""}
        </p>
      )}

      {reading.agreement !== "agree" && reading.agreement !== "not_comparable" && (
        <p
          className={cn(
            "border-l-2 pl-2 text-xs",
            reading.agreement === "ledger_optimistic"
              ? "border-destructive/60 text-destructive"
              : "border-border text-muted-foreground",
          )}
        >
          {AGREEMENT_NOTE[reading.agreement]}
        </p>
      )}

      <p className="font-mono text-[10px] text-muted-foreground">
        {reading.current ? (
          <>measured {formatDistanceToNow(reading.observedAt)}</>
        ) : (
          <span className="text-warning">
            last measured {formatDistanceToNow(reading.observedAt)} — not a current reading
          </span>
        )}
      </p>

      <Blockages blockages={view.blockages} />
    </div>
  );
}

/**
 * Why it is not converging, where the ledger has an answer.
 *
 * A `stalled` badge with nothing under it is a dead end: the operator is told
 * there is a problem and given no way to find out what it is. These rows are
 * the taxonomy's own prose, and `owner` is what says whether waiting will fix
 * it.
 */
function Blockages({ blockages }: { blockages: CloneConvergenceView["blockages"] }) {
  if (blockages === null) {
    return (
      <p className="font-mono text-[11px] text-warning">
        Open blockages could not be read, so none are listed — that is not the same as none.
      </p>
    );
  }
  if (blockages.length === 0) return null;

  return (
    <ul className="space-y-1.5 border-t border-border pt-2">
      {blockages.map((b) => (
        <li key={b.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <AlertTriangle className="h-3 w-3 shrink-0 translate-y-0.5 text-warning" />
          <span className="flex-1 basis-64 text-xs text-foreground">{b.what}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {BLOCKAGE_OWNER_LABEL[b.owner]} · {formatDistanceToNow(b.firstSeenAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
