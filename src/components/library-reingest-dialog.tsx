// Wipe the module catalogue and rebuild it from a fresh detection run.
//
// This is the most destructive action in the app: `clone_modules` cascades off
// `modules`, so a careless wipe erases which modules every clone in the fleet
// has installed. The dialog therefore forces a dry run first — you cannot reach
// the destructive button without having seen what it will do.

import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { TriangleAlert, RotateCcw, Loader2, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { resetAndReingest } from "@/server/ai-detect-modules.functions";

const CONFIRMATION = "RESET LIBRARY";

type Report = Awaited<ReturnType<typeof resetAndReingest>>;

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}

export function LibraryReingestDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Report | null>(null);
  const [result, setResult] = useState<Report | null>(null);
  const [typed, setTyped] = useState("");
  const [preserveInstalls, setPreserveInstalls] = useState(true);
  const [clearHistory, setClearHistory] = useState(false);

  const run = useServerFn(resetAndReingest);

  const reset = () => {
    setPlan(null);
    setResult(null);
    setTyped("");
    setBusy(false);
  };

  const preview = async () => {
    setBusy(true);
    try {
      const r = await run({ data: { dryRun: true } });
      setPlan(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    setBusy(true);
    try {
      const r = await run({
        data: {
          confirmation: CONFIRMATION,
          preserveCloneInstalls: preserveInstalls,
          publishToLibrary: true,
          clearHistory,
        },
      });
      setResult(r);
      if (r.ok) {
        toast.success(
          `Library rebuilt — ${r.after.modulesDetected} modules, ${r.after.libraryEntriesPublished} published`,
        );
        onDone();
      } else {
        toast.error(r.error ?? "Re-ingest failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-ingest failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" />
          Reset &amp; re-ingest
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reset and re-ingest the module library</DialogTitle>
          <DialogDescription>
            Deletes every module and library entry, then rebuilds the catalogue from a fresh
            detection run against the prime repo.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <TriangleAlert className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Clone module installs cascade off the modules table. They are snapshotted and
                restored by slug, but slugs the new detection does not reproduce cannot be restored
                — expected when switching detection strategy, since new modules are named after
                product domains rather than individual routes.
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={preserveInstalls}
                  onCheckedChange={(v) => setPreserveInstalls(Boolean(v))}
                />
                Restore clone module installs by slug
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={clearHistory}
                  onCheckedChange={(v) => setClearHistory(Boolean(v))}
                />
                Also clear detection history, drift alerts and import edges
              </label>
            </div>

            {!plan ? (
              <Button onClick={preview} disabled={busy} className="w-full gap-1.5">
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ListChecks className="h-3.5 w-3.5" />
                )}
                Preview what this will do
              </Button>
            ) : !plan.ok ? (
              // A preview that could not read what it would remove and restore
              // shows why, never a column of zeros.
              <p className="text-xs text-destructive">
                {plan.error ?? "The preview could not be made."}
              </p>
            ) : (
              <>
                <div className="border border-border p-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    current state
                  </p>
                  <StatRow label="Modules" value={plan.before.modules} />
                  <StatRow label="Library entries" value={plan.before.libraryEntries} />
                  <StatRow label="Clone installs" value={plan.before.cloneInstalls} />
                  <StatRow label="Clones with modules" value={plan.before.clonesWithModules} />
                  <StatRow label="Library pins" value={plan.before.libraryPins} />
                </div>

                {plan.warnings.map((w) => (
                  <p key={w} className="text-xs text-muted-foreground">
                    {w}
                  </p>
                ))}

                <div className="space-y-1.5">
                  <label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Type <span className="text-destructive">{CONFIRMATION}</span> to confirm
                  </label>
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={CONFIRMATION}
                    className="font-mono text-xs"
                  />
                </div>
              </>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="border border-border p-3">
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                result
              </p>
              <StatRow label="Modules detected" value={result.after.modulesDetected} />
              <StatRow label="Approved" value={result.after.modulesApproved} />
              <StatRow label="Published to library" value={result.after.libraryEntriesPublished} />
              <StatRow label="Full-stack modules" value={result.after.fullstackModules} />
              <StatRow label="Backend-only modules" value={result.after.backendModules} />
              <StatRow label="Clone installs restored" value={result.restored.cloneInstalls} />
            </div>

            {result.restored.unmappedSlugs.length > 0 && (
              <div>
                <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  slugs that no longer exist · {result.restored.unmappedSlugs.length}
                </p>
                <div className="flex flex-wrap gap-1">
                  {result.restored.unmappedSlugs.slice(0, 30).map((s) => (
                    <Badge key={s} variant="outline" className="font-mono text-[9px]">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {result.warnings.map((w) => (
              <p key={w} className="text-xs text-muted-foreground">
                {w}
              </p>
            ))}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={execute}
                disabled={busy || !plan || typed !== CONFIRMATION}
                className="gap-1.5"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Wipe and re-ingest
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
