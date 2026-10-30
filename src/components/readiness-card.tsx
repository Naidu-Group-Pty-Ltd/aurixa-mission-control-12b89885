// What this deployment can do, and what is stopping it.
//
// The way hosting turned out to be unconfigured was a clone parked at
// `pending_platform` with `status_detail: "No hosting provider token
// configured."` — a row in a table that nothing surfaced. This is that answer,
// before the attempt rather than after it.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CircleCheck,
  CircleX,
  HelpCircle,
  Loader2,
  RefreshCw,
  KeyRound,
  Minus,
} from "lucide-react";
import { fetchReadiness, type ReadinessReport } from "@/lib/readiness.functions";

type Capability = ReadinessReport["capabilities"][number];

/**
 * Four verdicts, four renderings.
 *
 * `ready` deliberately does not say "healthy" or "ok" — it says `no gaps`,
 * because presence is all this establishes. `unknown` is drawn as neither pass
 * nor fail: a precondition this side could not read is not a finding about the
 * configuration.
 */
function VerdictPill({ verdict }: { verdict: Capability["verdict"] }) {
  switch (verdict) {
    case "blocked":
      return (
        <Badge variant="destructive" className="gap-1">
          <CircleX className="h-3 w-3" />
          blocked
        </Badge>
      );
    case "degraded":
      return (
        <Badge variant="outline" className="gap-1">
          <Minus className="h-3 w-3" />
          degraded
        </Badge>
      );
    case "unknown":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <HelpCircle className="h-3 w-3" />
          could not check
        </Badge>
      );
    case "ready":
      return (
        <Badge variant="secondary" className="gap-1">
          <CircleCheck className="h-3 w-3 text-emerald-500" />
          no gaps
        </Badge>
      );
  }
}

export function ReadinessCard() {
  const fetchFn = useServerFn(fetchReadiness);
  const [data, setData] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchFn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load readiness");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Blocked first. An operator opening this is looking for what is wrong.
  const sorted = [...(data?.capabilities ?? [])].sort((a, b) => {
    const rank = (c: Capability) =>
      c.verdict === "blocked" ? 0 : c.verdict === "unknown" ? 1 : c.verdict === "degraded" ? 2 : 3;
    return rank(a) - rank(b);
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Platform readiness
          </CardTitle>
          <CardDescription>
            Which credentials and settings are in place, grouped by what they let you do.
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
            {/* The headline an operator actually wants, and it is scoped to the
                clone path: a blocked Stripe is a real problem and is not a
                reason to say cloning is impossible. */}
            {data && (
              <div
                className={
                  data.cloneReady
                    ? "rounded-md border p-2.5"
                    : "rounded-md border border-destructive/40 bg-destructive/5 p-2.5"
                }
              >
                <p className="text-sm font-medium">
                  {data.cloneReady ? "Nothing on the clone path is missing" : "Cloning is blocked"}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {data.cloneReady
                    ? "Core, backend provisioning, repository, hosting and DNS all have what they need."
                    : sorted
                        .filter((c) => c.verdict === "blocked")
                        .map((c) => c.title)
                        .join(" · ")}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant={data?.blocked ? "destructive" : "outline"}>
                {data?.blocked ?? 0} blocked
              </Badge>
              {(data?.degraded ?? 0) > 0 && (
                <Badge variant="outline">{data?.degraded} degraded</Badge>
              )}
              {(data?.unknown ?? 0) > 0 && (
                <Badge variant="outline">{data?.unknown} could not check</Badge>
              )}
            </div>

            <div className="space-y-2">
              {sorted.map((cap) => (
                <div key={cap.key} className="rounded-md border p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{cap.title}</p>
                    <VerdictPill verdict={cap.verdict} />
                  </div>

                  {/* What breaks — shown only when something is actually wrong,
                      so a working platform is not a wall of warnings. */}
                  {cap.verdict === "blocked" && (
                    <p className="mt-1 text-[11px] text-destructive">{cap.consequence}</p>
                  )}

                  {cap.blockers.map((b) => (
                    <p key={b} className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {b}
                    </p>
                  ))}

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {cap.credentials.map((c) => (
                      <Badge
                        key={c.name}
                        variant={
                          c.state === "set" ? "secondary" : c.required ? "destructive" : "outline"
                        }
                        className="font-mono text-[10px]"
                        title={c.purpose}
                      >
                        {c.name}
                        {c.state === "missing" && (c.required ? " · missing" : " · optional")}
                        {c.state === "default" && " · default"}
                      </Badge>
                    ))}
                    {cap.config.map((cfg) => (
                      <Badge
                        key={cfg.label}
                        variant={cfg.ok === false ? "destructive" : "outline"}
                        className="text-[10px]"
                        title={cfg.detail}
                      >
                        {cfg.label}
                        {cfg.ok === null && " · unknown"}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Part of the answer, not decoration around it — which is why it
                arrives ON the report rather than being imported beside it. */}
            {data && <p className="text-[11px] text-muted-foreground">{data.caveat}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
