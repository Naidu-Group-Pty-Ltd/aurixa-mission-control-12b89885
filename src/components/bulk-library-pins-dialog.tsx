import { useEffect, useMemo, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { bulkApplyClonePins, validateClonePins } from "@/server/library-admin.functions";
import { getModuleLibrary } from "@/server/ai-detect-modules.functions";
import { Loader2, Pin, AlertTriangle, CheckCircle2, Layers } from "lucide-react";
import { toast } from "sonner";
import type { Clone } from "@/lib/queries";
import { primeCommitLabel } from "@/lib/libraryCommit.pure";

type LibraryEntry = {
  id: string;
  slug: string;
  name: string;
  version: number;
  approval_status: string;
  is_latest: boolean;
  /** The prime commit the entry was approved at (D19). */
  source_commit_sha: string | null;
};

type Issue = {
  cloneId: string;
  slug: string;
  version: number;
  severity: "error" | "warning";
  reason: string;
};

export function BulkLibraryPinsDialog({
  clones,
  defaultSelected,
  trigger,
}: {
  clones: Clone[];
  defaultSelected?: string[];
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);

  const [selectedClones, setSelectedClones] = useState<Set<string>>(
    () => new Set(defaultSelected ?? []),
  );
  // slug -> chosen library_entry_id (or empty = skip)
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");

  const getLibraryFn = useServerFn(getModuleLibrary);
  const bulkApplyFn = useServerFn(bulkApplyClonePins);
  const validateFn = useServerFn(validateClonePins);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void getLibraryFn({ data: { latestOnly: false } })
      .then((res) => {
        if (res.ok) setEntries(res.entries as LibraryEntry[]);
      })
      .finally(() => setLoading(false));
  }, [open, getLibraryFn]);

  // Approved entries grouped by slug, versions descending
  const bySlug = useMemo(() => {
    const map = new Map<string, LibraryEntry[]>();
    for (const e of entries) {
      if (e.approval_status !== "approved") continue;
      if (!map.has(e.slug)) map.set(e.slug, []);
      map.get(e.slug)!.push(e);
    }
    for (const list of map.values()) list.sort((a, b) => b.version - a.version);
    return map;
  }, [entries]);

  const slugs = useMemo(() => {
    const all = Array.from(bySlug.keys()).sort();
    if (!filter.trim()) return all;
    const f = filter.toLowerCase();
    return all.filter((s) => s.toLowerCase().includes(f));
  }, [bySlug, filter]);

  const toggleClone = (id: string) => {
    setSelectedClones((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setIssues(null);
  };

  const setPick = (slug: string, value: string) => {
    setPicks((p) => ({ ...p, [slug]: value }));
    setIssues(null);
  };

  const activePicks = useMemo(
    () =>
      Object.entries(picks)
        .filter(([, v]) => Boolean(v))
        .map(([slug, libraryEntryId]) => ({ slug, libraryEntryId })),
    [picks],
  );

  const handleValidate = async () => {
    if (selectedClones.size === 0) return toast.error("Select at least one clone");
    setValidating(true);
    try {
      const res = await validateFn({ data: { cloneIds: Array.from(selectedClones) } });
      if (!res.ok) {
        toast.error(res.error ?? "Validation failed");
        setIssues([]);
      } else {
        setIssues(res.issues as Issue[]);
        if ((res.issues as Issue[]).length === 0) {
          toast.success(`All ${res.checked} existing pins are healthy`);
        } else {
          toast.warning(`${(res.issues as Issue[]).length} issue(s) across selected clones`);
        }
      }
    } finally {
      setValidating(false);
    }
  };

  const handleApply = async () => {
    if (selectedClones.size === 0) return toast.error("Select at least one clone");
    if (activePicks.length === 0) return toast.error("Pick at least one library version");
    setSubmitting(true);
    try {
      const res = await bulkApplyFn({
        data: {
          cloneIds: Array.from(selectedClones),
          pins: activePicks,
        },
      });
      if (!res.ok) {
        toast.error(res.error ?? "Bulk apply failed");
        return;
      }
      const total = res.results.reduce((s, r) => s + r.applied, 0);
      const skipped = res.results.reduce((s, r) => s + r.skipped.length, 0);
      const errors = res.results.filter((r) => r.error).length;
      if (errors > 0) {
        toast.error(`Applied ${total} · ${errors} clones errored · ${skipped} skipped`);
      } else if (skipped > 0) {
        toast.warning(`Applied ${total} pins · ${skipped} entries skipped`);
      } else {
        toast.success(`Applied ${total} pins across ${selectedClones.size} clone(s)`);
      }
      setOpen(false);
      setPicks({});
    } finally {
      setSubmitting(false);
    }
  };

  const issuesByClone = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const i of issues ?? []) {
      const list = map.get(i.cloneId) ?? [];
      list.push(i);
      map.set(i.cloneId, list);
    }
    return map;
  }, [issues]);

  const cloneNameFor = (id: string) => clones.find((c) => c.id === id)?.name ?? id.slice(0, 6);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className="gap-2">
            <Layers className="h-3.5 w-3.5" /> Bulk pin versions
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pin className="h-4 w-4 text-primary" /> Bulk apply library version pins
          </DialogTitle>
          <DialogDescription>
            Pin the same approved library versions across multiple clones in one shot. Only
            admin-approved entries are listed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Clones */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                clones ({selectedClones.size}/{clones.length})
              </div>
              <button
                type="button"
                className="text-[10px] text-primary hover:underline"
                onClick={() =>
                  setSelectedClones(
                    selectedClones.size === clones.length
                      ? new Set()
                      : new Set(clones.map((c) => c.id)),
                  )
                }
              >
                {selectedClones.size === clones.length ? "clear" : "select all"}
              </button>
            </div>
            <ScrollArea className="h-64 border border-border p-2">
              <div className="space-y-1">
                {clones.map((c) => {
                  const cloneIssues = issuesByClone.get(c.id) ?? [];
                  const checked = selectedClones.has(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-xs hover:bg-surface"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleClone(c.id)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{c.name}</span>
                          <code className="truncate font-mono text-[10px] text-muted-foreground">
                            {c.slug}
                          </code>
                        </div>
                        {cloneIssues.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {cloneIssues.slice(0, 3).map((i, idx) => (
                              <div
                                key={idx}
                                className="flex items-start gap-1 text-[10px] text-warning"
                              >
                                <AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                                <span>
                                  {i.slug}@v{i.version}: {i.reason}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </ScrollArea>
          </div>

          {/* Pin picks */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                versions to pin ({activePicks.length})
              </div>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter slugs"
                className="h-6 w-32 font-mono text-[10px]"
              />
            </div>
            <ScrollArea className="h-64 border border-border p-2">
              {loading ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : slugs.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  <CheckCircle2 className="mx-auto mb-1 h-4 w-4" />
                  No approved entries match.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {slugs.map((slug) => {
                    const versions = bySlug.get(slug) ?? [];
                    const value = picks[slug] ?? "";
                    return (
                      <div key={slug} className="flex items-center gap-2 px-1.5 py-1">
                        <code className="min-w-0 flex-1 truncate font-mono text-xs">{slug}</code>
                        <Select
                          value={value}
                          onValueChange={(v) => setPick(slug, v === "_skip" ? "" : v)}
                        >
                          <SelectTrigger className="h-7 w-44 font-mono text-[10px]">
                            <SelectValue placeholder="skip" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem
                              value="_skip"
                              className="font-mono text-xs text-muted-foreground"
                            >
                              skip
                            </SelectItem>
                            {versions.map((v) => (
                              <SelectItem key={v.id} value={v.id} className="font-mono text-xs">
                                v{v.version} ·{" "}
                                {primeCommitLabel(v.source_commit_sha) ?? "no commit"}
                                {v.is_latest && " (latest)"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>

        {issues && issues.length > 0 && (
          <div className="border border-warning/40 bg-warning/5 p-2 text-[11px] text-warning">
            <div className="mb-1 font-medium">{issues.length} issue(s) detected:</div>
            <div className="space-y-0.5">
              {issues.slice(0, 6).map((i, idx) => (
                <div key={idx}>
                  <Badge
                    variant="outline"
                    className="mr-1 font-mono text-[9px] border-warning/40 text-warning"
                  >
                    {cloneNameFor(i.cloneId)}
                  </Badge>
                  {i.slug}@v{i.version}: {i.reason}
                </div>
              ))}
              {issues.length > 6 && <div>…and {issues.length - 6} more</div>}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={validating || selectedClones.size === 0}
          >
            {validating ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
            )}
            Validate existing pins
          </Button>
          <Button
            size="sm"
            onClick={handleApply}
            disabled={submitting || selectedClones.size === 0 || activePicks.length === 0}
          >
            {submitting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Pin className="mr-1 h-3.5 w-3.5" />
            )}
            Apply {activePicks.length} pin{activePicks.length === 1 ? "" : "s"} ×{" "}
            {selectedClones.size} clone{selectedClones.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
