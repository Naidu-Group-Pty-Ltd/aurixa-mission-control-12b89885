/**
 * Where one mailbox's warmup mail landed, day by day.
 *
 * The story is the mail that did NOT reach the inbox, so that is the one
 * coloured thing: each day is a column of what the mailbox sent, the part
 * that reached an inbox (or a folder a rule moved it to) in the neutral
 * `--chart-muted`, and the part that went to spam or never arrived in
 * `--destructive`. Emphasis rather than three status colours: inbox / spam /
 * missing in green / amber / red fails the colour-blind check (amber and red
 * collapse under deuteranopia), and spam versus missing is a detail the
 * tooltip and the table carry.
 *
 * Checked with the dataviz validator against the card surface in both
 * themes: the two fills separate by ΔE 10.5 (dark) and 21.3 (light) under
 * colour-blind simulation. The neutral sits below 3:1 against the surface on
 * purpose, so the table view is always one click away.
 */
import { useState } from "react";
import { format, parseISO } from "date-fns";
import { AlertTriangle, BarChart3, Table2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { healthScore, type WarmupDay } from "@/lib/email/warmupPlan.pure";

type Point = WarmupDay & { placed: number; bad: number };

const config: ChartConfig = {
  placed: { label: "Reached the inbox", color: "var(--chart-muted)" },
  bad: { label: "Spam or missing", color: "var(--destructive)" },
};

function dayLabel(value: unknown): string {
  try {
    return format(parseISO(String(value)), "d MMM");
  } catch {
    return String(value);
  }
}

/** A column segment: square at the bottom, 4px round at the top when it IS the top. */
function segment(top: (point: Point) => boolean, gapBelowTop: (point: Point) => boolean) {
  return function Shape(props: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fill?: string;
    payload?: Point;
  }) {
    const { x = 0, width = 0, fill, payload } = props;
    let { y = 0, height = 0 } = props;
    if (!payload || height <= 0 || width <= 0) return <g />;
    // The 2px surface gap between the two parts of a column.
    if (gapBelowTop(payload)) {
      y += 2;
      height -= 2;
    }
    if (height <= 0) return <g />;
    if (!top(payload)) return <rect x={x} y={y} width={width} height={height} fill={fill} />;
    const r = Math.min(4, width / 2, height);
    const d = `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
    return <path d={d} fill={fill} />;
  };
}

const PlacedShape = segment(
  (point) => point.bad === 0,
  (point) => point.bad > 0,
);
const BadShape = segment(
  () => true,
  () => false,
);

function Tooltip({ active, payload }: { active?: boolean; payload?: { payload?: Point }[] }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const score = healthScore(point);
  const row = (value: string, label: string, colour?: string) => (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {colour ? (
          <span
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: colour }}
            aria-hidden
          />
        ) : (
          <span className="w-3" aria-hidden />
        )}
        {label}
      </span>
      <span className="font-mono font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
  return (
    <div className="min-w-[12rem] space-y-1 rounded-md border border-border/60 bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-medium text-foreground">{format(parseISO(point.day), "EEE d MMM")}</p>
      {row(String(point.sent), "sent")}
      {row(String(point.placed), "reached the inbox", "var(--chart-muted)")}
      {row(String(point.junk), "landed in spam", "var(--destructive)")}
      {row(String(point.missing), "never arrived", "var(--destructive)")}
      {score !== null ? row(`${score}%`, "inbox placement") : null}
      {point.received ? row(String(point.received), "received") : null}
      {point.rescued ? row(String(point.rescued), "rescued from spam") : null}
    </div>
  );
}

export function PlacementChart({ days }: { days: WarmupDay[] }) {
  const [asTable, setAsTable] = useState(false);
  const data: Point[] = days.map((day) => ({
    ...day,
    placed: day.inbox + day.other,
    bad: day.junk + day.missing,
  }));
  const sentAny = data.some((day) => day.sent > 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-chart-muted" aria-hidden />
            Reached the inbox
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-destructive" aria-hidden />
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Spam or missing
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setAsTable((shown) => !shown)}
          aria-pressed={asTable}
        >
          {asTable ? <BarChart3 className="mr-1 h-3 w-3" /> : <Table2 className="mr-1 h-3 w-3" />}
          {asTable ? "Chart" : "Table"}
        </Button>
      </div>

      {!sentAny ? (
        <p className="py-6 text-center font-mono text-xs text-muted-foreground">
          Nothing sent in the last 30 days.
        </p>
      ) : asTable ? (
        <div className="max-h-72 overflow-auto rounded border border-border/50">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Inbox</TableHead>
                <TableHead className="text-right">Spam</TableHead>
                <TableHead className="text-right">Missing</TableHead>
                <TableHead className="text-right">Placement</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Rescued</TableHead>
                <TableHead className="text-right">Replied</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...data].reverse().map((day) => {
                const score = healthScore(day);
                return (
                  <TableRow key={day.day} className="font-mono text-xs tabular-nums">
                    <TableCell>{format(parseISO(day.day), "EEE d MMM")}</TableCell>
                    <TableCell className="text-right">{day.sent}</TableCell>
                    <TableCell className="text-right">{day.placed}</TableCell>
                    <TableCell className="text-right">{day.junk}</TableCell>
                    <TableCell className="text-right">{day.missing}</TableCell>
                    <TableCell className="text-right">
                      {score === null ? "—" : `${score}%`}
                    </TableCell>
                    <TableCell className="text-right">{day.received}</TableCell>
                    <TableCell className="text-right">{day.rescued}</TableCell>
                    <TableCell className="text-right">{day.replied}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div
          role="img"
          aria-label="Where this mailbox's warmup mail landed, each of the last 30 days"
        >
          <ChartContainer config={config} className="aspect-auto h-52 w-full">
            <BarChart
              data={data}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              barCategoryGap="20%"
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={dayLabel}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
              <ChartTooltip
                cursor={{ fill: "var(--muted)", opacity: 0.35 }}
                content={<Tooltip />}
              />
              <Bar
                dataKey="placed"
                stackId="sent"
                fill="var(--color-placed)"
                maxBarSize={24}
                shape={PlacedShape}
                isAnimationActive={false}
              />
              <Bar
                dataKey="bad"
                stackId="sent"
                fill="var(--color-bad)"
                maxBarSize={24}
                shape={BadShape}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </div>
  );
}
