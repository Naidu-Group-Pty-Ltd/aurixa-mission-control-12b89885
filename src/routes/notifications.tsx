import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { ProtectedRoute } from "@/components/protected-route";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Bell,
  BellOff,
  BellRing,
  Filter,
  RefreshCw,
  X,
  CheckCheck,
  Inbox,
  CircleDot,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  GitFork,
  Trash2,
  Boxes,
  ChevronLeft,
  ChevronRight,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { toast } from "sonner";
import { useBrowserPushSettings } from "@/lib/browser-notifications";
import { useNotificationPreferences } from "@/lib/notification-preferences";
import { NotificationListSkeleton } from "@/components/list-skeletons";
import { EmptyState } from "@/components/empty-state";
import {
  INBOX_SCOPE_LABEL,
  INBOX_SCOPE_NOTE,
  RECORD_KINDS_FILTER,
  RECORD_SCOPE_LABEL,
} from "@/lib/notificationDisposition";
import {
  NOTIFICATION_KIND_FILTER_OPTIONS,
  NOTIFICATION_KIND_FILTER_VALUES,
} from "@/lib/notificationKinds.pure";
import {
  BULK_READ_EXEMPT_NOTE,
  describeLeftUnread,
  mayBulkMarkRead,
} from "@/lib/notificationBulkRead.pure";
import { useServerFn } from "@tanstack/react-start";
import {
  bulkMarkNotificationsRead,
  markAllMatchingNotificationsRead,
} from "@/server/bulk-ops.functions";
import { Settings as SettingsIcon, BellMinus } from "lucide-react";

type Notification = Database["public"]["Tables"]["notifications"]["Row"];
type Clone = Pick<Database["public"]["Tables"]["clones"]["Row"], "id" | "name">;
type Kind = Database["public"]["Enums"]["notification_kind"];
type Severity = Database["public"]["Enums"]["notification_severity"];

const PAGE_SIZE = 25;

const SEVERITY_VALUES = ["info", "success", "warning", "error"] as const;
const READ_VALUES = ["all", "unread", "read"] as const;

/*
  THE INBOX AND THE RECORD ARE THE SAME TABLE, READ TWO WAYS.

  A notification is for something that needs a person; if it needs nobody it is
  a record. Measured 18 Sep 2026, 79% of 2,459 unread rows were successes or
  the normal operating state of a working pipeline, which is how the channel
  that also carries `cascade_blocked` came to be one nobody reads.

  Nothing stopped being written — `CloneActivityHistory` reads this table as a
  clone's activity feed — so the split is here, and `Everything` is one click
  away rather than gone.
*/
const SCOPE_VALUES = ["attention", "everything"] as const;

// The kind filter is every kind the database declares, from
// `notificationKinds.pure.ts`. It was a hand list here, 22 kinds long, and
// `cascade_blocked` was not on it.

const SEVERITY_OPTIONS: { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "All severities" },
  { value: "info", label: "Info" },
  { value: "success", label: "Success" },
  { value: "warning", label: "Warning" },
  { value: "error", label: "Error" },
];

const READ_OPTIONS: { value: (typeof READ_VALUES)[number]; label: string }[] = [
  { value: "all", label: "Read & unread" },
  { value: "unread", label: "Unread only" },
  { value: "read", label: "Read only" },
];

const searchSchema = z.object({
  kind: fallback(z.enum(NOTIFICATION_KIND_FILTER_VALUES), "all").default("all"),
  severity: fallback(z.enum(["all", ...SEVERITY_VALUES]), "all").default("all"),
  clone: fallback(z.string(), "all").default("all"),
  read: fallback(z.enum(READ_VALUES), "all").default("all"),
  scope: fallback(z.enum(SCOPE_VALUES), "attention").default("attention"),
  page: fallback(z.number().int().min(0).max(10_000), 0).default(0),
});

export const Route = createFileRoute("/notifications")({
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <NotificationsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Notifications — Aurixa Systems Mission Control" }] }),
});

function iconFor(kind: Kind) {
  switch (kind) {
    case "cascade_completed":
      return CheckCircle2;
    case "cascade_failed":
      return XCircle;
    case "cascade_partial":
    case "drift_high":
    case "drift_medium":
      return AlertTriangle;
    case "cascade_started":
      return CircleDot;
    case "clone_created":
      return GitFork;
    case "clone_deleted":
      return Trash2;
    case "module_installed":
    case "module_removed":
      return Boxes;
    case "lead_captured":
      return UserPlus;
    default:
      return CircleDot;
  }
}

