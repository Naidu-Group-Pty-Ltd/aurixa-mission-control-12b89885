import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Library, Loader2, CheckCircle2, AlertTriangle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  syncCloneReferenceData,
  getReferenceTableCatalogue,
} from "@/server/reference-data.functions";

type Catalogue = Awaited<ReturnType<typeof getReferenceTableCatalogue>>;
type SyncResult = Extract<Awaited<ReturnType<typeof syncCloneReferenceData>>, { ok: true }>;

export function ReferenceDataSyncCard() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const fetchCatalogue = useServerFn(getReferenceTableCatalogue);
  const runSync = useServerFn(syncCloneReferenceData);

  useEffect(() => {
    fetchCatalogue()
      .then(setCatalogue)
      .catch(() => {
        // The catalogue is context, not the control. A failed read must not
        // disable seeding.
      });
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await runSync({ data: {} });
      if (result.ok) {
        setLastResult(result);
        const failed = result.tables.filter((t) => t.status === "failed");
        // A run that could not start is not a fleet with nothing waiting.
        if (result.error) {
          toast.error(result.error);
        } else if (failed.length > 0) {
          toast.warning(`${failed.length} table(s) refused — see the detail below`);
        } else if (result.done) {
          toast.success(`${result.cloneName ?? "Clone"} has the full reference set`);
        } else if (result.budgetExhausted) {
          toast.info(`${result.rowsCopied} row(s) copied — resuming on the next run`);
        } else {
          toast.info("No clone is waiting for reference data");
        }
      } else {
        toast.error(result.error);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reference data sync failed");
    }
    setSyncing(false);
  };

  return (
    <Card className="glass-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Library className="h-4 w-4" /> Reference data
        </CardTitle>
        <CardDescription>
          Copies the prime's seeded catalogue — templates, suburbs, depreciation comparables — into
          a clone that has the schema and none of the rows. Runs hourly; this button is the same
          engine with a shorter budget.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={handleSync} disabled={syncing} size="sm">
          {syncing ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
          Seed a waiting clone
        </Button>

        {/*
          The allow-list is rendered from the module the copier actually reads,
          not from a description of it. An operator asking "what can travel to a
          tenant?" gets the rule itself — a page that paraphrases the rule is a
          page that goes stale without anybody noticing.
        */}
        {catalogue && (
          <div className="space-y-1 text-xs">
            <div className="text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              {catalogue.tables.length} table(s) may be copied. Everything else is tenant data.
            </div>
            <div className="flex flex-wrap gap-1">
              {catalogue.tables.map((t) => (
                <Badge key={t.table} variant="outline" className="font-mono text-[10px]">
                  {t.table}
                  {t.nulled.length > 0 && (
                    <span className="text-muted-foreground ml-1">−{t.nulled.length} id</span>
                  )}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {lastResult && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="text-[10px]">
                {lastResult.cloneName ?? "no clone claimed"}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {lastResult.rowsCopied} row(s) this run
              </Badge>
              {lastResult.done && (
                <Badge variant="outline" className="bg-success/10 text-success text-[10px]">
                  <CheckCircle2 className="mr-1 h-3 w-3" /> complete
                </Badge>
              )}
              {lastResult.budgetExhausted && (
                <Badge variant="outline" className="text-muted-foreground text-[10px]">
                  stopped on budget — resumes next run
                </Badge>
              )}
            </div>
            {lastResult.tables
              .filter((t) => t.status === "failed" || t.status === "skipped")
              .map((t) => (
                <div key={t.table} className="flex items-start justify-between border p-2 text-xs">
                  <span className="font-mono">{t.table}</span>
                  <span
                    className={
                      t.status === "failed"
                        ? "text-destructive ml-2 text-right"
                        : "text-muted-foreground ml-2 text-right"
                    }
                  >
                    {t.status === "failed" && <AlertTriangle className="mr-1 inline h-3 w-3" />}
                    {t.detail ?? t.status}
                  </span>
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
