import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useClones } from "@/lib/queries";
import {
  listBrandProfiles,
  listBrandAssignments,
  listBrandHistory,
  upsertBrandProfile,
  setBrandProfileStatus,
  assignBrandProfile,
  applyBrandProfile,
  checkBrandDrift,
  deleteBrandProfile,
  duplicateBrandProfile,
} from "@/server/branding.functions";
import {
  createSchedule,
  deleteSchedule,
  runScheduleNow,
  updateSchedule,
} from "@/server/schedules.functions";
import { BrandProfileIO } from "@/components/brand-profile-io";
import { describeCron } from "@/lib/cron";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Palette,
  Plus,
  Save,
  Upload,
  Rocket,
  History as HistoryIcon,
  Trash2,
  Star,
  Image as ImageIcon,
  RefreshCw,
  Link2,
  Clock,
  PlayCircle,
  Sparkles,
  Layers,
} from "lucide-react";
import { formatDistanceToNow } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BrandVersionTimelineDialog } from "@/components/branding/brand-version-timeline";
import { CloneOverrideEditorDialog } from "@/components/branding/clone-override-editor";
import { BrandPlaygroundDialog } from "@/components/branding/brand-playground";
import { MetricCell } from "@/components/metric-bar";
import { BRAND_MARK_SLOTS } from "@/lib/brand/marks";

export const Route = createFileRoute("/branding")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <BrandingPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Branding — Aurixa Systems Mission Control" }] }),
});

// ─── Types ────────────────────────────────────────────────────────────

type BrandProfile = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: "draft" | "published" | "archived";
  is_default: boolean;
  version: number;
  brand_config: Record<string, unknown>;
  report_contact: Record<string, unknown>;
  asset_manifest: Array<Record<string, unknown>>;
  config_hash: string | null;
  tags: string[];
  updated_at: string;
};

type Assignment = {
  id: string;
  clone_id: string;
  profile_id: string;
  status: "pending" | "applied" | "drifted" | "failed";
  applied_at: string | null;
  applied_config_hash: string | null;
  drift_summary: string | null;
  error_message: string | null;
  clones: { id: string; name: string; slug: string } | null;
  clone_brand_profiles: { id: string; name: string; slug: string; version: number } | null;
};

type HistoryRow = {
  id: string;
  clone_id: string;
  profile_id: string | null;
  profile_version: number | null;
  status: "pending" | "applied" | "drifted" | "failed";
  config_hash: string | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
};

type AssetEntry = {
  source_path: string;
  target_path: string;
  content_type: string;
  config_field: string | null;
  public_url?: string;
};

type BrandSchedule = {
  id: string;
  name: string;
  cron_expression: string;
  enabled: boolean;
  scope_filter: { profile_id?: string; clone_ids?: string[] | "drifted" | "all" };
  last_run_at: string | null;
  next_run_at: string | null;
  notes: string | null;
};

// Drawn from the one list of marks rather than written out again here. It was
// written out here, it offered three of the six the workspace reads, and the
// three it missed are the ones a generated document needs — so a brand could be
// complete on screen and every PDF came out unmarked. See `branding/marks.ts`.
const ASSET_FIELDS = BRAND_MARK_SLOTS.map((slot) => ({
  field: slot.field,
  label: slot.label,
  purpose: slot.purpose,
  target: slot.target,
}));

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  archived: "bg-muted text-muted-foreground line-through",
  applied: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  drifted: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
};

// ─── Page ─────────────────────────────────────────────────────────────

