// Agreements — what a lead signs to become a client.
//
// Two kinds live here. A Subscription Agreement is the tier's own approved
// agreement (Launch, Growth or Scale), completed as an offer for one lead in
// the offer editor and issued through DocuSign; its signature provisions the
// workspace it sold. A Service Level Agreement is the fixed SLA PDF, stamped
// with the signer's details. Both are tracked draft → sent → delivered →
// signed / declined / voided. Until the DocuSign secrets exist the page says
// exactly what is missing; drafts can still be prepared.
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Download,
  FileSignature,
  FileText,
  Plus,
  RefreshCw,
  Rocket,
  Send,
  Settings2,
  SlidersHorizontal,
  Trash2,
  XCircle,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow } from "@/components/record-row";
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
  AGREEMENT_KINDS,
  AGREEMENT_STATUSES,
  SERVICE_TIERS,
  createAgreement,
  deleteDraftAgreement,
  downloadSignedAgreement,
  getAgreementsConfig,
  getSubscriptionContext,
  listAgreements,
  provisionAgreementNow,
  refreshAgreementStatus,
  searchAgreementClients,
  sendAgreement,
  voidAgreement,
  type AgreementListRow,
} from "@/lib/agreements.functions";
import { AgreementProvisioningDialog } from "@/components/agreement-provisioning-dialog";
import { NewSubscriptionDialog } from "@/components/agreements/new-subscription-dialog";
import { issuingProfileGaps } from "@/lib/agreements/offerEditor.pure";
import { agreementState } from "@/lib/agreements/agreementState.pure";
import { PDF_MIME, saveBase64File } from "@/lib/agreements/saveFile";
import { SUBSCRIPTION_TEMPLATES } from "@/lib/agreements/subscriptionTemplates";

