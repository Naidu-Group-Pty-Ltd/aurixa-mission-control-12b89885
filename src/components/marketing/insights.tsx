// What the engine concluded from a channel's figures: findings, entity
// health, the period comparison, budget advice, the trend and month pacing.
//
// Every conclusion here is deterministic and computed on the server from the
// vendor's own figures. Nothing in this file is a model's words.
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { cn } from "@/lib/utils";
import {
  changeTone,
  comparisonLabel,
  formatComparisonValue,
  formatSignalFigure,
} from "@/lib/marketing/labels.pure";
import {
  formatChange,
  formatCount,
  formatMoney,
  formatPercent,
  type BudgetAdvice,
  type ChannelSignal,
  type EntityHealth,
  type MonthPacing,
  type PeriodComparisonRow,
  type SeriesForecast,
} from "@/lib/marketing/marketingEngine";
import { ForecastChart } from "./charts";
import { HEALTH } from "./health-words";

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const SEVERITY: Record<ChannelSignal["severity"], { spine: SpineTone; word: string }> = {
  critical: { spine: "bad", word: "critical" },
  warning: { spine: "warn", word: "warning" },
  info: { spine: "live", word: "note" },
};

export function SignalList({
  signals,
  currency,
  emptyText,
}: {
  signals: ChannelSignal[];
  currency: string | null;
  emptyText: string;
}) {
  return (
    <Panel
      title="Findings"
      description="Rules applied to the vendor’s own figures, each compared with this account’s own average."
    >
      {signals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="space-y-2">
          {signals.map((s) => (
            <RecordRow key={s.id} spine={SEVERITY[s.severity].spine} className="px-4 py-3 text-sm">
              <p className="label-mono">{SEVERITY[s.severity].word}</p>
              <p className="mt-1 font-medium [overflow-wrap:anywhere]">{s.title}</p>
              <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">{s.description}</p>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                measured {formatSignalFigure(s, s.value, currency)} · against{" "}
                {formatSignalFigure(s, s.threshold, currency)}
              </p>
            </RecordRow>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function HealthList({ health }: { health: EntityHealth[] }) {
  const scored = health.filter((h) => h.status !== "not_scored");
  return (
    <Panel
      title="Health"
      description="A 0–100 score from efficiency, attention, retention, engagement and volume, each judged against this account’s own median. An entity measured on fewer than two of them is not scored."
    >
      {scored.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing in this period was measured on enough factors to score.
        </p>
      ) : (
        <div className="space-y-2">
          {scored.slice(0, 8).map((h) => (
            <RecordRow
              key={h.entityId}
              spine={HEALTH[h.status].spine}
              className="px-4 py-3 text-sm"
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <p className="min-w-0 truncate font-medium" title={h.entityName}>
                  {h.entityName}
                </p>
                <p className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  {HEALTH[h.status].word}
                  {h.score !== null ? ` · ${h.score}` : ""}
                </p>
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {h.factors.map((f) => `${f.label} ${f.score === null ? "—" : f.score}`).join(" · ")}
              </p>
              {h.recommendations.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {h.recommendations.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </RecordRow>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function ComparisonTable({
  rows,
  currency,
  followersWord,
}: {
  rows: PeriodComparisonRow[];
  currency: string | null;
  followersWord?: string;
}) {
  return (
    <Panel
      title="Against the previous period"
      description="The same number of days immediately before this range."
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There is no previous period to compare with.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="label-mono text-left">
                <th className="py-2 pr-3 font-normal">measure</th>
                <th className="py-2 pr-3 text-right font-normal">this period</th>
                <th className="py-2 pr-3 text-right font-normal">previous</th>
                <th className="py-2 text-right font-normal">change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const tone = changeTone(row);
                const Icon =
                  row.change === null || row.change === 0
                    ? Minus
                    : row.change > 0
                      ? ArrowUpRight
                      : ArrowDownRight;
                return (
                  <tr key={row.key} className="border-t border-border/50">
                    <td className="py-2 pr-3">{comparisonLabel(row.key, followersWord)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatComparisonValue(row.key, row.current, currency)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                      {formatComparisonValue(row.key, row.previous, currency)}
                    </td>
                    <td
                      className={cn(
                        "py-2 text-right font-mono tabular-nums",
                        tone === "good" && "text-success",
                        tone === "bad" && "text-destructive",
                        tone === "neutral" && "text-muted-foreground",
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                        {formatChange(row.change)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function BudgetAdviceCard({
  advice,
  currency,
}: {
  advice: BudgetAdvice | null;
  currency: string | null;
}) {
  return (
    <Panel
      title="Budget advice"
      description={
        <>
          Moves of at most a fifth of a campaign’s spend, from the costliest results to the
          cheapest.
          {advice?.accountCostPerResult != null && (
            <> Account cost per result: {formatMoney(advice.accountCostPerResult, currency)}.</>
          )}
        </>
      }
    >
      {!advice || advice.moves.length === 0 ? (
        <p className="text-sm text-muted-foreground">No move is suggested for this period.</p>
      ) : (
        <div className="space-y-2">
          {advice.moves.map((m) => (
            <RecordRow key={`${m.fromId}-${m.toId}`} spine="live" className="px-4 py-3 text-sm">
              <p className="font-medium">Move {formatMoney(m.amount, currency)}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-muted-foreground">
                <span className="[overflow-wrap:anywhere]">
                  from <span className="text-foreground">{m.fromName}</span> (
                  {formatMoney(m.fromCostPerResult, currency)} a result)
                </span>
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                <span className="[overflow-wrap:anywhere]">
                  to <span className="text-foreground">{m.toName}</span> (
                  {formatMoney(m.toCostPerResult, currency)} a result)
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                About {formatCount(Math.round(m.estimatedExtraResults))} more results at today’s
                average costs — optimistic, since the cheapest results are usually bought first.
              </p>
            </RecordRow>
          ))}
        </div>
      )}
      {advice?.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-muted-foreground">
          {n}
        </p>
      ))}
    </Panel>
  );
}

export function ForecastPanel({
  forecast,
  title,
  formatValue,
}: {
  forecast: SeriesForecast | null | undefined;
  title: string;
  formatValue: (n: number) => string;
}) {
  const trend = forecast?.trend ?? null;
  return (
    <Panel
      title={`${title}${trend ? ` · ${trend}` : ""}`}
      description={
        forecast && forecast.forecast.length > 0 ? (
          <>
            Next {forecast.forecast.length} days:{" "}
            {forecast.projectedTotal !== null ? formatValue(forecast.projectedTotal) : "—"}.
            {forecast.dailyAverage !== null && (
              <> Measured average {formatValue(forecast.dailyAverage)} a day.</>
            )}
          </>
        ) : undefined
      }
    >
      {!forecast || forecast.forecast.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {forecast?.note ?? "Not enough days were measured to draw a trend."}
        </p>
      ) : (
        <>
          <ForecastChart forecast={forecast} formatValue={formatValue} title={title} />
          <p className="mt-2 text-xs text-muted-foreground">{forecast.note}</p>
        </>
      )}
    </Panel>
  );
}

const PACING: Record<NonNullable<MonthPacing["status"]>, { spine: SpineTone; word: string }> = {
  under: { spine: "live", word: "under budget" },
  on_track: { spine: "ok", word: "on track" },
  over: { spine: "warn", word: "over budget" },
};

export function PacingPanel({
  pacing,
  currency,
}: {
  pacing: MonthPacing;
  currency: string | null;
}) {
  const status = pacing.status ? PACING[pacing.status] : null;
  return (
    <Panel
      title={`Month pacing${status ? ` · ${status.word}` : ""}`}
      description={`Day ${pacing.daysElapsed} of ${pacing.daysInMonth}, counted to the end of yesterday.`}
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["spent so far", formatMoney(pacing.monthToDateSpend, currency)],
          ["projected month", formatMoney(pacing.projectedMonthSpend, currency)],
          ["daily budgets × days", formatMoney(pacing.monthBudget, currency)],
          ["pace", formatPercent(pacing.pace, 0)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="label-mono">{label}</dt>
            <dd className="numeral mt-1 text-lg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">{pacing.note}</p>
    </Panel>
  );
}
