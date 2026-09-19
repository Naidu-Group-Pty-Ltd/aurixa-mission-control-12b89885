// Phase 11 — SLO surface: fleet uptime + per-clone breakdown.
//
// The reading behind this page was replaced wholesale. It used to be computed
// from `clone_health_snapshots` — one row per clone, so the window buttons
// changed nothing — and from a payload key that has never existed, so it drew
// 0.00% in destructive red across a fleet answering HTTP 200 in under 50 ms.
//
// Two things follow for this page rather than for the function behind it. A
// window ASKED FOR is not a window MEASURED, so the span the evidence actually
// covers is stated rather than implied by the button that is lit. And a clone
// with nothing to ping has no uptime rather than none: it reads "not measured"
// and sorts below every real reading, because an absence is not the worst
// clone in the fleet.
import { createFileRoute } from "@tanstack/react-router";
import { useState, lazy, Suspense } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MetricCell } from "@/components/metric-bar";
import { Activity, RefreshCw, Target } from "lucide-react";
import { computeFleetSlo } from "@/server/reliability.functions";
import { brandDriftTimeseries } from "@/server/reliability.functions";

const SloDriftChart = lazy(() => import("@/components/charts/slo-drift-chart"));

export const Route = createFileRoute("/slo")({
  component: () => (
    <ProtectedRoute>
      <SloPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "SLO — Aurixa Systems Mission Control" }] }),
});

function SloPage() {
  const sloFn = useServerFn(computeFleetSlo);
  const driftFn = useServerFn(brandDriftTimeseries);
  const [days, setDays] = useState(30);
  const slo = useQuery({
    queryKey: ["slo", days],
    queryFn: () => sloFn({ data: { windowDays: days } }),
  });
  const drift = useQuery({
    queryKey: ["brand-drift-ts", days],
    queryFn: () => driftFn({ data: { days } }),
  });

  const fleet = slo.data?.ok ? slo.data : null;
  const sloFailed = slo.data && !slo.data.ok ? slo.data.error : null;
  const series = drift.data?.ok ? drift.data.series : [];

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center bg-success/15 ring-1 ring-success/40">
          <Target className="h-5 w-5 text-success" />
        </div>
        <div className="flex-1">
          <p className="label-mono">reliability</p>
          <h1 className="font-display text-[2.125rem] leading-[1.05]">Fleet SLO</h1>
          <p className="text-sm text-muted-foreground">
            {fleet ? <ObservedSpan fleet={fleet} /> : `Uptime over the last ${days} days.`}
          </p>
        </div>
        <div className="flex gap-1">
          {[7, 30, 90].map((d) => (
            <Button
              key={d}
              variant={d === days ? "default" : "outline"}
              size="sm"
              onClick={() => setDays(d)}
            >
              {d}d
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              slo.refetch();
              drift.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="glass grid overflow-hidden md:grid-cols-3">
        <StatCard
          label="Fleet uptime"
          value={
            fleet?.fleetUptime !== null && fleet?.fleetUptime !== undefined
              ? `${fleet.fleetUptime}%`
              : "—"
          }
          tone={
            fleet?.fleetUptime != null
              ? fleet.fleetUptime >= 99
                ? "success"
                : fleet.fleetUptime >= 95
                  ? "warning"
                  : "destructive"
              : "muted"
          }
        />
        <StatCard
          label="Probes measured"
          value={(fleet?.samplesTotal ?? 0).toLocaleString()}
          note={
            fleet && fleet.unmeasuredTotal > 0
              ? `${fleet.unmeasuredTotal.toLocaleString()} reached no conclusion`
              : undefined
          }
        />
        <StatCard label="Clones tracked" value={(fleet?.clones.length ?? 0).toString()} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" /> Per-clone uptime
          </CardTitle>
          <CardDescription>
            Lowest uptime first. A clone nothing has measured sorts last — an absence is not the
            worst clone in the fleet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sloFailed ? (
            <div className="space-y-1 border border-dashed p-6 text-center">
              <p className="text-sm text-warning">The uptime series could not be read.</p>
              <p className="font-mono text-xs text-muted-foreground">{sloFailed}</p>
              <p className="text-xs text-muted-foreground">
                Nothing is claimed about any clone&rsquo;s uptime — a read that did not happen has
                measured nothing.
              </p>
            </div>
          ) : !fleet || fleet.clones.length === 0 ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              No probes recorded in the window.
            </div>
          ) : (
            <div className="space-y-2">
              {fleet.clones.map((c) => (
                <div
                  key={c.clone_id}
                  className="flex items-center gap-3 border border-border bg-surface p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-semibold truncate">{c.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {c.samples.toLocaleString()} measured
                      {c.unmeasured > 0 ? ` · ${c.unmeasured.toLocaleString()} inconclusive` : ""}
                      {" · "}
                      {c.last_status ? `last: ${c.last_status}` : "never probed"}
                    </div>
                  </div>
                  <UptimeBar pct={c.uptime_pct} />
                  <Badge
                    variant="outline"
                    className={
                      c.uptime_pct === null
                        ? ""
                        : c.uptime_pct >= 99
                          ? "border-success/40 text-success"
                          : c.uptime_pct >= 95
                            ? "border-warning/40 text-warning"
                            : "border-destructive/40 text-destructive"
                    }
                  >
                    {c.uptime_pct === null ? "not measured" : `${c.uptime_pct}%`}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Brand drift severity</CardTitle>
          <CardDescription>Brand assignment status by day.</CardDescription>
        </CardHeader>
        <CardContent>
          {series.length === 0 ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              No drift data in window.
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-[260px] items-center justify-center text-xs text-muted-foreground">
                  Loading chart…
                </div>
              }
            >
              <SloDriftChart series={series} />
            </Suspense>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  note,
  tone = "muted",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "success" | "warning" | "destructive" | "muted";
}) {
  return (
    <MetricCell
      label={label}
      value={value}
      note={note}
      size="sm"
      tone={tone === "muted" ? "neutral" : tone}
      alarm={tone !== "muted"}
    />
  );
}

/**
 * What the evidence actually spans.
 *
 * The window buttons choose a QUESTION. Until the probe series is older than
 * the window, the answer is drawn from less than that — which was true of
 * every reading this page had ever produced and said nowhere.
 */
function ObservedSpan({
  fleet,
}: {
  fleet: { windowDays: number; observedHours: number | null; coversRequestedWindow: boolean };
}) {
  if (fleet.observedHours === null) {
    return <>No probes recorded in the last {fleet.windowDays} days.</>;
  }
  if (fleet.coversRequestedWindow) {
    return <>Uptime over the last {fleet.windowDays} days of probes.</>;
  }
  const span =
    fleet.observedHours < 48
      ? `${Math.round(fleet.observedHours)} hours`
      : `${Math.round(fleet.observedHours / 24)} days`;
  return (
    <>
      Uptime over {span} of probes — the series does not yet reach back {fleet.windowDays} days.
    </>
  );
}

function UptimeBar({ pct }: { pct: number | null }) {
  if (pct === null) return <div className="h-1.5 w-32 rounded-full bg-muted" />;
  const color = pct >= 99 ? "bg-success" : pct >= 95 ? "bg-warning" : "bg-destructive";
  return (
    <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
