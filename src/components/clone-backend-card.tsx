import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Database,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ArrowUpCircle,
  GitBranch,
  Zap,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { getCloneBackendStatus } from "@/lib/backend-provisioning.functions";
import { getCloneMigrationStatus, syncCloneMigrations } from "@/server/migration-sync.functions";
import { cn } from "@/lib/utils";

type BackendStatus = Awaited<ReturnType<typeof getCloneBackendStatus>>["backend"];
type MigrationStatus = Awaited<ReturnType<typeof getCloneMigrationStatus>>;

type MigrationReport = { id: string; name: string; success: boolean; skipped?: boolean };
type FunctionReport = { slug: string; success: boolean; error?: string };
type SecretReport = { name: string; success: boolean; error?: string };

function asReportArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  ready: { label: "Healthy", color: "text-success", icon: CheckCircle2 },
  provisioning: { label: "Provisioning", color: "text-warning", icon: Loader2 },
  migrating: { label: "Migrating", color: "text-info", icon: Loader2 },
  seeding_admin: { label: "Seeding Admin", color: "text-info", icon: Loader2 },
  pending: { label: "Pending", color: "text-muted-foreground", icon: Loader2 },
  failed: { label: "Failed", color: "text-destructive", icon: AlertTriangle },
  suspended: { label: "Suspended", color: "text-muted-foreground", icon: AlertTriangle },
};

