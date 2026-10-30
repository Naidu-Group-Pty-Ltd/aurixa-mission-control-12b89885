// The live audit's engine health: every piece it needs, whether it is there,
// and what a person does when it is not. Presence only — never a value.
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordRow } from "@/components/record-row";
import { cn } from "@/lib/utils";
import { getLiveAuditEngineHealth, type LiveAuditHealthCheck } from "@/lib/live-audit.functions";

const ICON = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle } as const;
const TONE = { ok: "text-success", warn: "text-warning", fail: "text-destructive" } as const;
const SPINE = { ok: "ok", warn: "warn", fail: "bad" } as const;

export function LiveAuditHealth() {
  const q = useQuery({
    queryKey: ["live-audit-health"],
    queryFn: () => getLiveAuditEngineHealth(),
    // Several checks read GitHub; the panel's inputs change on deploys.
    refetchInterval: 5 * 60_000,
  });
  const checks = (q.data?.checks ?? []) as LiveAuditHealthCheck[];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {q.isLoading
            ? "Checking…"
            : `${checks.filter((c) => c.status === "ok").length} of ${checks.length} in order`}
        </p>
        <Button variant="ghost" size="sm" onClick={() => q.refetch()} aria-label="Check again">
          <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} />
        </Button>
      </div>
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      <div className="space-y-1.5">
        {checks.map((c) => {
          const Icon = ICON[c.status];
          return (
            <RecordRow key={c.key} spine={SPINE[c.status]} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE[c.status])} aria-hidden />
                <div className="min-w-0 space-y-0.5">
                  <div className="font-medium">{c.label}</div>
                  <div className="text-sm text-muted-foreground">{c.detail}</div>
                  {c.fix && <div className="text-sm">{c.fix}</div>}
                </div>
              </div>
            </RecordRow>
          );
        })}
      </div>
    </div>
  );
}
