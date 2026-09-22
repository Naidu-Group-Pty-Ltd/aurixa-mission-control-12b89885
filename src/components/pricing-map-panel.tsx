// Operator view of the pricing → module mapping.
//
// Most rows are derived and correct, so the panel leads with the ones that are
// not: an unmapped priced item means a customer can buy something that installs
// nothing, which is invisible until someone notices a missing feature.
//
// Overridden rows are never re-derived, so an operator decision survives the
// next re-seed and the next detection run.

import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, RefreshCw, TriangleAlert, Check, Pencil, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getModuleMap,
  seedModuleMap,
  overrideModuleMap,
  clearModuleMapOverride,
} from "@/server/entitlement-modules.functions";

type MapRow = {
  id: string;
  source_kind: string;
  source_slug: string;
  source_name: string;
  mapping_kind: string;
  module_slugs: string[];
  entitlement_key: string | null;
  confidence: string;
  reason: string | null;
  is_override: boolean;
};

function KindBadge({ kind }: { kind: string }) {
  // `external` reads neutral, not amber: it is a settled arrangement (the item
  // is served by another deployment), whereas `unmapped` is an open question
  // for a person. Colouring them alike is what would bury the open one.
  const tone =
    kind === "installs"
      ? "border-success/40 text-success"
      : kind === "entitlement"
        ? "border-primary/40 text-primary"
        : kind === "external"
          ? "border-muted-foreground/40 text-muted-foreground"
          : "border-warning/50 text-warning";
  return (
    <Badge variant="outline" className={cn("font-mono text-[9px] uppercase", tone)}>
      {kind}
    </Badge>
  );
}

export function PricingMapPanel() {
  const [rows, setRows] = useState<MapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(true);

  const load = useServerFn(getModuleMap);
  const seed = useServerFn(seedModuleMap);
  const override = useServerFn(overrideModuleMap);
  const clearOverride = useServerFn(clearModuleMapOverride);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await load({});
      if (res.ok) setRows(res.rows as MapRow[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unmapped = useMemo(() => rows.filter((r) => r.mapping_kind === "unmapped"), [rows]);
  const shown = onlyProblems
    ? rows.filter((r) => r.mapping_kind === "unmapped" || r.is_override)
    : rows;

  const runSeed = async () => {
    setSeeding(true);
    try {
      const res = await seed({});
      if (res.ok) {
        toast.success(
          `Mapping refreshed — ${res.inserted} new, ${res.updated} updated, ${res.preserved} operator rows preserved`,
        );
        await refresh();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Seed failed");
    } finally {
      setSeeding(false);
    }
  };

  const save = async (row: MapRow) => {
    const slugs = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await override({ data: { id: row.id, moduleSlugs: slugs } });
    if (!res.ok) return toast.error(res.error);
    toast.success(`${row.source_name} mapped to ${slugs.length} module(s)`);
    setEditing(null);
    refresh();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Pricing map</CardTitle>
            <CardDescription>
              Which technical modules each tier feature and priced add-on installs. Derived
              automatically; operator edits are preserved across re-seeds.
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[10px]"
              onClick={() => setOnlyProblems(!onlyProblems)}
            >
              {onlyProblems ? `Show all ${rows.length}` : "Show problems only"}
            </Button>
            <Button variant="outline" size="sm" onClick={runSeed} disabled={seeding}>
              {seeding ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Re-derive
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-dashed p-6 text-center text-sm text-muted-foreground">
            No mapping yet — press <span className="font-mono text-foreground">Re-derive</span> to
            build it from the pricing catalogue and the detected modules.
          </div>
        ) : (
          <>
            {unmapped.length > 0 && (
              <Alert>
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  {unmapped.length} priced item(s) install nothing. A customer can buy these and
                  receive no code until they are mapped.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              {shown.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    "rounded-md border p-2.5",
                    r.mapping_kind === "unmapped"
                      ? "border-warning/40 bg-warning/5"
                      : "border-border",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="font-mono text-[9px]">
                      {r.source_kind === "tier" ? r.source_slug : "add-on"}
                    </Badge>
                    <span className="text-sm font-medium">{r.source_name}</span>
                    <KindBadge kind={r.mapping_kind} />
                    <Badge variant="outline" className="font-mono text-[9px]">
                      {r.confidence}
                    </Badge>
                    {r.is_override && (
                      <Badge
                        variant="outline"
                        className="border-primary/40 text-[9px] text-primary"
                      >
                        operator
                      </Badge>
                    )}
                  </div>

                  {editing === r.id ? (
                    <div className="mt-2 flex items-center gap-1.5">
                      <Input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="comma-separated module slugs"
                        className="h-7 font-mono text-xs"
                      />
                      <Button size="sm" className="h-7 px-2" onClick={() => save(r)}>
                        <Check className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => setEditing(null)}
                      >
                        cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {r.module_slugs.length > 0 ? (
                        r.module_slugs.map((s) => (
                          <code key={s} className="bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                            {s}
                          </code>
                        ))
                      ) : r.entitlement_key ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          gates {r.entitlement_key}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">installs nothing</span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px]"
                        onClick={() => {
                          setEditing(r.id);
                          setDraft(r.module_slugs.join(", "));
                        }}
                      >
                        <Pencil className="mr-1 h-2.5 w-2.5" />
                        edit
                      </Button>
                      {r.is_override && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-[10px]"
                          onClick={async () => {
                            await clearOverride({ data: { id: r.id } });
                            toast.success(
                              "Override released — row tracks the derived mapping again",
                            );
                            refresh();
                          }}
                        >
                          <Undo2 className="mr-1 h-2.5 w-2.5" />
                          reset
                        </Button>
                      )}
                    </div>
                  )}

                  {r.reason && r.mapping_kind === "unmapped" && (
                    <p className="mt-1 text-[10px] text-muted-foreground">{r.reason}</p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
