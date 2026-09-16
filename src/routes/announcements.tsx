import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Megaphone, Pencil, RefreshCcw, Send } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { MetricBar } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { RefreshButton } from "@/components/refresh-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  archiveAnnouncementFn,
  createAnnouncementFn,
  listAnnouncements,
  publishAnnouncementFn,
  reraiseAnnouncementFn,
  updateAnnouncementFn,
  type AnnouncementListResult,
  type AnnouncementListRow,
} from "@/server/announcements.functions";
import {
  announcementReachesClone,
  announcementTone,
  describeAnnouncementState,
  type AnnouncementState,
} from "@/lib/cloneAnnouncements.pure";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/announcements")({
  component: () => (
    <ProtectedRoute>
      <AnnouncementsPage />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Announcements — Mission Control" }] }),
});

const TONE_TO_SPINE: Record<ReturnType<typeof announcementTone>, SpineTone> = {
  neutral: "idle",
  success: "ok",
  warning: "warn",
  danger: "bad",
};

const STATE_WORD: Record<AnnouncementState, string> = {
  draft: "draft",
  scheduled: "scheduled",
  active: "live",
  expired: "expired",
  archived: "archived",
};

type Filter = "all" | "active" | "scheduled" | "draft" | "expired" | "archived";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Live" },
  { key: "scheduled", label: "Scheduled" },
  { key: "draft", label: "Drafts" },
  { key: "expired", label: "Expired" },
  { key: "archived", label: "Archived" },
];

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

function AnnouncementsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listAnnouncements);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<AnnouncementListRow | null | "new">(null);

  const query = useQuery({
    queryKey: ["clone-announcements"],
    queryFn: () => list(),
    refetchInterval: 60_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["clone-announcements"] });

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    if (filter === "all") return all;
    if (filter === "active") return all.filter((r) => r.state === "active");
    return all.filter((r) => r.state === filter);
  }, [query.data, filter]);

  const s = query.data?.summary;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="fleet comms"
        title="Announcements"
        description="Operator notices delivered onto clone dashboards — global, or scoped to plans or named clones. Mission Control decides who sees what; a clone only ever renders the answer, and is told nothing about the targeting."
        actions={
          <div className="flex items-center gap-2">
            <RefreshButton onRefresh={refresh} loading={query.isFetching} />
            <Button onClick={() => setEditing("new")}>
              <Megaphone className="mr-2 h-4 w-4" /> New announcement
            </Button>
          </div>
        }
      />

      {s && (
        <MetricBar
          metrics={[
            { label: "live", value: s.active, tone: "success", alarm: false },
            { label: "scheduled", value: s.scheduled, tone: "warning", alarm: false },
            { label: "drafts", value: s.drafts },
            { label: "expired", value: s.expired },
            { label: "archived", value: s.archived, note: `${s.total} total` },
          ]}
        />
      )}

      <div className="glass flex flex-wrap overflow-hidden self-start">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "label-mono -ml-px border-l border-border/50 px-3 py-2 transition-colors",
              filter === f.key
                ? "bg-foreground/[0.07] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.04]",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <CardRowSkeleton />
      ) : query.isError ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Could not read the announcements"
          description={query.error instanceof Error ? query.error.message : "Unknown error"}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title={filter === "all" ? "Nothing announced yet" : "Nothing here"}
          description={
            filter === "all"
              ? "Write one and choose who sees it — everyone, a plan tier, or a single clone."
              : "No announcement matches this filter right now."
          }
        />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <AnnouncementRowView
              key={r.row.id}
              item={r}
              onEdit={() => setEditing(r)}
              onDone={refresh}
            />
          ))}
        </div>
      )}

      {editing !== null && query.data && (
        <EditorDialog
          data={query.data}
          item={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AnnouncementRowView({
  item,
  onEdit,
  onDone,
}: {
  item: AnnouncementListRow;
  onEdit: () => void;
  onDone: () => void;
}) {
  const publish = useServerFn(publishAnnouncementFn);
  const reraise = useServerFn(reraiseAnnouncementFn);
  const archive = useServerFn(archiveAnnouncementFn);
  const [busy, setBusy] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");

  const row = item.row;
  const tone = announcementTone(item.state);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      const result = (await fn()) as { ok: boolean; error?: string };
      if (!result.ok) toast.error(`${label} failed: ${result.error}`);
      else {
        toast.success(label);
        onDone();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <RecordRow spine={TONE_TO_SPINE[tone]} className="p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-display truncate text-base">{row.title}</span>
            <span
              className={cn(
                "font-mono text-[10px] tracking-[0.18em] uppercase whitespace-nowrap",
                tone === "danger"
                  ? "text-destructive"
                  : tone === "warning"
                    ? "text-warning"
                    : tone === "success"
                      ? "text-success"
                      : "text-muted-foreground",
              )}
            >
              <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 bg-current align-middle" />
              {STATE_WORD[item.state]}
            </span>
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted-foreground">
              · {row.severity} {row.display}
              {row.revision > 1 ? ` · r${row.revision}` : ""}
            </span>
          </div>

          <p className="text-sm text-muted-foreground">
            {describeAnnouncementState(row, item.state)}
          </p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            <span>{item.audience}</span>
            <span aria-hidden>·</span>
            <span>reaches {item.reaches.length} clone{item.reaches.length === 1 ? "" : "s"}</span>
            {item.state === "active" && (
              <>
                <span aria-hidden>·</span>
                {/* A notice nobody's dashboard has fetched is otherwise
                    indistinguishable from one that is working. */}
                <span className={cn(item.deliveredTo === 0 && "text-warning")}>
                  {item.deliveredTo === 0
                    ? "not yet fetched by any clone"
                    : `fetched by ${item.deliveredTo} of ${item.reaches.length}`}
                </span>
              </>
            )}
            {row.published_at && (
              <>
                <span aria-hidden>·</span>
                <span>published {when(row.published_at)}</span>
              </>
            )}
            {row.starts_at && (
              <>
                <span aria-hidden>·</span>
                <span>starts {when(row.starts_at)}</span>
              </>
            )}
            {row.ends_at && (
              <>
                <span aria-hidden>·</span>
                <span>ends {when(row.ends_at)}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
          </Button>
          {(item.state === "draft" ||
            item.state === "expired" ||
            item.state === "archived") && (
            <Button
              size="sm"
              onClick={() => act("Published", () => publish({ data: { id: row.id } }))}
              disabled={busy}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" /> Publish
            </Button>
          )}
          {item.state === "active" && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                title="Bump the revision so dashboards that dismissed it show it again"
                onClick={() => act("Re-raised", () => reraise({ data: { id: row.id } }))}
              >
                <RefreshCcw className="mr-1.5 h-3.5 w-3.5" /> Re-raise
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setArchiveOpen(true)}
              >
                Archive
              </Button>
            </>
          )}
          {(item.state === "scheduled" || item.state === "expired") && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setArchiveOpen(true)}
            >
              Archive
            </Button>
          )}
        </div>
      </div>

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive “{row.title}”</DialogTitle>
            <DialogDescription>
              Putting away, never throwing away: the notice stops rendering everywhere and the
              record — including which clones fetched it — is kept. Publishing it again later
              brings it back.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`archive-reason-${row.id}`}>Reason</Label>
            <Input
              id={`archive-reason-${row.id}`}
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
              placeholder="Why this notice is coming down"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={archiveReason.trim().length < 5 || busy}
              onClick={() =>
                act("Archived", () =>
                  archive({ data: { id: row.id, reason: archiveReason.trim() } }),
                ).then(() => setArchiveOpen(false))
              }
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RecordRow>
  );
}

