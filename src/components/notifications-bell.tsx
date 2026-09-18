import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bell,
  CheckCheck,
  CircleDot,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Inbox,
  GitFork,
  Trash2,
  Boxes,
  Settings,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { RECORD_KINDS_FILTER, isInboxKind } from "@/lib/notificationDisposition";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import type { Database } from "@/integrations/supabase/types";

export type Notification = Database["public"]["Tables"]["notifications"]["Row"];
type Kind = Database["public"]["Enums"]["notification_kind"];
type Severity = Database["public"]["Enums"]["notification_severity"];

const FEED_LIMIT = 20;

function iconFor(kind: Kind) {
  switch (kind) {
    case "cascade_completed":
      return CheckCircle2;
    case "cascade_failed":
      return XCircle;
    case "cascade_partial":
      return AlertTriangle;
    case "cascade_started":
      return CircleDot;
    case "drift_high":
    case "drift_medium":
      return AlertTriangle;
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

export function NotificationsBell() {
  const { session } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!session) return;

    const load = async () => {
      /*
        THE BELL IS THE INBOX, NOT THE RECORD.

        It used to load every kind and count the unread among them, so the
        badge read 2,459 on 18 Sep 2026 — 79% of it successes and the normal
        operating state of a working pipeline. A badge that is always large is
        a badge nobody reads, and `cascade_blocked` arrives in the same place.

        Nothing stopped being WRITTEN: `CloneActivityHistory` reads the same
        table as a clone's activity feed, and the notifications page can still
        show everything. The filter is here, at the reader, which is also why
        the 983 already-unread records stop being counted without a single row
        being stamped or deleted.
      */
      const { data } = await supabase
        .from("notifications")
        .select("*")
        .not("kind", "in", RECORD_KINDS_FILTER)
        .order("created_at", { ascending: false })
        .limit(FEED_LIMIT);
      setItems(data ?? []);
    };
    void load();

    const channel = supabase
      .channel(`notif:bell:${session.user.id}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications" },
        (payload) => {
          const n = payload.new as Notification;
          // The same rule as the query above. A live insert that bypassed it
          // would put a record in the inbox until the next reload, which is
          // the kind of drift that makes a filter untrustworthy.
          if (!isInboxKind(n.kind)) return;
          setItems((prev) => [n, ...prev].slice(0, FEED_LIMIT));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "notifications" },
        (payload) => {
          const n = payload.new as Notification;
          setItems((prev) => prev.map((x) => (x.id === n.id ? n : x)));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session]);

  const unread = items.filter((n) => !n.read_at).length;

  const markAllRead = async () => {
    const ids = items.filter((n) => !n.read_at).map((n) => n.id);
    if (ids.length === 0) return;
    setItems((prev) =>
      prev.map((n) => (ids.includes(n.id) ? { ...n, read_at: new Date().toISOString() } : n)),
    );
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", ids);
  };

  const markOneRead = async (id: string) => {
    if (items.find((n) => n.id === id)?.read_at) return;
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
  };

  if (!session) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 text-muted-foreground hover:text-foreground"
          aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 font-mono text-[9px] font-semibold leading-none text-destructive-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Notifications
            </span>
            {unread > 0 && (
              <Badge variant="outline" className="border-primary/40 text-primary">
                {unread} new
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={unread === 0}
              onClick={markAllRead}
              className="h-7 text-xs"
            >
              <CheckCheck className="mr-1 h-3 w-3" /> Mark all read
            </Button>
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Notification settings"
            >
              <Link
                to="/settings/notifications"
                onClick={() => setOpen(false)}
                aria-label="Notification settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>
        <ScrollArea className="h-[420px]">
          {items.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <Inbox className="mx-auto mb-2 h-6 w-6 opacity-50" />
              No notifications yet
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((n) => {
                const Icon = iconFor(n.kind);
                const unreadItem = !n.read_at;
                const inner = (
                  <div
                    className={cn(
                      "flex gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40",
                      unreadItem && "bg-primary/[0.04]",
                    )}
                  >
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone(n.severity))} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {n.title}
                        </span>
                        {unreadItem && (
                          <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        )}
                      </div>
                      {n.body && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {n.body}
                        </p>
                      )}
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {formatDistanceToNow(n.created_at)}
                      </p>
                    </div>
                  </div>
                );

                const handleClick = () => {
                  void markOneRead(n.id);
                  setOpen(false);
                };

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
        </ScrollArea>
        <div className="border-t border-border px-3 py-2">
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
