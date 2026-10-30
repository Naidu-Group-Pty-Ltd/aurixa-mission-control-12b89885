/**
 * Website → Videos → one video: its copy, chapters, transcript, video and
 * pictures, and the acts that put it on the website or take it off.
 *
 * The problems listed beside Publish are computed from the form as Save would
 * write it, by the same rules the server refuses on (`websiteBriefings.pure`),
 * which are the website build's own rules restated. A status change acts on
 * the saved listing, so unsaved edits are saved first or not at all.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowDownUp, ArrowLeft, ExternalLink, Plus, Timer, Trash2 } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WebsiteVideoMediaPanel } from "@/components/website-video-media-panel";
import { WebsiteVideoPicturesPanel } from "@/components/website-video-pictures-panel";
import { STATUS_COPY } from "@/components/website-video-status";
import {
  deleteDraftWebsiteBriefingFn,
  getWebsiteBriefingFn,
  saveWebsiteBriefingFn,
  setWebsiteBriefingStatusFn,
} from "@/server/website-briefings.functions";
import {
  BRIEFING_SERIES,
  WEBSITE_ARTWORK,
  WEBSITE_EXPLORE_TARGETS,
  briefingPageUrl,
  formatChapterTime,
  hasMedia,
  premiereProblems,
  publishProblems,
  type BriefingStatus,
} from "@/lib/websiteBriefings.pure";
import {
  chaptersInOrder,
  exploreLabelFor,
  factsFromForm,
  formFromRow,
  formsEqual,
  payloadFromForm,
  type BriefingForm,
} from "@/lib/websiteBriefingForm";

export const Route = createFileRoute("/website/videos/$briefingId")({
  component: () => (
    <ProtectedRoute>
      <WebsiteVideoEditor />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Website video — Mission Control" }] }),
});

type Rebuild = { requested: boolean; reason?: string; detail?: string } | null;

function rebuildToast(rebuild: Rebuild, done: string) {
  if (!rebuild) return toast.success(done);
  if (rebuild.requested)
    return toast.success(`${done} The website is rebuilding — live in a couple of minutes.`);
  if (rebuild.reason === "not_configured") {
    return toast.success(
      `${done} Website rebuilds are not connected, so it appears on the website's next deploy.`,
    );
  }
  if (rebuild.reason === "unconfirmed") {
    return toast.success(
      `${done} The rebuild was sent; Vercel had not answered yet. The list shows when the build reads the listings.`,
    );
  }
  return toast.warning(
    `${done} The website rebuild request failed (${rebuild.detail ?? "unknown"}) — use Rebuild website on the list.`,
  );
}

function Counter({ value, min, max }: { value: string; min?: number; max: number }) {
  const n = value.trim().length;
  const bad = n > max || (min !== undefined && n < min);
  return (
    <span className={bad ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
      {n}
      {min !== undefined ? ` (${min}–${max})` : ` / ${max}`}
    </span>
  );
}

function WebsiteVideoEditor() {
  const { briefingId } = Route.useParams();
  const getFn = useServerFn(getWebsiteBriefingFn);
  const saveFn = useServerFn(saveWebsiteBriefingFn);
  const statusFn = useServerFn(setWebsiteBriefingStatusFn);
  const deleteFn = useServerFn(deleteDraftWebsiteBriefingFn);
  const confirm = useConfirm();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["website-briefing", briefingId],
    queryFn: () => getFn({ data: { id: briefingId } }),
  });
  const row = query.data?.row ?? null;

  // Seeded from a cached row on the first render, so returning to a video
  // shows it at once; the effect below keeps both in step with every refetch.
  const [form, setForm] = useState<BriefingForm | null>(() => (row ? formFromRow(row) : null));
  const [saved, setSaved] = useState<BriefingForm | null>(() => (row ? formFromRow(row) : null));
  const [busy, setBusy] = useState(false);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [playhead, setPlayhead] = useState<number | null>(null);

  // A refetch (the page refetches when the window regains focus) replaces the
  // form only while it holds no unsaved edits, so switching tabs never loses
  // an operator's work. After this editor's own save, upload or status
  // change, the form takes the stored row as it is, normalised values and all.
  const savedRef = useRef(saved);
  const adoptNextRow = useRef(false);
  useEffect(() => {
    if (!row) return;
    const fresh = formFromRow(row);
    const adopt = adoptNextRow.current;
    adoptNextRow.current = false;
    setForm((current) =>
      adopt || !current || !savedRef.current || formsEqual(current, savedRef.current)
        ? fresh
        : current,
    );
    savedRef.current = fresh;
    setSaved(fresh);
  }, [row]);

  const dirty = form && saved ? !formsEqual(form, saved) : false;

  // Leaving the page (a reload, a closed tab) with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const built = form ? payloadFromForm(form) : null;
  const facts = useMemo(() => (row && form ? factsFromForm(row, form) : null), [row, form]);
  const toPublish = facts ? publishProblems(facts) : [];
  const toPremiere = facts ? premiereProblems(facts) : [];

  const refresh = async () => {
    adoptNextRow.current = true;
    await qc.invalidateQueries({ queryKey: ["website-briefing", briefingId] });
    await qc.invalidateQueries({ queryKey: ["website-briefings"] });
  };

  if (query.isLoading || !form || !row) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">
          {query.isLoading
            ? "Loading…"
            : query.error
              ? (query.error as Error).message
              : "That video no longer exists."}
        </p>
      </div>
    );
  }

  const set = <K extends keyof BriefingForm>(key: K, value: BriefingForm[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  async function save(): Promise<boolean> {
    if (!built?.ok) {
      toast.error(built ? built.errors.join(" ") : "Nothing to save");
      return false;
    }
    setBusy(true);
    setServerProblems([]);
    try {
      const result = await saveFn({ data: { id: briefingId, ...built.payload } });
      if (!result.ok) {
        setServerProblems([result.error, ...result.problems]);
        toast.error(result.error);
        return false;
      }
      rebuildToast(result.rebuild as Rebuild, "Saved.");
      await refresh();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function move(status: BriefingStatus) {
    const copy: Record<
      BriefingStatus,
      { title: string; description: string; confirmText: string; destructive?: boolean }
    > = {
      published: {
        title: `Publish "${row!.title}"?`,
        description: `It becomes a page at /watch/${row!.slug}, with its own link preview, and joins the website's library and sitemap.`,
        confirmText: "Publish",
      },
      premiere: {
        title: "Show it as a premiere?",
        description:
          "The website's library shows a card for it marked Premiering, with no page or video yet.",
        confirmText: "Show as premiere",
      },
      draft: {
        title: "Take it off the website?",
        description:
          "It returns to a draft that only Mission Control can see. Its page and card come down on the next rebuild.",
        confirmText: "Return to draft",
        destructive: row!.status === "published",
      },
      archived: {
        title: "Archive it?",
        description:
          "It leaves the website, if it is there, and moves to the archive. It can be restored as a draft.",
        confirmText: "Archive",
        destructive: true,
      },
    };
    if (!(await confirm(copy[status]))) return;
    if (dirty && !(await save())) return;
    setBusy(true);
    setServerProblems([]);
    try {
      const result = await statusFn({ data: { id: briefingId, status } });
      if (!result.ok) {
        setServerProblems([result.error, ...result.problems]);
        toast.error(result.error);
        return;
      }
      rebuildToast(
        result.rebuild as Rebuild,
        `Now ${STATUS_COPY[result.status]?.label ?? result.status}.`,
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the status");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Delete this draft?",
      description: "It has never been on the website and has no media; it is removed for good.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const result = await deleteFn({ data: { id: briefingId } });
    if (!result.ok) return void toast.error(result.error);
    toast.success("Draft deleted");
    await qc.invalidateQueries({ queryKey: ["website-briefings"] });
    await navigate({ to: "/website/videos" });
  }

  const status = row.status as BriefingStatus;
  const statusCopy = STATUS_COPY[status] ?? STATUS_COPY.draft;
  const slugLocked = hasMedia(row);
  const shapeLocked = Boolean(row.media_version);

  /** A chapter at the player's position, placed in time order. */
  const addChapterAtPlayhead = () => {
    if (playhead === null || !form) return;
    const chapters = [...form.chapters, { time: formatChapterTime(playhead), label: "" }];
    set("chapters", chaptersInOrder(chapters));
  };

  return (
    <div className="space-y-6 pb-16">
      <BackLink />
      <PageHeader
        eyebrow="website video"
        title={row.title}
        description={`/watch/${row.slug}`}
        actions={
          <>
            <Badge variant={statusCopy.tone}>{statusCopy.label}</Badge>
            {status === "published" && (
              <Button asChild variant="ghost" size="sm">
                <a href={briefingPageUrl(row.slug)} target="_blank" rel="noreferrer">
                  View on the website <ExternalLink className="ml-1 h-3 w-3" />
                </a>
              </Button>
            )}
            <Button onClick={save} disabled={!dirty || busy}>
              {dirty ? "Save changes" : "Saved"}
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On the website</CardTitle>
          <CardDescription>
            {status === "published"
              ? "Live: a page of its own, in the library and the sitemap."
              : status === "premiere"
                ? "A card in the library marked Premiering, with no page yet."
                : status === "archived"
                  ? "Archived: not on the website."
                  : "A draft: only Mission Control can see it."}
            {dirty ? " You have unsaved changes; acting below saves them first." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {status !== "published" && status !== "archived" && (
              <Button onClick={() => move("published")} disabled={busy || toPublish.length > 0}>
                Publish
              </Button>
            )}
            {status === "draft" && (
              <Button
                variant="outline"
                onClick={() => move("premiere")}
                disabled={busy || toPremiere.length > 0}
              >
                Show as premiere
              </Button>
            )}
            {(status === "published" || status === "premiere" || status === "archived") && (
              <Button variant="outline" onClick={() => move("draft")} disabled={busy}>
                {status === "archived" ? "Restore as draft" : "Return to draft"}
              </Button>
            )}
            {status !== "archived" && (
              <Button variant="ghost" onClick={() => move("archived")} disabled={busy}>
                Archive
              </Button>
            )}
            {status === "draft" && !row.media_version && (
              <Button variant="ghost" onClick={remove} disabled={busy}>
                <Trash2 className="mr-1 h-4 w-4" /> Delete draft
              </Button>
            )}
          </div>
          {status !== "published" && status !== "archived" && toPublish.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">Before it can be published:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {toPublish.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {status === "published" && toPublish.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
              {toPublish.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {serverProblems.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
              {serverProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Listing</CardTitle>
          <CardDescription>
            What the library card and the video's page say. The summary is also the page's search
            and link-preview description. Describe what the video shows, and claim nothing the page
            it links to does not also say.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="v-title">Title</Label>
              <Input
                id="v-title"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-slug">Address</Label>
              <div className="flex items-center gap-1 font-mono text-sm">
                <span className="text-muted-foreground">/watch/</span>
                <Input
                  id="v-slug"
                  value={form.slug}
                  disabled={slugLocked}
                  onChange={(e) => set("slug", e.target.value.toLowerCase())}
                />
              </div>
              {slugLocked && (
                <p className="text-xs text-muted-foreground">
                  Fixed: its media folder is named after it.
                </p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="v-kicker">Kicker — one line under the title</Label>
              <Counter value={form.kicker} max={120} />
            </div>
            <Input
              id="v-kicker"
              value={form.kicker}
              onChange={(e) => set("kicker", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="v-summary">Summary</Label>
              <Counter value={form.summary} min={70} max={320} />
            </div>
            <Textarea
              id="v-summary"
              rows={3}
              value={form.summary}
              onChange={(e) => set("summary", e.target.value)}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Series</Label>
              <Select value={form.series} onValueChange={(v) => set("series", v)}>
                <SelectTrigger aria-label="Series">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BRIEFING_SERIES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Sends viewers on to</Label>
              <Select
                value={form.exploreTo}
                onValueChange={(v) =>
                  setForm((f) =>
                    f
                      ? {
                          ...f,
                          exploreTo: v,
                          // A label still at the old page's suggestion follows the page.
                          exploreLabel:
                            f.exploreLabel === exploreLabelFor(f.exploreTo) ||
                            !f.exploreLabel.trim()
                              ? exploreLabelFor(v)
                              : f.exploreLabel,
                        }
                      : f,
                  )
                }
              >
                <SelectTrigger aria-label="Explore page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEBSITE_EXPLORE_TARGETS.map((t) => (
                    <SelectItem key={t.to} value={t.to}>
                      {t.to}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-explore-label">Link label</Label>
              <Input
                id="v-explore-label"
                value={form.exploreLabel}
                onChange={(e) => set("exploreLabel", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Takeaways (2 to 4)</Label>
            {form.takeaways.map((t, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  aria-label={`Takeaway ${i + 1}`}
                  value={t}
                  onChange={(e) =>
                    set(
                      "takeaways",
                      form.takeaways.map((x, j) => (j === i ? e.target.value : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove takeaway ${i + 1}`}
                  onClick={() =>
                    set(
                      "takeaways",
                      form.takeaways.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {form.takeaways.length < 4 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => set("takeaways", [...form.takeaways, ""])}
              >
                <Plus className="mr-1 h-3 w-3" /> Add a takeaway
              </Button>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="v-disclaimer">
                Disclaimer — the on-screen compliance line, verbatim (optional)
              </Label>
              <Counter value={form.disclaimer} max={240} />
            </div>
            <Input
              id="v-disclaimer"
              value={form.disclaimer}
              onChange={(e) => set("disclaimer", e.target.value)}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <Label>Card artwork (before a poster exists)</Label>
              <Select value={form.artwork} onValueChange={(v) => set("artwork", v)}>
                <SelectTrigger aria-label="Card artwork">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEBSITE_ARTWORK.map((a) => (
                    <SelectItem key={a.path} value={a.path}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-artwork-position">Artwork focus</Label>
              <Input
                id="v-artwork-position"
                className="font-mono"
                placeholder="center"
                value={form.artworkPosition}
                onChange={(e) => set("artworkPosition", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Which part of the artwork the card keeps, as a CSS position: <code>30% 25%</code>.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Orientation</Label>
              <Select
                value={form.orientation}
                onValueChange={(v) => set("orientation", v)}
                disabled={shapeLocked}
              >
                <SelectTrigger aria-label="Orientation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="landscape">Landscape 16:9</SelectItem>
                  <SelectItem value="portrait">Vertical 9:16 reel</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {shapeLocked
                  ? "Measured from the video; a new upload sets it again."
                  : "Set from the video when it is uploaded."}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="v-order">Library order</Label>
              <Input
                id="v-order"
                inputMode="numeric"
                value={form.sortOrder}
                onChange={(e) => set("sortOrder", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Lower comes first. Reorder the library from the list of videos.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Video</CardTitle>
        </CardHeader>
        <CardContent>
          <WebsiteVideoMediaPanel
            briefingId={row.id}
            slug={row.slug}
            media={row}
            mediaOrigin={query.data?.mediaOrigin ?? ""}
            disabled={busy || dirty}
            onPlayhead={setPlayhead}
            onUploaded={(rebuild) => {
              if (rebuild) rebuildToast(rebuild as Rebuild, "");
              void refresh();
            }}
          />
          {dirty && (
            <p className="mt-2 text-xs text-muted-foreground">
              Save your changes before uploading.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pictures</CardTitle>
          <CardDescription>
            The thumbnail designed for the video, the poster and the link preview, each uploaded on
            its own without uploading the video again. A new video upload keeps them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WebsiteVideoPicturesPanel
            row={row}
            mediaOrigin={query.data?.mediaOrigin ?? ""}
            libraryCode={query.data?.libraryCode ?? null}
            disabled={busy || dirty}
            onUploaded={(rebuild) => {
              if (rebuild) rebuildToast(rebuild as Rebuild, "");
              void refresh();
            }}
          />
          {dirty && (
            <p className="mt-2 text-xs text-muted-foreground">
              Save your changes before uploading.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Chapters</CardTitle>
          <CardDescription>
            Optional marks the viewer can jump to. The first starts at 0:00; each starts later than
            the one before, and before the video ends.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {form.chapters.map((c, i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label={`Chapter ${i + 1} time`}
                className="w-24 font-mono"
                value={c.time}
                placeholder="m:ss"
                onChange={(e) =>
                  set(
                    "chapters",
                    form.chapters.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)),
                  )
                }
              />
              <Input
                aria-label={`Chapter ${i + 1} label`}
                value={c.label}
                onChange={(e) =>
                  set(
                    "chapters",
                    form.chapters.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove chapter ${i + 1}`}
                onClick={() =>
                  set(
                    "chapters",
                    form.chapters.filter((_, j) => j !== i),
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                set("chapters", [
                  ...form.chapters,
                  { time: form.chapters.length ? "" : "0:00", label: "" },
                ])
              }
            >
              <Plus className="mr-1 h-3 w-3" /> Add a chapter
            </Button>
            {playhead !== null && (
              <Button variant="outline" size="sm" onClick={addChapterAtPlayhead}>
                <Timer className="mr-1 h-3 w-3" /> Add one at {formatChapterTime(playhead)}
              </Button>
            )}
            {form.chapters.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set("chapters", chaptersInOrder(form.chapters))}
              >
                <ArrowDownUp className="mr-1 h-3 w-3" /> Put in time order
              </Button>
            )}
          </div>
          {playhead === null && row.media_mp4 && (
            <p className="text-xs text-muted-foreground">
              Play or scrub the video above to add a chapter where it is.
            </p>
          )}
          {built && !built.ok && (
            <ul className="list-disc pl-5 text-xs text-destructive">
              {built.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transcript</CardTitle>
          <CardDescription>
            Shown on the video's page, so search engines and screen readers get what the video says.
            Verbatim: for a video whose words are on screen, the on-screen text in order. Separate
            paragraphs with a blank line.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            rows={12}
            value={form.transcript}
            onChange={(e) => set("transcript", e.target.value)}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/website/videos"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3 w-3" /> Website videos
    </Link>
  );
}
