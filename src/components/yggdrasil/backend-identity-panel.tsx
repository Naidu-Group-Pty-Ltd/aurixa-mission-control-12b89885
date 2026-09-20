/**
 * WHOSE DATABASE IS EACH BRANCH SHIPPING?
 *
 * The tree has always drawn where a clone gets its CODE from. This says where
 * its users' DATA goes, which is a different question and the one that was
 * wrong on every clone in the fleet on 20 Sep 2026: all three shipped the
 * prime's Supabase URL and anon key, so a lead captured on a tenant's own
 * domain was written into the prime's database. The cascade had been holding
 * those files correctly for weeks — holding a wrong file in place is not the
 * same as saying it is wrong, and nothing anywhere said it.
 *
 * ## Why a button and not a badge that is always there
 *
 * The reading costs two GitHub reads per clone against a live repository.
 * Drawing it on every render would make the tree's load time a function of
 * fleet size, and a figure that is always on screen is one nobody looks at.
 * This is asked.
 *
 * ## The clean case is drawn, not omitted
 *
 * A fleet with nothing wrong still renders its count and the paths it read.
 * An empty panel and a panel that found nothing look identical, and only one
 * of them means anything.
 */
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, HelpCircle, ScanLine, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { fetchFleetBackendIdentity, type FleetIdentity } from "@/server/backend-identity.functions";
import type { IdentityVerdict } from "@/server/cascade/backendIdentityReading.pure";

/**
 * How each reading is drawn.
 *
 * Four entries, because there are four readings. The two that are neither a
 * finding nor a clean bill — `no_backend` and `unreadable` — are deliberately
 * NOT green: "we could not check" is not "you are fine", and a clone with no
 * backend recorded is not one that has been cleared.
 */
const VERDICT: Record<
  IdentityVerdict,
  { label: string; color: string; Icon: typeof AlertTriangle }
> = {
  foreign: { label: "ships another project", color: "text-destructive", Icon: AlertTriangle },
  own: { label: "ships its own project", color: "text-success", Icon: CheckCircle2 },
  no_backend: { label: "no backend recorded", color: "text-warning", Icon: ShieldQuestion },
  unreadable: { label: "could not be read", color: "text-warning", Icon: HelpCircle },
};

export function BackendIdentityPanel() {
  const probe = useServerFn(fetchFleetBackendIdentity);
  const [result, setResult] = useState<FleetIdentity | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      setResult(await probe());
    } catch (e) {
      // The failure is shown and the previous reading is KEPT rather than
      // blanked: a stale answer an operator can see the age of is worth more
      // than an empty panel that looks like a clean fleet.
      toast.error(e instanceof Error ? e.message : "Could not read the fleet's backend identity");
    } finally {
      setRunning(false);
    }
  };

  // Everything that is not `own`, findings first. A clean clone is counted
  // rather than listed — the list is what somebody has to act on.
  const needsAttention = (result?.rows ?? [])
    .filter((r) => r.reading.verdict !== "own")
    .sort((a, b) =>
      a.reading.verdict === "foreign" ? -1 : b.reading.verdict === "foreign" ? 1 : 0,
    );

  return (
    <section className="border border-border/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="label-mono">backend identity</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Which Supabase project each deployment actually ships, read from its repository.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="font-mono text-xs"
          onClick={run}
          disabled={running}
        >
          <ScanLine className="mr-1.5 h-3 w-3" />
          {running ? "Reading…" : result ? "Read again" : "Check the fleet"}
        </Button>
      </div>

      {result && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-4 font-mono text-xs">
            {(Object.keys(VERDICT) as IdentityVerdict[]).map((v) => {
              const { label, color, Icon } = VERDICT[v];
              return (
                <span key={v} className={`flex items-center gap-1.5 ${color}`}>
                  <Icon className="h-3.5 w-3.5" />
                  <span className="tabular-nums font-semibold">{result.totals[v]}</span>
                  <span className="text-muted-foreground">{label}</span>
                </span>
              );
            })}
          </div>

          {needsAttention.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground">
              Every deployment reads its own project. Checked{" "}
              {result.rows[0]?.reading.paths.join(", ") || "no files"} on {result.rows.length}{" "}
              deployment(s) — these are the files that carry a Supabase pair, not the whole tree.
            </p>
          ) : (
            <ul className="space-y-2">
              {needsAttention.map((row) => {
                const { color, Icon } = VERDICT[row.reading.verdict];
                return (
                  <li key={row.cloneId} className="border border-border/30 p-3">
                    <div className={`flex items-center gap-2 font-mono text-xs ${color}`}>
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="font-semibold">{row.name}</span>
                      <span className="text-muted-foreground">
                        {row.githubOwner}/{row.githubRepo}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{row.reading.summary}</p>
                    {row.reading.findings.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {row.reading.findings.map((f) => (
                          <li key={f.path} className="font-mono text-[10px] text-muted-foreground">
                            {f.path} → {f.foreignRefs.join(", ")}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="font-mono text-[10px] text-muted-foreground/60">
            Read {new Date(result.probedAt).toLocaleString()}
          </p>
        </div>
      )}
    </section>
  );
}
