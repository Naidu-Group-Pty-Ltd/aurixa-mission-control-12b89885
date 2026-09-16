import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  CircleCheck,
  CircleAlert,
  TriangleAlert,
  Activity,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  cascadeDryRun,
  type CloneImpact,
  type DryRunResult,
} from "@/server/cascade-dryrun.functions";
import {
  approveCascadePaths,
  type PathApprovalKind,
} from "@/server/cascade-path-approvals.functions";

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
        {impact.holdReleases.length > 0 && (
          <div className="mt-1 truncate text-xs text-success">
            {impact.holdReleases.length} hold(s) released —{" "}
            {impact.holdReleases[0].basis === "approved" ? "operator approval" : "on evidence"}:{" "}
            {impact.holdReleases[0].path}
          </div>
        )}
        {/* The two refusals only a recorded operator decision can lift. The
            approval names the exact set the engine measured, so what lands is
            what was read here rather than whatever next week's evidence says. */}
        {impact.deletionRefusal && (
          <div className="mt-1 space-y-1">
            <div className="text-xs text-destructive">{impact.deletionRefusal}</div>
            {impact.refusedDeletionPaths.length > 0 && (
              <PathApprovalDialog
                cloneId={impact.cloneId}
                cloneName={impact.name}
                kind="bulk_deletion"
                paths={impact.refusedDeletionPaths}
                triggerLabel={`Approve deletion of ${impact.refusedDeletionPaths.length} file(s)`}
                explainer={
                  "Every path below was individually proven deleted against prime's own " +
                  "history; only the SET's size stopped it. Approving records your decision " +
                  "for 14 days and the next pass delivers the set whole — through the same " +
                  "per-file evidence rule, so a path that stops qualifying stops travelling."
                }
              />
            )}
          </div>
        )}
        {impact.needsReconcile.length > 0 && (
          <div className="mt-1 space-y-1">
            <div className="truncate text-xs text-warning">
              {impact.needsReconcile.length} held path(s) await a hand-reconcile:{" "}
              {impact.needsReconcile.slice(0, 3).join(", ")}
              {impact.needsReconcile.length > 3 ? "…" : ""}
            </div>
            <PathApprovalDialog
              cloneId={impact.cloneId}
              cloneName={impact.name}
              kind="overwrite"
              paths={impact.needsReconcile}
              triggerLabel="Approve prime's copy for held path(s)…"
              explainer={
                "Approving lets the next cascade write PRIME's current copy over the held " +
                "path(s) below, for 14 days. Do this only where the clone's copy carries no " +
                "work of its own — a hand-merged file that is really stale prime content. " +
                "Protected identity paths are refused by the engine whatever is approved here, " +
                "and delivered files still pass the backend-identity content holds."
              }
              perPath
            />
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

/**
 * Records a `cascade_path_approvals` decision. The reason is mandatory
 * because it IS the record — this dialog is the operator half of the two
 * refusals the engine cannot lift on its own (`planDeletions`'s bulk cap and
 * `decideHoldRelease`'s edited-here verdict).
 */
function PathApprovalDialog({
  cloneId,
  cloneName,
  kind,
  paths,
  triggerLabel,
  explainer,
  perPath = false,
}: {
  cloneId: string;
  cloneName: string;
  kind: PathApprovalKind;
  paths: string[];
  triggerLabel: string;
  explainer: string;
  perPath?: boolean;
}) {
  const approveFn = useServerFn(approveCascadePaths);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(perPath ? [] : paths));
  const [busy, setBusy] = useState(false);

  const chosen = perPath ? [...selected] : paths;

  const submit = async () => {
    if (chosen.length === 0) {
      toast.error("Nothing selected");
      return;
    }
    setBusy(true);
    try {
      const res = await approveFn({ data: { cloneId, kind, paths: chosen, reason } });
      if (!res.ok) {
        toast.error(res.error ?? "Approval failed");
      } else {
        toast.success(
          `Recorded ${res.recorded} ${kind === "bulk_deletion" ? "deletion" : "overwrite"} approval(s) for ${cloneName}`,
        );
        setOpen(false);
        setReason("");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs">
          <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {kind === "bulk_deletion"
              ? "Approve refused deletion set"
              : "Approve held-path overwrite"}
            {" · "}
            {cloneName}
          </DialogTitle>
          <DialogDescription>{explainer}</DialogDescription>
        </DialogHeader>
        <div className="max-h-48 space-y-1 overflow-y-auto border border-border/60 bg-surface p-2">
          {paths.map((p) =>
            perPath ? (
              <label key={p} className="flex items-center gap-2 font-mono text-xs">
                <input
                  type="checkbox"
                  checked={selected.has(p)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(p);
                    else next.delete(p);
                    setSelected(next);
                  }}
                />
                <span className="truncate">{p}</span>
              </label>
            ) : (
              <div key={p} className="truncate font-mono text-xs">
                {p}
              </div>
            ),
          )}
        </div>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why this is safe here (at least 10 characters — this is the record)"
          rows={3}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || reason.trim().length < 10 || chosen.length === 0}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Record approval{chosen.length > 1 ? ` (${chosen.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
