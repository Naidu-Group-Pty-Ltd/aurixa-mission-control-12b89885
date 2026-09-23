// Deploy tab: the client's VAPI key, what the fleet needs from an operator, and
// dry run / deploy / roll back into the client's own org.
//
// Secrets are write-only from here. What comes back is a fingerprint and a
// flag - the key a person typed is never returned to any browser - and the
// deploy itself runs on the worker, which is why this page polls.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { CheckCircle2, KeyRound, Rocket, RotateCcw, ScanSearch, XCircle } from "lucide-react";
import { RecordRow } from "@/components/record-row";
import { MonoStatus } from "@/components/voice/tone";
import { CopyButton } from "@/components/copy-button";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  queueStudioDeployment,
  setStudioDeploySettings,
  setStudioVapiKey,
} from "@/lib/voice-studio.functions";
import type { BuildPackage } from "@/lib/voice-studio/package.pure";
import type { DeployStep, VerificationRow } from "@/lib/voice-studio/vapiDeploy.pure";
import type { StudioProjectData } from "./types";

const DEPLOY_TONE = {
  queued: "info",
  running: "info",
  succeeded: "success",
  failed: "destructive",
  cancelled: "neutral",
} as const;

export function DeployTab({ data, refresh }: { data: StudioProjectData; refresh: () => void }) {
  const confirm = useConfirm();
  const projectId = data.project.id;
  const s = data.deploySettings;
  const pkg = data.currentPackage as unknown as BuildPackage | null;
  const current = data.packages.find((p) => p.id === data.project.current_package_id) ?? null;
  const needsTransfer = Boolean(pkg?.tools.some((t) => t.backend === "make_twilio_redirect"));
  const live = data.deployments.find((d) => d.status === "queued" || d.status === "running");
  const deployedPackageIds = new Set(
    data.deployments
      .filter((d) => d.status === "succeeded" && d.mode !== "dry_run")
      .map((d) => d.package_id),
  );
  const rollbackTargets = data.packages.filter(
    (p) => p.id !== current?.id && deployedPackageIds.has(p.id),
  );

  const [apiKey, setApiKey] = useState("");
  const [hook, setHook] = useState("");
  const [escalation, setEscalation] = useState(s.tenant?.escalationNumber ?? "");
  const [callLogUrl, setCallLogUrl] = useState(s.tenant?.callLogUrl ?? "");
  const [callLogSecret, setCallLogSecret] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [rollbackTo, setRollbackTo] = useState("");

  const saveKey = useMutation({
    mutationFn: () => setStudioVapiKey({ data: { projectId, apiKey } }),
    onSuccess: (r) => {
      toast.success("VAPI key verified and stored", {
        description: `Fingerprint ${r.fingerprint}`,
      });
      setApiKey("");
      refresh();
    },
    onError: (e: Error) => toast.error("Key not stored", { description: e.message }),
  });
  const saveSettings = useMutation({
    mutationFn: () =>
      setStudioDeploySettings({
        data: {
          projectId,
          ...(hook.trim() ? { makeTransferHookUrl: hook.trim() } : {}),
          escalationNumber: escalation.trim() || null,
          callLogUrl: callLogUrl.trim() || null,
          ...(callLogSecret.trim() ? { callLogSecret: callLogSecret.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Deploy settings saved");
      setHook("");
      setCallLogSecret("");
      refresh();
    },
    onError: (e: Error) => toast.error("Settings not saved", { description: e.message }),
  });
  const deploy = useMutation({
    mutationFn: (args: { mode: "dry_run" | "apply" | "rollback"; packageId: string }) =>
      queueStudioDeployment({
        data: {
          projectId,
          packageId: args.packageId,
          mode: args.mode,
          phoneNumberId: phoneNumberId.trim() || null,
        },
      }),
    onSuccess: (_r, args) => {
      toast.success(
        args.mode === "dry_run"
          ? "Dry run queued"
          : args.mode === "rollback"
            ? "Rollback queued"
            : "Deploy queued",
        {
          description: "The worker picks it up within a minute.",
        },
      );
      refresh();
    },
    onError: (e: Error) => toast.error("Could not queue", { description: e.message }),
  });

  const canDeploy = Boolean(
    current &&
    current.status === "approved" &&
    s.vapiKey &&
    !live &&
    (!needsTransfer || s.tenant?.transferHookSet),
  );

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="glass space-y-3 p-5">
          <p className="label-mono">Client's VAPI org</p>
          {s.vapiKey ? (
            <p className="text-sm">
              <KeyRound className="mr-1 inline h-3.5 w-3.5" /> Key {s.vapiKey.fingerprint}
              {s.vapiKey.verifiedAt
                ? ` · verified ${formatDistanceToNow(new Date(s.vapiKey.verifiedAt), { addSuffix: true })}`
                : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No key yet. Use the client's own org PRIVATE key - never Mission Control's; that is
              refused.
            </p>
          )}
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={s.vapiKey ? "Rotate the key" : "VAPI private key"}
            />
            <Button
              onClick={() => saveKey.mutate()}
              disabled={apiKey.trim().length < 16 || saveKey.isPending}
            >
              Verify & store
            </Button>
          </div>
        </div>

        <div className="glass space-y-3 p-5">
          <p className="label-mono">Tool backend for this fleet</p>
          {s.tenant ? (
            <>
              <div className="flex items-center gap-2 text-xs">
                <span className="truncate font-mono">{s.tenant.webhookUrl}</span>
                <CopyButton value={s.tenant.webhookUrl} />
              </div>
              <p className="text-xs text-muted-foreground">
                Secret {s.tenant.secretFingerprint} ·{" "}
                {s.tenant.enabled
                  ? "answering tool calls"
                  : "switches on after the first successful deploy"}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Created on the first deploy or settings save: an unguessable URL and its own secret.
            </p>
          )}
        </div>
      </section>

      <section className="glass space-y-4 p-5">
        <p className="label-mono">What an operator supplies</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>
              Make transfer hook{" "}
              {needsTransfer ? "(needed - this fleet transfers to a human)" : "(not needed)"}
            </Label>
            <Input
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              placeholder={
                s.tenant?.transferHookSet
                  ? "set - enter a new one to replace it"
                  : "https://hook.us1.make.com/..."
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Escalation number (what the Make scenario dials)</Label>
            <Input
              value={escalation}
              onChange={(e) => setEscalation(e.target.value)}
              placeholder="+61 2 9999 9999"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Call log URL (the client workspace's vapi-call-webhook)</Label>
            <Input
              value={callLogUrl}
              onChange={(e) => setCallLogUrl(e.target.value)}
              placeholder="https://<project>.supabase.co/functions/v1/vapi-call-webhook"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Call log secret (that workspace's VAPI_WEBHOOK_SECRET)</Label>
            <Input
              type="password"
              autoComplete="off"
              value={callLogSecret}
              onChange={(e) => setCallLogSecret(e.target.value)}
              placeholder={s.tenant?.callLogSecretSet ? "set - enter a new one to replace it" : ""}
            />
          </div>
        </div>
        {!s.tenant?.callLogUrl && (
          <p className="text-xs text-warning">
            With no call log URL, calls work but their logs are not kept anywhere: end-of-call
            reports go to the tool backend, which acknowledges and discards them.
          </p>
        )}
        <Button
          variant="outline"
          onClick={() => saveSettings.mutate()}
          disabled={saveSettings.isPending}
        >
          Save settings
        </Button>
      </section>

      <section className="glass space-y-4 p-5">
        <p className="label-mono">Deploy package v{current?.version ?? "-"}</p>
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <Input
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder="Optional: VAPI phone number id to route to this fleet"
          />
          <Button
            variant="outline"
            disabled={!current || !s.vapiKey || Boolean(live) || deploy.isPending}
            onClick={() => current && deploy.mutate({ mode: "dry_run", packageId: current.id })}
          >
            <ScanSearch className="mr-2 h-4 w-4" /> Dry run
          </Button>
          <Button
            disabled={!canDeploy || deploy.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: `Deploy package v${current!.version}?`,
                description:
                  "This writes the assistants, tools, knowledge base and squad into the client's VAPI org. Anything already deployed by the Studio is updated in place; nothing else in the org is touched.",
                confirmText: "Deploy",
              });
              if (ok) deploy.mutate({ mode: "apply", packageId: current!.id });
            }}
          >
            <Rocket className="mr-2 h-4 w-4" /> Deploy
          </Button>
        </div>
        {current?.status !== "approved" && (
          <p className="text-xs text-muted-foreground">Approve the package first.</p>
        )}
        {needsTransfer && !s.tenant?.transferHookSet && (
          <p className="text-xs text-warning">Set the Make transfer hook before deploying.</p>
        )}
        {rollbackTargets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
            <span className="text-xs text-muted-foreground">Roll back to</span>
            <Select value={rollbackTo} onValueChange={setRollbackTo}>
              <SelectTrigger className="h-8 w-48">
                <SelectValue placeholder="an earlier package" />
              </SelectTrigger>
              <SelectContent>
                {rollbackTargets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    Package v{p.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={!rollbackTo || Boolean(live) || deploy.isPending}
              onClick={() => deploy.mutate({ mode: "rollback", packageId: rollbackTo })}
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Roll back
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <p className="label-mono">History</p>
        {data.deployments.length === 0 && (
          <p className="text-xs text-muted-foreground">Nothing deployed yet.</p>
        )}
        {data.deployments.map((d) => {
          const steps = (Array.isArray(d.steps) ? d.steps : []) as unknown as DeployStep[];
          const verification = (Array.isArray(d.verification)
            ? d.verification
            : []) as unknown as VerificationRow[];
          const version = data.packages.find((p) => p.id === d.package_id)?.version;
          return (
            <RecordRow
              key={d.id}
              spine={d.status === "succeeded" ? "ok" : d.status === "failed" ? "bad" : "live"}
              className="space-y-2 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                  {d.mode.replace("_", " ")} · package v{version ?? "?"} ·{" "}
                  {formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}
                </p>
                <MonoStatus
                  label={d.status}
                  tone={DEPLOY_TONE[d.status as keyof typeof DEPLOY_TONE] ?? "neutral"}
                  pulse={d.status === "running"}
                />
              </div>
              {d.last_error && <p className="text-xs text-destructive">{d.last_error}</p>}
              {steps.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {steps.length} steps
                  </summary>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                    {steps.map((st, i) => (
                      <li
                        key={i}
                        className={
                          st.status === "failed"
                            ? "text-destructive"
                            : st.status === "planned"
                              ? "text-info"
                              : "text-muted-foreground"
                        }
                      >
                        {st.kind} {st.key} · {st.action} · {st.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {verification.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-3 font-normal">assistant</th>
                        {Object.keys(verification[0].checks).map((c) => (
                          <th key={c} className="py-1 pr-3 font-normal">
                            {c.replace(/_/g, " ")}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {verification.map((v) => (
                        <tr key={v.agentKey}>
                          <td className="py-0.5 pr-3 font-mono">{v.agentKey}</td>
                          {Object.keys(verification[0].checks).map((c) => (
                            <td key={c} className="py-0.5 pr-3">
                              {v.checks[c] === undefined ? (
                                "-"
                              ) : v.checks[c] ? (
                                <CheckCircle2 className="h-3 w-3 text-success" />
                              ) : (
                                <XCircle className="h-3 w-3 text-destructive" />
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </RecordRow>
          );
        })}
      </section>

      {data.ledger.length > 0 && (
        <section className="space-y-2">
          <p className="label-mono">In the client's org</p>
          <div className="glass overflow-x-auto p-4">
            <table className="w-full text-xs">
              <tbody>
                {data.ledger.map((l) => (
                  <tr key={`${l.kind}:${l.key}`}>
                    <td className="py-0.5 pr-3 text-muted-foreground">
                      {l.kind.replace("_", " ")}
                    </td>
                    <td className="py-0.5 pr-3">{l.key}</td>
                    <td className="py-0.5 pr-3 font-mono text-muted-foreground">{l.vapi_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
