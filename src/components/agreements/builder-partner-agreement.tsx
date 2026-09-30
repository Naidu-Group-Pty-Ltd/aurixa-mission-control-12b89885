/**
 * A Builder Partner Agreement's own page: who it is with, the terms and the
 * execution schedule it sends, whether signing admits the builder, and what
 * the Builder Portal made of it.
 *
 * Every write is an admin's; operators see the same page read-only. The page
 * never decides whether an agreement can be sent — it renders the server's
 * own `particularsGaps`, the list the send refuses on.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  CreditCard,
  Download,
  Mail,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  deleteDraftAgreement,
  downloadSignedAgreement,
  sendAgreement,
  voidAgreement,
} from "@/lib/agreements.functions";
import {
  downloadBuilderPartnerAgreementTerms,
  downloadBuilderPartnerSchedule,
  getBuilderPartnerAgreement,
  grantBuilderPartnerPortalAccess,
  saveBuilderPartnerParticulars,
  sendBuilderPartnerPaymentLink,
  setBuilderPartnerGrantOnSignature,
} from "@/lib/builderPartnerAgreements.functions";
import {
  GRANT_ON_SIGNATURE_LABEL,
  type BuilderPartnerParticulars,
} from "@/lib/agreements/builderPartner.pure";
import { subscriptionIsLive } from "@/lib/agreements/builderPortalPayment.pure";
import { PDF_MIME, saveBase64File } from "@/lib/agreements/saveFile";
import { useUserRoles } from "@/lib/use-user-roles";

const PARTNER_FIELDS: Array<[keyof BuilderPartnerParticulars["partner"], string]> = [
  ["legalName", "Legal name"],
  ["tradingName", "Trading name"],
  ["abn", "ABN"],
  ["acn", "ACN"],
  ["address", "Registered address"],
  ["email", "Notices email"],
  ["phone", "Phone"],
];
const SIGNATORY_FIELDS: Array<[keyof BuilderPartnerParticulars["signatory"], string]> = [
  ["name", "Signatory name"],
  ["email", "Signatory email"],
  ["title", "Signatory title"],
];

const ACCESS_LABEL: Record<string, string> = {
  granted: "Access granted",
  pending: "Granting access",
  failed: "Access not granted yet",
  refused: "Network refused access",
};

const PAYMENT_LINK_LABEL: Record<string, string> = {
  sending: "Sending payment link",
  sent: "Payment link sent",
  failed: "Payment link not sent yet",
  unconfirmed: "Send not confirmed",
  held: "Held — signed before links were sent automatically",
};

const SUBSCRIPTION_LABEL: Record<string, string> = {
  incomplete: "Awaiting payment",
  incomplete_expired: "Payment expired",
  trialing: "Trialing",
  active: "Subscription active",
  past_due: "Payment past due",
  unpaid: "Unpaid",
  canceled: "Subscription cancelled",
  paused: "Subscription paused",
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function when(value: string | null | undefined): string | null {
  return value ? format(new Date(value), "d MMM yyyy, h:mm a") : null;
}

export function BuilderPartnerAgreementPage({ agreementId }: { agreementId: string }) {
  const qc = useQueryClient();
  const roles = useUserRoles();
  const confirm = useConfirm();
  const viewQ = useQuery({
    queryKey: ["agreements", "builder-partner", agreementId],
    queryFn: () => getBuilderPartnerAgreement({ data: { id: agreementId } }),
    refetchInterval: (q) => {
      const v = q.state.data;
      if (!v) return false;
      if (
        v.sendState === "in_flight" ||
        v.portalAccess.status === "pending" ||
        v.portalPayment?.link.status === "sending"
      )
        return 5_000;
      return v.status === "sent" || v.status === "delivered" ? 30_000 : false;
    },
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["agreements"] });
  };

  const [draft, setDraft] = useState<BuilderPartnerParticulars | null>(null);
  const view = viewQ.data;
  useEffect(() => {
    if (view?.particulars && draft === null) setDraft(view.particulars);
  }, [view, draft]);

  const save = useMutation({
    mutationFn: () =>
      saveBuilderPartnerParticulars({
        data: { id: agreementId, particulars: draft, expectedUpdatedAt: view?.updatedAt ?? null },
      }),
    onSuccess: (r) => {
      setDraft(r.particulars);
      toast.success("Particulars saved");
      refresh();
    },
    onError: (err) => toast.error(message(err)),
  });
  const send = useMutation({
    mutationFn: () => sendAgreement({ data: { id: agreementId } }),
    onSuccess: (r) => {
      toast.success(
        r.recovered ? "Envelope recovered from DocuSign" : "Agreement sent for signature",
      );
      refresh();
    },
    onError: (err) => {
      toast.error(message(err));
      refresh();
    },
  });
  const arm = useMutation({
    mutationFn: (armed: boolean) =>
      setBuilderPartnerGrantOnSignature({ data: { id: agreementId, armed } }),
    onSuccess: refresh,
    onError: (err) => toast.error(message(err)),
  });
  const grant = useMutation({
    mutationFn: () => grantBuilderPartnerPortalAccess({ data: { id: agreementId } }),
    onSuccess: (r) => {
      if (r.outcome === "granted") {
        toast.success(
          r.alreadyActive ? "The organisation was already active" : "Builder Portal access granted",
        );
        if (!r.tenant.ok) toast.warning(`Metering account not created: ${r.tenant.error}`);
      } else toast.error(r.detail);
      refresh();
    },
    onError: (err) => toast.error(message(err)),
  });
  const sendLink = useMutation({
    mutationFn: () => sendBuilderPartnerPaymentLink({ data: { id: agreementId } }),
    onSuccess: (r) => {
      if (r.outcome === "sent") toast.success(`Payment link emailed to ${r.to}`);
      else if (r.outcome === "unconfirmed") toast.warning(r.detail);
      else toast.error(r.detail);
      refresh();
    },
    onError: (err) => {
      toast.error(message(err));
      refresh();
    },
  });
  const download = useMutation({
    mutationFn: async (what: "schedule" | "terms" | "signed") => {
      if (what === "schedule") {
        const r = await downloadBuilderPartnerSchedule({ data: { id: agreementId } });
        saveBase64File(r.base64, r.filename, PDF_MIME);
      } else if (what === "terms") {
        const r = await downloadBuilderPartnerAgreementTerms({ data: { id: agreementId } });
        saveBase64File(r.base64, r.filename, r.mediaType);
      } else {
        const r = await downloadSignedAgreement({ data: { id: agreementId } });
        saveBase64File(r.base64, r.filename, PDF_MIME);
      }
    },
    onError: (err) => toast.error(message(err)),
  });
  const remove = useMutation({
    mutationFn: async (kind: "void" | "delete") => {
      if (kind === "delete") await deleteDraftAgreement({ data: { id: agreementId } });
      else await voidAgreement({ data: { id: agreementId, reason: "Withdrawn by Aurixa" } });
      return kind;
    },
    onSuccess: (kind) => {
      toast.success(kind === "delete" ? "Draft deleted" : "Agreement voided");
      refresh();
    },
    onError: (err) => toast.error(message(err)),
  });

  if (viewQ.isPending || roles.loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading agreement…</div>;
  }
  if (viewQ.error || !view) {
    return (
      <div className="space-y-6 p-6">
        <BackLink />
        <EmptyState
          icon={<AlertTriangle />}
          title="The agreement could not be loaded"
          description={message(viewQ.error)}
          action={
            <Button variant="outline" onClick={() => void viewQ.refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Try again
            </Button>
          }
        />
      </div>
    );
  }

  const admin = roles.isAdmin;
  const editable = admin && view.status === "draft" && view.sendState === "unclaimed";
  const blockers = view.gaps?.blockers ?? [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.particulars);
  const open = ["draft", "sent", "delivered"].includes(view.status);
  const canSend =
    admin &&
    view.status === "draft" &&
    view.sendState !== "in_flight" &&
    !dirty &&
    !blockers.length;
  const access = view.portalAccess.status;
  const canGrant =
    admin && view.status === "signed" && access !== "granted" && access !== "pending";
  const payment = view.portalPayment;
  const linkStatus = payment?.link.status ?? null;
  const subscriptionStatus = payment?.subscription.status ?? null;
  const canSendLink =
    admin &&
    Boolean(payment?.installed) &&
    view.status === "signed" &&
    view.signedRecord.retained &&
    linkStatus !== "sending" &&
    !subscriptionIsLive(subscriptionStatus);
  const linkAlreadyWent = linkStatus === "sent" || linkStatus === "unconfirmed";

  const confirmSend = async () => {
    const ok = await confirm({
      title: "Send this Builder Partner Agreement?",
      description: `${view.particulars?.signatory.name} (${view.particulars?.signatory.email}) will be asked to sign the terms in force${view.termsInForce ? ` ("${view.termsInForce.name}", ${view.termsInForce.versionLabel})` : ""} with the execution schedule. The particulars are fixed once it is sent.`,
      confirmText: "Send for signature",
    });
    if (ok) send.mutate();
  };
  const confirmGrant = async () => {
    const ok = await confirm({
      title: "Admit this builder to the Builder Portal?",
      description:
        "This approves the organisation on the Builders Network on the basis of this signed agreement. The builder's account becomes active.",
      confirmText: "Grant access",
    });
    if (ok) grant.mutate();
  };
  const confirmSendLink = async () => {
    if (!payment) return;
    const previous = linkAlreadyWent
      ? ` A link was ${linkStatus === "sent" ? `sent${payment.link.sentAt ? ` on ${when(payment.link.sentAt)}` : ""}` : "possibly sent already"}; this sends another.`
      : "";
    const ok = await confirm({
      title: linkAlreadyWent ? "Send the payment link again?" : "Send the payment link?",
      description: `${view.particulars?.signatory.name ?? "The signatory"} (${view.particulars?.signatory.email ?? "their email"}) will be emailed their own Stripe link for the Builder / Developer Portal subscription: ${payment.price.sentence}.${previous}`,
      confirmText: linkAlreadyWent ? "Send again" : "Send payment link",
    });
    if (ok) sendLink.mutate();
  };
  const copyLink = async () => {
    if (!payment?.url) return;
    try {
      await navigator.clipboard.writeText(payment.url);
      toast.success("The builder's payment link is copied");
    } catch {
      toast.error("The link could not be copied");
    }
  };
  const confirmRemove = async (kind: "void" | "delete") => {
    const ok = await confirm({
      title: kind === "delete" ? "Delete this draft?" : "Void this agreement?",
      description:
        kind === "delete"
          ? "Nothing was sent. The organisation can be sent a new agreement later."
          : "DocuSign withdraws the envelope and the builder can no longer sign it.",
      confirmText: kind === "delete" ? "Delete draft" : "Void agreement",
      destructive: true,
    });
    if (ok) remove.mutate(kind);
  };

  return (
    <div className="space-y-6 p-6">
      <BackLink />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Builder Partner Agreement
          </p>
          <h1 className="text-2xl font-semibold">
            {view.particulars?.partner.legalName || "Unnamed builder"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {view.reference ?? "No reference"} · <Badge variant="outline">{view.status}</Badge>
            {view.builderOrganisationId ? (
              <>
                {" "}
                ·{" "}
                <Link to="/builders-network" className="underline">
                  Builders Network
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {view.status === "draft" && admin ? (
            <Button onClick={() => void confirmSend()} disabled={!canSend || send.isPending}>
              <Send className="mr-1.5 h-4 w-4" />
              {view.sendState === "stale"
                ? "Send again (checks DocuSign first)"
                : "Send for signature"}
            </Button>
          ) : null}
          {view.status === "signed" ? (
            <Button variant="outline" onClick={() => download.mutate("signed")}>
              <Download className="mr-1.5 h-4 w-4" /> Signed agreement
            </Button>
          ) : null}
          {admin && view.status === "draft" && view.sendState === "unclaimed" ? (
            <Button variant="ghost" onClick={() => void confirmRemove("delete")}>
              Delete draft
            </Button>
          ) : null}
          {admin && (view.status === "sent" || view.status === "delivered") ? (
            <Button variant="ghost" onClick={() => void confirmRemove("void")}>
              Void
            </Button>
          ) : null}
        </div>
      </header>

      {!view.docusignReady ? (
        <Notice tone="error">
          DocuSign is not configured, so nothing can be sent or retained.
        </Notice>
      ) : null}
      {view.status === "draft" && view.termsState !== "in_force" ? (
        <Notice tone="error">
          No Builder Partner terms are in force.{" "}
          <Link to="/agreements/builder-partner-terms" className="underline">
            Register and put the terms in force
          </Link>{" "}
          before sending.
        </Notice>
      ) : null}
      {view.sendState === "in_flight" ? (
        <Notice tone="info">This agreement is being sent.</Notice>
      ) : null}
      {view.sendState === "stale" ? (
        <Notice tone="warn">
          An earlier send did not finish. Sending again first asks DocuSign whether it created the
          envelope.
        </Notice>
      ) : null}

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">Particulars</h2>
        {draft ? (
          <div className="grid gap-3 md:grid-cols-2">
            {PARTNER_FIELDS.map(([key, label]) => (
              <Field key={`partner.${key}`} id={`partner-${key}`} label={label}>
                <Input
                  id={`partner-${key}`}
                  value={draft.partner[key]}
                  disabled={!editable}
                  onChange={(e) =>
                    setDraft({ ...draft, partner: { ...draft.partner, [key]: e.target.value } })
                  }
                />
              </Field>
            ))}
            {SIGNATORY_FIELDS.map(([key, label]) => (
              <Field key={`signatory.${key}`} id={`signatory-${key}`} label={label}>
                <Input
                  id={`signatory-${key}`}
                  value={draft.signatory[key]}
                  disabled={!editable}
                  onChange={(e) =>
                    setDraft({ ...draft, signatory: { ...draft.signatory, [key]: e.target.value } })
                  }
                />
              </Field>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">The particulars could not be read.</p>
        )}
        {blockers.length ? (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        {view.gaps?.warnings.length ? (
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {view.gaps.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {editable ? (
          <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            <Save className="mr-1.5 h-4 w-4" /> Save particulars
          </Button>
        ) : null}
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">Terms and execution schedule</h2>
        {view.issued ? (
          <p className="text-sm">
            Sent under “{view.issued.terms.name}” ({view.issued.terms.versionLabel}), SHA-256{" "}
            <code>{view.issued.terms.sha256.slice(0, 16)}…</code>, issued{" "}
            {when(view.issued.issuedAt)}.
            {view.issued.countersigner
              ? ` Countersigned by ${view.issued.countersigner.name}.`
              : ""}
          </p>
        ) : view.termsInForce ? (
          <p className="text-sm">
            Will be sent under the terms in force: “{view.termsInForce.name}” (
            {view.termsInForce.versionLabel})
            {view.termsInForce.countersignatureRequired ? ", countersigned by Aurixa" : ""}.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => download.mutate("terms")}>
            <Download className="mr-1.5 h-4 w-4" /> Terms
          </Button>
          <Button variant="outline" size="sm" onClick={() => download.mutate("schedule")}>
            <Download className="mr-1.5 h-4 w-4" />{" "}
            {view.issued ? "Execution schedule" : "Preview schedule"}
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 font-medium">
          <ShieldCheck className="h-4 w-4" /> Builder Portal access
        </h2>
        <div className="flex items-center gap-3">
          <Switch
            id="grant-on-signature"
            checked={view.grantAccessOnSignature}
            disabled={
              !admin ||
              arm.isPending ||
              (!open && !view.grantAccessOnSignature) ||
              access === "granted"
            }
            onCheckedChange={(armed) => arm.mutate(armed)}
          />
          <Label htmlFor="grant-on-signature">{GRANT_ON_SIGNATURE_LABEL}</Label>
        </div>
        <p className="text-sm text-muted-foreground">
          {view.grantAccessOnSignature
            ? "When the signed agreement has been retained, the organisation is approved on the Builders Network without waiting for an admin."
            : "When signed, an admin approves the organisation from here or from the Builders Network console."}
        </p>
        {access ? (
          <p className="text-sm">
            <Badge variant={access === "granted" ? "default" : "outline"}>
              {ACCESS_LABEL[access] ?? access}
            </Badge>{" "}
            {when(view.portalAccess.grantedAt ?? view.portalAccess.attemptedAt)}
            {view.portalAccess.detail ? ` — ${view.portalAccess.detail}` : ""}
          </p>
        ) : null}
        {view.status === "signed" && !view.signedRecord.retained ? (
          <Notice tone="warn">
            The signed agreement has not been copied out of DocuSign yet; automatic access waits for
            it.
          </Notice>
        ) : null}
        {access === "granted" && view.meteringAccount === false ? (
          <Notice tone="warn">
            The builder's metering account is missing; the agreements sweep creates it.
          </Notice>
        ) : null}
        {canGrant ? (
          <Button size="sm" onClick={() => void confirmGrant()} disabled={grant.isPending}>
            Grant Builder Portal access
          </Button>
        ) : null}
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 font-medium">
          <CreditCard className="h-4 w-4" /> Portal subscription
        </h2>
        {payment ? (
          <>
            <p className="text-sm text-muted-foreground">
              When the signed agreement has been retained, the signatory is emailed their own Stripe
              link for the monthly Portal subscription: {payment.price.sentence}. New Build and
              Development Sale fees are separate and are invoiced only when earned; this link never
              charges them.
            </p>
            {!payment.installed ? (
              <Notice tone="warn">
                The payment-link migration has not been applied to this database yet, so no link is
                sent.
              </Notice>
            ) : null}
            {linkStatus ? (
              <p className="text-sm">
                <Badge variant={linkStatus === "sent" ? "default" : "outline"}>
                  {PAYMENT_LINK_LABEL[linkStatus] ?? linkStatus}
                </Badge>{" "}
                {linkStatus === "sent"
                  ? `${when(payment.link.sentAt) ?? ""}${payment.link.sentTo ? ` to ${payment.link.sentTo}` : ""}`
                  : when(payment.link.attemptedAt)}
                {payment.link.detail ? ` — ${payment.link.detail}` : ""}
              </p>
            ) : view.status === "signed" && payment.installed ? (
              <p className="text-sm text-muted-foreground">
                {view.signedRecord.retained
                  ? "The payment link has not been sent yet; the agreements sweep sends it."
                  : "The payment link waits for the signed agreement to be retained."}
              </p>
            ) : null}
            {subscriptionStatus ? (
              <p className="text-sm">
                <Badge variant={subscriptionStatus === "active" ? "default" : "outline"}>
                  {SUBSCRIPTION_LABEL[subscriptionStatus] ?? subscriptionStatus}
                </Badge>{" "}
                {payment.subscription.id ? <code>{payment.subscription.id}</code> : null}
                {payment.subscription.startedAt
                  ? ` · started ${when(payment.subscription.startedAt)}`
                  : ""}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {canSendLink ? (
                <Button
                  size="sm"
                  onClick={() => void confirmSendLink()}
                  disabled={sendLink.isPending}
                >
                  <Mail className="mr-1.5 h-4 w-4" />
                  {linkStatus === null || linkStatus === "held"
                    ? "Send payment link"
                    : "Send payment link again"}
                </Button>
              ) : null}
              {payment.url && view.status === "signed" ? (
                <Button size="sm" variant="outline" onClick={() => void copyLink()}>
                  <Copy className="mr-1.5 h-4 w-4" /> Copy the builder's link
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            The Portal subscription could not be read.
          </p>
        )}
      </section>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Notice({ tone, children }: { tone: "info" | "warn" | "error"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-destructive/40 text-destructive"
      : tone === "warn"
        ? "border-warning/40 text-warning"
        : "border-border text-muted-foreground";
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

function BackLink() {
  return (
    <Link
      to="/agreements"
      className="inline-flex items-center text-sm text-muted-foreground hover:underline"
    >
      <ArrowLeft className="mr-1 h-4 w-4" /> Agreements
    </Link>
  );
}
