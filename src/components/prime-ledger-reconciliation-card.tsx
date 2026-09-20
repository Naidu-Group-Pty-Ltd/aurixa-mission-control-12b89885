/**
 * What the prime's ledger omits, and which of it the prime's schema already
 * has.
 *
 * The surface for `buildPrimeLedgerReconciliation`, which computed this and
 * had no caller. See `primeLedgerReconciliation.functions.ts` for why that
 * mattered and `primeLedgerReconciliation.pure.ts` for what the verdicts mean.
 *
 * Three rules hold the rendering:
 *
 * **It draws nothing until it is asked.** The reading is up to 120 GitHub
 * blob fetches; a `useEffect` here would spend that on every visit to the
 * fleet page. The sibling registry card loads on mount because its reading is
 * one tree listing — this one is not that.
 *
 * **There is no stamp button and there must never be one.** The verdicts are
 * evidence, and the act they inform is on the prime and is a person's. A
 * control here would make `satisfied` read as permission, which is the one
 * thing the pure module refuses in its header three times over.
 *
 * **A body that was never read is drawn apart from one that was.** Nine of
 * this window's indeterminate rows are 41 MB seeds refused before the round
 * trip, and a page that reports them as "creates nothing we can name" is
 * describing files it never opened.
 */
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScanSearch, Loader2, CheckCircle2, AlertTriangle, HelpCircle, FileX2 } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  readPrimeLedgerReconciliation,
  type PrimeLedgerReconciliationResult,
} from "@/server/primeLedgerReconciliation.functions";

type Report = Extract<PrimeLedgerReconciliationResult, { ok: true }>;

/** How many rows are listed before the list stops. */
const ROW_LIMIT = 40;

function verdictBadge(row: Report["rows"][number]) {
  if (row.unread) {
    return (
      <Badge variant="outline" className="text-muted-foreground shrink-0 text-[10px]">
        <FileX2 className="mr-1 h-3 w-3" /> not read
      </Badge>
    );
  }
  if (row.verdict === "satisfied") {
    return (
      <Badge variant="outline" className="bg-success/10 text-success shrink-0 text-[10px]">
        <CheckCircle2 className="mr-1 h-3 w-3" /> prime has it
      </Badge>
    );
  }
  if (row.verdict === "unsatisfied") {
    return (
      <Badge variant="outline" className="bg-warning/10 text-warning shrink-0 text-[10px]">
        <AlertTriangle className="mr-1 h-3 w-3" /> not run
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground shrink-0 text-[10px]">
      <HelpCircle className="mr-1 h-3 w-3" /> nothing to check
    </Badge>
  );
}

export function PrimeLedgerReconciliationCard() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);

  const reconcile = useServerFn(readPrimeLedgerReconciliation);

  const handleRun = async () => {
    setRunning(true);
    try {
      const result = await reconcile();
      if (result.ok) {
        setReport(result);
        // The number an operator came for, said out loud. `satisfied` is the
        // recoverable half and the only one this reading can move.
        toast.success(
          `${result.candidates} version(s) the ledger omits — ${result.summary.satisfied} the prime's schema already satisfies`,
        );
      } else {
        toast.error(result.error);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The reconciliation could not be computed");
    }
    setRunning(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScanSearch className="text-primary h-4 w-4" /> Prime Ledger Reconciliation
        </CardTitle>
        <CardDescription>
          Which migrations the prime&rsquo;s ledger omits, and which of those its database already
          satisfies. Evidence for a decision on the prime — nothing here stamps a ledger or sends
          anything to a clone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={handleRun} disabled={running} variant="outline" className="w-full">
          {running ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading the prime&rsquo;s catalog...
            </>
          ) : (
            <>
              <ScanSearch className="mr-2 h-4 w-4" /> Measure the ledger gap
            </>
          )}
        </Button>

        {report && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="text-[10px]">
                {report.primeRef}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {report.candidates} omitted by the ledger
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="border p-3 text-center">
                <div className="text-success text-2xl font-semibold">
                  {report.summary.satisfied}
                </div>
                <div className="text-muted-foreground text-[11px]">
                  Prime already has every object
                </div>
              </div>
              <div className="border p-3 text-center">
                <div className="text-warning text-2xl font-semibold">
                  {report.summary.unsatisfied}
                </div>
                <div className="text-muted-foreground text-[11px]">Prime has not run it</div>
              </div>
              <div className="border p-3 text-center">
                <div className="text-2xl font-semibold">{report.summary.indeterminate}</div>
                <div className="text-muted-foreground text-[11px]">
                  Nothing to check
                  {/*
                    Drawn as the SUBSET it is, never as a fourth number beside
                    the three: the verdicts still sum to the rows, and this
                    says how much of the third one is a read that never
                    happened.
                  */}
                  {report.summary.unread > 0 && <> &mdash; {report.summary.unread} never read</>}
                </div>
              </div>
            </div>

            {/*
              Said on the page rather than in a tooltip, for the same reason
              the AUSTRAC path says the platform never lodges: the reader is
              about to act on this, and the boundary is part of the reading.
            */}
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              <span className="text-foreground font-medium">Prime already has every object</span> is
              a migration the prime ran under an id nothing wrote down — the ledger is wrong, not
              the schema. <span className="text-foreground font-medium">Prime has not run it</span>{" "}
              is a file to dispatch on the prime.{" "}
              <span className="text-foreground font-medium">Nothing to check</span> is neither: a
              migration that only alters, seeds or rewrites policies creates nothing the catalog can
              be asked about, and a rollback script looks exactly the same. Reading this does not
              authorise anything.
            </p>

            <details className="group">
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium tracking-wider uppercase">
                View the evidence ({report.rows.length} read
                {report.candidates > report.rows.length && ` of ${report.candidates}`})
              </summary>
              <div className="mt-2 max-h-72 space-y-1 overflow-y-auto">
                {report.rows.slice(0, ROW_LIMIT).map((row) => (
                  <div key={row.id} className="flex items-start gap-2 border p-2 text-xs">
                    {verdictBadge(row)}
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground truncate">{row.name}</p>
                      {row.unread ? (
                        <p className="text-muted-foreground text-[10px]">
                          {row.unread.bytes !== null &&
                            `${(row.unread.bytes / 1_048_576).toFixed(1)} MB — `}
                          {row.unread.why}
                        </p>
                      ) : row.missing.length > 0 ? (
                        <p className="text-muted-foreground font-mono text-[10px]">
                          absent: {row.missing.map((m) => `${m.kind} ${m.qualified}`).join(", ")}
                        </p>
                      ) : row.creates.length > 0 ? (
                        <p className="text-muted-foreground font-mono text-[10px]">
                          {row.creates.length} object(s) present
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
                {report.rows.length > ROW_LIMIT && (
                  <p className="text-muted-foreground p-2 text-[10px]">
                    {report.rows.length - ROW_LIMIT} more not listed.
                  </p>
                )}
              </div>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
