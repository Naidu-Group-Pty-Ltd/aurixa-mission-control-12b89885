import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TierModulePicker, type TierSelection } from "@/components/tier-module-picker";
import { TrialLengthPicker } from "@/components/trial-length-picker";
import {
  configureAgreementProvisioning,
  getAgreementTrial,
  getProvisioningCatalog,
  type AgreementListRow,
} from "@/lib/agreements.functions";
import { exclusionChoices } from "@/lib/pricing/contract-exclusions";
import { getTrialSettings } from "@/server/trial-offers.functions";
import {
  DEFAULT_CHOICE,
  choiceFromStored,
  resolveTrialChoice,
  type TrialChoice,
} from "@/lib/trialOffers.pure";

/** The columns the dialog reads — the list's row and the offer page's row both carry them. */
export type ProvisioningAgreement = Pick<
  AgreementListRow,
  | "id"
  | "document_kind"
  | "client_name"
  | "client_email"
  | "plan_slug"
  | "addon_slugs"
  | "module_ids"
  | "excluded_module_slugs"
  | "admin_email"
  | "provision_on_signature"
  | "provision_status"
>;

/**
 * The commercial selection that a signature will provision: tier plan,
 * modules, add-ons, and the modules negotiated OUT — plus the arm switch
 * that makes the signature act on it.
 *
 * The tier/module surface is `TierModulePicker`, the SAME component the
 * clone wizard uses, resolving through the same pricing→module mapping
 * (`previewTierModules`), so what an agreement offers and what the wizard
 * offers cannot drift. Locked once provisioning has started: what a
 * signature provisions must be what the signature saw.
 *
 * On a Subscription Agreement the tier and add-ons are not chosen here at
 * all: they are what the offer sells, written onto the row on every save, so
 * this confirms them and arms the signature. Modules, exclusions and the
 * admin address remain the operator's.
 */
