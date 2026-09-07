/**
 * Dropping a contact list on the page.
 *
 * The important architectural decision here is invisible: **the file goes to
 * Supabase Storage directly from the browser, and only the parsed rows travel
 * through a server function.**
 *
 * Uploading through the app would put the file through a Cloudflare Worker,
 * whose request-body ceiling is the smallest number in the whole path and is
 * not raiseable from here — so "max out the upload size" would have meant
 * "whatever the Worker allows", which is where a 200 MB export becomes a 413
 * with no explanation. Going straight to Storage means the limit is the
 * bucket's, the parse never leaves the operator's machine, and the rows arrive
 * in chunks small enough that a lost connection resumes instead of restarting.
 *
 * The one real ceiling left is memory: reading a workbook requires the whole
 * archive, and a 500 MB text file becomes a gigabyte of UTF-16 string. That
 * ceiling is named, not discovered — a file above it is still STORED, and the
 * list says exactly why it was not read.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, FileSpreadsheet, Loader2, Upload, X, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { parseListFile, type ParsedTable } from "@/lib/email/workbook.pure";
import {
  extractContacts,
  profileTable,
  type ContactRow,
  type ListProfile,
} from "@/lib/email/listProfile.pure";
import {
  createList,
  finaliseList,
  ingestListChunk,
  INGEST_CHUNK_SIZE,
} from "@/lib/email-campaigns.functions";

export const LIST_BUCKET = "email-lists";

/**
 * The bucket's own ceiling, in bytes — 50 GB, the largest a Supabase bucket
 * accepts per object. The project-level "Upload file size limit" is a SECOND
 * setting and the lower of the two wins, so this number is the ceiling this
 * repository controls rather than the one an upload will actually meet.
 */
export const MAX_UPLOAD_BYTES = 53_687_091_200;

/**
 * What a browser can read into memory to parse. A workbook has to be held
 * whole (it is a compressed archive), and text becomes UTF-16 on the way in,
 * so this is roughly a million contacts and deliberately well short of the
 * point where a tab dies. Above it the file is stored and the reason is
 * recorded, because an upload that silently does nothing is the worse outcome.
 */
export const MAX_PARSE_BYTES = 100 * 1024 * 1024;

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Not available over plain http in some browsers. Provenance is nice to
    // have; it is not worth failing an upload over.
    return null;
  }
}

type Stage = "idle" | "reading" | "preview" | "uploading" | "done";

type Draft = {
  file: File;
  bytes: Uint8Array;
  table: ParsedTable;
  profile: ListProfile;
  name: string;
  emailColumn: string | null;
};

