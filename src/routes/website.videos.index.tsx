/**
 * Website → Videos: the Briefing Room on aurixasystems.com.au/watch.
 *
 * Every video on the website's Briefing Room is a listing here. A draft is
 * Mission Control's alone; a premiere shows on the website as a card with no
 * page; a published listing is a watchable page with its own link preview.
 * The website renders its pages at build time, so publishing — or editing a
 * live listing — asks Vercel to rebuild it (docs/WEBSITE_VIDEOS.md).
 *
 * The list is the library's order: moving a listing up or down here moves its
 * card on the website, and each live listing wears the code tag its card
 * shows there (BRF-01 …).
 */
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ExternalLink, Film, Plus, RefreshCw } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createWebsiteBriefingFn,
  listWebsiteBriefingsFn,
  reorderWebsiteBriefingsFn,
  requestWebsiteRebuildFn,
} from "@/server/website-briefings.functions";
import { STATUS_COPY, rebuildLine } from "@/components/website-video-status";
import {
  BRIEFING_SERIES,
  BRIEFING_STATUSES,
  SLUG_PATTERN,
  briefingPageUrl,
  formatChapterTime,
  premiereProblems,
  publishProblems,
  slugify,
  type BriefingStatus,
} from "@/lib/websiteBriefings.pure";

const FILTERS: Array<{ value: "all" | BriefingStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "published", label: "Live" },
  { value: "premiere", label: "Premiering" },
  { value: "draft", label: "Drafts" },
  { value: "archived", label: "Archived" },
];

