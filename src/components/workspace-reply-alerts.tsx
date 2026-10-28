import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { BellRing, Crown, MessagesSquare, Server, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useBrowserPushSettings } from "@/lib/browser-notifications";
import { getMutedSnapshot, isMuted } from "@/lib/notification-preferences";
import {
  WORKSPACE_REPLY_KIND,
  workspaceReplyAlertOf,
  type WorkspaceReplyAlert,
} from "@/lib/workspaceReplyAlert.pure";
import { cn } from "@/lib/utils";
import type { Database } from "@/integrations/supabase/types";

type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

/** Shown at once; anything beyond waits in the bell. */
const MAX_VISIBLE = 3;

/**
 * A pop-up, bottom right, the moment a workspace answers a message — naming
 * the business and the workspace it came from, who wrote, and what.
 *
 * Driven by the same `notifications` insert the bell already hears live, so a
 * reply needs nothing new on the server to be announced, and what it says is
 * `workspaceReplyAlertOf` — the projection a phone notification will draw.
 * The operating-system notification for the same row is
 * `BrowserPushNotifications`' (opt-in, only while the tab is behind); this is
 * the one inside the console, and it stays until it is opened or dismissed,
 * because a customer's answer is not something to miss by looking away.
 *
 * Respects the operator's mutes, like the browser notification does.
 */
export function WorkspaceReplyAlerts() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const [alerts, setAlerts] = useState<WorkspaceReplyAlert[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const push = useBrowserPushSettings();

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel(`notif:workspace-replies:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `kind=eq.${WORKSPACE_REPLY_KIND}`,
        },
        (payload) => {
          const row = payload.new as NotificationRow;
          if (seen.current.has(row.id)) return;
          seen.current.add(row.id);
          // The console's counts move with the pop-up, not on its next poll.
          void qc.invalidateQueries({ queryKey: ["clone-announcements"] });
          const meta = (row.metadata ?? {}) as { announcement_id?: unknown };
          if (typeof meta.announcement_id === "string") {
            void qc.invalidateQueries({
              queryKey: ["clone-announcement-replies", meta.announcement_id],
            });
          }
          if (isMuted(getMutedSnapshot(), row.kind, row.severity)) return;
          const alert = workspaceReplyAlertOf(row);
          if (!alert) return;
          setAlerts((prev) => [alert, ...prev.filter((a) => a.id !== alert.id)]);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, qc]);

  if (!session || alerts.length === 0) return null;

  const dismiss = (id: string) => setAlerts((prev) => prev.filter((a) => a.id !== id));
  return (
    <WorkspaceReplyAlertStack
      alerts={alerts}
      onDismiss={dismiss}
      onOpen={(id) => {
        dismiss(id);
        void supabase
          .from("notifications")
          .update({ read_at: new Date().toISOString() })
          .eq("id", id);
      }}
      offerDesktop={push.supported && !push.enabled && push.permission !== "denied"}
      onEnableDesktop={() => void push.request()}
    />
  );
}

/** The pop-ups themselves, drawn from alerts — no subscription, no session. */
export function WorkspaceReplyAlertStack({
  alerts,
  onOpen,
  onDismiss,
  offerDesktop,
  onEnableDesktop,
}: {
  alerts: WorkspaceReplyAlert[];
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
  offerDesktop: boolean;
  onEnableDesktop: () => void;
}) {
  if (alerts.length === 0) return null;
  const visible = alerts.slice(0, MAX_VISIBLE);
  const waiting = alerts.length - visible.length;
  return (
    <section
      aria-label="Workspace replies"
      // Above the Lovable badge's corner on the published site, and clear of
      // the toasts, which sonner draws bottom right too.
      className="pointer-events-none fixed bottom-16 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      {visible.map((a) => (
        <article
          key={a.id}
          role="status"
          aria-live="polite"
          className="glass-strong brut-raise-primary pointer-events-auto border-primary/50 p-4 animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
              <MessagesSquare className="h-4 w-4 text-primary" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
                New reply · Workspace messages
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-foreground" title={a.business}>
                {a.business}
              </p>
              {a.workspace && a.workspace !== a.business && (
                <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {a.isPrime ? (
                    <Crown className="h-3 w-3" aria-hidden />
                  ) : (
                    <Server className="h-3 w-3" aria-hidden />
                  )}
                  <span className="truncate">{a.workspace}</span>
                </p>
              )}
              <p className="mt-2 line-clamp-3 text-sm text-foreground/90">
                {a.author && <span className="font-medium text-foreground">{a.author}: </span>}
                {a.excerpt}
              </p>
              {a.messageTitle && (
                <p className="mt-1 truncate text-xs text-muted-foreground">On “{a.messageTitle}”</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(a.id)}
              className="-mr-1 -mt-1 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Dismiss the reply from ${a.business}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {a.href && (
              <Button asChild size="sm" className="h-8">
                <Link to={a.href} onClick={() => onOpen(a.id)}>
                  Open conversation
                </Link>
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-8" onClick={() => onDismiss(a.id)}>
              Dismiss
            </Button>
            {offerDesktop && (
              <button
                type="button"
                onClick={onEnableDesktop}
                className={cn(
                  "ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider",
                  "text-muted-foreground hover:text-foreground",
                )}
              >
                <BellRing className="h-3 w-3" aria-hidden />
                Desktop alerts
              </button>
            )}
          </div>
        </article>
      ))}
      {waiting > 0 && (
        <Link
          to="/notifications"
          className="glass-strong pointer-events-auto px-3 py-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {waiting} more {waiting === 1 ? "reply" : "replies"} in notifications
        </Link>
      )}
    </section>
  );
}
