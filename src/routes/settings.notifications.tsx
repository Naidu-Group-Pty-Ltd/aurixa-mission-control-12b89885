import { createFileRoute } from "@tanstack/react-router";
import { ProtectedRoute } from "@/components/protected-route";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BellOff,
  BellRing,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  CircleDot,
  GitFork,
  Trash2,
  Boxes,
  Smartphone,
  Monitor,
  Loader2,
  UserPlus,
  ScanSearch,
  Bug,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  useNotificationPreferences,
  type NotificationKind,
  type NotificationSeverity,
} from "@/lib/notification-preferences";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useState, useEffect, useCallback } from "react";
import {
  isPushSupported,
  registerServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
  getUserSubscriptions,
  removeSubscriptionById,
  getExistingSubscription,
} from "@/lib/push-subscription";
import { toast } from "sonner";

export const Route = createFileRoute("/settings/notifications")({
  component: SettingsNotificationsPage,
  head: () => ({
    meta: [{ title: "Notification Preferences — Aurixa Systems Mission Control" }],
  }),
});

const KINDS: {
  value: NotificationKind;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    value: "cascade_started",
    label: "Cascade started",
    description: "When a new cascade run kicks off.",
    icon: CircleDot,
  },
  {
    value: "cascade_completed",
    label: "Cascade completed",
    description: "Successful cascade runs.",
    icon: CheckCircle2,
  },
  {
    value: "cascade_partial",
    label: "Cascade partial",
    description: "Some clones synced, others didn't.",
    icon: AlertTriangle,
  },
  {
    value: "cascade_failed",
    label: "Cascade failed",
    description: "Run did not succeed for any clone.",
    icon: XCircle,
  },
  {
    value: "cascade_awaiting_approval",
    label: "Cascade awaiting approval",
    description: "A high-blast-radius cascade needs a second-operator approval.",
    icon: AlertTriangle,
  },
  {
    value: "cascade_approved",
    label: "Cascade approved",
    description: "Your pending cascade was approved by another operator.",
    icon: CheckCircle2,
  },
  {
    value: "cascade_rejected",
    label: "Cascade rejected",
    description: "Your pending cascade was rejected by another operator.",
    icon: XCircle,
  },
  {
    value: "drift_high",
    label: "Drift — high",
    description: "AI flagged a high-severity drift finding.",
    icon: AlertTriangle,
  },
  {
    value: "drift_medium",
    label: "Drift — medium",
    description: "AI flagged a medium-severity drift finding.",
    icon: AlertTriangle,
  },
  {
    value: "clone_created",
    label: "Clone created",
    description: "New clone provisioned in the fleet.",
    icon: GitFork,
  },
  {
    value: "clone_deleted",
    label: "Clone deleted",
    description: "Clone removed from the fleet.",
    icon: Trash2,
  },
  {
    value: "module_installed",
    label: "Module installed",
    description: "Module injected into a clone.",
    icon: Boxes,
  },
  {
    value: "module_removed",
    label: "Module removed",
    description: "Module removed from a clone.",
    icon: Boxes,
  },
  {
    value: "lead_captured",
    label: "Lead captured",
    description: "A new waitlist lead came in from the Aurixa Systems website.",
    icon: UserPlus,
  },
  {
    value: "live_audit_findings_detected",
    label: "Live audit — new defects",
    description: "A live audit of Prime found new high or critical defects, or one came back.",
    icon: Bug,
  },
  {
    value: "live_audit_run_failed",
    label: "Live audit — failing",
    description: "The live audit of Prime has failed three runs in a row.",
    icon: ScanSearch,
  },
  {
    value: "live_audit_fix_ready",
    label: "Live audit — fix ready",
    description: "Claude drafted a fix for a live-audit defect and it waits for review.",
    icon: Wrench,
  },
];