export const Route = createFileRoute("/website/videos/")({
  component: () => (
    <ProtectedRoute>
      <WebsiteVideosPage />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Website videos — Mission Control" }] }),
});

function WebsiteVideosPage() {
  const listFn = useServerFn(listWebsiteBriefingsFn);
  const rebuildFn = useServerFn(requestWebsiteRebuildFn);
  const reorderFn = useServerFn(reorderWebsiteBriefingsFn);
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["website-briefings"], queryFn: () => listFn() });
  const [creating, setCreating] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [moving, setMoving] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["value"]>("all");

  const rows = query.data?.rows ?? [];
  const origin = query.data?.mediaOrigin ?? "";
  const codes: Record<string, string> = query.data?.codes ?? {};
  const counts = Object.fromEntries(
    BRIEFING_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]),
  ) as Record<BriefingStatus, number>;
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  /** Move one listing up or down the library, and save the whole order. */
  async function move(index: number, by: -1 | 1) {
    const order = rows.map((r) => r.id);
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setMoving(true);
    try {
      const result = await reorderFn({ data: { order } });
      if (!result.ok) {
        toast.error(result.error);
      } else if (result.rebuild?.requested) {
        toast.success("Reordered. The website is rebuilding with the new order.");
      } else if (result.rebuild && result.rebuild.reason === "not_configured") {
        toast.success("Reordered. It reaches the website on its next deploy.");
      } else if (result.rebuild && result.rebuild.reason === "failed") {
        toast.warning(
          `Reordered, but the rebuild request failed (${result.rebuild.detail ?? "unknown"}) — use Rebuild website.`,
        );
      }
      await qc.invalidateQueries({ queryKey: ["website-briefings"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reorder");
    } finally {
      setMoving(false);
    }
  }

  async function rebuild() {
    setRebuilding(true);
    try {
      const result = await rebuildFn();
      if (result.requested)
        toast.success("The website is rebuilding — live in a couple of minutes.");
      else if (result.reason === "not_configured")
        toast.error("Website rebuilds are not connected (WEBSITE_DEPLOY_HOOK_URL).");
      else if (result.reason === "unconfirmed")
        toast.info(
          "Sent to Vercel, which had not answered yet. The build usually starts anyway: the line under the heading shows when it reads the listings.",
        );
      else toast.error(`The rebuild request failed: ${result.detail ?? "unknown error"}`);
      await qc.invalidateQueries({ queryKey: ["website-briefings"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The rebuild request failed");
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="website"
        title="Website videos"
        description="The Briefing Room at aurixasystems.com.au/watch: Aurixa's own channel for its explainer and marketing videos. Write a listing, upload its encoded video, and publish it as a page of its own on the website."
        actions={
          <>
            <Button variant="outline" onClick={rebuild} disabled={rebuilding}>
              <RefreshCw className="mr-2 h-4 w-4" /> Rebuild website
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-2 h-4 w-4" /> New video
            </Button>
          </>
        }
      />

      {query.data && (
        <p className="text-xs text-muted-foreground">{rebuildLine(query.data.rebuild)}</p>
      )}

      {query.data?.error === "schema_pending" && (
        <p className="text-sm text-warning">
          Website videos are not in the database yet — the migration that adds them has not applied.
        </p>
      )}
      {query.data?.error && query.data.error !== "schema_pending" && (
        <p className="text-sm text-destructive">The videos could not be read: {query.data.error}</p>
      )}

      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? "secondary" : "ghost"}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
              <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                {f.value === "all" ? rows.length : counts[f.value]}
              </span>
            </Button>
          ))}
        </div>
      )}

      {query.isSuccess && rows.length === 0 && !query.data?.error && (
        <EmptyState
          icon={<Film />}
          title="No videos yet"
          description="Each video on the website's Briefing Room starts here as a draft."
          action={<Button onClick={() => setCreating(true)}>New video</Button>}
        />
      )}

      {rows.length > 0 && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No {FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} videos.
        </p>
      )}

      {shown.length > 0 && (
        <ul className="divide-y divide-border/60 border border-border/60">
          {shown.map((row) => {
            const status = STATUS_COPY[row.status] ?? STATUS_COPY.draft;
            const thumbnail = row.media_thumbnail ? `${origin}/${row.media_thumbnail}` : null;
            const poster = row.media_poster ? `${origin}/${row.media_poster}` : null;
            const index = rows.indexOf(row);
            const toFix = row.status === "archived" ? 0 : publishProblems(row).length;
            const premiereReady = row.status === "draft" && premiereProblems(row).length === 0;
            return (
              <li key={row.id} className="flex items-center gap-4 p-3">
                {filter === "all" && (
                  <div className="flex shrink-0 flex-col">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={`Move ${row.title} up`}
                      disabled={moving || index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={`Move ${row.title} down`}
                      disabled={moving || index === rows.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </div>
                )}
                <div className="relative flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden bg-muted/40">
                  {thumbnail ? (
                    <img
                      src={thumbnail}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : poster ? (
                    <img
                      src={poster}
                      alt=""
                      className="h-full w-full object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <Film className="h-5 w-5 text-muted-foreground" />
                  )}
                  {codes[row.slug] && (
                    <span className="absolute left-1 top-1 bg-black/70 px-1 font-mono text-[9px] font-bold tracking-wider text-white">
                      {codes[row.slug]}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/website/videos/$briefingId"
                      params={{ briefingId: row.id }}
                      className="truncate font-medium hover:underline"
                    >
                      {row.title}
                    </Link>
                    <Badge variant={status.tone}>{status.label}</Badge>
                  </div>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    /watch/{row.slug} ·{" "}
                    {BRIEFING_SERIES.find((s) => s.value === row.series)?.label ?? row.series}
                    {row.duration_seconds ? ` · ${formatChapterTime(row.duration_seconds)}` : ""}
                    {row.published_on ? ` · published ${row.published_on}` : ""}
                    {row.media_version ? ` · media ${row.media_version}` : " · no media yet"}
                    {row.media_thumbnail ? " · thumbnail" : ""}
                  </p>
                  {toFix > 0 && (
                    <p
                      className={
                        row.status === "published"
                          ? "text-[11px] text-destructive"
                          : "text-[11px] text-muted-foreground"
                      }
                    >
                      {row.status === "published"
                        ? `Breaks ${toFix === 1 ? "a website rule" : `${toFix} website rules`}: the website's build leaves it out. Open it to see why.`
                        : `${toFix} ${toFix === 1 ? "thing" : "things"} before it can be published${premiereReady ? "; ready to show as a premiere" : ""}`}
                    </p>
                  )}
                </div>
                {row.status === "published" && (
                  <a
                    href={briefingPageUrl(row.slug)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    View <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <Button asChild variant="outline" size="sm">
                  <Link to="/website/videos/$briefingId" params={{ briefingId: row.id }}>
                    Edit
                  </Link>
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <NewVideoDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewVideoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createFn = useServerFn(createWebsiteBriefingFn);
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugTouched ? slug : slugify(title);
  const valid =
    title.trim().length > 0 && SLUG_PATTERN.test(effectiveSlug) && effectiveSlug.length <= 60;

  async function create() {
    setBusy(true);
    try {
      const result = await createFn({ data: { title: title.trim(), slug: effectiveSlug } });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onOpenChange(false);
      setTitle("");
      setSlug("");
      setSlugTouched(false);
      await navigate({ to: "/website/videos/$briefingId", params: { briefingId: result.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the video");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New video</DialogTitle>
          <DialogDescription>
            It starts as a draft, which only Mission Control can see. The slug is its address on the
            website, and is fixed once its video has been uploaded.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-video-title">Title</Label>
            <Input id="new-video-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-video-slug">Address</Label>
            <div className="flex items-center gap-1 font-mono text-sm">
              <span className="text-muted-foreground">/watch/</span>
              <Input
                id="new-video-slug"
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            </div>
            {effectiveSlug && !SLUG_PATTERN.test(effectiveSlug) && (
              <p className="text-xs text-destructive">
                Lowercase letters, digits and single hyphens.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!valid || busy}>
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
