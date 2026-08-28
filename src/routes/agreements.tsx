// Agreements — Service Level Agreements for leads who convert into clients.
// The operator raises an agreement (usually against a CRM contact), sends it
// for signature via DocuSign, and tracks it draft → sent → delivered →
// signed / declined / voided. Until the DocuSign secrets exist the page says
// exactly what is missing; drafts can still be prepared.
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { MonoStatus } from "@/components/voice/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  AGREEMENT_STATUSES,
  SERVICE_TIERS,
  createAgreement,
  deleteDraftAgreement,
  downloadSignedAgreement,
  getAgreementsConfig,
  listAgreements,
  provisionAgreementNow,
  refreshAgreementStatus,
  searchAgreementClients,
  sendAgreement,
  voidAgreement,
  type AgreementRow,
} from "@/lib/agreements.functions";
import { AgreementProvisioningDialog } from "@/components/agreement-provisioning-dialog";
import {
  Download,
  FileSignature,
  Plus,
  RefreshCw,
  Rocket,
  Send,
  Settings2,
  Trash2,
  XCircle,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/agreements")({
  component: () => (
    <ProtectedRoute>
      <AgreementsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Agreements — Aurixa Mission Control" },
      {
        name: "description",
        content: "Service Level Agreements: raised for converted leads, signed via DocuSign.",
      },
      { property: "og:title", content: "Agreements — Aurixa Mission Control" },
      { property: "og:description", content: "SLA lifecycle for Aurixa clients." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const STATUS_SPINE: Record<string, SpineTone> = {
  draft: "idle",
  sent: "live",
  delivered: "live",
  signed: "ok",
  declined: "bad",
  voided: "warn",
};

const STATUS_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "destructive"> = {
  draft: "neutral",
  sent: "info",
  delivered: "info",
  signed: "success",
  declined: "destructive",
  voided: "warning",
};

function AgreementsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<AgreementRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [provisionTarget, setProvisionTarget] = useState<AgreementRow | null>(null);

  const configQ = useQuery({
    queryKey: ["agreements", "config"],
    queryFn: () => getAgreementsConfig(),
    staleTime: 5 * 60_000,
  });
  const listQ = useQuery({
    queryKey: ["agreements", "list", statusFilter, search],
    queryFn: () =>
      listAgreements({
        data: { status: statusFilter as "all", search },
      }),
    refetchInterval: 60_000,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["agreements", "list"] });

  const sendM = useMutation({
    mutationFn: (id: string) => sendAgreement({ data: { id } }),
    onSuccess: () => {
      toast.success("Agreement sent for signature");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message, { duration: 12_000 }),
  });
  const refreshM = useMutation({
    mutationFn: (id: string) => refreshAgreementStatus({ data: { id } }),
    onSuccess: (r) => {
      toast.success(`DocuSign status: ${r.docusignStatus}`);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const downloadM = useMutation({
    mutationFn: (id: string) => downloadSignedAgreement({ data: { id } }),
    onSuccess: (r) => {
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const voidM = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      voidAgreement({ data: { id, reason } }),
    onSuccess: () => {
      toast.success("Envelope voided");
      setVoidTarget(null);
      setVoidReason("");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => deleteDraftAgreement({ data: { id } }),
    onSuccess: () => {
      toast.success("Draft deleted");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const provisionM = useMutation({
    mutationFn: (id: string) => provisionAgreementNow({ data: { id } }),
    onSuccess: (res) => {
      if (res && "cloneId" in res && res.cloneId) {
        toast.success("Clone provisioned — backend is queued for the worker");
      } else if (res && "skipped" in res && res.skipped) {
        toast.info(`Not provisioned: ${res.detail}`);
      } else if (res && "error" in res) {
        toast.error(res.error);
      }
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const agreements = listQ.data?.agreements ?? [];
  const counts = useMemo(() => {
    const c = { draft: 0, out: 0, signed: 0, declined: 0, voided: 0 };
    for (const a of agreements) {
      if (a.status === "draft") c.draft += 1;
      else if (a.status === "sent" || a.status === "delivered") c.out += 1;
      else if (a.status === "signed") c.signed += 1;
      else if (a.status === "declined") c.declined += 1;
      else if (a.status === "voided") c.voided += 1;
    }
    return c;
  }, [agreements]);

  const configured = configQ.data?.configured ?? false;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="client operations"
        title="Agreements"
        description="Service Level Agreements for converted leads — raised here, signed via DocuSign, retained on the client record."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New agreement
          </Button>
        }
      />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-5">
        <MetricCell label="drafts" value={counts.draft} />
        <MetricCell label="awaiting signature" value={counts.out} />
        <MetricCell label="signed" value={counts.signed} tone="success" />
        <MetricCell
          label="declined"
          value={counts.declined}
          tone="destructive"
          alarm={counts.declined > 0}
        />
        <MetricCell label="voided" value={counts.voided} />
      </div>

      {configQ.data && !configured && (
        <div className="glass border border-amber-500/40 p-4">
          <p className="text-sm font-medium text-foreground">
            DocuSign is not connected yet — agreements can be drafted but not sent.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add these Worker secrets and sending comes alive without a code change:{" "}
            <span className="font-mono text-xs">{configQ.data.missing.join(", ")}</span>. The setup
            runbook (integration key, RSA keypair, one-time consent) is in{" "}
            <span className="font-mono text-xs">docs/agreements.md</span>.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {AGREEMENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email or organisation…"
          className="w-72"
        />
        <a
          href="/agreements/aurixa-sla-template.pdf"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          View the SLA template
        </a>
      </div>

      <div className="glass overflow-hidden">
        {listQ.isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : agreements.length === 0 ? (
          <EmptyState
            icon={<FileSignature className="h-8 w-8" />}
            title="No agreements yet"
            description="Raise a Service Level Agreement for a converted lead and send it for signature."
          />
        ) : (
          <div className="divide-y divide-border/40">
            {agreements.map((a) => (
              <RecordRow
                key={a.id}
                spine={STATUS_SPINE[a.status] ?? "idle"}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{a.client_name}</p>
                    {a.client_org && (
                      <Badge variant="outline" className="max-w-40 truncate">
                        {a.client_org}
                      </Badge>
                    )}
                    {a.service_tier && <Badge variant="secondary">{a.service_tier}</Badge>}
                    {a.plan_slug && <Badge variant="outline">plan: {a.plan_slug}</Badge>}
                    {a.provision_status === "armed" && (
                      <Badge
                        variant="secondary"
                        title="Signature will provision the clone automatically"
                      >
                        <Rocket className="mr-1 h-3 w-3" /> armed
                      </Badge>
                    )}
                    {a.provision_status === "provisioning" && (
                      <Badge variant="secondary">provisioning…</Badge>
                    )}
                    {a.provision_status === "provisioned" && (
                      <Badge variant="default">provisioned</Badge>
                    )}
                    {a.provision_status === "failed" && (
                      <Badge variant="destructive" title={a.provision_error ?? undefined}>
                        provisioning failed
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {a.client_email}
                    {a.commencement_date &&
                      ` · commences ${format(new Date(a.commencement_date), "d MMM yyyy")}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-right">
                  <div className="hidden sm:block">
                    <MonoStatus tone={STATUS_TONE[a.status] ?? "neutral"} label={a.status} />
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {a.docusign_signed_at
                        ? `signed ${formatDistanceToNow(new Date(a.docusign_signed_at), { addSuffix: true })}`
                        : a.docusign_sent_at
                          ? `sent ${formatDistanceToNow(new Date(a.docusign_sent_at), { addSuffix: true })}`
                          : `created ${formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}`}
                    </p>
                  </div>
                  {(a.status === "draft" || a.status === "sent" || a.status === "delivered") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Configure provisioning"
                      title="What a signature provisions: plan, modules, add-ons"
                      onClick={() => setProvisionTarget(a)}
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {a.status === "draft" && (
                    <>
                      <Button
                        size="sm"
                        disabled={!configured || sendM.isPending}
                        title={configured ? "Send for signature" : "DocuSign not configured"}
                        onClick={() => sendM.mutate(a.id)}
                      >
                        <Send className="mr-1.5 h-3.5 w-3.5" /> Send
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Delete draft"
                        disabled={deleteM.isPending}
                        onClick={() => deleteM.mutate(a.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                  {(a.status === "sent" || a.status === "delivered") && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!configured || refreshM.isPending}
                        onClick={() => refreshM.mutate(a.id)}
                      >
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!configured}
                        aria-label="Void envelope"
                        onClick={() => setVoidTarget(a)}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                  {a.status === "signed" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!configured || downloadM.isPending}
                        onClick={() => downloadM.mutate(a.id)}
                      >
                        <Download className="mr-1.5 h-3.5 w-3.5" /> Signed PDF
                      </Button>
                      {a.provision_status === "provisioned" && a.provisioned_clone_id ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link to="/clones/$cloneId" params={{ cloneId: a.provisioned_clone_id }}>
                            <Rocket className="mr-1.5 h-3.5 w-3.5" /> View clone
                          </Link>
                        </Button>
                      ) : a.provision_status !== "provisioning" ? (
                        <Button
                          size="sm"
                          disabled={provisionM.isPending}
                          title={
                            a.provision_status === "failed"
                              ? `Retry — last attempt failed: ${a.provision_error ?? "unknown"}`
                              : "Provision the clone from this agreement's selection"
                          }
                          onClick={() => provisionM.mutate(a.id)}
                        >
                          <Rocket className="mr-1.5 h-3.5 w-3.5" />
                          {a.provision_status === "failed" ? "Retry provision" : "Provision now"}
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </RecordRow>
            ))}
          </div>
        )}
      </div>

      <CreateAgreementDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={invalidate}
      />

      <AgreementProvisioningDialog
        agreement={provisionTarget}
        onOpenChange={(o) => !o && setProvisionTarget(null)}
        onSaved={invalidate}
      />

      <Dialog open={Boolean(voidTarget)} onOpenChange={(o) => !o && setVoidTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void this envelope?</DialogTitle>
            <DialogDescription>
              {voidTarget?.client_name}'s agreement will be withdrawn in DocuSign and can no longer
              be signed. The record stays here as voided.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void-reason">Reason (sent to the signer)</Label>
            <Textarea
              id="void-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Superseded by a revised agreement…"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVoidTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={voidM.isPending}
              onClick={() => voidTarget && voidM.mutate({ id: voidTarget.id, reason: voidReason })}
            >
              Void envelope
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateAgreementDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [clientSearch, setClientSearch] = useState("");
  const [contactId, setContactId] = useState<string | undefined>();
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientOrg, setClientOrg] = useState("");
  const [tier, setTier] = useState<string>("");
  const [commencement, setCommencement] = useState("");
  const [notes, setNotes] = useState("");

  const clientsQ = useQuery({
    queryKey: ["agreements", "clients", clientSearch],
    queryFn: () => searchAgreementClients({ data: { search: clientSearch } }),
    enabled: open && clientSearch.trim().length >= 2,
  });

  const reset = () => {
    setClientSearch("");
    setContactId(undefined);
    setClientName("");
    setClientEmail("");
    setClientOrg("");
    setTier("");
    setCommencement("");
    setNotes("");
  };

  const createM = useMutation({
    mutationFn: () =>
      createAgreement({
        data: {
          contactId,
          clientName: clientName.trim(),
          clientEmail: clientEmail.trim(),
          clientOrg: clientOrg.trim() || undefined,
          serviceTier: (tier || undefined) as (typeof SERVICE_TIERS)[number] | undefined,
          commencementDate: commencement || undefined,
          notes: notes.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Agreement drafted");
      reset();
      onOpenChange(false);
      onCreated();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Service Level Agreement</DialogTitle>
          <DialogDescription>
            Pick a CRM contact (or enter the signer directly). Their details are stamped into the
            Execution Schedule when the agreement is sent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agreement-client-search">Find a contact</Label>
            <Input
              id="agreement-client-search"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              placeholder="Search CRM contacts by name or email…"
            />
            {(clientsQ.data?.contacts?.length ?? 0) > 0 && (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {clientsQ.data!.contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`glass-inset flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm ${
                      contactId === c.id ? "spine spine-ok" : ""
                    }`}
                    onClick={() => {
                      setContactId(c.id);
                      setClientName(c.name);
                      setClientEmail(c.email);
                      if (c.org) setClientOrg(c.org);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">
                        {c.name || c.email}
                      </span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {c.email}
                        {c.org ? ` · ${c.org}` : ""}
                      </span>
                    </span>
                    {c.stage && <Badge variant="outline">{c.stage.replace(/_/g, " ")}</Badge>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="agreement-name">Signer name</Label>
              <Input
                id="agreement-name"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Full legal name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agreement-email">Signer email</Label>
              <Input
                id="agreement-email"
                type="email"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="agreement-org">Organisation</Label>
              <Input
                id="agreement-org"
                value={clientOrg}
                onChange={(e) => setClientOrg(e.target.value)}
                placeholder="Client Pty Ltd"
              />
            </div>
            <div className="space-y-2">
              <Label>Service tier</Label>
              <Select value={tier} onValueChange={setTier}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a tier" />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_TIERS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="agreement-commencement">Commencement date</Label>
            <Input
              id="agreement-commencement"
              type="date"
              value={commencement}
              onChange={(e) => setCommencement(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="agreement-notes">Internal notes</Label>
            <Textarea
              id="agreement-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the team should know about this engagement…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!clientName.trim() || !clientEmail.trim() || createM.isPending}
            onClick={() => createM.mutate()}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
