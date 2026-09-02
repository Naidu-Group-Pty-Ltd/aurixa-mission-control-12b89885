import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { AlertTriangle, CheckCircle2, CloudUpload, HelpCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  attachCloneBackendToken,
  declareCloneBackendDeployer,
  detachCloneBackendToken,
  getCloneBackendDeploy,
} from "@/lib/clone-backend-deploy.functions";
import type { DeployRouteKind } from "@/server/cloneBackendDeploy.pure";

/**
 * Who deploys this clone's Supabase backend, and what has actually been done.
 *
 * Two routes, named in `cloneBackendDeploy.pure.ts`. Mission Control deploys
 * with the credential it already holds, on the cascade that delivers the code;
 * or the clone's own CI deploys with a scoped token in its own repository,
 * which is what a tenant's engineers need when they push directly.
 *
 * The route is DERIVED from the repository's Actions configuration, never
 * stored, so this card cannot claim a route the workflow does not take. The
 * runs beneath it are the evidence: "Mission Control deploys this" is a claim,
 * and a list of what it queued with what outcome is what makes it checkable.
 */

const ROUTE_TONE: Record<DeployRouteKind, { icon: typeof ShieldCheck; variant: string }> = {
  mission_control: { icon: ShieldCheck, variant: "default" },
  clone_ci: { icon: CloudUpload, variant: "default" },
  clone_ci_incomplete: { icon: AlertTriangle, variant: "destructive" },
  nobody: { icon: AlertTriangle, variant: "destructive" },
  unknown: { icon: HelpCircle, variant: "secondary" },
};

const RUN_TONE: Record<string, string> = {
  succeeded: "text-success",
  failed: "text-destructive",
  awaiting_validation: "text-warning",
  skipped: "text-muted-foreground",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-AU");
}

