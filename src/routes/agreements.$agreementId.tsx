// /agreements/$agreementId — one agreement.
//
// A Subscription Agreement is prepared here. The offer editor runs down the
// page in the document's own order; beside it stand what still keeps the
// offer from being sent, the price as the agreement will state it, and what a
// signature provisions. Until it is sent the offer is a draft and saves as
// one. Once sent it is a record — shown from the snapshot taken at the send,
// never edited — and a revision is a new offer, raised by duplicating it.
//
// A Service Level Agreement has no offer. Its page is its facts; its
// lifecycle stays on the list.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  Download,
  Eye,
  FileSignature,
  RefreshCw,
  Rocket,
  Save,
  Send,
  Settings2,
  Trash2,
  XCircle,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeaderSkeleton } from "@/components/route-loading";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { EmptyState } from "@/components/empty-state";
import { useConfirm } from "@/components/confirm-dialog";
import { MonoStatus } from "@/components/voice/tone";
import { Button } from "@/components/ui/button";
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
import { AgreementProvisioningDialog } from "@/components/agreement-provisioning-dialog";
import { OfferEditor } from "@/components/agreements/offer-editor";
import {
  OfferDocumentReview,
  OfferPrice,
  OfferProvisioning,
  OfferReadiness,
} from "@/components/agreements/offer-summary";
import { useUserRoles } from "@/lib/use-user-roles";
import { cn } from "@/lib/utils";
import {
  deleteDraftAgreement,
  downloadSignedAgreement,
  downloadSubscriptionAgreementDocument,
  duplicateSubscriptionOffer,
  getAgreement,
  getAgreementsConfig,
  getSubscriptionContext,
  provisionAgreementNow,
  refreshAgreementStatus,
  saveSubscriptionOffer,
  sendAgreement,
  voidAgreement,
  type AgreementRow,
} from "@/lib/agreements.functions";
import { agreementState } from "@/lib/agreements/agreementState.pure";
import {
  aud,
  composedView,
  longDate,
  readIssuedSnapshot,
  snapshotView,
  type OfferView,
} from "@/lib/agreements/offerEditor.pure";
import { DOCX_MIME, PDF_MIME, saveBase64File } from "@/lib/agreements/saveFile";
import { sendClaimState } from "@/lib/agreements/subscriptionIssue.pure";
import {
  composeSubscriptionOffer,
  subscriptionOfferSchema,
  type SubscriptionOffer,
} from "@/lib/agreements/subscriptionOffer.pure";
import { SUBSCRIPTION_TEMPLATES } from "@/lib/agreements/subscriptionTemplates";

export const Route = createFileRoute("/agreements/$agreementId")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <AgreementRoute />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Agreement — Aurixa Mission Control" }] }),
});

type Loaded = Awaited<ReturnType<typeof getAgreement>>;

const TERM_WORDS: Record<SubscriptionOffer["term"], string> = {
  flexible: "flexible, month to month",
  committed_monthly: "12 months, paid monthly",
  committed_annual: "12 months, prepaid",
};

function AgreementRoute() {
  const { agreementId } = Route.useParams();
  // Keyed on the id: duplicating navigates from one offer to another on this
  // same route, and one offer's working copy must never carry into the next.
  return <AgreementPage key={agreementId} agreementId={agreementId} />;
}

/** How often the page asks again: often while something is moving, never when nothing can. */
function pollInterval(a: AgreementRow | null | undefined): number | false {
  if (!a) return false;
  if (
    a.document_kind === "subscription" &&
    a.status === "draft" &&
    sendClaimState(a, Date.now()) === "in_flight"
  ) {
    return 5_000;
  }
  if (a.status === "sent" || a.status === "delivered") return 60_000;
  if (
    a.status === "signed" &&
    (a.provision_status === "provisioning" ||
      (a.document_kind === "subscription" && !a.signed_record_path))
  ) {
    return 30_000;
  }
  return false;
}

