// One campaign, end to end: the message, the ruleset, the per-parameter
// quotas, the recipient ledger and the activity behind it.
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Info,
  Pause,
  Play,
  Plus,
  Send,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import { auStateSiblings, type ColumnProfile } from "@/lib/email/listProfile.pure";
import {
  attachListToCampaign,
  campaignReadiness,
  cancelRecipient,
  deleteQuota,
  getCampaign,
  listLists,
  listRecipients,
  previewCampaign,
  quotaUsage,
  releaseUnconfirmed,
  sendTestEmail,
  setCampaignStatus,
  updateCampaign,
  upsertQuota,
} from "@/lib/email-campaigns.functions";

export const Route = createFileRoute("/email/campaigns/$campaignId")({
  component: () => (
    <ProtectedRoute>
      <CampaignWorkspace />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Campaign — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "The message, the sending rules, the per-parameter quotas and the recipient ledger.",
      },
      { property: "og:title", content: "Campaign — Aurixa Mission Control" },
      { property: "og:description", content: "One email campaign, end to end." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

const TIMEZONES = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Adelaide",
  "Australia/Perth",
  "Australia/Darwin",
  "Australia/Hobart",
  "UTC",
];

const RECIPIENT_SPINE: Record<string, SpineTone> = {
  pending: "idle",
  claimed: "live",
  sent: "ok",
  failed: "bad",
  unconfirmed: "warn",
  suppressed: "warn",
  cancelled: "idle",
};

function CampaignWorkspace() {
  const { campaignId } = Route.useParams();
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ["email", "campaign", campaignId],
    queryFn: () => getCampaign({ data: { id: campaignId } }),
    refetchInterval: 15_000,
  });
  const readiness = useQuery({
    queryKey: ["email", "readiness", campaignId],
    queryFn: () => campaignReadiness({ data: { id: campaignId } }),
    refetchInterval: 30_000,
  });

  const status = useMutation({
    mutationFn: (next: "running" | "paused" | "cancelled" | "draft") =>
      setCampaignStatus({ data: { id: campaignId, status: next } }),
    onSuccess: () => {
      toast.success("Campaign updated");
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) =>
      toast.error("Could not change the campaign", { description: error.message }),
  });

  const campaign = detail.data?.campaign;
  const counts = (detail.data?.counts ?? {}) as Record<string, number>;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  if (detail.isLoading) {
    return <div className="p-6 font-mono text-xs text-muted-foreground">Loading…</div>;
  }
  if (!campaign) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<AlertTriangle className="h-6 w-6" />}
          title="Campaign not found"
          description="It may have been deleted."
          action={
            <Button asChild variant="outline">
              <Link to="/email">Back to campaigns</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const isRunning = campaign.status === "running";
  const isFinal = campaign.status === "completed" || campaign.status === "cancelled";

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow={
          <Link to="/email" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-3 w-3" /> campaigns
          </Link>
        }
        title={campaign.name as string}
        description={(campaign.description as string) ?? undefined}
        actions={
          <>
            <TestSendDialog campaignId={campaignId} />
            {isRunning ? (
              <Button variant="outline" onClick={() => status.mutate("paused")}>
                <Pause className="mr-2 h-4 w-4" /> Pause
              </Button>
            ) : (
              <Button
                onClick={() => status.mutate("running")}
                disabled={isFinal || (readiness.data?.blocking.length ?? 1) > 0}
              >
                <Play className="mr-2 h-4 w-4" />
                {campaign.status === "paused" ? "Resume" : "Start sending"}
              </Button>
            )}
          </>
        }
      />

      <ReadinessPanel readiness={readiness.data} status={campaign.status as string} />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-6">
        <MetricCell label="contacts" value={total.toLocaleString()} />
        <MetricCell label="sent" value={(counts.sent ?? 0).toLocaleString()} />
        <MetricCell label="waiting" value={(counts.pending ?? 0).toLocaleString()} />
        <MetricCell
          label="refused"
          value={(counts.failed ?? 0).toLocaleString()}
          tone="destructive"
          alarm={(counts.failed ?? 0) > 0}
        />
        <MetricCell
          label="unconfirmed"
          value={(counts.unconfirmed ?? 0).toLocaleString()}
          tone="warning"
          alarm={(counts.unconfirmed ?? 0) > 0}
        />
        <MetricCell
          label="held"
          value={(counts.suppressed ?? 0).toLocaleString()}
          note="on the register"
        />
      </div>

      <Tabs defaultValue="message">
        <TabsList>
          <TabsTrigger value="message">Message</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="parameters">Parameters</TabsTrigger>
          <TabsTrigger value="audience">Audience</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="message" className="mt-4">
          <MessageEditor campaign={campaign} campaignId={campaignId} />
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          <RulesEditor campaign={campaign} campaignId={campaignId} />
        </TabsContent>
        <TabsContent value="parameters" className="mt-4">
          <QuotaEditor
            campaignId={campaignId}
            quotas={detail.data?.quotas ?? []}
            imports={detail.data?.imports ?? []}
          />
        </TabsContent>
        <TabsContent value="audience" className="mt-4">
          <AudiencePanel campaignId={campaignId} imports={detail.data?.imports ?? []} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityPanel messages={detail.data?.messages ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReadinessPanel({
  readiness,
  status,
}: {
  readiness:
    | { blocking: string[]; warnings: string[]; batchSize: number; pending: number }
    | undefined;
  status: string;
}) {
  if (!readiness) return null;
  const { blocking, warnings } = readiness;
  if (blocking.length === 0 && warnings.length === 0) {
    if (status !== "draft") return null;
    return (
      <div className="glass-inset spine spine-ok flex items-start gap-3 px-4 py-3">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <p className="text-sm text-muted-foreground">
          Ready to send — {readiness.pending.toLocaleString()} contacts waiting,{" "}
          {readiness.batchSize === 1 ? "one at a time" : `${readiness.batchSize} to a message`}.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {blocking.map((reason) => (
        <div key={reason} className="glass-inset spine spine-bad flex items-start gap-3 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground">Cannot start:</span> {reason}
          </p>
        </div>
      ))}
      {warnings.map((reason) => (
        <div key={reason} className="glass-inset spine spine-warn flex items-start gap-3 px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-sm text-muted-foreground">{reason}</p>
        </div>
      ))}
    </div>
  );
}

// ── Message ─────────────────────────────────────────────────────────────────

function MessageEditor({
  campaign,
  campaignId,
}: {
  campaign: Record<string, unknown>;
  campaignId: string;
}) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState((campaign.subject_template as string) ?? "");
  const [body, setBody] = useState((campaign.body_template as string) ?? "");
  const [bodyFormat, setBodyFormat] = useState((campaign.body_format as string) ?? "html");
  const [fromName, setFromName] = useState((campaign.from_name as string) ?? "");
  const [fromMailbox, setFromMailbox] = useState((campaign.from_mailbox as string) ?? "");
  const [replyTo, setReplyTo] = useState((campaign.reply_to as string) ?? "");

  const save = useMutation({
    mutationFn: () =>
      updateCampaign({
        data: {
          id: campaignId,
          subjectTemplate: subject,
          bodyTemplate: body,
          bodyFormat: bodyFormat as "html" | "text",
          fromName: fromName || null,
          fromMailbox: fromMailbox || null,
          replyTo: replyTo || null,
        },
      }),
    onSuccess: () => {
      toast.success("Message saved");
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const preview = useQuery({
    queryKey: ["email", "preview", campaignId],
    queryFn: () => previewCampaign({ data: { id: campaignId } }),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="glass space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="from-name">Sender name</Label>
            <Input
              id="from-name"
              value={fromName}
              onChange={(event) => setFromName(event.target.value)}
              placeholder="Aurixa Systems"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="from-mailbox">Send from</Label>
            <Input
              id="from-mailbox"
              value={fromMailbox}
              onChange={(event) => setFromMailbox(event.target.value)}
              placeholder="the deployment's mailbox"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reply-to">Reply to</Label>
            <Input
              id="reply-to"
              value={replyTo}
              onChange={(event) => setReplyTo(event.target.value)}
              placeholder="replies go to the sender otherwise"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="subject">Subject</Label>
          <Input
            id="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="A quick note for {{first_name}}"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="body">Body</Label>
            <Select value={bodyFormat} onValueChange={setBodyFormat}>
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="html">HTML</SelectItem>
                <SelectItem value="text">Plain text</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            id="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={16}
            className="font-mono text-xs"
            placeholder={
              '<p>Hi {{first_name}},</p>\n<p>…</p>\n<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>'
            }
          />
          <p className="font-mono text-[11px] text-muted-foreground">
            Merge fields are <code>{"{{column_key}}"}</code> — any column from an attached list,
            plus <code>{"{{email}}"}</code>, <code>{"{{campaign_name}}"}</code>,{" "}
            <code>{"{{sender_name}}"}</code>, <code>{"{{today}}"}</code> and{" "}
            <code>{"{{unsubscribe_url}}"}</code>. Anything a value is substituted into is escaped,
            so a contact's own text cannot break the page. Using any per-recipient field sends one
            message per contact whatever the batch size says.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save message
          </Button>
        </div>
      </div>

      <div className="glass space-y-3 p-5">
        <p className="label-mono">preview</p>
        {preview.data ? (
          <>
            <p className="font-mono text-[11px] text-muted-foreground">
              {preview.data.recipient
                ? `as ${preview.data.recipient} will see it`
                : "no contacts yet — sample values shown"}
            </p>
            <p className="text-sm font-medium">{preview.data.subject || "(no subject)"}</p>
            <div className="max-h-[28rem] overflow-auto border border-border/50 bg-background/40 p-3 text-sm">
              {preview.data.html ? (
                // The body is written by an operator of this console, not by a
                // contact: the untrusted half (merge values) is escaped before
                // it ever reaches here.
                <div dangerouslySetInnerHTML={{ __html: preview.data.body }} />
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs">{preview.data.body}</pre>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void preview.refetch()}
              disabled={preview.isFetching}
            >
              Refresh preview
            </Button>
          </>
        ) : (
          <p className="font-mono text-[11px] text-muted-foreground">
            Save the message to preview it.
          </p>
        )}
      </div>
    </div>
  );
}

function TestSendDialog({ campaignId }: { campaignId: string }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const send = useMutation({
    mutationFn: () => sendTestEmail({ data: { id: campaignId, to } }),
    onSuccess: (result) => {
      toast.success("Test sent", { description: `from ${result.mailbox}` });
      setOpen(false);
    },
    onError: (error: Error) => toast.error("Test failed", { description: error.message }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Send className="mr-2 h-4 w-4" /> Send a test
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test message</DialogTitle>
          <DialogDescription>
            Goes to one address you name, outside the campaign entirely — no recipient is consumed,
            no cap is spent, and the ledger is untouched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="test-to">Send to</Label>
          <Input
            id="test-to"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="you@yourcompany.com"
          />
        </div>
        <DialogFooter>
          <Button onClick={() => send.mutate()} disabled={!to.trim() || send.isPending}>
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rules ───────────────────────────────────────────────────────────────────

function RulesEditor({
  campaign,
  campaignId,
}: {
  campaign: Record<string, unknown>;
  campaignId: string;
}) {
  const qc = useQueryClient();
  const [timezone, setTimezone] = useState((campaign.timezone as string) ?? "Australia/Sydney");
  const [days, setDays] = useState<number[]>((campaign.send_days as number[]) ?? [1, 2, 3, 4, 5]);
  const [windowStart, setWindowStart] = useState(
    ((campaign.window_start as string) ?? "09:00").slice(0, 5),
  );
  const [windowEnd, setWindowEnd] = useState(
    ((campaign.window_end as string) ?? "17:00").slice(0, 5),
  );
  const [perDay, setPerDay] = useState(String(campaign.max_messages_per_day ?? ""));
  const [contactsPerDay, setContactsPerDay] = useState(
    String(campaign.max_recipients_per_day ?? ""),
  );
  const [perMessage, setPerMessage] = useState(String(campaign.recipients_per_message ?? 1));
  const [gap, setGap] = useState(String(campaign.min_gap_seconds ?? 60));
  const [perRun, setPerRun] = useState(String(campaign.max_messages_per_run ?? 20));

  const save = useMutation({
    mutationFn: () =>
      updateCampaign({
        data: {
          id: campaignId,
          rules: {
            timezone,
            sendDays: days.length ? days : [1, 2, 3, 4, 5],
            windowStart,
            windowEnd,
            maxMessagesPerDay: perDay.trim() ? Number(perDay) : null,
            maxRecipientsPerDay: contactsPerDay.trim() ? Number(contactsPerDay) : null,
            recipientsPerMessage: Math.max(1, Number(perMessage) || 1),
            minGapSeconds: Math.max(0, Number(gap) || 0),
            maxMessagesPerRun: Math.max(1, Number(perRun) || 1),
          },
        },
      }),
    onSuccess: () => {
      toast.success("Rules saved");
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const perHour = Number(gap) > 0 ? Math.floor(3600 / Number(gap)) : null;

  return (
    <div className="glass space-y-6 p-5">
      <div className="space-y-2">
        <p className="label-mono">when it may send</p>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((day) => (
            <button
              key={day.value}
              type="button"
              onClick={() =>
                setDays((current) =>
                  current.includes(day.value)
                    ? current.filter((value) => value !== day.value)
                    : [...current, day.value].sort(),
                )
              }
              className={cn(
                "border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                days.includes(day.value)
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-border-strong",
              )}
            >
              {day.label}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="window-start">From</Label>
            <Input
              id="window-start"
              type="time"
              value={windowStart}
              onChange={(event) => setWindowStart(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="window-end">Until</Label>
            <Input
              id="window-end"
              type="time"
              value={windowEnd}
              onChange={(event) => setWindowEnd(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">In this timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          The window is the campaign's own clock, not the server's — 09:00 here means 09:00 there,
          across daylight saving.
        </p>
      </div>

      <div className="space-y-2">
        <p className="label-mono">how fast</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            id="per-day"
            label="Messages a day"
            hint="Blank means no daily limit."
            value={perDay}
            onChange={setPerDay}
            placeholder="unlimited"
          />
          <Field
            id="contacts-per-day"
            label="Contacts a day"
            hint="A different number when one message carries several people."
            value={contactsPerDay}
            onChange={setContactsPerDay}
            placeholder="unlimited"
          />
          <Field
            id="per-message"
            label="Contacts per message"
            hint="Above 1 the extras travel as BCC. Personalisation forces 1."
            value={perMessage}
            onChange={setPerMessage}
          />
          <Field
            id="gap"
            label="Seconds between messages"
            hint={perHour ? `About ${perHour} an hour at most.` : "No pause between messages."}
            value={gap}
            onChange={setGap}
          />
          <Field
            id="per-run"
            label="Messages per dispatcher tick"
            hint="The dispatcher runs once a minute; this caps one pass."
            value={perRun}
            onChange={setPerRun}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          Save rules
        </Button>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
      />
      {hint && <p className="font-mono text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ── Per-parameter quotas ────────────────────────────────────────────────────

/** The column profile an import carried. Snapshotted, so it survives the list. */
function importedColumns(value: unknown): ColumnProfile[] {
  return Array.isArray(value) ? (value as ColumnProfile[]) : [];
}

function QuotaEditor({
  campaignId,
  quotas,
  imports,
}: {
  campaignId: string;
  quotas: Record<string, unknown>[];
  imports: Record<string, unknown>[];
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const usage = useQuery({
    queryKey: ["email", "quota-usage", campaignId],
    queryFn: () => quotaUsage({ data: { campaignId } }),
    refetchInterval: 30_000,
  });

  // Every parameter column across every list this campaign has taken, merged
  // by key: two lists that both carry `state` are one control, not two.
  const dimensions = useMemo(() => {
    const merged = new Map<string, ColumnProfile>();
    for (const row of imports) {
      for (const column of importedColumns(row.columns)) {
        if (!column?.isDimension) continue;
        const existing = merged.get(column.key);
        if (!existing) {
          merged.set(column.key, { ...column, values: [...(column.values ?? [])] });
          continue;
        }
        const values = new Map(existing.values.map((value) => [value.value, { ...value }]));
        for (const value of column.values ?? []) {
          const seen = values.get(value.value);
          if (seen) seen.count += value.count;
          else values.set(value.value, { ...value });
        }
        existing.values = [...values.values()].sort((a, b) => b.count - a.count);
      }
    }
    return [...merged.values()];
  }, [imports]);

  const remove = useMutation({
    mutationFn: (id: string) => deleteQuota({ data: { id } }),
    onSuccess: () => {
      toast.success("Quota removed");
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (quota: Record<string, unknown>) =>
      upsertQuota({
        data: {
          id: quota.id as string,
          campaignId,
          dimension: quota.dimension as string,
          dimensionLabel: quota.dimension_label as string,
          matchValues: quota.match_values as string[],
          valueLabel: quota.value_label as string,
          maxPerDay: (quota.max_per_day as number | null) ?? null,
          maxTotal: (quota.max_total as number | null) ?? null,
          enabled: !(quota.enabled as boolean),
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["email"] }),
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-4">
      <div className="glass-inset flex items-start gap-3 px-4 py-3">
        <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          A quota caps one value of one column from the uploaded list — "no more than 20 a day to
          NSW". The columns on offer come from the spreadsheet itself, so they are whatever your
          list happens to carry. Several quotas may cover the same contact; the strictest one binds,
          and none of them can lift the campaign's own daily cap.
        </p>
      </div>

      {dimensions.length === 0 ? (
        <EmptyState
          icon={<SlidersHorizontal className="h-6 w-6" />}
          title="No parameters yet"
          description="Attach a list on the Audience tab. Any column whose values repeat — a state, a segment, a source — becomes something you can cap."
        />
      ) : (
        <QuotaDialog campaignId={campaignId} dimensions={dimensions} />
      )}

      <div className="space-y-2">
        {quotas.map((quota) => {
          const spent = usage.data?.[quota.id as string];
          const perDay = quota.max_per_day as number | null;
          const total = quota.max_total as number | null;
          const dayFull = perDay != null && (spent?.today ?? 0) >= perDay;
          const totalFull = total != null && (spent?.total ?? 0) >= total;
          return (
            <RecordRow
              key={quota.id as string}
              spine={!quota.enabled ? "idle" : dayFull || totalFull ? "warn" : "ok"}
              className="flex items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {quota.dimension_label as string} = {quota.value_label as string}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {perDay != null
                    ? `${(spent?.today ?? 0).toLocaleString()} of ${perDay.toLocaleString()} today`
                    : "no daily limit"}
                  {total != null
                    ? ` · ${(spent?.total ?? 0).toLocaleString()} of ${total.toLocaleString()} in total`
                    : ""}
                  {(quota.match_values as string[]).length > 1
                    ? ` · covers ${(quota.match_values as string[]).length} spellings`
                    : ""}
                </p>
              </div>
              <Switch
                checked={quota.enabled as boolean}
                onCheckedChange={() => toggle.mutate(quota)}
                aria-label="Enable this quota"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove this quota?",
                    description: "Contacts it was holding become sendable again on the next tick.",
                    confirmText: "Remove",
                    destructive: true,
                  });
                  if (ok) remove.mutate(quota.id as string);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </RecordRow>
          );
        })}
      </div>
    </div>
  );
}

function QuotaDialog({
  campaignId,
  dimensions,
}: {
  campaignId: string;
  dimensions: ColumnProfile[];
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dimension, setDimension] = useState(dimensions[0]?.key ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [perDay, setPerDay] = useState("");
  const [total, setTotal] = useState("");

  const column = dimensions.find((entry) => entry.key === dimension);

  useEffect(() => {
    setSelected([]);
  }, [dimension]);

  const save = useMutation({
    mutationFn: () => {
      if (!column) throw new Error("choose a column");
      const labels = column.values
        .filter((value) => selected.includes(value.value))
        .map((value) => value.label);
      return upsertQuota({
        data: {
          campaignId,
          dimension: column.key,
          dimensionLabel: column.header || column.key,
          matchValues: selected,
          valueLabel: labels.join(" / ") || selected.join(" / "),
          maxPerDay: perDay.trim() ? Number(perDay) : null,
          maxTotal: total.trim() ? Number(total) : null,
          enabled: true,
        },
      });
    },
    onSuccess: () => {
      toast.success("Quota added");
      setOpen(false);
      setSelected([]);
      setPerDay("");
      setTotal("");
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  /** Other spellings of the same state, so `NSW` and `New South Wales` are one rule. */
  const suggestSiblings = (value: string) => {
    if (!column) return;
    const siblings = auStateSiblings(value);
    if (siblings.length === 0) return;
    const present = column.values
      .map((entry) => entry.value)
      .filter((entry) => siblings.includes(entry));
    if (present.length > 1) setSelected((current) => [...new Set([...current, ...present])]);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus className="mr-2 h-4 w-4" /> Add a quota
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cap one parameter</DialogTitle>
          <DialogDescription>
            Pick a column, pick the values it covers, and set the limit. A contact whose value is
            blank is outside every rule on that column.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quota-dimension">Column</Label>
            <Select value={dimension} onValueChange={setDimension}>
              <SelectTrigger id="quota-dimension">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dimensions.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.header || entry.key} — {entry.distinct} value
                    {entry.distinct === 1 ? "" : "s"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {column && (
            <div className="space-y-2">
              <Label>Values</Label>
              <div className="max-h-56 space-y-1 overflow-y-auto border border-border/50 p-2">
                {column.values.map((value) => (
                  <label
                    key={value.value}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-foreground/[0.04]"
                  >
                    <Checkbox
                      checked={selected.includes(value.value)}
                      onCheckedChange={(checked) => {
                        setSelected((current) =>
                          checked
                            ? [...new Set([...current, value.value])]
                            : current.filter((entry) => entry !== value.value),
                        );
                        if (checked) suggestSiblings(value.value);
                      }}
                    />
                    <span className="flex-1 truncate">{value.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {value.count.toLocaleString()}
                    </span>
                  </label>
                ))}
              </div>
              <p className="font-mono text-[10px] text-muted-foreground">
                Selecting an Australian state also ticks the other spellings your list uses for it —
                nothing in your data is rewritten, the rule simply covers both.
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="quota-day"
              label="At most, per day"
              value={perDay}
              onChange={setPerDay}
              placeholder="e.g. 20"
            />
            <Field
              id="quota-total"
              label="At most, in total"
              value={total}
              onChange={setTotal}
              placeholder="optional"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={selected.length === 0 || (!perDay.trim() && !total.trim()) || save.isPending}
          >
            Add quota
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Audience ────────────────────────────────────────────────────────────────

function AudiencePanel({
  campaignId,
  imports,
}: {
  campaignId: string;
  imports: Record<string, unknown>[];
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [status, setStatus] = useState<string>("all");
  const [search, setSearch] = useState("");

  const lists = useQuery({ queryKey: ["email", "lists"], queryFn: () => listLists({ data: {} }) });
  const recipients = useQuery({
    queryKey: ["email", "recipients", campaignId, status, search],
    queryFn: () =>
      listRecipients({
        data: { campaignId, status: status as never, search, limit: 200 },
      }),
  });

  const attach = useMutation({
    mutationFn: (listId: string) => attachListToCampaign({ data: { campaignId, listId } }),
    onSuccess: (result) => {
      toast.success(`${result.imported.toLocaleString()} contacts added`, {
        description:
          `${result.skippedDuplicate.toLocaleString()} already in this campaign · ` +
          `${result.skippedSuppressed.toLocaleString()} on the do-not-send register`,
      });
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) =>
      toast.error("Could not attach the list", { description: error.message }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelRecipient({ data: { id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["email"] }),
    onError: (error: Error) => toast.error(error.message),
  });

  const release = useMutation({
    mutationFn: (id: string) => releaseUnconfirmed({ data: { id } }),
    onSuccess: () => {
      toast.success("Back in the queue");
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const attached = new Set(imports.map((row) => row.list_id as string));

  return (
    <div className="space-y-6">
      <div className="glass space-y-4 p-5">
        <p className="label-mono">attach a list</p>
        <div className="space-y-2">
          {(lists.data ?? []).length === 0 && (
            <p className="font-mono text-[11px] text-muted-foreground">
              No lists yet — upload one from the Contact lists tab on the campaigns page.
            </p>
          )}
          {(lists.data ?? []).map((list) => (
            <div key={list.id as string} className="glass-inset flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{list.name as string}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {(list.contact_count as number).toLocaleString()} contacts ·{" "}
                  {list.source_format as string}
                </p>
              </div>
              {attached.has(list.id as string) && (
                <Badge variant="secondary" className="font-mono text-[10px]">
                  attached
                </Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={list.status !== "ready" || attach.isPending}
                onClick={() => attach.mutate(list.id as string)}
              >
                {attached.has(list.id as string) ? "Re-import" : "Attach"}
              </Button>
            </div>
          ))}
        </div>
        {imports.length > 0 && (
          <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
            {imports.map((row) => (
              <p key={row.id as string}>
                {(row.list_name as string | null) ?? "a list"} ·{" "}
                {(row.imported as number).toLocaleString()} added ·{" "}
                {(row.skipped_duplicate as number).toLocaleString()} already here ·{" "}
                {(row.skipped_suppressed as number).toLocaleString()} on the register ·{" "}
                {formatDistanceToNow(new Date(row.created_at as string), { addSuffix: true })}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find an address"
          className="max-w-xs"
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every status</SelectItem>
            <SelectItem value="pending">Waiting</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="failed">Refused</SelectItem>
            <SelectItem value="unconfirmed">Unconfirmed</SelectItem>
            <SelectItem value="suppressed">Held</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        {(recipients.data ?? []).map((recipient) => (
          <RecordRow
            key={recipient.id as string}
            spine={RECIPIENT_SPINE[recipient.status as string] ?? "idle"}
            className="flex items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{recipient.email as string}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {recipient.status as string}
                {recipient.sent_at
                  ? ` · ${format(new Date(recipient.sent_at as string), "d MMM, h:mm a")}`
                  : ""}
                {recipient.last_error ? ` · ${recipient.last_error}` : ""}
                {recipient.suppressed_reason ? ` · ${recipient.suppressed_reason}` : ""}
              </p>
            </div>
            {recipient.status === "unconfirmed" || recipient.status === "failed" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const ok = await confirm({
                    title:
                      recipient.status === "unconfirmed"
                        ? "Send to this contact again?"
                        : "Put this contact back in the queue?",
                    description:
                      recipient.status === "unconfirmed"
                        ? "The first attempt left without an answer, so this message may already have arrived. Releasing it accepts the chance of a second copy in exchange for the certainty of a first."
                        : "The message was refused before it was accepted, so nothing was sent.",
                    confirmText: "Queue it",
                  });
                  if (ok) release.mutate(recipient.id as string);
                }}
              >
                Retry
              </Button>
            ) : null}
            {recipient.status === "pending" || recipient.status === "suppressed" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => cancel.mutate(recipient.id as string)}
              >
                <X className="h-3 w-3" />
              </Button>
            ) : null}
          </RecordRow>
        ))}
        {!recipients.isLoading && (recipients.data ?? []).length === 0 && (
          <EmptyState
            icon={<AlertTriangle className="h-6 w-6" />}
            title="Nothing here"
            description="Attach a list above, or widen the filter."
          />
        )}
      </div>
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

function ActivityPanel({ messages }: { messages: Record<string, unknown>[] }) {
  if (messages.length === 0) {
    return (
      <EmptyState
        icon={<Send className="h-6 w-6" />}
        title="Nothing sent yet"
        description="Every message this campaign hands to Microsoft Graph is recorded here, including the ones it refused."
      />
    );
  }
  return (
    <div className="space-y-2">
      {messages.map((message) => (
        <RecordRow
          key={message.id as string}
          spine={
            message.status === "sent"
              ? "ok"
              : message.status === "failed"
                ? "bad"
                : message.status === "unconfirmed"
                  ? "warn"
                  : "live"
          }
          className="flex items-center gap-3 px-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{message.subject as string}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {message.status as string} · {(message.recipient_count as number).toLocaleString()}{" "}
              contact{message.recipient_count === 1 ? "" : "s"}
              {message.bcc_count ? ` (${message.bcc_count} bcc)` : ""}
              {message.sent_at
                ? ` · ${formatDistanceToNow(new Date(message.sent_at as string), { addSuffix: true })}`
                : ` · queued ${formatDistanceToNow(new Date(message.queued_at as string), { addSuffix: true })}`}
              {message.duration_ms ? ` · ${message.duration_ms}ms` : ""}
              {message.error ? ` · ${message.error}` : ""}
            </p>
          </div>
          {message.graph_status ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              {message.graph_status as number}
            </Badge>
          ) : null}
        </RecordRow>
      ))}
    </div>
  );
}
