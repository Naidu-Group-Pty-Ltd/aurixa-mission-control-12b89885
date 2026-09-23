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
import { billingFallbackSentence } from "@/lib/bundleIdentityReading.pure";

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
 *
 * ## Two claims, drawn apart
 *
 * The column and the artefact are different facts. `VITE_AURIXA_BILLING_UID`
 * is inlined at BUILD time, so an id written here reaches a customer's browser
 * only through a rebuild — and until it does, that browser is still carrying
 * whatever it was built with. So the card draws what is RECORDED and, beneath
 * it, what the served bundle was measured to CARRY.
 *
 * Presenting only the first is the shape this whole programme keeps paying
 * for: every signal was green while three of four clones served a bundle
 * pointed at the prime's database, because nothing fetched the JavaScript and
 * asked. `bundleCarries` is that question asked, and `null` renders as its own
 * line rather than as silence, because never probed is not a pass.
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
                  This clone has none, so the purchase links minted for it carry no credential and
                  its own build has no identity to fall back on — which credits the prime on a build
                  resolving the prime&rsquo;s backend, and can only browse on one resolving its own.
                  Its next deployment derives one from the slug unless that is refused; assign one
                  here to choose it yourself.
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
              ) : current && data?.publishedBillingUserId === current ? (
                // The project holds this id already and its digest has been
                // cleared — by a re-sync, or by another publisher invalidating
                // it — so the next deployment publishes it again. "Not yet
                // pushed" would be false, and so would a plain "pushed" beside
                // a publish the worker still owes.
                <span className="text-xs text-muted-foreground">
                  Pushed to the hosting project — the next deployment publishes it again.
                </span>
              ) : current && data?.publishedBillingUserId ? (
                <span className="text-xs text-muted-foreground">
                  The hosting project was last given{" "}
                  <span className="font-mono">{data.publishedBillingUserId}</span> — this takes
                  effect on the next deployment.
                </span>
              ) : current ? (
                <span className="text-xs text-muted-foreground">
                  Not yet pushed to the hosting project — takes effect on the next deployment.
                </span>
              ) : null}
            </div>

            {current ? <BundleReading data={data} /> : null}

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

/**
 * What the served bundle actually carries.
 *
 * Four readings and they are four different facts, so the raw word is never
 * drawn — that is the shape that made `not_required` read as `clear` elsewhere
 * in this codebase. Only `fallback` is a problem: the artefact was read and
 * carries no identity of its own. What that COSTS is not one thing — it
 * credits the prime on a build resolving the prime's backend and can only
 * browse on one resolving its own — so the sentence comes from
 * `billingFallbackSentence`, the one the probe writes into the event log, and
 * the two cannot disagree. It said "every purchase made from this workspace
 * is crediting the prime right now", which was false of the one clone whose
 * build resolves its own backend, and of every link Mission Control mints.
 *
 * `not_scanned` is deliberately NOT drawn as a fault. It says neither this
 * clone's identity nor the built-in was in what the probe read — a statement
 * about the scan, not about the clone — and colouring it like a problem is
 * what made eleven chips unreadable on the Passport.
 */
function BundleReading({
  data,
}: {
  data:
    | {
        bundleCarries: "own" | "fallback" | "not_scanned" | "none" | null;
        bundleCheckedAt: string | null;
        bundleIdentity: string | null;
      }
    | undefined;
}) {
  const carries = data?.bundleCarries ?? null;
  const when = data?.bundleCheckedAt
    ? new Date(data.bundleCheckedAt).toLocaleString("en-AU")
    : null;

  if (carries === "fallback") {
    return (
      <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {billingFallbackSentence(data?.bundleIdentity)} Mission Control requests one rebuild per
          bundle to repair it; a reading that survives its rebuild is a fault in the clone&rsquo;s
          own source{when ? ` — read ${when}` : ""}.
        </span>
      </p>
    );
  }

  if (carries === "own") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />
        The served bundle carries this identity{when ? `, read ${when}` : ""}.
      </p>
    );
  }

  // Never probed and could-not-see are both "we do not know", and a card that
  // draws nothing for them reads the same as one that checked and was happy.
  return (
    <p className="text-xs text-muted-foreground">
      {carries === "not_scanned"
        ? `Neither this identity nor the prime's built-in was in what the probe read${
            when ? ` (${when})` : ""
          } — that says what was searched, not what the browser is carrying.`
        : "Nothing has fetched this deployment's JavaScript to check which identity it carries. That is not the same as having checked and found it correct."}
    </p>
  );
}
