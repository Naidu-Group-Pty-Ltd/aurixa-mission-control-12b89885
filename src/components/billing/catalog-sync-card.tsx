// Moves the seat-plan tiers onto the signed-off price list.
//
// Two systems have to change together: Stripe holds the price that is charged,
// the catalog row holds the price that is shown. Preview shows exactly what
// will happen to both; nothing is written until Apply.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Tag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { previewCatalogSync, runCatalogSync } from "@/lib/catalog-sync.functions";
import { ANNUAL_DISCOUNT } from "@/lib/pricing/aurixa-catalog";

const aud = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/** The commitment discount as the card says it — read from the price list, never typed. */
const commitmentPercent = `${Math.round(ANNUAL_DISCOUNT * 100)}%`;

type Plan = {
  ok: boolean;
  error?: string;
  renames?: Array<{ from: string; to: string; name: string }>;
  prices?: Array<{
    tierSlug: string;
    interval: string;
    unitAmount: number;
    gstComponent: number;
    baseAmount: number;
    includesAml: boolean;
    monthlyCredits: number;
  }>;
  untouched?: string[];
  warnings?: string[];
  createdPrices?: Array<{ tierSlug: string; interval: string; priceId: string }>;
  errors?: string[];
  notes?: string[];
  storefrontRefreshed?: boolean;
};

export function CatalogSyncCard() {
  const preview = useServerFn(previewCatalogSync);
  const apply = useServerFn(runCatalogSync);
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [applied, setApplied] = useState(false);

  const load = async () => {
    setBusy("preview");
    setApplied(false);
    try {
      setPlan((await preview()) as Plan);
    } catch (err) {
      setPlan({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setBusy("apply");
    try {
      const result = (await apply({ data: { confirm: true } })) as Plan;
      setPlan(result);
      setApplied(result.ok);
      if (result.ok) await queryClient.invalidateQueries({ queryKey: ["pricing-catalog"] });
    } catch (err) {
      setPlan({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const prices = plan?.prices ?? [];
  const canApply = !!plan?.ok && prices.length > 0 && !(plan.warnings ?? []).length && !applied;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tag className="h-4 w-4" /> Seat plan price list
        </CardTitle>
        <CardDescription>
          Moves the tiers onto the signed-off prices. Each tier is titled in the price list by its
          <strong className="mx-1">with AML/CTF Compliance</strong> figure, so that is what Stripe
          charges and what the pricing page leads with; the without-AML figure is shown beside it.
          Every figure is tax-inclusive — GST is contained in the amount, not added to it — and
          Stripe prices are created with <code className="mx-1">tax_behavior: inclusive</code> so
          enabling Stripe Tax later cannot inflate a total. Annual is a 12-month commitment paid up
          front: twelve months of the base less {commitmentPercent}, the Subscription Agreement's
          own commitment discount. Each tier's included credits are written onto the Stripe product
          and price, so an invoice and the billing portal say what the subscription entitles the
          customer to — and are granted per month on both billing periods, since credits lapse 30
          days after they are issued.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null}>
            {busy === "preview" ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Checking…
              </>
            ) : (
              "Preview changes"
            )}
          </Button>
          <Button size="sm" onClick={() => void run()} disabled={busy !== null || !canApply}>
            {busy === "apply" ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Applying…
              </>
            ) : (
              "Create Stripe prices & apply"
            )}
          </Button>
          {applied && (
            <Badge variant="outline" className="text-[10px]">
              applied
            </Badge>
          )}
        </div>

        {plan && !plan.ok && (
          <div className="space-y-1 border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{plan.error ?? "Sync failed."}</p>
            {/* Per-tier detail. A failure here is usually Stripe or Postgres
                saying something specific, and hiding it behind a generic
                message leaves an operator with nothing to act on. */}
            {plan.errors?.map((e) => (
              <p key={e} className="font-mono text-xs text-destructive/80">
                {e}
              </p>
            ))}
          </div>
        )}

        {!!plan?.warnings?.length && (
          <p className="flex items-start gap-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {plan.warnings.join(" ")}
          </p>
        )}

        {!!plan?.renames?.length && (
          <p className="text-xs text-muted-foreground">
            Rows reused, in this order: {plan.renames.map((r) => `${r.from} → ${r.to}`).join(", ")}.
            Existing Stripe products and subscription history stay attached to the row.
          </p>
        )}

        {prices.length > 0 && (
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead className="text-right">Price (incl GST)</TableHead>
                  <TableHead className="text-right">of which GST</TableHead>
                  <TableHead className="text-right">Without AML/CTF</TableHead>
                  <TableHead className="text-right">Credits / month</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.map((p) => (
                  <TableRow key={`${p.tierSlug}-${p.interval}`}>
                    <TableCell className="text-xs capitalize">{p.tierSlug}</TableCell>
                    <TableCell className="text-xs">
                      {p.interval === "year" ? `Annual (−${commitmentPercent})` : "Monthly"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {aud(p.unitAmount)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {aud(p.gstComponent)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {aud(p.baseAmount)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {p.monthlyCredits.toLocaleString("en-AU")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!!plan?.untouched?.length && (
          <p className="text-xs text-muted-foreground">Left alone: {plan.untouched.join(", ")}.</p>
        )}

        {applied && !!plan?.createdPrices?.length && (
          <p className="text-xs text-muted-foreground">
            Created {plan.createdPrices.length} Stripe price
            {plan.createdPrices.length === 1 ? "" : "s"} and repointed the catalog. Prices that
            already existed at the right amount were reused rather than duplicated.
          </p>
        )}

        {plan?.notes?.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}

        {/* Repricing here and the pricing page showing it are two different
            things. Said plainly, so a stale page is not mistaken for a failed
            cutover. */}
        {plan?.storefrontRefreshed === false && (
          <p className="flex items-start gap-1.5 border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The new prices are live here, but the pricing page still shows the old ones until the
            15-minute reconcile runs.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