export function CloneBackendDeployCard({ cloneId }: { cloneId: string }) {
  const readFn = useServerFn(getCloneBackendDeploy);
  const attachFn = useServerFn(attachCloneBackendToken);
  const detachFn = useServerFn(detachCloneBackendToken);
  const declareFn = useServerFn(declareCloneBackendDeployer);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-backend-deploy", cloneId],
    queryFn: async () => readFn({ data: { cloneId } }),
  });

  async function attach() {
    if (!token.trim()) return;
    setBusy(true);
    try {
      const res = await attachFn({ data: { cloneId, token } });
      if (!res.ok) {
        // The refusal reason IS the message. It names what the token could
        // reach, which is the only thing that tells an operator how to make a
        // better one.
        toast.error(res.error, { duration: 12_000 });
        return;
      }
      setToken("");
      toast.success("Scoped token placed. This repository's CI deploys its own backend now.");
      void refetch();
    } finally {
      setBusy(false);
    }
  }

  async function declareDeployer() {
    setBusy(true);
    try {
      const res = await declareFn({ data: { cloneId } });
      if (!res.ok) {
        // GitHub's own refusal, verbatim and at length. "Resource not
        // accessible by integration" names the remedy; a tidied summary of it
        // does not, and this is the message an administrator acts on.
        toast.error(res.error ?? "The declaration failed.", { duration: 15_000 });
        return;
      }
      toast.success("Declared. This repository's deploy check will stand down on its next push.");
      void refetch();
    } finally {
      setBusy(false);
    }
  }

  async function detach() {
    if (
      !window.confirm(
        "Remove the deploy token from this repository and hand the backend back to " +
          "Mission Control?\n\nIts CI will stop deploying; Mission Control will deploy " +
          "on the next cascade that changes a function or a migration.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await detachFn({ data: { cloneId } });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Handed back to Mission Control.");
      void refetch();
    } finally {
      setBusy(false);
    }
  }

  const route = data?.route;
  const tone = route ? ROUTE_TONE[route.kind] : ROUTE_TONE.unknown;
  const Icon = tone.icon;
  const holdsToken = route?.kind === "clone_ci" || route?.kind === "clone_ci_incomplete";

  return (
    <Card className="glass-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudUpload className="h-4 w-4" aria-hidden />
          Backend deployment
        </CardTitle>
        <CardDescription>
          Which route ships this clone's edge functions and migrations, and what it has done.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {isLoading && <p className="text-sm text-muted-foreground">Reading…</p>}

        {data?.error && <p className="text-sm text-destructive">{data.error}</p>}

        {route && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="text-sm font-medium">Deployed by</span>
              <Badge variant={tone.variant as never}>{route.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{route.detail}</p>
            {data.repo && (
              <p className="text-xs text-muted-foreground">
                {data.repo.owner}/{data.repo.repo}
                {data.projectRef ? ` → ${data.projectRef}` : " · no Supabase project yet"}
              </p>
            )}

            {/*
              Why the deploy check is red, when it is. The variable being
              absent is a fact; which of "never written" and "not permitted"
              it is decides the remedy, and only one of them is something an
              operator can fix from this page.
            */}
            {data.deployerBlocker && (
              <div className="border-warning/40 bg-warning/5 space-y-2 rounded-md border p-3">
                <p className="flex items-start gap-2 text-sm">
                  <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{data.deployerBlocker}</span>
                </p>
                {data.capabilities.variables.state !== "missing" && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={declareDeployer}>
                    Declare Mission Control as the deployer
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* The trail. A route is a claim; these rows are the evidence for it. */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Backend work Mission Control queued</h4>
          {data && data.runs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing yet. A run appears when a cascade delivers a change under{" "}
              <code className="text-xs">supabase/functions/</code> or{" "}
              <code className="text-xs">supabase/migrations/</code> — a cascade that touches neither
              owes the backend nothing, so an empty list here is a real state rather than a missing
              one.
            </p>
          )}
          {data?.runs.map((run) => (
            <div key={run.id} className="border-border/60 rounded-md border p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{run.action.replace(/_/g, " ")}</span>
                <span className={RUN_TONE[run.status] ?? "text-muted-foreground"}>
                  {run.status.replace(/_/g, " ")}
                </span>
                <span className="text-muted-foreground text-xs">{when(run.createdAt)}</span>
              </div>
              {run.detail && <p className="text-muted-foreground mt-1 text-xs">{run.detail}</p>}
              {/* Progress first: an `executing` row with no progress and one
                  that is two thirds through look identical without it. */}
              {run.progress && <p className="mt-1 text-xs font-medium">{run.progress}</p>}
              {run.lastError && (
                <p className="text-destructive mt-1 text-xs break-words">{run.lastError}</p>
              )}
              {run.reasons.length > 0 && (
                <ul className="text-muted-foreground mt-1 list-disc pl-4 text-xs">
                  {run.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {/* Handing the job to the clone's own CI. */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">
            {holdsToken ? "This repository's own token" : "Let this repository deploy itself"}
          </h4>
          {holdsToken ? (
            <>
              <p className="text-muted-foreground text-sm">
                A scoped token is set in this repository's Actions secrets. It cannot be read back —
                GitHub returns names, never values — so replacing it means pasting a new one.
              </p>
              {data?.lastTokenEvent && (
                <p className="text-muted-foreground text-xs">
                  Last change: {data.lastTokenEvent.action.split(".").pop()?.replace(/_/g, " ")} ·{" "}
                  {when(data.lastTokenEvent.at)}
                </p>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={detach}>
                Hand back to Mission Control
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Only a <strong>scoped</strong> token (<code className="text-xs">sbp_fc…</code>)
              limited to this project is accepted. A classic token carries every permission on every
              project the account can reach — including projects created later — so one in a clone
              repository is fleet-wide database administration. What you paste is checked against
              the API before anything is written, and refused if it can see any project but this
              one.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sbp_fc…"
              className="max-w-sm"
              aria-label="Scoped Supabase access token for this clone"
              autoComplete="off"
            />
            <Button size="sm" disabled={busy || !token.trim()} onClick={attach}>
              {holdsToken ? "Replace token" : "Check and place token"}
            </Button>
          </div>
        </div>

        {route?.kind === "mission_control" && (
          <p className="text-muted-foreground flex items-start gap-2 text-xs">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            No Supabase credential exists in this repository. That is the default and the reason it
            is: the token that would go there reaches every project its account can.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