function AgreementPage({ agreementId }: { agreementId: string }) {
  const agreementQ = useQuery({
    queryKey: ["agreements", "detail", agreementId],
    queryFn: () => getAgreement({ data: { id: agreementId } }),
    refetchInterval: (query) => pollInterval(query.state.data?.agreement),
  });
  const contextQ = useQuery({
    queryKey: ["agreements", "subscription-context"],
    queryFn: () => getSubscriptionContext(),
    staleTime: 60_000,
  });

  if (agreementQ.isPending) return <PageLoading />;
  if (agreementQ.error) {
    const missing = (agreementQ.error as Error).message === "agreement_not_found";
    return (
      <div className="space-y-6 p-6">
        <BackLink />
        <EmptyState
          icon={<AlertTriangle />}
          title={missing ? "No such agreement" : "The agreement could not be loaded"}
          description={
            missing
              ? "It may have been a draft that was deleted. Every agreement that was sent is kept."
              : (agreementQ.error as Error).message
          }
          action={
            missing ? undefined : (
              <Button variant="outline" onClick={() => void agreementQ.refetch()}>
                <RefreshCw className="mr-1.5 h-4 w-4" /> Try again
              </Button>
            )
          }
        />
      </div>
    );
  }

  const loaded = agreementQ.data;
  if (loaded.agreement.document_kind !== "subscription") {
    return <ServiceLevelAgreement agreement={loaded.agreement} />;
  }
  if (contextQ.isPending) return <PageLoading />;
  if (contextQ.error) {
    return (
      <div className="space-y-6 p-6">
        <BackLink />
        <EmptyState
          icon={<AlertTriangle />}
          title="The offer's context could not be loaded"
          description={`The issuing profile and rate card are needed to show the offer as it will print. ${(contextQ.error as Error).message}`}
          action={
            <Button variant="outline" onClick={() => void contextQ.refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Try again
            </Button>
          }
        />
      </div>
    );
  }
  return <SubscriptionOfferPage loaded={loaded} context={contextQ.data} />;
}

function PageLoading() {
  return (
    <div className="space-y-6 p-6">
      <PageHeaderSkeleton />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          <CardRowSkeleton />
          <CardRowSkeleton />
          <CardRowSkeleton />
        </div>
        <CardRowSkeleton />
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/agreements"
      className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="mr-1 h-4 w-4" /> Agreements
    </Link>
  );
}

/** The first thing zod refused, in words an operator can act on. */
function describeInvalid(offer: SubscriptionOffer): string | null {
  const parsed = subscriptionOfferSchema.safeParse(offer);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const where = issue.path.join(".");
  return where ? `${where}: ${issue.message}` : issue.message;
}

/* ───────────────────────────── the subscription offer ───────────────────────────── */

function SubscriptionOfferPage({
  loaded,
  context,
}: {
  loaded: Loaded;
  context: Awaited<ReturnType<typeof getSubscriptionContext>>;
}) {
  const { agreement: row, lead, account } = loaded;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { isAdmin } = useUserRoles();
  const configQ = useQuery({
    queryKey: ["agreements", "config"],
    queryFn: () => getAgreementsConfig(),
    staleTime: 5 * 60_000,
  });
  const configured = configQ.data?.configured ?? false;

  const reference = row.offer_reference ?? "";
  const stored = useMemo(() => subscriptionOfferSchema.safeParse(row.offer), [row.offer]);
  const snapshot = useMemo(() => readIssuedSnapshot(row.issued_snapshot), [row.issued_snapshot]);
  const claim = sendClaimState(row, Date.now());
  const state = agreementState(row, Date.now());
  const editable = row.status === "draft" && claim === "unclaimed" && stored.success;
  const issued = Boolean(row.docusign_envelope_id);

  /* ── the working copy ── */
  const [draft, setDraft] = useState<SubscriptionOffer | null>(stored.success ? stored.data : null);
  const [base, setBase] = useState(() => ({
    json: stored.success ? JSON.stringify(stored.data) : "",
    updatedAt: row.updated_at,
  }));
  const draftJson = useMemo(() => (draft ? JSON.stringify(draft) : ""), [draft]);
  const dirty = editable && draft !== null && draftJson !== base.json;
  // Newer, not merely different: straight after a save the page already
  // holds the saved version while the row it was loaded with is older.
  const changedElsewhere = Date.parse(row.updated_at) > Date.parse(base.updatedAt);

  const dirtyRef = useRef(dirty);
  const leavingRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // The row moved on under a page holding nothing unsaved — a send finished,
  // provisioning was armed, the offer was saved in another tab: follow it.
  // With unsaved work the page keeps it, and says the row moved.
  useEffect(() => {
    if (!changedElsewhere || dirtyRef.current || !stored.success) return;
    setDraft(stored.data);
    setBase({ json: JSON.stringify(stored.data), updatedAt: row.updated_at });
  }, [changedElsewhere, stored, row.updated_at]);

  useBlocker({
    shouldBlockFn: async () => {
      if (leavingRef.current || !dirtyRef.current) return false;
      const leave = await confirm({
        title: "Leave without saving?",
        description: `Offer ${reference} has changes that have not been saved. Leaving discards them.`,
        confirmText: "Discard changes",
        cancelText: "Keep editing",
        destructive: true,
      });
      return !leave;
    },
    enableBeforeUnload: () => dirtyRef.current && !leavingRef.current,
  });

  /* ── what the page shows ── */
  const shown = editable ? draft : stored.success ? stored.data : null;
  const liveView = useMemo<OfferView | null>(() => {
    if (!shown || issued) return null;
    return composedView(
      composeSubscriptionOffer(shown, {
        offerReference: reference,
        rateCard: context.rateCard,
        today: context.today,
      }),
    );
  }, [shown, issued, reference, context.rateCard, context.today]);
  const issuedView = useMemo<OfferView | null>(() => {
    if (!issued || !snapshot || !stored.success) return null;
    // The snapshot keeps each line's figures, not its printed A4 record: the
    // record is reproduced from the frozen offer under the issued rate card.
    const records = composedView(
      composeSubscriptionOffer(stored.data, {
        offerReference: reference,
        rateCard: snapshot.rateCard,
      }),
    ).records;
    return snapshotView(snapshot, records);
  }, [issued, snapshot, stored, reference]);
  const recomputedIssued = useMemo<OfferView | null>(() => {
    if (!issued || snapshot || !stored.success) return null;
    return composedView(
      composeSubscriptionOffer(stored.data, {
        offerReference: reference,
        rateCard: context.rateCard,
      }),
    );
  }, [issued, snapshot, stored, reference, context.rateCard]);
  const view = issuedView ?? recomputedIssued ?? liveView;
  const gapCount = view?.gaps.length ?? 0;

  /* ── actions ── */
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["agreements", "detail", row.id] });
    void qc.invalidateQueries({ queryKey: ["agreements", "list"] });
  };

  /** Save the working copy; every action that reads the stored offer calls this first. */
  const persist = async () => {
    if (!draft) throw new Error("The offer could not be read, so it cannot be saved.");
    const invalid = describeInvalid(draft);
    if (invalid) throw new Error(`The offer cannot be saved as it stands — ${invalid}`);
    const sent = draft;
    const res = await saveSubscriptionOffer({
      data: { id: row.id, offer: subscriptionOfferSchema.parse(sent) },
    });
    setBase({ json: JSON.stringify(sent), updatedAt: res.updatedAt });
    if (res.disarmed) {
      toast.warning("Provisioning was disarmed", {
        description:
          "The offer now sells a different plan or add-ons than provisioning was armed for. Re-arm it once the offer is final.",
        duration: 12_000,
      });
    }
    invalidate();
  };
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  });

  const saveM = useMutation({
    mutationFn: () => persist(),
    onSuccess: () => toast.success("Offer saved"),
    onError: (err: Error) => toast.error("The offer was not saved", { description: err.message }),
  });

  // Ctrl/Cmd+S saves, as it does in every editor an operator has used.
  const saveShortcut = useRef({ can: false, save: () => {} });
  useEffect(() => {
    saveShortcut.current = {
      can: editable && dirty && !saveM.isPending,
      save: () => saveM.mutate(),
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (saveShortcut.current.can) saveShortcut.current.save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const previewM = useMutation({
    mutationFn: async () => {
      if (dirtyRef.current) await persistRef.current();
      return downloadSubscriptionAgreementDocument({ data: { id: row.id } });
    },
    onSuccess: (r) => {
      saveBase64File(r.base64, r.filename, DOCX_MIME);
      if (r.kind === "preview") {
        toast.info("Preview downloaded", {
          description: "Marked PREVIEW ONLY in its title and signature field — it is not an offer.",
        });
      }
    },
    onError: (err: Error) =>
      toast.error("The document could not be produced", { description: err.message }),
  });

  const [sendOpen, setSendOpen] = useState(false);
  const sendM = useMutation({
    mutationFn: async () => {
      if (dirtyRef.current) await persistRef.current();
      return sendAgreement({ data: { id: row.id } });
    },
    onSuccess: (r) => {
      setSendOpen(false);
      toast.success(
        r.recovered ? "The earlier send was found and recorded" : "Sent for signature",
        {
          description: r.recovered
            ? `DocuSign had created envelope ${r.envelopeId}; nothing was sent twice.`
            : `DocuSign has emailed ${shown?.signatory.name || "the signatory"} a link to sign offer ${reference}.`,
        },
      );
      invalidate();
    },
    onError: (err: Error) => {
      toast.error("The offer was not sent", { description: err.message, duration: 15_000 });
      invalidate();
    },
  });

  const duplicateM = useMutation({
    mutationFn: async () => {
      if (dirtyRef.current) await persistRef.current();
      return duplicateSubscriptionOffer({ data: { id: row.id } });
    },
    onSuccess: (r) => {
      toast.success(`Offer ${r.offerReference} prepared`, {
        description: `A new draft carrying the terms of ${reference}.`,
      });
      void qc.invalidateQueries({ queryKey: ["agreements", "list"] });
      void navigate({ to: "/agreements/$agreementId", params: { agreementId: r.id } });
    },
    onError: (err: Error) =>
      toast.error("The offer could not be duplicated", { description: err.message }),
  });

  const deleteM = useMutation({
    mutationFn: () => deleteDraftAgreement({ data: { id: row.id } }),
    onSuccess: () => {
      toast.success(`Draft ${reference} deleted`);
      leavingRef.current = true;
      void qc.invalidateQueries({ queryKey: ["agreements", "list"] });
      void navigate({ to: "/agreements" });
    },
    onError: (err: Error) => toast.error("The draft was not deleted", { description: err.message }),
  });

  const refreshM = useMutation({
    mutationFn: () => refreshAgreementStatus({ data: { id: row.id } }),
    onSuccess: (r) => {
      toast.success(`DocuSign reports this envelope ${r.docusignStatus}`);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const voidM = useMutation({
    mutationFn: () => voidAgreement({ data: { id: row.id, reason: voidReason.trim() } }),
    onSuccess: () => {
      toast.success(`Offer ${reference} withdrawn`);
      setVoidOpen(false);
      setVoidReason("");
      invalidate();
    },
    onError: (err: Error) =>
      toast.error("The envelope was not voided", { description: err.message }),
  });

  const signedPdfM = useMutation({
    mutationFn: () => downloadSignedAgreement({ data: { id: row.id } }),
    onSuccess: (r) => saveBase64File(r.base64, r.filename, PDF_MIME),
    onError: (err: Error) => toast.error(err.message),
  });

  const provisionM = useMutation({
    mutationFn: () => provisionAgreementNow({ data: { id: row.id } }),
    onSuccess: (res) => {
      if (res && "cloneId" in res && res.cloneId) {
        toast.success("Clone provisioned — the backend is queued for the worker");
      } else if (res && "skipped" in res && res.skipped) {
        toast.info(`Not provisioned: ${res.detail}`);
      } else if (res && "error" in res) {
        toast.error(res.error);
      }
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const [provisioningOpen, setProvisioningOpen] = useState(false);
  const openProvisioning = async () => {
    if (dirtyRef.current) {
      try {
        await persistRef.current();
      } catch (err) {
        toast.error("Save the offer first", { description: (err as Error).message });
        return;
      }
    }
    setProvisioningOpen(true);
  };

  const deleteDraft = async () => {
    const ok = await confirm({
      title: `Delete draft ${reference}?`,
      description:
        "The draft and everything typed into it are removed. Nothing has been sent, so nobody else is affected.",
      confirmText: "Delete draft",
      destructive: true,
    });
    if (ok) deleteM.mutate();
  };

  const discardMine = async () => {
    const ok = await confirm({
      title: "Discard your changes?",
      description: "The page loads the offer as it was last saved.",
      confirmText: "Discard",
      destructive: true,
    });
    if (!ok || !stored.success) return;
    setDraft(stored.data);
    setBase({ json: JSON.stringify(stored.data), updatedAt: row.updated_at });
  };

  /* ── the page ── */
  if (!shown || !view) {
    return (
      <div className="space-y-6 p-6">
        <BackLink />
        <EmptyState
          icon={<AlertTriangle />}
          title="This offer could not be read"
          description={`Offer ${reference || row.id} is stored in a shape this build does not understand, so it is not shown rather than shown wrongly.`}
        />
      </div>
    );
  }

  const tier = SUBSCRIPTION_TEMPLATES[shown.tier];
  const customer =
    shown.customer.legalName.trim() || row.client_org?.trim() || row.client_name || "New offer";
  const busy =
    saveM.isPending ||
    previewM.isPending ||
    sendM.isPending ||
    duplicateM.isPending ||
    deleteM.isPending;
  const out = row.status === "sent" || row.status === "delivered";
  const provisioningLocked =
    row.provision_status === "provisioning" || row.provision_status === "provisioned";
  const canConfigureProvisioning =
    !provisioningLocked && (row.status === "draft" || out || row.status === "signed");

  const sendBlocker = !configured
    ? configQ.isPending
      ? "Checking DocuSign…"
      : "DocuSign is not connected, so nothing can be sent yet."
    : gapCount > 0
      ? `Complete the offer first — ${gapCount} ${gapCount === 1 ? "thing" : "things"} to complete.`
      : null;

  const when = row.docusign_signed_at
    ? `signed ${format(new Date(row.docusign_signed_at), "d MMM yyyy, h:mm a")}`
    : row.docusign_sent_at
      ? `sent ${format(new Date(row.docusign_sent_at), "d MMM yyyy, h:mm a")}`
      : `prepared ${formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}`;

  const actions: ReactNode = editable ? (
    <>
      <Button
        variant="outline"
        disabled={!dirty || busy}
        onClick={() => saveM.mutate()}
        title="Save the draft (Ctrl+S)"
      >
        <Save className="mr-1.5 h-4 w-4" /> {dirty ? "Save" : "Saved"}
      </Button>
      <Button
        variant="outline"
        disabled={gapCount > 0 || busy}
        title={
          gapCount > 0
            ? "The document can be previewed once the offer is complete. Until then, “Every field as it prints” below shows its text."
            : "Download the completed document, marked as a preview"
        }
        onClick={() => previewM.mutate()}
      >
        <Eye className="mr-1.5 h-4 w-4" /> Preview .docx
      </Button>
      <Button
        disabled={Boolean(sendBlocker) || busy}
        title={sendBlocker ?? "Review the details and send through DocuSign"}
        onClick={() => setSendOpen(true)}
      >
        <Send className="mr-1.5 h-4 w-4" /> Send for signature
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Duplicate this offer"
        title="Duplicate — a new draft with these terms"
        disabled={busy}
        onClick={() => duplicateM.mutate()}
      >
        <Copy className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete this draft"
        title="Delete this draft"
        className="text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => void deleteDraft()}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </>
  ) : claim === "stale" && row.status === "draft" ? (
    <Button
      disabled={!configured || sendM.isPending}
      title={configured ? "Ask DocuSign, then finish the send" : "DocuSign is not connected"}
      onClick={() => setSendOpen(true)}
    >
      <Send className="mr-1.5 h-4 w-4" /> Finish sending
    </Button>
  ) : claim === "in_flight" && row.status === "draft" ? (
    <Button disabled>
      <Send className="mr-1.5 h-4 w-4" /> Sending…
    </Button>
  ) : (
    <>
      {out && (
        <>
          <Button
            variant="outline"
            disabled={!configured || refreshM.isPending}
            onClick={() => refreshM.mutate()}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh status
          </Button>
          <Button
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={!configured}
            onClick={() => setVoidOpen(true)}
          >
            <XCircle className="mr-1.5 h-4 w-4" /> Void
          </Button>
        </>
      )}
      {row.status === "signed" && (
        <Button
          variant="outline"
          disabled={(!configured && !row.signed_record_path) || signedPdfM.isPending}
          onClick={() => signedPdfM.mutate()}
        >
          <Download className="mr-1.5 h-4 w-4" /> Signed PDF
        </Button>
      )}
      {issued && (
        <Button
          variant="outline"
          disabled={previewM.isPending}
          title="The document exactly as issued, reproduced from its record"
          onClick={() => previewM.mutate()}
        >
          <FileSignature className="mr-1.5 h-4 w-4" /> Issued .docx
        </Button>
      )}
      <Button
        variant={row.status === "declined" || row.status === "voided" ? "default" : "outline"}
        disabled={duplicateM.isPending}
        title="A new draft with these terms, under a new reference"
        onClick={() => duplicateM.mutate()}
      >
        <Copy className="mr-1.5 h-4 w-4" />
        {row.status === "declined" || row.status === "voided"
          ? "Prepare a revised offer"
          : "Duplicate"}
      </Button>
    </>
  );

  const provisioningAction: ReactNode =
    row.status === "signed" ? (
      row.provision_status === "provisioned" && row.provisioned_clone_id ? (
        <Button size="sm" variant="outline" asChild>
          <Link to="/clones/$cloneId" params={{ cloneId: row.provisioned_clone_id }}>
            <Rocket className="mr-1.5 h-3.5 w-3.5" /> View clone
          </Link>
        </Button>
      ) : row.provision_status !== "provisioning" ? (
        <div className="flex flex-wrap gap-2">
          {isAdmin ? (
            <Button size="sm" disabled={provisionM.isPending} onClick={() => provisionM.mutate()}>
              <Rocket className="mr-1.5 h-3.5 w-3.5" />
              {row.provision_status === "failed" ? "Retry provision" : "Provision now"}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">An administrator can provision it now.</p>
          )}
          {canConfigureProvisioning && (
            <Button size="sm" variant="ghost" onClick={() => void openProvisioning()}>
              <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Configure
            </Button>
          )}
        </div>
      ) : null
    ) : canConfigureProvisioning ? (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void openProvisioning()}
        title="Modules, the admin address and whether a signature provisions automatically"
      >
        <Settings2 className="mr-1.5 h-3.5 w-3.5" />
        {row.provision_on_signature ? "Provisioning settings" : "Arm provisioning"}
      </Button>
    ) : null;

  return (
    <div className="space-y-6 p-6">
      <BackLink />

      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="label-mono">subscription agreement · {reference}</p>
          <h1 className="mt-1 font-display text-[1.75rem] leading-[1.1]">{customer}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <MonoStatus
              label={dirty ? `${state.label} · unsaved changes` : state.label}
              tone={dirty ? "warning" : state.tone}
              pulse={state.label === "sending"}
            />
            <span>
              {tier.tierName} · {shown.aml === "with" ? "with AML" : "without AML"} ·{" "}
              {TERM_WORDS[shown.term]}
            </span>
            <span className="font-mono text-xs">{when}</span>
            {lead && (
              <Link
                to="/leads"
                search={{ q: lead.email }}
                className="underline underline-offset-4 hover:text-foreground"
              >
                Lead: {lead.name || lead.email}
              </Link>
            )}
            {account && (
              <Link
                to="/crm/accounts/$accountId"
                params={{ accountId: account.id }}
                className="underline underline-offset-4 hover:text-foreground"
              >
                Account: {account.name}
              </Link>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>
      </header>

      <Notices
        row={row}
        claim={claim}
        editable={editable}
        dirty={dirty}
        changedElsewhere={changedElsewhere}
        configured={configured}
        configMissing={configQ.data?.missing ?? null}
        snapshotMissing={issued && !snapshot}
        onDiscard={() => void discardMine()}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <OfferEditor
            offer={shown}
            onChange={setDraft}
            readOnly={!editable}
            view={view}
            profile={context.profile}
            profileUpdatedAt={context.profileUpdatedAt}
            rateCard={issued && snapshot ? snapshot.rateCard : context.rateCard}
            rateCardFrom={issued && snapshot ? "issued" : "live"}
          />
          <OfferDocumentReview view={view} defaultOpen={!editable} />
        </div>
        <aside
          aria-label="Offer summary"
          className="space-y-4 xl:sticky xl:top-16 xl:max-h-[calc(100vh-5rem)] xl:self-start xl:overflow-y-auto"
        >
          <OfferReadiness
            view={view}
            issued={
              snapshot && issued
                ? {
                    at: snapshot.issuedAt,
                    documentName: snapshot.document.name,
                    signer: `${snapshot.signer.name} (${snapshot.signer.email})`,
                  }
                : null
            }
          />
          <OfferPrice view={view} offer={shown} />
          <OfferProvisioning offer={shown} row={row} unsaved={dirty} action={provisioningAction} />
        </aside>
      </div>

      <SendOfferDialog
        open={sendOpen}
        onOpenChange={(o) => !sendM.isPending && setSendOpen(o)}
        offer={shown}
        view={view}
        reference={reference}
        countersigner={configQ.data?.countersigner ?? null}
        recovering={claim === "stale"}
        unsaved={dirty}
        pending={sendM.isPending}
        onSend={() => sendM.mutate()}
      />

      <AgreementProvisioningDialog
        agreement={provisioningOpen ? row : null}
        onOpenChange={(o) => !o && setProvisioningOpen(false)}
        onSaved={invalidate}
      />

      <Dialog open={voidOpen} onOpenChange={(o) => !voidM.isPending && setVoidOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw offer {reference}?</DialogTitle>
            <DialogDescription>
              The envelope is voided in DocuSign and can no longer be signed. The offer stays here
              as a voided record; a revised offer is raised by duplicating it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="offer-void-reason">Reason (DocuSign shows it to the signatory)</Label>
            <Textarea
              id="offer-void-reason"
              value={voidReason}
              maxLength={500}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Superseded by a revised offer…"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVoidOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={voidM.isPending} onClick={() => voidM.mutate()}>
              Void envelope
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ───────────────────────────── notices ───────────────────────────── */

function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: "warn" | "live" | "bad" | "idle";
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "glass spine flex flex-wrap items-center justify-between gap-3 p-4",
        `spine-${tone}`,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  );
}

function Notices({
  row,
  claim,
  editable,
  dirty,
  changedElsewhere,
  configured,
  configMissing,
  snapshotMissing,
  onDiscard,
}: {
  row: AgreementRow;
  claim: ReturnType<typeof sendClaimState>;
  editable: boolean;
  dirty: boolean;
  changedElsewhere: boolean;
  configured: boolean;
  configMissing: string[] | null;
  snapshotMissing: boolean;
  onDiscard: () => void;
}) {
  const notices: ReactNode[] = [];
  if (row.status === "draft" && claim === "in_flight" && row.issued_at) {
    notices.push(
      <Notice key="sending" tone="live" title="Being sent">
        The send started {formatDistanceToNow(new Date(row.issued_at), { addSuffix: true })}. This
        page updates itself once DocuSign has accepted the envelope; pressing Send again would not
        send a second one.
      </Notice>,
    );
  }
  if (row.status === "draft" && claim === "stale" && row.issued_at) {
    notices.push(
      <Notice key="stale" tone="warn" title="A send of this offer did not finish">
        It started {format(new Date(row.issued_at), "d MMM yyyy, h:mm a")} and stopped before
        DocuSign's answer was recorded. Finish sending asks DocuSign whether that send created an
        envelope and records it if so; only if none exists is the offer sent now.
      </Notice>,
    );
  }
  if (editable && dirty && changedElsewhere) {
    notices.push(
      <Notice
        key="elsewhere"
        tone="warn"
        title="This offer was saved elsewhere since you opened it"
        action={
          <Button size="sm" variant="outline" onClick={onDiscard}>
            Load the saved offer
          </Button>
        }
      >
        Saving replaces that version with yours.
      </Notice>,
    );
  }
  if (editable && configMissing && !configured) {
    notices.push(
      <Notice key="docusign" tone="idle" title="DocuSign is not connected yet">
        This offer can be prepared, saved and previewed, but not sent until these Worker secrets
        exist: <span className="font-mono text-xs">{configMissing.join(", ")}</span>.
      </Notice>,
    );
  }
  if (snapshotMissing) {
    notices.push(
      <Notice key="snapshot" tone="warn" title="The issued snapshot could not be read">
        The figures below are recomputed from the stored offer under today's rate card and may not
        be exactly what was issued. The document as sent is in DocuSign.
      </Notice>,
    );
  }
  if (row.status === "signed" && !row.signed_record_path) {
    notices.push(
      <Notice key="retain" tone="warn" title="Signed — the signed copy is not yet retained">
        Nothing is provisioned from this agreement until the signed PDF has been copied into the
        records bucket. The agreements sweep keeps trying; Provision now retries at once.
      </Notice>,
    );
  }
  if (row.status === "voided") {
    notices.push(
      <Notice key="voided" tone="idle" title="Withdrawn">
        Voided
        {row.docusign_voided_at ? ` ${format(new Date(row.docusign_voided_at), "d MMM yyyy")}` : ""}
        {row.void_reason ? ` — “${row.void_reason}”` : ""}. It can no longer be signed; prepare a
        revised offer to replace it.
      </Notice>,
    );
  }
  if (row.status === "declined") {
    notices.push(
      <Notice key="declined" tone="bad" title="Declined in DocuSign">
        The signatory declined to sign. Prepare a revised offer to try again.
      </Notice>,
    );
  }
  if (notices.length === 0) return null;
  return <div className="space-y-3">{notices}</div>;
}

/* ───────────────────────────── the send ───────────────────────────── */

function SendOfferDialog({
  open,
  onOpenChange,
  offer,
  view,
  reference,
  countersigner,
  recovering,
  unsaved,
  pending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offer: SubscriptionOffer;
  view: OfferView;
  reference: string;
  countersigner: { name: string | null; email: string } | null;
  recovering: boolean;
  unsaved: boolean;
  pending: boolean;
  onSend: () => void;
}) {
  const t = view.totals;
  const prepaid = offer.term === "committed_annual";
  const rows: Array<[string, ReactNode]> = [
    [
      "Signs",
      <>
        {offer.signatory.name}
        {offer.signatory.role ? `, ${offer.signatory.role}` : ""}
        <span className="block font-mono text-xs text-muted-foreground">
          {offer.signatory.email}
        </span>
      </>,
    ],
    [
      "For",
      <>
        {offer.customer.legalName}
        {offer.customer.identifier && (
          <span className="block font-mono text-xs text-muted-foreground">
            {offer.customer.identifier}
          </span>
        )}
      </>,
    ],
    [
      "Offer",
      `${SUBSCRIPTION_TEMPLATES[offer.tier].tierName}, ${offer.aml === "with" ? "with AML" : "without AML"}, ${TERM_WORDS[offer.term]}`,
    ],
    [prepaid ? "Monthly equivalent" : "Each month", `${aud(t.monthlyTotalCents)} incl. GST`],
    [
      "Due at activation",
      <>
        {aud(t.dueAtActivationCents)}
        {view.dates && (
          <span className="block text-xs text-muted-foreground">
            on {longDate(view.dates.activation)}
          </span>
        )}
      </>,
    ],
    [
      "Copy to",
      countersigner ? (
        <>
          {countersigner.name || "Aurixa's countersigner"}
          <span className="block font-mono text-xs text-muted-foreground">
            {countersigner.email}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">Nobody at Aurixa — no countersigner is set</span>
      ),
    ],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {recovering ? `Finish sending offer ${reference}?` : `Send offer ${reference}?`}
          </DialogTitle>
          <DialogDescription>
            {recovering
              ? "Mission Control first asks DocuSign whether the earlier send created an envelope, and records it if it did. Only if none exists is the offer sent now."
              : "DocuSign emails the signatory a link to sign. From that moment the offer is a record: it cannot be edited, only withdrawn and replaced by a revised offer."}
          </DialogDescription>
        </DialogHeader>
        <dl className="divide-y divide-border/40 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[9rem_1fr] gap-3 py-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {view.warnings.length > 0 && (
          <div className="space-y-1">
            <p className="label-mono">check before sending</p>
            {view.warnings.map((w) => (
              <p key={w} className="text-xs text-warning">
                {w}
              </p>
            ))}
          </div>
        )}
        {unsaved && (
          <p className="text-xs text-muted-foreground">Your unsaved changes are saved first.</p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={onSend}>
            <Send className="mr-1.5 h-4 w-4" />
            {pending ? "Sending…" : recovering ? "Finish sending" : "Send for signature"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────────── the SLA ───────────────────────────── */

function ServiceLevelAgreement({ agreement: a }: { agreement: AgreementRow }) {
  const state = agreementState(a, Date.now());
  const facts: Array<[string, string | null]> = [
    ["Signer", a.client_name],
    ["Email", a.client_email],
    ["Organisation", a.client_org],
    ["Service tier", a.service_tier],
    [
      "Commencement",
      a.commencement_date
        ? format(new Date(`${a.commencement_date}T00:00:00`), "d MMMM yyyy")
        : null,
    ],
    [
      "Sent",
      a.docusign_sent_at ? format(new Date(a.docusign_sent_at), "d MMM yyyy, h:mm a") : null,
    ],
    [
      "Signed",
      a.docusign_signed_at ? format(new Date(a.docusign_signed_at), "d MMM yyyy, h:mm a") : null,
    ],
    [
      "Voided",
      a.docusign_voided_at
        ? `${format(new Date(a.docusign_voided_at), "d MMM yyyy")}${a.void_reason ? ` — ${a.void_reason}` : ""}`
        : null,
    ],
    ["Provisioning", a.provision_status === "none" ? null : a.provision_status],
  ];
  return (
    <div className="space-y-6 p-6">
      <BackLink />
      <header>
        <p className="label-mono">service level agreement</p>
        <h1 className="mt-1 font-display text-[1.75rem] leading-[1.1]">
          {a.client_org?.trim() || a.client_name}
        </h1>
        <div className="mt-2">
          <MonoStatus label={state.label} tone={state.tone} />
        </div>
      </header>
      <section className="glass max-w-2xl p-5">
        <dl className="divide-y divide-border/40">
          {facts
            .filter((f): f is [string, string] => Boolean(f[1]))
            .map(([label, value]) => (
              <div key={label} className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">
          A Service Level Agreement is sent, refreshed, voided and provisioned from the{" "}
          <Link to="/agreements" className="underline underline-offset-4 hover:text-foreground">
            Agreements list
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