export function CloneBackendCard({ cloneId }: { cloneId: string }) {
  const [backend, setBackend] = useState<BackendStatus>(null);
  const [migration, setMigration] = useState<MigrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchBackendStatus = useServerFn(getCloneBackendStatus);
  const fetchMigrationStatus = useServerFn(getCloneMigrationStatus);
  const syncMigrations = useServerFn(syncCloneMigrations);

  const load = async () => {
    setLoading(true);
    try {
      const [bRes, mRes] = await Promise.all([
        fetchBackendStatus({ data: { cloneId } }),
        fetchMigrationStatus({ data: { cloneId } }),
      ]);
      setBackend(bRes.backend);
      setMigration(mRes);
    } catch {
      // silent
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [cloneId]);

  // Auto-refresh while provisioning
  useEffect(() => {
    if (!backend) return;
    const inProgress = ["pending", "provisioning", "migrating", "seeding_admin"].includes(
      backend.status,
    );
    if (!inProgress) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [backend?.status]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncMigrations({ data: { cloneId } });
      if ("ok" in result && result.ok) {
        toast.success(`Applied ${result.applied} migration(s)`);
        if (result.failures.length > 0) {
          toast.warning(`${result.failures.length} migration(s) failed`);
        }
      } else if ("error" in result) {
        toast.error(result.error);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
    setSyncing(false);
    load();
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" /> Backend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!backend) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-muted-foreground" /> Backend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No dedicated backend provisioned for this clone.
          </p>
        </CardContent>
      </Card>
    );
  }

  const statusCfg = STATUS_CONFIG[backend.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = statusCfg.icon;
  const isActive = ["pending", "provisioning", "migrating", "seeding_admin"].includes(
    backend.status,
  );
  const hasPending = migration?.hasBackend && !migration.isUpToDate;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4 text-primary" /> Dedicated Backend
          </CardTitle>
          <CardDescription className="mt-1">
            {backend.supabase_project_ref
              ? `Project: ${backend.supabase_project_ref}`
              : "Provisioning in progress..."}
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusIcon className={cn("h-4 w-4", statusCfg.color, isActive && "animate-spin")} />
            <span className={cn("text-sm font-medium", statusCfg.color)}>{statusCfg.label}</span>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">
            {backend.region}
          </Badge>
        </div>

        {/* Status detail */}
        {backend.status_detail && (
          <p className="text-xs text-muted-foreground">{backend.status_detail}</p>
        )}

        {/* Error message */}
        {backend.error_message && (
          <div className="border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">{backend.error_message}</p>
          </div>
        )}

        {/* Admin info */}
        {backend.admin_email && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Admin:</span>{" "}
              <span className="font-mono">{backend.admin_email}</span>
            </div>
            {backend.supabase_url && (
              <div>
                <span className="text-muted-foreground">URL:</span>{" "}
                <span className="font-mono truncate">
                  {backend.supabase_url.replace("https://", "")}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Prime replication report */}
        {backend.source_repo && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Replicated Architecture
              </span>
              <Badge variant="outline" className="font-mono text-[10px]">
                <GitBranch className="mr-1 h-3 w-3" />
                {backend.source_repo}
                {backend.source_sha ? `@${backend.source_sha.slice(0, 7)}` : ""}
              </Badge>
            </div>
            {(() => {
              const migrations = asReportArray<MigrationReport>(backend.migrations_applied);
              const functions = asReportArray<FunctionReport>(backend.edge_functions);
              const secrets = asReportArray<SecretReport>(backend.secret_shells);
              const failedFns = functions.filter((f) => !f.success);
              const failedSecrets = secrets.filter((s) => !s.success);
              // The clone's OWN numbers where they were measured this render,
              // and the provisioning run's report where they were not. The two
              // used to be drawn as one snapshot: 425/425 edge functions and
              // "2 migrations" beside a badge naming the commit the migration
              // sync had just refreshed, on a project holding 435 functions and
              // 948 recorded versions.
              const measuredFns = migration?.hasBackend ? migration.deployedFunctions : null;
              const measuredMigrations =
                migration?.hasBackend && migration.basis === "clone_ledger"
                  ? migration.appliedVersionCount
                  : null;
              return (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="border p-2 text-center">
                      <div className="text-lg font-semibold">
                        {measuredMigrations ?? migrations.filter((m) => m.success).length}
                        {measuredMigrations !== null && migration?.hasBackend ? (
                          <span className="text-xs text-muted-foreground">
                            /{migration.runnableVersionCount}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {measuredMigrations === null ? "Migrations (last run)" : "Migrations"}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "rounded-md border p-2 text-center",
                        measuredFns === null && failedFns.length > 0 && "border-warning/50",
                      )}
                    >
                      <div className="text-lg font-semibold">
                        {measuredFns ?? functions.filter((f) => f.success).length}
                        {measuredFns === null && (
                          <span className="text-xs text-muted-foreground">/{functions.length}</span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        <Zap className="mr-0.5 inline h-2.5 w-2.5" />
                        {measuredFns === null ? "Edge functions (last run)" : "Edge functions"}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "rounded-md border p-2 text-center",
                        failedSecrets.length > 0 && "border-warning/50",
                      )}
                    >
                      <div className="text-lg font-semibold">
                        {secrets.filter((s) => s.success).length}
                        <span className="text-xs text-muted-foreground">/{secrets.length}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        <KeyRound className="mr-0.5 inline h-2.5 w-2.5" />
                        Secret shells
                      </div>
                    </div>
                  </div>

                  {failedFns.length > 0 && (
                    <div className="space-y-1">
                      {/*
                        This list is the provisioning run's, and every cascade
                        deploy since has had a chance to fix it. Saying whose
                        it is costs a line and stops a resolved failure reading
                        as a live one — which is the same fault as the counts
                        above, at a smaller scale.
                      */}
                      <p className="text-[10px] text-muted-foreground">
                        Reported by the provisioning run; later deploys are not reflected here.
                      </p>
                      {failedFns.map((f) => (
                        <div
                          key={f.slug}
                          className="border border-warning/40 bg-warning/5 p-2 text-xs"
                        >
                          <span className="font-mono font-medium">{f.slug}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            — {f.error ?? "deploy failed"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {secrets.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                        Secret sync ({secrets.length})
                      </summary>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {secrets.map((s) => {
                          const status = (s as any).status as string | undefined;
                          const isMissing = status === "missing" || (!status && !s.success);
                          const isFailed = status === "failed";
                          return (
                            <Badge
                              key={s.name}
                              variant="outline"
                              className={cn(
                                "font-mono text-[10px]",
                                isMissing && "border-warning/60 text-warning",
                                isFailed && "border-destructive/60 text-destructive",
                              )}
                            >
                              {s.name}
                            </Badge>
                          );
                        })}
                      </div>
                      <a
                        href={`/clones/${cloneId}/secrets`}
                        className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
                      >
                        Manage secret values →
                      </a>
                    </details>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Migration status */}
        {migration?.hasBackend && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Schema Migrations
              </span>
              {migration.isUpToDate ? (
                <Badge variant="outline" className="bg-success/10 text-success text-[10px]">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> Up to date
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-warning/10 text-warning text-[10px]">
                  <ArrowUpCircle className="mr-1 h-3 w-3" /> {migration.pendingCount} pending
                </Badge>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              {migration.basis === "clone_ledger" ? (
                // Where the clone stands, read from the clone. Mission
                // Control's own `currentVersion` is deliberately not drawn
                // beside it: it is a record of the last sync, it was BEHIND the
                // clone on all three deployments, and a stale cursor sitting
                // next to a measured figure is how the two came to be read as
                // one fact.
                <span>
                  Here:{" "}
                  <span className="font-mono">
                    {migration.latestAppliedVersion ?? "nothing recorded"}
                  </span>
                </span>
              ) : (
                <span>
                  Synced to:{" "}
                  <span className="font-mono">{migration.currentVersion ?? "bootstrap"}</span>
                </span>
              )}
              <span>
                Latest: <span className="font-mono">{migration.latestVersion}</span>
              </span>
            </div>

            {/*
              A reading taken from somewhere other than the clone has to say so.
              This is the whole defect: the badge read "5 pending" from Mission
              Control's own cursor while the clone held two of the five and
              could never take a third.

              Not while a run is in progress, though: the server deliberately
              declines to measure a moving backend, and drawing a warning about
              a state the operator can already see moving is noise, not news.
            */}
            {migration.basisNote && !isActive && (
              <p className="border border-warning/40 bg-warning/5 p-2 text-[11px] text-muted-foreground">
                {migration.basisNote}
              </p>
            )}

            {/* Pending migration list */}
            {hasPending && migration.pendingMigrations.length > 0 && (
              <div className="space-y-1">
                {migration.pendingMigrations.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 border p-2 text-xs">
                    <ArrowUpCircle className="mt-0.5 h-3 w-3 text-warning shrink-0" />
                    <div>
                      <span className="font-mono text-[10px] text-muted-foreground">{m.id}</span>
                      <p className="text-foreground">{m.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/*
              Not pending, and not a defect on this clone either.
              `schema_migrations.version` is the PRIMARY KEY, so a version
              carried by two files records one of them; the replay skips by
              version, so the other is skipped for ever, on this clone and on
              every future one. Counting them as work offers a button that can
              never discharge them — a remedy that cannot discharge the reason.
              A disclosure, opened only when there is something in it.
            */}
            {migration.sharedVersions.length > 0 && (
              <details>
                <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                  {migration.sharedVersions.length} version
                  {migration.sharedVersions.length !== 1 ? "s" : ""} shared by more than one
                  migration file
                </summary>
                <div className="mt-1 space-y-1">
                  {migration.sharedVersions.map((s) => (
                    <div key={s.version} className="border p-2 text-xs">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {s.version}
                      </span>
                      <p className="text-muted-foreground">{s.reading}</p>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {hasPending && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleSync}
                disabled={syncing}
                className="w-full"
              >
                {syncing ? (
                  <>
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Applying migrations...
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="mr-2 h-3 w-3" /> Apply {migration.pendingCount}{" "}
                    pending migration{migration.pendingCount !== 1 ? "s" : ""}
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
