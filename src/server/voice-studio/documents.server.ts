// A client document entering a cloning project.
//
// The browser uploads the file straight into the private `voice-studio-docs`
// bucket (the storage policy lets an admin write there), then asks the server
// to register it. Registration is where the file is READ - by the server, from
// the bucket, never from bytes the browser claims to have - so the text the
// planner sees and the hash that identifies the document both come from what
// is actually stored.
//
// The same file uploaded twice to one project is one document (the migration's
// unique (project_id, sha256)); the second upload's object is removed so the
// bucket does not fill with copies nothing points at.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  documentKind,
  ExtractionError,
  extractDocument,
  MAX_UPLOAD_BYTES,
  MIME_FOR_KIND,
  sha256OfBytes,
} from "@/lib/voice-studio/extract.pure";

export const VOICE_STUDIO_BUCKET = "voice-studio-docs";

export type RegisterDocumentInput = {
  projectId: string;
  storagePath: string;
  fileName: string;
  userId: string;
};

export type RegisteredDocument = {
  id: string;
  duplicate: boolean;
  extraction_status: "extracted" | "native" | "failed";
  truncated: boolean;
  notes: string[];
  error: string | null;
};

/** A storage key the browser may upload to: under the project, never outside it. */
export function assertProjectPath(projectId: string, storagePath: string): void {
  if (!storagePath.startsWith(`${projectId}/`) || storagePath.includes("..")) {
    throw new Error("storage_path_outside_project");
  }
}

export async function registerStudioDocument(input: RegisterDocumentInput): Promise<RegisteredDocument> {
  assertProjectPath(input.projectId, input.storagePath);
  const kind = documentKind(input.fileName);
  if (!kind) {
    await removeObject(input.storagePath);
    throw new Error(`"${input.fileName}" is not a type the studio reads (pdf, docx, xlsx, csv, txt, md)`);
  }

  const { data: blob, error: dlError } = await supabaseAdmin.storage
    .from(VOICE_STUDIO_BUCKET)
    .download(input.storagePath);
  if (dlError || !blob) throw new Error(`the uploaded file could not be read back: ${dlError?.message ?? "empty"}`);
  if (blob.size > MAX_UPLOAD_BYTES) {
    await removeObject(input.storagePath);
    throw new Error("the file is larger than 25 MB");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = await sha256OfBytes(bytes);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("voice_studio_documents")
    .select("id, storage_path, extraction_status, truncated, error")
    .eq("project_id", input.projectId)
    .eq("sha256", sha256)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    // Never the object the existing row points at - only the fresh copy.
    if (existing.storage_path !== input.storagePath) await removeObject(input.storagePath);
    return {
      id: existing.id,
      duplicate: true,
      extraction_status: existing.extraction_status as RegisteredDocument["extraction_status"],
      truncated: existing.truncated,
      notes: [],
      error: existing.error,
    };
  }

  // A file that cannot be read is still recorded - with the reason - so the
  // operator sees why it is not in the plan instead of wondering where it went.
  let extraction: Awaited<ReturnType<typeof extractDocument>> | null = null;
  let failure: string | null = null;
  try {
    extraction = await extractDocument(bytes, input.fileName, blob.type);
  } catch (err) {
    failure = err instanceof ExtractionError || err instanceof Error ? err.message : "the file could not be read";
  }

  const status: RegisteredDocument["extraction_status"] = failure
    ? "failed"
    : extraction?.kind === "pdf"
      ? "native"
      : "extracted";

  const { data: row, error } = await supabaseAdmin
    .from("voice_studio_documents")
    .insert({
      project_id: input.projectId,
      storage_path: input.storagePath,
      file_name: input.fileName.slice(0, 300),
      mime_type: MIME_FOR_KIND[kind],
      size_bytes: bytes.length,
      sha256,
      kind,
      extraction_status: status,
      extracted_text: extraction?.text ?? null,
      truncated: extraction?.truncated ?? false,
      page_count: extraction?.pageCount ?? null,
      error: failure,
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (error) throw error;

  return {
    id: row.id,
    duplicate: false,
    extraction_status: status,
    truncated: extraction?.truncated ?? false,
    notes: extraction?.notes ?? [],
    error: failure,
  };
}

/** Remove a document and its stored object. The plan versions that cited it keep their citations. */
export async function deleteStudioDocument(documentId: string): Promise<void> {
  const { data: doc, error } = await supabaseAdmin
    .from("voice_studio_documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!doc) return;
  const { error: delError } = await supabaseAdmin.from("voice_studio_documents").delete().eq("id", documentId);
  if (delError) throw delError;
  await removeObject(doc.storage_path);
}

async function removeObject(path: string): Promise<void> {
  const { error } = await supabaseAdmin.storage.from(VOICE_STUDIO_BUCKET).remove([path]);
  // A leftover object is clutter, not a fault the operator can act on.
  if (error) console.error(`[voice-studio] could not remove ${path}: ${error.message}`);
}

/** A short-lived link to a stored document, for checking a citation against its source. */
export async function signedDocumentUrl(documentId: string, expiresIn = 300): Promise<string | null> {
  const { data: doc, error } = await supabaseAdmin
    .from("voice_studio_documents")
    .select("storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!doc) return null;
  const { data, error: signError } = await supabaseAdmin.storage
    .from(VOICE_STUDIO_BUCKET)
    .createSignedUrl(doc.storage_path, expiresIn);
  if (signError) throw signError;
  return data?.signedUrl ?? null;
}
