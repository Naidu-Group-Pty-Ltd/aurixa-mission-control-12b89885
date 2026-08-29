import { createFileRoute, Link, useParams, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Github,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Waves,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { PageHeaderSkeleton } from "@/components/route-loading";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { CloneActivityHistory } from "@/components/clone-activity-history";
import { CloneBackendCard } from "@/components/clone-backend-card";
import { CloneAddonsCard } from "@/components/clone-addons-card";
import { CloneDriftPolicyCard } from "@/components/clone-drift-policy-card";
import { CloneDriftSuggestionsCard } from "@/components/clone-drift-suggestions-card";
import { CloneEditDialog } from "@/components/clone-edit-dialog";
import { CloneDeploymentCard } from "@/components/clone-deployment-card";
import { CloneTurnstileCard } from "@/components/clone-turnstile-card";
import { CloneEdgeCard } from "@/components/clone-edge-card";
import { CloneHealthCard } from "@/components/clone-health-card";
import { CloneLibraryPinsCard } from "@/components/clone-library-pins";
import { ClonePurchasesCard } from "@/components/clone-purchases-card";
import { CloneSecurityAssessmentsCard } from "@/components/clone-security-assessments-card";
import { CloneCodexScansCard } from "@/components/clone-codex-scans-card";
import { CloneSyncStatusCard } from "@/components/clone-sync-status-card";
import { GitHubSecretSyncCard } from "@/components/github-secret-sync-card";
import { CopyButton } from "@/components/copy-button";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { StatusPill } from "@/components/status-pill";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "@/lib/format";
import type { Clone, Module } from "@/lib/queries";
import { useModules } from "@/lib/queries";
import { bulkSyncModuleFn } from "@/server/module-sync.functions";
import type { DriftSuggestion } from "@/server/drift-suggestions.functions";

const CloneHealthTimeline = lazy(() =>
  import("@/components/clone-health-timeline").then((module) => ({
    default: module.CloneHealthTimeline,
  })),
);

export const Route = createFileRoute("/clones/$cloneId")({
  component: () => (
    <ProtectedRoute>
      <CloneDetail />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
});

function CloneDetail() {
  const { cloneId } = useParams({ from: "/clones/$cloneId" });
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data: allModules } = useModules();
  const [resyncingId, setResyncingId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const query = useQuery({
    queryKey: ["clone-detail", cloneId],
    queryFn: async () => {
      const { data: c, error: cErr } = await supabase
        .from("clones")
        .select("*")
        .eq("id", cloneId)
        .maybeSingle();
      if (cErr) throw cErr;
      const { data: cm, error: mErr } = await supabase
        .from("clone_modules")
        .select("module_id, modules(*)")
        .eq("clone_id", cloneId);
      if (mErr) throw mErr;
      const installed = ((cm ?? []) as Array<{ modules: Module | null }>)
        .map((row) => row.modules)
        .filter((m): m is Module => Boolean(m));
      return { clone: (c as Clone | null) ?? null, installed };
    },
  });

  const clone = query.data?.clone ?? null;
  const installed = query.data?.installed ?? [];
  const loading = query.isPending;
  const load = () => {
    void query.refetch();
  };

  const inject = async (moduleId: string) => {
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from("clone_modules").insert({
      clone_id: cloneId,
      module_id: moduleId,
      installed_by: auth.user?.id,
    });
    if (error) return toast.error(error.message);
    const module = allModules.find((item) => item.id === moduleId);
    await supabase.from("audit_log").insert({
      action: "module.injected",
      entity_type: "clone",
      entity_id: cloneId,
      actor_user_id: auth.user?.id,
      metadata: { module_id: moduleId },
    });
    await supabase.from("notifications").insert({
      kind: "module_installed",
      severity: "info",
      title: `Module installed: ${module?.name ?? "module"}`,
      body: clone ? `On ${clone.name}` : null,
      clone_id: cloneId,
      url: `/clones/${cloneId}`,
      metadata: { module_id: moduleId },
    });
    toast.success("Module injected — pushing commit to repo");
    void load();
  };

  const remove = async (moduleId: string) => {
    const { data: auth } = await supabase.auth.getUser();
    await supabase.from("clone_modules").delete().eq("clone_id", cloneId).eq("module_id", moduleId);
    const module = allModules.find((item) => item.id === moduleId);
    await supabase.from("audit_log").insert({
      action: "module.removed",
      entity_type: "clone",
      entity_id: cloneId,
      actor_user_id: auth.user?.id,
      metadata: { module_id: moduleId },
    });
    await supabase.from("notifications").insert({
      kind: "module_removed",
      severity: "info",
      title: `Module removed: ${module?.name ?? "module"}`,
      body: clone ? `From ${clone.name}` : null,
      clone_id: cloneId,
      url: `/clones/${cloneId}`,
      metadata: { module_id: moduleId },
    });
    toast.success("Module removed");
    void load();
  };

  const resync = async (moduleId: string) => {
    const module = allModules.find((item) => item.id === moduleId);
    setResyncingId(moduleId);
    try {
      const result = await bulkSyncModuleFn({
        data: {
          moduleId,
          cloneIds: [cloneId],
          action: "install",
          cascade: true,
          cascadeMode: "pr",
        },
      });
      if (!result.ok) return toast.error(result.error ?? "Re-sync failed");
      toast.success(`Re-synced ${module?.name ?? "module"} — cascading scoped files`);
      void load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Re-sync failed");
    } finally {
      setResyncingId(null);
    }
  };

  const destroy = async () => {
    const ok = await confirm({
      title: "Delete this clone?",
      description:
        "This permanently removes the clone record and Mission Control metadata. The GitHub repo and backend are not affected.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await supabase.from("notifications").insert({
      kind: "clone_deleted",
      severity: "warning",
      title: `Clone deleted: ${clone?.name ?? "Clone"}`,
      metadata: { clone_id: cloneId },
    });
    await supabase.from("clones").delete().eq("id", cloneId);
    toast.success("Clone deleted");
    void navigate({ to: "/dashboard" });
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton />
        <div className="grid gap-3 md:grid-cols-3">
          <CardRowSkeleton />
          <CardRowSkeleton />
          <CardRowSkeleton />
        </div>
        <CardRowSkeleton />
        <CardRowSkeleton />
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="space-y-3">
        <Link
          to="/dashboard"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> fleet
        </Link>
        <EmptyState
          icon={<AlertTriangle />}
          title="Couldn't load this clone"
          description={
            query.error instanceof Error
              ? query.error.message
              : "Something went wrong fetching this clone."
          }
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!clone) {
    return (
      <div className="space-y-3">
        <Link
          to="/dashboard"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> fleet
        </Link>
        <div>Clone not found.</div>
      </div>
    );
  }

  const installedIds = new Set(installed.map((module) => module.id));
  const available = allModules.filter((module) => !installedIds.has(module.id));

  return (
    <div className="space-y-6">
      <Link
        to="/dashboard"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" /> fleet
      </Link>

      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="label-mono">clone</p>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="font-display text-[2.125rem] leading-[1.05]">{clone.name}</h1>
            <CopyButton value={clone.id} label="clone id" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusPill status={clone.sync_status} behind={clone.commits_behind} />
            <Badge variant="outline" className="font-mono text-[10px] uppercase">
              {clone.provisioning_method}
            </Badge>
            <span className="inline-flex items-center gap-1 font-mono">
              {clone.github_owner}/{clone.github_repo}
              <CopyButton value={`${clone.github_owner}/${clone.github_repo}`} label="repo slug" />
            </span>
            {clone.last_synced_sha && (
              <span className="inline-flex items-center gap-1 font-mono text-xs">
                sha {clone.last_synced_sha.slice(0, 7)}
                <CopyButton value={clone.last_synced_sha} label="commit SHA" />
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-4 w-4" /> Edit
          </Button>
          <Button variant="outline" onClick={() => navigate({ to: "/cascades" })}>
            <Waves className="mr-1.5 h-4 w-4" /> Cascade now
          </Button>
          <Button
            variant="ghost"
            onClick={destroy}
            className="text-destructive hover:text-destructive"
            aria-label="Delete clone"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <CloneEditDialog clone={clone} open={editOpen} onOpenChange={setEditOpen} onSaved={load} />

      <div className="grid gap-3 md:grid-cols-3">
        <InfoTile
          label="GitHub"
          value={clone.github_url ?? "—"}
          icon={<Github className="h-4 w-4" />}
          link={clone.github_url}
        />
        <InfoTile
          label="Lovable"
          value={clone.lovable_project_url ?? "—"}
          icon={<ExternalLink className="h-4 w-4" />}
          link={clone.lovable_project_url}
        />
        <InfoTile
          label="Deploy"
          value={clone.deploy_url ?? "—"}
          icon={<ExternalLink className="h-4 w-4" />}
          link={clone.deploy_url}
        />
      </div>

      <CloneSyncStatusCard clone={clone} />
      <CloneHealthCard cloneId={cloneId} />
      <Suspense
        fallback={
          <Card>
            <CardContent className="p-6 text-xs text-muted-foreground">
              Loading timeline…
            </CardContent>
          </Card>
        }
      >
        <CloneHealthTimeline cloneId={cloneId} />
      </Suspense>
      <CloneAddonsCard cloneId={cloneId} />

      <CloneBackendCard cloneId={cloneId} />
      <CloneDeploymentCard cloneId={cloneId} />
      {/*
        Beside the deployment because that is what it belongs to: the site key
        is published into the hosting environment and only reaches a browser
        when the clone is built again. It sits on THIS page, not only on the
        secrets sub-page, because "Mission Control shows nothing about
        Cloudflare for this clone" is indistinguishable from "Cloudflare is not
        configured" — and one of those was true while the other was not.
      */}
      <CloneTurnstileCard cloneId={cloneId} />
      <ClonePurchasesCard cloneId={cloneId} />
      <GitHubSecretSyncCard target="clone" cloneId={cloneId} />
      <CloneSecurityAssessmentsCard cloneId={cloneId} />
      <CloneCodexScansCard cloneId={cloneId} />
      <ModuleInjector
        installed={installed}
        available={available}
        resyncingId={resyncingId}
        inject={inject}
        remove={remove}
        resync={resync}
      />
      <CloneEdgeCard cloneId={cloneId} />
      <CloneDriftSuggestionsCard
        cloneId={cloneId}
        suggestions={(clone.drift_suggestions as unknown as DriftSuggestion[] | null) ?? []}
        lastCheckedAt={clone.last_drift_check_at}
        onChange={load}
      />
      <CloneLibraryPinsCard cloneId={cloneId} />
      <CloneDriftPolicyCard cloneId={cloneId} />
      <CloneActivityHistory cloneId={cloneId} />
    </div>
  );
}

function ModuleInjector({
  installed,
  available,
  resyncingId,
  inject,
  remove,
  resync,
}: {
  installed: Module[];
  available: Module[];
  resyncingId: string | null;
  inject: (moduleId: string) => void;
  remove: (moduleId: string) => void;
  resync: (moduleId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Module injector</CardTitle>
        <span className="font-mono text-xs text-muted-foreground">
          installed · {installed.length}
        </span>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              installed
            </div>
            <div className="space-y-2">
              {installed.length === 0 && (
                <div className="border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No modules installed
                </div>
              )}
              {installed.map((module) => {
                const noGlobs = (module.file_globs ?? []).length === 0;
                const isResyncing = resyncingId === module.id;
                return (
                  <div
                    key={module.id}
                    className="flex items-center justify-between gap-2 border border-border bg-surface px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-sm">{module.name}</div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {(module.file_globs ?? []).length} glob
                        {(module.file_globs ?? []).length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => resync(module.id)}
                        disabled={isResyncing || noGlobs}
                        title={
                          noGlobs
                            ? "Module has no file_globs to push"
                            : "Re-sync this module's files only"
                        }
                        className="h-7 gap-1 px-2 text-muted-foreground hover:text-primary"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${isResyncing ? "animate-spin" : ""}`} />
                        <span className="font-mono text-[10px] uppercase tracking-wider">
                          re-sync
                        </span>
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(module.id)}
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              available
            </div>
            <div className="space-y-2">
              {available.length === 0 && (
                <div className="border border-dashed p-4 text-center text-sm text-muted-foreground">
                  All modules installed
                </div>
              )}
              {available.map((module) => (
                <div
                  key={module.id}
                  className="flex items-center justify-between border border-border bg-surface px-3 py-2"
                >
                  <span className="font-mono text-sm">{module.name}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => inject(module.id)}
                    className="h-7 w-7 text-muted-foreground hover:text-primary"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function InfoTile({
  label,
  value,
  icon,
  link,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  link?: string | null;
}) {
  const inner = (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 items-center justify-center bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className="truncate text-sm">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
  if (link)
    return (
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        className="block transition-opacity hover:opacity-80"
      >
        {inner}
      </a>
    );
  return inner;
}
