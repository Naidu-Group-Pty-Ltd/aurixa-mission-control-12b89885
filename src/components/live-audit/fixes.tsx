// The live audit's fixes: every one Claude drafted, where its pull request is,
// and whether the next complete run confirmed the defect gone.
import { ExternalLink } from "lucide-react";
import { RecordRow } from "@/components/record-row";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FIX_STATUS_LABEL, WORD, fixSpine, severityText } from "./labels";

export type FixRow = {
  id: string;
  finding_id: string;
  status: string;
  model: string | null;
  source: string;
  pr_number: number | null;
  pr_url: string | null;
  workflow_run_url: string | null;
  last_error: string | null;
  created_at: string;
  merged_at: string | null;
  fix_confirmed_at: string | null;
  files_changed: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  finding: { title: string; severity: string; state: string } | null;
};

export function LiveAuditFixes({
  fixes,
  onOpenFinding,
}: {
  fixes: FixRow[];
  onOpenFinding: (id: string) => void;
}) {
  if (fixes.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No fix yet. Open a finding and ask Claude for one, or turn automatic fixes on under
        Settings.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {fixes.map((x) => (
        <RecordRow key={x.id} spine={fixSpine(x.status)} className="px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={cn(
                WORD,
                x.status === "failed"
                  ? "text-destructive"
                  : x.status === "merged"
                    ? "text-success"
                    : "text-info",
              )}
            >
              {FIX_STATUS_LABEL[x.status] ?? x.status}
            </span>
            <button
              type="button"
              onClick={() => onOpenFinding(x.finding_id)}
              className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
            >
              {x.finding?.title ?? "A finding"}
            </button>
            {x.pr_url && (
              <a
                href={x.pr_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                PR #{x.pr_number} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-muted-foreground">
            {x.finding && (
              <span className={severityText(x.finding.severity)}>{x.finding.severity}</span>
            )}
            <span>· {x.model ?? "default model"}</span>
            <span>· {x.source === "autofix" ? "automatic" : "asked for"}</span>
            {x.files_changed != null && (
              <span>
                · {x.files_changed} file{x.files_changed === 1 ? "" : "s"}, +{x.lines_added ?? 0} −
                {x.lines_removed ?? 0}
              </span>
            )}
            <span>· {formatDistanceToNow(x.created_at)}</span>
            {x.fix_confirmed_at && <span className="text-success">· confirmed gone</span>}
            {x.merged_at && !x.fix_confirmed_at && (
              <span>· merged, awaiting the next complete run</span>
            )}
          </div>
          {x.last_error && (
            <p className="mt-1 line-clamp-2 text-xs text-destructive">{x.last_error}</p>
          )}
        </RecordRow>
      ))}
    </div>
  );
}
