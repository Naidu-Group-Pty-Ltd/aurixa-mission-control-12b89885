import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  getCloneLibraryPins,
  setCloneLibraryPin,
  removeCloneLibraryPin,
  validateClonePins,
} from "@/server/library-admin.functions";
import { getModuleLibrary } from "@/server/ai-detect-modules.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BookOpen, Loader2, Pin, X, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { primeCommitLabel } from "@/lib/libraryCommit.pure";

type LibraryEntry = {
  id: string;
  slug: string;
  name: string;
  version: number;
  description: string | null;
  approval_status: string;
  is_latest: boolean;
  /** The prime commit the entry was approved at (D19). */
  source_commit_sha: string | null;
};

type PinRow = {
  id: string;
  clone_id: string;
  library_entry_id: string;
  slug: string;
  version: number;
  pinned_at: string;
  notes: string | null;
};

export function CloneLibraryPinsCard({ cloneId }: { cloneId: string }) {
  const [pins, setPins] = useState<PinRow[]>([]);
  const [allEntries, setAllEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [issuesBySlug, setIssuesBySlug] = useState<Map<string, string>>(new Map());

  const getPinsFn = useServerFn(getCloneLibraryPins);
  const getLibraryFn = useServerFn(getModuleLibrary);
  const setPinFn = useServerFn(setCloneLibraryPin);
  const removePinFn = useServerFn(removeCloneLibraryPin);
  const validateFn = useServerFn(validateClonePins);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [pinsRes, libRes] = await Promise.all([
      getPinsFn({ data: { cloneId } }),
      // Fetch ALL versions, not latestOnly, so users can pin any version
      getLibraryFn({ data: { latestOnly: false } }),
    ]);
    if (pinsRes.ok) setPins(pinsRes.pins as PinRow[]);
    if (libRes.ok) setAllEntries(libRes.entries as LibraryEntry[]);
    setLoading(false);
  }, [cloneId, getPinsFn, getLibraryFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Group entries by slug, only approved
  const approvedBySlug = new Map<string, LibraryEntry[]>();
  for (const e of allEntries) {
    if (e.approval_status !== "approved") continue;
    if (!approvedBySlug.has(e.slug)) approvedBySlug.set(e.slug, []);
    approvedBySlug.get(e.slug)!.push(e);
  }
  // Sort each slug's versions descending
  for (const list of approvedBySlug.values()) {
    list.sort((a, b) => b.version - a.version);
  }

  const pinSlugs = new Set(pins.map((p) => p.slug));
  const unpinnedSlugs = Array.from(approvedBySlug.keys()).filter((s) => !pinSlugs.has(s));

  const handleSet = async (libraryEntryId: string) => {
    setBusy(libraryEntryId);
    try {
      const res = await setPinFn({ data: { cloneId, libraryEntryId } });
      if (res.ok) {
        toast.success("Pinned");
        await refresh();
      } else {
        toast.error(res.error ?? "Pin failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (slug: string) => {
    setBusy(slug);
    try {
      const res = await removePinFn({ data: { cloneId, slug } });
      if (res.ok) {
        toast.success("Unpinned");
        await refresh();
      } else {
        toast.error(res.error ?? "Remove failed");
      }
    } finally {
      setBusy(null);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await validateFn({ data: { cloneIds: [cloneId] } });
      const next = new Map<string, string>();
      if (res.ok) {
        for (const i of res.issues as Array<{ slug: string; reason: string }>) {
          next.set(i.slug, i.reason);
        }
        setIssuesBySlug(next);
        if (next.size === 0) toast.success(`All ${res.checked ?? 0} pin(s) healthy`);
        else toast.warning(`${next.size} pin issue(s)`);
      } else {
        toast.error(res.error ?? "Validation failed");
      }
    } finally {
      setValidating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4 text-primary" /> Library version pins
            </CardTitle>
            <CardDescription className="text-xs">
              Choose which approved library version this clone should install per module slug. Only
              admin-approved versions are selectable.
            </CardDescription>
          </div>
          {pins.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-[10px]"
              onClick={handleValidate}
              disabled={validating}
            >
              {validating ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <ShieldCheck className="mr-1 h-3 w-3" />
              )}
              validate
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Pinned versions */}
            <div className="space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                pinned ({pins.length})
              </div>
              {pins.length === 0 ? (
                <div className="border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No version pins yet — pick one from the list below.
                </div>
              ) : (
                pins.map((p) => {
                  const versions = approvedBySlug.get(p.slug) ?? [];
                  const isStale = versions.length > 0 && versions[0].version > p.version;
                  const issue = issuesBySlug.get(p.slug);
                  // Only an entry that was read can say it records no commit.
                  const pinned = allEntries.find((e) => e.id === p.library_entry_id);
                  return (
                    <div
                      key={p.id}
                      className={`rounded-md border bg-surface px-3 py-2 ${issue ? "border-destructive/50" : "border-border"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Pin className="h-3 w-3 shrink-0 text-primary" />
                          <code className="font-mono text-sm truncate">{p.slug}</code>
                          <Badge variant="outline" className="font-mono text-[10px]">
                            v{p.version}
                          </Badge>
                          {pinned && (
                            <code className="font-mono text-[10px] text-muted-foreground">
                              {primeCommitLabel(pinned.source_commit_sha) ?? "no commit recorded"}
                            </code>
                          )}
                          {isStale && (
                            <Badge
                              variant="outline"
                              className="font-mono text-[9px] border-warning/40 text-warning"
                            >
                              <AlertCircle className="mr-1 h-2.5 w-2.5" /> v{versions[0].version}{" "}
                              available
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {versions.length > 1 && (
                            <Select
                              value={String(p.library_entry_id)}
                              onValueChange={(v) => handleSet(v)}
                              disabled={busy === p.slug}
                            >
                              <SelectTrigger className="h-7 w-44 font-mono text-[10px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {versions.map((v) => (
                                  <SelectItem key={v.id} value={v.id} className="font-mono text-xs">
                                    v{v.version} ·{" "}
                                    {primeCommitLabel(v.source_commit_sha) ?? "no commit"}{" "}
                                    {v.is_latest && "(latest)"}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemove(p.slug)}
                            disabled={busy === p.slug}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {issue && (
                        <div className="mt-1.5 flex items-start gap-1 text-[10px] text-destructive">
                          <AlertCircle className="mt-0.5 h-2.5 w-2.5 shrink-0" />
                          <span>{issue}</span>
                        </div>
                      )}
                      {p.notes && (
                        <div className="mt-1 text-[10px] text-muted-foreground italic truncate">
                          “{p.notes}”
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Available to pin */}
            {unpinnedSlugs.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  available ({unpinnedSlugs.length})
                </div>
                {unpinnedSlugs.map((slug) => {
                  const versions = approvedBySlug.get(slug) ?? [];
                  const latest = versions[0];
                  if (!latest) return null;
                  return (
                    <div
                      key={slug}
                      className="flex items-center justify-between gap-2 border border-border px-3 py-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <code className="font-mono text-sm truncate">{slug}</code>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {latest.name}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {versions.length > 1 ? (
                          <Select onValueChange={(v) => handleSet(v)} disabled={busy === slug}>
                            <SelectTrigger className="h-7 w-44 font-mono text-[10px]">
                              <SelectValue placeholder="pick version" />
                            </SelectTrigger>
                            <SelectContent>
                              {versions.map((v) => (
                                <SelectItem key={v.id} value={v.id} className="font-mono text-xs">
                                  v{v.version} ·{" "}
                                  {primeCommitLabel(v.source_commit_sha) ?? "no commit"}{" "}
                                  {v.is_latest && "(latest)"}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 font-mono text-[10px]"
                            onClick={() => handleSet(latest.id)}
                            disabled={busy === slug}
                          >
                            {busy === slug ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <Pin className="mr-1 h-3 w-3" /> pin v{latest.version}
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {approvedBySlug.size === 0 && (
              <div className="border border-dashed p-4 text-center text-xs text-muted-foreground">
                <CheckCircle2 className="mx-auto mb-1 h-4 w-4" />
                No approved library entries available yet. An admin publishes modules first, which
                approves each entry at the prime commit its module was detected at.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
