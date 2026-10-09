// The range every Marketing page reads, held by the layout so moving between
// Overview, Meta, YouTube and TikTok keeps it, and the control that sets it.
//
// The reader's own time zone travels with every request, so "Last 7 Days" is
// the reader's last seven days — the same rule the prime's Marketing page
// follows.
import { useMemo, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DATE_PRESET_LABELS, DATE_PRESETS, type DatePreset } from "@/lib/marketing/marketingEngine";
import { RangeContext, useMarketingRange, type RangeContextValue } from "./use-marketing-range";

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function MarketingRangeProvider({ children }: { children: ReactNode }) {
  const [datePreset, setPreset] = useState<DatePreset>("last_30d");
  const [timeRange, setCustom] = useState<{ since: string; until: string } | null>(null);
  const value = useMemo<RangeContextValue>(
    () => ({
      datePreset,
      timeRange,
      setPreset: (p) => {
        setPreset(p);
        setCustom(null);
      },
      setCustom,
      request: { datePreset, timeRange, timeZone: browserTimeZone() },
    }),
    [datePreset, timeRange],
  );
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function RangeControl() {
  const range = useMarketingRange();
  const [since, setSince] = useState(range.timeRange?.since ?? "");
  const [until, setUntil] = useState(range.timeRange?.until ?? "");
  const custom = range.timeRange !== null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <span className="label-mono">range</span>
        <Select
          value={custom ? "custom" : range.datePreset}
          onValueChange={(v) => {
            if (v === "custom") {
              if (since && until) range.setCustom({ since, until });
              return;
            }
            range.setPreset(v as DatePreset);
          }}
        >
          <SelectTrigger className="w-44" aria-label="Date range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => (
              <SelectItem key={p} value={p}>
                {DATE_PRESET_LABELS[p]}
              </SelectItem>
            ))}
            <SelectItem value="custom" disabled={!(since && until) && !custom}>
              Custom range
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <span className="label-mono">from</span>
        <Input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="w-40"
          aria-label="From"
        />
      </div>
      <div className="space-y-1">
        <span className="label-mono">to</span>
        <Input
          type="date"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          className="w-40"
          aria-label="To"
        />
      </div>
      <button
        type="button"
        disabled={!since || !until}
        onClick={() => range.setCustom({ since, until })}
        className="h-9 border border-border px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
      >
        Apply dates
      </button>
    </div>
  );
}
