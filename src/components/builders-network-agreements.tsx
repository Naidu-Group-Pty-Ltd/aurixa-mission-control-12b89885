/**
 * The Builder Partner Agreement on the Builders Network console: what each
 * organisation has signed, the act that drafts one, and the dialog Approve
 * opens when the gate asks for a signature.
 *
 * The console never decides whether an organisation may be approved. The
 * server does, in `approveNetworkOrganisation`, reading the agreements itself
 * at the moment of approval; a list drawn a minute ago is not evidence. What
 * is drawn here is the standing an operator needs in order to act BEFORE
 * pressing Approve, and the gate's own words when they press it anyway.
 *
 * Nothing here touches the waitlist. A builder applies on the website, the
 * network records an access request and an organisation, and this console
 * approves it — the agreement is one more thing Approve looks at, not a step
 * inserted into how an account is made.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FileSignature, Loader2, PlayCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import {
  BUILDER_PARTNER_DOCUMENT_NAME,
  GRANT_ON_SIGNATURE_LABEL,
  WAIVER_REASON_MAX,
  WAIVER_REASON_MIN,
  type BuilderAgreementSummary,
  type OrganisationAgreementState,
} from "@/lib/agreements/builderPartner.pure";

/** What the console knows about one organisation's agreements. */
export type AgreementStandingRead =
  | { state: "loading" }
  | { state: "unreadable" }
  | { state: "not_installed" }
  | {
      state: "read";
      termsInForce: boolean;
      /** False when the read stopped short; an absent entry is then unknown. */
      complete: boolean;
      entry: OrganisationAgreementState | null;
    };

const STATUS_WORD: Record<string, string> = {
  draft: "drafted",
  sent: "sent",
  delivered: "delivered",
  signed: "signed",
  declined: "declined",
  voided: "voided",
};

function AgreementLink({
  agreement,
  children,
}: {
  agreement: BuilderAgreementSummary;
  children: ReactNode;
}) {
  return (
    <Link
      to="/agreements/$agreementId"
      params={{ agreementId: agreement.id }}
      className="underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}

/**
 * One organisation's agreement, as a line under its name.
 *
 * Four things it will not do: claim an organisation has no agreement when the
 * read failed or stopped short; offer to draft one for a closed organisation;
 * colour a healthy signature as though something were wrong; and call a
 * signed agreement "access granted" — access is the network's record, shown
 * by the status badge beside it, and the agreement page says what happened to
 * the grant.
 */
export function AgreementStanding({
  organisationStatus,
  standing,
  busy,
  onSend,
}: {
  organisationStatus: string;
  standing: AgreementStandingRead;
  busy: boolean;
  onSend: () => void;
}) {
  if (standing.state === "loading" || standing.state === "not_installed") return null;
  if (standing.state === "unreadable") {
    return (
      <p className="text-xs text-muted-foreground">
        {BUILDER_PARTNER_DOCUMENT_NAME}: could not be read — this is not a statement that none was
        signed.
      </p>
    );
  }
  const entry = standing.entry;
  const closed = organisationStatus === "closed";

  if (entry?.kind === "signed") {
    const access = entry.agreement.portalAccessStatus;
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary" className="gap-1">
          <FileSignature className="h-3 w-3" aria-hidden /> Agreement signed
        </Badge>
        <AgreementLink agreement={entry.agreement}>
          {entry.agreement.reference ?? "Open agreement"}
        </AgreementLink>
        {entry.inFlight ? (
          <span className="text-muted-foreground">
            · a replacement is {STATUS_WORD[entry.inFlight.status] ?? entry.inFlight.status} (
            <AgreementLink agreement={entry.inFlight}>
              {entry.inFlight.reference ?? "open"}
            </AgreementLink>
            )
          </span>
        ) : null}
        {access === "failed" || access === "refused" ? (
          <span className="text-destructive">
            · the Builder Portal did not admit them after signing — see the agreement
          </span>
        ) : null}
      </div>
    );
  }

  if (entry?.kind === "in_flight") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="gap-1">
          <FileSignature className="h-3 w-3" aria-hidden /> Agreement{" "}
          {STATUS_WORD[entry.agreement.status] ?? entry.agreement.status}
        </Badge>
        <AgreementLink agreement={entry.agreement}>
          {entry.agreement.reference ?? "Open agreement"}
        </AgreementLink>
        {entry.agreement.grantAccessOnSignature ? (
          <span className="text-muted-foreground">· access follows the signature</span>
        ) : null}
      </div>
    );
  }

  // No entry. That means "none" only when the read was complete.
  if (!entry && !standing.complete) {
    return (
      <p className="text-xs text-muted-foreground">
        {BUILDER_PARTNER_DOCUMENT_NAME}: not established — there were more agreements than the
        console reads at once. Open Agreements to check before sending another.
      </p>
    );
  }
  const lastEnded = entry?.kind === "none" ? entry.lastEnded : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        {standing.termsInForce
          ? "No signed agreement — approval waits for one."
          : "No agreement signed (none is required while no terms are in force)."}
      </span>
      {lastEnded ? (
        <span className="text-muted-foreground">
          The last one was {STATUS_WORD[lastEnded.status] ?? lastEnded.status} (
          <AgreementLink agreement={lastEnded}>{lastEnded.reference ?? "open"}</AgreementLink>).
        </span>
      ) : null}
      {closed ? null : (
        <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={onSend}>
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <FileSignature className="mr-1 h-3.5 w-3.5" aria-hidden />
          )}
          {lastEnded ? "Send a new agreement" : "Send agreement"}
        </Button>
      )}
    </div>
  );
}

