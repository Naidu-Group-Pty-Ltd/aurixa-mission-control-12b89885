/**
 * Workspace messages — how Mission Control speaks to the fleet.
 *
 * Three ways to address it, and they are three views of ONE stored scope
 * (`audience_plan_slugs` / `audience_clone_ids`), so delivery, reach and the
 * clone's wire are exactly what they were:
 *
 *  - One workspace       — a single named clone;
 *  - All workspaces      — every clone (both columns null);
 *  - Selected workspaces — chosen clones, or every clone on chosen plans.
 *
 * Every message is ONE-WAY. A workspace shows it to its own Command Centre
 * staff (a banner or a popup, and a "From Mission Control" sheet in their
 * Messaging Hub) and nobody can reply to it. Mission Control is never a
 * contact in any workspace's hub and never a participant in a conversation,
 * which is why this is a notice channel and not a messaging surface: a reply
 * path would make Mission Control a mailbox somebody has to watch.
 *
 * Operators read this page; only an administrator writes. The server enforces
 * that (`requireAdmin`); the page merely stops offering what would be refused.
 */
import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Building2,
  Globe2,
  Layers,
  Megaphone,
  Pencil,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
} from "lucide-react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
  type AnnouncementCloneRef,
  type AnnouncementListResult,
  type AnnouncementListRow,
} from "@/server/announcements.functions";
import {
  AUDIENCE_MODE_LABEL,
  announcementReachesClone,
  announcementTone,
  audienceDraftOf,
  audienceHeadline,
  audienceModeOf,
  audienceScopeOf,
  describeAnnouncementState,
  workspaceMatches,
  type AnnouncementState,
  type SelectedBy,
  type WorkspaceAudienceDraft,
  type WorkspaceAudienceMode,
} from "@/lib/cloneAnnouncements.pure";
import { useUserRoles } from "@/lib/use-user-roles";
import { cn } from "@/lib/utils";

type AnnouncementsSearch = { to?: string };

