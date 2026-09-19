/**
 * One clone's uptime, by day.
 *
 * ## The three things this used to get wrong
 *
 * It read `clone_health_snapshots` **from the browser** — a table that is
 * UNIQUE on `clone_id`, so a "30-day sparkline" could never hold more than one
 * bucket. It resolved each row's status as `payload.status`, a key
 * `CloneHealth` has never carried (the status is under `uptime`), so every
 * bucket computed 0% on a fleet that was up. And it ended with
 * `if (series.length === 0) return null`, which drew nothing at all for three
 * different states: a clone with no probes, a clone whose read RLS had
 * filtered — `[]` with HTTP 200, the trap three surfaces in this fleet have
 * hit — and a clone this card was never meant to draw for.
 *
 * Now: the series comes from `clone_health_daily` through a server function,
 * so a failed read is a failure rather than an emptiness; the percentages come
 * from columns, so no reader here knows a payload's shape; and a day that
 * measured nothing draws a GAP rather than a floor, because a clone with
 * nothing to ping has no uptime rather than none.
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { getCloneHealthHistory } from "@/server/metrics.functions";

type Series = Awaited<ReturnType<typeof getCloneHealthHistory>>;

export function CloneHealthTimeline({ cloneId }: { cloneId: string }) {
  const historyFn = useServerFn(getCloneHealthHistory);
  const [result, setResult] = useState<Series | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await historyFn({ data: { cloneId, windowDays: 30 } });
        if (!cancelled) setResult(data);
      } catch (e) {
        if (!cancelled)
          setResult({
            ok: false,
            error: e instanceof Error ? e.message : "The series could not be reached.",
            windowDays: 30,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneId]);

  if (!result) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-mono uppercase tracking-wider">
          <Activity className="h-4 w-4 text-primary" /> 30-day uptime
        </CardTitle>
        {result.ok && result.average !== null && (
          <span className="font-mono text-xs text-muted-foreground">avg {result.average}%</span>
        )}
      </CardHeader>
      <CardContent>
        <Content result={result} />
      </CardContent>
    </Card>
  );
}

function Content({ result }: { result: Series }) {
  if (!result.ok) {
    return (
      <div className="space-y-1 border border-dashed p-4 text-center">
        <p className="font-mono text-xs text-warning">The uptime series could not be read.</p>
        <p className="font-mono text-[11px] text-muted-foreground">{result.error}</p>
      </div>
    );
  }

  if (result.series.length === 0) {
    // Said rather than drawn as nothing. An empty chart area and a missing
    // card are the same pixel, and one of them means the probe has not run.
    return (
      <div className="border border-dashed p-4 text-center">
        <p className="font-mono text-xs text-muted-foreground">
          No probes recorded in the last {result.windowDays} days.
        </p>
      </div>
    );
  }

  const measured = result.series.reduce((s, d) => s + d.measured, 0);

  return (
    <>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={result.series}>
            <XAxis dataKey="date" tick={{ fontSize: 10 }} hide />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} width={28} />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                fontSize: 11,
              }}
            />
            <Line
              type="monotone"
              dataKey="pct"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              // A day that measured nothing is a GAP. Joining across it would
              // draw a line through a period nobody observed.
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {measured === 0 && (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
          Probes were taken but none reached a conclusion — this clone has no deployment to ping.
        </p>
      )}
    </>
  );
}
