import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CRM_MODE_COPY, crmModeLabel, isCrmMode, oppositeCrmMode } from "@/lib/crmMode.pure";
import { describeConversion, isOpenConversionStatus } from "@/server/crmConversion.pure";
import {
  cancelCrmConversion,
  listCrmConversions,
  previewCrmConversion,
  startCrmConversion,
} from "@/lib/crm-conversion.functions";

type Preview = Awaited<ReturnType<typeof previewCrmConversion>>;

/**
 * Move this clone from one CRM line to the other.
 *
 * Three steps, each the server's: a PREVIEW the cascade engine rehearses
 * (writes nothing), a PROPOSAL (one pull request on the clone — merging it is
 * the conversion, and Mission Control never merges it), and the FINISH, which
 * the five-minute drain performs once the pull request lands. Every refusal
 * the page shows is the server's own sentence (`judgeConversion`), so what an
 * operator is told and what would be refused cannot disagree.
 */
export function CloneCrmConversionCard({
  cloneId,
  crmMode,
}: {
  cloneId: string;
  crmMode: string | null | undefined;
}) {
  const listFn = useServerFn(listCrmConversions);
  const previewFn = useServerFn(previewCrmConversion);
  const startFn = useServerFn(startCrmConversion);
  const cancelFn = useServerFn(cancelCrmConversion);

  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  const history = useQuery({
    queryKey: ["clone-crm-conversions", cloneId],
    queryFn: async () => listFn({ data: { cloneId } }),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => isOpenConversionStatus(r.status)) ? 60_000 : false,
  });

  const recorded = isCrmMode(crmMode) ? crmMode : null;
  const toMode = recorded ? oppositeCrmMode(recorded) : null;
  const rows = history.data ?? [];
  const open = rows.find((r) => isOpenConversionStatus(r.status)) ?? null;

  const runPreview = async () => {
    if (!toMode) return;
    setBusy(true);
    try {
      setPreview(await previewFn({ data: { cloneId, toMode } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runStart = async () => {
    if (!toMode) return;
    if (
      !window.confirm(
        `Propose converting this clone to ${CRM_MODE_COPY[toMode].title}? A pull request is opened on ` +
          `the clone's repository. Nothing changes until someone merges it; cascades to this clone ` +
          `are held while it is open.`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await startFn({ data: { cloneId, toMode } });
      if (res.ok) {
        toast.success(
          res.status === "completed"
            ? "Converted — nothing needed delivering"
            : `Proposed as pull request #${res.prNumber}`,
        );
        setPreview(null);
      } else {
        toast.error(res.reason);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await history.refetch();
    }
  };

  const runCancel = async (conversionId: string) => {
    if (
      !window.confirm(
        "Close this conversion's pull request and cancel it? Nothing on the clone changes.",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await cancelFn({ data: { conversionId, cloneId } });
      if (res.ok) toast.success("Conversion cancelled");
      else toast.error(res.reason);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await history.refetch();
    }
  };

  const okPreview = preview && preview.ok ? preview : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4" aria-hidden /> CRM line
            </CardTitle>
            <CardDescription>
              Which CRM this deployment runs, and moving it to the other. A conversion delivers the
              other line's tree as one pull request; records are not moved.
            </CardDescription>
          </div>
          <Badge variant={recorded ? "secondary" : "outline"}>{crmModeLabel(crmMode)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!recorded ? (
          <p className="text-sm text-muted-foreground">
            This clone does not record which CRM it runs, so there is no line to convert it from.
          </p>
        ) : open ? (
          <div className="space-y-2 rounded-lg border border-info/40 bg-info/10 p-3 text-sm">
            <p className="font-medium">{describeConversion(open)}</p>
            {open.error && <p className="text-muted-foreground">{open.error}</p>}
            <div className="flex flex-wrap gap-2">
              {open.pr_url && (
                <Button asChild size="sm" variant="outline">
                  <a href={open.pr_url} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden /> Pull request
                  </a>
                </Button>
              )}
              {open.status === "proposed" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy}
                  onClick={() => void runCancel(open.id)}
                >
                  Cancel conversion
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Converting to <span className="font-medium">{CRM_MODE_COPY[toMode!].title}</span>{" "}
              moves the clone under that line's head. {CRM_MODE_COPY[toMode!].consequence}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void runPreview()}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
                {preview
                  ? "Preview again"
                  : `Preview conversion to ${CRM_MODE_COPY[toMode!].title}`}
              </Button>
              {okPreview && !okPreview.refusal && (
                <Button size="sm" disabled={busy} onClick={() => void runStart()}>
                  Propose conversion
                </Button>
              )}
            </div>

            {preview && !preview.ok && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
                {preview.reason}
              </p>
            )}

            {okPreview && (
              <div className="space-y-3 rounded-lg border p-3 text-sm">
                <p>
                  From <span className="font-medium">{okPreview.leavingLabel}</span> to{" "}
                  <span className="font-medium">{okPreview.targetName}</span>.
                </p>
                {okPreview.refusal && (
                  <p className="text-destructive">Would be refused: {okPreview.refusal}</p>
                )}
                {okPreview.cautions.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {okPreview.cautions.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                {okPreview.plan && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                    <PlanFigure label="Files written" value={okPreview.plan.writes.length} />
                    <PlanFigure label="Files removed" value={okPreview.plan.deletes.length} />
                    <PlanFigure label="Kept for a person" value={okPreview.plan.kept.length} />
                    <PlanFigure
                      label="Functions retired"
                      value={okPreview.plan.retiredFunctions.length}
                    />
                  </dl>
                )}
                {okPreview.plan && okPreview.plan.retiredFunctions.length > 0 && (
                  <p className="text-muted-foreground">
                    Retired once merged:{" "}
                    <span className="font-mono">{okPreview.plan.retiredFunctions.join(", ")}</span>
                  </p>
                )}
                {okPreview.plan && okPreview.plan.deletes.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      Files removed ({okPreview.plan.deletes.length})
                    </summary>
                    <ul className="mt-1 max-h-48 overflow-auto font-mono text-xs">
                      {okPreview.plan.deletes.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {okPreview.plan && okPreview.plan.kept.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      Kept for a person ({okPreview.plan.kept.length})
                    </summary>
                    <ul className="mt-1 max-h-48 space-y-1 overflow-auto text-xs">
                      {okPreview.plan.kept.map((k) => (
                        <li key={k.path}>
                          <span className="font-mono">{k.path}</span> — {k.why}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </>
        )}

        {rows.filter((r) => !isOpenConversionStatus(r.status)).length > 0 && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Earlier conversions</p>
            <ul className="space-y-1">
              {rows
                .filter((r) => !isOpenConversionStatus(r.status))
                .map((r) => (
                  <li key={r.id}>{describeConversion(r)}</li>
                ))}
            </ul>
          </div>
        )}
        {history.isError && (
          <p className="text-sm text-destructive">Could not read this clone's conversions.</p>
        )}
      </CardContent>
    </Card>
  );
}

function PlanFigure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