/** What Approve was told when the gate asked for a signature. */
export type ApprovalGateRefusal = {
  organisationId: string;
  legalName: string;
  code: "agreement_required" | "agreement_in_flight";
  detail: string;
  openAgreementId: string | null;
};

/**
 * The gate's answer, and the two lawful ways on.
 *
 * The way the gate intends is the agreement: draft one, or open the one in
 * flight. The other is an admin's decision to admit the builder without one,
 * which is allowed only in words — the reason travels to the network as the
 * approval's reason and is written to the audit log, so an approval is
 * explainable from the record alone. Removing a ceremony must never remove a
 * control: this dialog does not approve anything itself; it asks the same
 * server function Approve asked, with the reason attached, and the server
 * decides again.
 */
export function ApprovalGateDialog({
  refusal,
  onOpenChange,
  onApprove,
  sending,
  onSend,
}: {
  refusal: ApprovalGateRefusal | null;
  onOpenChange: (next: boolean) => void;
  /** Resolves to an error sentence to show in the dialog, or null when approved. */
  onApprove: (refusal: ApprovalGateRefusal, waiverReason: string) => Promise<string | null>;
  sending: boolean;
  onSend: (organisationId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setReason("");
    setProblem(null);
  }, [refusal]);

  const trimmed = reason.replace(/\s+/g, " ").trim();
  const approve = async () => {
    if (!refusal) return;
    setBusy(true);
    try {
      setProblem(await onApprove(refusal, trimmed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={refusal !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{refusal?.legalName} has not signed</DialogTitle>
          <DialogDescription>{refusal?.detail}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Send the agreement (recommended)</p>
          <p className="text-xs text-muted-foreground">
            {refusal?.code === "agreement_in_flight"
              ? `The agreement is already in progress. Open it to send, chase or check it; switch on “${GRANT_ON_SIGNATURE_LABEL}” there and the builder is admitted once they have signed.`
              : `Draft the agreement from what the builder told us when they applied, check it, and send it. With “${GRANT_ON_SIGNATURE_LABEL}” on, the builder is admitted once they have signed.`}
          </p>
          {refusal?.code === "agreement_in_flight" && refusal.openAgreementId ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/agreements/$agreementId" params={{ agreementId: refusal.openAgreementId }}>
                <FileSignature className="mr-1 h-4 w-4" aria-hidden /> Open the agreement
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={sending || !refusal}
              onClick={() => refusal && onSend(refusal.organisationId)}
            >
              {sending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <FileSignature className="mr-1 h-4 w-4" aria-hidden />
              )}
              Draft the agreement
            </Button>
          )}
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <Label htmlFor="approval-waiver" className="text-sm font-medium">
            Or approve without a signed agreement
          </Label>
          <p className="text-xs text-muted-foreground">
            Record why. The reason is sent to the Builders Network as the reason for the approval
            and kept in the audit log.
          </p>
          <Textarea
            id="approval-waiver"
            rows={3}
            maxLength={WAIVER_REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Signed on paper at the 12 Oct meeting; scanned copy filed with the contract."
          />
          <p className="text-xs text-muted-foreground">
            At least {WAIVER_REASON_MIN} characters ({trimmed.length} so far).
          </p>
          {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void approve()}
            disabled={busy || trimmed.length < WAIVER_REASON_MIN}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <PlayCircle className="mr-1 h-4 w-4" aria-hidden />
            )}
            Approve without an agreement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
