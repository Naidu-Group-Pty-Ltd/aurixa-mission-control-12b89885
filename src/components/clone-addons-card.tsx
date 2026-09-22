// Add-ons a clone holds, and the entitlement state they produce.
//
// Add-ons used to be a text[] on the clone that an operator edited. That could
// say which add-ons were held and nothing else — not when they were bought,
// not what pays for them, not whether one lapsed. Cancelling looked identical
// to fixing a typo.
//
// Granting or cancelling here reconciles the clone's modules immediately: an
// add-on the customer has paid for should not wait for the next plan change.

import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Plus, X, CreditCard, Hand, TriangleAlert, PackageCheck } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MODULES, isModulePurchasable } from "@/lib/pricing/aurixa-catalog";
import {
  listCloneAddons,
  grantCloneAddon,
  cancelCloneAddon,
} from "@/server/entitlement-modules.functions";

type Purchase = {
  id: string;
  addon_slug: string;
  addon_name: string | null;
  status: string;
  source: string;
  purchased_at: string;
  cancelled_at: string | null;
  current_period_end: string | null;
  stripe_subscription_item_id: string | null;
  unit_amount_cents: number | null;
  notes: string | null;
};

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "border-success/40 text-success"
      : status === "past_due"
        ? "border-warning/50 text-warning"
        : status === "pending"
          ? "border-muted text-muted-foreground"
          : "border-muted text-muted-foreground line-through";
  return (
    <Badge variant="outline" className={cn("font-mono text-[9px] uppercase", tone)}>
      {status}
    </Badge>
  );
}

const money = (cents: number | null) => (cents == null ? null : `$${(cents / 100).toFixed(2)}`);

export function CloneAddonsCard({ cloneId }: { cloneId: string }) {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const list = useServerFn(listCloneAddons);
  const grant = useServerFn(grantCloneAddon);
  const cancel = useServerFn(cancelCloneAddon);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await list({ data: { cloneId } });
      if (res.ok) setPurchases(res.purchases as Purchase[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneId]);

  const live = useMemo(() => purchases.filter((p) => p.status !== "cancelled"), [purchases]);
  const heldSlugs = useMemo(() => new Set(live.map((p) => p.addon_slug)), [live]);
  const history = useMemo(() => purchases.filter((p) => p.status === "cancelled"), [purchases]);

  // Only sellable add-ons. A module is withheld either because it has no
  // agreed price (`comingSoon`) or because it has one and is sold directly
  // (`directSale`); `isModulePurchasable` is the single place that decides, so
  // this list cannot fall behind a new reason to withhold.
  const grantable = useMemo(
    () => MODULES.filter((m) => !heldSlugs.has(m.slug) && isModulePurchasable(m.slug)),
    [heldSlugs],
  );

  const doGrant = async (slug: string) => {
    setBusy(slug);
    try {
      const res = await grant({ data: { cloneId, addonSlug: slug } });
      if (!res.ok) return toast.error(res.error);
      const installed = res.reconciliation?.installed ?? [];
      toast.success(
        res.alreadyHeld
          ? "Already held — nothing changed"
          : installed.length > 0
            ? `Granted — installed ${installed.join(", ")}`
            : "Granted — no new modules needed (sub-feature entitlement)",
      );
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async (slug: string) => {
    setBusy(slug);
    try {
      const res = await cancel({ data: { cloneId, addonSlug: slug } });
      if (!res.ok) return toast.error(res.error);
      toast.success("Cancelled — entitlement revoked, files left in place");
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Add-ons</CardTitle>
            <CardDescription>
              Priced modules this clone holds on top of its tier. Granting or cancelling reconciles
              its installed modules immediately.
            </CardDescription>
          </div>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? "Hide" : `Show ${history.length} cancelled`}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading…
          </div>
        ) : (
          <>
            {live.some((p) => p.status === "past_due") && (
              <Alert>
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  One or more add-ons are past due. They still entitle their features — a failed
                  card does not strip access mid-period — but will stop once dunning cancels them.
                </AlertDescription>
              </Alert>
            )}

            {live.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No add-ons. This clone gets only what its tier includes.
              </p>
            ) : (
              <div className="space-y-1.5">
                {(showAll ? purchases : live).map((p) => (
                  <div
                    key={p.id}
                    className={cn(
                      "flex items-start justify-between gap-3 rounded-md border p-2.5",
                      p.status === "cancelled" ? "border-border/60 opacity-60" : "border-border",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{p.addon_name ?? p.addon_slug}</span>
                        <StatusBadge status={p.status} />
                        <Badge variant="secondary" className="gap-1 font-mono text-[9px]">
                          {p.source === "stripe" ? (
                            <CreditCard className="h-2.5 w-2.5" />
                          ) : (
                            <Hand className="h-2.5 w-2.5" />
                          )}
                          {p.source}
                        </Badge>
                        {money(p.unit_amount_cents) && (
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {money(p.unit_amount_cents)}/mo
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {p.addon_slug}
                        {p.stripe_subscription_item_id && ` · ${p.stripe_subscription_item_id}`}
                      </div>
                      {p.notes && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{p.notes}</div>
                      )}
                    </div>
                    {p.status !== "cancelled" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[10px]"
                        disabled={busy === p.addon_slug}
                        onClick={() => doCancel(p.addon_slug)}
                      >
                        {busy === p.addon_slug ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <X className="h-3 w-3" />
                        )}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {grantable.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  <PackageCheck className="h-3 w-3" /> grant an add-on
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {grantable.map((m) => (
                    <button
                      key={m.slug}
                      type="button"
                      disabled={busy === m.slug}
                      onClick={() => doGrant(m.slug)}
                      className="inline-flex items-center gap-1 border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
                    >
                      {busy === m.slug ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        <Plus className="h-2.5 w-2.5" />
                      )}
                      {m.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
