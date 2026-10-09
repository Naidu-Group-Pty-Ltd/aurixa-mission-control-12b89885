// The Marketing pages' two charts: a channel's figures day by day, and a
// figure's trend with its projection.
//
// Drawn through the console's `ChartContainer`, so every colour is a token and
// follows the theme. A day the vendor did not report is a gap in the line,
// never a fall to zero, and a value is printed in its own unit in the tooltip
// rather than as a bare number.
import { format, parseISO } from "date-fns";
import { Area, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { SeriesForecast } from "@/lib/marketing/marketingEngine";

export interface TrendSeries {
  key: string;
  label: string;
  kind: "bar" | "line";
  axis: "left" | "right";
  /** Which of the theme's chart colours (1–5). */
  colour: 1 | 2 | 3 | 4 | 5;
  format: (value: number) => string;
}

function dayLabel(value: unknown): string {
  try {
    return format(parseISO(String(value)), "d MMM");
  } catch {
    return String(value);
  }
}

function valueRow(label: string, text: string, colour: string) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span className="h-2.5 w-2.5 shrink-0" style={{ background: colour }} aria-hidden />
        {label}
      </span>
      <span className="font-mono font-medium tabular-nums text-foreground">{text}</span>
    </div>
  );
}

export function TrendChart({
  data,
  series,
  ariaLabel,
  className = "h-64",
}: {
  data: Array<Record<string, number | string | null>>;
  series: TrendSeries[];
  ariaLabel: string;
  className?: string;
}) {
  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: `var(--chart-${s.colour})` }]),
  );
  const byKey = new Map(series.map((s) => [s.key, s]));
  const left = series.find((s) => s.axis === "left");
  const right = series.find((s) => s.axis === "right");
  return (
    <div role="img" aria-label={ariaLabel}>
      <ChartContainer config={config} className={`aspect-auto w-full ${className}`}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={dayLabel}
            tickLine={false}
            axisLine={false}
            minTickGap={16}
          />
          {left && (
            <YAxis
              yAxisId="left"
              tickFormatter={(v: number) => left.format(v)}
              tickLine={false}
              axisLine={false}
              width={64}
            />
          )}
          {right && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={(v: number) => right.format(v)}
              tickLine={false}
              axisLine={false}
              width={56}
            />
          )}
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => dayLabel(label)}
                formatter={(value, name) => {
                  const s = byKey.get(String(name));
                  const n = typeof value === "number" ? value : Number(value);
                  return valueRow(
                    s?.label ?? String(name),
                    s && Number.isFinite(n) ? s.format(n) : "—",
                    `var(--color-${String(name)})`,
                  );
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map((s) =>
            s.kind === "bar" ? (
              <Bar
                key={s.key}
                yAxisId={s.axis}
                dataKey={s.key}
                fill={`var(--color-${s.key})`}
                maxBarSize={28}
              />
            ) : (
              <Line
                key={s.key}
                yAxisId={s.axis}
                dataKey={s.key}
                stroke={`var(--color-${s.key})`}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                type="monotone"
              />
            ),
          )}
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}

/** Measured days, then the projection with its typical spread. */
export function ForecastChart({
  forecast,
  formatValue,
  title,
}: {
  forecast: SeriesForecast;
  formatValue: (n: number) => string;
  title: string;
}) {
  const data: Array<Record<string, unknown>> = forecast.history.map((p) => ({
    date: p.date,
    actual: p.value,
  }));
  const last = forecast.history[forecast.history.length - 1];
  if (last && forecast.forecast.length > 0)
    data[data.length - 1] = { ...data[data.length - 1], projected: last.value };
  for (const p of forecast.forecast)
    data.push({ date: p.date, projected: p.value, band: [p.low, p.high] });
  const config: ChartConfig = {
    actual: { label: "Measured", color: "var(--chart-1)" },
    projected: { label: "Projected", color: "var(--chart-2)" },
    band: { label: "Typical range", color: "var(--chart-2)" },
  };
  return (
    <div role="img" aria-label={`${title}: measured days and a projection`}>
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={dayLabel}
            tickLine={false}
            axisLine={false}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={(v: number) => formatValue(v)}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => dayLabel(label)}
                formatter={(value, name) => {
                  if (Array.isArray(value)) {
                    return valueRow(
                      "Typical range",
                      `${formatValue(Number(value[0]))} – ${formatValue(Number(value[1]))}`,
                      "var(--color-band)",
                    );
                  }
                  const key = String(name);
                  return valueRow(
                    key === "actual" ? "Measured" : "Projected",
                    formatValue(Number(value)),
                    `var(--color-${key})`,
                  );
                }}
              />
            }
          />
          <Area
            dataKey="band"
            stroke="none"
            fill="var(--color-band)"
            fillOpacity={0.15}
            isAnimationActive={false}
          />
          <Line
            dataKey="actual"
            stroke="var(--color-actual)"
            strokeWidth={2}
            dot={false}
            type="monotone"
          />
          <Line
            dataKey="projected"
            stroke="var(--color-projected)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            type="monotone"
          />
        </ComposedChart>
      </ChartContainer>
    </div>
  );
}
