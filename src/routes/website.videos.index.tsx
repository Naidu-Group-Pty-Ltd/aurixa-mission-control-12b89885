/**
 * Website → Videos: the Briefing Room on aurixasystems.com.au/watch.
 *
 * Every video on the website's Briefing Room is a listing here. A draft is
 * Mission Control's alone; a premiere shows on the website as a card with no
 * page; a published listing is a watchable page with its own link preview.
 * The website renders its pages at build time, so publishing — or editing a
 * live listing — asks Vercel to rebuild it (docs/WEBSITE_VIDEOS.md).
 */
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ExternalLink, Film, Plus, RefreshCw } from "lucide-react";
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
  requestWebsiteRebuildFn,
} from "@/server/website-briefings.functions";
import { STATUS_COPY, rebuildLine } from "@/components/website-video-status";
import {
  BRIEFING_SERIES,
  SLUG_PATTERN,
  briefingPageUrl,
  formatChapterTime,
  slugify,
} from "@/lib/websiteBriefings.pure";

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
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["website-briefings"], queryFn: () => listFn() });
  const [creating, setCreating] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const rows = query.data?.rows ?? [];
  const origin = query.data?.mediaOrigin ?? "";

  async function rebuild() {
    setRebuilding(true);
    try {
      const result = await rebuildFn();
      if (result.requested)
        toast.success("The website is rebuilding — live in a couple of minutes.");
      else if (result.reason === "not_configured")
        toast.error("Website rebuilds are not connected (WEBSITE_DEPLOY_HOOK_URL).");
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

      {query.isSuccess && rows.length === 0 && !query.data?.error && (
        <EmptyState
          icon={<Film />}
          title="No videos yet"
          description="Each video on the website's Briefing Room starts here as a draft."
          action={<Button onClick={() => setCreating(true)}>New video</Button>}
        />
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-border/60 border border-border/60">
          {rows.map((row) => {
            const status = STATUS_COPY[row.status] ?? STATUS_COPY.draft;
            const poster = row.media_poster ? `${origin}/${row.media_poster}` : null;
            return (
              <li key={row.id} className="flex items-center gap-4 p-3">
                <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden bg-muted/40">
                  {poster ? (
                    <img
                      src={poster}
                      alt=""
                      className="h-full w-full object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <Film className="h-5 w-5 text-muted-foreground" />
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
                  </p>
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
