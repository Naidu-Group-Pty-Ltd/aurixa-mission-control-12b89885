// The do-not-send register: every address this deployment will not mail, and
// the mailbox scan that keeps it current.
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { ArrowLeft, Plus, ShieldOff, Trash2 } from "lucide-react";
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
import {
  addSuppression,
  listBounceScans,
  listSuppressions,
  removeSuppression,
} from "@/lib/email-campaigns.functions";

export const Route = createFileRoute("/email/suppressions")({
  component: () => (
    <ProtectedRoute>
      <SuppressionsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Do-not-send register — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Every address this deployment will not mail: hard bounces read out of the sending mailbox, unsubscribes, complaints and addresses an operator added by hand.",
      },
      { property: "og:title", content: "Do-not-send register — Aurixa Mission Control" },
      { property: "og:description", content: "The addresses no campaign may reach." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const REASON_SPINE: Record<string, SpineTone> = {
  bounced: "bad",
  complaint: "bad",
  unsubscribed: "idle",
  invalid: "warn",
  manual: "idle",
};

function SuppressionsPage() {
  const qc = useQueryClient();
  const [reason, setReason] = useState("all");
  const [search, setSearch] = useState("");

  const register = useQuery({
    queryKey: ["email", "suppressions", reason, search],
    queryFn: () => listSuppressions({ data: { reason: reason as never, search, limit: 500 } }),
  });
  const scans = useQuery({
    queryKey: ["email", "bounce-scans"],
    queryFn: () => listBounceScans({ data: {} }),
    refetchInterval: 60_000,
  });

  const remove = useMutation({
    mutationFn: (emailKey: string) =>
      removeSuppression({ data: { emailKey, reason: "removed from the console" } }),
    onSuccess: () => {
      toast.success("Removed from the register");
      void qc.invalidateQueries({ queryKey: ["email", "suppressions"] });
    },
    onError: (error: Error) =>
      toast.error("Could not remove it", {
        description: `${error.message} — removing an address is an admin's act, because it is the one thing here that can put mail back on the wire to an address a server has already rejected.`,
      }),
  });

  const rows = register.data ?? [];
  const byReason = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.reason as string;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const latestScan = (scans.data ?? [])[0];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow={
          <Link to="/email" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-3 w-3" /> email campaigns
          </Link>
        }
        title="Do-not-send register"
        description="One list, global across every campaign. A hard bounce read out of the sending mailbox lands here automatically; so does an unsubscribe. Soft failures — a full mailbox, a greylist — deliberately do not, because an afternoon is not a wrong address."
        actions={
          <>
            <RefreshButton
              onRefresh={() => qc.invalidateQueries({ queryKey: ["email"] })}
              loading={register.isFetching}
              lastUpdated={register.dataUpdatedAt ? new Date(register.dataUpdatedAt) : null}
            />
            <AddSuppressionDialog />
          </>
        }
      />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-5">
        <MetricCell label="on the register" value={rows.length.toLocaleString()} />
        <MetricCell label="bounced" value={(byReason.bounced ?? 0).toLocaleString()} />
        <MetricCell label="unsubscribed" value={(byReason.unsubscribed ?? 0).toLocaleString()} />
        <MetricCell
          label="complaints"
          value={(byReason.complaint ?? 0).toLocaleString()}
          tone="destructive"
          alarm={(byReason.complaint ?? 0) > 0}
        />
        <MetricCell
          label="last scan"
          size="sm"
          value={
            latestScan
              ? formatDistanceToNow(new Date(latestScan.started_at as string), { addSuffix: true })
              : "never"
          }
          tone="warning"
          alarm={!latestScan}
          note={latestScan ? (latestScan.status as string) : "no mailbox scan on record"}
        />
      </div>

      <Tabs defaultValue="register">
        <TabsList>
          <TabsTrigger value="register">Addresses</TabsTrigger>
          <TabsTrigger value="scans">Mailbox scans</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find an address"
              className="max-w-xs"
            />
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every reason</SelectItem>
                <SelectItem value="bounced">Bounced</SelectItem>
                <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
                <SelectItem value="complaint">Complaint</SelectItem>
                <SelectItem value="invalid">Invalid</SelectItem>
                <SelectItem value="manual">Added by hand</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {rows.length === 0 && !register.isLoading ? (
            <EmptyState
              icon={<ShieldOff className="h-6 w-6" />}
              title="Nothing on the register"
              description="Nobody has bounced or unsubscribed yet. Addresses arrive here on their own — the mailbox scan runs every fifteen minutes."
            />
          ) : (
            <div className="space-y-2">
              {rows.map((row) => (
                <RecordRow
                  key={row.email_key as string}
                  spine={REASON_SPINE[row.reason as string] ?? "idle"}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{row.email as string}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {row.reason as string} · via {row.source as string} ·{" "}
                      {formatDistanceToNow(new Date(row.last_seen_at as string), {
                        addSuffix: true,
                      })}
                      {(row.occurrences as number) > 1 ? ` · seen ${row.occurrences} times` : ""}
                      {row.detail ? ` · ${row.detail}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="font-mono text-[10px] uppercase">
                    {row.reason as string}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove.mutate(row.email_key as string)}
                    title="Remove from the register (admins only)"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </RecordRow>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="scans" className="mt-4 space-y-2">
          <div className="glass-inset px-4 py-3">
            <p className="text-sm text-muted-foreground">
              Microsoft Graph raises no callback when a message fails downstream — the failure comes
              back as an ordinary message in the sending mailbox. This pass reads it. An address is
              only ever put on the register when a campaign here actually sent to it, so a bounce
              quoting somebody else's addresses cannot suppress them.
            </p>
          </div>
          {(scans.data ?? []).length === 0 ? (
            <EmptyState
              icon={<ShieldOff className="h-6 w-6" />}
              title="No scan has run yet"
              description="It runs every fifteen minutes once a mailbox is configured."
            />
          ) : (
            (scans.data ?? []).map((scan) => (
              <RecordRow
                key={scan.id as string}
                spine={scan.status === "ok" ? "ok" : scan.status === "failed" ? "bad" : "live"}
                className="flex items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{scan.mailbox as string}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {scan.status as string} · {(scan.messages_examined as number).toLocaleString()}{" "}
                    messages · {(scan.reports_found as number).toLocaleString()} reports ·{" "}
                    {(scan.addresses_suppressed as number).toLocaleString()} suppressed ·{" "}
                    {(scan.soft_failures as number).toLocaleString()} soft ·{" "}
                    {formatDistanceToNow(new Date(scan.started_at as string), { addSuffix: true })}
                    {scan.error ? ` · ${scan.error}` : ""}
                  </p>
                </div>
              </RecordRow>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AddSuppressionDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("manual");
  const [detail, setDetail] = useState("");

  const add = useMutation({
    mutationFn: () =>
      addSuppression({
        data: {
          email,
          reason: reason as "bounced" | "complaint" | "unsubscribed" | "invalid" | "manual",
          detail: detail || null,
        },
      }),
    onSuccess: () => {
      toast.success("Added to the register", {
        description: "Every campaign that has not yet mailed this address will now skip it.",
      });
      setOpen(false);
      setEmail("");
      setDetail("");
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" /> Add an address
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Never mail this address</DialogTitle>
          <DialogDescription>
            Applies immediately and to every campaign, including ones that have not started.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="suppress-email">Address</Label>
            <Input
              id="suppress-email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="someone@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="suppress-reason">Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id="suppress-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Asked us to stop</SelectItem>
                <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
                <SelectItem value="complaint">Complained</SelectItem>
                <SelectItem value="bounced">Bounced</SelectItem>
                <SelectItem value="invalid">Not a real address</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="suppress-detail">Note</Label>
            <Input
              id="suppress-detail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              placeholder="optional"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => add.mutate()} disabled={!email.trim() || add.isPending}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
