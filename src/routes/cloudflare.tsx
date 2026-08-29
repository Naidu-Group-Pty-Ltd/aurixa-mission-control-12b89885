import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow } from "@/components/record-row";
import {
  Shield,
  Lock,
  Bot,
  Gauge,
  Activity,
  Plug,
  AlertTriangle,
  RefreshCw,
  Trash2,
  KeyRound,
} from "lucide-react";
import { useClones } from "@/lib/queries";
import { toast } from "sonner";
import {
  cfTokenStatus,
  cfListZones,
  cfAttachZone,
  cfDetachZone,
  cfApplyPosture,
  cfFleetAnalytics,
  cfSeedZone,
} from "@/server/cloudflare.functions";

export const Route = createFileRoute("/cloudflare")({
  component: () => (
    <ProtectedRoute>
      <CloudflarePage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Cloudflare — Aurixa Systems Mission Control" }] }),
});

const CAPS = [
  { icon: Lock, label: "WAF rules", desc: "Block known attack patterns" },
  { icon: Bot, label: "Bot fight", desc: "Stop scrapers and credential stuffing" },
  { icon: Gauge, label: "Rate limiting", desc: "Throttle abusive clients" },
  { icon: Activity, label: "DDoS shield", desc: "Always-on layer 3-7 mitigation" },
];

function CloudflarePage() {
  const tokenFn = useServerFn(cfTokenStatus);
  const zonesFn = useServerFn(cfListZones);
  const attachFn = useServerFn(cfAttachZone);
  const detachFn = useServerFn(cfDetachZone);
  const postureFn = useServerFn(cfApplyPosture);
  const fleetFn = useServerFn(cfFleetAnalytics);
  const qc = useQueryClient();
  const { data: clones = [] } = useClones();

  const tokenQ = useQuery({ queryKey: ["cf-token"], queryFn: () => tokenFn() });
  const zonesQ = useQuery({
    queryKey: ["cf-zones"],
    queryFn: () => zonesFn(),
    enabled: !!tokenQ.data?.valid,
  });
  const fleetQ = useQuery({ queryKey: ["cf-fleet"], queryFn: () => fleetFn() });

  const attached = useMemo(() => fleetQ.data?.configs ?? [], [fleetQ.data]);
  const totals = useMemo(() => {
    const a = fleetQ.data?.analytics ?? [];
    return {
      requests: a.reduce((s, r) => s + r.requests, 0),
      threats: a.reduce((s, r) => s + r.threats, 0),
      bandwidth: a.reduce((s, r) => s + r.bandwidth, 0),
    };
  }, [fleetQ.data]);

  const attach = useMutation({
    mutationFn: (v: { cloneId: string; zoneId: string }) => attachFn({ data: v }),
    onSuccess: () => {
      toast.success("Zone attached");
      qc.invalidateQueries({ queryKey: ["cf-fleet"] });
      qc.invalidateQueries({ queryKey: ["clones"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const detach = useMutation({
    mutationFn: (cloneId: string) => detachFn({ data: { cloneId } }),
    onSuccess: () => {
      toast.success("Zone detached");
      qc.invalidateQueries({ queryKey: ["cf-fleet"] });
      qc.invalidateQueries({ queryKey: ["clones"] });
    },
  });
  const posture = useMutation({
    mutationFn: (v: Parameters<typeof postureFn>[0]["data"]) => postureFn({ data: v }),
    onSuccess: () => {
      toast.success("Posture applied");
      qc.invalidateQueries({ queryKey: ["cf-fleet"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const seedFn = useServerFn(cfSeedZone);
  const seed = useMutation({
    mutationFn: (v: Parameters<typeof seedFn>[0]["data"]) => seedFn({ data: v }),
    onSuccess: () => {
      toast.success("Zone seeded");
      qc.invalidateQueries({ queryKey: ["cf-fleet"] });
      qc.invalidateQueries({ queryKey: ["clones"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unattachedClones = clones.filter((c) => !attached.some((a) => a.clone_id === c.id));

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center bg-info/15 ring-1 ring-info/40">
          <Shield className="h-5 w-5 text-info" />
        </div>
        <div className="flex-1">
          <p className="label-mono">edge</p>
          <h1 className="font-display text-[2.125rem] leading-[1.05]">Cloudflare</h1>
          <p className="text-sm text-muted-foreground">
            Per-clone WAF, bot, and rate-limit control via the Cloudflare v4 API.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh Cloudflare status"
          onClick={() => {
            tokenQ.refetch();
            fleetQ.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      {/* Token status */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" /> API token
            </CardTitle>
            <CardDescription>
              Stored as the <code className="font-mono">CLOUDFLARE_API_TOKEN</code> server secret
            </CardDescription>
          </div>
          {tokenQ.data?.configured ? (
            tokenQ.data.valid ? (
              <Badge className="bg-success/15 text-success">Active</Badge>
            ) : (
              <Badge variant="destructive">Invalid</Badge>
            )
          ) : (
            <Badge variant="outline">Not configured</Badge>
          )}
        </CardHeader>
        {!tokenQ.data?.configured && (
          <CardContent className="text-sm text-muted-foreground">
            Add the <code>CLOUDFLARE_API_TOKEN</code> secret in Lovable Cloud settings. Required
            scopes: Zone — Read, Zone Settings — Edit, Analytics — Read, and{" "}
            <strong>Account — Turnstile: Edit</strong> for per-clone sign-in widgets. A token
            missing the last one still reports <em>Active</em> here: validity is not scope.
          </CardContent>
        )}
      </Card>

      {/* Capabilities */}
      <div className="grid gap-3 md:grid-cols-4">
        {CAPS.map((c) => (
          <RecordRow key={c.label}>
            <CardContent className="p-5">
              <c.icon className="mb-3 h-5 w-5 text-info" />
              <div className="font-mono text-sm font-semibold">{c.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{c.desc}</div>
            </CardContent>
          </RecordRow>
        ))}
      </div>

      {/* Fleet totals */}
      {tokenQ.data?.valid && (
        <div className="glass grid overflow-hidden md:grid-cols-3">
          <StatCard label="24h requests" value={totals.requests.toLocaleString()} />
          <StatCard
            label="24h threats blocked"
            value={totals.threats.toLocaleString()}
            accent="warning"
          />
          <StatCard
            label="24h bandwidth (MB)"
            value={Math.round(totals.bandwidth / 1024 / 1024).toLocaleString()}
          />
        </div>
      )}

      {/* Attached clones */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Wrapped clones ({attached.length})</CardTitle>
            <CardDescription>Per-zone posture, live</CardDescription>
          </div>
          <div className="flex gap-2">
            {unattachedClones.length > 0 && (
              <SeedZoneDialog
                clones={unattachedClones.map((c) => ({ id: c.id, name: c.name }))}
                onSeed={(v) => seed.mutate(v)}
                pending={seed.isPending}
              />
            )}
            {tokenQ.data?.valid && unattachedClones.length > 0 && (
              <AttachZoneDialog
                clones={unattachedClones.map((c) => ({ id: c.id, name: c.name }))}
                zones={zonesQ.data?.zones ?? []}
                onAttach={(v) => attach.mutate(v)}
              />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {attached.length === 0 ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              No clones wrapped yet. Attach a zone via API token, or seed one manually — both are
              optional.
            </div>
          ) : (
            <div className="space-y-2">
              {attached.map((cfg) => {
                const stats = fleetQ.data?.analytics.find((a) => a.clone_id === cfg.clone_id);
                const clone = clones.find((c) => c.id === cfg.clone_id);
                return (
                  <div
                    key={cfg.clone_id}
                    className="flex flex-col gap-3 border border-border bg-surface p-4 md:flex-row md:items-center"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">
                          {clone?.name ?? cfg.zone_name}
                        </span>
                        <Badge variant="outline" className="border-info/40 text-info text-[10px]">
                          {cfg.zone_name}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {cfg.status}
                        </Badge>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        Sec: {cfg.security_level ?? "—"} · Bot: {cfg.bot_fight_mode ? "on" : "off"}{" "}
                        · WAF: {cfg.waf_preset ?? "—"}
                      </div>
                    </div>
                    {stats && (
                      <div className="flex gap-4 font-mono text-[11px] text-muted-foreground">
                        <span>{stats.requests.toLocaleString()} req</span>
                        <span className="text-warning">
                          {stats.threats.toLocaleString()} threats
                        </span>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <PostureDialog
                        cloneId={cfg.clone_id}
                        current={cfg}
                        onApply={(v) => posture.mutate(v)}
                        pending={posture.isPending}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Detach Cloudflare configuration"
                        onClick={() => detach.mutate(cfg.clone_id)}
                        disabled={detach.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {tokenQ.data?.error && (
        <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{tokenQ.data.error}</span>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: "warning" }) {
  return (
    <MetricCell label={label} value={value} size="sm" tone="warning" alarm={accent === "warning"} />
  );
}

function AttachZoneDialog({
  clones,
  zones,
  onAttach,
}: {
  clones: { id: string; name: string }[];
  zones: { id: string; name: string }[];
  onAttach: (v: { cloneId: string; zoneId: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cloneId, setCloneId] = useState("");
  const [zoneId, setZoneId] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plug className="mr-2 h-4 w-4" /> Attach zone
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach Cloudflare zone</DialogTitle>
          <DialogDescription>Bind a clone to a Cloudflare zone for edge control.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">Clone</label>
            <Select value={cloneId} onValueChange={setCloneId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a clone" />
              </SelectTrigger>
              <SelectContent>
                {clones.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">Zone</label>
            <Select value={zoneId} onValueChange={setZoneId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a zone" />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    {z.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!cloneId || !zoneId}
            onClick={() => {
              onAttach({ cloneId, zoneId });
              setOpen(false);
              setCloneId("");
              setZoneId("");
            }}
          >
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PostureDialog({
  cloneId,
  current,
  onApply,
  pending,
}: {
  cloneId: string;
  current: {
    security_level: string | null;
    bot_fight_mode: boolean;
    rate_limit_rps: number | null;
    waf_preset: string | null;
  };
  onApply: (v: any) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sec, setSec] = useState<string>(current.security_level ?? "medium");
  const [bot, setBot] = useState(current.bot_fight_mode);
  const [rl, setRl] = useState<string>(current.rate_limit_rps?.toString() ?? "");
  const [waf, setWaf] = useState<string>(current.waf_preset ?? "balanced");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Posture
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edge posture</DialogTitle>
          <DialogDescription>Apply security settings to this zone.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              Security level
            </label>
            <Select value={sec} onValueChange={setSec}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["off", "essentially_off", "low", "medium", "high", "under_attack"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              Bot fight mode
            </label>
            <Switch checked={bot} onCheckedChange={setBot} />
          </div>
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              Rate limit (req/sec)
            </label>
            <Input
              type="number"
              value={rl}
              onChange={(e) => setRl(e.target.value)}
              placeholder="0 = off"
            />
          </div>
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              WAF preset
            </label>
            <Select value={waf} onValueChange={setWaf}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["lenient", "balanced", "strict"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => {
              onApply({
                cloneId,
                securityLevel: sec as any,
                botFight: bot,
                rateLimitRps: rl ? Number(rl) : undefined,
                wafPreset: waf as any,
              });
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SeedZoneDialog({
  clones,
  onSeed,
  pending,
}: {
  clones: { id: string; name: string }[];
  onSeed: (v: {
    cloneId: string;
    zoneId: string;
    zoneName: string;
    accountId?: string;
    plan?: string;
    securityLevel?: "off" | "essentially_off" | "low" | "medium" | "high" | "under_attack";
    botFight?: boolean;
    rateLimitRps?: number;
    wafPreset?: "lenient" | "balanced" | "strict";
  }) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cloneId, setCloneId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [zoneName, setZoneName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [plan, setPlan] = useState("");
  const [sec, setSec] = useState<string>("");
  const [bot, setBot] = useState(false);
  const [rl, setRl] = useState("");
  const [waf, setWaf] = useState<string>("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plug className="mr-2 h-4 w-4" /> Seed manually
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Seed Cloudflare zone</DialogTitle>
          <DialogDescription>
            Optional. Bind a clone to a zone without an API token. Posture fields are stored
            locally; live posture apply still requires the{" "}
            <code className="font-mono">CLOUDFLARE_API_TOKEN</code> secret.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">Clone *</label>
            <Select value={cloneId} onValueChange={setCloneId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a clone" />
              </SelectTrigger>
              <SelectContent>
                {clones.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="font-mono text-[11px] uppercase text-muted-foreground">
                Zone ID *
              </label>
              <Input
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                placeholder="e.g. abc123…"
              />
            </div>
            <div>
              <label className="font-mono text-[11px] uppercase text-muted-foreground">
                Zone name *
              </label>
              <Input
                value={zoneName}
                onChange={(e) => setZoneName(e.target.value)}
                placeholder="example.com"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="font-mono text-[11px] uppercase text-muted-foreground">
                Account ID
              </label>
              <Input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="optional"
              />
            </div>
            <div>
              <label className="font-mono text-[11px] uppercase text-muted-foreground">Plan</label>
              <Input
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              Security level
            </label>
            <Select value={sec} onValueChange={setSec}>
              <SelectTrigger>
                <SelectValue placeholder="optional" />
              </SelectTrigger>
              <SelectContent>
                {["off", "essentially_off", "low", "medium", "high", "under_attack"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              Bot fight mode
            </label>
            <Switch checked={bot} onCheckedChange={setBot} />
          </div>
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              Rate limit (req/sec)
            </label>
            <Input
              type="number"
              value={rl}
              onChange={(e) => setRl(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div>
            <label className="font-mono text-[11px] uppercase text-muted-foreground">
              WAF preset
            </label>
            <Select value={waf} onValueChange={setWaf}>
              <SelectTrigger>
                <SelectValue placeholder="optional" />
              </SelectTrigger>
              <SelectContent>
                {["lenient", "balanced", "strict"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending || !cloneId || !zoneId || !zoneName}
            onClick={() => {
              onSeed({
                cloneId,
                zoneId,
                zoneName,
                accountId: accountId || undefined,
                plan: plan || undefined,
                securityLevel: (sec || undefined) as any,
                botFight: bot,
                rateLimitRps: rl ? Number(rl) : undefined,
                wafPreset: (waf || undefined) as any,
              });
              setOpen(false);
              setCloneId("");
              setZoneId("");
              setZoneName("");
              setAccountId("");
              setPlan("");
              setSec("");
              setBot(false);
              setRl("");
              setWaf("");
            }}
          >
            Seed zone
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
