import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Copy, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { readNetworkFailure } from "@/lib/buildersNetworkFailure.pure";
// One list of the network's organisation kinds, shared with the public
// application form: two copies is how the console and the form come to offer
// different types of business.
import { ORG_TYPE_LABEL } from "@/lib/builderOrgTypes.pure";
import {
  createNetworkOrganisation,
  updateNetworkOrganisation,
  closeNetworkOrganisation,
  reopenNetworkOrganisation,
  inviteNetworkOrganisationOwner,
  ORGANISATION_FIELDS,
  AU_STATES,
  type NetworkOrganisation,
} from "@/server/builders-network.functions";

/**
 * The four acts the Builders Network console performs ON an organisation
 * rather than on the network: write it, close it, reopen it, and seed its
 * first owner.
 *
 * They live beside the console rather than inside it because the route file
 * is already the status strip, the organisation register, the join queue, the
 * shadow connections and the marketplace ranking — and a dialog is not a
 * screen. What is load-bearing about the split is nothing: these are mounted
 * by `/builders-network` alone and every rule they answer to is asserted
 * against this file by `buildersNetworkOrganisationCrud.test.ts`.
 */
/**
 * The organisation an operator writes, created and edited by ONE form.
 *
 * Create and edit take the same fields because they are the same fields —
 * two forms is how one of them comes to be missing a column. What is
 * deliberately absent is the lifecycle: `status`, `is_active` and the
 * activation and suspension stamps are tied together by three CHECK
 * constraints on the network's table and move only under Approve, Suspend,
 * Reinstate and Close. A status dropdown here would be a second way to move
 * a lifecycle, and the two would disagree the first time one forgot a stamp.
 */
/**
 * The network's refusal, as a sentence.
 *
 * Every one of these was rendered RAW — `toast.error(result.error)` put
 * `abn_already_registered` in front of an operator, which is the database
 * vocabulary this codebase forbids reaching a person. `readNetworkFailure`
 * already existed to answer exactly this, authored where the wording matters
 * and unslugged where it does not, so the dialogs ask it rather than
 * carrying a second list of their own.
 */
function refusal(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return readNetworkFailure(error.message).sentence;
  return fallback;
}

type OrgFormValues = Record<string, string>;

const EMPTY_ORG_FORM: OrgFormValues = Object.fromEntries(
  ORGANISATION_FIELDS.map((field) => [field, ""]),
) as OrgFormValues;

function organisationToForm(organisation: NetworkOrganisation | null): OrgFormValues {
  if (!organisation) return { ...EMPTY_ORG_FORM };
  const source = organisation as unknown as Record<string, unknown>;
  return Object.fromEntries(
    ORGANISATION_FIELDS.map((field) => [
      field,
      typeof source[field] === "string" ? String(source[field]) : "",
    ]),
  ) as OrgFormValues;
}

