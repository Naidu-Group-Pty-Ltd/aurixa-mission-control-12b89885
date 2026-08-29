import { useEffect, useState, useCallback } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Shield, RefreshCw, Trash2, Plus, Globe } from "lucide-react";
import { toast } from "sonner";
import { useUserRoles } from "@/lib/use-user-roles";
import {
  enqueueEdgeJob,
  getCloneEdgeStatus,
  applyEdgePreset,
  detachEdge,
  listEdgePresets,
  listEdgeProviders,
} from "@/server/edge-provisioning.functions";
import { formatDistanceToNow } from "@/lib/format";
import {
  readCloudflareDns,
  type CloudflareDnsFacts,
} from "@/lib/hosting/cloudflareDnsReading.pure";

type Provider = {
  slug: string;
  display_name: string;
  status: string;
  description?: string | null;
};
type Preset = {
  slug: string;
  display_name: string;
  description?: string | null;
  settings: Record<string, unknown>;
};
type Config = {
  provider_slug: string;
  hostname: string | null;
  status: string;
  status_detail: string | null;
  posture_preset: string | null;
  external_ref: string | null;
  last_synced_at: string | null;
};
type Job = {
  id: string;
  provider_slug: string;
  action: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export function CloneEdgeCard({ cloneId }: { cloneId: string }) {
  const { isAdmin } = useUserRoles();
  const status = useServerFn(getCloneEdgeStatus);
  const enqueue = useServerFn(enqueueEdgeJob);
  const applyPreset = useServerFn(applyEdgePreset);
  const detach = useServerFn(detachEdge);
  const listPresets = useServerFn(listEdgePresets);
  const listProviders = useServerFn(listEdgeProviders);

  const [providers, setProviders] = useState<Provider[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [dns, setDns] = useState<CloudflareDnsFacts | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // Attach form
  const [newProvider, setNewProvider] = useState<string>("cloudflare");
  const [newHostname, setNewHostname] = useState("");
  const [newPreset, setNewPreset] = useState<string>("balanced");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, pr] = await Promise.all([
        status({ data: { cloneId } }),
        listPresets(),
        listProviders(),
      ]);
      setConfigs((s.configs as Config[]) ?? []);
      setDns((s.dns as CloudflareDnsFacts | null) ?? null);
      setJobs((s.jobs as Job[]) ?? []);
      setPresets((p.presets as Preset[]) ?? []);
      setProviders((pr.providers as Provider[]) ?? []);
    } catch (e) {
      // Silently fail — most likely permissions.
    } finally {
      setLoading(false);
    }
  }, [cloneId, status, listPresets, listProviders]);

  useEffect(() => {
    load();
  }, [load]);

  const attach = async () => {
    if (newProvider === "cloudflare" && !newHostname.trim()) {
      toast.error("Hostname is required for Cloudflare");
      return;
    }
    setBusy("attach");
    try {
      await enqueue({
        data: {
          cloneId,
          providerSlug: newProvider as "cloudflare" | "aws" | "azure",
          action: "attach",
          payload: {
            hostname: newHostname.trim() || undefined,
            posturePreset: newPreset,
          },
        },
      });
      toast.success(
        newProvider === "cloudflare"
          ? "Attach job queued — the worker will run within a minute"
          : `${newProvider.toUpperCase()} waitlisted — this provider is coming soon`,
      );
      setNewHostname("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to enqueue");
    } finally {
      setBusy(null);
    }
  };

  const changePreset = async (providerSlug: string, presetSlug: string) => {
    setBusy(`preset:${providerSlug}`);
    try {
      await applyPreset({
        data: {
          cloneId,
          providerSlug: providerSlug as "cloudflare" | "aws" | "azure",
          presetSlug,
        },
      });
      toast.success("Posture update queued");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const sync = async (providerSlug: string) => {
    setBusy(`sync:${providerSlug}`);
    try {
      await enqueue({
        data: {
          cloneId,
          providerSlug: providerSlug as "cloudflare" | "aws" | "azure",
          action: "sync",
          payload: {},
        },
      });
      toast.success("Sync queued");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const confirm = useConfirm();
  const remove = async (providerSlug: string) => {
    const ok = await confirm({
      title: `Detach ${providerSlug}?`,
      description: "This will remove the edge configuration.",
      confirmText: "Detach",
      destructive: true,
    });
    if (!ok) return;
    setBusy(`detach:${providerSlug}`);
    try {
      await detach({
        data: { cloneId, providerSlug: providerSlug as "cloudflare" | "aws" | "azure" },
      });
      toast.success("Detach queued");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const activeProviderSlugs = new Set(configs.map((c) => c.provider_slug));
  const availableProviders = providers.filter((p) => !activeProviderSlugs.has(p.slug));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Shield className="h-4 w-4 text-info" /> Edge security
        </CardTitle>
        <CardDescription>
          What Cloudflare does for this clone: the subdomain it resolves, and an optional edge/CDN
          wrapper for WAF, bot protection and DDoS mitigation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="font-mono text-xs text-muted-foreground">loading…</div>
        ) : (
          <>
            {/*
              DNS first, and unconditionally. Cloudflare does two jobs for a
              clone and this card used to report only the optional one — so it
              said "No edge provider attached" for a hostname Cloudflare was
              resolving at that moment, three lines above a failed Cloudflare
              job. The wrapper's empty state is now scoped to the wrapper.
            */}
            {(() => {
              const reading = readCloudflareDns(dns);
              const tone =
                reading.tone === "live"
                  ? "default"
                  : reading.tone === "unconfigured"
                    ? "outline"
                    : reading.tone === "drifted"
                      ? "destructive"
                      : "secondary";
              const label =
                reading.tone === "live"
                  ? "Live"
                  : reading.tone === "untracked"
                    ? "Untracked"
                    : reading.tone === "drifted"
                      ? "Drifted"
                      : reading.tone === "pending"
                        ? "Pending"
                        : "Not configured";
              return (
                <div className="border p-4">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Globe className="h-4 w-4" aria-hidden /> DNS · {reading.headline}
                    </div>
                    <Badge variant={tone}>{label}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{reading.detail}</p>
                  {reading.record && <p className="mt-2 font-mono text-xs">{reading.record}</p>}
                </div>
              );
            })()}

            <div className="pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Edge wrapper · optional
            </div>

            {configs.length === 0 && (
              <div className="border border-dashed p-4 text-center text-xs text-muted-foreground">
                No WAF / CDN wrapper attached. This is separate from the DNS above, which Cloudflare
                serves either way.
              </div>
            )}

            {configs.map((c) => {
              const provider = providers.find((p) => p.slug === c.provider_slug);
              const statusTone =
                c.status === "active"
                  ? "text-success"
                  : c.status === "error"
                    ? "text-destructive"
                    : c.status === "waitlisted"
                      ? "text-warning"
                      : "text-muted-foreground";
              return (
                <div key={c.provider_slug} className="border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">
                          {provider?.display_name ?? c.provider_slug}
                        </span>
                        <Badge variant="outline" className={`font-mono text-[10px] ${statusTone}`}>
                          {c.status}
                        </Badge>
                      </div>
                      {c.hostname && (
                        <div className="mt-0.5 flex items-center gap-1 font-mono text-xs text-muted-foreground">
                          <Globe className="h-3 w-3" />
                          {c.hostname}
                        </div>
                      )}
                      {c.status_detail && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {c.status_detail}
                        </div>
                      )}
                      {c.last_synced_at && (
                        <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          last sync · {formatDistanceToNow(c.last_synced_at)}
                        </div>
                      )}
                    </div>
                    {isAdmin && (
                      <div className="flex shrink-0 items-center gap-2">
                        <Select
                          value={c.posture_preset ?? ""}
                          onValueChange={(v) => changePreset(c.provider_slug, v)}
                          disabled={busy !== null || c.status === "waitlisted"}
                        >
                          <SelectTrigger className="h-8 w-[150px] text-xs">
                            <SelectValue placeholder="Posture" />
                          </SelectTrigger>
                          <SelectContent>
                            {presets.map((p) => (
                              <SelectItem key={p.slug} value={p.slug}>
                                {p.display_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null || c.status === "waitlisted"}
                          onClick={() => sync(c.provider_slug)}
                          className="h-8 gap-1 px-2"
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${
                              busy === `sync:${c.provider_slug}` ? "animate-spin" : ""
                            }`}
                          />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => remove(c.provider_slug)}
                          className="h-8 px-2 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {isAdmin && availableProviders.length > 0 && (
              <div className="grid gap-3 border border-dashed border-border p-3 md:grid-cols-4">
                <div className="space-y-1 md:col-span-1">
                  <Label className="text-[11px]">Provider</Label>
                  <Select value={newProvider} onValueChange={setNewProvider}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableProviders.map((p) => (
                        <SelectItem key={p.slug} value={p.slug}>
                          {p.display_name}
                          {p.status !== "available" && ` (${p.status})`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 md:col-span-2">
                  <Label className="text-[11px]">
                    Hostname {newProvider !== "cloudflare" && "(optional)"}
                  </Label>
                  <Input
                    value={newHostname}
                    onChange={(e) => setNewHostname(e.target.value)}
                    placeholder="app.example.com"
                    className="h-9"
                  />
                </div>
                <div className="space-y-1 md:col-span-1">
                  <Label className="text-[11px]">Posture</Label>
                  <Select value={newPreset} onValueChange={setNewPreset}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((p) => (
                        <SelectItem key={p.slug} value={p.slug}>
                          {p.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-4">
                  <Button
                    size="sm"
                    onClick={attach}
                    disabled={busy !== null}
                    className="w-full md:w-auto"
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" /> Attach provider
                  </Button>
                </div>
              </div>
            )}

            {jobs.length > 0 && (
              <div>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  recent jobs
                </div>
                <div className="space-y-1">
                  {jobs.slice(0, 5).map((j) => {
                    const tone =
                      j.status === "succeeded"
                        ? "text-success"
                        : j.status === "failed"
                          ? "text-destructive"
                          : j.status === "running"
                            ? "text-info"
                            : "text-muted-foreground";
                    return (
                      <div
                        key={j.id}
                        className="flex items-center justify-between border px-2 py-1 font-mono text-[11px]"
                      >
                        <span>
                          {j.provider_slug} · {j.action}
                        </span>
                        <span className={tone}>
                          {j.status}
                          {j.attempts > 1 && ` (×${j.attempts})`}
                          {" · "}
                          {formatDistanceToNow(j.created_at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
