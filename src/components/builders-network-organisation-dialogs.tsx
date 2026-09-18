import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Copy, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
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
  createNetworkOrganisation,
  updateNetworkOrganisation,
  closeNetworkOrganisation,
  inviteNetworkOrganisationOwner,
  ORGANISATION_FIELDS,
  AU_STATES,
  type NetworkOrganisation,
} from "@/server/builders-network.functions";

/**
 * The three acts the Builders Network console performs ON an organisation
 * rather than on the network: write it, close it, and seed its first owner.
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
const ORG_TYPE_LABEL: Record<string, string> = {
  builder: "Builder",
  developer: "Developer",
  builder_developer: "Builder & developer",
  sales_representative: "Sales representative",
};

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
      toast.error(error instanceof Error ? error.message : "The organisation could not be saved");
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
 * Closing, which is the end and says so.
 *
 * Its own dialog rather than a status dropdown: suspension is reversible and
 * closing is not, and offering them in one control invites the wrong one.
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
      toast.error(error instanceof Error ? error.message : "The organisation could not be closed");
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
            Closing is final — a closed organisation cannot be reopened, approved or edited. Its
            members lose access to the portal, and every record of what it did on the network is
            kept. If you only need to stop it for now, suspend it instead.
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
            Close permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const [minted, setMinted] = useState<{ url: string; expiresAt: string; hours: number } | null>(
    null,
  );

  useEffect(() => {
    setEmail("");
    setName("");
    setMinted(null);
  }, [organisation]);

  const mint = async () => {
    if (!organisation) return;
    setBusy(true);
    try {
      const result = await inviteFn({
        data: { organisationId: organisation.id, email: email.trim(), name: name.trim() },
      });
      if (!result.ok) throw new Error(result.error);
      setMinted({
        url: result.invite_url,
        expiresAt: result.expires_at,
        hours: result.expires_in_hours,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The invite could not be minted");
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

        {minted ? (
          <div className="space-y-3">
            <p className="text-sm">
              Send this link to {name.trim() || "them"}. It is shown once — only its fingerprint is
              stored — so copy it now; if it is lost, mint another.
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={minted.url}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                size="icon"
                variant="outline"
                aria-label="Copy the invite link"
                onClick={() => {
                  void navigator.clipboard.writeText(minted.url);
                  toast.success("Invite link copied");
                }}
              >
                <Copy className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Expires in {minted.hours} hours
              {minted.expiresAt ? ` — ${new Date(minted.expiresAt).toLocaleString("en-AU")}` : ""}.
            </p>
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
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {minted ? "Done" : "Cancel"}
          </Button>
          {!minted && (
            <Button onClick={() => void mint()} disabled={busy || !email.trim() || !name.trim()}>
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Mail className="mr-2 h-4 w-4" aria-hidden />
              )}
              Mint the invite link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
