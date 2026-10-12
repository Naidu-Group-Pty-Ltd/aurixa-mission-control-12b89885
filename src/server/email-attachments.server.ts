/**
 * A campaign's files, read back from storage and proved to be the files the
 * operator registered.
 *
 * Everything that sends — the dispatcher and the test send — reads through
 * `prepareAttachments`, and it either returns every file, verified, or
 * throws. There is no partial answer, because a message missing one of its
 * files is a DIFFERENT message, and the never-twice rule makes whatever went
 * out permanent: that contact cannot be sent the right one afterwards.
 *
 * Verified means: the object exists, its length is the length recorded when
 * it was registered, and its SHA-256 is the one the server computed then.
 * The bucket already refuses to replace an object in place; the hash is the
 * second wall, and it costs one digest per file per isolate.
 *
 * The service role is used here, on purpose and only here and in the
 * registration path: the dispatcher has no user, and registration has to read
 * the bytes the browser uploaded to hash them itself rather than accept a hash
 * the browser computed.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  MAX_CAMPAIGN_ATTACHMENT_BYTES,
  humanBytes,
  isInline,
  sha256Hex,
} from "@/lib/email/attachments.pure";
import type { OutboundAttachment } from "@/server/graph-client";

export const ATTACHMENT_BUCKET = "email-attachments";

export type AttachmentRow = {
  id: string;
  campaign_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  sha256: string;
  content_id: string;
  position: number;
};

/** What one message carried, as written to `email_campaign_messages.attachments`. */
export type AttachmentSnapshot = {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  inline: boolean;
};

export type PreparedAttachments = {
  outbound: OutboundAttachment[];
  snapshot: AttachmentSnapshot[];
  totalBytes: number;
};

export const NO_ATTACHMENTS: PreparedAttachments = { outbound: [], snapshot: [], totalBytes: 0 };

// Verified bytes, per isolate, keyed by id AND hash so a re-registered file can
// never be answered from an old copy. A running campaign would otherwise
// download the same file from storage every minute of its sending window.
const CACHE_BUDGET_BYTES = 48 * 1024 * 1024;
const cache = new Map<string, Uint8Array>();
let cachedBytes = 0;

function recall(key: string): Uint8Array | undefined {
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes to the back, so eviction takes the stalest.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function remember(key: string, bytes: Uint8Array): void {
  if (bytes.length > CACHE_BUDGET_BYTES || cache.has(key)) return;
  for (const [oldest, value] of cache) {
    if (cachedBytes + bytes.length <= CACHE_BUDGET_BYTES) break;
    cache.delete(oldest);
    cachedBytes -= value.length;
  }
  cache.set(key, bytes);
  cachedBytes += bytes.length;
}

/** Read an object from the attachments bucket, whole. */
export async function downloadStoredObject(path: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).download(path);
  if (error || !data) {
    throw new Error(`could not be read from storage: ${error?.message ?? "no data"}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

/** One file's bytes, proved to be what was registered. Throws otherwise. */
export async function readVerifiedAttachment(row: AttachmentRow): Promise<Uint8Array> {
  const key = `${row.id}:${row.sha256}`;
  const hit = recall(key);
  if (hit) return hit;

  let bytes: Uint8Array;
  try {
    bytes = await downloadStoredObject(row.storage_path);
  } catch (error) {
    throw new Error(`${row.file_name} ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length !== Number(row.size_bytes)) {
    throw new Error(
      `${row.file_name} in storage is ${humanBytes(bytes.length)}, not the ${humanBytes(Number(row.size_bytes))} that was attached`,
    );
  }
  if ((await sha256Hex(bytes)) !== row.sha256) {
    throw new Error(`${row.file_name} in storage no longer matches the file that was attached`);
  }
  remember(key, bytes);
  return bytes;
}

/** A campaign's attachment rows, in the order they were added. */
export async function campaignAttachmentRows(campaignId: string): Promise<AttachmentRow[]> {
  const { data, error } = await supabaseAdmin
    .from("email_campaign_attachments")
    .select(
      "id, campaign_id, file_name, content_type, size_bytes, storage_path, sha256, content_id, position",
    )
    .eq("campaign_id", campaignId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AttachmentRow[];
}

/**
 * Every file a message of this campaign carries, read and verified, with the
 * snapshot that records it. All or nothing.
 */
export async function prepareAttachments(
  rows: AttachmentRow[],
  body: string,
  bodyFormat: string,
): Promise<PreparedAttachments> {
  if (rows.length === 0) return NO_ATTACHMENTS;
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  if (totalBytes > MAX_CAMPAIGN_ATTACHMENT_BYTES) {
    throw new Error(
      `the attachments total ${humanBytes(totalBytes)}, over the ${humanBytes(MAX_CAMPAIGN_ATTACHMENT_BYTES)} one message may carry`,
    );
  }

  const outbound: OutboundAttachment[] = [];
  const snapshot: AttachmentSnapshot[] = [];
  for (const row of rows) {
    const bytes = await readVerifiedAttachment(row);
    const inline = isInline(row.content_id, body, bodyFormat);
    outbound.push({
      name: row.file_name,
      contentType: row.content_type,
      bytes,
      isInline: inline,
      contentId: row.content_id,
    });
    snapshot.push({
      id: row.id,
      file_name: row.file_name,
      content_type: row.content_type,
      size_bytes: Number(row.size_bytes),
      sha256: row.sha256,
      storage_path: row.storage_path,
      inline,
    });
  }
  return { outbound, snapshot, totalBytes };
}

/** A campaign's files, ready to send. */
export async function prepareCampaignAttachments(campaign: {
  id: string;
  body_template: string;
  body_format: string;
}): Promise<PreparedAttachments> {
  const rows = await campaignAttachmentRows(campaign.id);
  return prepareAttachments(rows, campaign.body_template ?? "", campaign.body_format);
}

/**
 * Delete a stored object. Logged rather than thrown: the callers are tidying
 * up after a refusal or a removal, and a stray object sends nothing.
 */
export async function removeStoredObject(path: string): Promise<void> {
  const { error } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).remove([path]);
  if (error) console.error(`[email] could not remove ${path} from storage:`, error.message);
}

/** Forget cached bytes for an attachment that has been removed. */
export function forgetAttachment(id: string): void {
  for (const [key, value] of cache) {
    if (!key.startsWith(`${id}:`)) continue;
    cache.delete(key);
    cachedBytes -= value.length;
  }
}
