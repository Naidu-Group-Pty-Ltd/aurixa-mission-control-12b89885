import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/copy-button";
import { AlertTriangle, CheckCircle2, Receipt } from "lucide-react";
import { toast } from "sonner";
import {
  getCloneBillingIdentity,
  setCloneBillingIdentity,
} from "@/server/clone-billing-identity.functions";

/**
 * Which workspace this clone's customers pay into.
 *
 * `clones.billing_user_id` is read by every purchase path and was written by
 * exactly one statement — the provisioning insert, which took a wizard field
 * that defaulted blank under the words "Leave blank to assign later". This is
 * the later. Measured 22 Sep 2026, all four live clones held NULL.
 *
 * It says what the absence COSTS rather than drawing an empty box, because an
 * unset id is not a cosmetic gap: `/api/public/tokens/packs` answers a
 * credential-less link, the clone's own bundle falls through to the prime's
 * built-in `npc-prime`, and a customer clicking "buy more tokens" credits the
 * prime's balance instead of their own.
 */
export function CloneBillingIdentityCard({ cloneId }: { cloneId: string }) {
  const loadFn = useServerFn(getCloneBillingIdentity);
  const setFn = useServerFn(setCloneBillingIdentity);

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-billing-identity", cloneId],
    queryFn: async () => loadFn({ data: { cloneId } }),
  });

  // Seed from the server until the operator touches the field, and never
  // afterwards — the picker's rule in the property dashboard, for the same
  // reason: this query resolves after the card is interactive, so seeding on
  // every render overwrites somebody who typed while it was loading.
  useEffect(() => {
    if (touched || !data) return;
    setValue(data.billingUserId ?? data.suggested ?? "");
  }, [data, touched]);

  const save = async () => {
    setBusy(true);
    try {
      const result = await setFn({ data: { cloneId, billingUserId: value } });
      toast.success(`Billing identity set to ${result.billingId}`, { description: result.rebuild });
      setTouched(false);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const current = data?.billingUserId ?? null;
  const dirty = value.trim().toLowerCase() !== (current ?? "").toLowerCase();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" aria-hidden /> Billing identity
          {current ? (
            <Badge variant="outline" className="ml-auto font-mono text-xs">
              {current}
            </Badge>
          ) : (
            <Badge variant="destructive" className="ml-auto">
              Not set
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          The <span className="font-mono">?uid=</span> key that sends this clone's customers into
          their own checkout, and the id every purchase is credited against. Published to the
          clone's build as <span className="font-mono">VITE_AURIXA_BILLING_UID</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Reading…</p>
        ) : (
          <>
            {!current && (
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                <p className="text-muted-foreground">
                  This clone has none, so its purchase links carry no credential and its own build
                  falls back to the prime's identity. A customer buying tokens here would credit the
                  prime's balance, not theirs.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor={`billing-uid-${cloneId}`}>Billing identity</Label>
              <div className="flex gap-2">
                <Input
                  id={`billing-uid-${cloneId}`}
                  value={value}
                  onChange={(e) => {
                    setTouched(true);
                    setValue(e.target.value);
                  }}
                  placeholder={data?.suggested ?? "acme-corp"}
                  className="font-mono"
                />
                {current ? <CopyButton value={current} /> : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits and hyphens. Refused — never quietly changed — if another
                clone or another workspace's tenant already holds it.
              </p>
            </div>

            {data?.suggested && value.trim().toLowerCase() !== data.suggested ? (
              <button
                type="button"
                className="text-xs text-info underline-offset-2 hover:underline"
                onClick={() => {
                  setTouched(true);
                  setValue(data.suggested!);
                }}
              >
                Use the slug: <span className="font-mono">{data.suggested}</span>
              </button>
            ) : null}

            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={busy || !dirty || !value.trim()}>
                {busy ? "Saving…" : current ? "Change" : "Assign"}
              </Button>
              {current && data?.publishedToHosting ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />
                  Pushed to the hosting project
                </span>
              ) : current ? (
                <span className="text-xs text-muted-foreground">
                  Not yet pushed to the hosting project — takes effect on the next deployment.
                </span>
              ) : null}
            </div>

            {data?.tenantBillingUserId && data.tenantBillingUserId !== current ? (
              <p className="text-xs text-muted-foreground">
                A tenant of this clone carries{" "}
                <span className="font-mono">{data.tenantBillingUserId}</span>. Both resolve to this
                workspace; the clone's own id is what a new link uses.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
