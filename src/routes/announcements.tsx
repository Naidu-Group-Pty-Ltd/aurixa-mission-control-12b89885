/**
 * Workspace messages — how Mission Control speaks to the fleet.
 *
 * Three ways to address it, and they are three views of ONE stored scope
 * (`audience_plan_slugs` / `audience_clone_ids` / `audience_match`), so
 * delivery, reach and the workspace's wire run one matcher:
 *
 *  - One workspace       — a single named workspace, the prime included;
 *  - All workspaces      — every workspace (both columns null);
 *  - Selected workspaces — chosen workspaces, every workspace on chosen
 *                          plans, or both together.
 *
 * Each message is either an ANNOUNCEMENT (one-way, the default) or sent with
 * REPLIES ENABLED, when a workspace's Command Centre staff can answer it and
 * the answer comes back here as a conversation with that workspace alone.
 * Mission Control is still never a contact in any workspace's Message Hub:
 * a workspace can answer what it was sent, and cannot start anything.
 *
 * A message goes out now, at a scheduled time, or is kept as a draft. Send
 * now and Schedule publish in the same act as the save, so nothing waits on a
 * second click that is easy to miss (the 17 Oct 2026 "Going Live" message sat
 * as an unpublished draft).
 *
 * Operators read this page; only an administrator writes. The server enforces
 * that (`requireAdmin`); the page merely stops offering what would be refused.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  Clock,
  Crown,
  FileText,
  Globe2,
  Layers,
  Megaphone,
  MessageSquareReply,
  MessagesSquare,
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
  listAnnouncementRepliesFn,
  listAnnouncements,
  markThreadReadFn,
  publishAnnouncementFn,
  replyToWorkspaceFn,
  reraiseAnnouncementFn,
  sendAnnouncementFn,
  updateAnnouncementFn,
  type AnnouncementCloneRef,
  type AnnouncementListResult,
  type AnnouncementListRow,
  type ThreadView,
} from "@/server/announcements.functions";
import {
  ANNOUNCEMENT_SEVERITIES,
  AUDIENCE_MODE_LABEL,
  SEVERITY_IN_WORKSPACE,
  announcementReachesClone,
  announcementTone,
  audienceDraftOf,
  audienceHeadline,
  audienceModeOf,
  audienceScopeOf,
  describeAnnouncementState,
  formatInstant,
  isNarrowingScope,
  sendTimingRefusal,
  workspaceMatches,
  type AnnouncementSeverity,
  type AnnouncementState,
  type SendTiming,
  type WorkspaceAudienceDraft,
  type WorkspaceAudienceMode,
} from "@/lib/cloneAnnouncements.pure";
import { signalSentence, type SignalSummary } from "@/lib/workspaceSignal.pure";
import { useUserRoles } from "@/lib/use-user-roles";
import { cn } from "@/lib/utils";

type AnnouncementsSearch = { to?: string; thread?: string; workspace?: string };

const searchString = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

export const Route = createFileRoute("/announcements")({
  // `thread` + `workspace` is where a reply notification lands: that
  // message's conversations, open at that workspace.
  validateSearch: (s: Record<string, unknown>): AnnouncementsSearch => ({
    to: searchString(s.to),
    thread: searchString(s.thread),
    workspace: searchString(s.workspace),
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

type Filter = "all" | "active" | "scheduled" | "draft" | "expired" | "archived" | "replies";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Live" },
  { key: "scheduled", label: "Scheduled" },
  { key: "draft", label: "Drafts" },
  { key: "expired", label: "Expired" },
  { key: "archived", label: "Archived" },
  { key: "replies", label: "With replies" },
];

type AudienceFilter = "any" | WorkspaceAudienceMode;

const AUDIENCE_FILTERS: Array<{ key: AudienceFilter; label: string }> = [
  { key: "any", label: "Any audience" },
  { key: "everyone", label: AUDIENCE_MODE_LABEL.everyone },
  { key: "one", label: AUDIENCE_MODE_LABEL.one },
  { key: "selected", label: AUDIENCE_MODE_LABEL.selected },
];

/** A severity's swatch in the picker: status colours, which here MEAN status. */
const SEVERITY_SWATCH: Record<AnnouncementSeverity, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  critical: "bg-destructive",
};

