// Campaigns, ad groups (Meta's ad sets) and ads, with the drill-down and the
// side-by-side compare the prime's Meta tab has.
//
// Sorting puts an unmeasured figure last in both directions, because a dash is
// neither the largest nor the smallest number.
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { statusWord } from "@/lib/marketing/labels.pure";
import type { EntityHealth, EntityRow } from "@/lib/marketing/marketingEngine";
import { HEALTH } from "./health-words";
import type { AdLevel, Crumb } from "./use-ad-drill";

export interface EntityColumn {
  key: string;
  label: string;
  render: (row: EntityRow) => string;
  sortValue: (row: EntityRow) => number | null;
}

const MAX_COMPARE = 4;

export function EntityTable({
  title,
  entities,
  columns,
  health,
  level,
  levelWords,
  crumbs,
  loading,
  onDrill,
  onCrumb,
  onLevel,
}: {
  title: string;
  entities: EntityRow[];
  columns: EntityColumn[];
  health: EntityHealth[];
  level: AdLevel;
  levelWords: Record<AdLevel, string>;
  crumbs: Crumb[];
  loading: boolean;
  onDrill: (row: EntityRow) => void;
  onCrumb: (index: number) => void;
  onLevel: (level: AdLevel) => void;
}) {
  const [sortKey, setSortKey] = useState(columns[0]?.key ?? "");
  const [descending, setDescending] = useState(true);
  const [comparing, setComparing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const healthById = useMemo(() => new Map(health.map((h) => [h.entityId, h])), [health]);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return entities;
    return [...entities].sort((a, b) => {
      const av = col.sortValue(a);
      const bv = col.sortValue(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return descending ? bv - av : av - bv;
    });
  }, [entities, columns, sortKey, descending]);

  const togglePick = (id: string) =>
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPARE) {
        toast.error(`At most ${MAX_COMPARE} can be compared at once`);
        return prev;
      }
      return [...prev, id];
    });

  const pickedRows = picked
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is EntityRow => !!e);

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Level" className="flex border border-border">
              {(["campaign", "adgroup", "ad"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="tab"
                  aria-selected={level === l}
                  onClick={() => {
                    setPicked([]);
                    onLevel(l);
                  }}
                  className={cn(
                    "border-l border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] first:border-l-0",
                    level === l
                      ? "bg-foreground/[0.08] text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {levelWords[l]}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant={comparing ? "default" : "outline"}
              onClick={() => {
                setComparing((c) => !c);
                setPicked([]);
              }}
            >
              {comparing ? `Comparing (${picked.length})` : "Compare"}
            </Button>
          </div>
        </div>
        {crumbs.length > 1 && (
          <nav
            aria-label="Drill-down"
            className="flex flex-wrap items-center gap-1 font-mono text-[11px]"
          >
            {crumbs.map((c, i) => (
              <span key={`${c.level}-${i}`} className="inline-flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden />}
                {i < crumbs.length - 1 ? (
                  <button
                    type="button"
                    className="max-w-[16rem] truncate text-primary hover:underline"
                    onClick={() => {
                      setPicked([]);
                      onCrumb(i);
                    }}
                  >
                    {c.label}
                  </button>
                ) : (
                  <span className="max-w-[16rem] truncate">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-9 animate-pulse bg-muted" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing at this level delivered in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="label-mono text-left">
                  {comparing && (
                    <th className="w-8 py-2 pr-2 font-normal">
                      <span className="sr-only">Compare</span>
                    </th>
                  )}
                  <th className="py-2 pr-3 font-normal">name</th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className="py-2 pr-3 text-right font-normal"
                      aria-sort={
                        sortKey === c.key ? (descending ? "descending" : "ascending") : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (c.key === sortKey) setDescending((d) => !d);
                          else {
                            setSortKey(c.key);
                            setDescending(true);
                          }
                        }}
                        className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                      >
                        {c.label}
                        {sortKey === c.key &&
                          (descending ? (
                            <ArrowDown className="h-3 w-3" aria-hidden />
                          ) : (
                            <ArrowUp className="h-3 w-3" aria-hidden />
                          ))}
                      </button>
                    </th>
                  ))}
                  <th className="py-2 text-right font-normal">health</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => {
                  const h = healthById.get(row.id);
                  return (
                    <tr key={row.id} className="border-t border-border/50 align-top">
                      {comparing && (
                        <td className="py-2 pr-2">
                          <Checkbox
                            checked={picked.includes(row.id)}
                            onCheckedChange={() => togglePick(row.id)}
                            aria-label={`Compare ${row.name}`}
                          />
                        </td>
                      )}
                      <td className="max-w-[22rem] py-2 pr-3">
                        {level !== "ad" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setPicked([]);
                              onDrill(row);
                            }}
                            className="text-left font-medium hover:text-primary [overflow-wrap:anywhere]"
                          >
                            {row.name}
                            <ChevronRight
                              className="ml-0.5 inline h-3.5 w-3.5 text-muted-foreground"
                              aria-hidden
                            />
                          </button>
                        ) : (
                          <span className="font-medium [overflow-wrap:anywhere]">{row.name}</span>
                        )}
                        <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted-foreground">
                          {statusWord(row.status) && <span>{statusWord(row.status)}</span>}
                          {row.objective && <span>{statusWord(row.objective)}</span>}
                          {row.parentName && level !== "campaign" && (
                            <span className="truncate">in {row.parentName}</span>
                          )}
                        </div>
                      </td>
                      {columns.map((c) => (
                        <td key={c.key} className="py-2 pr-3 text-right font-mono tabular-nums">
                          {c.render(row)}
                        </td>
                      ))}
                      <td className="py-2 text-right font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        {h
                          ? `${HEALTH[h.status].word}${h.score !== null ? ` · ${h.score}` : ""}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {comparing && pickedRows.length >= 2 && (
          <div className="glass-inset p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="label-mono">side by side</p>
              <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
                <X className="mr-1 h-3.5 w-3.5" aria-hidden /> Clear
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="label-mono py-1.5 pr-3 font-normal">measure</th>
                    {pickedRows.map((r) => (
                      <th key={r.id} className="max-w-[12rem] py-1.5 pr-3 text-right font-medium">
                        <span className="line-clamp-2 [overflow-wrap:anywhere]">{r.name}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c) => {
                    const values = pickedRows.map((r) => c.sortValue(r));
                    const measured = values.filter((v): v is number => v !== null);
                    const best = measured.length > 1 ? Math.max(...measured) : null;
                    return (
                      <tr key={c.key} className="border-t border-border/50">
                        <td className="py-1.5 pr-3 text-muted-foreground">{c.label}</td>
                        {pickedRows.map((r, i) => (
                          <td
                            key={r.id}
                            className={cn(
                              "py-1.5 pr-3 text-right font-mono tabular-nums",
                              best !== null && values[i] === best && "font-semibold",
                            )}
                          >
                            {c.render(r)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              the largest figure in each row is set in bold — for a cost, that is the most expensive
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