const SEVERITIES: {
  value: NotificationSeverity;
  label: string;
  className: string;
  icon: LucideIcon;
}[] = [
  { value: "info", label: "Info", className: "text-info", icon: Info },
  { value: "success", label: "Success", className: "text-success", icon: CheckCircle2 },
  { value: "warning", label: "Warning", className: "text-warning", icon: AlertTriangle },
  { value: "error", label: "Error", className: "text-destructive", icon: XCircle },
];

type DeviceSub = {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
};

function SettingsNotificationsPage() {
  const { prefs, loading, toggleKind, toggleSeverity, setToggle, setDigestMode } =
    useNotificationPreferences();
  const { session } = useAuth();

  const handleToast = (next: boolean) => void setToggle("mute_toasts", next);
  const handlePush = (next: boolean) => void setToggle("mute_browser_push", next);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-primary" /> Delivery channels
          </CardTitle>
          <CardDescription>
            Mute entire channels without losing the inbox history. Notifications still appear in the
            bell and on the /notifications page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ChannelToggle
            id="mute-toasts"
            label="In-app toasts"
            description="Floating popups for cascade outcomes and drift findings."
            checked={!prefs.mute_toasts}
            onCheckedChange={(v) => handleToast(!v)}
            disabled={loading}
          />
          <ChannelToggle
            id="mute-push"
            label="Browser notifications"
            description="OS-level notifications when this tab is in the background."
            checked={!prefs.mute_browser_push}
            onCheckedChange={(v) => handlePush(!v)}
            disabled={loading}
          />
          <div className="border p-3">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Digest mode
            </Label>
            <div className="mt-2 flex gap-1">
              {(["realtime", "hourly", "daily"] as const).map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={prefs.digest_mode === m ? "default" : "outline"}
                  disabled={loading}
                  onClick={() => void setDigestMode(m)}
                >
                  {m}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Batch non-critical notifications into rolled-up summaries instead of firing them in
              real time.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Web Push subscription management */}
      {session && <WebPushCard userId={session.user.id} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellOff className="h-4 w-4 text-warning" /> Mute by severity
          </CardTitle>
          <CardDescription>
            Suppress toasts and browser push for specific severity levels.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2">
            {SEVERITIES.map((s) => {
              const muted = prefs.muted_severities.includes(s.value);
              const Icon = s.icon;
              return (
                <button
                  key={s.value}
                  type="button"
                  disabled={loading}
                  onClick={() => void toggleSeverity(s.value)}
                  className={cn(
                    "flex items-center justify-between rounded-md border p-3 text-left transition-colors",
                    muted
                      ? "border-muted bg-muted/40 opacity-70"
                      : "border-border hover:border-primary/40",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon
                      className={cn("h-4 w-4", muted ? "text-muted-foreground" : s.className)}
                    />
                    <span className="font-mono text-sm">{s.label}</span>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] uppercase",
                      muted
                        ? "border-muted text-muted-foreground"
                        : "border-success/40 text-success",
                    )}
                  >
                    {muted ? "muted" : "on"}
                  </Badge>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellOff className="h-4 w-4 text-warning" /> Mute by kind
          </CardTitle>
          <CardDescription>
            Suppress toasts and browser push for specific event types. The bell still records them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {KINDS.map((k) => {
            const muted = prefs.muted_kinds.includes(k.value);
            const Icon = k.icon;
            return (
              <div
                key={k.value}
                className="flex items-center justify-between gap-3 border bg-surface p-3"
              >
                <div className="flex items-start gap-3">
                  <Icon
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      muted ? "text-muted-foreground" : "text-primary",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="font-mono text-sm">{k.label}</div>
                    <div className="text-xs text-muted-foreground">{k.description}</div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={muted ? "outline" : "ghost"}
                  disabled={loading}
                  onClick={() => void toggleKind(k.value)}
                  className="shrink-0"
                >
                  {muted ? "Unmute" : "Mute"}
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── Web Push Card ────────────────────────────────────── */

function WebPushCard({ userId }: { userId: string }) {
  const supported = isPushSupported();
  const [subscribed, setSubscribed] = useState(false);
  const [devices, setDevices] = useState<DeviceSub[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [subscribing, setSubscribing] = useState(false);

  const refresh = useCallback(async () => {
    setLoadingDevices(true);
    try {
      const subs = await getUserSubscriptions(userId);
      setDevices(subs);

      // Check if THIS browser is subscribed
      const existing = await getExistingSubscription();
      setSubscribed(!!existing);
    } catch {
      // ignore
    } finally {
      setLoadingDevices(false);
    }
  }, [userId]);

  useEffect(() => {
    void registerServiceWorker();
    void refresh();
  }, [refresh]);

  const handleSubscribe = async () => {
    setSubscribing(true);
    try {
      await subscribeToPush(userId);
      setSubscribed(true);
      toast.success("Push notifications enabled for this device");
      await refresh();
    } catch (err) {
      toast.error("Failed to enable push notifications");
      console.error(err);
    } finally {
      setSubscribing(false);
    }
  };

  const handleUnsubscribe = async () => {
    setSubscribing(true);
    try {
      await unsubscribeFromPush(userId);
      setSubscribed(false);
      toast.success("Push notifications disabled for this device");
      await refresh();
    } catch (err) {
      toast.error("Failed to disable push notifications");
      console.error(err);
    } finally {
      setSubscribing(false);
    }
  };

  const handleRemoveDevice = async (id: string) => {
    try {
      await removeSubscriptionById(id);
      toast.success("Device removed");
      await refresh();
    } catch {
      toast.error("Failed to remove device");
    }
  };

  const parseDeviceType = (ua: string | null): { icon: LucideIcon; label: string } => {
    if (!ua) return { icon: Monitor, label: "Unknown device" };
    if (/mobile|android|iphone|ipad/i.test(ua)) return { icon: Smartphone, label: "Mobile" };
    return { icon: Monitor, label: "Desktop" };
  };

  const parseBrowser = (ua: string | null): string => {
    if (!ua) return "Unknown browser";
    if (/firefox/i.test(ua)) return "Firefox";
    if (/edg/i.test(ua)) return "Edge";
    if (/chrome/i.test(ua)) return "Chrome";
    if (/safari/i.test(ua)) return "Safari";
    return "Browser";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="h-4 w-4 text-primary" /> Web Push (closed-tab)
        </CardTitle>
        <CardDescription>
          Receive notifications even when the dashboard tab is closed.
          {!supported && (
            <span className="mt-1 block text-xs text-destructive">
              Web Push is not supported in this browser.
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Subscribe/Unsubscribe this device */}
        <div className="flex items-center justify-between border bg-surface p-3">
          <div className="min-w-0">
            <Label className="font-mono text-sm">This device</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {subscribed
                ? "Push notifications are active on this browser."
                : "Enable push to get alerts when the tab is closed."}
            </p>
          </div>
          <Button
            size="sm"
            variant={subscribed ? "outline" : "default"}
            disabled={!supported || subscribing}
            onClick={subscribed ? handleUnsubscribe : handleSubscribe}
          >
            {subscribing && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            {subscribed ? "Disable" : "Enable"}
          </Button>
        </div>

        {/* Device list */}
        {loadingDevices ? (
          <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            Loading devices…
          </div>
        ) : devices.length > 0 ? (
          <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Subscribed devices ({devices.length})
            </p>
            {devices.map((d) => {
              const { icon: DevIcon, label: deviceLabel } = parseDeviceType(d.user_agent);
              const browser = parseBrowser(d.user_agent);
              return (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-3 border bg-surface p-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <DevIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="font-mono text-sm">
                        {browser} · {deviceLabel}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        Last used{" "}
                        {new Date(d.last_used_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => handleRemoveDevice(d.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-center text-xs text-muted-foreground py-2">
            No devices subscribed to push notifications yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelToggle({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border bg-surface p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="font-mono text-sm">
          {label}
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
