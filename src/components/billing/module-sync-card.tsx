// Puts the add-on modules on sale.
//
// The modules have been in the catalog since the price list landed, but as
// display data only — priced on the pricing page, with nothing behind them to
// charge. This is the step that gives each one a Stripe product and a monthly
// recurring price and records the link on the row. Preview shows exactly that;
// nothing is written until Apply.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Puzzle } from "lucide-react";

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
import { previewModuleSync, runModuleSync } from "@/lib/module-sync.functions";

const aud = (cents: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

type Plan = {
  ok: boolean;
  error?: string;
  modules?: Array<{
    slug: string;
    name: string;
    category: string;
    unitAmount: number;
    gstComponent: number;
    includedIn: string[];
    includedWithAml?: boolean;
    alreadyLive: boolean;
  }>;
  skipped?: string[];
  missing?: string[];
  warnings?: string[];
  createdPrices?: Array<{ slug: string; priceId: string; productId: string; amount: number }>;
  linked?: string[];
  notes?: string[];
  errors?: string[];
  storefrontRefreshed?: boolean;
};

export function ModuleSyncCard() {
  const preview = useServerFn(previewModuleSync);
  const apply = useServerFn(runModuleSync);
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

  const modules = plan?.modules ?? [];
  const pending = modules.filter((m) => !m.alreadyLive).length;
  const canApply = !!plan?.ok && modules.length > 0 && !(plan.warnings ?? []).length && !applied;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Puzzle className="h-4 w-4" /> Add-on modules
        </CardTitle>
        <CardDescription>
          Gives every purchasable module a Stripe product and a monthly recurring price, and links
          the catalog row to it — until this runs, the modules are priced on the pricing page with
          nothing behind them to charge. Every figure is tax-inclusive, so the prices are created
          with <code className="mx-1">tax_behavior: inclusive</code> and enabling Stripe Tax later
          cannot inflate a total. Modules still in development are skipped rather than priced.
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
              "Create Stripe products & apply"
            )}
          </Button>
          {applied && (
            <Badge variant="outline" className="text-[10px]">
              applied
            </Badge>
          )}
          {!!plan?.ok && !applied && modules.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {pending === 0
                ? `All ${modules.length} already live.`
                : `${pending} of ${modules.length} still to do.`}
            </span>
          )}
        </div>

        {plan && !plan.ok && (
          <div className="space-y-1 border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{plan.error ?? "Sync failed."}</p>
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

        {modules.length > 0 && (
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Price /mo (incl GST)</TableHead>
                  <TableHead className="text-right">of which GST</TableHead>
                  <TableHead>Bundled with</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {modules.map((m) => (
                  <TableRow key={m.slug}>
                    <TableCell className="text-xs">{m.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{m.category}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {aud(m.unitAmount)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {aud(m.gstComponent)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[...m.includedIn, ...(m.includedWithAml ? ["with AML/CTF"] : [])].join(
                        ", ",
                      ) || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {m.alreadyLive && (
                        <Badge variant="outline" className="text-[10px] text-emerald-500">
                          live
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Stated rather than left as a gap in the count. A card that plans 22
            of 23 modules looks like it lost one unless it says which, and why. */}
        {!!plan?.skipped?.length && (
          <p className="text-xs text-muted-foreground">
            Not priced: {plan.skipped.join(", ")}. Listed on the pricing page so the roadmap is
            visible, with no agreed price — so no Stripe product, and any earlier link is cleared.
          </p>
        )}

        {applied && (
          <p className="text-xs text-muted-foreground">
            Created {plan?.createdPrices?.length ?? 0} Stripe price
            {(plan?.createdPrices?.length ?? 0) === 1 ? "" : "s"} and linked{" "}
            {plan?.linked?.length ?? 0} module{(plan?.linked?.length ?? 0) === 1 ? "" : "s"}.
            Products and prices that already existed at the right amount were reused rather than
            duplicated.
          </p>
        )}

        {plan?.notes?.map((n) => (
          <p key={n} className="text-xs text-muted-foreground">
            {n}
          </p>
        ))}

        {/* The catalog being right and the pricing page showing it are two
            different things, and the gap between them is invisible from here
            unless it is stated. */}
        {plan?.storefrontRefreshed === false && (
          <p className="flex items-start gap-1.5 border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The modules are linked here, but the pricing page catches up when the 15-minute
            reconcile runs.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
