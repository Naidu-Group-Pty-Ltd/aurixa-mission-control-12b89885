// Tier-driven module selection for clone creation.
//
// The module step used to be a flat list of every detected module, ticked from
// memory. With 75 modules that is both slow and unreliable: nothing in the UI
// said which ones a Growth customer is actually entitled to, so a clone could
// ship features nobody bought or miss features they did.
//
// Picking a tier now selects the right set, and the operator can still adjust
// it — the tier is a starting point, not a cage. Anything selected that the
// tier does not entitle is called out rather than silently shipped.

import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Layers, Sparkles, TriangleAlert, Loader2, Package, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { TIERS, MODULES } from "@/lib/pricing/aurixa-catalog";
import { previewTierModules } from "@/server/entitlement-modules.functions";

type ModuleRow = { id: string; slug: string; name: string; description?: string | null };

export type TierSelection = {
  planSlug: string | null;
  addonSlugs: string[];
};

export function TierModulePicker({
  modules,
  picked,
  onPickedChange,
  selection,
  onSelectionChange,
  selectionLockedReason,
}: {
  modules: ModuleRow[];
  picked: Set<string>;
  onPickedChange: (next: Set<string>) => void;
  selection: TierSelection;
  onSelectionChange: (next: TierSelection) => void;
  /**
   * When the tier and add-ons are decided elsewhere — a Subscription
   * Agreement's offer — they are shown but not changed here, and this says
   * why. Modules can still be adjusted by hand.
   */
  selectionLockedReason?: string;
}) {
  const selectionLocked = Boolean(selectionLockedReason);
  const [loading, setLoading] = useState(false);
  const [entitled, setEntitled] = useState<Set<string>>(new Set());
  const [unmapped, setUnmapped] = useState<Array<{ sourceName: string; reason: string }>>([]);
  const preview = useServerFn(previewTierModules);

  const bySlug = useMemo(() => new Map(modules.map((m) => [m.slug, m])), [modules]);

  // Priced add-ons the chosen tier does not already include.
  const availableAddons = useMemo(() => {
    if (!selection.planSlug) return [];
    return MODULES.filter((m) => !m.includedIn.includes(selection.planSlug!));
  }, [selection.planSlug]);

  useEffect(() => {
    if (!selection.planSlug) {
      setEntitled(new Set());
      setUnmapped([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    preview({ data: { planSlug: selection.planSlug, purchasedAddons: selection.addonSlugs } })
      .then((res) => {
        if (cancelled || !res.ok) return;
        const slugs = new Set(res.moduleSlugs);
        setEntitled(slugs);
        setUnmapped(res.unmapped ?? []);
        // Selecting a tier replaces the selection — that is the point of the
        // control. Manual edits after this are preserved until the tier changes.
        const ids = new Set(
          res.moduleSlugs
            .map((s: string) => bySlug.get(s)?.id)
            .filter((id): id is string => Boolean(id)),
        );
        onPickedChange(ids);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.planSlug, selection.addonSlugs.join(",")]);

  const toggleAddon = (slug: string) => {
    const next = selection.addonSlugs.includes(slug)
      ? selection.addonSlugs.filter((s) => s !== slug)
      : [...selection.addonSlugs, slug];
    onSelectionChange({ ...selection, addonSlugs: next });
  };

  const togglePick = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onPickedChange(next);
  };

  // Selected but not entitled by the tier — an operator override that will
  // ship code the customer is not paying for unless it is deliberate.
  const extras = useMemo(() => {
    if (!selection.planSlug) return [];
    return modules.filter((m) => picked.has(m.id) && !entitled.has(m.slug));
  }, [modules, picked, entitled, selection.planSlug]);

  const missing = useMemo(() => {
    if (!selection.planSlug) return [];
    return [...entitled].filter((s) => {
      const m = bySlug.get(s);
      return m && !picked.has(m.id);
    });
  }, [entitled, picked, bySlug, selection.planSlug]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4 text-primary" /> 4 · Tier &amp; modules
        </CardTitle>
        <CardDescription>
          Choose the customer&apos;s pricing tier to select the modules it entitles them to. You can
          still adjust the selection by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ── Tier ── */}
        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            pricing tier
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {TIERS.map((t) => {
              const active = selection.planSlug === t.slug;
              return (
                <button
                  key={t.slug}
                  type="button"
                  disabled={selectionLocked}
                  aria-pressed={active}
                  onClick={() =>
                    onSelectionChange({
                      planSlug: active ? null : t.slug,
                      addonSlugs: active ? [] : selection.addonSlugs,
                    })
                  }
                  className={cn(
                    "rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed",
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/40 disabled:opacity-50 disabled:hover:border-border",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold">{t.name}</span>
                    {active && <Sparkles className="h-3 w-3 text-primary" />}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {t.seatMin}–{t.seatMax} seats
                  </div>
                </button>
              );
            })}
          </div>
          {selectionLockedReason ? (
            <p className="mt-2 text-xs text-muted-foreground">{selectionLockedReason}</p>
          ) : (
            !selection.planSlug && (
              <p className="mt-2 text-xs text-muted-foreground">
                No tier selected — pick modules manually below, or choose a tier to start from its
                entitlements.
              </p>
            )
          )}
        </div>

        {/* ── Add-ons ── */}
        {selection.planSlug && availableAddons.length > 0 && (
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              add-ons purchased on top of {selection.planSlug}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {availableAddons.map((a) => {
                const on = selection.addonSlugs.includes(a.slug);
                return (
                  <button
                    key={a.slug}
                    type="button"
                    disabled={selectionLocked}
                    aria-pressed={on}
                    onClick={() => toggleAddon(a.slug)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] transition-colors disabled:cursor-not-allowed",
                      on
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40 disabled:opacity-50 disabled:hover:border-border",
                    )}
                  >
                    <Plus className="h-2.5 w-2.5" />
                    {a.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Resolving entitlements…
          </div>
        )}

        {unmapped.length > 0 && (
          <Alert>
            <TriangleAlert className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {unmapped.length} priced item(s) have no technical module mapped, so nothing will be
              installed for them: {unmapped.map((u) => u.sourceName).join(", ")}. Resolve them in
              Modules → Pricing map.
            </AlertDescription>
          </Alert>
        )}

        {extras.length > 0 && (
          <Alert>
            <TriangleAlert className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {extras.length} selected module(s) are not entitled by this tier and will ship anyway:{" "}
              {extras.map((m) => m.slug).join(", ")}.
            </AlertDescription>
          </Alert>
        )}

        {/* ── Module list ── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              modules to inject · {picked.size} of {modules.length}
            </p>
            <div className="flex gap-1">
              {missing.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    const next = new Set(picked);
                    for (const s of missing) {
                      const m = bySlug.get(s);
                      if (m) next.add(m.id);
                    }
                    onPickedChange(next);
                  }}
                >
                  Restore {missing.length} entitled
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => onPickedChange(new Set())}
              >
                Clear
              </Button>
            </div>
          </div>

          {modules.length === 0 ? (
            <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
              No modules detected yet. Run detection from the{" "}
              <span className="font-mono text-foreground">Modules</span> page.
            </div>
          ) : (
            <div className="grid max-h-[420px] gap-2 overflow-y-auto md:grid-cols-2">
              {modules.map((m) => {
                const active = picked.has(m.id);
                const isEntitled = entitled.has(m.slug);
                return (
                  <label
                    key={m.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                      active
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40",
                    )}
                  >
                    <Checkbox
                      checked={active}
                      onCheckedChange={() => togglePick(m.id)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-semibold">{m.name}</span>
                        {selection.planSlug &&
                          (isEntitled ? (
                            <Badge
                              variant="outline"
                              className="border-success/40 text-[9px] text-success"
                            >
                              <Package className="mr-0.5 h-2.5 w-2.5" />
                              entitled
                            </Badge>
                          ) : (
                            active && (
                              <Badge
                                variant="outline"
                                className="border-warning/40 text-[9px] text-warning"
                              >
                                extra
                              </Badge>
                            )
                          ))}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                        {m.slug}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
