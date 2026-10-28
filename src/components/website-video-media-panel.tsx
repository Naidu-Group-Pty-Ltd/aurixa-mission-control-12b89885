/**
 * A website video's media: what it plays now, and uploading a new version.
 *
 * The package is the folder `npm run video:encode` writes (aurixa-systems,
 * docs/video-briefings.md): an adaptive ladder, a fallback MP4, a poster and
 * a link-preview card. It is uploaded straight from the browser into the
 * website's bucket under a single-use grant, then read back from the bucket
 * the way a viewer's player will see it; only then does the listing point at
 * it. A new upload is always a new version folder, so the version playing now
 * keeps playing until the new one has been verified.
 */
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { FolderUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  createBriefingUploadFn,
  finalizeBriefingUploadFn,
} from "@/server/website-briefings.functions";
import {
  isHiddenFile,
  relativePathOf,
  uploadPackage,
  type UploadProgress,
} from "@/lib/briefingUpload";
import { formatChapterTime, planUpload } from "@/lib/websiteBriefings.pure";

type Media = {
  media_version: string | null;
  media_hls: string | null;
  media_mp4: string | null;
  media_poster: string | null;
  media_card: string | null;
  duration_seconds: number | null;
  orientation: string;
};

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function WebsiteVideoMediaPanel({
  briefingId,
  slug,
  media,
  mediaOrigin,
  onUploaded,
  disabled,
}: {
  briefingId: string;
  slug: string;
  media: Media;
  mediaOrigin: string;
  onUploaded: (rebuild: { requested: boolean; reason?: string } | null) => void;
  disabled?: boolean;
}) {
  const createUpload = useServerFn(createBriefingUploadFn);
  const finalize = useServerFn(finalizeBriefingUploadFn);
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Map<string, File> | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [busy, setBusy] = useState<"uploading" | "verifying" | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const plan = picked ? planUpload([...picked.keys()]) : null;
  const totalBytes = picked ? [...picked.values()].reduce((sum, f) => sum + f.size, 0) : 0;
  const url = (path: string | null) => (path ? `${mediaOrigin}/${path}` : null);

  function choose(files: FileList | null) {
    setProblems([]);
    setProgress(null);
    if (!files || files.length === 0) return;
    const map = new Map<string, File>();
    for (const file of Array.from(files)) {
      const path = relativePathOf(file);
      if (!isHiddenFile(path)) map.set(path, file);
    }
    setFolderName(files[0].webkitRelativePath?.split("/")[0] || null);
    setPicked(map);
  }

  async function upload() {
    if (!picked || !plan?.ok) return;
    setBusy("uploading");
    setProblems([]);
    try {
      const grant = await createUpload({
        data: { briefingId, paths: plan.files.map((f) => f.path) },
      });
      if (!grant.ok) {
        setProblems([grant.error, ...grant.problems]);
        return;
      }
      const outcome = await uploadPackage({
        files: picked,
        grant: { token: grant.token, signerUrl: grant.signerUrl },
        onProgress: setProgress,
      });
      if (!outcome.ok) {
        setProblems([
          outcome.error,
          ...outcome.failed.slice(0, 8).map((f) => `${f.path}: ${f.reason}`),
          "Nothing was changed on the listing. Pick the folder and upload again to send what is missing.",
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
        `Uploaded ${grant.version}: ${done.durationSeconds ? formatChapterTime(done.durationSeconds) : "progressive"} ${done.orientation} video, verified from the website's bucket.`,
      );
      setPicked(null);
      setFolderName(null);
      if (input.current) input.current.value = "";
      onUploaded(done.rebuild);
    } catch (err) {
      setProblems([err instanceof Error ? err.message : "The upload failed"]);
    } finally {
      setBusy(null);
    }
  }

  const poster = url(media.media_poster);
  const card = url(media.media_card);

  return (
    <div className="space-y-4">
      {media.media_version ? (
        <div className="flex flex-col gap-4 md:flex-row">
          {poster && (
            <img
              src={poster}
              alt="Poster"
              className={
                media.orientation === "portrait"
                  ? "h-56 w-auto self-start border border-border/60 object-contain"
                  : "h-36 w-auto self-start border border-border/60 object-contain"
              }
            />
          )}
          <div className="space-y-1 text-sm">
            <p>
              Playing <span className="font-mono">{media.media_version}</span>
              {media.duration_seconds
                ? ` · ${formatChapterTime(media.duration_seconds)}`
                : ""} · {media.orientation}
            </p>
            <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {[
                ["stream", media.media_hls],
                ["fallback", media.media_mp4],
                ["poster", media.media_poster],
                ["link preview", media.media_card],
              ].map(([label, path]) =>
                path ? (
                  <li key={label}>
                    {label}:{" "}
                    <a
                      href={url(path)!}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-foreground"
                    >
                      {path}
                    </a>
                  </li>
                ) : null,
              )}
            </ul>
            {card && (
              <img
                src={card}
                alt="Link preview"
                className="mt-2 h-24 w-auto border border-border/60"
              />
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No video yet. Upload its encoded package below.
        </p>
      )}

      <div className="space-y-3 border-t border-border/60 pt-4">
        <p className="text-sm">
          {media.media_version ? "Upload a new version" : "Upload the video"}: pick the folder{" "}
          <code className="font-mono text-xs">
            npm run video:encode -- master.mov --slug {slug}
          </code>{" "}
          wrote (<code className="font-mono text-xs">media-build/{slug}</code> in the aurixa-systems
          repository).
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => choose(e.target.files)}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
          <Button
            variant="outline"
            onClick={() => input.current?.click()}
            disabled={disabled || busy !== null}
          >
            <FolderUp className="mr-2 h-4 w-4" /> Choose folder
          </Button>
          {picked && (
            <span className="text-xs text-muted-foreground">
              {folderName ? `${folderName}: ` : ""}
              {picked.size} files, {megabytes(totalBytes)}
            </span>
          )}
          {picked && plan?.ok && (
            <Button onClick={upload} disabled={disabled || busy !== null}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {busy === "verifying"
                ? "Verifying…"
                : busy === "uploading"
                  ? "Uploading…"
                  : "Upload and verify"}
            </Button>
          )}
        </div>
        {plan && !plan.ok && (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
            {plan.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {progress && busy === "uploading" && (
          <div className="space-y-1">
            <Progress
              value={progress.bytesTotal ? (progress.bytesDone / progress.bytesTotal) * 100 : 0}
            />
            <p className="font-mono text-[11px] text-muted-foreground">
              {progress.stage === "signing"
                ? "Asking the website for upload links…"
                : `${progress.filesDone} of ${progress.filesTotal} files · ${megabytes(progress.bytesDone)} of ${megabytes(progress.bytesTotal)}`}
            </p>
          </div>
        )}
        {problems.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