export function ListDropzone({ onUploaded }: { onUploaded?: (listId: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressNote, setProgressNote] = useState("");

  const extraction = useMemo(() => {
    if (!draft) return null;
    return extractContacts(draft.table.headers, draft.table.rows, draft.profile, draft.emailColumn);
  }, [draft]);

  const reset = () => {
    setStage("idle");
    setDraft(null);
    setError(null);
    setProgress(0);
    setProgressNote("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const takeFile = useCallback(async (file: File) => {
    setError(null);
    setStage("reading");
    setProgressNote(`Reading ${file.name}…`);
    try {
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `${humanBytes(file.size)} is larger than this deployment accepts (${humanBytes(MAX_UPLOAD_BYTES)}).`,
        );
      }
      if (file.size > MAX_PARSE_BYTES) {
        throw new Error(
          `${humanBytes(file.size)} is too large to read in the browser (the ceiling is ${humanBytes(MAX_PARSE_BYTES)}, about a million contacts). Split the export and upload the parts — each becomes its own list, and a campaign can take several.`,
        );
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const table = await parseListFile(bytes, file.name);
      const profile = profileTable(table.headers, table.rows);
      setDraft({
        file,
        bytes,
        table,
        profile,
        name: file.name.replace(/\.[^.]+$/, ""),
        emailColumn: profile.emailColumnKey,
      });
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("idle");
    }
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) void takeFile(file);
    },
    [takeFile],
  );

  const upload = async () => {
    if (!draft || !extraction) return;
    setStage("uploading");
    setProgress(0);

    try {
      const checksum = await sha256Hex(draft.bytes);
      setProgressNote("Creating the list…");
      const { id: listId } = await createList({
        data: {
          name: draft.name.trim() || draft.file.name,
          fileName: draft.file.name,
          mimeType: draft.file.type || null,
          sizeBytes: draft.file.size,
          checksum,
          sourceFormat: draft.table.format,
        },
      });

      // The raw file, kept whatever the parse made of it. Straight to Storage
      // — this is the request that never passes through a Worker.
      const path = `${listId}/${draft.file.name.replace(/[^\w.-]+/g, "_")}`;
      setProgressNote(`Storing ${humanBytes(draft.file.size)}…`);
      const stored = await supabase.storage.from(LIST_BUCKET).upload(path, draft.file, {
        contentType: draft.file.type || "application/octet-stream",
        upsert: true,
      });
      if (stored.error) {
        // Not fatal: the contacts are what the campaign needs, and losing the
        // provenance copy is worth saying rather than worth stopping for.
        console.error("[email] list file upload failed:", stored.error.message);
        toast.warning("The contacts were read, but the source file could not be stored", {
          description: stored.error.message,
        });
      }

      const contacts: ContactRow[] = extraction.contacts;
      let sent = 0;
      for (let at = 0; at < contacts.length; at += INGEST_CHUNK_SIZE) {
        const chunk = contacts.slice(at, at + INGEST_CHUNK_SIZE);
        await ingestListChunk({ data: { listId, contacts: chunk } });
        sent += chunk.length;
        setProgress(Math.round((sent / Math.max(1, contacts.length)) * 100));
        setProgressNote(
          `${sent.toLocaleString()} of ${contacts.length.toLocaleString()} contacts…`,
        );
      }

      await finaliseList({
        data: {
          listId,
          status: "ready",
          rowCount: draft.table.rows.length,
          contactCount: contacts.length,
          invalidCount: extraction.invalid.length,
          duplicateCount: extraction.duplicates,
          emailColumn: draft.emailColumn,
          // Only a parameter column's values are kept. A `Full Name` column
          // samples up to two hundred values on the way past and is never
          // offered as a control, so storing them copies a slice of the list
          // into the campaign record for nothing.
          columns: draft.profile.columns.map((column) => ({
            ...column,
            values: column.isDimension ? column.values : [],
          })) as unknown as Record<string, unknown>[],
          parseError: null,
        },
      });

      setStage("done");
      setProgressNote(`${contacts.length.toLocaleString()} contacts ready`);
      toast.success("List uploaded", {
        description: `${contacts.length.toLocaleString()} contacts from ${draft.file.name}`,
      });
      onUploaded?.(listId);
    } catch (err) {
      setStage("preview");
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Upload failed", { description: message });
    }
  };

  const dimensions = draft?.profile.columns.filter((column) => column.isDimension) ?? [];

  return (
    <div className="space-y-4">
      {stage !== "preview" && stage !== "uploading" && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload a contact list"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          className={cn(
            "grid-bg flex cursor-pointer flex-col items-center justify-center border border-dashed p-10 text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border hover:border-border-strong",
          )}
        >
          {stage === "reading" ? (
            <Loader2 className="mb-3 h-6 w-6 animate-spin text-muted-foreground" />
          ) : stage === "done" ? (
            <CheckCircle2 className="mb-3 h-6 w-6 text-success" />
          ) : (
            <Upload className="mb-3 h-6 w-6 text-muted-foreground" />
          )}
          <p className="text-sm font-medium">
            {stage === "reading"
              ? progressNote
              : stage === "done"
                ? progressNote
                : "Drop a contact list here, or click to choose one"}
          </p>
          <p className="mt-1 max-w-md font-mono text-[11px] text-muted-foreground">
            Any file type — CSV, TSV, Excel (.xlsx), JSON or newline-delimited JSON. The format is
            read from the file itself, not from its name. Up to {humanBytes(MAX_PARSE_BYTES)}.
          </p>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void takeFile(file);
            }}
          />
        </div>
      )}

      {error && (
        <div className="glass-inset spine spine-bad flex items-start gap-3 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setError(null)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {draft && (stage === "preview" || stage === "uploading") && (
        <div className="glass space-y-5 p-5">
          <div className="flex items-start gap-3">
            <FileSpreadsheet className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{draft.file.name}</p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {draft.table.format} · {humanBytes(draft.file.size)} ·{" "}
                {draft.table.rows.length.toLocaleString()} rows · {draft.table.headers.length}{" "}
                columns
                {draft.table.delimiter
                  ? ` · separator ${draft.table.delimiter === "\t" ? "tab" : `"${draft.table.delimiter}"`}`
                  : ""}
              </p>
            </div>
            {stage === "preview" && (
              <Button variant="ghost" size="sm" onClick={reset}>
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>

          {draft.table.notes.length > 0 && (
            <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
              {draft.table.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="list-name">List name</Label>
              <Input
                id="list-name"
                value={draft.name}
                disabled={stage === "uploading"}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="list-email-column">Which column holds the address</Label>
              <Select
                value={draft.emailColumn ?? ""}
                disabled={stage === "uploading"}
                onValueChange={(value) =>
                  setDraft((current) => (current ? { ...current, emailColumn: value } : current))
                }
              >
                <SelectTrigger id="list-email-column">
                  <SelectValue placeholder="Choose a column" />
                </SelectTrigger>
                <SelectContent>
                  {draft.profile.columns.map((column) => (
                    <SelectItem key={column.key} value={column.key}>
                      {column.header || column.key}
                      {column.emailRatio > 0
                        ? ` — ${Math.round(column.emailRatio * 100)}% addresses`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {extraction && (
            <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
              <Cell label="contacts" value={extraction.contacts.length.toLocaleString()} />
              <Cell
                label="duplicates"
                value={extraction.duplicates.toLocaleString()}
                note="same address twice"
              />
              <Cell
                label="unreadable"
                value={extraction.invalid.length.toLocaleString()}
                alarm={extraction.invalid.length > 0}
                note="not an address"
              />
              <Cell
                label="parameters"
                value={dimensions.length.toLocaleString()}
                note="quota columns"
              />
            </div>
          )}

          {extraction && extraction.invalid.length > 0 && (
            <details className="glass-inset px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium">
                {extraction.invalid.length.toLocaleString()} rows had no usable address
              </summary>
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                {extraction.invalid.slice(0, 50).map((row) => (
                  <li key={`${row.row_number}-${row.value}`}>
                    row {row.row_number}: {row.value || "(empty)"}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {dimensions.length > 0 && (
            <div className="space-y-2">
              <p className="label-mono">columns you can set a quota on</p>
              <div className="flex flex-wrap gap-2">
                {dimensions.map((column) => (
                  <Badge key={column.key} variant="outline" className="font-mono text-[10px]">
                    {column.header || column.key} · {column.distinct} value
                    {column.distinct === 1 ? "" : "s"}
                  </Badge>
                ))}
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                A column is offered when its values repeat — a state or a segment, not a name. Every
                other column is still stored and can be used as a merge field.
              </p>
            </div>
          )}

          {stage === "uploading" ? (
            <div className="space-y-2">
              <Progress value={progress} />
              <p className="font-mono text-[11px] text-muted-foreground">{progressNote}</p>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={reset}>
                Discard
              </Button>
              <Button
                onClick={() => void upload()}
                disabled={!extraction || extraction.contacts.length === 0}
              >
                Upload {extraction ? extraction.contacts.length.toLocaleString() : 0} contacts
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  note,
  alarm,
}: {
  label: string;
  value: string;
  note?: string;
  alarm?: boolean;
}) {
  return (
    <div className="-mt-px -ml-px border-t border-l border-border/50 px-5 py-4">
      <div className={cn("numeral text-[2rem] leading-none", alarm && "text-warning")}>{value}</div>
      <div className="label-mono mt-2">{label}</div>
      {note && <div className="mt-1 font-mono text-[10px] text-muted-foreground">{note}</div>}
    </div>
  );
}