export function AgreementProvisioningDialog({
  agreement,
  onOpenChange,
  onSaved,
}: {
  agreement: ProvisioningAgreement | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const open = Boolean(agreement);
  const catalogQ = useQuery({
    queryKey: ["agreement-provisioning-catalog"],
    queryFn: async () => getProvisioningCatalog(),
    enabled: open,
  });

  const modules = useMemo(
    () =>
      (catalogQ.data?.modules ?? []) as Array<{
        id: string;
        slug: string;
        name: string;
        description?: string | null;
      }>,
    [catalogQ.data],
  );
  const byId = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  const fromOffer = agreement?.document_kind === "subscription";

  const [selection, setSelection] = useState<TierSelection>({ planSlug: null, addonSlugs: [] });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [excludedSlugs, setExcludedSlugs] = useState<string[]>([]);
  const [adminEmail, setAdminEmail] = useState("");
  const [armed, setArmed] = useState(true);
  const [saving, setSaving] = useState(false);

  // The free trial the workspace will be armed with. Read apart from the row
  // (the agreements list does not carry it), and only sent back once it has
  // been read — saving the other settings must never quietly reset a 30-day
  // trial to the default because the read had not come back yet.
  const trialSettingsQ = useQuery({
    queryKey: ["trial-settings"],
    queryFn: async () => getTrialSettings(),
    enabled: open,
    staleTime: 60_000,
  });
  const trialQ = useQuery({
    queryKey: ["agreement-trial", agreement?.id],
    queryFn: async () => getAgreementTrial({ data: { id: agreement!.id } }),
    enabled: open && Boolean(agreement?.id),
  });
  const [trialChoice, setTrialChoice] = useState<TrialChoice>(DEFAULT_CHOICE);
  const trialLoaded = Boolean(trialQ.data) && Boolean(trialSettingsQ.data);
  useEffect(() => {
    if (!trialQ.data || !trialSettingsQ.data) return;
    setTrialChoice(
      choiceFromStored(
        { trial_days: trialQ.data.trialDays, trial_offer_code: trialQ.data.trialOfferCode },
        trialSettingsQ.data.offers,
      ),
    );
  }, [trialQ.data, trialSettingsQ.data]);
  const trial = resolveTrialChoice(trialChoice, {
    offers: trialSettingsQ.data?.offers ?? [],
    defaultHours: trialSettingsQ.data?.defaults.hours ?? null,
  });

  useEffect(() => {
    if (!agreement) return;
    setSelection({
      planSlug: agreement.plan_slug ?? null,
      addonSlugs: agreement.addon_slugs ?? [],
    });
    setExcludedSlugs(agreement.excluded_module_slugs ?? []);
    setAdminEmail(agreement.admin_email ?? agreement.client_email);
    setArmed(agreement.provision_on_signature ?? true);
  }, [agreement]);

  // What can be negotiated out is what the tier includes, in the price list's
  // own names: the modules it bundles, plus AML/CTF, which every tier's
  // headline SKU carries. A saved exclusion outside that set (the tier changed,
  // or the price list did) stays listed until the dialog closes, so it can be
  // seen and removed rather than kept unseen.
  const exclusionOptions = useMemo(
    () =>
      exclusionChoices({
        planSlug: selection.planSlug,
        saved: agreement?.excluded_module_slugs ?? [],
        selected: excludedSlugs,
      }),
    [selection.planSlug, agreement?.excluded_module_slugs, excludedSlugs],
  );

  const toggleExcluded = (slug: string) =>
    setExcludedSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );

  // The picker keys its selection by module id. The stored ids are loaded
  // once the catalog is (and only then — filtering through an empty catalog
  // would wipe a saved selection).
  useEffect(() => {
    if (!agreement || modules.length === 0) return;
    setPicked(new Set((agreement.module_ids ?? []).filter((id) => byId.has(id))));
  }, [agreement, modules, byId]);

  const locked =
    agreement?.provision_status === "provisioning" || agreement?.provision_status === "provisioned";

  const save = async () => {
    if (!agreement) return;
    if (!selection.planSlug) {
      toast.error("Pick a tier plan — provisioning without one has nothing to entitle.");
      return;
    }
    if (trialLoaded && !trial.ok) {
      toast.error(`Free trial: ${trial.error}`);
      return;
    }
    setSaving(true);
    try {
      const moduleIds = [...picked].filter((id) => byId.has(id));
      const res = await configureAgreementProvisioning({
        data: {
          id: agreement.id,
          planSlug: selection.planSlug,
          moduleIds,
          addonSlugs: selection.addonSlugs,
          excludedModuleSlugs: excludedSlugs,
          adminEmail: adminEmail.trim() || undefined,
          armed,
          trial:
            trialLoaded && trial.ok
              ? {
                  days: trialChoice.kind === "default" ? null : trial.days,
                  offerCode: trial.offerCode,
                }
              : undefined,
        },
      });
      if (res?.ok) {
        toast.success(
          armed ? "Armed — signature will provision this clone" : "Selection saved (not armed)",
        );
        onSaved();
        onOpenChange(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Provisioning on signature</DialogTitle>
          <DialogDescription>
            {agreement?.client_name} — the moment DocuSign reports this agreement signed
            {fromOffer ? " and the signed copy is retained" : ""}, Mission Control provisions the
            clone from exactly this selection: repository, module set, entitlements, dedicated
            backend, deployment.
          </DialogDescription>
        </DialogHeader>

        {locked && (
          <div className="border border-warning/40 bg-warning/10 p-3 text-sm">
            Provisioning has already{" "}
            {agreement?.provision_status === "provisioned" ? "completed" : "started"} — the
            selection is locked.
          </div>
        )}

        <div className={locked ? "pointer-events-none space-y-5 opacity-60" : "space-y-5"}>
          <TierModulePicker
            modules={modules}
            picked={picked}
            onPickedChange={setPicked}
            selection={selection}
            onSelectionChange={setSelection}
            selectionLockedReason={
              fromOffer
                ? "Set by the offer: a signature provisions the plan and add-ons this agreement sells. Change the offer to change them."
                : undefined
            }
          />

          <div className="space-y-2">
            <Label htmlFor="prov-admin-email">Clone admin email</Label>
            <Input
              id="prov-admin-email"
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              disabled={locked}
            />
            <p className="text-xs text-muted-foreground">
              Seed administrator of the new workspace. They set their password via the platform's
              own reset flow.
            </p>
          </div>

          <div className="space-y-2">
            {trialLoaded ? (
              <TrialLengthPicker
                id="prov-trial"
                value={trialChoice}
                onChange={setTrialChoice}
                defaultHours={trialSettingsQ.data?.defaults.hours ?? null}
                offers={trialSettingsQ.data?.offers ?? []}
                offersError={trialSettingsQ.data?.offersError ?? null}
                disabled={locked}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {trialQ.error || trialSettingsQ.error
                  ? "The free trial could not be read; saving leaves it as it is."
                  : "Reading the free trial…"}
              </p>
            )}
            {trialQ.data?.schemaPending && (
              <p className="text-xs text-warning">
                Free trials on agreements need a migration that has not applied yet. Until it does,
                this agreement provisions the platform default.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Modules excluded (negotiated out)</Label>
            <p className="text-xs text-muted-foreground">
              Price-list modules this tier includes that the client negotiated out. They are written
              onto the clone when it is created, hold across every later plan change, and reach the
              clone itself through its balance check — a tier upgrade can never re-install what the
              client bargained away.
            </p>
            {exclusionOptions.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/60 p-2 text-xs text-muted-foreground">
                Pick a tier plan to see the modules it includes.
              </p>
            ) : (
              <div className="grid max-h-32 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-border/60 p-2 sm:grid-cols-2">
                {exclusionOptions.map((m) => (
                  <label
                    key={m.slug}
                    className="flex items-start gap-2 rounded p-1 text-sm hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={excludedSlugs.includes(m.slug)}
                      disabled={locked}
                      onCheckedChange={() => toggleExcluded(m.slug)}
                    />
                    <span className="leading-tight">
                      {m.name}
                      {m.note && <span className="ml-1 text-xs text-warning">({m.note})</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
            <div>
              <p className="text-sm font-medium">Provision on signature</p>
              <p className="text-xs text-muted-foreground">
                Armed: the signed envelope triggers provisioning automatically. Disarmed: the
                selection is recorded and an operator provisions by hand.
              </p>
            </div>
            <Switch checked={armed} onCheckedChange={setArmed} disabled={locked} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={save} disabled={saving || locked}>
            {saving ? "Saving…" : armed ? "Save & arm" : "Save selection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