export function OrganisationFormDialog({
  open,
  onOpenChange,
  organisation,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** null creates; a row edits it. */
  organisation: NetworkOrganisation | null;
  onSaved: () => void;
}) {
  const createFn = useServerFn(createNetworkOrganisation);
  const updateFn = useServerFn(updateNetworkOrganisation);
  const [values, setValues] = useState<OrgFormValues>(() => organisationToForm(organisation));
  const [saving, setSaving] = useState(false);
  const editing = organisation !== null;
  // `org_type` is NOT NULL with no default and `legal_name` is NOT NULL, so a
  // save without either is one the network refuses. Offering it and reporting
  // the refusal afterwards is how "The organisation could not be saved"
  // reached an operator with no field named.
  const canSave = Boolean(values.legal_name.trim() && values.org_type.trim());

  // Re-seed whenever the dialog opens on a different subject, so editing one
  // organisation and then another does not show the first one's details.
  useEffect(() => {
    if (open) setValues(organisationToForm(organisation));
  }, [open, organisation]);

  const set =
    (field: string) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues((prev) => ({ ...prev, [field]: event.target.value }));

  const save = async () => {
    if (!values.legal_name.trim()) {
      toast.error("A legal name is required");
      return;
    }
    if (!values.org_type.trim()) {
      toast.error("An organisation type is required");
      return;
    }
    setSaving(true);
    try {
      const result = editing
        ? await updateFn({ data: { organisationId: organisation.id, ...values } })
        : await createFn({ data: { ...values, legal_name: values.legal_name } });
      if (!result.ok) throw new Error(result.error);
      toast.success(
        editing
          ? "Organisation updated"
          : `${values.legal_name.trim()} created — it still needs approving`,
      );
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(refusal(error, "The organisation could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  const field = (name: string, label: string, placeholder?: string) => (
    <div className="space-y-1">
      <Label htmlFor={`org-${name}`}>{label}</Label>
      <Input
        id={`org-${name}`}
        value={values[name] ?? ""}
        onChange={set(name)}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${organisation.legal_name}` : "New organisation"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes the organisation's details. Its status is moved by Approve, Suspend, Reinstate and Close — not here."
              : "Creates the organisation unapproved, exactly as a self-serve registration arrives. Approving it is a separate decision."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            {field("legal_name", "Legal name (required)", "Bright Homes Pty Ltd")}
          </div>
          {field("trading_name", "Trading name", "Bright Homes")}
          <div className="space-y-1">
            <Label htmlFor="org-org_type">Type (required)</Label>
            <Select
              value={values.org_type || undefined}
              onValueChange={(next) => setValues((prev) => ({ ...prev, org_type: next }))}
            >
              <SelectTrigger id="org-org_type">
                <SelectValue placeholder="Choose a type…" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ORG_TYPE_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {field("abn", "ABN", "12 345 678 901")}
          {field("acn", "ACN")}
          {field("contact_email", "Contact email", "owner@example.com")}
          {field("contact_phone", "Contact phone")}
          <div className="sm:col-span-2">{field("website", "Website", "https://example.com")}</div>
          <div className="sm:col-span-2">{field("address_line1", "Address")}</div>
          <div className="sm:col-span-2">{field("address_line2", "Address line 2")}</div>
          {field("suburb", "Suburb")}
          <div className="space-y-1">
            <Label htmlFor="org-state">State</Label>
            <Select
              value={values.state || undefined}
              onValueChange={(next) => setValues((prev) => ({ ...prev, state: next }))}
            >
              <SelectTrigger id="org-state">
                <SelectValue placeholder="Choose a state…" />
              </SelectTrigger>
              <SelectContent>
                {AU_STATES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {field("postcode", "Postcode")}
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="org-notes">Operator notes</Label>
            <Textarea id="org-notes" rows={3} value={values.notes ?? ""} onChange={set("notes")} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !canSave}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            {editing ? "Save changes" : "Create organisation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Closing, which takes an organisation off the network and says what it keeps.
 *
 * This dialog used to say closing was final — "a closed organisation cannot be
 * reopened" — while the network had only ever written the organisation's
 * status: every member, listing, document and connection survived it, and no
 * control anywhere could bring them back. Closing is reversible now, through
 * `ReopenOrganisationDialog`, and the copy says so rather than promising a
 * finality nothing enforces.
 *
 * Its own dialog rather than a status dropdown: suspension and closure are
 * different decisions (a suspended organisation is still on the network, a
 * closed one is not), and offering them in one control invites the wrong one.
 */
export function CloseOrganisationDialog({
  organisation,
  onOpenChange,
  onClosed,
}: {
  organisation: NetworkOrganisation | null;
  onOpenChange: (next: boolean) => void;
  onClosed: () => void;
}) {
  const closeFn = useServerFn(closeNetworkOrganisation);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReason("");
  }, [organisation]);

  const confirm = async () => {
    if (!organisation || !reason.trim()) return;
    setBusy(true);
    try {
      const result = await closeFn({
        data: { organisationId: organisation.id, reason: reason.trim() },
      });
      if (!result.ok) throw new Error(result.error);
      toast.success(`${organisation.legal_name} closed`);
      onOpenChange(false);
      onClosed();
    } catch (error) {
      toast.error(refusal(error, "The organisation could not be closed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={organisation !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close {organisation?.legal_name}</DialogTitle>
          <DialogDescription>
            Closing takes it off the network: its members lose access to the portal and it can no
            longer be edited, approved or given an owner. Nothing is deleted — its members, listings
            and every record of what it did on the network are kept, and it can be reopened from
            this console. If you only need to stop it for now, suspend it instead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="close-reason">Reason</Label>
          <Input
            id="close-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this organisation being closed?"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void confirm()}
            disabled={busy || !reason.trim()}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            Close organisation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reopening a closed organisation.
 *
 * The network decides where it comes back to and never brings it back higher
 * than it was: one that was never approved returns to the approval queue, and
 * one that was approved returns SUSPENDED — unless the operator asks, here and
 * in the same act, for its members' access back. Restoring access is a
 * decision, not a side effect, which is why it is an unticked box rather than
 * the default; and it is offered only where there is access to restore
 * (`activated_at`), because an organisation that was never approved goes back
 * through approval and everything that gates it.
 */
export function ReopenOrganisationDialog({
  organisation,
  onOpenChange,
  onReopened,
}: {
  organisation: NetworkOrganisation | null;
  onOpenChange: (next: boolean) => void;
  onReopened: () => void;
}) {
  const reopenFn = useServerFn(reopenNetworkOrganisation);
  const [reason, setReason] = useState("");
  const [reinstate, setReinstate] = useState(false);
  const [busy, setBusy] = useState(false);
  const wasApproved = Boolean(organisation?.activated_at);

  useEffect(() => {
    setReason("");
    setReinstate(false);
  }, [organisation]);

  const confirm = async () => {
    if (!organisation || !reason.trim()) return;
    setBusy(true);
    try {
      const result = await reopenFn({
        data: {
          organisationId: organisation.id,
          reason: reason.trim(),
          reinstate: wasApproved && reinstate,
        },
      });
      if (!result.ok) throw new Error(result.error);
      // Each landing is said as what it means for the organisation, so the
      // operator knows whether anything is still theirs to do.
      const name = organisation.legal_name;
      if (result.alreadyOpen) {
        toast.info(`${name} was already open — nothing was changed`);
      } else if (result.status === "active") {
        toast.success(`${name} reopened — its members can sign in again`);
      } else if (result.status === "suspended") {
        toast.success(`${name} reopened as suspended — reinstate it to restore access`);
      } else {
        toast.success(`${name} reopened — it is back in the approval queue`);
      }
      onOpenChange(false);
      onReopened();
    } catch (error) {
      toast.error(refusal(error, "The organisation could not be reopened."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={organisation !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen {organisation?.legal_name}</DialogTitle>
          <DialogDescription>
            {wasApproved
              ? "Brings it back with everything it had — members, listings and records. It returns suspended, so nobody can sign in to it until it is reinstated, unless you restore access below."
              : "Brings it back with everything it had. It was never approved, so it returns to the approval queue and is approved the usual way."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reopen-reason">Reason</Label>
          <Input
            id="reopen-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this organisation being reopened?"
          />
        </div>
        {wasApproved ? (
          <div className="flex items-start gap-2 pt-1">
            <Checkbox
              id="reopen-reinstate"
              checked={reinstate}
              onCheckedChange={(next) => setReinstate(next === true)}
            />
            <Label htmlFor="reopen-reinstate" className="text-sm font-normal leading-snug">
              Restore access now
              <span className="block text-xs text-muted-foreground">
                Its members can sign in again straight away. Leave this unticked to reopen it
                suspended and reinstate it when you are ready.
              </span>
            </Label>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={busy || !reason.trim()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            Reopen organisation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the network answered, in the shape the dialog renders.
 *
 * `invite_url` is nullable twice over. An ATTACH mints nothing: the person
 * already had an account, so ownership is granted and there is no credential
 * to hand over. And an invitation can be minted and WITHHELD
 * (`link_withheld`): when the address is still a pending invitee of another
 * organisation, its link would open that organisation too, so the network
 * sends it to the invitee by email rather than handing it to an operator.
 */
type InviteResult = {
  outcome: "invited" | "attached";
  invite_url: string | null;
  link_withheld: boolean;
  /** The same person's waiting invitation, issued again: earlier links are dead. */
  reissued: boolean;
  expires_at: string | null;
  expires_in_hours: number | null;
  email_requested: boolean;
  email_sent: boolean;
  email_failure: string | null;
};

/**
 * Why a send did not happen, in words an operator can act on.
 *
 * `not_configured` is this deployment's own setting and `refused` is almost
 * always an unverified sender domain — two different people fix those, so
 * they are never collapsed into "the email failed".
 */
const EMAIL_FAILURE: Record<string, string> = {
  not_configured:
    "No mail is configured on the network, so nothing was sent — pass the link on yourself.",
  refused:
    "The mail provider refused the send (usually an unverified sender domain), so pass the link on yourself.",
  unreachable: "The mail provider could not be reached, so pass the link on yourself.",
};

/**
 * The first owner's invite link.
 *
 * The network stores only the link's hash, so it comes back exactly once —
 * which is why the minted link is DISPLAYED, selectable and copyable, rather
 * than promised. A box an operator cannot copy out of is the defect this
 * codebase has already paid for twice.
 */
export function InviteOwnerDialog({
  organisation,
  onOpenChange,
}: {
  organisation: NetworkOrganisation | null;
  onOpenChange: (next: boolean) => void;
}) {
  const inviteFn = useServerFn(inviteNetworkOrganisationOwner);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
  const [result, setResult] = useState<InviteResult | null>(null);

  useEffect(() => {
    setEmail("");
    setName("");
    setSendEmail(true);
    setResult(null);
  }, [organisation]);

  const mint = async () => {
    if (!organisation) return;
    setBusy(true);
    try {
      const answer = await inviteFn({
        data: {
          organisationId: organisation.id,
          email: email.trim(),
          name: name.trim(),
          sendEmail,
        },
      });
      if (!answer.ok) throw new Error(answer.error);
      setResult(answer);
    } catch (error) {
      toast.error(refusal(error, "The invitation could not be issued."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={organisation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Invite the first owner of {organisation?.legal_name}</DialogTitle>
          <DialogDescription>
            Seeds this organisation's first member as its owner. It is offered only while the
            organisation has none — from then on its owner invites their own colleagues, which is
            not an operator's decision to make.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            {result.outcome === "attached" ? (
              // No link, because none was minted. They already hold an
              // account, so ownership is simply theirs now — telling an
              // operator to "send them the link" would send them nothing.
              <p className="text-sm">
                {name.trim() || "They"} already had an account on the network, so no invitation was
                needed — ownership of {organisation?.legal_name} is theirs now and it appears in
                their organisation switcher next time they sign in. Their existing password still
                works and nothing about their account was changed. If they no longer know it, the
                Builder Portal&rsquo;s &ldquo;Forgot password&rdquo; link sends them a new one.
              </p>
            ) : result.link_withheld || !result.invite_url ? (
              // Minted, and deliberately not shown. Drawing an empty copy box
              // here would be the uncopyable-empty-box defect again, and
              // telling the operator to "send them the link" would ask for
              // something they were never given.
              <p className="text-sm">
                The invitation for {name.trim() || "them"} was issued, but its link is not shown
                here: {email.trim() || "this address"} already belongs to another organisation on
                the network (a closed one counts), and a link in anyone else&rsquo;s hands could be
                used to take over that account. It is sent only to their own inbox. When they accept
                it, ownership of {organisation?.legal_name} is theirs.
              </p>
            ) : (
              <>
                <p className="text-sm">
                  Send this link to {name.trim() || "them"}. It is shown once — only its fingerprint
                  is stored — so copy it now; if it is lost, use Invite owner again with the same
                  address to mint another.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={result.invite_url ?? ""}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="Copy the invite link"
                    onClick={() => {
                      void navigator.clipboard.writeText(result.invite_url ?? "");
                      toast.success("Invite link copied");
                    }}
                  >
                    <Copy className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Expires in {result.expires_in_hours} hours
                  {result.expires_at
                    ? ` — ${new Date(result.expires_at).toLocaleString("en-AU")}`
                    : ""}
                  .
                </p>
              </>
            )}
            {result.reissued ? (
              <p className="text-xs text-muted-foreground">
                This replaces the invitation issued to them before — any earlier link no longer
                works.
              </p>
            ) : null}
            {/* Whether the email went is said outright either way. A send
                that failed and a send nobody asked for are different
                things to an operator holding a link. */}
            {result.email_requested ? (
              result.email_sent ? (
                <p className="text-xs text-muted-foreground">Emailed to {email.trim()}.</p>
              ) : result.link_withheld || (result.outcome === "invited" && !result.invite_url) ? (
                // There is no link in the operator's hands to "pass on", so
                // the failure names the act that IS available to them.
                <p className="text-xs text-destructive">
                  The email could not be sent, and the link is not shown here, so they have not
                  received it. Once mail is working, use Invite owner again with the same address —
                  that issues a fresh invitation and this one stops working.
                </p>
              ) : (
                <p className="text-xs text-destructive">
                  {EMAIL_FAILURE[result.email_failure ?? ""] ??
                    "The email could not be sent, so pass it on yourself."}
                </p>
              )
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="invite-name">Their name</Label>
              <Input
                id="invite-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="invite-email">Their email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </div>
            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id="invite-send-email"
                checked={sendEmail}
                onCheckedChange={(next) => setSendEmail(next === true)}
              />
              <Label htmlFor="invite-send-email" className="text-sm font-normal leading-snug">
                Email it to them
                <span className="block text-xs text-muted-foreground">
                  Sends the invitation on the Builder Portal&rsquo;s own letterhead. The link is
                  shown here either way.
                </span>
              </Label>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result && (
            <Button onClick={() => void mint()} disabled={busy || !email.trim() || !name.trim()}>
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Mail className="mr-2 h-4 w-4" aria-hidden />
              )}
              {sendEmail ? "Mint and send the invite" : "Mint the invite link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
