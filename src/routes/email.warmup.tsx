// Email warmup: the pool of mailboxes that write to each other to earn their
// sending reputation, how each is doing, and the controls for all of it.
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Flame,
  Info,
  Loader2,
  Pause,
  Plus,
  Settings2,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { EmptyState } from "@/components/empty-state";
import { RefreshButton } from "@/components/refresh-button";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddWarmupMailboxesDialog } from "@/components/email/warmup/add-mailboxes-dialog";
import { WarmupMailboxRow } from "@/components/email/warmup/mailbox-row";
import { SendingDomainsPanel } from "@/components/email/sending-domains";
import { HEALTH_WINDOW_DAYS } from "@/lib/email/warmupPlan.pure";
import { getWarmupPool, updateWarmupSettings, type WarmupPool } from "@/lib/email-warmup.functions";

export const Route = createFileRoute("/email/warmup")({
  component: () => (
    <ProtectedRoute>
      <EmailWarmupPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Email Warmup — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Warm up Microsoft 365 mailboxes before they send campaigns: a pool that writes, opens, rescues and replies across your tenants.",
      },
      { property: "og:title", content: "Email Warmup — Aurixa Mission Control" },
      { property: "og:description", content: "Mailbox warmup across Microsoft tenants." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

/** A pass every two minutes; ten without one means the schedule is not reaching the engine. */
const STALLED_AFTER_MS = 10 * 60_000;

function PoolSettingsDialog({
  settings,
  open,
  onOpenChange,
}: {
  settings: WarmupPool["settings"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [paused, setPaused] = useState(settings.paused);
  const [sameOrganisation, setSameOrganisation] = useState(settings.allowSameOrganisation);
  const save = useMutation({
    mutationFn: () =>
      updateWarmupSettings({ data: { paused, allowSameOrganisation: sameOrganisation } }),
    onSuccess: () => {
      toast.success("Pool settings saved");
      void qc.invalidateQueries({ queryKey: ["email", "warmup"] });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error("Not saved", { description: error.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Warmup pool</DialogTitle>
          <DialogDescription>Switches that apply to every mailbox in the pool.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-start justify-between gap-4 text-sm">
            <span>
              Pause the whole pool
              <span className="block font-mono text-[11px] text-muted-foreground">
                No new conversations and no replies. Mail already on its way is still found, read
                and filed, so nothing is left sitting in an inbox.
              </span>
            </span>
            <Switch checked={paused} onCheckedChange={setPaused} />
          </label>
          <label className="flex items-start justify-between gap-4 text-sm">
            <span>
              Test mode: pair mailboxes inside one organisation
              <span className="block font-mono text-[11px] text-muted-foreground">
                Mail between two mailboxes of the same Microsoft 365 organisation never leaves
                Microsoft, so it shows the warmup working end to end but builds no reputation. Pairs
                across organisations are still preferred.
              </span>
            </span>
            <Switch checked={sameOrganisation} onCheckedChange={setSameOrganisation} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Strip({ tone, children }: { tone: "warn" | "bad" | "idle"; children: React.ReactNode }) {
  const Icon = tone === "idle" ? Info : AlertTriangle;
  return (
    <div className={`glass-inset spine spine-${tone} flex items-start gap-3 px-4 py-3`}>
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "bad" ? "text-destructive" : tone === "warn" ? "text-warning" : "text-muted-foreground"}`}
      />
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function EmailWarmupPage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pool = useQuery({
    queryKey: ["email", "warmup", "pool"],
    queryFn: () => getWarmupPool(),
    refetchInterval: 30_000,
  });
  const data = pool.data;
  const mailboxes = data?.mailboxes ?? [];
  const enrolled = new Set(mailboxes.map((row) => row.mailbox));
  const lastTick = data?.settings.lastTickAt ? new Date(data.settings.lastTickAt) : null;
  const stalled =
    data !== undefined &&
    data.warming > 0 &&
    (!lastTick || Date.now() - lastTick.getTime() > STALLED_AFTER_MS);
  const single =
    data !== undefined &&
    data.warming > 0 &&
    data.organisations < 2 &&
    !data.settings.allowSameOrganisation;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow={
          <Link to="/email" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-3 w-3" /> email campaigns
          </Link>
        }
        title="Email Warmup"
        description="Mailboxes in your Microsoft tenants write to each other a little more each day, then open, rescue from spam and answer what arrives — so mailbox providers learn they are wanted before a campaign asks anything of them."
        actions={
          <>
            <RefreshButton
              onRefresh={() => qc.invalidateQueries({ queryKey: ["email", "warmup"] })}
              loading={pool.isFetching}
              lastUpdated={pool.dataUpdatedAt ? new Date(pool.dataUpdatedAt) : null}
            />
            <Button variant="outline" onClick={() => setSettingsOpen(true)} disabled={!data}>
              <Settings2 className="mr-2 h-4 w-4" />
              Pool settings
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add mailboxes
            </Button>
          </>
        }
      />

      {pool.error ? <Strip tone="bad">{(pool.error as Error).message}</Strip> : null}
      {data?.settings.paused ? (
        <Strip tone="warn">
          <span className="text-foreground">The pool is paused.</span> No new warmup mail is sent
          and nothing is answered; mail already on its way is still read and filed.
        </Strip>
      ) : null}
      {single ? (
        <Strip tone="warn">
          <span className="text-foreground">Every warming mailbox is in one organisation.</span>{" "}
          Mail inside one Microsoft 365 organisation never leaves Microsoft, so it builds no
          reputation and the pool will not send it. Enrol a mailbox from another tenant —{" "}
          <Link to="/email" search={{ tab: "tenants" }} className="text-foreground underline">
            add a tenant
          </Link>{" "}
          if you need one — or turn on test mode under Pool settings to watch it work.
        </Strip>
      ) : null}
      {data?.settings.allowSameOrganisation ? (
        <Strip tone="idle">
          Test mode is on: mailboxes of one organisation may be paired. Those pairs show the
          machinery working and build no reputation.
        </Strip>
      ) : null}
      {stalled ? (
        <Strip tone="bad">
          <span className="text-foreground">The warmup engine has not run</span>
          {lastTick ? ` since ${formatDistanceToNow(lastTick, { addSuffix: true })}` : " yet"}. It
          is meant to run every two minutes (`email-warmup-2min`); check the scheduler.
        </Strip>
      ) : data?.settings.lastTickNote && lastTick ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          Last pass {formatDistanceToNow(lastTick, { addSuffix: true })}:{" "}
          {data.settings.lastTickNote}
        </p>
      ) : null}

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4 lg:grid-cols-7">
        <MetricCell label="warming" value={data?.warming ?? "—"} />
        <MetricCell label="organisations" value={data?.organisations ?? "—"} />
        <MetricCell label="started today" value={data?.pool.startedToday ?? "—"} />
        <MetricCell label="received today" value={data?.pool.receivedToday ?? "—"} />
        <MetricCell
          label={`inbox placement, ${HEALTH_WINDOW_DAYS} days`}
          value={
            data?.pool.health === null || data?.pool.health === undefined
              ? "—"
              : `${data.pool.health}%`
          }
          size="sm"
        />
        <MetricCell
          label={`rescued, ${HEALTH_WINDOW_DAYS} days`}
          value={data?.pool.week.rescued ?? "—"}
        />
        <MetricCell
          label={`answered, ${HEALTH_WINDOW_DAYS} days`}
          value={data?.pool.week.replied ?? "—"}
        />
      </div>

      {pool.isLoading ? (
        <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading the pool…
        </p>
      ) : mailboxes.length === 0 ? (
        <EmptyState
          icon={<Flame className="h-6 w-6" />}
          title="No mailboxes are warming"
          description="Add mailboxes from two or more of your Microsoft tenants. Each starts with a couple of messages a day and builds up from there."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add mailboxes
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {mailboxes.map((row) => (
            <WarmupMailboxRow key={row.id} row={row} />
          ))}
        </div>
      )}

      <SendingDomainsPanel />

      <div className="glass-inset spine spine-idle flex items-start gap-3 px-4 py-3">
        <Pause className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Warmup mail is filed into a folder named <span className="text-foreground">Warmup</span>{" "}
          in each mailbox once it has been read, so it does not sit in anyone's inbox. Mailboxes
          only write to mailboxes in other organisations, about as much as they receive. Most
          providers suggest about two weeks of warmup before a campaign; campaigns sending from a
          warming mailbox say so on their readiness checks.
        </p>
      </div>

      <AddWarmupMailboxesDialog open={adding} onOpenChange={setAdding} enrolled={enrolled} />
      {data && settingsOpen ? (
        <PoolSettingsDialog
          settings={data.settings}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      ) : null}
    </div>
  );
}
