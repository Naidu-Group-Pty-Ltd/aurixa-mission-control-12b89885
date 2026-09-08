import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Database, Loader2, CheckCircle2, AlertTriangle, ArrowUpCircle } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { fleetMigrationSync, getMigrationRegistry } from "@/server/migration-sync.functions";
import { useEffect } from "react";

type Registry = Awaited<ReturnType<typeof getMigrationRegistry>>;
type FleetResult = Extract<Awaited<ReturnType<typeof fleetMigrationSync>>, { ok: true }>;

export function FleetMigrationSyncCard() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<FleetResult | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRegistry = useServerFn(getMigrationRegistry);
  const syncFleet = useServerFn(fleetMigrationSync);

  const load = async () => {
    setLoading(true);
    try {
      const reg = await fetchRegistry();
      setRegistry(reg);
    } catch {
      // silent
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleFleetSync = async () => {
    setSyncing(true);
    try {
      const result = await syncFleet();
      if ("ok" in result && result.ok) {
        setLastResult(result);
        if (result.failed.length > 0) {
          toast.warning(
            `${result.advanced} clone(s) advanced, ${result.failed.length} fell out of sync`,
          );
        } else if (result.advanced > 0) {
          toast.success(`${result.advanced} clone(s) advanced to the prime's latest migration`);
        } else if (result.processed > 0) {
          toast.info(`${result.upToDate} clone(s) already level with the prime`);
        } else {
          toast.info("No clone backend was eligible this run");
        }
      } else if ("error" in result) {
        toast.error(result.error);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fleet sync failed");
    }
    setSyncing(false);
    load();
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" /> Schema Migration Registry
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading registry...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4 text-primary" /> Schema Migration Registry
        </CardTitle>
        <CardDescription>Track and sync database schema across all clone backends.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {registry && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="border p-3 text-center">
                <div className="text-2xl font-semibold">{registry.totalMigrations}</div>
                <div className="text-[11px] text-muted-foreground">Total migrations</div>
              </div>
              <div className="border p-3 text-center">
                <div className="text-2xl font-semibold text-primary">
                  {registry.cloneApplicable}
                </div>
                <div className="text-[11px] text-muted-foreground">Clone-applicable</div>
              </div>
              <div className="border p-3 text-center">
                <div className="font-mono text-sm font-semibold truncate">
                  {registry.latestCloneVersion}
                </div>
                <div className="text-[11px] text-muted-foreground">Latest version</div>
              </div>
            </div>

            {/* Migration list */}
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground">
                View all migrations ({registry.migrations.length})
              </summary>
              <div className="mt-2 max-h-60 overflow-y-auto space-y-1">
                {registry.migrations.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 border p-2 text-xs">
                    {m.cloneApplicable ? (
                      <ArrowUpCircle className="mt-0.5 h-3 w-3 text-primary shrink-0" />
                    ) : (
                      <div className="mt-0.5 h-3 w-3 rounded-full border border-border shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground">{m.id}</span>
                        {m.cloneApplicable && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0">
                            clone
                          </Badge>
                        )}
                      </div>
                      <p className="text-foreground truncate">{m.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </>
        )}

        <Button onClick={handleFleetSync} disabled={syncing} className="w-full">
          {syncing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Syncing fleet...
            </>
          ) : (
            <>
              <ArrowUpCircle className="mr-2 h-4 w-4" /> Sync all clone backends
            </>
          )}
        </Button>

        {/* Last sync results */}
        {lastResult && (
          <div className="space-y-2 border-t pt-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Last sync
            </span>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="text-[10px]">
                {lastResult.processed} processed
              </Badge>
              {lastResult.advanced > 0 && (
                <Badge variant="outline" className="bg-success/10 text-success text-[10px]">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> {lastResult.advanced} advanced
                </Badge>
              )}
              {lastResult.upToDate > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {lastResult.upToDate} already level
                </Badge>
              )}
              {/*
                Excluded backends are shown even when the count is zero-ish
                elsewhere: a clone leaves the eligible set the moment a
                migration fails on it, and "5 processed" while three sit
                outside the query is the quiet half of this whole failure.

                The COUNT was still the quiet half. `2 not eligible` is true,
                unactionable, and reads identically whether the two are
                mid-provision (fine, along shortly) or held out of the fleet
                for a day by a verdict a different worker reached about a job —
                which is what happened on 7-8 Sep 2026 while every run reported
                exactly this badge. Names and reasons are below it now.
              */}
              {lastResult.excluded > 0 && (
                <Badge variant="outline" className="bg-warning/10 text-warning text-[10px]">
                  <AlertTriangle className="mr-1 h-3 w-3" /> {lastResult.excluded} not eligible
                </Badge>
              )}
              {/*
                Withheld is shown for the same reason as excluded. These are
                repo migrations the prime has never applied — rollback scripts,
                future-dated work, files production declined — and they are held
                back from every clone deliberately. A count nobody can see is
                indistinguishable from a corpus that had nothing in it, which is
                precisely how two rollback scripts reached a tenant database.
              */}
              {lastResult.withheld > 0 && (
                <Badge variant="outline" className="text-muted-foreground text-[10px]">
                  {lastResult.withheld} withheld (not applied on the prime)
                </Badge>
              )}
              {/*
                Split, because the total is unreadable in both directions. The
                skew-suspected half is the apply-timestamp mismatch between a
                repo filename and what Lovable stamped when it applied the
                file — harmless for a clone stamped from the prime's ledger.
                The never-applied half is the set worth looking at, so it is the
                one drawn in warning ink.
              */}
              {lastResult.withheldBreakdown.neverApplied > 0 && (
                <Badge variant="outline" className="bg-warning/10 text-warning text-[10px]">
                  {lastResult.withheldBreakdown.neverApplied} never applied on the prime
                </Badge>
              )}
              {lastResult.withheldBreakdown.skewSuspected > 0 && (
                <Badge variant="outline" className="text-muted-foreground text-[10px]">
                  {lastResult.withheldBreakdown.skewSuspected} likely apply-timestamp skew
                </Badge>
              )}
            </div>
            {lastResult.failed.map((r) => (
              <div key={r.cloneId} className="flex items-start justify-between border p-2 text-xs">
                <span className="font-mono">{r.cloneName}</span>
                <span className="ml-2 text-right text-destructive">{r.error}</span>
              </div>
            ))}
            {/*
              Every clone this run did NOT touch, by name, with the reason and
              what to do about it. Only `migration_blocked` is a fault in the
              tenant's database; the rest are ordinary states this lane is
              correct to wait on, and the difference is exactly what a count
              could never carry.
            */}
            {(lastResult.skipped ?? []).map((sk) => (
              <div
                key={sk.cloneId}
                className="flex items-start justify-between gap-2 border p-2 text-xs"
              >
                <span className="font-mono shrink-0">{sk.cloneName}</span>
                <span
                  className={
                    sk.reason === "migration_blocked"
                      ? "text-right text-destructive"
                      : "text-muted-foreground text-right"
                  }
                >
                  {sk.detail}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