const MODE_ICON: Record<WorkspaceAudienceMode, typeof Globe2> = {
  everyone: Globe2,
  one: Building2,
  selected: Layers,
};

const MODE_BLURB: Record<WorkspaceAudienceMode, string> = {
  one: "A single workspace — a note to one business, or to the prime.",
  everyone: "Every workspace, the prime included, and any provisioned later.",
  selected: "Plans, named workspaces, or both — everyone on Scale plus two more.",
};

/** The modes in the order an operator reaches for them. */
const MODE_ORDER: WorkspaceAudienceMode[] = ["one", "everyone", "selected"];

const when = formatInstant;

/**
 * The zone a `datetime-local` value is read in — the operator's browser's —
 * said in words beside the inputs, so "5:38 pm" is never a guess.
 */
function operatorZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const abbr =
      new Intl.DateTimeFormat("en-AU", { timeZoneName: "short" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    return abbr && abbr !== zone ? `${zone} (${abbr})` : zone;
  } catch {
    return "your browser's time zone";
  }
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : // Fallback for an old browser: v4-shaped from Math.random. Only an
      // idempotency key, never a secret.
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
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
        <span className="text-foreground">Staff only, from Aurixa Systems.</span> A workspace shows
        the message to its Command Centre staff as a banner or a centred popup, as a browser
        notification where they allow it, and keeps it in their Message Hub under “Aurixa Systems”.
        Clients and partners never see it. An announcement cannot be answered; a message sent with
        replies on can be, and each workspace’s answers come back here as its own conversation.
        Mission Control is never a contact in any workspace’s hub.
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
  const { thread: threadParam, workspace: workspaceParam } = Route.useSearch();
  // Arriving from a workspace's page ("Message this workspace") opens a new
  // message already addressed to it.
  const [editing, setEditing] = useState<AnnouncementListRow | null | "new">(() =>
    to ? "new" : null,
  );
  const [presetCloneId, setPresetCloneId] = useState<string | undefined>(to);
  // A reply notification lands on that message's conversations — on arrival,
  // and again when one is clicked while this page is already open (the bell's
  // link changes the search without remounting the page).
  const [conversations, setConversations] = useState<{
    id: string;
    workspaceId?: string;
  } | null>(() => (threadParam ? { id: threadParam, workspaceId: workspaceParam } : null));
  useEffect(() => {
    if (threadParam) setConversations({ id: threadParam, workspaceId: workspaceParam });
  }, [threadParam, workspaceParam]);

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
    if (filter === "replies") all = all.filter((r) => (r.threads?.length ?? 0) > 0);
    else if (filter !== "all") all = all.filter((r) => r.state === filter);
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
  const conversationRow = conversations
    ? (query.data?.rows.find((r) => r.row.id === conversations.id) ?? null)
    : null;
  const closeConversations = () => {
    setConversations(null);
    if (threadParam) void navigate({ to: "/announcements", search: {}, replace: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="fleet comms"
        title="Workspace messages"
        description="Write to one workspace, to every workspace, to the plans and workspaces you choose — the prime included. Send now or schedule it, as an announcement or with replies on. Mission Control decides who sees a message; a workspace only ever renders it, and is told nothing about who else was sent it."
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
            {
              label: "replies waiting",
              value: s.unreadReplies ?? "—",
              tone: "warning",
              alarm: (s.unreadReplies ?? 0) > 0,
              note: s.unreadReplies === null ? "could not read replies" : undefined,
            },
          ]}
        />
      )}

      {query.data?.repliesError && (
        <div
          role="status"
          className="glass-inset flex items-start gap-3 rounded-md px-4 py-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-muted-foreground">
            <span className="text-foreground">Replies could not be read.</span> Messages and
            delivery are shown; conversation counts are unknown, not zero.{" "}
            <span className="font-mono text-[11px]">{query.data.repliesError}</span>
          </p>
        </div>
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
              onConversations={() => setConversations({ id: r.row.id })}
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

      {conversations && query.data && (
        <ConversationsDialog
          key={conversations.id}
          item={conversationRow}
          announcementId={conversations.id}
          focusWorkspaceId={conversations.workspaceId}
          cloneNames={cloneNames}
          canWrite={isAdmin}
          onClose={closeConversations}
          onChanged={refresh}
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
  onConversations,
  onDone,
}: {
  item: AnnouncementListRow;
  canWrite: boolean;
  headline: string;
  onEdit: () => void;
  onConversations: () => void;
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
  const repliesOn = row.replies_enabled === true;
  const threads = item.threads;
  const unread = threads?.reduce((n, t) => n + t.unread, 0) ?? 0;

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      const result = (await fn()) as { ok: boolean; error?: string; signal?: SignalSummary };
      if (!result.ok) toast.error(`${label} failed: ${result.error}`);
      else {
        toast.success(label, { description: signalSentence(result.signal) ?? undefined });
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
              · {row.severity} {row.display === "modal" ? "popup" : row.display}
              {row.revision > 1 ? ` · r${row.revision}` : ""}
            </span>
            <span
              className={cn(
                "font-mono text-[10px] tracking-[0.18em] uppercase whitespace-nowrap",
                repliesOn ? "text-primary" : "text-muted-foreground",
              )}
            >
              · {repliesOn ? "replies on" : "announcement"}
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
                <span
                  className={cn(item.deliveredTo === 0 && "text-warning")}
                  title="A workspace fetches its messages while somebody has its dashboard open, about once a minute."
                >
                  {item.deliveredTo === 0
                    ? "not yet fetched by any workspace"
                    : `fetched by ${item.deliveredTo} of ${item.reaches.length}`}
                </span>
                {item.deliveredTo > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      opened in {item.seenBy} of {item.deliveredTo}
                    </span>
                  </>
                )}
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
          {(repliesOn || (threads?.length ?? 0) > 0) && (
            <Button
              size="sm"
              variant={unread > 0 ? "default" : "outline"}
              onClick={onConversations}
              disabled={busy}
              aria-label={
                threads === null
                  ? "Conversations (replies could not be read)"
                  : `Conversations: ${threads.length}, ${unread} unread`
              }
            >
              <MessagesSquare className="mr-1.5 h-3.5 w-3.5" />
              {threads === null
                ? "Conversations"
                : threads.length === 0
                  ? "No replies yet"
                  : `${threads.length} conversation${threads.length === 1 ? "" : "s"}`}
              {unread > 0 && (
                <span className="ml-1.5 rounded-sm bg-background/20 px-1 font-mono text-[10px]">
                  {unread} new
                </span>
              )}
            </Button>
          )}
          {canWrite && (
            <>
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
            </>
          )}
        </div>
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
 * AND plans with the original AND ("these workspaces, if they are on these
 * plans") is not something the console builds any more — choosing both now
 * reaches either — so such a row is opened as the workspaces it reaches today.
 * Saving then keeps exactly that reach rather than silently widening it.
 */
function initialDraft(
  row: AnnouncementListRow["row"] | null,
  clones: AnnouncementCloneRef[],
  presetCloneId: string | undefined,
): WorkspaceAudienceDraft {
  if (!row) {
    if (presetCloneId && clones.some((c) => c.id === presetCloneId)) {
      return { mode: "one", cloneIds: [presetCloneId], planSlugs: [], match: "all" };
    }
    return { mode: "one", cloneIds: [], planSlugs: [], match: "all" };
  }
  const draft = audienceDraftOf(row);
  if (isNarrowingScope(draft)) {
    const reached = clones
      .filter((c) => announcementReachesClone(row, { id: c.id, planSlug: c.planSlug }))
      .map((c) => c.id);
    return {
      mode: reached.length === 1 ? "one" : "selected",
      cloneIds: reached,
      planSlugs: [],
      match: "all",
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
  const shown = useMemo(
    () =>
      clones.filter((c) => workspaceMatches({ ...c, slug: c.isPrime ? "prime" : c.slug }, query)),
    [clones, query],
  );
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
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
        {c.isPrime && <Crown className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
        <span className="truncate">{c.name}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {c.isPrime ? "prime · no plan" : (c.planSlug ?? "no plan")}
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
          {chosen.length} of {clones.length} chosen by name
        </p>
      )}
    </div>
  );
}

/** Two large choices, side by side — the editor's own vocabulary for an either/or. */
function ChoiceCards<K extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: K;
  onChange: (k: K) => void;
  options: Array<{ key: K; title: string; blurb: string; icon: typeof Globe2 }>;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("grid gap-2", options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}
    >
      {options.map((o) => {
        const on = value === o.key;
        const Icon = o.icon;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.key)}
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
              {o.title}
            </span>
            <span className="text-xs text-muted-foreground">{o.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

type Timing = SendTiming;

const TIMING_OPTIONS: Array<{ key: Timing; title: string; blurb: string; icon: typeof Globe2 }> = [
  {
    key: "now",
    title: "Send now",
    blurb: "Live at once. Open dashboards show it within about a minute.",
    icon: Send,
  },
  {
    key: "schedule",
    title: "Schedule",
    blurb: "Goes live by itself at the time you set.",
    icon: CalendarClock,
  },
  {
    key: "draft",
    title: "Save as draft",
    blurb: "Seen by nobody until it is published from the list.",
    icon: FileText,
  },
];

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
  const send = useServerFn(sendAnnouncementFn);
  const [busy, setBusy] = useState(false);
  // One id per opening of the editor: a double click, or a retry after a
  // timeout, is the SAME act and finds the row the first attempt made.
  const [requestId] = useState(newRequestId);

  const row = item?.row ?? null;
  // Only a draft (or a new message) is sent from here. A message already out
  // is edited with Save, and brought back with Re-raise on the list.
  const isDraft = !row || item?.state === "draft";
  const [timing, setTiming] = useState<Timing>(() =>
    !row ? "now" : row.starts_at && Date.parse(row.starts_at) > Date.now() ? "schedule" : "now",
  );
  const [title, setTitle] = useState(row?.title ?? "");
  const [body, setBody] = useState(row?.body ?? "");
  const [linkUrl, setLinkUrl] = useState(row?.link_url ?? "");
  const [linkLabel, setLinkLabel] = useState(row?.link_label ?? "");
  const [severity, setSeverity] = useState(row?.severity ?? "info");
  const [display, setDisplay] = useState(row?.display ?? "banner");
  const [dismissible, setDismissible] = useState(row?.dismissible ?? true);
  const [repliesEnabled, setRepliesEnabled] = useState(row?.replies_enabled === true);
  const [startsAt, setStartsAt] = useState(toLocalInput(row?.starts_at));
  const [endsAt, setEndsAt] = useState(toLocalInput(row?.ends_at));
  const zone = useMemo(operatorZone, []);

  const initial = useMemo(
    () => initialDraft(row, data.clones, presetCloneId),
    // Computed once for the message being edited; the roster refreshing
    // underneath must not reset an operator's choice mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [mode, setMode] = useState<WorkspaceAudienceMode>(initial.mode);
  const [oneId, setOneId] = useState<string[]>(initial.mode === "one" ? [...initial.cloneIds] : []);
  const [cloneIds, setCloneIds] = useState<string[]>(
    initial.mode === "selected" ? [...initial.cloneIds] : [],
  );
  const [planSlugs, setPlanSlugs] = useState<string[]>([...initial.planSlugs]);

  const draft: WorkspaceAudienceDraft = {
    mode,
    cloneIds: mode === "one" ? oneId : cloneIds,
    planSlugs: mode === "selected" ? planSlugs : [],
    match: "any",
  };
  const scope = audienceScopeOf(draft);

  // The SAME matcher the route serves with, run over the same roster — "who
  // will see this" is a fact, not a second opinion.
  const reach = useMemo(() => {
    if (!scope.ok) return [];
    const stored = {
      audience_plan_slugs: scope.audiencePlanSlugs,
      audience_clone_ids: scope.audienceCloneIds,
      audience_match: scope.audienceMatch,
    };
    return data.clones.filter((c) =>
      announcementReachesClone(stored, { id: c.id, planSlug: c.planSlug }),
    );
    // `scope` is derived from these on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.clones, mode, oneId, cloneIds, planSlugs]);

  const plansWithCounts = useMemo(
    () =>
      data.planOptions.map((p) => ({
        ...p,
        count: data.clones.filter((c) => c.planSlug === p.slug).length,
      })),
    [data.planOptions, data.clones],
  );

  const isoOf = (local: string) => (local ? new Date(local).toISOString() : null);
  const effectiveTiming: Timing = isDraft ? timing : "draft";
  const timingRefusal = sendTimingRefusal(
    effectiveTiming,
    effectiveTiming === "now" ? null : isoOf(startsAt),
    isoOf(endsAt),
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
        repliesEnabled,
        audiencePlanSlugs: scope.audiencePlanSlugs,
        audienceCloneIds: scope.audienceCloneIds,
        audienceMatch: scope.audienceMatch,
        startsAt: effectiveTiming === "now" ? null : isoOf(startsAt),
        endsAt: isoOf(endsAt),
        clientRequestId: requestId,
      };
      let result: { ok: boolean; error?: string; repeated?: boolean; signal?: SignalSummary };
      if (isDraft && effectiveTiming !== "draft") {
        result = (await send({
          data: { ...payload, id: row?.id ?? null, timing: effectiveTiming },
        })) as typeof result;
      } else if (row) {
        result = (await update({ data: { ...payload, id: row.id } })) as typeof result;
      } else {
        result = (await create({ data: payload })) as typeof result;
      }
      if (!result.ok) {
        toast.error(
          result.error === "already_published"
            ? "This message is already out — save your changes instead."
            : `Save failed: ${result.error}`,
        );
      } else {
        toast.success(
          result.repeated
            ? "Already sent — nothing was sent twice."
            : effectiveTiming === "now" && isDraft
              ? `Sent to ${reach.length} workspace${reach.length === 1 ? "" : "s"}`
              : effectiveTiming === "schedule" && isDraft
                ? `Scheduled for ${when(isoOf(startsAt))}`
                : row
                  ? "Message updated"
                  : "Draft saved — nobody sees it until it is published",
          { description: signalSentence(result.signal) ?? undefined },
        );
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
  const blocker = !scope.ok ? scope.reason : (missing ?? timingRefusal);

  const actionLabel = !isDraft
    ? "Save changes"
    : timing === "now"
      ? "Send now"
      : timing === "schedule"
        ? "Schedule"
        : "Save draft";
  const ActionIcon = !isDraft
    ? Pencil
    : timing === "now"
      ? Send
      : timing === "schedule"
        ? CalendarClock
        : FileText;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {row ? (isDraft ? "Edit draft" : "Edit message") : "New message"}
          </DialogTitle>
          <DialogDescription>
            {!isDraft
              ? "Edits reach workspaces on their next poll, about a minute. Dismissed banners stay dismissed — use Re-raise on the list when everyone should see it again."
              : "Choose who it is for, what it says, and when it goes out. Send now and Schedule publish it in the same step."}
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
              <div className="space-y-3">
                <div className="space-y-1 rounded-md border border-border/60 p-2">
                  <p className="label-mono px-2 pb-1 text-muted-foreground">By subscription plan</p>
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
                <div className="space-y-1">
                  <p className="label-mono text-muted-foreground">
                    {planSlugs.length > 0 ? "Plus these workspaces by name" : "By workspace"}
                  </p>
                  <WorkspaceList
                    clones={data.clones}
                    chosen={cloneIds}
                    onChange={setCloneIds}
                    single={false}
                  />
                </div>
              </div>
            )}

            <div
              className="glass-inset rounded-md px-3 py-2 font-mono text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              {!scope.ok
                ? scope.reason
                : mode === "everyone"
                  ? `Every workspace — ${reach.length} today, the prime included, and any provisioned later.`
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

            <div className="space-y-2">
              <Label>Can they reply?</Label>
              <ChoiceCards<"off" | "on">
                label="Replies"
                value={repliesEnabled ? "on" : "off"}
                onChange={(k) => setRepliesEnabled(k === "on")}
                options={[
                  {
                    key: "off",
                    title: "Announcement only",
                    blurb: "One-way. Workspaces read it; there is nothing to answer.",
                    icon: Megaphone,
                  },
                  {
                    key: "on",
                    title: "Replies enabled",
                    blurb:
                      "Staff can reply. Each workspace's answers come back here as its own conversation.",
                    icon: MessageSquareReply,
                  },
                ]}
              />
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="label-mono mb-2 text-muted-foreground">3 · How it shows</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Severity</Label>
                <Select value={severity} onValueChange={setSeverity}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ANNOUNCEMENT_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        <span className="flex items-center gap-2">
                          <span aria-hidden className={cn("h-2.5 w-2.5 shrink-0", SEVERITY_SWATCH[s])} />
                          {SEVERITY_IN_WORKSPACE[s].option}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {severity in SEVERITY_IN_WORKSPACE && (
                  <p className="text-xs text-muted-foreground">
                    Workspaces see it as “{SEVERITY_IN_WORKSPACE[severity as AnnouncementSeverity].word}”, in{" "}
                    {SEVERITY_IN_WORKSPACE[severity as AnnouncementSeverity].colour}.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Display</Label>
                <Select value={display} onValueChange={setDisplay}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="banner">Banner across the dashboard</SelectItem>
                    <SelectItem value="modal">Centred popup</SelectItem>
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
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="label-mono mb-2 text-muted-foreground">4 · When it goes out</legend>
            {isDraft && (
              <ChoiceCards<Timing>
                label="When it goes out"
                value={timing}
                onChange={setTiming}
                options={TIMING_OPTIONS}
              />
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {(!isDraft || timing !== "now") && (
                <div className="space-y-2">
                  <Label htmlFor="ann-starts">
                    {isDraft && timing === "schedule" ? "Goes live at" : "Starts (optional)"}
                  </Label>
                  <Input
                    id="ann-starts"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </div>
              )}
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
            <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" aria-hidden />
              Times are in {zone}.
            </p>
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
              <ActionIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {busy ? "Working…" : actionLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The conversations on one message: one thread per workspace that answered,
 * the workspace's words with who wrote them, and the operator's answers —
 * which the workspace reads signed "Aurixa Systems". Opening a thread marks
 * what the workspace wrote as read.
 */
function ConversationsDialog({
  item,
  announcementId,
  focusWorkspaceId,
  cloneNames,
  canWrite,
  onClose,
  onChanged,
}: {
  item: AnnouncementListRow | null;
  announcementId: string;
  focusWorkspaceId?: string;
  cloneNames: Record<string, string>;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const listReplies = useServerFn(listAnnouncementRepliesFn);
  const reply = useServerFn(replyToWorkspaceFn);
  const markRead = useServerFn(markThreadReadFn);
  const query = useQuery({
    queryKey: ["clone-announcement-replies", announcementId],
    queryFn: () => listReplies({ data: { id: announcementId } }),
    refetchInterval: 30_000,
  });
  const threads: ThreadView[] = query.data?.threads ?? [];
  const reachable = item?.reaches ?? [];
  const [active, setActive] = useState<string | null>(focusWorkspaceId ?? null);
  // A notification naming another workspace while this is open moves to it.
  useEffect(() => {
    if (focusWorkspaceId) setActive(focusWorkspaceId);
  }, [focusWorkspaceId]);
  const shownId = active ?? threads[0]?.workspaceId ?? null;
  const thread = threads.find((t) => t.workspaceId === shownId) ?? null;
  // One reply box PER WORKSPACE, each with its own request id. A shared box
  // let words typed for one business be sent to another after a switch.
  const [drafts, setDrafts] = useState<Record<string, { body: string; requestId: string }>>({});
  const draft = shownId ? (drafts[shownId]?.body ?? "") : "";
  const setDraft = (body: string) => {
    if (!shownId) return;
    setDrafts((prev) => ({
      ...prev,
      [shownId]: { body, requestId: prev[shownId]?.requestId ?? newRequestId() },
    }));
  };
  const [sending, setSending] = useState(false);
  // No switching threads while a reply is in flight: its completion clears
  // the box it was sent from, and only that one.
  const choose = (workspaceId: string) => {
    if (!sending) setActive(workspaceId);
  };
  const endRef = useRef<HTMLDivElement | null>(null);

  const nameOf = (id: string) => cloneNames[id] ?? `${id.slice(0, 8)}…`;
  const unreadIn = (t: ThreadView) => t.messages.filter((m) => m.unread).length;

  // Reading a thread marks what the workspace wrote in it as read.
  const unreadShown = thread ? unreadIn(thread) : 0;
  useEffect(() => {
    if (!shownId || unreadShown === 0) return;
    void markRead({ data: { id: announcementId, workspaceId: shownId } })
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["clone-announcement-replies", announcementId] });
        onChanged();
      })
      .catch(() => {
        /* the count stays; the next open marks it */
      });
    // onChanged is a fresh closure each render; the act keys on the thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcementId, shownId, unreadShown]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [shownId, thread?.messages.length]);

  const canAnswer = canWrite && item?.state === "active" && item.row.replies_enabled === true;
  const startable = reachable.filter((r) => !threads.some((t) => t.workspaceId === r.id));

  async function sendReply() {
    // Captured once: the workspace, words and request id of THIS send.
    const to = shownId;
    const entry = to ? drafts[to] : undefined;
    if (!to || !entry || entry.body.trim().length === 0 || sending) return;
    setSending(true);
    try {
      const result = (await reply({
        data: {
          id: announcementId,
          workspaceId: to,
          body: entry.body,
          clientRequestId: entry.requestId,
        },
      })) as { ok: boolean; error?: string; signal?: SignalSummary };
      if (!result.ok) {
        toast.error(result.error ?? "The reply was not sent");
        return;
      }
      toast.success(`Sent to ${nameOf(to)} as Aurixa Systems`, {
        description: signalSentence(result.signal) ?? undefined,
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[to];
        return next;
      });
      await qc.invalidateQueries({ queryKey: ["clone-announcement-replies", announcementId] });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The reply was not sent");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-primary" aria-hidden />
            Conversations
          </DialogTitle>
          <DialogDescription>
            {item ? `“${item.row.title}”. ` : ""}Each workspace sees only its own conversation, and
            reads your answers signed “Aurixa Systems”.
          </DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <CardRowSkeleton />
        ) : query.isError ? (
          <EmptyState
            icon={<AlertTriangle />}
            title="Could not read the replies"
            description={query.error instanceof Error ? query.error.message : "Unknown error"}
          />
        ) : threads.length === 0 && !(canAnswer && startable.length > 0) ? (
          <EmptyState
            icon={<MessagesSquare />}
            title="No replies yet"
            description={
              item?.row.replies_enabled
                ? "When a workspace's staff answer this message, the conversation appears here."
                : "This message was sent as an announcement, so it cannot be answered."
            }
          />
        ) : (
          <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[14rem_1fr]">
            <nav aria-label="Workspaces" className="min-h-0 space-y-1 overflow-y-auto">
              {threads.map((t) => {
                const n = unreadIn(t);
                const on = t.workspaceId === shownId;
                return (
                  <button
                    key={t.workspaceId}
                    type="button"
                    aria-current={on ? "true" : undefined}
                    onClick={() => choose(t.workspaceId)}
                    disabled={sending}
                    className={cn(
                      "glass-inset flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm",
                      on ? "border-primary/60" : "border-transparent hover:border-border",
                    )}
                  >
                    <span className="min-w-0 truncate">{nameOf(t.workspaceId)}</span>
                    {n > 0 ? (
                      <span className="shrink-0 rounded-sm bg-primary px-1.5 font-mono text-[10px] text-primary-foreground">
                        {n} new
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {t.messages.length}
                      </span>
                    )}
                  </button>
                );
              })}
              {canAnswer && startable.length > 0 && (
                <div className="pt-2">
                  <Label className="label-mono text-muted-foreground">Write to a workspace</Label>
                  <Select value="" onValueChange={choose} disabled={sending}>
                    <SelectTrigger className="mt-1 h-8">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      {startable.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </nav>

            <section
              aria-label={shownId ? `Conversation with ${nameOf(shownId)}` : "Conversation"}
              className="flex min-h-[18rem] min-w-0 flex-col rounded-md border border-border/60"
            >
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {!thread || thread.messages.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {shownId
                      ? `Nothing yet with ${nameOf(shownId)}. What you write appears in their Message Hub, signed Aurixa Systems.`
                      : "Choose a workspace."}
                  </p>
                ) : (
                  thread.messages.map((m) => {
                    const mine = m.direction === "operator";
                    return (
                      <div
                        key={m.id}
                        className={cn("flex", mine ? "justify-end" : "justify-start")}
                      >
                        <div
                          className={cn(
                            "max-w-[85%] rounded-md border px-3 py-2 text-sm",
                            mine
                              ? "border-primary/40 bg-primary/10"
                              : "glass-inset border-border/60",
                          )}
                        >
                          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                            {mine
                              ? `Aurixa Systems · ${m.authorName}`
                              : [m.authorName, m.authorRole].filter(Boolean).join(" · ")}
                            {m.unread && <span className="ml-1.5 text-primary">new</span>}
                          </p>
                          <p className="mt-1 whitespace-pre-line break-words">{m.body}</p>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                            {when(m.createdAt)}
                            {!mine && m.authorEmail ? ` · ${m.authorEmail}` : ""}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={endRef} />
              </div>

              {shownId && (
                <div className="border-t border-border/60 p-2">
                  {canAnswer ? (
                    <form
                      className="flex items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void sendReply();
                      }}
                    >
                      <Textarea
                        value={draft}
                        maxLength={2000}
                        rows={2}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void sendReply();
                          }
                        }}
                        placeholder={`Reply to ${nameOf(shownId)} as Aurixa Systems`}
                        aria-label={`Reply to ${nameOf(shownId)}`}
                        className="min-h-[2.5rem] flex-1"
                      />
                      <Button type="submit" disabled={sending || draft.trim().length === 0}>
                        <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        {sending ? "Sending…" : "Send"}
                      </Button>
                    </form>
                  ) : (
                    <p className="px-1 py-1 text-xs text-muted-foreground">
                      {!canWrite
                        ? "Only an administrator can answer."
                        : "This message is not live, so the workspace would not see an answer."}
                    </p>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
