// The range every Marketing page reads, and the hook that reads it. Held by
// <MarketingRangeProvider> in the Marketing layout, so moving between tabs
// keeps it.
import { createContext, useContext } from "react";
import type { DatePreset } from "@/lib/marketing/marketingEngine";

export interface MarketingRange {
  datePreset: DatePreset;
  timeRange: { since: string; until: string } | null;
}

export interface RangeContextValue extends MarketingRange {
  setPreset: (preset: DatePreset) => void;
  setCustom: (range: { since: string; until: string } | null) => void;
  /** What a server function is sent. The reader's own time zone travels with it. */
  request: {
    datePreset: DatePreset;
    timeRange: { since: string; until: string } | null;
    timeZone?: string;
  };
}

export const RangeContext = createContext<RangeContextValue | null>(null);

export function useMarketingRange(): RangeContextValue {
  const ctx = useContext(RangeContext);
  if (!ctx) throw new Error("useMarketingRange must be used inside <MarketingRangeProvider>");
  return ctx;
}

/** A query key fragment that changes exactly when the range does. */
export function rangeKey(range: MarketingRange): string {
  return range.timeRange ? `${range.timeRange.since}..${range.timeRange.until}` : range.datePreset;
}
