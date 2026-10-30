/**
 * A website video's pictures: the 16:9 thumbnail designed for it, the poster
 * the theatre shows before play, and the link-preview card — each uploaded on
 * its own, without re-uploading the stream.
 *
 * A picked PNG, JPEG or WebP of the right shape is made into the JPEG the
 * website expects in the browser (`briefingPictures.ts`); the card can be made
 * from the thumbnail. The pictures go up into a version folder of their own
 * under a single-use grant, the server reads each one's size back from the
 * bucket, and only then does the listing point at them. The previews below
 * the slots draw them as the website does: the library card with its code and
 * running-time tags, the theatre's poster under its play button, and a shared
 * link's preview.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ImageUp, Loader2, Play, RotateCcw, X } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  createBriefingPicturesUploadFn,
  finalizeBriefingPicturesUploadFn,
  resetBriefingPictureFn,
} from "@/server/website-briefings.functions";
import { uploadPackage, type UploadProgress } from "@/lib/briefingUpload";
import {
  PICTURE_TYPES,
  cardFromThumbnail,
  preparePicture,
  type PreparedPicture,
} from "@/lib/briefingPictures";
import {
  PICTURE_FIELD,
  WEBSITE_ORIGIN,
  formatChapterTime,
  pictureShape,
  pictureSource,
  planPicturesUpload,
  type Picture,
} from "@/lib/websiteBriefings.pure";

export type PicturesRow = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: string;
  orientation: string;
  artwork: string;
  artwork_position: string | null;
  duration_seconds: number | null;
  media_version: string | null;
  media_poster: string | null;
  media_card: string | null;
  media_thumbnail?: string | null;
};

type Rebuild = { requested: boolean; reason?: string; detail?: string } | null;

const SLOTS: Array<{ picture: Picture; title: string; says: string }> = [
  {
    picture: "thumbnail",
    title: "Thumbnail",
    says: "The website's library card and the theatre's up-next card. Designed art: its type and logo are shown as they are, with only a light wash for the card's tags.",
  },
  {
    picture: "poster",
    title: "Poster",
    says: "What the theatre shows in the player before the first frame plays, in the video's own shape.",
  },
  {
    picture: "card",
    title: "Link preview",
    says: "The picture a shared link unfurls with (og:image), 1200×630.",
  },
];

const kilobytes = (bytes: number) =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;

type Picked = { prepared: PreparedPicture; url: string };

export function WebsiteVideoPicturesPanel({
  row,
  mediaOrigin,
  libraryCode,
  onUploaded,
  disabled,
}: {
  row: PicturesRow;
  mediaOrigin: string;
  /** The card's code tag on the website (BRF-01 …), when the listing is in its library. */
  libraryCode: string | null;
  onUploaded: (rebuild: Rebuild) => void;
  disabled?: boolean;
}) {
  const createUpload = useServerFn(createBriefingPicturesUploadFn);
  const finalize = useServerFn(finalizeBriefingPicturesUploadFn);
  const resetFn = useServerFn(resetBriefingPictureFn);
  const confirm = useConfirm();
  const [picked, setPicked] = useState<Partial<Record<Picture, Picked>>>({});
  const [derivedCard, setDerivedCard] = useState<Picked | null>(null);
  const [cardFromThumb, setCardFromThumb] = useState(true);
  const [slotProblems, setSlotProblems] = useState<Partial<Record<Picture, string>>>({});
  const [busy, setBusy] = useState<"preparing" | "uploading" | "verifying" | "resetting" | null>(
    null,
  );
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  // Object URLs live as long as their preview: revoked when replaced, and on leaving.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const held = urls.current;
    return () => held.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const hold = (prepared: PreparedPicture): Picked => {
    const url = URL.createObjectURL(prepared.blob);
    urls.current.add(url);
    return { prepared, url };
  };
  const release = (p: Picked | null | undefined) => {
    if (!p) return;
    URL.revokeObjectURL(p.url);
    urls.current.delete(p.url);
  };

  const stored = (picture: Picture) => {
    const path = row[PICTURE_FIELD[picture]] ?? null;
    return path ? `${mediaOrigin}/${path}` : null;
  };
  const card = picked.card ?? (cardFromThumb ? derivedCard : null);
  const toUpload = [picked.thumbnail, picked.poster, card].filter((p): p is Picked => Boolean(p));
  const shown = (picture: Picture) =>
    (picture === "card" ? card?.url : picked[picture]?.url) ?? stored(picture);

  async function choose(picture: Picture, file: File | undefined) {
    if (!file) return;
    setProblems([]);
    setSlotProblems((p) => ({ ...p, [picture]: undefined }));
    setBusy("preparing");
    try {
      const made = await preparePicture({ file, picture, orientation: row.orientation });
      if (!made.ok) {
        setSlotProblems((p) => ({ ...p, [picture]: made.problem }));
        return;
      }
      release(picked[picture]);
      setPicked((p) => ({ ...p, [picture]: hold(made.prepared) }));
      if (picture === "thumbnail") {
        release(derivedCard);
        setDerivedCard(hold(await cardFromThumbnail(made.image, made.prepared)));
      }
      made.image.close();
    } catch (err) {
      setSlotProblems((p) => ({
        ...p,
        [picture]: err instanceof Error ? err.message : "The image could not be read.",
      }));
    } finally {
      setBusy(null);
    }
  }

  function clear(picture: Picture) {
    release(picked[picture]);
    setPicked((p) => ({ ...p, [picture]: undefined }));
    if (picture === "thumbnail") {
      release(derivedCard);
      setDerivedCard(null);
    }
    setSlotProblems((p) => ({ ...p, [picture]: undefined }));
  }

  async function upload() {
    if (toUpload.length === 0) return;
    setBusy("uploading");
    setProblems([]);
    setProgress(null);
    try {
      const files = new Map(toUpload.map((p) => [p.prepared.file, p.prepared.blob]));
      const grant = await createUpload({ data: { briefingId: row.id, paths: [...files.keys()] } });
      if (!grant.ok) {
        setProblems([grant.error, ...grant.problems]);
        return;
      }
      const outcome = await uploadPackage({
        files,
        grant: { token: grant.token, signerUrl: grant.signerUrl },
        plan: planPicturesUpload,
        onProgress: setProgress,
      });
      if (!outcome.ok) {
        setProblems([
          outcome.error,
          ...outcome.failed.map((f) => `${f.path}: ${f.reason}`),
          "Nothing was changed on the listing.",
        ]);
        return;
      }
      setBusy("verifying");
      const done = await finalize({ data: { uploadId: grant.uploadId } });
      if (!done.ok) {
        setProblems([done.error, ...done.problems]);
        return;
      }
      toast.success(
        `Uploaded the ${done.pictures.join(", ")} (${grant.version}), checked in the website's bucket.`,
      );
      for (const p of [picked.thumbnail, picked.poster, picked.card, derivedCard]) release(p);
      setPicked({});
      setDerivedCard(null);
      onUploaded(done.rebuild as Rebuild);
    } catch (err) {
      setProblems([err instanceof Error ? err.message : "The upload failed"]);
    } finally {
      setBusy(null);
    }
  }

  async function reset(picture: Picture) {
    const copy = {
      thumbnail: {
        title: "Remove the thumbnail?",
        description:
          "The website's library and up-next cards go back to showing the poster. The file stays in the bucket.",
        confirmText: "Remove",
      },
      poster: {
        title: "Use the video's own poster?",
        description: `The theatre goes back to the poster the video was uploaded with (${row.media_version}).`,
        confirmText: "Use the video's poster",
      },
      card: {
        title: "Use the video's own link preview?",
        description:
          "Shared links go back to the card the video was uploaded with, or to the website's default picture if it had none.",
        confirmText: "Use the video's card",
      },
    }[picture];
    if (!(await confirm(copy))) return;
    setBusy("resetting");
    setProblems([]);
    try {
      const result = await resetFn({ data: { id: row.id, picture } });
      if (!result.ok) {
        setProblems([result.error, ...result.problems]);
        return;
      }
      toast.success(
        picture === "thumbnail" ? "Thumbnail removed." : `Back to the video's own ${picture}.`,
      );
      onUploaded(result.rebuild as Rebuild);
    } catch (err) {
      setProblems([err instanceof Error ? err.message : "That did not work"]);
    } finally {
      setBusy(null);
    }
  }

  const locked = disabled || busy !== null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        {SLOTS.map((slot) => {
          const shape = pictureShape(slot.picture, row.orientation);
          const source = pictureSource(
            { ...row, media_thumbnail: row.media_thumbnail ?? null },
            slot.picture,
          );
          const pending = slot.picture === "card" ? card : picked[slot.picture];
          const url = shown(slot.picture);
          return (
            <div key={slot.picture} className="flex flex-col gap-3 border border-border/60 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{slot.title}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {shape.ratio} · {shape.width}×{shape.height} JPEG
                  </p>
                </div>
                {pending ? (
                  <Badge variant="outline">to upload</Badge>
                ) : source === "own" ? (
                  <Badge variant="default">uploaded on its own</Badge>
                ) : source === "video" ? (
                  <Badge variant="secondary">from the video</Badge>
                ) : (
                  <Badge variant="secondary">none</Badge>
                )}
              </div>
              <div
                className="relative flex w-full items-center justify-center overflow-hidden bg-muted/40"
                style={{
                  aspectRatio: `${shape.width} / ${shape.height}`,
                  maxHeight:
                    slot.picture === "poster" && row.orientation === "portrait" ? 300 : undefined,
                }}
              >
                {url ? (
                  <img src={url} alt={`${slot.title}`} className="h-full w-full object-contain" />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {slot.picture === "thumbnail"
                      ? "None: the cards show the poster"
                      : slot.picture === "card"
                        ? "None: links show the website's default"
                        : "None yet"}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{slot.says}</p>
              {pending && (
                <p className="font-mono text-[11px] text-muted-foreground">
                  {pending.prepared.fromThumbnail
                    ? `made from the thumbnail · ${kilobytes(pending.prepared.blob.size)}`
                    : `${pending.prepared.source.name}: ${pending.prepared.source.width}×${pending.prepared.source.height} → ${pending.prepared.width}×${pending.prepared.height} · ${kilobytes(pending.prepared.blob.size)}`}
                </p>
              )}
              {slot.picture === "card" && derivedCard && !picked.card && (
                <div className="flex items-center gap-2">
                  <Switch
                    id="card-from-thumbnail"
                    checked={cardFromThumb}
                    onCheckedChange={setCardFromThumb}
                    disabled={locked}
                  />
                  <Label htmlFor="card-from-thumbnail" className="text-xs font-normal">
                    Make it from the thumbnail (centred; 3% off the top and bottom)
                  </Label>
                </div>
              )}
              <div className="mt-auto flex flex-wrap gap-2">
                <PickButton disabled={locked} onPick={(file) => void choose(slot.picture, file)}>
                  {picked[slot.picture] ? "Choose another" : "Choose image"}
                </PickButton>
                {picked[slot.picture] && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={() => clear(slot.picture)}
                  >
                    <X className="mr-1 h-3 w-3" /> Don't upload
                  </Button>
                )}
                {!pending && source === "own" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={() => void reset(slot.picture)}
                  >
                    <RotateCcw className="mr-1 h-3 w-3" />
                    {slot.picture === "thumbnail" ? "Remove" : "Use the video's own"}
                  </Button>
                )}
              </div>
              {slotProblems[slot.picture] && (
                <p className="text-xs text-destructive">{slotProblems[slot.picture]}</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void upload()} disabled={locked || toUpload.length === 0}>
          {busy === "uploading" || busy === "verifying" || busy === "preparing" ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ImageUp className="mr-2 h-4 w-4" />
          )}
          {busy === "verifying"
            ? "Checking…"
            : busy === "uploading"
              ? "Uploading…"
              : busy === "preparing"
                ? "Preparing…"
                : toUpload.length > 0
                  ? `Upload ${toUpload.length === 1 ? "1 picture" : `${toUpload.length} pictures`} and check`
                  : "Upload pictures"}
        </Button>
        <span className="text-xs text-muted-foreground">
          PNG, JPEG or WebP, in the slot's shape (within 1%). The video keeps playing as it is;
          {row.status === "published"
            ? " the website rebuilds with the new pictures."
            : " the website shows them once the video is published."}
        </span>
      </div>
      {progress && busy === "uploading" && (
        <Progress
          value={progress.bytesTotal ? (progress.bytesDone / progress.bytesTotal) * 100 : 0}
        />
      )}
      {problems.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="space-y-3 border-t border-border/60 pt-4">
        <p className="text-sm font-medium">On the website</p>
        <p className="text-xs text-muted-foreground">
          Drawn as the website draws them
          {toUpload.length > 0 ? ", with the pictures chosen above" : ""}.
        </p>
        <div className="flex flex-wrap items-start gap-6">
          <Preview label="Library card">
            <LibraryCardPreview
              row={row}
              thumbnail={shown("thumbnail")}
              poster={shown("poster")}
              code={libraryCode}
            />
          </Preview>
          <Preview label="Theatre, before play">
            <TheatrePreview row={row} poster={shown("poster")} />
          </Preview>
          <Preview label="A shared link">
            <LinkPreview row={row} card={shown("card")} />
          </Preview>
        </div>
      </div>
    </div>
  );
}

function PickButton({
  children,
  disabled,
  onPick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onPick: (file: File | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={PICTURE_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
    </>
  );
}

function Preview({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="space-y-1.5">
      {children}
      <figcaption className="font-mono text-[11px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

// The website's own colours and marks (aurixa-systems src/index.css, .watch-card
// and the theatre), so a preview reads as the page will.
const NAVY = "#02060d";
const TAG =
  "absolute bg-black/70 px-1.5 py-1 font-mono text-[8px] font-bold tracking-[0.15em] text-white";

/**
 * The library card: a designed thumbnail as landscape art under a light wash;
 * without one, a portrait poster small over a blur of itself, a landscape
 * poster filling the frame, or the brand artwork before there is a poster.
 */
function LibraryCardPreview({
  row,
  thumbnail,
  poster,
  code,
  width = 288,
}: {
  row: PicturesRow;
  thumbnail: string | null;
  poster: string | null;
  code: string | null;
  width?: number;
}) {
  const live = row.status === "published";
  const designed = Boolean(thumbnail && live);
  const art = designed ? thumbnail : live ? poster : null;
  const artwork = `${WEBSITE_ORIGIN}${row.artwork}`;
  return (
    <div className="space-y-2" style={{ width }}>
      <div
        className="relative w-full overflow-hidden"
        style={{ aspectRatio: "16 / 9", background: NAVY }}
      >
        {art && !designed && row.orientation === "portrait" ? (
          <>
            <img
              src={art}
              alt=""
              className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-md"
            />
            <img
              src={art}
              alt=""
              className="absolute inset-0 m-auto h-full w-auto object-contain"
            />
          </>
        ) : (
          <img
            src={art ?? artwork}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              objectPosition: art ? "center" : (row.artwork_position ?? "center"),
              filter: designed ? undefined : "contrast(1.1) brightness(.82)",
            }}
          />
        )}
        <div
          className="absolute inset-0"
          style={{
            background: designed
              ? "linear-gradient(180deg, rgba(4,11,22,.3), transparent 22%), radial-gradient(ellipse 45% 40% at 100% 100%, rgba(4,11,22,.55), transparent)"
              : "linear-gradient(180deg, rgba(4,11,22,.35), transparent 40%, rgba(16,35,61,.95))",
          }}
        />
        <span className={`${TAG} left-2 top-2 border border-white/25`}>{code ?? "BRF-··"}</span>
        <span className={`${TAG} bottom-2 right-2`}>
          {live && row.duration_seconds ? formatChapterTime(row.duration_seconds) : "PREMIERING"}
        </span>
      </div>
      <p className="line-clamp-2 text-xs font-medium leading-snug">{row.title}</p>
      {!live && (
        <p className="text-[11px] text-muted-foreground">
          Not published: the website shows a premiere's card with its brand artwork.
        </p>
      )}
    </div>
  );
}

function TheatrePreview({ row, poster }: { row: PicturesRow; poster: string | null }) {
  const portrait = row.orientation === "portrait";
  return (
    <div
      className="relative overflow-hidden"
      style={{
        width: portrait ? 162 : 288,
        aspectRatio: portrait ? "9 / 16" : "16 / 9",
        background: NAVY,
      }}
    >
      {poster ? (
        <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground">
          No poster yet
        </span>
      )}
      <div
        className="absolute inset-x-0 bottom-0 h-1/3"
        style={{ background: "linear-gradient(180deg, transparent, rgba(4,11,22,.9))" }}
      />
      <span
        className="absolute left-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/30"
        style={{ top: "47%", background: "rgba(10,25,47,.55)" }}
      >
        <Play className="ml-0.5 h-4 w-4 fill-amber-300 text-amber-300" />
      </span>
      <p className="absolute inset-x-2 bottom-2 line-clamp-2 text-[10px] font-medium leading-tight text-white">
        {row.title}
      </p>
    </div>
  );
}

function LinkPreview({ row, card }: { row: PicturesRow; card: string | null }) {
  return (
    <div className="w-72 overflow-hidden border border-border/60 bg-card">
      <div className="w-full bg-muted/40" style={{ aspectRatio: "1200 / 630" }}>
        {card ? (
          <img src={card} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full place-items-center text-[11px] text-muted-foreground">
            The website's default picture
          </span>
        )}
      </div>
      <div className="space-y-0.5 p-2">
        <p className="font-mono text-[10px] uppercase text-muted-foreground">
          aurixasystems.com.au
        </p>
        <p className="line-clamp-1 text-xs font-medium">{row.title}</p>
        <p className="line-clamp-2 text-[11px] text-muted-foreground">{row.summary}</p>
      </div>
    </div>
  );
}
