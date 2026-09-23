// Documents tab: the client's files in, the planning run started and watched.
//
// Files go straight from the browser into the private bucket under the
// project's own prefix; the server then reads them BACK from the bucket to
// extract text and hash them, so what the planner sees is what is stored.
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { ExternalLink, FileText, Loader2, Play, Trash2, Upload, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { MonoStatus } from "@/components/voice/tone";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/confirm-dialog";
import {
  cancelStudioRun,
  deleteStudioDocumentFn,
  getStudioDocumentUrl,
  registerStudioDocumentFn,
  startStudioPlanning,
  VOICE_STUDIO_BUCKET,
} from "@/lib/voice-studio.functions";
import {
  ACCEPTED_EXTENSIONS,
  documentKind,
  MAX_UPLOAD_BYTES,
} from "@/lib/voice-studio/extract.pure";
import { bytes, STAGE_LABEL } from "./studio-vocab";
import type { StudioProjectData } from "./types";

const EXTRACTION = {
  extracted: { label: "text read", tone: "success" as const },
  native: { label: "read by the model", tone: "info" as const },
  pending: { label: "pending", tone: "neutral" as const },
  failed: { label: "unreadable", tone: "destructive" as const },
};

const storagePath = (projectId: string, fileName: string) => {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
  return `${projectId}/${crypto.randomUUID()}/${safe}`;
};

export function DocumentsTab({ data, refresh }: { data: StudioProjectData; refresh: () => void }) {
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const projectId = data.project.id;
  const liveRun = data.runs.find((r) => r.status === "queued" || r.status === "running");
  const lastRun = data.runs[0];

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (!documentKind(file.name, file.type)) {
        toast.error(`${file.name} is not a type the studio reads`, {
          description: ACCEPTED_EXTENSIONS.join(", "),
        });
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`${file.name} is larger than 25 MB`);
        continue;
      }
      setUploading(file.name);
      try {
        const path = storagePath(projectId, file.name);
        const { error } = await supabase.storage
          .from(VOICE_STUDIO_BUCKET)
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          });
        if (error) throw error;
        const r = await registerStudioDocumentFn({
          data: { projectId, storagePath: path, fileName: file.name },
        });
        if (r.duplicate) toast.info(`${file.name} is already in this project`);
        else if (r.error)
          toast.warning(`${file.name} was stored but could not be read`, { description: r.error });
        else toast.success(`${file.name} added`, { description: r.notes.join(" ") || undefined });
      } catch (err) {
        toast.error(`Upload of ${file.name} failed`, {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setUploading(null);
    if (input.current) input.current.value = "";
    refresh();
  };

  const remove = useMutation({
    mutationFn: (documentId: string) => deleteStudioDocumentFn({ data: { documentId } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const plan = useMutation({
    mutationFn: () => startStudioPlanning({ data: { projectId } }),
    onSuccess: () => {
      toast.success("Planning started", { description: "The worker picks it up within a minute." });
      refresh();
    },
    onError: (e: Error) => toast.error("Could not start planning", { description: e.message }),
  });
  const cancel = useMutation({
    mutationFn: (runId: string) => cancelStudioRun({ data: { runId } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const open = async (documentId: string) => {
    try {
      const { url } = await getStudioDocumentUrl({ data: { documentId } });
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error("Could not open the document", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const readable = data.documents.filter(
    (d) => d.extraction_status === "extracted" || d.extraction_status === "native",
  );

  return (
    <div className="space-y-6">
      <div className="glass flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Planning run</p>
          {liveRun ? (
            <p className="font-mono text-xs text-muted-foreground">
              {STAGE_LABEL[liveRun.stage] ?? liveRun.stage} · ${Number(liveRun.cost_usd).toFixed(2)}{" "}
              so far · started{" "}
              {formatDistanceToNow(new Date(liveRun.created_at), { addSuffix: true })}
            </p>
          ) : lastRun ? (
            <p className="font-mono text-xs text-muted-foreground">
              Last run {lastRun.status}{" "}
              {formatDistanceToNow(new Date(lastRun.updated_at), { addSuffix: true })} · $
              {Number(lastRun.cost_usd).toFixed(2)}
              {lastRun.last_error && lastRun.status === "failed" ? ` · ${lastRun.last_error}` : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Add the client's documents - brochure, FAQ, price list, policies, booking rules - then
              make the plan. Mission Control's own record of the client is included automatically.
            </p>
          )}
          {!data.modelConfigured && (
            <p className="text-xs text-warning">
              The planning agent is not configured on this deployment:
              VOICE_STUDIO_ANTHROPIC_API_KEY is not set.
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {liveRun ? (
            <>
              <MonoStatus label={liveRun.status} tone="info" pulse />
              <Button
                variant="outline"
                size="sm"
                onClick={() => cancel.mutate(liveRun.id)}
                disabled={cancel.isPending}
              >
                <X className="mr-1 h-3 w-3" /> Cancel
              </Button>
            </>
          ) : (
            <Button
              onClick={() => plan.mutate()}
              disabled={plan.isPending || !data.modelConfigured}
            >
              <Play className="mr-2 h-4 w-4" />
              {data.plans.length ? "Re-plan" : "Make the plan"}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <p className="label-mono">
          {data.documents.length} document{data.documents.length === 1 ? "" : "s"} ·{" "}
          {readable.length} readable
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(e) => void upload(e.target.files)}
        />
        <Button
          variant="outline"
          onClick={() => input.current?.click()}
          disabled={Boolean(uploading)}
        >
          {uploading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-2 h-4 w-4" />
          )}
          {uploading ? `Uploading ${uploading}` : "Add documents"}
        </Button>
      </div>

      {data.documents.length === 0 && (
        <EmptyState
          icon={<FileText />}
          title="No documents yet"
          description="PDF, Word (.docx), Excel (.xlsx), CSV, text and Markdown, up to 25 MB each. A PDF is read by the model itself; the rest are read here and every quote the plan makes is checked against them."
        />
      )}

      <div className="space-y-2">
        {data.documents.map((d) => {
          const ex =
            EXTRACTION[d.extraction_status as keyof typeof EXTRACTION] ?? EXTRACTION.pending;
          return (
            <RecordRow
              key={d.id}
              spine={d.extraction_status === "failed" ? "bad" : d.truncated ? "warn" : "ok"}
              className="flex items-center gap-3 px-4 py-3"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{d.file_name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {d.kind} · {bytes(d.size_bytes)}
                  {d.text_chars ? ` · ${d.text_chars.toLocaleString("en-AU")} characters` : ""}
                  {d.page_count ? ` · about ${d.page_count} pages` : ""}
                  {d.truncated ? " · only the first part was kept" : ""}
                  {d.error ? ` · ${d.error}` : ""}
                </p>
              </div>
              <MonoStatus label={ex.label} tone={ex.tone} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void open(d.id)}
                aria-label={`Open ${d.file_name}`}
              >
                <ExternalLink className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${d.file_name}`}
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove this document?",
                    description: `${d.file_name} will not be read by the next plan. Plans already made keep their citations to it.`,
                    confirmText: "Remove",
                    destructive: true,
                  });
                  if (ok) remove.mutate(d.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </RecordRow>
          );
        })}
      </div>
    </div>
  );
}
