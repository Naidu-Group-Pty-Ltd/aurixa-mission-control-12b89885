import { createFileRoute, Link, useParams, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  ChevronDown,
  ExternalLink,
  GitMerge,
  Github,
  KeyRound,
  Loader2,
  Megaphone,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Waves,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/empty-state";
import { PageHeaderSkeleton } from "@/components/route-loading";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { CloneActivityHistory } from "@/components/clone-activity-history";
import { CloneBackendCard } from "@/components/clone-backend-card";
import { CloneAddonsCard } from "@/components/clone-addons-card";
import { CloneBillingIdentityCard } from "@/components/clone-billing-identity-card";
import { ClonePaymentGateCard } from "@/components/clone-payment-gate-card";
import { CloneDriftPolicyCard } from "@/components/clone-drift-policy-card";
import { CloneDriftSuggestionsCard } from "@/components/clone-drift-suggestions-card";
import { CloneEditDialog } from "@/components/clone-edit-dialog";
import { CloneDeploymentCard } from "@/components/clone-deployment-card";
import { CloneEmailIdentityCard } from "@/components/clone-email-identity-card";
import { CloneAccessCredentialsCard } from "@/components/clone-access-credentials-card";
import { CloneTurnstileCard } from "@/components/clone-turnstile-card";
import { CloneCrmConversionCard } from "@/components/clone-crm-conversion-card";
import { CloneVoiceAutomationCard } from "@/components/clone-voice-automation-card";
import { CloneVoiceStackCard } from "@/components/clone-voice-stack-card";
import { CloneAnthropicCard } from "@/components/clone-anthropic-card";
import { CloneBrandMarksCard } from "@/components/clone-brand-marks-card";
import { CloneBackendDeployCard } from "@/components/clone-backend-deploy-card";
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
import { useLaunchCascade } from "@/lib/use-launch-cascade";
import { spawnCascade } from "@/server/cascade-spawn.functions";
import { bulkSyncModuleFn } from "@/server/module-sync.functions";
import type { DriftSuggestion } from "@/server/drift-suggestions.functions";
import type { Database } from "@/integrations/supabase/types";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

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
  const [cascading, setCascading] = useState(false);
  const spawnCascadeFn = useServerFn(spawnCascade);
  const launch = useLaunchCascade();

  /*
    "Cascade now" used to navigate to /cascades and deliver nothing. It now
    re-delivers THIS clone through the same one-clone spawn the cascade detail
    page's "Retry as" uses: a fresh manual event carrying only this clone,
    which reads its source's head when the pass runs. The server refuses while
    a delivery to this clone is already in flight, and the toast links to
    whichever cascade the answer names.
  */
  const cascadeNow = async (mode: CascadeMode) => {
    setCascading(true);
    try {
      await launch(() => spawnCascadeFn({ data: { intent: "redeliver", mode, cloneId } }));
    } finally {
      setCascading(false);
    }
  };

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
    // Installing records a row and pushes nothing. A module-scoped clone takes
    // the module's files on its next cascade; a mirror is delivered its whole
    // tree whatever it installed, so the row changes no file there.
    toast.success(
      clone?.sync_scope === "mirror"
        ? "Module recorded. This clone is a mirror, so it already receives every file."
        : "Module installed. Its files arrive with the next cascade.",
    );
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
      toast.success(
        clone?.sync_scope === "mirror"
          ? "Cascade started. A mirror is delivered its whole tree, not one module's files."
          : `Cascade started for ${module?.name ?? "the module"}'s files`,
      );
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
        <div className="flex flex-wrap gap-2">
          {/*
            A message to this one workspace is written on the Workspace
            messages page with this workspace already chosen. It is one-way and
            reaches staff only — Mission Control is never a contact in the
            workspace's own Messaging Hub.
          */}
          <Button
            variant="outline"
            onClick={() => navigate({ to: "/announcements", search: { to: cloneId } })}
          >
            <Megaphone className="mr-1.5 h-4 w-4" /> Message this workspace
          </Button>
          {/*
            The secrets sub-page had no link anywhere in the product — grep for
            its route found only its own definition — so the raw secret list
            and `Derive ALLOWED_ORIGINS` were reachable only by typing a URL.
          */}
          <Button
            variant="outline"
            onClick={() => navigate({ to: "/clones/$cloneId/secrets", params: { cloneId } })}
          >
            <KeyRound className="mr-1.5 h-4 w-4" /> Secrets
          </Button>
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-4 w-4" /> Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" disabled={cascading}>
                {cascading ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Waves className="mr-1.5 h-4 w-4" />
                )}
                {cascading ? "Cascading…" : "Cascade now"}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Deliver to this clone as
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void cascadeNow("pr")}>
                <GitMerge className="mr-2 h-3.5 w-3.5" /> Open PR
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void cascadeNow("auto_merge")}>
                <Send className="mr-2 h-3.5 w-3.5" /> Auto-merge
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void cascadeNow("notify")}>
                <Bell className="mr-2 h-3.5 w-3.5" /> Notify only
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      <CloneCrmConversionCard
        cloneId={cloneId}
        crmMode={(clone as { crm_mode?: string | null }).crm_mode}
      />
      <CloneVoiceAutomationCard
        cloneId={cloneId}
        crmMode={(clone as { crm_mode?: string | null }).crm_mode}
      />
      {/*
        Beside the calendar-and-email card, because that card configures the
        agents this one builds: the stack is the Vapi org, the Make scenarios
        and the tools; the automation card is which calendar they book into.
      */}
      <CloneVoiceStackCard cloneId={cloneId} />
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
      {/*
        Above the gate, because it is the thing the gate's own pay button and
        every top-up link resolve through: an unset identity is what makes a
        clone's checkout credit the prime.
      */}
      <CloneBillingIdentityCard cloneId={cloneId} />
      <ClonePaymentGateCard cloneId={cloneId} cloneName={clone.name} />
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
      {/*
        The clone's own sending identity, beside the widget for the same
        reason. Both are per-clone credentials Mission Control mints, and this
        one lived ONLY on the secrets sub-page — a route nothing in the product
        linked to, reachable only by typing the URL. A panel an operator cannot
        navigate to is a panel that does not exist, which is how the one clone
        in the fleet sat with `RESEND_API_KEY` missing and no visible way to
        fix it.
      */}
      <CloneBrandMarksCard cloneId={cloneId} />
      <CloneEmailIdentityCard cloneId={cloneId} />
      {/*
        And the fourth: whose Anthropic line this clone's model spend lands
        on. It sits beside the other per-clone identities because it is one —
        Anthropic will not create an API key through its API, so the unit of
        attribution is a workspace rather than a credential, and federation
        then takes the organisation key off the project entirely.

        The card leads with what has been PROVED rather than what is
        configured, because every reading on this page can be green while a
        clone cannot obtain a credential at all.
      */}
      <CloneAnthropicCard cloneId={cloneId} />
      {/*
        Beside the other two per-clone credentials, because it is the third:
        an operator login for the clone itself. It exists because two people
        needed one and neither could get it — the team auditing a clone before
        it ships, and the client it is handed to — while the only place a
        clone's admin password is ever written down is cleared on every
        terminal outcome, deliberately. So this ISSUES rather than reveals, and
        says so.
      */}
      <CloneAccessCredentialsCard cloneId={cloneId} />
      <ClonePurchasesCard cloneId={cloneId} />
      <GitHubSecretSyncCard target="clone" cloneId={cloneId} />
      <CloneSecurityAssessmentsCard cloneId={cloneId} />
      <CloneCodexScansCard cloneId={cloneId} />
      <ModuleInjector
        isMirror={clone.sync_scope === "mirror"}
        installed={installed}
        available={available}
        resyncingId={resyncingId}
        inject={inject}
        remove={remove}
        resync={resync}
      />
      <CloneBackendDeployCard cloneId={cloneId} />
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
  isMirror,
  installed,
  available,
  resyncingId,
  inject,
  remove,
  resync,
}: {
  isMirror: boolean;
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
                            : isMirror
                              ? "Cascade this clone (a mirror is delivered its whole tree)"
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
