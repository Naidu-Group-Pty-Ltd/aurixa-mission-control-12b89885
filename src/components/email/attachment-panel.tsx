/**
 * The files a campaign sends with every message.
 *
 * A file goes from the browser straight to the `email-attachments` bucket and
 * is then registered by the server, which reads it back and records ITS OWN
 * size and hash — the same "the file never passes through the Worker" shape
 * as a contact list, and for the same reason. The dispatcher re-checks that
 * hash before it claims anybody, so what reaches an inbox is the file shown
 * here.
 *
 * Whether a file travels inline is not a setting: an image the HTML body shows
 * as `cid:<name>` is inline, anything else is an ordinary attachment. The
 * panel reads the body as it is being typed, so the badge follows the edit.
 *
 * Files can change only while the campaign is a draft or paused. A file
 * swapped mid-send would split one campaign into two different messages with
 * no record of who received which.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Download, FileText, ImageIcon, Loader2, Paperclip, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RecordRow } from "@/components/record-row";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  MAX_ATTACHMENTS_PER_CAMPAIGN,
  MAX_CAMPAIGN_ATTACHMENT_BYTES,
  admissionProblem,
  humanBytes,
  isImageType,
  likelyDeliveryPath,
  referencedContentIds,
  safeObjectName,
} from "@/lib/email/attachments.pure";
import {
  ATTACHMENT_BUCKET,
  ATTACHMENT_EDITABLE_STATUSES,
  attachmentDownloadUrl,
  registerCampaignAttachment,
  removeCampaignAttachment,
} from "@/lib/email-campaigns.functions";

export type AttachmentListRow = {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  content_id: string;
};

/** A v4 UUID, also where `crypto.randomUUID` is unavailable (a non-secure origin). */
function uuidV4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function AttachmentPanel({
  campaignId,
  status,
  attachments,
  body,
  bodyFormat,
}: {
  campaignId: string;
  status: string;
  attachments: AttachmentListRow[];
  body: string;
  bodyFormat: string;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<{ id: string; name: string; note: string }[]>([]);

  const editable = (ATTACHMENT_EDITABLE_STATUSES as readonly string[]).includes(status);
  const total = attachments.reduce((sum, file) => sum + Number(file.size_bytes), 0);
  const shown = useMemo(
    () => (bodyFormat === "text" ? new Set<string>() : referencedContentIds(body)),
    [body, bodyFormat],
  );
  const path = likelyDeliveryPath(total, attachments.length, body.length);

  const note = (id: string, text: string) =>
    setUploads((current) =>
      current.map((upload) => (upload.id === id ? { ...upload, note: text } : upload)),
    );

  const addFiles = async (files: File[]) => {
    let held = attachments.map((file) => ({ sizeBytes: Number(file.size_bytes) }));
    for (const file of files) {
      // The same rule the server applies; asked here first so a file that
      // cannot be attached is never uploaded at all.
      const problem = admissionProblem({ fileName: file.name, sizeBytes: file.size }, held);
      if (problem) {
        toast.error(`${file.name} was not attached`, { description: problem });
        continue;
      }
      const attachmentId = uuidV4();
      const storagePath = `${campaignId}/${attachmentId}/${safeObjectName(file.name)}`;
      setUploads((current) => [
        ...current,
        { id: attachmentId, name: file.name, note: `uploading ${humanBytes(file.size)}…` },
      ]);
      try {
        const stored = await supabase.storage.from(ATTACHMENT_BUCKET).upload(storagePath, file, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });
        if (stored.error) throw new Error(stored.error.message);
        note(attachmentId, "checking…");
        await registerCampaignAttachment({
          data: {
            campaignId,
            attachmentId,
            storagePath,
            fileName: file.name,
            contentType: file.type || null,
          },
        });
        held = [...held, { sizeBytes: file.size }];
        toast.success(`${file.name} attached`);
      } catch (error) {
        toast.error(`${file.name} was not attached`, {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setUploads((current) => current.filter((upload) => upload.id !== attachmentId));
      }
    }
    void qc.invalidateQueries({ queryKey: ["email"] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => removeCampaignAttachment({ data: { id } }),
    onSuccess: (result) => {
      toast.success("Attachment removed", {
        description: result.fileKept
          ? "Messages already sent carried it, so the file is kept as the record of what they received."
          : undefined,
      });
      void qc.invalidateQueries({ queryKey: ["email"] });
    },
    onError: (error: Error) => toast.error("Could not remove it", { description: error.message }),
  });

  const open = async (id: string) => {
    try {
      const { url } = await attachmentDownloadUrl({ data: { attachmentId: id } });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error("Could not open the file", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const copyTag = async (contentId: string) => {
    const tag = `<img src="cid:${contentId}" alt="">`;
    try {
      await navigator.clipboard.writeText(tag);
      toast.success("Copied", {
        description: `${tag} — paste it into the body where the image goes.`,
      });
    } catch {
      toast.info(tag);
    }
  };

  return (
    <div className="glass space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="label-mono">attachments</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {attachments.length} of {MAX_ATTACHMENTS_PER_CAMPAIGN} files
        </p>
      </div>

      {editable ? (
        <div
          role="button"
          tabIndex={0}
          aria-label="Attach files"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = [...(event.dataTransfer?.files ?? [])];
            if (files.length) void addFiles(files);
          }}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center border border-dashed px-4 py-6 text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border hover:border-border-strong",
          )}
        >
          <Paperclip className="mb-2 h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">Drop files here, or click to choose</p>
          <p className="mt-1 max-w-md font-mono text-[11px] text-muted-foreground">
            Up to {humanBytes(MAX_CAMPAIGN_ATTACHMENT_BYTES)} in total, sent with every message.
            Programs and scripts are refused — Outlook blocks them for the reader anyway.
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length) void addFiles(files);
            }}
          />
        </div>
      ) : (
        <p className="font-mono text-[11px] text-muted-foreground">
          {status === "running"
            ? "Pause the campaign to change its attachments — a file swapped mid-send would split one campaign into two different messages."
            : `Attachments cannot change on a ${status} campaign.`}
        </p>
      )}

      {uploads.map((upload) => (
        <RecordRow key={upload.id} spine="live" className="flex items-center gap-3 px-4 py-2">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-sm">{upload.name}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{upload.note}</p>
        </RecordRow>
      ))}

      {attachments.length > 0 && (
        <div className="space-y-2">
          {attachments.map((file) => {
            const image = isImageType(file.content_type);
            const inline = shown.has(file.content_id.toLowerCase());
            return (
              <RecordRow
                key={file.id}
                spine={inline ? "live" : "ok"}
                className="flex items-center gap-3 px-4 py-2"
              >
                {image ? (
                  <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{file.file_name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {humanBytes(Number(file.size_bytes))} · {file.content_type}
                    {inline
                      ? ` · shown in the body as cid:${file.content_id}`
                      : image && bodyFormat !== "text"
                        ? ` · attached — to show it in the body use cid:${file.content_id}`
                        : ""}
                  </p>
                </div>
                {inline && (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    inline
                  </Badge>
                )}
                {image && bodyFormat !== "text" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Copy an <img> tag for the body"
                    onClick={() => void copyTag(file.content_id)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  title="Open the stored file"
                  onClick={() => void open(file.id)}
                >
                  <Download className="h-3 w-3" />
                </Button>
                {editable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Remove"
                    disabled={remove.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Remove ${file.file_name}?`,
                        description:
                          "Later messages will not carry it. If earlier messages did, the stored file is kept as the record of what they received.",
                        confirmText: "Remove",
                        destructive: true,
                      });
                      if (ok) remove.mutate(file.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </RecordRow>
            );
          })}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="space-y-1">
          <Progress value={Math.min(100, (total / MAX_CAMPAIGN_ATTACHMENT_BYTES) * 100)} />
          <p className="font-mono text-[11px] text-muted-foreground">
            {humanBytes(total)} of {humanBytes(MAX_CAMPAIGN_ATTACHMENT_BYTES)} ·{" "}
            {path === "sendmail"
              ? "small enough to send in one request"
              : "too large for one request, so each message is built as a draft and its files uploaded (needs the Mail.ReadWrite permission)"}
          </p>
        </div>
      )}
    </div>
  );
}
