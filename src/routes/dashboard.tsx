import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { BulkTagDialog } from "@/components/bulk-tag-dialog";
import { EmptyState } from "@/components/empty-state";
import { CloneGridSkeleton } from "@/components/list-skeletons";
import { MetricBar, type Metric } from "@/components/metric-bar";
import { PageHeader } from "@/components/page-header";
import { ProtectedRoute } from "@/components/protected-route";
import { StatusPill, syncSpine } from "@/components/status-pill";
import { exportRowsAsCSV } from "@/lib/csv";
import { formatDistanceToNow } from "@/lib/format";
import { useClones, useFleetModules, usePrimeConfig } from "@/lib/queries";
import {
  bulkDeleteClones,
  bulkPauseClones,
  bulkReprovisionBackends,
} from "@/server/operator-ux.functions";
import {
  createBulkSecurityAssessments,
  listSecurityDashboardSummaries,
  listSecurityPartnersForAssignment,
} from "@/server/security-partner-dashboard.functions";
import {
  ArrowDownUp,
  Download,
  ExternalLink,
  GitBranch,
  Github,
  Package,
  PauseCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  Waves,
  X,
} from "lucide-react";
import { toast } from "sonner";

const dashboardSearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  filter: fallback(z.enum(["all", "in_sync", "behind", "failed", "ai"]), "all").default("all"),
  sort: fallback(
    z.enum(["name", "commits_behind", "last_cascade_at", "ai_suggestions"]),
    "name",
  ).default("name"),
  module: fallback(z.string(), "").default(""),
});

type SecuritySummary = {
  id: string;
  clone_id: string;
  status: string;
  cycle: string;
  aurixa_review_status: string;
  partner?: { name: string; slug: string } | null;
  open_findings: number;
  critical_findings: number;
  report_count: number;
  pending_retests: number;
};