type AudienceMode = "all" | "plans" | "clones";

function EditorDialog({
  data,
  item,
  onClose,
  onSaved,
}: {
  data: AnnouncementListResult;
  item: AnnouncementListRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const create = useServerFn(createAnnouncementFn);
  const update = useServerFn(updateAnnouncementFn);
  const [busy, setBusy] = useState(false);

  const row = item?.row ?? null;
  const [title, setTitle] = useState(row?.title ?? "");
  const [body, setBody] = useState(row?.body ?? "");
  const [linkUrl, setLinkUrl] = useState(row?.link_url ?? "");
  const [linkLabel, setLinkLabel] = useState(row?.link_label ?? "");
  const [severity, setSeverity] = useState(row?.severity ?? "info");
  const [display, setDisplay] = useState(row?.display ?? "banner");
  const [dismissible, setDismissible] = useState(row?.dismissible ?? true);
  const [mode, setMode] = useState<AudienceMode>(
    row?.audience_clone_ids ? "clones" : row?.audience_plan_slugs ? "plans" : "all",
  );
  const [planSlugs, setPlanSlugs] = useState<string[]>(row?.audience_plan_slugs ?? []);
  const [cloneIds, setCloneIds] = useState<string[]>(row?.audience_clone_ids ?? []);
  const toLocal = (iso: string | null | undefined) =>
    iso ? new Date(iso).toISOString().slice(0, 16) : "";
  const [startsAt, setStartsAt] = useState(toLocal(row?.starts_at));
  const [endsAt, setEndsAt] = useState(toLocal(row?.ends_at));

  // The SAME matcher the route serves with, run over the same roster — "who
  // will see this" is a fact, not a second opinion.
  const reach = useMemo(() => {
    const scope = {
      audience_plan_slugs: mode === "plans" && planSlugs.length > 0 ? planSlugs : null,
      audience_clone_ids: mode === "clones" && cloneIds.length > 0 ? cloneIds : null,
    };
    return data.clones.filter((c) =>
      announcementReachesClone(scope, { id: c.id, planSlug: c.planSlug }),
    );
  }, [data.clones, mode, planSlugs, cloneIds]);

  async function save() {
    setBusy(true);
    try {
      const payload = {
        title,
        body,
        linkUrl: linkUrl || null,
        linkLabel: linkLabel || null,
        severity,
        display,
        dismissible,
        audiencePlanSlugs: mode === "plans" ? planSlugs : null,
        audienceCloneIds: mode === "clones" ? cloneIds : null,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      };
      const result = (
        row
          ? await update({ data: { ...payload, id: row.id } })
          : await create({ data: payload })
      ) as { ok: boolean; error?: string };
      if (!result.ok) toast.error(`Save failed: ${result.error}`);
      else {
        toast.success(row ? "Announcement updated" : "Draft created — publish it when ready");
        onSaved();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const audienceInvalid =
    (mode === "plans" && planSlugs.length === 0) ||
    (mode === "clones" && cloneIds.length === 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{row ? "Edit announcement" : "New announcement"}</DialogTitle>
          <DialogDescription>
            {row
              ? "Edits reach dashboards on their next poll. Dismissed banners stay dismissed — use Re-raise on the list when everyone should see it again."
              : "Saved as a draft nobody can see. Publishing is its own step."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ann-title">Title</Label>
            <Input
              id="ann-title"
              value={title}
              maxLength={140}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Scheduled maintenance this Saturday"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ann-body">Body</Label>
            <Textarea
              id="ann-body"
              value={body}
              maxLength={2000}
              rows={4}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Plain words, shown exactly as typed."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Display</Label>
              <Select value={display} onValueChange={setDisplay}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="banner">Banner across the dashboard</SelectItem>
                  <SelectItem value="modal">Popup (modal)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2.5">
            <div>
              <Label htmlFor="ann-dismissible">Dismissible</Label>
              <p className="text-xs text-muted-foreground">
                {display === "modal"
                  ? "A popup can always be closed — an uncloseable modal is a lock screen, and locking is the payment gate's job."
                  : "Off, the banner stays until this notice ends or is archived."}
              </p>
            </div>
            <Switch
              id="ann-dismissible"
              checked={display === "modal" ? true : dismissible}
              disabled={display === "modal"}
              onCheckedChange={setDismissible}
            />
          </div>

          <div className="space-y-2">
            <Label>Audience</Label>
            <div className="glass flex overflow-hidden self-start">
              {(
                [
                  ["all", "Everyone"],
                  ["plans", "By plan"],
                  ["clones", "Specific clones"],
                ] as Array<[AudienceMode, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  className={cn(
                    "label-mono -ml-px border-l border-border/50 px-3 py-2 transition-colors",
                    mode === key
                      ? "bg-foreground/[0.07] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04]",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "plans" && (
              <div className="space-y-1.5 rounded-md border border-border/60 p-3">
                {data.planOptions.map((p) => (
                  <label key={p.slug} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={planSlugs.includes(p.slug)}
                      onCheckedChange={(v) =>
                        setPlanSlugs((prev) =>
                          v ? [...prev, p.slug] : prev.filter((s) => s !== p.slug),
                        )
                      }
                    />
                    {p.name}
                    <span className="font-mono text-[11px] text-muted-foreground">{p.slug}</span>
                  </label>
                ))}
              </div>
            )}

            {mode === "clones" && (
              <div className="space-y-1.5 rounded-md border border-border/60 p-3">
                {data.clones.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={cloneIds.includes(c.id)}
                      onCheckedChange={(v) =>
                        setCloneIds((prev) =>
                          v ? [...prev, c.id] : prev.filter((s) => s !== c.id),
                        )
                      }
                    />
                    {c.name}
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {c.planSlug ?? "no plan"}
                    </span>
                  </label>
                ))}
              </div>
            )}

            <p className="font-mono text-[11px] text-muted-foreground">
              {audienceInvalid
                ? "Pick at least one, or switch back to Everyone."
                : reach.length === 0
                  ? "Right now this reaches no clone."
                  : `Right now this reaches: ${reach.map((c) => c.name).join(", ")}`}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ann-starts">Starts (optional)</Label>
              <Input
                id="ann-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ann-ends">Ends (optional)</Label>
              <Input
                id="ann-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ann-link">Link (optional, https)</Label>
              <Input
                id="ann-link"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ann-link-label">Link label</Label>
              <Input
                id="ann-link-label"
                value={linkLabel}
                disabled={!linkUrl}
                onChange={(e) => setLinkLabel(e.target.value)}
                placeholder="Read more"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || title.trim().length === 0 || body.trim().length === 0 || audienceInvalid}
          >
            {row ? "Save changes" : "Save draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
