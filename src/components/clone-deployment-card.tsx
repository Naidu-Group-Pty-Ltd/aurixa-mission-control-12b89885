import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { ExternalLink, RefreshCw, Rocket, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "@/lib/format";
import {
  declineCloneDeployment,
  getCloneDeployment,
  redeployClone,
  requestCloneDeployment,
  resyncCloneDeploymentEnv,
  retryCloneDeployment,
} from "@/server/deployment-provisioning.functions";
import { bundleIdentityReading } from "@/lib/bundleIdentityReading.pure";

type Reading = {
  reading: string;
  label: string;
  detail: string;
  tone: "neutral" | "warning" | "destructive" | "success" | "primary";
};

const SPINE: Record<Reading["tone"], string> = {
  neutral: "spine-idle",
  warning: "spine-warn",
  destructive: "spine-bad",
  success: "spine-ok",
  primary: "spine-live",
};
const TONE: Record<Reading["tone"], string> = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
  success: "text-success",
  primary: "text-info",
};

/**
 * Where this clone lives.
 *
 * The card leads with the READING rather than the status string, because
 * "not requested", "waiting on a token", "building" and "failed" are four
 * different facts and three of them are not problems. A status word alone puts
 * the operator in the position of deciding which — which is how "not required"
 * came to read as "clear" elsewhere in this codebase.
 *
 * The DNS block renders what the record SHOULD say beside where that value came
 * from, so somebody debugging a domain that will not verify does not have to
 * open two dashboards to compare two strings.
 */
export function CloneDeploymentCard({ cloneId }: { cloneId: string }) {
  const load = useServerFn(getCloneDeployment);
  const request = useServerFn(requestCloneDeployment);
  const decline = useServerFn(declineCloneDeployment);
  const retry = useServerFn(retryCloneDeployment);
  const redeploy = useServerFn(redeployClone);
  const resync = useServerFn(resyncCloneDeploymentEnv);

  const [state, setState] = useState<Awaited<ReturnType<typeof getCloneDeployment>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await load({ data: { cloneId } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the deployment");
    }
  }, [load, cloneId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    try {
      await fn();
      toast.success(done);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const deployment = state?.deployment ?? null;
  const r = (state?.reading ?? {
    reading: "absent",
    label: "loading",
    detail: "",
    tone: "neutral",
  }) as Reading;
  const origin = deployment?.domain
    ? `https://${deployment.domain}`
    : (deployment?.provider_origin ?? null);

  return (
    <Card className={`spine ${SPINE[r.tone]}`}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-4 w-4 text-info" /> Deployment
            </CardTitle>
            <CardDescription>{r.detail}</CardDescription>
          </div>
          <span className={`label-mono shrink-0 ${TONE[r.tone]}`}>{r.label}</span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {origin && (
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={origin}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" /> {origin.replace(/^https?:\/\//, "")}
            </a>
            <CopyButton value={origin} />
          </div>
        )}

        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <Row label="provider" value={state?.providerSlug ?? "—"} />
          <Row
            label="token"
            value={state?.providerConfigured ? "configured" : "not configured"}
            tone={state?.providerConfigured ? undefined : "text-warning"}
          />
          <Row label="project" value={deployment?.project_name ?? "—"} mono />
          <Row
            label="last build"
            value={
              deployment?.last_deployed_at
                ? formatDistanceToNow(deployment.last_deployed_at)
                : "never"
            }
          />
        </dl>

        {/* What DNS must say for this domain to reach this project, and where
            that value came from. `fleet_default` on a Vercel deployment is the
            misconfiguration that produces a DEPLOYMENT_NOT_FOUND page, so the
            source is shown rather than assumed. */}
        {state?.dnsTarget && deployment?.domain && (
          <div className="glass-inset p-3">
            <div className="label-mono mb-2">expected dns</div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
              <span className="text-muted-foreground">{deployment.domain}</span>
              <span className="text-border-strong">·</span>
              <span>{state.dnsTarget.recordType}</span>
              <span className="text-border-strong">→</span>
              <span className="text-foreground">{state.dnsTarget.recordContent}</span>
              <CopyButton value={state.dnsTarget.recordContent} />
              <span
                className={`ml-auto ${
                  state.dnsTarget.source === "fleet_default"
                    ? "text-warning"
                    : "text-muted-foreground"
                }`}
              >
                {state.dnsTarget.source.replace("_", " ")}
              </span>
            </div>
          </div>
        )}

        {/* What the browser actually downloaded.
            Drawn for every deployment that has one, including the ones that
            have never been read: three of four clones served a bundle pointed
            at the prime's database while every other signal on this card was
            green, and a card that renders nothing for "never checked" cannot
            be told apart from one that checked and was happy. */}
        {deployment &&
          deployment.status !== "not_requested" &&
          (() => {
            const bundle = bundleIdentityReading({
              verdict: deployment.bundle_identity,
              detail: deployment.bundle_identity_detail,
              checkedAt: deployment.bundle_checked_at,
            });
            return (
              <div className="glass-inset p-3">
                <div className="label-mono mb-2">served bundle</div>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={`text-xs font-medium ${TONE[bundle.tone]}`}>{bundle.label}</span>
                  {deployment.bundle_checked_at && (
                    <span className="text-[11px] text-muted-foreground">
                      read {formatDistanceToNow(deployment.bundle_checked_at)} ago
                    </span>
                  )}
                  {deployment.bundle_artefact && (
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      {deployment.bundle_artefact}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{bundle.detail}</p>
              </div>
            );
          })()}

        {deployment?.status_detail && (
          <p className="text-xs text-muted-foreground">{deployment.status_detail}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {(!deployment || deployment.status === "not_requested") && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  "request",
                  () => request({ data: { cloneId, providerSlug: "vercel" } }),
                  "Deployment queued",
                )
              }
            >
              <Rocket className="mr-1.5 h-3.5 w-3.5" /> Deploy with Vercel
            </Button>
          )}
          {deployment?.status === "failed" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => act("retry", () => retry({ data: { cloneId } }), "Re-queued")}
            >
              <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          )}
          {deployment?.project_id && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  act("redeploy", () => redeploy({ data: { cloneId } }), "Redeploy queued")
                }
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Redeploy
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  act("resync", () => resync({ data: { cloneId } }), "Environment re-sync queued")
                }
              >
                Re-sync env
              </Button>
            </>
          )}
          {deployment && deployment.status !== "not_requested" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                act("decline", () => decline({ data: { cloneId } }), "Deployment declined")
              }
            >
              Decline
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="label-mono w-24 shrink-0">{label}</dt>
      <dd className={`${mono ? "font-mono" : ""} ${tone ?? "text-foreground"} truncate`}>
        {value}
      </dd>
    </div>
  );
}
