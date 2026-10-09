// How far into a video the audience got, stage by stage.
//
// Each bar is a share of the first stage, and each step says what it kept of
// the stage before it. A stage the vendor does not measure is left out rather
// than drawn empty: a missing six-second count is not a funnel that lost
// everybody at six seconds.
import { formatCount, formatPercent, type Measured } from "@/lib/marketing/marketingEngine";

export interface FunnelStage {
  key: string;
  label: string;
  value: Measured;
}

export function VideoFunnel({ stages, basis }: { stages: FunnelStage[]; basis?: string }) {
  const measured = stages.filter((s): s is FunnelStage & { value: number } => s.value !== null);
  const top = measured[0]?.value ?? 0;
  if (measured.length < 2 || !(top > 0)) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough of the funnel was measured over this period to draw it.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ol className="space-y-2.5" aria-label="Video funnel">
        {measured.map((stage, i) => {
          const share = stage.value / top;
          const previous = i > 0 ? measured[i - 1].value : null;
          const kept = previous && previous > 0 ? stage.value / previous : null;
          return (
            <li key={stage.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{stage.label}</span>
                <span className="shrink-0 font-mono tabular-nums">
                  {formatCount(stage.value)}
                  {i > 0 && (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {formatPercent(share, 1)} of the first
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2 bg-muted" aria-hidden>
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.max(1, Math.min(100, share * 100))}%` }}
                />
              </div>
              {kept !== null && i > 0 && (
                <p className="font-mono text-[10px] text-muted-foreground">
                  kept {formatPercent(kept, 1)} of the stage above
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {basis && <p className="text-xs text-muted-foreground">{basis}</p>}
    </div>
  );
}
