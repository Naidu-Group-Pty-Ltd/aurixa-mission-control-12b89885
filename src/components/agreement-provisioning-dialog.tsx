import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  configureAgreementProvisioning,
  getProvisioningCatalog,
  type AgreementRow,
} from "@/lib/agreements.functions";

/**
 * The commercial selection that a signature will provision: tier plan,
 * modules in, add-ons on top, modules negotiated OUT — and the arm switch
 * that makes the signature act on it. Locked once provisioning has started:
 * what a signature provisions must be what the signature saw.
 */
export function AgreementProvisioningDialog({
  agreement,
  onOpenChange,
  onSaved,
}: {
  agreement: AgreementRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const open = Boolean(agreement);
  const catalogQ = useQuery({
    queryKey: ["agreement-provisioning-catalog"],
    queryFn: async () => getProvisioningCatalog(),
    enabled: open,
  });

  const [planSlug, setPlanSlug] = useState("");
  const [moduleIds, setModuleIds] = useState<string[]>([]);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [addonSlugs, setAddonSlugs] = useState<string[]>([]);
  const [adminEmail, setAdminEmail] = useState("");
  const [armed, setArmed] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!agreement) return;
    setPlanSlug(agreement.plan_slug ?? "");
    setModuleIds(agreement.module_ids ?? []);
    setExcludedIds(agreement.excluded_module_ids ?? []);
    setAddonSlugs(agreement.addon_slugs ?? []);
    setAdminEmail(agreement.admin_email ?? agreement.client_email);
    setArmed(agreement.provision_on_signature ?? true);
  }, [agreement]);

  const locked =
    agreement?.provision_status === "provisioning" || agreement?.provision_status === "provisioned";

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = async () => {
    if (!agreement) return;
    if (!planSlug) {
      toast.error("Pick a tier plan — provisioning without one has nothing to entitle.");
      return;
    }
    setSaving(true);
    try {
      const res = await configureAgreementProvisioning({
        data: {
          id: agreement.id,
          planSlug,
          moduleIds,
          addonSlugs,
          excludedModuleIds: excludedIds,
          adminEmail: adminEmail.trim() || undefined,
          armed,
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

  const modules = catalogQ.data?.modules ?? [];
  const addons = catalogQ.data?.addons ?? [];
  const plans = catalogQ.data?.plans ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Provisioning on signature</DialogTitle>
          <DialogDescription>
            {agreement?.client_name} — the moment DocuSign reports this agreement signed, Mission
            Control provisions the clone from exactly this selection: repository, module set,
            entitlements, dedicated backend, deployment.
          </DialogDescription>
        </DialogHeader>

        {locked && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            Provisioning has already{" "}
            {agreement?.provision_status === "provisioned" ? "completed" : "started"} — the
            selection is locked.
          </div>
        )}

        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Tier plan</Label>
              <Select value={planSlug} onValueChange={setPlanSlug} disabled={locked}>
                <SelectTrigger>
                  <SelectValue placeholder="Select the plan the client signed up to" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.slug} value={p.slug}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
          </div>

          <div className="space-y-2">
            <Label>Modules included</Label>
            <div className="grid max-h-44 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-border/60 p-2 sm:grid-cols-2">
              {modules.map((m) => (
                <label
                  key={m.id}
                  className="flex items-start gap-2 rounded p-1 text-sm hover:bg-muted/40"
                >
                  <Checkbox
                    checked={moduleIds.includes(m.id)}
                    disabled={locked}
                    onCheckedChange={() => toggle(moduleIds, setModuleIds, m.id)}
                  />
                  <span className="leading-tight">{m.name}</span>
                </label>
              ))}
              {modules.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">No modules in the catalog yet.</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Add-ons</Label>
            <div className="flex flex-wrap gap-2">
              {addons.map((a) => (
                <button
                  key={a.slug}
                  type="button"
                  disabled={locked}
                  onClick={() => toggle(addonSlugs, setAddonSlugs, a.slug)}
                  className="focus-visible:ring-2 focus-visible:ring-primary rounded-full focus-visible:outline-none"
                >
                  <Badge variant={addonSlugs.includes(a.slug) ? "default" : "outline"}>
                    {a.name}
                  </Badge>
                </button>
              ))}
              {addons.length === 0 && (
                <p className="text-xs text-muted-foreground">No add-ons in the catalog.</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Modules excluded (negotiated out)</Label>
            <p className="text-xs text-muted-foreground">
              Recorded so a later reconciliation never "helpfully" re-adds what the client bargained
              away. An exclusion always wins over the include list.
            </p>
            <div className="grid max-h-32 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-border/60 p-2 sm:grid-cols-2">
              {modules.map((m) => (
                <label
                  key={m.id}
                  className="flex items-start gap-2 rounded p-1 text-sm hover:bg-muted/40"
                >
                  <Checkbox
                    checked={excludedIds.includes(m.id)}
                    disabled={locked}
                    onCheckedChange={() => toggle(excludedIds, setExcludedIds, m.id)}
                  />
                  <span className="leading-tight">{m.name}</span>
                </label>
              ))}
            </div>
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