function BrandingPage() {
  const confirm = useConfirm();
  const listProfilesFn = useServerFn(listBrandProfiles);
  const listAssignmentsFn = useServerFn(listBrandAssignments);
  const listHistoryFn = useServerFn(listBrandHistory);
  const upsertFn = useServerFn(upsertBrandProfile);
  const setStatusFn = useServerFn(setBrandProfileStatus);
  const assignFn = useServerFn(assignBrandProfile);
  const applyFn = useServerFn(applyBrandProfile);
  const driftFn = useServerFn(checkBrandDrift);
  const deleteFn = useServerFn(deleteBrandProfile);
  const duplicateFn = useServerFn(duplicateBrandProfile);
  const createScheduleFn = useServerFn(createSchedule);
  const updateScheduleFn = useServerFn(updateSchedule);
  const deleteScheduleFn = useServerFn(deleteSchedule);
  const runScheduleFn = useServerFn(runScheduleNow);

  const { data: clones } = useClones();
  const [profiles, setProfiles] = useState<BrandProfile[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<BrandProfile | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkProfileId, setBulkProfileId] = useState<string>("");
  const [bulkCloneIds, setBulkCloneIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [schedules, setSchedules] = useState<BrandSchedule[]>([]);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [newSchedName, setNewSchedName] = useState("");
  const [newSchedCron, setNewSchedCron] = useState("0 */6 * * *");
  const [newSchedProfile, setNewSchedProfile] = useState("");
  const [newSchedTarget, setNewSchedTarget] = useState<"drifted" | "all">("drifted");

  // Phase 6 dialogs
  const [versionsDialog, setVersionsDialog] = useState<BrandProfile | null>(null);
  const [overridesDialog, setOverridesDialog] = useState<{
    cloneId: string;
    cloneName: string;
  } | null>(null);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const [playgroundProfileId, setPlaygroundProfileId] = useState<string | null>(null);

  const refreshSchedules = async () => {
    const { data } = await supabase
      .from("cascade_schedules" as never)
      .select("id, name, cron_expression, enabled, scope_filter, last_run_at, next_run_at, notes")
      .eq("kind", "brand_sync")
      .order("created_at", { ascending: false });
    setSchedules((data as unknown as BrandSchedule[]) ?? []);
  };

  const refresh = async () => {
    setLoading(true);
    const [p, a, h] = await Promise.all([
      listProfilesFn({}),
      listAssignmentsFn({}),
      listHistoryFn({ data: { limit: 50 } }),
    ]);
    if (p.ok) setProfiles(p.profiles as unknown as BrandProfile[]);
    if (a.ok) setAssignments(a.assignments as unknown as Assignment[]);
    if (h.ok) setHistory(h.history as unknown as HistoryRow[]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    refreshSchedules();
  }, []);

  const handleCreateSchedule = async () => {
    if (!newSchedName.trim() || !newSchedProfile) {
      toast.error("Name and profile required");
      return;
    }
    const r = await createScheduleFn({
      data: {
        name: newSchedName.trim(),
        kind: "brand_sync",
        cron_expression: newSchedCron,
        mode: "auto_merge",
        scope_filter: { profile_id: newSchedProfile, clone_ids: newSchedTarget },
        enabled: true,
      },
    });
    if (r.ok) {
      toast.success("Brand sync schedule created");
      setScheduleDialogOpen(false);
      setNewSchedName("");
      refreshSchedules();
    } else {
      toast.error(r.error ?? "Create failed");
    }
  };

  const handleRunSchedule = async (id: string) => {
    setBusy(true);
    const r = await runScheduleFn({ data: { id } });
    setBusy(false);
    if (r.ok) {
      toast.success(`Ran "${r.name}"`);
      refresh();
      refreshSchedules();
    } else {
      toast.error(r.error ?? "Run failed");
    }
  };

  const handleToggleSchedule = async (s: BrandSchedule) => {
    const r = await updateScheduleFn({
      data: { id: s.id, patch: { enabled: !s.enabled } },
    });
    if (r.ok) refreshSchedules();
    else toast.error(r.error ?? "Toggle failed");
  };

  const handleDeleteSchedule = async (s: BrandSchedule) => {
    const ok = await confirm({
      title: `Delete schedule "${s.name}"?`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const r = await deleteScheduleFn({ data: { id: s.id } });
    if (r.ok) {
      toast.success("Schedule deleted");
      refreshSchedules();
    } else {
      toast.error(r.error ?? "Delete failed");
    }
  };

  const profilesById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const driftedClones = assignments.filter((a) => a.status === "drifted");
  const pendingClones = assignments.filter((a) => a.status === "pending");
  const failedClones = assignments.filter((a) => a.status === "failed");

  const handleScanDrift = async () => {
    setBusy(true);
    const r = await driftFn({ data: {} });
    setBusy(false);
    if (r.ok) {
      toast.success(`Scanned ${r.scanned}, found ${r.drifted.length} drifted`);
      refresh();
    } else {
      toast.error(r.error ?? "Drift scan failed");
    }
  };

  const handlePublishToggle = async (p: BrandProfile) => {
    const next = p.status === "published" ? "archived" : "published";
    const r = await setStatusFn({ data: { profileId: p.id, status: next } });
    if (r.ok) {
      toast.success(`Profile ${next}`);
      refresh();
    } else {
      toast.error(r.error ?? "Status change failed");
    }
  };

  const handleDelete = async (p: BrandProfile) => {
    const ok = await confirm({
      title: `Delete brand profile "${p.name}"?`,
      description: "Assignments to this profile will be lost.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const r = await deleteFn({ data: { profileId: p.id } });
    if (r.ok) {
      toast.success("Profile deleted");
      refresh();
    } else {
      toast.error(r.error ?? "Delete failed");
    }
  };

  const openBulk = (profileId?: string) => {
    setBulkProfileId(profileId ?? profiles.find((p) => p.is_default)?.id ?? profiles[0]?.id ?? "");
    setBulkCloneIds(new Set());
    setBulkOpen(true);
  };

  const handleBulkAssign = async () => {
    if (!bulkProfileId || bulkCloneIds.size === 0) return;
    setBusy(true);
    const r = await assignFn({
      data: { profileId: bulkProfileId, cloneIds: Array.from(bulkCloneIds) },
    });
    setBusy(false);
    if (r.ok) {
      toast.success(`Assigned profile to ${r.count} clone(s)`);
      refresh();
    } else {
      toast.error(r.error ?? "Assign failed");
    }
  };

  const handleBulkApply = async () => {
    if (!bulkProfileId || bulkCloneIds.size === 0) return;
    setBusy(true);
    const r = await applyFn({
      data: { profileId: bulkProfileId, cloneIds: Array.from(bulkCloneIds) },
    });
    setBusy(false);
    if (!r.ok) {
      if ((r as { requiresApproval?: boolean }).requiresApproval) {
        toast.warning(r.error ?? "Approval required");
      } else {
        toast.error(r.error ?? "Apply failed");
      }
      return;
    }
    toast.success(`Applied · ${r.succeeded} succeeded · ${r.failed} failed`);
    setBulkOpen(false);
    refresh();
  };

  const handleApplyOne = async (cloneId: string, profileId: string) => {
    setBusy(true);
    const r = await applyFn({ data: { profileId, cloneIds: [cloneId] } });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? "Apply failed");
      return;
    }
    const first = r.results[0];
    if (first?.ok) toast.success(`Brand applied to clone`);
    else toast.error(first?.error ?? "Apply failed");
    refresh();
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-mono">white-label cascade</p>
          <h1 className="mt-1 flex items-center gap-2 font-display text-[2.125rem] leading-[1.05]">
            <Palette className="h-7 w-7 text-primary" />
            Branding
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage brand profiles, mirror assets, and cascade white-label settings across the clone
            fleet.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={handleScanDrift} disabled={busy}>
            <RefreshCw className={cn("mr-2 h-4 w-4", busy && "animate-spin")} />
            Scan drift
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPlaygroundProfileId(null);
              setPlaygroundOpen(true);
            }}
          >
            <Sparkles className="mr-2 h-4 w-4" /> Playground
          </Button>
          <Button variant="outline" size="sm" onClick={() => openBulk()}>
            <Rocket className="mr-2 h-4 w-4" /> Bulk apply
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> New profile
          </Button>
        </div>
      </header>

      {/* Health strip */}
      <div className="glass grid grid-cols-2 overflow-hidden md:grid-cols-4">
        <StatCard label="Profiles" value={profiles.length} />
        <StatCard label="Pending" value={pendingClones.length} tone="warning" />
        <StatCard
          label="Drifted"
          value={driftedClones.length}
          tone={driftedClones.length > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Failed"
          value={failedClones.length}
          tone={failedClones.length > 0 ? "danger" : "default"}
        />
      </div>

      <Tabs defaultValue="profiles">
        <TabsList>
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
          <TabsTrigger value="assignments">Assignments ({assignments.length})</TabsTrigger>
          <TabsTrigger value="history">
            <HistoryIcon className="mr-1 h-3.5 w-3.5" /> History
          </TabsTrigger>
          <TabsTrigger value="schedules">
            <Clock className="mr-1 h-3.5 w-3.5" /> Schedules ({schedules.length})
          </TabsTrigger>
        </TabsList>

        {/* Profiles */}
        <TabsContent value="profiles" className="mt-4 space-y-3">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!loading && profiles.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No brand profiles yet. Create one to start cascading white-label settings.
              </CardContent>
            </Card>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                assignmentCount={assignments.filter((a) => a.profile_id === p.id).length}
                onEdit={() => {
                  setEditing(p);
                  setEditorOpen(true);
                }}
                onPublishToggle={() => handlePublishToggle(p)}
                onDelete={() => handleDelete(p)}
                onApply={() => openBulk(p.id)}
                onShowVersions={() => setVersionsDialog(p)}
                onPlayground={() => {
                  setPlaygroundProfileId(p.id);
                  setPlaygroundOpen(true);
                }}
                onDuplicate={async () => {
                  const r = await duplicateFn({ data: { profileId: p.id } });
                  if (r.ok) {
                    toast.success("Profile duplicated");
                    refresh();
                  } else toast.error(r.error);
                }}
              />
            ))}
          </div>
        </TabsContent>

        {/* Assignments */}
        <TabsContent value="assignments" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Clone</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        No clones assigned to a profile yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {assignments.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium">
                          {a.clones?.name ?? a.clone_id.slice(0, 8)}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {a.clones?.slug}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{a.clone_brand_profiles?.name ?? "—"}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          v{a.clone_brand_profiles?.version ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_BADGE[a.status]}>
                          {a.status}
                        </Badge>
                        {a.drift_summary && (
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            {a.drift_summary}
                          </div>
                        )}
                        {a.error_message && (
                          <div className="mt-1 text-[10px] text-destructive">{a.error_message}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.applied_at ? formatDistanceToNow(a.applied_at) + " ago" : "Never"}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setOverridesDialog({
                              cloneId: a.clone_id,
                              cloneName: a.clones?.name ?? a.clone_id.slice(0, 8),
                            })
                          }
                        >
                          <Layers className="mr-1 h-3 w-3" /> Overrides
                          {a.clone_brand_profiles && (
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {/* override_keys count rendered if available */}
                            </span>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => handleApplyOne(a.clone_id, a.profile_id)}
                        >
                          <Rocket className="mr-1 h-3 w-3" /> Apply
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* History */}
        <TabsContent value="history" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Clone</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Hash</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        No branding cascades yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {history.map((h) => {
                    const profile = h.profile_id ? profilesById.get(h.profile_id) : null;
                    const clone = clones.find((c) => c.id === h.clone_id);
                    return (
                      <TableRow key={h.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDistanceToNow(h.created_at)} ago
                        </TableCell>
                        <TableCell className="text-sm">
                          {clone?.name ?? h.clone_id.slice(0, 8)}
                        </TableCell>
                        <TableCell className="text-sm">
                          {profile?.name ?? "—"} {h.profile_version ? `v${h.profile_version}` : ""}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={STATUS_BADGE[h.status]}>
                            {h.status}
                          </Badge>
                          {h.error_message && (
                            <div className="mt-1 text-[10px] text-destructive">
                              {h.error_message}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {h.duration_ms ? `${h.duration_ms}ms` : "—"}
                        </TableCell>
                        <TableCell className="font-mono text-[10px] text-muted-foreground">
                          {h.config_hash?.slice(0, 10) ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        {/* Schedules */}
        <TabsContent value="schedules" className="mt-4 space-y-3">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              Cron-driven brand syncs. Targets drifted clones by default; use "all" to re-cascade
              every assigned clone.
            </p>
            <Button size="sm" onClick={() => setScheduleDialogOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" /> New schedule
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Cron</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        No brand sync schedules yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {schedules.map((s) => {
                    const profile = s.scope_filter.profile_id
                      ? profilesById.get(s.scope_filter.profile_id)
                      : null;
                    const target = s.scope_filter.clone_ids;
                    const targetLabel = Array.isArray(target)
                      ? `${target.length} clone(s)`
                      : (target ?? "drifted");
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell className="text-sm">{profile?.name ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {describeCron(s.cron_expression)}
                        </TableCell>
                        <TableCell className="text-xs">{targetLabel}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {s.last_run_at ? formatDistanceToNow(s.last_run_at) + " ago" : "Never"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {s.next_run_at ? formatDistanceToNow(s.next_run_at) : "—"}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={s.enabled}
                            onCheckedChange={() => handleToggleSchedule(s)}
                          />
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => handleRunSchedule(s.id)}
                          >
                            <PlayCircle className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDeleteSchedule(s)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* New schedule dialog */}
      <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New brand sync schedule</DialogTitle>
            <DialogDescription>
              Periodically re-applies a brand profile to its assigned clones.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={newSchedName}
                onChange={(e) => setNewSchedName(e.target.value)}
                placeholder="Daily brand sync"
              />
            </div>
            <div>
              <Label>Brand profile</Label>
              <Select value={newSchedProfile} onValueChange={setNewSchedProfile}>
                <SelectTrigger>
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles
                    .filter((p) => p.status === "published")
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} (v{p.version})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Cron expression (UTC)</Label>
              <Input
                value={newSchedCron}
                onChange={(e) => setNewSchedCron(e.target.value)}
                placeholder="0 */6 * * *"
              />
              <p className="mt-1 text-xs text-muted-foreground">{describeCron(newSchedCron)}</p>
            </div>
            <div>
              <Label>Target clones</Label>
              <Select
                value={newSchedTarget}
                onValueChange={(v) => setNewSchedTarget(v as "drifted" | "all")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="drifted">Drifted only (recommended)</SelectItem>
                  <SelectItem value="all">All assigned clones</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScheduleDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateSchedule}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editor */}
      {editorOpen && (
        <ProfileEditor
          profile={editing}
          onClose={() => setEditorOpen(false)}
          onSave={async (input) => {
            const r = await upsertFn({ data: input });
            if (r.ok) {
              toast.success(editing ? "Profile updated" : "Profile created");
              setEditorOpen(false);
              refresh();
            } else {
              toast.error(r.error ?? "Save failed");
            }
          }}
        />
      )}

      {/* Bulk apply dialog */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bulk apply brand profile</DialogTitle>
            <DialogDescription>
              Select clones to receive this profile. Pushes &gt;3 clones in auto-merge mode require
              second-operator approval.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Profile
              </Label>
              <select
                className="mt-1 w-full border border-input bg-background px-3 py-2 text-sm"
                value={bulkProfileId}
                onChange={(e) => setBulkProfileId(e.target.value)}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.is_default ? "(default)" : ""} · v{p.version}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Clones ({bulkCloneIds.size} selected)
                </Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setBulkCloneIds(new Set(clones.map((c) => c.id)))}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:underline"
                    onClick={() => setBulkCloneIds(new Set())}
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="max-h-64 overflow-auto border border-border">
                {clones.map((c) => {
                  const checked = bulkCloneIds.has(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-sm hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          const next = new Set(bulkCloneIds);
                          if (v) next.add(c.id);
                          else next.delete(c.id);
                          setBulkCloneIds(next);
                        }}
                      />
                      <span className="flex-1">{c.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{c.slug}</span>
                    </label>
                  );
                })}
                {clones.length === 0 && (
                  <p className="px-3 py-4 text-sm text-muted-foreground">No clones yet.</p>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={busy || bulkCloneIds.size === 0 || !bulkProfileId}
              onClick={handleBulkAssign}
            >
              <Link2 className="mr-2 h-4 w-4" /> Assign only
            </Button>
            <Button
              disabled={busy || bulkCloneIds.size === 0 || !bulkProfileId}
              onClick={handleBulkApply}
            >
              <Rocket className="mr-2 h-4 w-4" /> Apply now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phase 6: Version timeline */}
      {versionsDialog && (
        <BrandVersionTimelineDialog
          open
          onClose={() => setVersionsDialog(null)}
          profileId={versionsDialog.id}
          profileName={versionsDialog.name}
          currentVersion={versionsDialog.version}
          onRolledBack={refresh}
        />
      )}

      {/* Phase 6: Per-clone overrides */}
      {overridesDialog && (
        <CloneOverrideEditorDialog
          open
          onClose={() => setOverridesDialog(null)}
          cloneId={overridesDialog.cloneId}
          cloneName={overridesDialog.cloneName}
          onSaved={refresh}
        />
      )}

      {/* Phase 6: Theme playground */}
      <BrandPlaygroundDialog
        open={playgroundOpen}
        onClose={() => setPlaygroundOpen(false)}
        profiles={profiles}
        initialProfileId={playgroundProfileId}
      />
    </div>
  );
}

// ─── Profile card ─────────────────────────────────────────────────────

function ProfileCard({
  profile,
  assignmentCount,
  onEdit,
  onPublishToggle,
  onDelete,
  onApply,
  onShowVersions,
  onPlayground,
  onDuplicate,
}: {
  profile: BrandProfile;
  assignmentCount: number;
  onEdit: () => void;
  onPublishToggle: () => void;
  onDelete: () => void;
  onApply: () => void;
  onShowVersions: () => void;
  onPlayground: () => void;
  onDuplicate: () => void;
}) {
  const cfg = profile.brand_config as Record<string, string | null | undefined>;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              {profile.is_default && <Star className="h-4 w-4 fill-amber-400 text-amber-400" />}
              <span className="truncate">{profile.name}</span>
            </CardTitle>
            <CardDescription className="font-mono text-[10px]">
              {profile.slug} · v{profile.version}
            </CardDescription>
          </div>
          <Badge variant="outline" className={STATUS_BADGE[profile.status]}>
            {profile.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {cfg.brand_name && <p className="text-sm font-medium">{cfg.brand_name}</p>}
        {profile.description && (
          <p className="text-xs text-muted-foreground">{profile.description}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {(["primary_color", "secondary_color", "accent_color"] as const).map((k) => {
            const c = cfg[k];
            if (!c) return null;
            return (
              <div
                key={k}
                className="flex items-center gap-1 border bg-surface px-2 py-1 text-[10px] font-mono"
                title={k}
              >
                <span className="h-3 w-3 border border-border" style={{ background: c }} />
                {c}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{assignmentCount} clone(s)</span>
          <span>·</span>
          <span>{profile.asset_manifest.length} asset(s)</span>
          <span>·</span>
          <span>updated {formatDistanceToNow(profile.updated_at)} ago</span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button size="sm" variant="outline" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="outline" onClick={onPublishToggle}>
            {profile.status === "published" ? "Archive" : "Publish"}
          </Button>
          <Button size="sm" variant="outline" onClick={onShowVersions}>
            <HistoryIcon className="mr-1 h-3 w-3" /> v{profile.version}
          </Button>
          <Button size="sm" variant="outline" onClick={onPlayground}>
            <Sparkles className="mr-1 h-3 w-3" /> Tweak
          </Button>
          <Button size="sm" variant="outline" onClick={onDuplicate}>
            Duplicate
          </Button>
          <BrandProfileIO profile={profile} />
          <Button size="sm" onClick={onApply} disabled={profile.status !== "published"}>
            <Rocket className="mr-1 h-3 w-3" /> Apply
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Profile editor ───────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <MetricCell
      label={label}
      value={value}
      tone={tone === "danger" ? "destructive" : "warning"}
      alarm={tone !== "default"}
    />
  );
}

function ProfileEditor({
  profile,
  onClose,
  onSave,
}: {
  profile: BrandProfile | null;
  onClose: () => void;
  onSave: (input: {
    id?: string;
    name: string;
    slug?: string;
    description?: string | null;
    brand_config: Record<string, unknown>;
    report_contact: Record<string, unknown>;
    asset_manifest?: AssetEntry[];
    tags?: string[];
    is_default?: boolean;
  }) => Promise<void>;
}) {
  const initialCfg = (profile?.brand_config ?? {}) as Record<string, string>;
  const initialContact = (profile?.report_contact ?? {}) as Record<string, string>;
  const initialAssets = (profile?.asset_manifest ?? []) as unknown as AssetEntry[];

  const [name, setName] = useState(profile?.name ?? "");
  const [slug, setSlug] = useState(profile?.slug ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [isDefault, setIsDefault] = useState(profile?.is_default ?? false);
  const [tags, setTags] = useState((profile?.tags ?? []).join(", "));
  const [cfg, setCfg] = useState<Record<string, string>>({
    brand_name: initialCfg.brand_name ?? "",
    tagline: initialCfg.tagline ?? "",
    primary_color: initialCfg.primary_color ?? "#0066ff",
    secondary_color: initialCfg.secondary_color ?? "#1a1a1a",
    accent_color: initialCfg.accent_color ?? "#ff6b35",
    background_color: initialCfg.background_color ?? "#ffffff",
    foreground_color: initialCfg.foreground_color ?? "#0a0a0a",
    font_family: initialCfg.font_family ?? "",
    logo_light_url: initialCfg.logo_light_url ?? "",
    logo_dark_url: initialCfg.logo_dark_url ?? "",
    favicon_url: initialCfg.favicon_url ?? "",
    support_url: initialCfg.support_url ?? "",
    privacy_url: initialCfg.privacy_url ?? "",
    terms_url: initialCfg.terms_url ?? "",
  });
  const [contact, setContact] = useState<Record<string, string>>({
    contact_name: initialContact.contact_name ?? "",
    contact_email: initialContact.contact_email ?? "",
    contact_phone: initialContact.contact_phone ?? "",
    contact_address: initialContact.contact_address ?? "",
    contact_website: initialContact.contact_website ?? "",
    legal_name: initialContact.legal_name ?? "",
    abn: initialContact.abn ?? "",
    licence_number: initialContact.licence_number ?? "",
  });
  const [assets, setAssets] = useState<AssetEntry[]>(initialAssets);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadField, setUploadField] = useState<string | null>(null);

  const handleField = (k: string, v: string) => setCfg((prev) => ({ ...prev, [k]: v }));

  const handleUpload = async (field: string, target: string, file: File) => {
    const tempId = profile?.id ?? "draft";
    const path = `profiles/${tempId}/${Date.now()}-${file.name}`;
    const { error } = await supabase.storage
      .from("brand-assets")
      .upload(path, file, { contentType: file.type, upsert: true });
    if (error) {
      toast.error(`Upload failed: ${error.message}`);
      return;
    }
    const { data } = supabase.storage.from("brand-assets").getPublicUrl(path);
    const publicUrl = data.publicUrl;
    setCfg((prev) => ({ ...prev, [field]: publicUrl }));
    setAssets((prev) => {
      const filtered = prev.filter((a) => a.config_field !== field);
      return [
        ...filtered,
        {
          source_path: path,
          target_path: target,
          content_type: file.type || "application/octet-stream",
          config_field: field,
          public_url: publicUrl,
        },
      ];
    });
    toast.success("Asset uploaded");
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadField) return;
    const def = ASSET_FIELDS.find((a) => a.field === uploadField);
    if (!def) return;
    handleUpload(def.field, def.target, file);
    e.target.value = "";
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    setSaving(true);
    await onSave({
      id: profile?.id,
      name: name.trim(),
      slug: slug.trim() || undefined,
      description: description.trim() || null,
      brand_config: Object.fromEntries(Object.entries(cfg).filter(([, v]) => v?.trim() !== "")),
      report_contact: Object.fromEntries(
        Object.entries(contact).filter(([, v]) => v?.trim() !== ""),
      ),
      asset_manifest: assets,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      is_default: isDefault,
    });
    setSaving(false);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {profile ? `Edit profile · ${profile.name}` : "New brand profile"}
          </DialogTitle>
          <DialogDescription>
            Brand bundle cascades to clones&apos;{" "}
            <code className="font-mono text-xs">whitelabel_settings</code> and report contact
            details.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="identity" className="mt-2">
          <TabsList>
            <TabsTrigger value="identity">Identity</TabsTrigger>
            <TabsTrigger value="theme">Theme</TabsTrigger>
            <TabsTrigger value="assets">Assets</TabsTrigger>
            <TabsTrigger value="contact">Contact</TabsTrigger>
            <TabsTrigger value="legal">Legal</TabsTrigger>
          </TabsList>

          <TabsContent value="identity" className="mt-4 space-y-3">
            <Field label="Profile name" value={name} onChange={setName} required />
            <Field label="Slug (optional)" value={slug} onChange={setSlug} mono />
            <Field
              label="Brand name"
              value={cfg.brand_name}
              onChange={(v) => handleField("brand_name", v)}
            />
            <Field
              label="Tagline"
              value={cfg.tagline}
              onChange={(v) => handleField("tagline", v)}
            />
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Description
              </Label>
              <Textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <Field label="Tags (comma-separated)" value={tags} onChange={setTags} />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(Boolean(v))} />
              <Star className="h-4 w-4 text-amber-400" />
              Default profile (auto-assigned to new clones)
            </label>
          </TabsContent>

          <TabsContent value="theme" className="mt-4 grid gap-3 md:grid-cols-2">
            <ColorField
              label="Primary"
              value={cfg.primary_color}
              onChange={(v) => handleField("primary_color", v)}
            />
            <ColorField
              label="Secondary"
              value={cfg.secondary_color}
              onChange={(v) => handleField("secondary_color", v)}
            />
            <ColorField
              label="Accent"
              value={cfg.accent_color}
              onChange={(v) => handleField("accent_color", v)}
            />
            <ColorField
              label="Background"
              value={cfg.background_color}
              onChange={(v) => handleField("background_color", v)}
            />
            <ColorField
              label="Foreground"
              value={cfg.foreground_color}
              onChange={(v) => handleField("foreground_color", v)}
            />
            <Field
              label="Font family"
              value={cfg.font_family}
              onChange={(v) => handleField("font_family", v)}
            />
          </TabsContent>

          <TabsContent value="assets" className="mt-4 space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/x-icon"
              className="hidden"
              onChange={handleFile}
            />
            {ASSET_FIELDS.map((def) => {
              const url = cfg[def.field];
              return (
                <div
                  key={def.field}
                  className="flex items-center gap-3 border border-border bg-surface p-3"
                >
                  <div className="flex h-12 w-12 items-center justify-center border border-border bg-background">
                    {url ? (
                      <img src={url} alt="" className="max-h-10 max-w-10 object-contain" />
                    ) : (
                      <ImageIcon className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{def.label}</div>
                    {/* What the mark is FOR. Two of the six print on paper and
                        four dress the interface, and nothing here said which —
                        so "Logo (dark)" was uploaded as a knockout lockup about
                        as often as it was not. */}
                    <div className="text-xs text-muted-foreground">{def.purpose}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {url || "Not set"}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setUploadField(def.field);
                      fileRef.current?.click();
                    }}
                  >
                    <Upload className="mr-1 h-3 w-3" /> Upload
                  </Button>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              Uploads land in Mission Control&apos;s <code className="font-mono">brand-assets</code>{" "}
              bucket and are mirrored into each clone&apos;s storage on apply.
            </p>
          </TabsContent>

          <TabsContent value="contact" className="mt-4 space-y-3">
            <Field
              label="Contact name"
              value={contact.contact_name}
              onChange={(v) => setContact((p) => ({ ...p, contact_name: v }))}
            />
            <Field
              label="Email"
              value={contact.contact_email}
              onChange={(v) => setContact((p) => ({ ...p, contact_email: v }))}
            />
            <Field
              label="Phone"
              value={contact.contact_phone}
              onChange={(v) => setContact((p) => ({ ...p, contact_phone: v }))}
            />
            <Field
              label="Website"
              value={contact.contact_website}
              onChange={(v) => setContact((p) => ({ ...p, contact_website: v }))}
            />
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Address
              </Label>
              <Textarea
                rows={2}
                value={contact.contact_address}
                onChange={(e) => setContact((p) => ({ ...p, contact_address: e.target.value }))}
              />
            </div>
            <div className="border-t pt-3">
              <p className="mb-2 text-xs text-muted-foreground">
                Legal identity — printed on generated legal documents (agreements, reports): the
                registered entity, its ABN/ACN and licence details.
              </p>
              <div className="space-y-3">
                <Field
                  label="Legal entity name"
                  value={contact.legal_name}
                  onChange={(v) => setContact((p) => ({ ...p, legal_name: v }))}
                />
                <Field
                  label="ABN / ACN"
                  value={contact.abn}
                  onChange={(v) => setContact((p) => ({ ...p, abn: v }))}
                />
                <Field
                  label="Licence number"
                  value={contact.licence_number}
                  onChange={(v) => setContact((p) => ({ ...p, licence_number: v }))}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="legal" className="mt-4 space-y-3">
            <Field
              label="Support URL"
              value={cfg.support_url}
              onChange={(v) => handleField("support_url", v)}
            />
            <Field
              label="Privacy URL"
              value={cfg.privacy_url}
              onChange={(v) => handleField("privacy_url", v)}
            />
            <Field
              label="Terms URL"
              value={cfg.terms_url}
              onChange={(v) => handleField("terms_url", v)}
            />
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving…" : profile ? "Save changes" : "Create profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  mono?: boolean;
}) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={cn(mono && "font-mono text-sm")}
      />
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-14 cursor-pointer border border-input bg-background"
        />
        <Input
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
          placeholder="#0066ff"
        />
      </div>
    </div>
  );
}
