// How the Live Audit page says things: one word per state, one spine per
// record, the same everywhere on the page. Client-safe.
import type { SpineTone } from "@/components/record-row";
import { STATE_LABEL, type FindingState } from "@/lib/live-audit-policy";

/**
 * A state word: the label voice, in a tone. `.label-mono` cannot carry one — it
 * sets its own colour among the utilities, so a `text-*` beside it loses — and
 * a coloured word spells the recipe out instead, as `StatusPill` does.
 */
export const WORD = "font-mono text-[10px] uppercase leading-none tracking-[0.18em]";

/** A severity's spine: what the eye finds scanning a column of findings. */
export function severitySpine(severity: string): SpineTone {
  if (severity === "critical" || severity === "high") return "bad";
  if (severity === "medium") return "warn";
  return "idle";
}

/** A severity's word colour. Semantic tokens only. */
export function severityText(severity: string): string {
  if (severity === "critical" || severity === "high") return "text-destructive";
  if (severity === "medium") return "text-warning";
  if (severity === "low") return "text-info";
  return "text-muted-foreground";
}

export function stateLabel(state: string): string {
  return STATE_LABEL[state as FindingState] ?? state;
}

export function stateText(state: string): string {
  if (state === "resolved") return "text-success";
  if (state.startsWith("fix_")) return "text-info";
  if (state === "dismissed" || state === "false_positive") return "text-muted-foreground";
  return "text-foreground";
}

export function runSpine(status: string, complete: boolean | null): SpineTone {
  if (status === "completed") return complete === false ? "warn" : "ok";
  if (status === "failed") return "bad";
  if (status === "canceled") return "idle";
  return "live";
}

export function runStatusText(status: string, complete: boolean | null): string {
  if (status === "completed") return complete === false ? "text-warning" : "text-success";
  if (status === "failed") return "text-destructive";
  if (status === "canceled") return "text-muted-foreground";
  return "text-info";
}

export function runStatusLabel(status: string, complete: boolean | null): string {
  if (status === "completed" && complete === false) return "partial";
  return status;
}

export function fixSpine(status: string): SpineTone {
  if (status === "merged") return "ok";
  if (status === "failed") return "bad";
  if (status === "closed" || status === "canceled") return "idle";
  return "live";
}

export const FIX_STATUS_LABEL: Record<string, string> = {
  queued: "queued",
  dispatched: "Claude is working",
  pr_opened: "PR open",
  pr_updated: "PR updated",
  merged: "merged",
  closed: "closed unmerged",
  failed: "failed",
  canceled: "canceled",
};

export const KIND_LABEL: Record<string, string> = {
  manual: "manual",
  nightly: "nightly",
  verify: "re-test",
};

/** Money a run spent. Not recorded is "—", never "$0.00": absent is not zero. */
export function formatUsd(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

export function durationBetween(from: string | null, to: string | null): string {
  if (!from || !to) return "—";
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return min ? `${min}m ${sec}s` : `${sec}s`;
}

/** The model a run used, and whether a person chose it or it was the default. */
export function modelOf(anthropic: unknown): {
  model: string | null;
  chosen: boolean | null;
  available: boolean | null;
  /** The run was sent with Claude off (Use Claude was off in the settings). */
  off: boolean;
} {
  const a = (anthropic && typeof anthropic === "object" ? anthropic : {}) as Record<
    string,
    unknown
  >;
  return {
    model: typeof a.model === "string" ? a.model : null,
    // The runner's own words (lib/config.mjs on Prime): "chosen" when the
    // settings named a model, "default" when nobody had, "off" when the run
    // was sent with Claude off.
    chosen: a.model_source === "chosen" ? true : a.model_source === "default" ? false : null,
    available: typeof a.available === "boolean" ? a.available : null,
    off: a.model_source === "off",
  };
}

/** One readable line for a timeline event. */
export function describeEvent(e: {
  event_type: string;
  from_state?: string | null;
  to_state?: string | null;
  reason?: string | null;
}): string {
  const move =
    e.from_state && e.to_state && e.from_state !== e.to_state
      ? ` (${stateLabel(e.from_state)} → ${stateLabel(e.to_state)})`
      : "";
  const words: Record<string, string> = {
    "run.queued": "Run queued",
    "run.dispatched": "Dispatched to Prime's Actions",
    "run.started": "The runner started",
    "run.findings": "Findings reported",
    "run.completed": "Run completed",
    "run.failed": "Run failed",
    "run.canceled": "Run canceled",
    "run.timed_out": "Run timed out",
    "run.never_started": "The workflow never started",
    "run.dispatch_failed": "GitHub refused the dispatch",
    "autofix.dispatched": "Automatic fixes started",
    "findings.ingest_failed": "Findings could not be stored",
    detected: "First seen",
    triaged: "Triaged",
    severity_changed: "Severity changed",
    regressed: "Came back after being resolved",
    fix_ineffective: "Seen again after its fix merged",
    fix_confirmed: "Fix confirmed: gone on the next complete run",
    resolved_absent: "Resolved: absent from complete runs",
    "fix.requested": "Fix requested",
    "fix.autofix_dispatched": "Automatic fix dispatched",
    "fix.workflow.started": "Claude started on the fix",
    "fix.branch.pushed": "Fix branch pushed",
    "fix.pr.opened": "Fix PR opened",
    "fix.pr.updated": "Fix PR updated",
    "fix.pr.merged": "Fix PR merged",
    "fix.merged": "Fix PR merged",
    "fix.pr.closed": "Fix PR closed",
    "fix.closed_unmerged": "Fix PR closed unmerged",
    "fix.workflow.failed": "The fix workflow failed",
    "fix.timed_out": "The fix workflow went silent",
  };
  const base =
    words[e.event_type] ??
    (e.event_type.startsWith("phase.") ? `Phase: ${e.event_type.slice(6)}` : e.event_type);
  return `${base}${move}${e.reason ? ` — ${e.reason}` : ""}`;
}
