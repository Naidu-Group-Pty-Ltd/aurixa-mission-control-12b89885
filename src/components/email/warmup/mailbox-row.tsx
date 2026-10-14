/**
 * One mailbox in the warmup pool: where it is in its ramp, what it did today,
 * how its mail has landed this week, and — opened — the last thirty days and
 * its latest conversations.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  Settings2,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { RecordRow, type SpineTone } from "@/components/record-row";
import { useConfirm } from "@/components/confirm-dialog";
import { PlacementChart } from "@/components/email/warmup/placement-chart";
import { ScheduleFields } from "@/components/email/warmup/schedule-fields";
import { cn } from "@/lib/utils";
import {
  HEALTH_WINDOW_DAYS,
  healthTone,
  scheduleProblems,
  type WarmupSchedule,
} from "@/lib/email/warmupPlan.pure";
import {
  getWarmupMailbox,
  removeWarmupMailbox,
  setWarmupMailboxStatus,
  updateWarmupMailbox,
  type WarmupMailboxSummary,
} from "@/lib/email-warmup.functions";

/** Inbox placement as status: an icon and words, never colour alone. */
export function HealthBadge({ score }: { score: number | null }) {
  const tone = healthTone(score);
  if (tone === null) {
    return (
      <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
        not enough mail yet
      </Badge>
    );
  }
  const Icon = tone === "good" ? CheckCircle2 : AlertTriangle;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-mono text-[10px]",
        tone === "good" && "text-success",
        tone === "fair" && "text-warning",
        tone === "poor" && "text-destructive",
      )}
      title={`Inbox placement over the last ${HEALTH_WINDOW_DAYS} days`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {score}% inbox
    </Badge>
  );
}

function spineFor(row: WarmupMailboxSummary): SpineTone {
  if (row.status === "error") return "bad";
  if (row.status === "paused") return "idle";
  if (row.brake?.state === "held") return "bad";
  if (row.brake) return "warn";
  const tone = healthTone(row.health);
  if (tone === "poor") return "bad";
  if (tone === "fair") return "warn";
  return "live";
}

const STATUS_TEXT: Record<string, string> = {
  sending: "sending",
  sent: "on its way",
  landed: "arrived",
  engaged: "read, reply due",
  done: "done",
  missing: "never arrived",
  failed: "not sent",
};

function MailboxDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["email", "warmup", "mailbox", id],
    queryFn: () => getWarmupMailbox({ data: { id } }),
    refetchInterval: 60_000,
  });
  if (detail.isLoading) {
    return (
      <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Reading its last thirty days…
      </p>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <p className="font-mono text-xs text-destructive">
        {(detail.error as Error | null)?.message ?? "Could not read this mailbox's warmup."}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <PlacementChart days={detail.data.series} />
      <div className="space-y-1">
        <p className="label-mono">latest conversations</p>
        {detail.data.messages.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">None yet.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {detail.data.messages.map((message) => {
              const bad =
                message.status === "missing" ||
                message.status === "failed" ||
                message.placement === "junk";
              return (
                <div
                  key={message.id}
                  className="flex items-start gap-2 border-b border-border/30 py-1.5 text-xs last:border-0"
                >
                  {message.direction === "out" ? (
                    <ArrowUpRight
                      className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
                      aria-label="sent"
                    />
                  ) : (
                    <ArrowDownLeft
                      className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
                      aria-label="received"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate">
                      <span className="text-foreground">{message.subject}</span>
                    </p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {message.direction === "out" ? "to" : "from"} {message.partner}
                      {message.sent_at
                        ? ` · ${format(new Date(message.sent_at), "d MMM HH:mm")}`
                        : ""}
                      {message.rescued_at ? " · rescued from spam" : ""}
                      {message.flagged_at ? " · flagged" : ""}
                      {message.replied_at ? " · answered" : ""}
                      {message.error && bad ? ` · ${message.error}` : ""}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn("shrink-0 font-mono text-[10px]", bad && "text-destructive")}
                  >
                    {message.placement === "junk"
                      ? "landed in spam"
                      : message.placement === "other" && message.status !== "done"
                        ? "in a folder"
                        : (STATUS_TEXT[message.status] ?? message.status)}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EditScheduleDialog({
  row,
  open,
  onOpenChange,
}: {
  row: WarmupMailboxSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [schedule, setSchedule] = useState<WarmupSchedule>(row.schedule);
  const [tidySent, setTidySent] = useState(row.tidySent);
  const problems = scheduleProblems(schedule);
  const save = useMutation({
    mutationFn: () => updateWarmupMailbox({ data: { id: row.id, schedule, tidySent } }),
    onSuccess: () => {
      toast.success("Schedule saved", { description: "Its place in the ramp is kept." });
      void qc.invalidateQueries({ queryKey: ["email", "warmup"] });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error("Not saved", { description: error.message }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Warmup schedule — {row.mailbox}</DialogTitle>
          <DialogDescription>
            It is on day {row.rampDay} of its ramp; a new start or increase applies from there.
          </DialogDescription>
        </DialogHeader>
        <ScheduleFields value={schedule} onChange={setSchedule} idPrefix={`edit-${row.id}`} />
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            File sent copies too
            <span className="block font-mono text-[10px] text-muted-foreground">
              move warmup mail out of Sent Items into the Warmup folder
            </span>
          </span>
          <Switch checked={tidySent} onCheckedChange={setTidySent} />
        </label>
        {problems.length > 0 ? (
          <ul className="space-y-1 font-mono text-[11px] text-destructive">
            {problems.map((problem) => (
              <li key={problem}>— {problem}</li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={problems.length > 0 || save.isPending}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WarmupMailboxRow({ row }: { row: WarmupMailboxSummary }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const status = useMutation({
    mutationFn: (next: "active" | "paused") =>
      setWarmupMailboxStatus({ data: { id: row.id, status: next } }),
    onSuccess: (_, next) => {
      toast.success(
        next === "paused" ? `${row.mailbox} paused` : `${row.mailbox} is warming again`,
      );
      void qc.invalidateQueries({ queryKey: ["email", "warmup"] });
    },
    onError: (error: Error) => toast.error("Could not change it", { description: error.message }),
  });
  const remove = useMutation({
    mutationFn: () => removeWarmupMailbox({ data: { id: row.id } }),
    onSuccess: () => {
      toast.success(`${row.mailbox} left the warmup pool`);
      void qc.invalidateQueries({ queryKey: ["email", "warmup"] });
    },
    onError: (error: Error) => toast.error("Could not remove it", { description: error.message }),
  });

  const week = row.week;
  const placed = week.inbox + week.other;
  const progress =
    row.status === "active"
      ? `${row.startedToday} of ${row.targetToday} started today`
      : `${row.startedToday} started today`;

  return (
    <RecordRow spine={spineFor(row)} className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <button
          type="button"
          onClick={() => setOpen((shown) => !shown)}
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{row.displayName ?? row.mailbox}</span>
            {row.displayName ? (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {row.mailbox}
              </span>
            ) : null}
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              {row.status === "active" ? `day ${row.rampDay}` : row.status}
            </Badge>
            <HealthBadge score={row.health} />
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {row.tenantLabel} · {progress}
            {row.repliesToday ? ` · ${row.repliesToday} replies` : ""} · {row.receivedToday}{" "}
            received
            {row.status === "active" && row.nextSendAt
              ? ` · next ${formatDistanceToNow(new Date(row.nextSendAt), { addSuffix: true })}`
              : ""}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            last {HEALTH_WINDOW_DAYS} days: {week.sent} sent · {placed} reached the inbox ·{" "}
            {week.junk} in spam · {week.missing} missing · {week.rescued} rescued · {week.replied}{" "}
            answered
          </p>
          {row.status === "active" && row.brake ? (
            <p className="font-mono text-[11px] leading-snug text-warning">
              {row.brake.state === "held" ? "Held back" : "Slowed"}: {row.brake.reason}
            </p>
          ) : null}
          {row.statusReason || row.lastError ? (
            <p
              className={cn(
                "font-mono text-[11px] leading-snug",
                row.status === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {row.statusReason ?? row.lastError}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {row.status === "active" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={status.isPending}
              onClick={() => status.mutate("paused")}
              title="Stop sending from this mailbox; mail on its way is still filed"
            >
              <Pause className="h-3 w-3" />
              <span className="ml-1 hidden sm:inline">Pause</span>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={status.isPending}
              onClick={() => status.mutate("active")}
              title="Check the mailbox again and start warming it"
            >
              {status.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              <span className="ml-1 hidden sm:inline">Resume</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
            title="Change its schedule"
          >
            <Settings2 className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            title="Take it out of the warmup pool"
            onClick={async () => {
              const ok = await confirm({
                title: `Remove ${row.mailbox} from warmup?`,
                description:
                  "It stops sending and receiving warmup mail. Its Warmup folder and the mail in it stay in the mailbox, and its record stays here.",
                confirmText: "Remove",
                destructive: true,
              });
              if (ok) remove.mutate();
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-3 border-t border-border/40 pt-3">
          <MailboxDetail id={row.id} />
        </div>
      ) : null}
      {editing ? <EditScheduleDialog row={row} open={editing} onOpenChange={setEditing} /> : null}
    </RecordRow>
  );
}