function tone(severity: Severity) {
  switch (severity) {
    case "success":
      return "text-success";
    case "error":
      return "text-destructive";
    case "warning":
      return "text-warning";
    default:
      return "text-info";
  }
}

function NotificationsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/notifications" });
  const push = useBrowserPushSettings();
  const { prefs } = useNotificationPreferences();

  const confirm = useConfirm();
  const [items, setItems] = useState<Notification[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [clones, setClones] = useState<Clone[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  type SearchState = typeof search;

  const setSearch = useCallback(
    (patch: Partial<SearchState>) => {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, ...patch }),
        replace: true,
      });
    },
    [navigate],
  );

  // When filter inputs change, drop back to page 0 automatically.
  const updateFilter = useCallback(
    (patch: Partial<SearchState>) => {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, ...patch, page: 0 }),
        replace: true,
      });
    },
    [navigate],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const from = search.page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    let q = supabase
      .from("notifications")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    // A kind chosen explicitly always wins: an operator who picked "Cascade
    // completed" has asked for records, and handing them an empty list because
    // of a default scope would read as a broken page.
    if (search.kind !== "all") q = q.eq("kind", search.kind);
    else if (search.scope === "attention") q = q.not("kind", "in", RECORD_KINDS_FILTER);
    if (search.severity !== "all") q = q.eq("severity", search.severity);
    if (search.clone !== "all") q = q.eq("clone_id", search.clone);
    if (search.read === "unread") q = q.is("read_at", null);
    if (search.read === "read") q = q.not("read_at", "is", null);
    const { data, count } = await q;
    setItems(data ?? []);
    setTotal(count ?? 0);
    setLoading(false);
  }, [search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Load clones for the filter dropdown
  useEffect(() => {
    void supabase
      .from("clones")
      .select("id, name")
      .order("name", { ascending: true })
      .then(({ data }) => setClones(data ?? []));
  }, []);

  // Live updates
  useEffect(() => {
    const channel = supabase
      .channel(`notif:page:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => {
        void refresh();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const unreadOnPage = useMemo(() => items.filter((n) => !n.read_at), [items]);
  // What "Mark page read" may change: everything unread here except a
  // blocked-cascade notice, which stands until its pull request closes.
  const bulkReadableOnPage = useMemo(
    () => unreadOnPage.filter((n) => mayBulkMarkRead(n.kind)),
    [unreadOnPage],
  );
  const blockedUnreadOnPage = unreadOnPage.length - bulkReadableOnPage.length;
  // A kind chosen in the filter that no bulk mark may change.
  const kindIsExempt = search.kind !== "all" && !mayBulkMarkRead(search.kind);
  const markReadFn = useServerFn(bulkMarkNotificationsRead);
  const markMatchingFn = useServerFn(markAllMatchingNotificationsRead);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  /*
    SCOPE IS A FILTER, AND THE DEFAULT ONE IS NARROWING.

    `attention` hides the record — 983 of 2,459 unread rows on 18 Sep 2026 —
    so a confirmation reading "no filters, this will affect every unread
    notification" would be a false promise on the one control that writes in
    bulk. It counts as a filter unless the operator has asked for everything.
  */
  const hasFilters =
    search.kind !== "all" ||
    search.severity !== "all" ||
    search.clone !== "all" ||
    search.read !== "all" ||
    search.scope !== "everything";

  const markAllOnPageRead = async () => {
    const ids = bulkReadableOnPage.map((n) => n.id);
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (ids.includes(n.id) ? { ...n, read_at: now } : n)));
    // Through the server, which leaves blocked-cascade notices alone even if
    // an id for one arrives here.
    try {
      const r = await markReadFn({ data: { ids, read: true } });
      if (!r.ok) throw new Error(r.error);
      if (blockedUnreadOnPage > 0) toast.info(describeLeftUnread(blockedUnreadOnPage));
    } catch (err) {
      toast.error("Failed to mark the page read", {
        description: err instanceof Error ? err.message : String(err),
      });
      // The optimistic stamp above is not what the database holds.
      await refresh();
    }
  };

  const markOneRead = async (id: string) => {
    if (items.find((n) => n.id === id)?.read_at) return;
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: now } : n)));
    await supabase.from("notifications").update({ read_at: now }).eq("id", id);
  };

  const markAllMatching = async () => {
    setBulkBusy(true);
    try {
      // `read === "read"` would zero out the work, so just guard:
      if (search.read === "read") {
        toast.info("No unread entries match these filters.");
        return;
      }
      // The server builds the write from the same filters the page is SHOWING
      // (`planMarkMatching`): a bulk mark that reached rows the operator cannot
      // see would silently clear the record behind their back, and the
      // confirmation promises "matching the current filters". It also leaves
      // every blocked-cascade notice unread, and says how many it left.
      const r = await markMatchingFn({
        data: {
          kind: search.kind,
          severity: search.severity,
          clone: search.clone,
          scope: search.scope,
        },
      });
      if (!r.ok) throw new Error(r.error);
      toast.success(
        `Marked ${r.count} notification${r.count === 1 ? "" : "s"} as read`,
        r.leftUnread ? { description: describeLeftUnread(r.leftUnread) } : undefined,
      );
      await refresh();
    } catch (err) {
      toast.error("Failed to mark all as read", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBulkBusy(false);
      setConfirmOpen(false);
    }
  };

  const clearFilters = () =>
    navigate({
      search: () => ({
        kind: "all",
        severity: "all",
        clone: "all",
        read: "all",
        page: 0,
      }),
      replace: true,
    });

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
            <Bell className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="label-mono">inbox</p>
            <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">Notifications</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Full history of cascade outcomes, drift findings, and fleet activity.
            </p>
            <MuteSummaryChip
              kinds={prefs.muted_kinds.length}
              severities={prefs.muted_severities.length}
              toasts={prefs.mute_toasts}
              push={prefs.mute_browser_push}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PushControl push={push} />
          <Button
            variant="outline"
            size="sm"
            onClick={markAllOnPageRead}
            disabled={bulkReadableOnPage.length === 0}
            title={blockedUnreadOnPage > 0 ? BULK_READ_EXEMPT_NOTE : undefined}
          >
            <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
            Mark page read
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (
                !(await confirm({
                  title: "Delete old read notifications?",
                  description: "Removes all read notifications older than 30 days.",
                  confirmText: "Delete",
                  destructive: true,
                }))
              )
                return;
              const { purgeReadNotifications } = await import("@/server/bulk-ops.functions");
              const r = await purgeReadNotifications({ data: { olderThanDays: 30 } });
              if (r.ok) {
                toast.success(`Purged ${r.deleted} read notifications`);
                refresh();
              } else toast.error(r.error);
            }}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Purge old read
          </Button>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button
                variant="default"
                size="sm"
                disabled={search.read === "read" || kindIsExempt}
                title={kindIsExempt ? BULK_READ_EXEMPT_NOTE : undefined}
              >
                <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
                Mark all matching
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Mark all matching as read?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every unread notification matching the current filters will be marked as read
                  across all pages. {BULK_READ_EXEMPT_NOTE}
                  {hasFilters ? (
                    <span className="mt-2 block font-mono text-[11px] text-muted-foreground">
                      filters: {filterSummary(search)}
                    </span>
                  ) : (
                    <span className="mt-2 block font-mono text-[11px] text-warning">
                      no filters — this will affect every unread notification.
                    </span>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={bulkBusy}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={markAllMatching} disabled={bulkBusy}>
                  {bulkBusy ? "Working…" : "Mark all as read"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
          <Select
            value={search.scope}
            onValueChange={(v) => updateFilter({ scope: v as typeof search.scope })}
          >
            <SelectTrigger aria-label="Scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="attention">{INBOX_SCOPE_LABEL}</SelectItem>
              <SelectItem value="everything">{RECORD_SCOPE_LABEL}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={search.kind}
            onValueChange={(v) => updateFilter({ kind: v as typeof search.kind })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_KIND_FILTER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.severity}
            onValueChange={(v) => updateFilter({ severity: v as typeof search.severity })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={search.clone} onValueChange={(v) => updateFilter({ clone: v })}>
            <SelectTrigger>
              <SelectValue placeholder="All clones" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clones</SelectItem>
              {clones.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Select
              value={search.read}
              onValueChange={(v) => updateFilter({ read: v as typeof search.read })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {READ_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={clearFilters}
                title="Clear filters"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {search.scope === "attention" && search.kind === "all" && (
            <p className="text-xs text-muted-foreground md:col-span-3 lg:col-span-5">
              {INBOX_SCOPE_NOTE}
            </p>
          )}
          {kindIsExempt && (
            <p className="text-xs text-muted-foreground md:col-span-3 lg:col-span-5">
              {BULK_READ_EXEMPT_NOTE}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardDescription className="font-mono text-[11px] uppercase tracking-wider">
            {total.toLocaleString()} {total === 1 ? "entry" : "entries"}
            {total > 0 && (
              <span className="ml-2 text-muted-foreground/70">
                · page {search.page + 1} of {totalPages}
              </span>
            )}
          </CardDescription>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setSearch({ page: Math.max(0, search.page - 1) })}
              disabled={search.page === 0 || loading}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setSearch({ page: search.page + 1 })}
              disabled={search.page + 1 >= totalPages || loading}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <NotificationListSkeleton count={8} />
          ) : items.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Inbox />}
                title="No notifications"
                description={
                  hasFilters
                    ? "Nothing matches these filters. Try clearing them to see your full inbox."
                    : "You're all caught up. New cascade outcomes and drift findings will land here."
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((n) => {
                const Icon = iconFor(n.kind);
                const unread = !n.read_at;
                const inner = (
                  <div
                    className={cn(
                      "flex gap-3 px-4 py-3 transition-colors hover:bg-muted/40",
                      unread && "bg-primary/[0.04]",
                    )}
                  >
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone(n.severity))} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{n.title}</span>
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {n.kind.replace(/_/g, " ")}
                        </Badge>
                        {unread && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                      </div>
                      {n.body && <p className="mt-1 text-xs text-muted-foreground">{n.body}</p>}
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {formatDistanceToNow(n.created_at)}
                      </p>
                    </div>
                  </div>
                );

                const handleClick = () => void markOneRead(n.id);

                if (n.url) {
                  return (
                    <li key={n.id}>
                      <Link to={n.url} onClick={handleClick} className="block">
                        {inner}
                      </Link>
                    </li>
                  );
                }
                return (
                  <li key={n.id}>
                    <button type="button" onClick={handleClick} className="block w-full text-left">
                      {inner}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PushControl({ push }: { push: ReturnType<typeof useBrowserPushSettings> }) {
  if (!push.supported) {
    return (
      <Badge variant="outline" className="gap-1 text-[10px] uppercase">
        <BellOff className="h-3 w-3" /> Push unsupported
      </Badge>
    );
  }
  if (push.permission === "denied") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-destructive/40 text-destructive text-[10px] uppercase"
      >
        <BellOff className="h-3 w-3" /> Push blocked
      </Badge>
    );
  }
  if (push.enabled && push.permission === "granted") {
    return (
      <Button variant="outline" size="sm" onClick={push.disable}>
        <BellRing className="mr-1.5 h-3.5 w-3.5 text-success" /> Push on
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={() => void push.request()}>
      <Bell className="mr-1.5 h-3.5 w-3.5" /> Enable browser push
    </Button>
  );
}

function filterSummary(s: {
  kind: string;
  severity: string;
  clone: string;
  read: string;
  scope: string;
}): string {
  const parts: string[] = [];
  // Named first, because it is the one the operator did not choose.
  if (s.scope !== "everything") parts.push(`scope=${s.scope}`);
  if (s.kind !== "all") parts.push(`kind=${s.kind}`);
  if (s.severity !== "all") parts.push(`severity=${s.severity}`);
  if (s.clone !== "all") parts.push("clone=specific");
  if (s.read !== "all") parts.push(`read=${s.read}`);
  return parts.length === 0 ? "(none)" : parts.join(" · ");
}

function MuteSummaryChip({
  kinds,
  severities,
  toasts,
  push,
}: {
  kinds: number;
  severities: number;
  toasts: boolean;
  push: boolean;
}) {
  const total = kinds + severities + (toasts ? 1 : 0) + (push ? 1 : 0);
  if (total === 0) return null;
  const parts: string[] = [];
  if (kinds > 0) parts.push(`${kinds} kind${kinds === 1 ? "" : "s"}`);
  if (severities > 0) parts.push(`${severities} severit${severities === 1 ? "y" : "ies"}`);
  if (toasts) parts.push("toasts");
  if (push) parts.push("push");
  return (
    <Link
      to="/settings/notifications"
      className="mt-2 inline-flex items-center gap-1.5 border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-warning transition-colors hover:bg-warning/20"
      title="Manage notification preferences"
    >
      <BellMinus className="h-3 w-3" />
      muted: {parts.join(" · ")}
      <SettingsIcon className="h-3 w-3 opacity-60" />
    </Link>
  );
}
