import { useState, useCallback, lazy, Suspense } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, FileDiff, ExternalLink, SplitSquareHorizontal, AlignJustify } from "lucide-react";
import { cn } from "@/lib/utils";
import { useServerFn } from "@tanstack/react-start";
import { fetchFileDiff } from "@/server/github-diff.functions";

const ReactDiffViewer = lazy(() => import("react-diff-viewer-continued"));

type DiffFile = {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch?: string;
  oldContent?: string;
  newContent?: string;
};

/** A commit's short form, keeping a parent suffix (`abc1234^`) so the ref still names the same commit. */
function shortRef(ref: string): string {
  const m = /^([0-9a-f]{7,40})([\^~]\d*)?$/i.exec(ref);
  return m ? `${m[1].slice(0, 7)}${m[2] ?? ""}` : ref;
}

/**
 * Rich side-by-side diff viewer for cascade results.
 * Fetches the GitHub compare diff on demand and renders with react-diff-viewer-continued.
 */
export function RichDiffViewer({
  cloneOwner,
  cloneRepo,
  baseSha,
  headSha,
  filesChanged,
  className,
}: {
  cloneOwner: string;
  cloneRepo: string;
  baseSha: string;
  headSha: string;
  filesChanged?: number;
  className?: string;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [splitView, setSplitView] = useState(true);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const fetchDiff = useServerFn(fetchFileDiff);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDiff({
        data: { owner: cloneOwner, repo: cloneRepo, base: baseSha, head: headSha },
      });
      if (!res.ok) {
        setError(res.error);
      } else {
        setFiles(res.files as DiffFile[]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load diff");
    } finally {
      setLoading(false);
    }
  }, [fetchDiff, cloneOwner, cloneRepo, baseSha, headSha]);

  const ghCompareUrl = `https://github.com/${cloneOwner}/${cloneRepo}/compare/${shortRef(baseSha)}...${shortRef(headSha)}`;

  if (!files && !loading && !error) {
    return (
      <Card className={cn("border-border/60", className)}>
        <CardContent className="flex items-center justify-between p-3">
          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <FileDiff className="h-3.5 w-3.5" />
            <span>
              {shortRef(baseSha)}…{shortRef(headSha)}
              {typeof filesChanged === "number" &&
                ` · ${filesChanged} file${filesChanged === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={ghCompareUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              GitHub <ExternalLink className="h-3 w-3" />
            </a>
            <Button size="sm" variant="outline" onClick={load} className="h-7 text-xs">
              <FileDiff className="mr-1.5 h-3 w-3" /> Load diff
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("border-border/60", className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-2 p-3 pb-2">
        <div className="flex items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileDiff className="h-3.5 w-3.5 text-primary" /> Diff
          </CardTitle>
          {files && (
            <Badge variant="outline" className="text-[10px]">
              {files.length} file{files.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={splitView ? "default" : "ghost"}
            onClick={() => setSplitView(true)}
            className="h-6 w-6 p-0"
            title="Split view"
          >
            <SplitSquareHorizontal className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant={!splitView ? "default" : "ghost"}
            onClick={() => setSplitView(false)}
            className="h-6 w-6 p-0"
            title="Unified view"
          >
            <AlignJustify className="h-3 w-3" />
          </Button>
          <a
            href={ghCompareUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-1 inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
          >
            GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {loading && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Fetching diff from GitHub…
          </div>
        )}
        {error && (
          <div className="border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs text-destructive">
            {error}
            <Button size="sm" variant="outline" onClick={load} className="ml-3 h-6 text-[10px]">
              Retry
            </Button>
          </div>
        )}
        {files && files.length === 0 && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            No file changes found.
          </div>
        )}
        {files && files.length > 0 && (
          <div className="space-y-2">
            {/* File list */}
            <div className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <button
                  key={f.filename}
                  type="button"
                  onClick={() =>
                    setExpandedFile((prev) => (prev === f.filename ? null : f.filename))
                  }
                  className={cn(
                    "rounded border px-2 py-1 font-mono text-[10px] transition-colors",
                    expandedFile === f.filename
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border bg-surface text-muted-foreground hover:border-primary/30 hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "mr-1",
                      f.status === "added" && "text-success",
                      f.status === "removed" && "text-destructive",
                      f.status === "modified" && "text-info",
                      f.status === "renamed" && "text-warning",
                    )}
                  >
                    {f.status === "added" ? "+" : f.status === "removed" ? "−" : "~"}
                  </span>
                  {f.filename.split("/").pop()}
                  <span className="ml-1.5 text-muted-foreground">
                    +{f.additions} −{f.deletions}
                  </span>
                </button>
              ))}
            </div>

            {/* Expanded diff */}
            {expandedFile &&
              (() => {
                const file = files.find((f) => f.filename === expandedFile);
                if (!file) return null;
                const oldCode = file.oldContent ?? "";
                const newCode = file.newContent ?? "";

                // If we have patch but no full content, show the patch as text
                if (!file.oldContent && !file.newContent && file.patch) {
                  return (
                    <div className="border bg-surface overflow-x-auto">
                      <div className="border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {file.filename}
                      </div>
                      <pre className="p-3 font-mono text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
                        {file.patch}
                      </pre>
                    </div>
                  );
                }

                return (
                  <div className="border overflow-hidden">
                    <div className="border-b bg-surface px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                      {file.filename}
                    </div>
                    <div className="max-h-[600px] overflow-auto text-[11px] [&_pre]:!bg-transparent [&_td]:!bg-transparent [&_table]:!bg-transparent">
                      <Suspense
                        fallback={
                          <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          </div>
                        }
                      >
                        <ReactDiffViewer
                          oldValue={oldCode}
                          newValue={newCode}
                          splitView={splitView}
                          useDarkTheme={true}
                          hideLineNumbers={false}
                          styles={{
                            variables: {
                              dark: {
                                diffViewerBackground: "transparent",
                                addedBackground: "rgba(34, 197, 94, 0.08)",
                                removedBackground: "rgba(239, 68, 68, 0.08)",
                                wordAddedBackground: "rgba(34, 197, 94, 0.2)",
                                wordRemovedBackground: "rgba(239, 68, 68, 0.2)",
                                addedGutterBackground: "rgba(34, 197, 94, 0.12)",
                                removedGutterBackground: "rgba(239, 68, 68, 0.12)",
                                gutterBackground: "transparent",
                                gutterBackgroundDark: "transparent",
                                highlightBackground: "rgba(139, 92, 246, 0.1)",
                                highlightGutterBackground: "rgba(139, 92, 246, 0.1)",
                                codeFoldGutterBackground: "transparent",
                                codeFoldBackground: "transparent",
                                emptyLineBackground: "transparent",
                                addedGutterColor: "rgb(34, 197, 94)",
                                removedGutterColor: "rgb(239, 68, 68)",
                                gutterColor: "rgb(115, 115, 115)",
                                addedColor: "rgb(200, 255, 200)",
                                removedColor: "rgb(255, 200, 200)",
                                diffViewerTitleBackground: "transparent",
                                diffViewerTitleColor: "rgb(163, 163, 163)",
                                diffViewerTitleBorderColor: "transparent",
                              },
                            },
                          }}
                        />
                      </Suspense>
                    </div>
                  </div>
                );
              })()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