export const Route = createFileRoute("/dashboard")({
  validateSearch: zodValidator(dashboardSearchSchema),
  component: () => (
    <ProtectedRoute>
      <Dashboard />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Fleet — Aurixa Systems Mission Control" }] }),
});

function Dashboard() {
  const { data: clones, loading, refresh: refreshClones } = useClones();
  const { data: prime } = usePrimeConfig();
  const { byClone: modulesByClone } = useFleetModules();
  const { q, filter, sort, module: moduleFilter } = Route.useSearch();
  const navigate = useNavigate({ from: "/dashboard" });
  const listSecurity = useServerFn(listSecurityDashboardSummaries);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [securityRows, setSecurityRows] = useState<SecuritySummary[]>([]);

  type DashboardSearch = z.infer<typeof dashboardSearchSchema>;
  const setQ = (value: string) =>
    navigate({ search: (prev: DashboardSearch) => ({ ...prev, q: value }), replace: true });
  const setFilter = (value: typeof filter) =>
    navigate({ search: (prev: DashboardSearch) => ({ ...prev, filter: value }), replace: true });
  const setSort = (value: typeof sort) =>
    navigate({ search: (prev: DashboardSearch) => ({ ...prev, sort: value }), replace: true });
  const setModuleFilter = (value: string) =>
    navigate({ search: (prev: DashboardSearch) => ({ ...prev, module: value }), replace: true });

  const openSuggestionsCount = (clone: (typeof clones)[number]) => {
    const suggestions =
      (clone.drift_suggestions as unknown as Array<{ status?: string }> | null) ?? [];
    return suggestions.filter((suggestion) => (suggestion?.status ?? "open") === "open").length;
  };

  useEffect(() => {
    if (loading) return;
    if (clones.length === 0) {
      setSecurityRows((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    void listSecurity({ data: { cloneIds: clones.map((clone) => clone.id) } })
      .then((result) => {
        if (!cancelled) setSecurityRows((result.summaries ?? []) as SecuritySummary[]);
      })
      .catch(() => {
        if (!cancelled) setSecurityRows((prev) => (prev.length === 0 ? prev : []));
      });
    return () => {
      cancelled = true;
    };
  }, [clones, loading, listSecurity]);

  const securityByClone = useMemo(() => {
    const map = new Map<string, SecuritySummary[]>();
    for (const row of securityRows)
      (map.get(row.clone_id) ?? map.set(row.clone_id, []).get(row.clone_id)!).push(row);
    return map;
  }, [securityRows]);

  const moduleFilterName = useMemo(() => {
    if (!moduleFilter) return null;
    for (const list of Object.values(modulesByClone)) {
      const hit = list.find((module) => module.module_id === moduleFilter);
      if (hit) return hit.module_name;
    }
    return null;
  }, [moduleFilter, modulesByClone]);

  const filtered = useMemo(() => {
    const list = clones.filter((clone) => {
      const matchQ =
        !q ||
        clone.name.toLowerCase().includes(q.toLowerCase()) ||
        clone.tags?.some((tag) => tag.toLowerCase().includes(q.toLowerCase()));
      const matchF =
        filter === "all" ||
        (filter === "ai" ? openSuggestionsCount(clone) > 0 : clone.sync_status === filter);
      const matchM =
        !moduleFilter ||
        (modulesByClone[clone.id]?.some((module) => module.module_id === moduleFilter) ?? false);
      return matchQ && matchF && matchM;
    });
    return [...list].sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "commits_behind":
          return (b.commits_behind ?? 0) - (a.commits_behind ?? 0);
        case "last_cascade_at":
          return (
            new Date(b.last_cascade_at ?? 0).getTime() - new Date(a.last_cascade_at ?? 0).getTime()
          );
        case "ai_suggestions":
          return openSuggestionsCount(b) - openSuggestionsCount(a);
        default:
          return 0;
      }
    });
  }, [clones, q, filter, sort, moduleFilter, modulesByClone]);

  const stats = useMemo(() => {
    const activeSecurity = securityRows.filter(
      (row) => !["closed", "canceled"].includes(row.status),
    );
    return {
      total: clones.length,
      in_sync: clones.filter((clone) => clone.sync_status === "in_sync").length,
      behind: clones.filter((clone) => clone.sync_status === "behind").length,
      failed: clones.filter((clone) => clone.sync_status === "failed").length,
      ai_open: clones.reduce((acc, clone) => acc + openSuggestionsCount(clone), 0),
      ai_clones: clones.filter((clone) => openSuggestionsCount(clone) > 0).length,
      security_active: activeSecurity.length,
      security_critical: securityRows.reduce((sum, row) => sum + row.critical_findings, 0),
    };
  }, [clones, securityRows]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const metrics = useMemo<Metric[]>(
    () => [
      { label: "clones", value: stats.total },
      { label: "in sync", value: stats.in_sync },
      { label: "behind", value: stats.behind, tone: "warning", alarm: stats.behind > 0 },
      { label: "failed", value: stats.failed, tone: "destructive", alarm: stats.failed > 0 },
      {
        label: "ai open",
        value: stats.ai_open,
        tone: "primary",
        alarm: stats.ai_open > 0,
        note: stats.ai_clones ? `across ${stats.ai_clones}` : undefined,
      },
      {
        label: "security",
        value: stats.security_active,
        tone: "destructive",
        alarm: stats.security_critical > 0,
        to: "/security",
        note: stats.security_critical ? `${stats.security_critical} critical` : undefined,
      },
    ],
    [stats],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="fleet overview"
        title="Mission Control"
        description={
          prime ? (
            <>
              Prime{" "}
              <span className="font-mono text-foreground">
                {prime.github_owner}/{prime.github_repo}
              </span>{" "}
              on <span className="font-mono">{prime.default_branch}</span>
            </>
          ) : (
            <>
              No prime repo configured.{" "}
              <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
                Set it up
              </Link>
            </>
          )
        }
        actions={
          <>
            {/* Security partners used to sit here as a fourth button. It is in
                the sidebar and behind the security metric; four equal-weight
                buttons is how a header stops having a primary action. */}
            <Button
              variant="outline"
              onClick={() => exportRowsAsCSV("mission-control-clones", filtered)}
            >
              <Download className="mr-2 h-4 w-4" /> Export
            </Button>
            <Link to="/cascades">
              <Button variant="outline">
                <Waves className="mr-2 h-4 w-4" /> New cascade
              </Button>
            </Link>
            <Link to="/clones/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New clone
              </Button>
            </Link>
          </>
        }
      />

      <MetricBar metrics={metrics} />

      <section className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="search by name or tag…"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            className="pl-9 font-mono text-sm"
          />
        </div>
        <div className="flex flex-wrap border border-border">
          {(["all", "in_sync", "behind", "failed", "ai"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`border-l border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors first:border-l-0 ${
                filter === key
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {key === "ai"
                ? `ai${stats.ai_clones ? ` (${stats.ai_clones})` : ""}`
                : key.replace("_", " ")}
            </button>
          ))}
        </div>
        <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}>
          <SelectTrigger className="w-[200px] font-mono text-xs">
            <ArrowDownUp className="h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue placeholder="Sort by…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name" className="font-mono text-xs">
              name (a→z)
            </SelectItem>
            <SelectItem value="commits_behind" className="font-mono text-xs">
              commits behind
            </SelectItem>
            <SelectItem value="last_cascade_at" className="font-mono text-xs">
              last cascade
            </SelectItem>
            <SelectItem value="ai_suggestions" className="font-mono text-xs">
              ai suggestions
            </SelectItem>
          </SelectContent>
        </Select>
        {moduleFilter && (
          <button
            onClick={() => setModuleFilter("")}
            className="inline-flex items-center gap-1.5 border border-primary/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-primary hover:bg-primary/10"
            title="Clear module filter"
          >
            <Package className="h-3 w-3" /> {moduleFilterName ?? moduleFilter.slice(0, 6)}
            <X className="h-3 w-3" />
          </button>
        )}
      </section>

      <BulkActionBar count={selected.size} noun="clone" onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="outline" onClick={() => setBulkTagOpen(true)}>
          <Tag className="mr-1.5 h-3.5 w-3.5" /> Tags
        </Button>
        <BulkSecurityAssessmentButton
          ids={Array.from(selected)}
          onDone={() => {
            setSelected(new Set());
            void refreshClones();
          }}
        />
        <BulkPauseButton
          ids={Array.from(selected)}
          onDone={() => {
            setSelected(new Set());
            void refreshClones();
          }}
        />
        <BulkReprovisionButton
          ids={Array.from(selected)}
          onDone={() => {
            setSelected(new Set());
            void refreshClones();
          }}
        />
        <BulkDeleteButton
          ids={Array.from(selected)}
          onDone={() => {
            setSelected(new Set());
            void refreshClones();
          }}
        />
      </BulkActionBar>

      {loading ? (
        <CloneGridSkeleton count={4} />
      ) : filtered.length === 0 ? (
        clones.length === 0 ? (
          <DashboardEmpty />
        ) : (
          <EmptyState
            icon={<Search />}
            title="No clones match"
            description="Try clearing the search or switching the filter to see more clones."
          />
        )
      ) : (
        <section className="grid gap-3 lg:grid-cols-2">
          {filtered.map((clone) => (
            <CloneRow
              key={clone.id}
              clone={clone}
              modules={modulesByClone[clone.id] ?? []}
              security={(securityByClone.get(clone.id) ?? []).find(
                (row) => !["closed", "canceled"].includes(row.status),
              )}
              suggestions={openSuggestionsCount(clone)}
              selected={selected.has(clone.id)}
              onToggle={() => toggle(clone.id)}
              moduleFilter={moduleFilter}
              onModuleFilter={setModuleFilter}
            />
          ))}
        </section>
      )}

      <BulkTagDialog
        open={bulkTagOpen}
        onOpenChange={setBulkTagOpen}
        clones={clones}
        selectedIds={selected}
        onDone={() => {
          setSelected(new Set());
          void refreshClones();
        }}
      />
    </div>
  );
}

/**
 * A clone, reduced to what an operator actually scans for.
 *
 * The card this replaces carried twelve competing objects: a checkbox, the
 * name, a method badge, a Cloudflare badge, a security badge, free tags, a
 * status pill, an AI-count pill, the repo path, one bordered chip per module,
 * three link chips and a timestamp — every one of them a bordered, tinted
 * rectangle. Down a two-column grid of twelve clones that is well over a
 * hundred rectangles, and finding the failing one meant reading all of them.
 *
 * State is now the SPINE plus one word. Everything secondary is text separated
 * by middots rather than another chip, and the destinations appear on hover
 * because an operator opens one perhaps once a session. Nothing was dropped:
 * the method, the wrapper, the security cycle, the modules and the tags are
 * all still here — they have simply stopped pretending to be buttons.
 *
 * The modules stay pressable (they filter the fleet) but are underlined on
 * hover rather than boxed, which is the honest affordance for a text control.
 */
function CloneRow({
  clone,
  modules,
  security,
  suggestions,
  selected,
  onToggle,
  moduleFilter,
  onModuleFilter,
}: {
  clone: ReturnType<typeof useClones>["data"][number];
  modules: Array<{ module_id: string; module_name: string }>;
  security?: SecuritySummary;
  suggestions: number;
  selected: boolean;
  onToggle: () => void;
  moduleFilter: string;
  onModuleFilter: (id: string) => void;
}) {
  const meta = [
    clone.provisioning_method,
    ...(clone.cloudflare_enabled ? ["cloudflare"] : []),
    ...(security ? [`pentest ${security.status.replaceAll("_", " ")}`] : []),
  ];

  return (
    <div
      className={`glass spine ${syncSpine(clone.sync_status)} group p-5 transition-colors hover:bg-foreground/[0.03] ${selected ? "bg-foreground/[0.05]" : ""}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            className="mt-1"
            aria-label={`Select ${clone.name}`}
          />
          <div className="min-w-0">
            <Link
              to="/clones/$cloneId"
              params={{ cloneId: clone.id }}
              className="font-display block truncate text-[1.0625rem] leading-tight hover:text-primary"
            >
              {clone.name}
            </Link>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {clone.github_owner}/{clone.github_repo}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusPill status={clone.sync_status} behind={clone.commits_behind} />
          {suggestions > 0 && (
            <Link
              to="/clones/$cloneId"
              params={{ cloneId: clone.id }}
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary hover:underline"
            >
              {suggestions} ai open
            </Link>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {meta.map((entry, index) => (
          <span key={entry}>
            {index > 0 && (
              <span aria-hidden className="mr-2 text-border-strong">
                ·
              </span>
            )}
            {entry}
          </span>
        ))}
        {modules.length > 0 && (
          <span aria-hidden className="text-border-strong">
            ·
          </span>
        )}
        {modules.map((module) => {
          const active = moduleFilter === module.module_id;
          return (
            <button
              key={module.module_id}
              onClick={() => onModuleFilter(active ? "" : module.module_id)}
              title={active ? "Clear filter" : `Filter fleet by ${module.module_name}`}
              className={`underline-offset-4 hover:underline ${active ? "text-primary underline" : "hover:text-foreground"}`}
            >
              {module.module_name}
            </button>
          );
        })}
        {clone.tags?.map((tag) => (
          <span key={tag} className="tracking-normal normal-case text-muted-foreground/70">
            #{tag}
          </span>
        ))}
        <span className="ml-auto tracking-normal normal-case">
          cascaded {formatDistanceToNow(clone.last_cascade_at)}
        </span>
      </div>

      {/* Destinations on hover (and on keyboard focus). Three permanent link
          chips per record is thirty-six objects on a twelve-clone fleet. */}
      <div className="mt-3 hidden gap-4 font-mono text-[10px] uppercase tracking-[0.14em] group-hover:flex focus-within:flex">
        {clone.github_url && (
          <a
            href={clone.github_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-primary"
          >
            <Github className="h-3 w-3" /> repo
          </a>
        )}
        {clone.lovable_project_url && (
          <a
            href={clone.lovable_project_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-primary"
          >
            <ExternalLink className="h-3 w-3" /> lovable
          </a>
        )}
        {clone.deploy_url && (
          <a
            href={clone.deploy_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-primary"
          >
            <ExternalLink className="h-3 w-3" /> deploy
          </a>
        )}
      </div>
    </div>
  );
}

function DashboardEmpty() {
  return (
    <EmptyState
      icon={<GitBranch />}
      title="No clones in the fleet"
      description="Provision your first clone from the prime codebase. It can be a fork, a template instance, or an independent clone."
      action={
        <Link to="/clones/new">
          <Button>
            <Plus className="mr-2 h-4 w-4" /> Provision first clone
          </Button>
        </Link>
      }
    />
  );
}

function BulkSecurityAssessmentButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const listPartners = useServerFn(listSecurityPartnersForAssignment);
  const createBulk = useServerFn(createBulkSecurityAssessments);
  const [partners, setPartners] = useState<Array<{ id: string; name: string }>>([]);
  const [partnerId, setPartnerId] = useState("");
  const [cycle, setCycle] = useState<"quarterly" | "bi_annual" | "annual" | "one_off">("quarterly");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listPartners().then((result) => {
      const rows = (result.partners ?? []) as Array<{ id: string; name: string }>;
      setPartners(rows);
      setPartnerId((current) => current || rows[0]?.id || "");
    });
  }, [listPartners]);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> Activate pentest
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Activate security partner testing?</AlertDialogTitle>
          <AlertDialogDescription>
            Creates separated penetration-testing records for {ids.length} selected clone
            {ids.length === 1 ? "" : "s"}. Partner visibility remains limited to these cycles.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3 py-2">
          <div className="space-y-1">
            <Label>Security partner</Label>
            <Select value={partnerId} onValueChange={setPartnerId}>
              <SelectTrigger>
                <SelectValue placeholder="Select partner" />
              </SelectTrigger>
              <SelectContent>
                {partners.map((partner) => (
                  <SelectItem key={partner.id} value={partner.id}>
                    {partner.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Testing cycle</Label>
            <Select value={cycle} onValueChange={(value) => setCycle(value as typeof cycle)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="bi_annual">Bi-annual</SelectItem>
                <SelectItem value="annual">Annual</SelectItem>
                <SelectItem value="one_off">One-off</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async (event) => {
              event.preventDefault();
              if (!partnerId) return toast.error("Choose a partner first");
              setBusy(true);
              try {
                const result = await createBulk({
                  data: { partnerId, cloneIds: ids, cycle, retestRequired: true },
                });
                toast.success(`Created ${(result.created as unknown[]).length} security cycle(s)`);
                if ((result.skipped as unknown[]).length)
                  toast.info(
                    `${(result.skipped as unknown[]).length} clone(s) already had active cycles`,
                  );
                onDone();
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not activate testing");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            Activate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BulkPauseButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const fn = useServerFn(bulkPauseClones);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await fn({ data: { cloneIds: ids, pause: true } });
        setBusy(false);
        if (result.ok) {
          toast.success(`Paused ${result.count} clone${result.count === 1 ? "" : "s"}`);
          onDone();
        } else toast.error("Pause failed");
      }}
    >
      <PauseCircle className="mr-1.5 h-3.5 w-3.5" /> Pause
    </Button>
  );
}

function BulkReprovisionButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const fn = useServerFn(bulkReprovisionBackends);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await fn({ data: { cloneIds: ids } });
        setBusy(false);
        if (!result.ok) {
          toast.error(result.error ?? "Reprovision failed");
          return;
        }
        // What was SELECTED is not what was queued. This used to report the
        // tick count whatever the server did with it — and the server did
        // nothing, on every row (see bulkReprovisionBackends). A skipped
        // backend is named, because "Re-queued 4" over 4 refusals is how an
        // operator comes to wait on work nobody started.
        const skipped = result.skipped ?? [];
        if (result.count > 0) {
          toast.success(`Re-queued ${result.count} backend${result.count === 1 ? "" : "s"}`, {
            description:
              skipped.length > 0
                ? `${skipped.length} skipped — ${skipped[0].reason}${skipped.length > 1 ? ", …" : ""}`
                : undefined,
          });
        } else {
          toast.error(
            skipped.length > 0
              ? `Nothing re-queued — ${skipped[0].reason}${skipped.length > 1 ? ` (and ${skipped.length - 1} more)` : ""}`
              : "Nothing re-queued",
          );
        }
        onDone();
      }}
    >
      <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reprovision
    </Button>
  );
}

function BulkDeleteButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const fn = useServerFn(bulkDeleteClones);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive" disabled={busy}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {ids.length} clone{ids.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the clone records and related Mission Control metadata. The
            underlying GitHub repos and backends are NOT affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              setBusy(true);
              const result = await fn({ data: { cloneIds: ids } });
              setBusy(false);
              if (result.ok) {
                const okCount = result.results.filter((row) => row.ok).length;
                toast.success(`Deleted ${okCount}/${ids.length}`);
                onDone();
              } else toast.error("Delete failed");
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
