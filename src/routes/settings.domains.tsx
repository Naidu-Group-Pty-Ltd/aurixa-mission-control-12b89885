import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Loader2,
  Globe,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
  KeyRound,
  CircleDot,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  getPlatformHostingConfig,
  updatePlatformHostingConfig,
  reconcilePendingSubdomains,
  listCloneSubdomains,
  verifyCloudflareSetup,
  countPendingSubdomains,
} from "@/server/subdomain-hosting.functions";
import { reconcilePendingDeployments } from "@/server/deployment-provisioning.functions";

export const Route = createFileRoute("/settings/domains")({
  // Renders inside the /settings layout, which already provides ProtectedRoute
  // + AppShell — wrapping again here re-ran the auth check and flashed
  // "authenticating…" inside the settings tabs on every navigation.
  component: () => <DomainsSettings />,
  head: () => ({
    meta: [{ title: "Fleet domains — Aurixa Systems Mission Control" }],
  }),
});

type StepState = "idle" | "ok" | "fail";

function StepPip({ state, label, detail }: { state: StepState; label: string; detail?: string }) {
  const Icon = state === "ok" ? CheckCircle2 : state === "fail" ? XCircle : CircleDot;
  const color =
    state === "ok"
      ? "text-emerald-500"
      : state === "fail"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <div className="flex items-start gap-3 border border-border p-3">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {detail && <div className="mt-0.5 text-xs text-muted-foreground break-words">{detail}</div>}
      </div>
    </div>
  );
}

