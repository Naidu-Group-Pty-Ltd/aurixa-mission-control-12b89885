import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Sparkles, Loader2, CircleCheck, CircleAlert, TriangleAlert, Activity } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  cascadeDryRun,
  type CloneImpact,
  type DryRunResult,
} from "@/server/cascade-dryrun.functions";

export function CascadeDryRunCard({ cloneIds }: { cloneIds?: string[] }) {
  const dryRunFn = useServerFn(cascadeDryRun);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DryRunResult | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const res = await dryRunFn({ data: { cloneIds } });
      setResult(res);
      if (!res.ok) toast.error(res.error);
      else
        toast.success(
          `Dry-run · ${res.totals.green} green · ${res.totals.yellow} yellow · ${res.totals.red} red`,
        );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Dry-run failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-info" /> Dry-run impact matrix
          </CardTitle>
          <CardDescription className="mt-1">
            Probe each clone's installed modules to see who&rsquo;ll actually be touched. AI
            summarizes the riskiest blasts.
          </CardDescription>
        </div>
        <Button size="sm" onClick={run} disabled={running}>
          {running ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          )}
          {running ? "Probing…" : result?.ok ? "Re-run dry-run" : "Run dry-run"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!result && (
          <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
            No dry-run yet. Click <span className="font-mono">Run dry-run</span> to preview the
            blast.
          </div>
        )}
        {result?.ok === false && (
          <div className="border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {result.error}
          </div>
        )}
        {result?.ok && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Tally label="Green" count={result.totals.green} tone="success" />
              <Tally label="Yellow" count={result.totals.yellow} tone="warning" />
              <Tally label="Red" count={result.totals.red} tone="destructive" />
            </div>
            {result.aiSummary && (
              <div className="border border-accent/30 bg-accent/5 p-3">
                <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-accent">
                  <Sparkles className="h-3 w-3" /> AI summary
                </div>
                <p className="text-sm text-foreground">{result.aiSummary}</p>
              </div>
            )}
            <div className="space-y-1">
              {result.cloneImpacts.map((c) => (
                <ImpactRow key={c.cloneId} impact={c} />
              ))}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              prime@{result.sourceSha.slice(0, 7)} · probed {result.cloneImpacts.length} clones
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Tally({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "success" | "warning" | "destructive";
}) {
  const map = {
    success: "border-success/40 bg-success/5 text-success",
    warning: "border-warning/40 bg-warning/5 text-warning",
    destructive: "border-destructive/40 bg-destructive/5 text-destructive",
  };
  return (
    <div className={cn("rounded-md border p-3", map[tone])}>
      <div className="font-mono text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="font-mono text-2xl font-semibold">{count}</div>
    </div>
  );
}

function ImpactRow({ impact }: { impact: CloneImpact }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border bg-surface px-3 py-2",
        impact.level === "red" && "border-destructive/30",
        impact.level === "yellow" && "border-warning/30",
        impact.level === "green" && "border-border/60",
      )}
    >
      <ImpactIcon level={impact.level} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">{impact.name}</span>
          <Badge variant="outline" className="font-mono text-[10px] uppercase">
            {impact.installedModules} mod
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">{impact.reason}</div>
        {/* A rehearsal that hides the two things worth rehearsing for is not
            one. A breakage puts the clone's default branch in a state that
            cannot build, and a removal is irreversible from this screen — so
            both are named here rather than folded into a count. */}
        {impact.breaks.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-destructive">
            {impact.breaks.map((b) => (
              <li key={b} className="truncate">
                {b}
              </li>
            ))}
          </ul>
        )}
        {impact.filesDeleted > 0 && (
          <div className="mt-1 truncate font-mono text-[11px] text-warning">
            would remove {impact.filesDeleted} file(s) prime deleted
          </div>
        )}
        {impact.deletionsWithheld.length > 0 && (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {impact.deletionsWithheld.length} prime deletion(s) withheld —{" "}
            {impact.deletionsWithheld[0].why}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right font-mono text-[11px] text-muted-foreground">
        <div>
          {impact.filesChanged}/{impact.filesInScope}
        </div>
        {impact.filesDeleted > 0 && <div className="text-warning">−{impact.filesDeleted}</div>}
      </div>
    </div>
  );
}

function ImpactIcon({ level }: { level: CloneImpact["level"] }) {
  const cls = "h-4 w-4 shrink-0";
  switch (level) {
    case "green":
      return <CircleCheck className={cn(cls, "text-success")} />;
    case "yellow":
      return <TriangleAlert className={cn(cls, "text-warning")} />;
    case "red":
      return <CircleAlert className={cn(cls, "text-destructive")} />;
  }
}
