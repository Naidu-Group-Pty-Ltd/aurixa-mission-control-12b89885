// The email scheduler's front door: every campaign, every uploaded list, and
// whether this deployment can send at all.
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Mail,
  Plus,
  ShieldOff,
  Trash2,
  Users,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { RefreshButton } from "@/components/refresh-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { ListDropzone } from "@/components/email/list-dropzone";
import {
  createCampaign,
  deleteList,
  listCampaigns,
  listLists,
  mailboxStatus,
} from "@/lib/email-campaigns.functions";

export const Route = createFileRoute("/email/")({
  component: () => (
    <ProtectedRoute>
      <EmailCampaignsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Email Campaigns — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Scheduled email campaigns: upload a contact list, set the rules and per-parameter quotas, and send through Microsoft Graph.",
      },
      { property: "og:title", content: "Email Campaigns — Aurixa Mission Control" },
      { property: "og:description", content: "The email scheduler." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const STATUS_SPINE: Record<string, SpineTone> = {
  draft: "idle",
  running: "live",
  paused: "warn",
  completed: "ok",
  cancelled: "idle",
};

function EmailCampaignsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();

  const campaignsQuery = useQuery({
    queryKey: ["email", "campaigns"],
    queryFn: () => listCampaigns({ data: {} }),
    refetchInterval: 20_000,
  });
  const listsQuery = useQuery({
    queryKey: ["email", "lists"],
    queryFn: () => listLists({ data: {} }),
  });
  const mailboxQuery = useQuery({
    queryKey: ["email", "mailbox"],
    queryFn: () => mailboxStatus(),
    staleTime: 60_000,
  });

  const removeList = useMutation({
    mutationFn: (id: string) => deleteList({ data: { id } }),
    onSuccess: () => {
      toast.success("List deleted");
      void qc.invalidateQueries({ queryKey: ["email", "lists"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const campaigns = campaignsQuery.data ?? [];
  const lists = listsQuery.data ?? [];
  const mailbox = mailboxQuery.data;

  const totals = campaigns.reduce(
    (acc, campaign) => {
      const counts = (campaign.counts ?? {}) as Record<string, number>;
      acc.sent += counts.sent ?? 0;
      acc.pending += counts.pending ?? 0;
      acc.failed += (counts.failed ?? 0) + (counts.unconfirmed ?? 0);
      acc.suppressed += counts.suppressed ?? 0;
      if (campaign.status === "running") acc.running += 1;
      return acc;
    },
    { sent: 0, pending: 0, failed: 0, suppressed: 0, running: 0 },
  );

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="outbound email"
        title="Email Campaigns"
        description="Upload a contact list, set how fast it goes and who gets how much of it, and let the dispatcher work through it. Nobody is mailed twice for one campaign, and nobody who has bounced is mailed at all."
        actions={
          <>
            <RefreshButton
              onRefresh={() => qc.invalidateQueries({ queryKey: ["email"] })}
              loading={campaignsQuery.isFetching || listsQuery.isFetching}
              lastUpdated={
                campaignsQuery.dataUpdatedAt ? new Date(campaignsQuery.dataUpdatedAt) : null
              }
            />
            <Button variant="outline" asChild>
              <Link to="/email/suppressions">
                <ShieldOff className="mr-2 h-4 w-4" />
                Do-not-send register
              </Link>
            </Button>
            <NewCampaignDialog />
          </>
        }
      />

      <MailboxStrip status={mailbox} loading={mailboxQuery.isLoading} />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-5">
        <MetricCell label="campaigns" value={campaigns.length} />
        <MetricCell label="running" value={totals.running} />
        <MetricCell label="sent" value={totals.sent.toLocaleString()} />
        <MetricCell label="waiting" value={totals.pending.toLocaleString()} />
        <MetricCell
          label="not delivered"
          value={totals.failed.toLocaleString()}
          tone="warning"
          alarm={totals.failed > 0}
        />
      </div>

      <Tabs defaultValue="campaigns">
        <TabsList>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="lists">Contact lists</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="mt-4 space-y-2">
          {!campaignsQuery.isLoading && campaigns.length === 0 && (
            <EmptyState
              icon={<Mail className="h-6 w-6" />}
              title="No campaigns yet"
              description="Create one, attach a list, write the message and set the rules. Nothing sends until you start it."
              action={<NewCampaignDialog />}
            />
          )}
          {campaigns.map((campaign) => {
            const counts = (campaign.counts ?? {}) as Record<string, number>;
            const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
            return (
              <RecordRow
                key={campaign.id as string}
                spine={STATUS_SPINE[campaign.status as string] ?? "idle"}
                className="flex items-center gap-3 px-4 py-3"
              >
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <Link
                    to="/email/campaigns/$campaignId"
                    params={{ campaignId: campaign.id as string }}
                    className="truncate text-sm font-medium hover:underline"
                  >
                    {campaign.name as string}
                  </Link>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {campaign.status as string}
                    {` · ${(counts.sent ?? 0).toLocaleString()} of ${total.toLocaleString()} sent`}
                    {counts.pending ? ` · ${counts.pending.toLocaleString()} waiting` : ""}
                    {counts.suppressed ? ` · ${counts.suppressed.toLocaleString()} held` : ""}
                    {campaign.last_message_at
                      ? ` · last sent ${formatDistanceToNow(new Date(campaign.last_message_at as string), { addSuffix: true })}`
                      : ""}
                  </p>
                </div>
                {counts.unconfirmed ? (
                  <Badge variant="outline" className="text-warning">
                    {counts.unconfirmed} unconfirmed
                  </Badge>
                ) : null}
                <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                  {campaign.status as string}
                </Badge>
              </RecordRow>
            );
          })}
        </TabsContent>

        <TabsContent value="lists" className="mt-4 space-y-4">
          <ListDropzone
            onUploaded={() => {
              void qc.invalidateQueries({ queryKey: ["email", "lists"] });
            }}
          />

          {lists.length === 0 && !listsQuery.isLoading ? (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="No contact lists yet"
              description="Drop a spreadsheet above. The columns it carries become the parameters you can set quotas on."
            />
          ) : (
            <div className="space-y-2">
              {lists.map((list) => (
                <RecordRow
                  key={list.id as string}
                  spine={list.status === "ready" ? "ok" : list.status === "failed" ? "bad" : "idle"}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{list.name as string}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {(list.contact_count as number).toLocaleString()} contacts
                      {list.duplicate_count
                        ? ` · ${(list.duplicate_count as number).toLocaleString()} duplicates dropped`
                        : ""}
                      {list.invalid_count
                        ? ` · ${(list.invalid_count as number).toLocaleString()} unreadable`
                        : ""}
                      {list.source_format ? ` · ${list.source_format}` : ""}
                      {` · added ${formatDistanceToNow(new Date(list.created_at as string), { addSuffix: true })}`}
                      {list.parse_error ? ` · ${list.parse_error}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete this list?",
                        description:
                          "The parsed contacts go with it. Recipients already imported into a campaign stay — they are that campaign's own record of who it has mailed.",
                        confirmText: "Delete",
                        destructive: true,
                      });
                      if (ok) removeList.mutate(list.id as string);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </RecordRow>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MailboxStrip({
  status,
  loading,
}: {
  status:
    | { configured: boolean; mailbox: string | null; reachable: boolean; detail: string | null }
    | undefined;
  loading: boolean;
}) {
  if (loading || !status) return null;

  if (!status.configured) {
    return (
      <div className="glass-inset spine spine-bad flex items-start gap-3 px-4 py-3">
        <Ban className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">No mailbox is configured.</span> Set{" "}
          <code className="font-mono text-xs">MICROSOFT_TENANT_ID</code>,{" "}
          <code className="font-mono text-xs">MICROSOFT_CLIENT_ID</code>,{" "}
          <code className="font-mono text-xs">MICROSOFT_CLIENT_SECRET</code> and{" "}
          <code className="font-mono text-xs">MICROSOFT_MAILBOX_EMAIL</code> on this deployment —
          the same application registration the property dashboard sends from. Campaigns can be
          written and lists uploaded meanwhile; nothing will send.
        </p>
      </div>
    );
  }

  return (
    <div className={cnSpine(status.reachable)}>
      {status.reachable ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      )}
      <p className="text-sm text-muted-foreground">
        {status.reachable ? (
          <>
            Sending as <span className="text-foreground">{status.mailbox}</span>
            {status.detail ? ` (${status.detail})` : ""} through Microsoft Graph.
          </>
        ) : (
          <>
            <span className="text-foreground">{status.mailbox ?? "The mailbox"}</span> could not be
            reached: {status.detail ?? "no detail"}.
          </>
        )}
      </p>
    </div>
  );
}

function cnSpine(ok: boolean): string {
  return `glass-inset spine ${ok ? "spine-ok" : "spine-warn"} flex items-start gap-3 px-4 py-3`;
}

function NewCampaignDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () => createCampaign({ data: { name, description: description || null } }),
    onSuccess: () => {
      toast.success("Campaign created");
      setOpen(false);
      setName("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: ["email", "campaigns"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New campaign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            It starts as a draft. Nothing is sent until you attach a list, write the message and
            start it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="campaign-name">Name</Label>
            <Input
              id="campaign-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="September investor update"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="campaign-description">What it is for</Label>
            <Textarea
              id="campaign-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
