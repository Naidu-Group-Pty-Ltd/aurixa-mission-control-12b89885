// Operator view of whether each migration's declared effect is actually in the
// database. A green apply only proves the SQL ran -- a `DO $$ ... EXCEPTION
// WHEN OTHERS THEN NULL $$` block succeeds having achieved nothing, and this
// corpus contains that shape. What this card reports is the schema itself.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CircleCheck, CircleX, Clock, HelpCircle, Loader2, RefreshCw, Layers } from "lucide-react";
import { formatDistanceToNow } from "@/lib/format";
import {
  fetchMigrationDrift,
  type MigrationDriftReport,
  type MigrationAssertionRow,
} from "@/lib/migration-drift.functions";

/**
 * Five verdicts get five renderings, deliberately.
 *
 * Drawing `unassertable` or `error` as a failure is how an alarm gets muted,
 * and drawing either as a tick is how it stops being an alarm. Neither is a
 * result about the migration: one says nothing can answer the question, the
 * other says the asking failed.
 */
function StatusPill({ row }: { row: MigrationAssertionRow }) {
  switch (row.status) {
    case "satisfied":
      return (
        <Badge variant="secondary" className="gap-1">
          <CircleCheck className="h-3 w-3 text-emerald-500" />
          present
        </Badge>
      );
    case "unsatisfied":
      return (
        <Badge variant="destructive" className="gap-1">
          <CircleX className="h-3 w-3" />
          missing
        </Badge>
      );
    case "error":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" />
          not answered
        </Badge>
      );
    case "unassertable":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <HelpCircle className="h-3 w-3" />
          uncheckable
        </Badge>
      );
    case "not_applicable":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          &mdash;
        </Badge>
      );
    case "superseded":
      // Quiet on purpose: a retired claim is a recorded decision, not a
      // condition. The detail column names the migration that retired it.
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          retired
        </Badge>
      );
  }
}

export function MigrationDriftCard() {
  const fetchFn = useServerFn(fetchMigrationDrift);
  const [data, setData] = useState<MigrationDriftReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchFn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load migration drift");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = data?.rows ?? [];
  // Drift first, then the ones nothing could answer, then the rest. An operator
  // opening this page is looking for what is wrong, not for a roll call.
  const sorted = [...rows].sort((a, b) => {
    const rank = (r: MigrationAssertionRow) =>
      r.status === "unsatisfied"
        ? 0
        : r.status === "error"
          ? 1
          : r.status === "unassertable"
            ? 2
            : r.status === "superseded"
              ? 4
              : 3;
    return rank(a) - rank(b) || a.migration.localeCompare(b.migration);
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Migration effects
          </CardTitle>
          <CardDescription>
            Whether what each migration said it would make true is actually in this database.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">{data?.satisfied ?? 0} present</Badge>
              <Badge variant={data?.drifted ? "destructive" : "outline"}>
                {data?.drifted ?? 0} missing
              </Badge>
              {(data?.errored ?? 0) > 0 && (
                <Badge variant="outline">{data?.errored} not answered</Badge>
              )}
              {(data?.unassertable ?? 0) > 0 && (
                <Badge variant="outline">{data?.unassertable} uncheckable</Badge>
              )}
              {/* A claim with no observation is the interesting empty case: it
                  means the worker has not reached it, or has not run at all. */}
              {(data?.neverChecked ?? 0) > 0 && (
                <Badge variant="outline">{data?.neverChecked} never checked</Badge>
              )}
            </div>
            {/* The queue is a different question from the claims -- "is my
                migration waiting" rather than "did it take" -- but an operator
                asks them in one breath, so they share a card. A FAILED row
                halts the queue outright: migrations are ordered, and applying
                N+1 after N failed is how a schema becomes unreproducible. */}
            {(data?.queue?.length ?? 0) > 0 && (
              <div
                className={
                  data?.queueHalted
                    ? "rounded-md border border-destructive/40 bg-destructive/5 p-2.5"
                    : "rounded-md border p-2.5"
                }
              >
                <p className="text-xs font-medium">
                  {data?.queueHalted
                    ? "Migration queue halted by a failure"
                    : `${data?.queue.length} migration(s) waiting to apply`}
                </p>
                {data?.queue.map((q) => (
                  <p key={q.version} className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {q.name} · {q.status}
                    {q.attempts > 0 ? ` · ${q.attempts} attempt(s)` : ""}
                    {q.error ? ` · ${q.error}` : ""}
                  </p>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {data?.declared ?? 0} claim(s) across {data?.migrations ?? 0} migration(s).{" "}
              {data?.lastCheckedAt
                ? `Last checked ${formatDistanceToNow(new Date(data.lastCheckedAt))}.`
                : "Never checked — the hourly worker has not run yet."}
            </p>
            <div className="divide-y rounded-md border">
              {sorted.length === 0 && !loading ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No observations recorded yet. Migrations declare their effect with a{" "}
                  <code className="font-mono">-- @asserts</code> comment; the hourly worker resolves
                  them against the live schema.
                </p>
              ) : (
                sorted.map((r) => (
                  <div
                    key={`${r.migration} ${r.assertion}`}
                    className="flex flex-wrap items-center justify-between gap-2 p-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{r.assertion}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {r.migration} · {r.detail}
                      </p>
                    </div>
                    <StatusPill row={r} />
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