export const Route = createFileRoute("/agreements/")({
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
        content:
          "Subscription Agreements and Service Level Agreements: prepared for leads, signed via DocuSign.",
      },
      { property: "og:title", content: "Agreements — Aurixa Mission Control" },
      {
        property: "og:description",
        content: "Subscription and SLA lifecycle for Aurixa clients.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const KIND_LABEL: Record<(typeof AGREEMENT_KINDS)[number], string> = {
  subscription: "Subscription",
  sla: "Service level",
};

function AgreementsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<AgreementListRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [provisionTarget, setProvisionTarget] = useState<AgreementListRow | null>(null);

  const configQ = useQuery({
    queryKey: ["agreements", "config"],
    queryFn: () => getAgreementsConfig(),
    staleTime: 5 * 60_000,
  });
  const contextQ = useQuery({
    queryKey: ["agreements", "subscription-context"],
    queryFn: () => getSubscriptionContext(),
    staleTime: 60_000,
  });
  const listQ = useQuery({
    queryKey: ["agreements", "list", statusFilter, kindFilter, search],
    queryFn: () =>
      listAgreements({
        data: {
          status: statusFilter as "all",
          kind: kindFilter as "all",
          search,
        },
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
    onSuccess: (r) => saveBase64File(r.base64, r.filename, PDF_MIME),
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

  const agreements = useMemo(() => listQ.data?.agreements ?? [], [listQ.data]);
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
  const requiredProfileGaps = contextQ.data
    ? issuingProfileGaps(contextQ.data.profile).filter((g) => g.weight === "required")
    : [];

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="client operations"
        title="Agreements"
        description="Subscription Agreements and Service Level Agreements for leads — prepared here, signed via DocuSign, retained on the client record."
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/agreements/issuing-profile">
                <SlidersHorizontal className="mr-2 h-4 w-4" /> Issuing profile
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> New SLA
            </Button>
            <Button onClick={() => setOfferOpen(true)}>
              <FileSignature className="mr-2 h-4 w-4" /> New Subscription Agreement
            </Button>
          </>
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
        <div className="glass spine spine-warn p-4">
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

      {requiredProfileGaps.length > 0 && (
        <div className="glass spine spine-warn flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              The issuing profile is missing {requiredProfileGaps.length}{" "}
              {requiredProfileGaps.length === 1 ? "fact" : "facts"} every Subscription Agreement
              prints.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Offers can be prepared now, but each one carries the same gaps until an administrator
              completes the profile — or they are typed into the offer by hand.
            </p>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to="/agreements/issuing-profile">Complete the profile</Link>
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger className="w-44" aria-label="Kind">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agreements</SelectItem>
            {AGREEMENT_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44" aria-label="Status">
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
          placeholder="Search name, email, organisation or offer…"
          className="w-80"
          aria-label="Search agreements"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="label-mono">templates</span>
          {Object.values(SUBSCRIPTION_TEMPLATES).map((t) => (
            <a
              key={t.tier}
              href={t.path}
              className="underline underline-offset-4 hover:text-foreground"
              title={`The approved ${t.tierName} Subscription Agreement, blank (${t.version})`}
            >
              {t.tierName}
            </a>
          ))}
          <a
            href="/agreements/aurixa-sla-template.pdf"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            SLA
          </a>
        </div>
      </div>

      <div className="glass overflow-hidden">
        {listQ.isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : listQ.error ? (
          <div className="p-8 text-center text-sm text-destructive">
            The agreements could not be loaded: {(listQ.error as Error).message}
          </div>
        ) : agreements.length === 0 ? (
          <EmptyState
            icon={<FileSignature className="h-8 w-8" />}
            title="No agreements yet"
            description="Prepare a Subscription Agreement for a lead — choose the tier, complete the offer, and send it for signature."
          />
        ) : (
          <div className="divide-y divide-border/40">
            {agreements.map((a) =>
              a.document_kind === "subscription" ? (
                <SubscriptionRow
                  key={a.id}
                  a={a}
                  configured={configured}
                  busy={{
                    delete: deleteM.isPending,
                    refresh: refreshM.isPending,
                    download: downloadM.isPending,
                    provision: provisionM.isPending,
                  }}
                  onDelete={() => deleteM.mutate(a.id)}
                  onRefresh={() => refreshM.mutate(a.id)}
                  onVoid={() => setVoidTarget(a)}
                  onDownload={() => downloadM.mutate(a.id)}
                  onProvision={() => provisionM.mutate(a.id)}
                />
              ) : (
                <SlaRow
                  key={a.id}
                  a={a}
                  configured={configured}
                  busy={{
                    send: sendM.isPending,
                    delete: deleteM.isPending,
                    refresh: refreshM.isPending,
                    download: downloadM.isPending,
                    provision: provisionM.isPending,
                  }}
                  onConfigure={() => setProvisionTarget(a)}
                  onSend={() => sendM.mutate(a.id)}
                  onDelete={() => deleteM.mutate(a.id)}
                  onRefresh={() => refreshM.mutate(a.id)}
                  onVoid={() => setVoidTarget(a)}
                  onDownload={() => downloadM.mutate(a.id)}
                  onProvision={() => provisionM.mutate(a.id)}
                />
              ),
            )}
          </div>
        )}
      </div>

      <NewSubscriptionDialog open={offerOpen} onOpenChange={setOfferOpen} />

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
              {voidTarget?.client_org || voidTarget?.client_name}'s{" "}
              {voidTarget?.document_kind === "subscription"
                ? `offer ${voidTarget.offer_reference ?? ""}`
                : "agreement"}{" "}
              will be withdrawn in DocuSign and can no longer be signed. The record stays here as
              voided.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void-reason">Reason (sent to the signer)</Label>
            <Textarea
              id="void-reason"
              value={voidReason}
              maxLength={500}
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

/* ───────────────────────────── rows ───────────────────────────── */

function when(a: AgreementListRow): string {
  if (a.docusign_signed_at)
    return `signed ${formatDistanceToNow(new Date(a.docusign_signed_at), { addSuffix: true })}`;
  if (a.docusign_sent_at)
    return `sent ${formatDistanceToNow(new Date(a.docusign_sent_at), { addSuffix: true })}`;
  return `prepared ${formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}`;
}

function ProvisionWord({ a }: { a: AgreementListRow }) {
  const map: Record<string, { label: string; tone: "info" | "success" | "destructive" }> = {
    armed: { label: "armed", tone: "info" },
    provisioning: { label: "provisioning", tone: "info" },
    provisioned: { label: "provisioned", tone: "success" },
    failed: { label: "provisioning failed", tone: "destructive" },
  };
  const m = map[a.provision_status];
  if (!m) return null;
  return (
    <span title={a.provision_status === "failed" ? (a.provision_error ?? undefined) : undefined}>
      <MonoStatus label={m.label} tone={m.tone} pulse={a.provision_status === "provisioning"} />
    </span>
  );
}

function SignedActions({
  a,
  configured,
  busy,
  onDownload,
  onProvision,
}: {
  a: AgreementListRow;
  configured: boolean;
  busy: { download: boolean; provision: boolean };
  onDownload: () => void;
  onProvision: () => void;
}) {
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={(!configured && !a.signed_record_path) || busy.download}
        onClick={onDownload}
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
          disabled={busy.provision}
          title={
            a.provision_status === "failed"
              ? `Retry — last attempt failed: ${a.provision_error ?? "unknown"}`
              : "Provision the clone from this agreement's selection"
          }
          onClick={onProvision}
        >
          <Rocket className="mr-1.5 h-3.5 w-3.5" />
          {a.provision_status === "failed" ? "Retry provision" : "Provision now"}
        </Button>
      ) : null}
    </>
  );
}

function SubscriptionRow({
  a,
  configured,
  busy,
  onDelete,
  onRefresh,
  onVoid,
  onDownload,
  onProvision,
}: {
  a: AgreementListRow;
  configured: boolean;
  busy: { delete: boolean; refresh: boolean; download: boolean; provision: boolean };
  onDelete: () => void;
  onRefresh: () => void;
  onVoid: () => void;
  onDownload: () => void;
  onProvision: () => void;
}) {
  const state = agreementState(a, Date.now());
  const customer = a.client_org?.trim() || a.client_name;
  const representative =
    a.client_org?.trim() && a.client_name !== a.client_org ? a.client_name : null;
  const unissued = a.status === "draft" && !a.issued_at;
  const out = a.status === "sent" || a.status === "delivered";
  return (
    <RecordRow spine={state.spine} className="flex flex-wrap items-center gap-3 px-4 py-3">
      {/* A basis, not only flex-1: a row wraps when its items' hypothetical
          sizes overflow it, and flex-1 alone contributes zero — so without it
          a narrow window hands the name whatever the buttons leave, down to
          a few characters, instead of moving the buttons to their own line. */}
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Link
            to="/agreements/$agreementId"
            params={{ agreementId: a.id }}
            className="truncate text-sm font-medium text-foreground hover:underline"
          >
            {customer}
          </Link>
          <span className="label-mono">subscription · {a.service_tier ?? "tier not set"}</span>
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {[
            a.offer_reference,
            representative,
            a.client_email || null,
            a.commencement_date
              ? `activates ${format(new Date(`${a.commencement_date}T00:00:00`), "d MMM yyyy")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {a.status === "signed" && !a.signed_record_path && (
          <p className="mt-0.5 text-xs text-warning">
            Signed — the signed copy has not been retained yet, so nothing is provisioned.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 text-right">
        <div>
          <div className="flex items-center justify-end gap-3">
            <ProvisionWord a={a} />
            <MonoStatus tone={state.tone} label={state.label} pulse={state.label === "sending"} />
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{when(a)}</p>
        </div>
        <Button size="sm" variant={a.status === "draft" ? "default" : "outline"} asChild>
          <Link to="/agreements/$agreementId" params={{ agreementId: a.id }}>
            <FileText className="mr-1.5 h-3.5 w-3.5" />
            {a.status === "draft" ? "Open offer" : "View"}
          </Link>
        </Button>
        {unissued && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Delete draft offer"
            disabled={busy.delete}
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {out && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!configured || busy.refresh}
              onClick={onRefresh}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!configured}
              aria-label="Void envelope"
              onClick={onVoid}
            >
              <XCircle className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {a.status === "signed" && (
          <SignedActions
            a={a}
            configured={configured}
            busy={busy}
            onDownload={onDownload}
            onProvision={onProvision}
          />
        )}
      </div>
    </RecordRow>
  );
}

function SlaRow({
  a,
  configured,
  busy,
  onConfigure,
  onSend,
  onDelete,
  onRefresh,
  onVoid,
  onDownload,
  onProvision,
}: {
  a: AgreementListRow;
  configured: boolean;
  busy: { send: boolean; delete: boolean; refresh: boolean; download: boolean; provision: boolean };
  onConfigure: () => void;
  onSend: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onVoid: () => void;
  onDownload: () => void;
  onProvision: () => void;
}) {
  const state = agreementState(a, Date.now());
  return (
    <RecordRow spine={state.spine} className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="truncate text-sm font-medium text-foreground">{a.client_name}</p>
          <span className="label-mono">
            service level{a.service_tier ? ` · ${a.service_tier}` : ""}
            {a.plan_slug ? ` · plan ${a.plan_slug}` : ""}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {[
            a.client_org,
            a.client_email,
            a.commencement_date
              ? `commences ${format(new Date(`${a.commencement_date}T00:00:00`), "d MMM yyyy")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 text-right">
        <div>
          <div className="flex items-center justify-end gap-3">
            <ProvisionWord a={a} />
            <MonoStatus tone={state.tone} label={state.label} />
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{when(a)}</p>
        </div>
        {(a.status === "draft" || a.status === "sent" || a.status === "delivered") && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Configure provisioning"
            title="What a signature provisions: plan, modules, add-ons"
            onClick={onConfigure}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        )}
        {a.status === "draft" && (
          <>
            <Button
              size="sm"
              disabled={!configured || busy.send}
              title={configured ? "Send for signature" : "DocuSign not configured"}
              onClick={onSend}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" /> Send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Delete draft"
              disabled={busy.delete}
              onClick={onDelete}
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
              disabled={!configured || busy.refresh}
              onClick={onRefresh}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!configured}
              aria-label="Void envelope"
              onClick={onVoid}
            >
              <XCircle className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {a.status === "signed" && (
          <SignedActions
            a={a}
            configured={configured}
            busy={busy}
            onDownload={onDownload}
            onProvision={onProvision}
          />
        )}
      </div>
    </RecordRow>
  );
}

/* ───────────────────────────── the SLA ───────────────────────────── */

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