export const Route = createFileRoute("/announcements")({
  validateSearch: (s: Record<string, unknown>): AnnouncementsSearch => ({
    to: typeof s.to === "string" && s.to.length > 0 ? s.to : undefined,
  }),
  component: () => (
    <ProtectedRoute>
      <AnnouncementsPage />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Workspace messages — Mission Control" }] }),
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

type AudienceFilter = "any" | WorkspaceAudienceMode;

const AUDIENCE_FILTERS: Array<{ key: AudienceFilter; label: string }> = [
  { key: "any", label: "Any audience" },
  { key: "everyone", label: AUDIENCE_MODE_LABEL.everyone },
  { key: "one", label: AUDIENCE_MODE_LABEL.one },
  { key: "selected", label: AUDIENCE_MODE_LABEL.selected },
];

const MODE_ICON: Record<WorkspaceAudienceMode, typeof Globe2> = {
  everyone: Globe2,
  one: Building2,
  selected: Layers,
};

const MODE_BLURB: Record<WorkspaceAudienceMode, string> = {
  one: "A single workspace — a note to one business.",
  everyone: "Every workspace in the fleet, including any provisioned later.",
  selected: "Workspaces you pick, or every workspace on the plans you pick.",
};

/** The modes in the order an operator reaches for them. */
const MODE_ORDER: WorkspaceAudienceMode[] = ["one", "everyone", "selected"];

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

/**
 * An ISO instant as the value a `datetime-local` input expects — in the
 * operator's own time zone. `toISOString().slice(0, 16)` gives UTC, which the
 * input then reads as local, so every save of an edited message moved its
 * start and end by the operator's UTC offset.
 */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function namesList(names: string[], max = 6): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ key: K; label: string }>;
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="glass flex flex-wrap overflow-hidden self-start"
    >
      {options.map((f) => (
        <button
          key={f.key}
          type="button"
          aria-pressed={value === f.key}
          onClick={() => onChange(f.key)}
          className={cn(
            "label-mono -ml-px border-l border-border/50 px-3 py-2 transition-colors",
            value === f.key
              ? "bg-foreground/[0.07] text-foreground"
              : "text-muted-foreground hover:bg-foreground/[0.04]",
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** What happens to a message after it leaves here, said once, where it is written. */
function DeliveryNote({ className }: { className?: string }) {
  return (
    <div
      className={cn("glass-inset flex items-start gap-3 rounded-md px-4 py-3 text-sm", className)}
    >
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p className="text-muted-foreground">
        <span className="text-foreground">One-way, staff only.</span> A workspace shows the message
        to its Command Centre staff as a banner or popup, and keeps it in their Messaging Hub under
        “From Mission Control”. Clients and partners never see it, nobody can reply, and Mission
        Control is not a contact in any workspace’s hub.
      </p>
    </div>
  );
}

function AnnouncementsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { to } = Route.useSearch();
  const { isAdmin } = useUserRoles();
  const list = useServerFn(listAnnouncements);
  const [filter, setFilter] = useState<Filter>("all");
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>("any");
  const [search, setSearch] = useState("");
  // Arriving from a workspace's page ("Message this workspace") opens a new
  // message already addressed to it.
  const [editing, setEditing] = useState<AnnouncementListRow | null | "new">(() =>
    to ? "new" : null,
  );
  const [presetCloneId, setPresetCloneId] = useState<string | undefined>(to);

  const query = useQuery({
    queryKey: ["clone-announcements"],
    queryFn: () => list(),
    refetchInterval: 60_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["clone-announcements"] });

  const cloneNames = useMemo(
    () => Object.fromEntries((query.data?.clones ?? []).map((c) => [c.id, c.name])),
    [query.data],
  );
  const planNames = useMemo(
    () => Object.fromEntries((query.data?.planOptions ?? []).map((p) => [p.slug, p.name])),
    [query.data],
  );

  const rows = useMemo(() => {
    let all = query.data?.rows ?? [];
    if (filter !== "all") all = all.filter((r) => r.state === filter);
    if (audienceFilter !== "any") all = all.filter((r) => audienceModeOf(r.row) === audienceFilter);
    const q = search.trim();
    if (q) {
      all = all.filter((r) =>
        workspaceMatches(
          {
            name: `${r.row.title} ${r.row.body}`,
            slug: audienceHeadline(r.row, cloneNames, planNames),
          },
          q,
        ),
      );
    }
    return all;
  }, [query.data, filter, audienceFilter, search, cloneNames, planNames]);

  const closeEditor = () => {
    setEditing(null);
    setPresetCloneId(undefined);
    if (to) void navigate({ to: "/announcements", search: {}, replace: true });
  };

  const s = query.data?.summary;
  const filtered = filter !== "all" || audienceFilter !== "any" || search.trim().length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="fleet comms"
        title="Workspace messages"
        description="Write to one workspace, to every workspace, or to the ones you choose. Mission Control decides who sees a message; a workspace only ever renders it, and is told nothing about who else was sent it."
        actions={
          <div className="flex items-center gap-2">
            <RefreshButton onRefresh={refresh} loading={query.isFetching} />
            {isAdmin && (
              <Button
                onClick={() => {
                  setPresetCloneId(undefined);
                  setEditing("new");
                }}
              >
                <Megaphone className="mr-2 h-4 w-4" /> New message
              </Button>
            )}
          </div>
        }
      />

      <DeliveryNote />

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

      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <Segmented<Filter>
          label="Filter by state"
          options={FILTERS}
          value={filter}
          onChange={setFilter}
        />
        <Segmented<AudienceFilter>
          label="Filter by audience"
          options={AUDIENCE_FILTERS}
          value={audienceFilter}
          onChange={setAudienceFilter}
        />
        <div className="relative min-w-0 lg:ml-auto lg:w-72">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, body or audience"
            aria-label="Search messages"
            className="pl-8"
          />
        </div>
      </div>

      {query.isLoading ? (
        <CardRowSkeleton />
      ) : query.isError ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Could not read the messages"
          description={query.error instanceof Error ? query.error.message : "Unknown error"}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title={filtered ? "Nothing here" : "No messages yet"}
          description={
            filtered
              ? "No message matches these filters right now."
              : "Write one and choose who it is for — one workspace, all of them, or a selection."
          }
          action={
            filtered ? (
              <Button
                variant="outline"
                onClick={() => {
                  setFilter("all");
                  setAudienceFilter("any");
                  setSearch("");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <AnnouncementRowView
              key={r.row.id}
              item={r}
              canWrite={isAdmin}
              headline={audienceHeadline(r.row, cloneNames, planNames)}
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
          presetCloneId={editing === "new" ? presetCloneId : undefined}
          canWrite={isAdmin}
          onClose={closeEditor}
          onSaved={() => {
            closeEditor();
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AnnouncementRowView({
  item,
  canWrite,
  headline,
  onEdit,
  onDone,
}: {
  item: AnnouncementListRow;
  canWrite: boolean;
  headline: string;
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
  const mode = audienceModeOf(row);
  const ModeIcon = MODE_ICON[mode];

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
              <span
                aria-hidden
                className="mr-1.5 inline-block h-1.5 w-1.5 bg-current align-middle"
              />
              {STATE_WORD[item.state]}
            </span>
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted-foreground">
              · {row.severity} {row.display}
              {row.revision > 1 ? ` · r${row.revision}` : ""}
            </span>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="glass-inset inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <ModeIcon className="h-3 w-3" aria-hidden />
              {AUDIENCE_MODE_LABEL[mode]}
            </span>
            <span className="min-w-0 break-words text-foreground/90">{headline}</span>
          </div>

          <p className="text-sm text-muted-foreground">
            {describeAnnouncementState(row, item.state)}
          </p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            <span>
              reaches {item.reaches.length} workspace{item.reaches.length === 1 ? "" : "s"}
            </span>
            {item.state === "active" && (
              <>
                <span aria-hidden>·</span>
                {/* A notice nobody's dashboard has fetched is otherwise
                    indistinguishable from one that is working. */}
                <span className={cn(item.deliveredTo === 0 && "text-warning")}>
                  {item.deliveredTo === 0
                    ? "not yet fetched by any workspace"
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

        {canWrite && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
            </Button>
            {(item.state === "draft" || item.state === "expired" || item.state === "archived") && (
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
        )}
      </div>

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive “{row.title}”</DialogTitle>
            <DialogDescription>
              Putting away, never throwing away: the message stops showing everywhere and the record
              — including which workspaces fetched it — is kept. Publishing it again later brings it
              back.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`archive-reason-${row.id}`}>Reason</Label>
            <Input
              id={`archive-reason-${row.id}`}
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
              placeholder="Why this message is coming down"
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

/**
 * The starting choice for the editor. A stored scope that names workspaces
 * AND plans means "these workspaces, if they are on these plans" — the matcher
 * ANDs them — and the console offers no such mode, so it is opened as the
 * workspaces it reaches today. Saving then keeps exactly that reach rather
 * than silently widening it to the workspaces whatever their plan.
 */
function initialDraft(
  row: AnnouncementListRow["row"] | null,
  clones: AnnouncementCloneRef[],
  presetCloneId: string | undefined,
): WorkspaceAudienceDraft {
  if (!row) {
    if (presetCloneId && clones.some((c) => c.id === presetCloneId)) {
      return { mode: "one", selectedBy: "workspaces", cloneIds: [presetCloneId], planSlugs: [] };
    }
    return { mode: "one", selectedBy: "workspaces", cloneIds: [], planSlugs: [] };
  }
  const draft = audienceDraftOf(row);
  if (draft.cloneIds.length > 0 && draft.planSlugs.length > 0) {
    const reached = clones
      .filter((c) => announcementReachesClone(row, { id: c.id, planSlug: c.planSlug }))
      .map((c) => c.id);
    return {
      mode: reached.length === 1 ? "one" : "selected",
      selectedBy: "workspaces",
      cloneIds: reached,
      planSlugs: [],
    };
  }
  return draft;
}

function WorkspaceList({
  clones,
  chosen,
  onChange,
  single,
}: {
  clones: AnnouncementCloneRef[];
  chosen: readonly string[];
  onChange: (ids: string[]) => void;
  single: boolean;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => clones.filter((c) => workspaceMatches(c, query)), [clones, query]);
  const chosenSet = new Set(chosen);
  const allShownChosen = shown.length > 0 && shown.every((c) => chosenSet.has(c.id));

  if (clones.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border/60 p-3 text-sm text-muted-foreground">
        No workspaces have been provisioned yet.
      </p>
    );
  }

  const row = (c: AnnouncementCloneRef, control: React.ReactNode) => (
    <label
      key={c.id}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-foreground/[0.04]",
        chosenSet.has(c.id) && "bg-foreground/[0.05]",
      )}
    >
      {control}
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {c.planSlug ?? "no plan"}
      </span>
    </label>
  );

  return (
    <div className="rounded-md border border-border/60">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 p-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${clones.length} workspaces`}
            aria-label="Search workspaces"
            className="h-8 pl-8"
          />
        </div>
        {!single && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={shown.length === 0 || allShownChosen}
              onClick={() => onChange([...new Set([...chosen, ...shown.map((c) => c.id)])])}
            >
              Select {query.trim() ? "shown" : "all"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={chosen.length === 0}
              onClick={() => onChange([])}
            >
              Clear
            </Button>
          </div>
        )}
      </div>

      <div className="max-h-60 overflow-y-auto py-1">
        {shown.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            No workspace matches “{query}”.
          </p>
        ) : single ? (
          <RadioGroup
            value={chosen[0] ?? ""}
            onValueChange={(v) => onChange([v])}
            className="gap-0"
            aria-label="Workspace"
          >
            {shown.map((c) => row(c, <RadioGroupItem value={c.id} aria-label={c.name} />))}
          </RadioGroup>
        ) : (
          shown.map((c) =>
            row(
              c,
              <Checkbox
                checked={chosenSet.has(c.id)}
                aria-label={c.name}
                onCheckedChange={(v) =>
                  onChange(v ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))
                }
              />,
            ),
          )
        )}
      </div>

      {!single && (
        <p className="border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {chosen.length} of {clones.length} chosen
        </p>
      )}
    </div>
  );
}

function EditorDialog({
  data,
  item,
  presetCloneId,
  canWrite,
  onClose,
  onSaved,
}: {
  data: AnnouncementListResult;
  item: AnnouncementListRow | null;
  presetCloneId?: string;
  canWrite: boolean;
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
  const [startsAt, setStartsAt] = useState(toLocalInput(row?.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalInput(row?.ends_at));

  const initial = useMemo(
    () => initialDraft(row, data.clones, presetCloneId),
    // Computed once for the message being edited; the roster refreshing
    // underneath must not reset an operator's choice mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [mode, setMode] = useState<WorkspaceAudienceMode>(initial.mode);
  const [selectedBy, setSelectedBy] = useState<SelectedBy>(initial.selectedBy);
  const [oneId, setOneId] = useState<string[]>(initial.mode === "one" ? [...initial.cloneIds] : []);
  const [cloneIds, setCloneIds] = useState<string[]>(
    initial.mode === "selected" ? [...initial.cloneIds] : [],
  );
  const [planSlugs, setPlanSlugs] = useState<string[]>([...initial.planSlugs]);

  const draft: WorkspaceAudienceDraft = {
    mode,
    selectedBy,
    cloneIds: mode === "one" ? oneId : cloneIds,
    planSlugs,
  };
  const scope = audienceScopeOf(draft);

  // The SAME matcher the route serves with, run over the same roster — "who
  // will see this" is a fact, not a second opinion.
  const reach = useMemo(() => {
    if (!scope.ok) return [];
    const stored = {
      audience_plan_slugs: scope.audiencePlanSlugs,
      audience_clone_ids: scope.audienceCloneIds,
    };
    return data.clones.filter((c) =>
      announcementReachesClone(stored, { id: c.id, planSlug: c.planSlug }),
    );
    // `scope` is derived from these on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.clones, mode, selectedBy, oneId, cloneIds, planSlugs]);

  const plansWithCounts = useMemo(
    () =>
      data.planOptions.map((p) => ({
        ...p,
        count: data.clones.filter((c) => c.planSlug === p.slug).length,
      })),
    [data.planOptions, data.clones],
  );

  async function save() {
    if (!scope.ok) return;
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
        audiencePlanSlugs: scope.audiencePlanSlugs,
        audienceCloneIds: scope.audienceCloneIds,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      };
      const result = (
        row ? await update({ data: { ...payload, id: row.id } }) : await create({ data: payload })
      ) as { ok: boolean; error?: string };
      if (!result.ok) toast.error(`Save failed: ${result.error}`);
      else {
        toast.success(row ? "Message updated" : "Draft saved — publish it when ready");
        onSaved();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const oneName =
    mode === "one" && oneId[0] ? data.clones.find((c) => c.id === oneId[0])?.name : null;
  const missing =
    title.trim().length === 0
      ? "Give it a title."
      : body.trim().length === 0
        ? "Write the message."
        : null;
  const blocker = !scope.ok ? scope.reason : missing;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row ? "Edit message" : "New message"}</DialogTitle>
          <DialogDescription>
            {row
              ? "Edits reach workspaces on their next poll. Dismissed banners stay dismissed — use Re-raise on the list when everyone should see it again."
              : "Saved as a draft nobody can see. Publishing is its own step."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="label-mono mb-2 text-muted-foreground">1 · Who it is for</legend>
            <div role="radiogroup" aria-label="Audience" className="grid gap-2 sm:grid-cols-3">
              {MODE_ORDER.map((m) => {
                const Icon = MODE_ICON[m];
                const on = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setMode(m)}
                    className={cn(
                      "glass-inset flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors",
                      on
                        ? "border-primary/60 ring-1 ring-primary/40"
                        : "border-transparent hover:border-border",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon
                        className={cn("h-4 w-4", on ? "text-primary" : "text-muted-foreground")}
                        aria-hidden
                      />
                      {AUDIENCE_MODE_LABEL[m]}
                    </span>
                    <span className="text-xs text-muted-foreground">{MODE_BLURB[m]}</span>
                  </button>
                );
              })}
            </div>

            {mode === "one" && (
              <WorkspaceList clones={data.clones} chosen={oneId} onChange={setOneId} single />
            )}

            {mode === "selected" && (
              <div className="space-y-2">
                <Segmented<SelectedBy>
                  label="Choose by"
                  options={[
                    { key: "workspaces", label: "Choose workspaces" },
                    { key: "plans", label: "Choose by plan" },
                  ]}
                  value={selectedBy}
                  onChange={setSelectedBy}
                />
                {selectedBy === "workspaces" ? (
                  <WorkspaceList
                    clones={data.clones}
                    chosen={cloneIds}
                    onChange={setCloneIds}
                    single={false}
                  />
                ) : (
                  <div className="space-y-1 rounded-md border border-border/60 p-2">
                    {plansWithCounts.map((p) => (
                      <label
                        key={p.slug}
                        className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-foreground/[0.04]"
                      >
                        <Checkbox
                          checked={planSlugs.includes(p.slug)}
                          onCheckedChange={(v) =>
                            setPlanSlugs((prev) =>
                              v ? [...prev, p.slug] : prev.filter((s) => s !== p.slug),
                            )
                          }
                        />
                        <span className="flex-1">{p.name}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {p.count} workspace{p.count === 1 ? "" : "s"} today
                        </span>
                      </label>
                    ))}
                    <p className="px-2 pt-1 text-xs text-muted-foreground">
                      A workspace that moves onto one of these plans later will see it too.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div
              className="glass-inset rounded-md px-3 py-2 font-mono text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              {!scope.ok
                ? scope.reason
                : mode === "everyone"
                  ? `Every workspace — ${reach.length} today, and any provisioned later.`
                  : mode === "one"
                    ? `Only ${oneName ?? "this workspace"}. No other workspace is told it exists.`
                    : reach.length === 0
                      ? "Right now this reaches no workspace."
                      : `${reach.length} workspace${reach.length === 1 ? "" : "s"}: ${namesList(reach.map((c) => c.name))}`}
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="label-mono mb-2 text-muted-foreground">2 · The message</legend>
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
              <Label htmlFor="ann-body">Message</Label>
              <Textarea
                id="ann-body"
                value={body}
                maxLength={2000}
                rows={5}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Plain words, shown exactly as typed."
              />
              <p className="text-right font-mono text-[11px] text-muted-foreground">
                {body.length} / 2000
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
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
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="label-mono mb-2 text-muted-foreground">
              3 · How and when it shows
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
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

            <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-2.5">
              <div>
                <Label htmlFor="ann-dismissible">Dismissible</Label>
                <p className="text-xs text-muted-foreground">
                  {display === "modal"
                    ? "A popup can always be closed — an uncloseable modal is a lock screen, and locking is the payment gate's job."
                    : "Off, the banner stays until this message ends or is archived."}
                </p>
              </div>
              <Switch
                id="ann-dismissible"
                checked={display === "modal" ? true : dismissible}
                disabled={display === "modal"}
                onCheckedChange={setDismissible}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
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
          </fieldset>

          <DeliveryNote />
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {!canWrite ? "Only an administrator can save messages." : (blocker ?? "")}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={busy || !canWrite || blocker !== null}>
              {row ? "Save changes" : "Save draft"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