function DomainsSettings() {
  const cfgFn = useServerFn(getPlatformHostingConfig);
  const listFn = useServerFn(listCloneSubdomains);
  const updateFn = useServerFn(updatePlatformHostingConfig);
  const reconcileFn = useServerFn(reconcilePendingSubdomains);
  const verifyFn = useServerFn(verifyCloudflareSetup);
  const countFn = useServerFn(countPendingSubdomains);
  const reconcileDeploymentsFn = useServerFn(reconcilePendingDeployments);

  const cfgQ = useQuery({ queryKey: ["platform-hosting-config"], queryFn: () => cfgFn() });
  const listQ = useQuery({ queryKey: ["clone-subdomains"], queryFn: () => listFn() });
  const pendingQ = useQuery({
    queryKey: ["subdomain-pending-count"],
    queryFn: () => countFn(),
    refetchInterval: 15_000,
  });

  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [reconcilingDeployments, setReconcilingDeployments] = useState(false);

  useEffect(() => {
    if (cfgQ.data?.config && !form) setForm({ ...cfgQ.data.config });
  }, [cfgQ.data, form]);

  const ready = cfgQ.data?.ready;
  const tokenConfigured = cfgQ.data?.cloudflareTokenConfigured;
  const pending = pendingQ.data?.pending ?? 0;

  const onSave = async () => {
    setSaving(true);
    try {
      await updateFn({
        data: {
          primary_domain: form.primary_domain,
          cloudflare_account_id: form.cloudflare_account_id || null,
          cloudflare_zone_id: form.cloudflare_zone_id || null,
          cloudflare_zone_name: form.cloudflare_zone_name || null,
          target_type: form.target_type,
          target_value: form.target_value,
          proxied: form.proxied,
          auto_provision: form.auto_provision,
          hosting_provider_slug: form.hosting_provider_slug,
          vercel_team_id: form.vercel_team_id || null,
          vercel_project_prefix: form.vercel_project_prefix ?? "",
          auto_deploy: form.auto_deploy,
        },
      });
      toast.success("Hosting configuration saved");
      cfgQ.refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const r = await verifyFn();
      setVerifyResult(r);
      if (r.ready) toast.success("All Cloudflare checks passed — safe to reconcile");
      else toast.warning("One or more Cloudflare checks failed. See details below.");
    } catch (e: any) {
      toast.error(e?.message ?? "Verify failed");
    } finally {
      setVerifying(false);
    }
  };

  const onReconcile = async () => {
    setReconciling(true);
    try {
      const r = await reconcileFn();
      if (r.ok) {
        toast.success(
          r.enqueued > 0
            ? `Enqueued ${r.enqueued} pending subdomain${r.enqueued === 1 ? "" : "s"} — DNS will land within ~1 min`
            : "No pending subdomains to reconcile",
        );
        listQ.refetch();
        pendingQ.refetch();
      } else {
        toast.error(r.error);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Reconcile failed");
    } finally {
      setReconciling(false);
    }
  };

  const step1: StepState = tokenConfigured ? "ok" : "fail";
  const step2: StepState = form?.cloudflare_zone_id ? "ok" : "fail";
  const step3: StepState = ready ? "ok" : "idle";

  const verifySteps = verifyResult?.steps as
    | {
        token: { ok: boolean; detail: string };
        zoneRead: { ok: boolean; detail: string };
        dnsEdit: { ok: boolean; detail: string };
      }
    | undefined;

  if (cfgQ.isLoading || !form) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 font-display text-[1.75rem] leading-[1.1]">
          <Globe className="h-6 w-6" /> Fleet domains
        </h1>
        <p className="text-sm text-muted-foreground">
          Every clone gets an optional{" "}
          <code className="bg-muted px-1 text-xs">{`<slug>.${form.primary_domain}`}</code>{" "}
          subdomain, managed via Cloudflare DNS.
        </p>
      </div>

      {ready ? (
        <Alert className="border-emerald-500/40 bg-emerald-500/10">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <AlertTitle>Live</AlertTitle>
          <AlertDescription>
            Cloudflare token detected and zone{" "}
            <b>{form.cloudflare_zone_name || form.cloudflare_zone_id}</b> configured. New clones
            will auto-provision subdomains.
            {pending > 0 && (
              <span className="ml-1">
                {" "}
                <b>{pending}</b> clone{pending === 1 ? "" : "s"} still stamped{" "}
                <code>pending_platform</code> — hit <em>Reconcile pending</em> below.
              </span>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-amber-500/40 bg-amber-500/10">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <AlertTitle>Dormant — awaiting Cloudflare</AlertTitle>
          <AlertDescription className="space-y-1">
            {!tokenConfigured && (
              <div>
                • Cloudflare API token not configured (secret <code>CLOUDFLARE_API_TOKEN</code>).
              </div>
            )}
            {!form.cloudflare_zone_id && <div>• Cloudflare zone ID not set below.</div>}
            <div className="pt-1 text-xs opacity-80">
              Pending clones are stamped <code>pending_platform</code> and will fan out
              automatically once both are set. <b>{pending}</b> in the queue.
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Guided cutover panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" /> Cutover checklist
          </CardTitle>
          <CardDescription>
            Three steps to flip the fleet from dormant to live. Each check is non-destructive — no
            DNS records are written until you hit <em>Reconcile pending</em>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <StepPip
              state={step1}
              label="1 · CLOUDFLARE_API_TOKEN"
              detail={
                step1 === "ok"
                  ? "Secret configured"
                  : "Add via project secrets. Scopes: Zone:Read + DNS:Edit on aurixasystems.com.au, AND Account:Turnstile:Edit — the same token mints each clone's CAPTCHA widget, and a token with only the first two verifies as active while refusing widget creation."
              }
            />
            <StepPip
              state={step2}
              label="2 · Zone ID saved"
              detail={
                step2 === "ok"
                  ? `Zone ${form.cloudflare_zone_name || form.cloudflare_zone_id}`
                  : "Paste the zone ID from Cloudflare dashboard → Overview → API section"
              }
            />
            <StepPip
              state={step3}
              label="3 · Reconcile pending"
              detail={
                step3 === "ok"
                  ? `${pending} clone${pending === 1 ? "" : "s"} waiting to fan out`
                  : "Complete steps 1 & 2 to enable"
              }
            />
          </div>

          {verifySteps && (
            <div className="grid gap-2 sm:grid-cols-3 pt-1">
              <StepPip
                state={verifySteps.token.ok ? "ok" : "fail"}
                label="Live check · Token"
                detail={verifySteps.token.detail}
              />
              <StepPip
                state={verifySteps.zoneRead.ok ? "ok" : verifySteps.token.ok ? "fail" : "idle"}
                label="Live check · Zone:Read"
                detail={verifySteps.zoneRead.detail}
              />
              <StepPip
                state={verifySteps.dnsEdit.ok ? "ok" : verifySteps.zoneRead.ok ? "fail" : "idle"}
                label="Live check · DNS:Edit"
                detail={verifySteps.dnsEdit.detail}
              />
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" onClick={onVerify} disabled={verifying}>
              {verifying ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="mr-2 h-4 w-4" />
              )}
              Verify Cloudflare
            </Button>
            <Button onClick={onReconcile} disabled={!ready || reconciling}>
              {reconciling ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Reconcile pending {pending > 0 && `(${pending})`}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Platform configuration</CardTitle>
          <CardDescription>
            Applies to every subdomain we mint. Changes take effect on the next provisioning job.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Primary domain</Label>
              <Input
                value={form.primary_domain}
                onChange={(e) => setForm({ ...form, primary_domain: e.target.value })}
              />
              <p className="pt-1 text-xs text-muted-foreground">
                Root apex — leave blank subdomains at the registrar so we can write child records.
              </p>
            </div>
            <div>
              <Label>Cloudflare zone ID</Label>
              <Input
                value={form.cloudflare_zone_id ?? ""}
                onChange={(e) => setForm({ ...form, cloudflare_zone_id: e.target.value.trim() })}
                placeholder="e.g. 3f8b…"
              />
            </div>
            <div>
              <Label>Cloudflare account ID</Label>
              <Input
                value={form.cloudflare_account_id ?? ""}
                onChange={(e) => setForm({ ...form, cloudflare_account_id: e.target.value.trim() })}
              />
            </div>
            <div>
              <Label>Zone name (display)</Label>
              <Input
                value={form.cloudflare_zone_name ?? ""}
                onChange={(e) => setForm({ ...form, cloudflare_zone_name: e.target.value })}
                placeholder={form.primary_domain}
              />
            </div>
            <div>
              <Label>Record type</Label>
              <Select
                value={form.target_type}
                onValueChange={(v) => setForm({ ...form, target_type: v })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="a">A (IP)</SelectItem>
                  <SelectItem value="cname">CNAME (hostname)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Target value</Label>
              <Input
                value={form.target_value}
                onChange={(e) => setForm({ ...form, target_value: e.target.value })}
              />
              <p className="pt-1 text-xs text-muted-foreground">
                Lovable default: <code>185.158.133.1</code> (A).
              </p>
            </div>
          </div>

          <div className="flex items-center gap-6 pt-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={!!form.proxied}
                onCheckedChange={(v) => setForm({ ...form, proxied: v })}
              />
              Cloudflare proxy (orange cloud)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={!!form.auto_provision}
                onCheckedChange={(v) => setForm({ ...form, auto_provision: v })}
              />
              Auto-provision subdomains on clone creation
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <Button onClick={onSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hosting</CardTitle>
          <CardDescription>
            Who builds a clone and serves it. This is a different question from DNS: a zone with a
            valid token and no hosting provider is a fleet whose names resolve to an origin that
            serves nobody. The DNS target above is the FLEET DEFAULT — a clone with its own
            deployment overrides it with the record its provider issued.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>Hosting provider</Label>
              <Select
                value={form.hosting_provider_slug ?? "manual"}
                onValueChange={(v) => setForm({ ...form, hosting_provider_slug: v })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vercel">Vercel</SelectItem>
                  <SelectItem value="manual">Manual target (current)</SelectItem>
                </SelectContent>
              </Select>
              <p className="pt-1 text-xs text-muted-foreground">
                {cfgQ.data?.hostingTokenConfigured
                  ? "VERCEL_API_TOKEN is configured."
                  : "VERCEL_API_TOKEN is not set — new deployments record as pending and fan out once it lands."}
              </p>
            </div>
            <div>
              <Label>Vercel team ID</Label>
              <Input
                value={form.vercel_team_id ?? ""}
                onChange={(e) => setForm({ ...form, vercel_team_id: e.target.value })}
                placeholder={cfgQ.data?.hostingTeamId ?? "team_… (blank for a personal account)"}
              />
              <p className="pt-1 text-xs text-muted-foreground">
                Omitting this on a team account operates on the personal account instead, which is
                how a project ends up somewhere nobody on the team can see it.
              </p>
            </div>
            <div>
              <Label>Project name prefix</Label>
              <Input
                value={form.vercel_project_prefix ?? ""}
                onChange={(e) => setForm({ ...form, vercel_project_prefix: e.target.value })}
                placeholder="aurixa-"
              />
              <p className="pt-1 text-xs text-muted-foreground">
                Prepended to the clone slug. A project name is a namespace — two clones cannot share
                one.
              </p>
            </div>
            <div className="self-end">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={!!form.auto_deploy}
                  onCheckedChange={(v) => setForm({ ...form, auto_deploy: v })}
                />
                Deploy automatically on clone creation
              </label>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={onSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
            {/* The way OUT of the dormant posture. Recording a request while no
                token exists is only honest if there is a way to fan the backlog
                out that does not mean touching every clone by hand. */}
            <Button
              variant="outline"
              disabled={reconcilingDeployments || !cfgQ.data?.hostingTokenConfigured}
              onClick={async () => {
                setReconcilingDeployments(true);
                try {
                  const res = await reconcileDeploymentsFn();
                  if (res.ok) toast.success(`Queued ${res.enqueued} deployment(s)`);
                  else toast.error("Hosting provider is not configured");
                } catch (e: any) {
                  toast.error(e?.message ?? "Reconcile failed");
                } finally {
                  setReconcilingDeployments(false);
                }
              }}
            >
              {reconcilingDeployments && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reconcile pending deployments
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Provisioned subdomains</CardTitle>
          <CardDescription>All clones with a subdomain intent recorded.</CardDescription>
        </CardHeader>
        <CardContent>
          {listQ.isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (listQ.data?.rows ?? []).length === 0 ? (
            <EmptyState
              icon={<Globe />}
              title="No subdomains yet"
              description="Clones with a recorded subdomain intent will appear here once provisioned."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2">Clone</th>
                    <th>FQDN</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {listQ.data!.rows.map((r: any) => {
                    const variant =
                      r.subdomain_status === "active"
                        ? "default"
                        : r.subdomain_status === "failed"
                          ? "destructive"
                          : "secondary";
                    return (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-2">{r.name || r.slug}</td>
                        <td className="font-mono text-xs">{r.subdomain_fqdn}</td>
                        <td>
                          <Badge variant={variant as any}>{r.subdomain_status ?? "unknown"}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
