/**
 * Files a campaign sends with every message: what may be attached, how big,
 * and which of Microsoft Graph's two delivery paths a message takes.
 *
 * Three facts about Graph decide most of this file.
 *
 * **One request is about 4 MB, and `sendMail` carries its attachments inside
 * it, as base64.** Base64 is a third larger than the file, so a message whose
 * files total more than about 2.9 MB cannot be sent in one call at all. Such
 * a message is built as a DRAFT instead — create it, attach each file, then
 * send it — which costs more calls and needs `Mail.ReadWrite` as well as
 * `Mail.Send`. `deliveryPath` decides which, from an estimate of the request
 * rather than from the file sizes alone, because the body counts too.
 *
 * **A draft takes a file of 3 MB or more only through an upload session, and
 * refuses an upload session for anything smaller.** Graph answers
 * `ErrorAttachmentSizeShouldNotBeLessThanMinimumSize` below the line, and the
 * single POST it wants instead is itself bounded by the 4 MB request. So the
 * threshold is not a tuning knob; it is `UPLOAD_SESSION_MIN_BYTES`.
 *
 * **Exchange limits what one mailbox may upload: 150 MB in any five minutes.**
 * A campaign that attaches a 10 MB file to every message meets that ceiling at
 * fifteen messages, and Graph answers 429. The dispatcher already treats a 429
 * as "nothing was sent, try next tick", so the cap degrades into a slower
 * campaign rather than a broken one — but the operator should be told before
 * they press Start, not left wondering why 500 messages a day became 300.
 *
 * Everything here takes its inputs as arguments, so it runs in the browser
 * (the uploader checks a file before it is stored), in a server function (the
 * same check, which is the one that counts), and in the dispatcher.
 */
import { escapeHtml } from "@/lib/email/mergeTemplate.pure";

/**
 * What one message may carry in total. Also the largest one file may be, and
 * the bucket's own `file_size_limit` — the three are the same number on
 * purpose, and the migration's CHECK holds the database to it.
 *
 * Twenty rather than Exchange's thirty-five because the sender's ceiling is
 * not the one that matters: a receiving server that refuses 25 MB refuses the
 * whole message, and many corporate gateways stop well short of that.
 */
export const MAX_CAMPAIGN_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** More than this many files is a document library, not an email. */
export const MAX_ATTACHMENTS_PER_CAMPAIGN = 10;

/** Above this, warn that some receiving servers refuse the message outright. */
export const LARGE_MESSAGE_WARNING_BYTES = 10 * 1024 * 1024;

/**
 * The most a single `sendMail` request may weigh, by our estimate. Graph's
 * ceiling is 4 MB; this leaves headroom for what an estimate cannot see.
 */
export const SENDMAIL_REQUEST_LIMIT_BYTES = 3_900_000;

/** Upload sessions refuse files smaller than this; a single POST refuses larger. */
export const UPLOAD_SESSION_MIN_BYTES = 3 * 1024 * 1024;

/** One PUT to an upload session. Under Graph's 4 MB, and a multiple of 320 KiB. */
export const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024;

/** Exchange's per-mailbox upload allowance: this much in any five minutes. */
export const MAILBOX_UPLOAD_ALLOWANCE_BYTES = 150 * 1024 * 1024;

/**
 * Extensions Outlook blocks for the recipient, plus the scripting and disk
 * image types mail gateways quarantine on sight.
 *
 * Refused at upload rather than sent and discovered: a campaign is mail from
 * this business's own domain, an executable in it is how a domain's
 * reputation is lost in one afternoon, and the recipient could not have opened
 * it anyway.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "ade adp app application appref-ms asp aspx asx bas bat bgi cab cer chm cmd cnt com " +
    "cpl crt csh der diagcab dll exe fxp gadget grp hlp hpj hta htc inf ins iso isp its " +
    "jar jnlp js jse ksh lnk mad maf mag mam maq mar mas mat mau mav maw mcf mda mdb mde " +
    "mdt mdw mdz msc msh msh1 msh2 mshxml msh1xml msh2xml msi msix msixbundle msp mst msu " +
    "ops osd pcd pif pl plg prf prg printerexport ps1 ps1xml ps2 ps2xml psc1 psc2 psd1 " +
    "psdm1 pst py pyc pyo pyw pyz pyzw reg scf scr sct shb shs sys theme tmp url vb vbe " +
    "vbp vbs vhd vhdx vsmacros vsw webpnp website ws wsb wsc wsf wsh xbap xll xnk"
  ).split(" "),
);

/** Types worth naming when the browser could not, keyed by extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  ics: "text/calendar",
  vcf: "text/vcard",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/** The last extension of a file name, lowercased, or "" when it has none. */
export function fileExtension(fileName: string): string {
  const base =
    String(fileName ?? "")
      .trim()
      .split(/[\\/]/)
      .pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Why a file may not be attached, or null when it may.
 *
 * Read from the LAST extension, so `invoice.pdf.exe` is the executable it is.
 */
export function blockedReason(fileName: string): string | null {
  const name = String(fileName ?? "").trim();
  if (!name) return "the file has no name";
  if (name.length > 255) return "the file name is longer than 255 characters";
  const extension = fileExtension(name);
  if (extension && BLOCKED_EXTENSIONS.has(extension)) {
    return `.${extension} files are blocked by Outlook and quarantined by mail gateways, so they cannot be sent with a campaign`;
  }
  return null;
}

/**
 * The content type a file is sent as.
 *
 * The browser's label when it gave a useful one; otherwise the extension's
 * well-known type; otherwise the honest "some bytes".
 */
export function contentTypeFor(fileName: string, declared?: string | null): string {
  const label = String(declared ?? "")
    .trim()
    .toLowerCase();
  if (label && label !== "application/octet-stream" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(label)) {
    return label;
  }
  return MIME_BY_EXTENSION[fileExtension(fileName)] ?? "application/octet-stream";
}

/** Whether a recipient's mail client can show this file in the body. */
export function isImageType(contentType: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|bmp)$/.test(String(contentType ?? "").toLowerCase());
}

/** A storage object name that keeps the extension and nothing awkward. */
export function safeObjectName(fileName: string): string {
  const cleaned = String(fileName ?? "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;
  const extension = fileExtension(cleaned);
  const keep = extension ? 119 - extension.length : 120;
  return extension ? `${cleaned.slice(0, keep)}.${extension}` : cleaned.slice(0, 120);
}

/**
 * The name an HTML body uses to show this file inline: `cid:<id>`.
 *
 * Derived from the file name so the operator can guess it, lowercased and
 * reduced to what the column's CHECK admits, and made unique against the
 * campaign's other files by a numeric suffix.
 */
export function contentIdFor(fileName: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((value) => value.toLowerCase()));
  let base = String(fileName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 90)
    .replace(/[._-]+$/, "");
  if (!base) base = "attachment";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

const CID_REFERENCE = /\bcid:([a-z0-9][a-z0-9._-]*)/gi;

/** Every `cid:` an HTML body points at, lowercased. */
export function referencedContentIds(body: string): Set<string> {
  const out = new Set<string>();
  for (const match of String(body ?? "").matchAll(CID_REFERENCE)) {
    out.add(match[1].toLowerCase().replace(/[._-]+$/, ""));
  }
  return out;
}

/**
 * Whether a file travels inline — shown in the body — or as an ordinary
 * attachment.
 *
 * Decided by the body, not by a toggle: an inline file IS one the body
 * refers to. A toggle could disagree with the body, and both ways round that
 * is a visible defect — an image marked inline that nothing shows is hidden
 * from the reader, and one the body shows that is not marked inline arrives
 * as a broken picture plus a stray attachment.
 */
export function isInline(contentId: string, body: string, bodyFormat: string): boolean {
  if (bodyFormat === "text") return false;
  return referencedContentIds(body).has(String(contentId ?? "").toLowerCase());
}

/** Length of the base64 encoding of `size` bytes. */
export function base64Length(size: number): number {
  return Math.ceil(Math.max(0, size) / 3) * 4;
}

export type DeliveryPath = "sendmail" | "draft";

/**
 * How heavy one `sendMail` request carrying these files would be.
 *
 * `messageJsonBytes` is the UTF-8 size of the request without its attachments;
 * each file adds its base64 plus the few hundred bytes of JSON around it.
 */
export function estimateSendMailBytes(
  messageJsonBytes: number,
  attachments: { size: number; name: string }[],
): number {
  let total = Math.max(0, messageJsonBytes);
  for (const attachment of attachments) {
    total += base64Length(attachment.size) + String(attachment.name ?? "").length * 2 + 256;
  }
  return total;
}

/** One `sendMail` when it fits, otherwise a draft built in steps. */
export function deliveryPath(
  estimatedSendMailBytes: number,
  attachmentCount: number,
): DeliveryPath {
  if (attachmentCount === 0) return "sendmail";
  return estimatedSendMailBytes <= SENDMAIL_REQUEST_LIMIT_BYTES ? "sendmail" : "draft";
}

/**
 * A rough answer to "which path will this campaign's messages take", for the
 * page, where the exact body of the next message is not known. Errs towards
 * "draft" by assuming the body is as large as the template.
 */
export function likelyDeliveryPath(
  totalAttachmentBytes: number,
  attachmentCount: number,
  bodyLength: number,
): DeliveryPath {
  const estimate =
    Math.ceil(bodyLength * 1.2) + 4096 + base64Length(totalAttachmentBytes) + attachmentCount * 512;
  return deliveryPath(estimate, attachmentCount);
}

/** Inclusive byte ranges for an upload session, in order. */
export function uploadRanges(
  size: number,
  chunk: number = UPLOAD_CHUNK_BYTES,
): { start: number; end: number }[] {
  if (!Number.isFinite(size) || size <= 0) return [];
  const step = Math.max(1, Math.floor(chunk));
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += step) {
    out.push({ start, end: Math.min(size, start + step) - 1 });
  }
  return out;
}

/**
 * Base64 without `Buffer`, so the same code runs in a Worker and a browser.
 * Built in slices: `String.fromCharCode(...bytes)` over a whole file is a
 * call with a million arguments, and that is a stack overflow.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const slice = 0x8000;
  for (let at = 0; at < bytes.length; at += slice) {
    binary += String.fromCharCode(...bytes.subarray(at, at + slice));
  }
  return btoa(binary);
}

/** Hex SHA-256 of some bytes, through the platform's own digest. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Can another file join these? Returns the sentence that says why not.
 * The same check runs in the uploader and in the server function that
 * registers the file — the second is the one that counts.
 */
export function admissionProblem(
  candidate: { fileName: string; sizeBytes: number },
  existing: { sizeBytes: number }[],
): string | null {
  const blocked = blockedReason(candidate.fileName);
  if (blocked) return blocked;
  if (!Number.isFinite(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
    return "the file is empty";
  }
  if (existing.length >= MAX_ATTACHMENTS_PER_CAMPAIGN) {
    return `a campaign carries at most ${MAX_ATTACHMENTS_PER_CAMPAIGN} files`;
  }
  const already = existing.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (already + candidate.sizeBytes > MAX_CAMPAIGN_ATTACHMENT_BYTES) {
    return `that would make the message carry ${humanBytes(already + candidate.sizeBytes)} of files; the ceiling is ${humanBytes(MAX_CAMPAIGN_ATTACHMENT_BYTES)}, because a receiving server that refuses a large message refuses all of it`;
  }
  return null;
}

/**
 * Messages a campaign's rules allow in five minutes, for the upload-allowance
 * warning. Ceiling of the tick cap, floor of the gap.
 */
export function messagesPerFiveMinutes(rules: {
  minGapSeconds: number;
  maxMessagesPerRun: number;
}): number {
  const perRun = Math.max(1, rules.maxMessagesPerRun || 1);
  if (rules.minGapSeconds > 0) {
    return Math.max(1, Math.min(perRun * 5, Math.floor(300 / rules.minGapSeconds) || 1));
  }
  return perRun * 5;
}

export type AttachmentReadinessInput = {
  attachments: { contentId: string; fileName: string; sizeBytes: number; contentType: string }[];
  body: string;
  bodyFormat: string;
  minGapSeconds: number;
  maxMessagesPerRun: number;
  /**
   * Whether the application's token carries `Mail.ReadWrite`. `null` when the
   * token could not be read, or when Exchange grants access some other way.
   */
  canBuildDrafts: boolean | null;
};

/** What attachments add to a campaign's go / no-go. */
export function attachmentReadiness(input: AttachmentReadinessInput): {
  blocking: string[];
  warnings: string[];
  totalBytes: number;
  path: DeliveryPath;
} {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const totalBytes = input.attachments.reduce((sum, file) => sum + file.sizeBytes, 0);
  const html = input.bodyFormat !== "text";
  const path = likelyDeliveryPath(totalBytes, input.attachments.length, input.body.length);

  if (totalBytes > MAX_CAMPAIGN_ATTACHMENT_BYTES) {
    blocking.push(
      `the attachments total ${humanBytes(totalBytes)}, over the ${humanBytes(MAX_CAMPAIGN_ATTACHMENT_BYTES)} one message may carry`,
    );
  }
  if (input.attachments.length > MAX_ATTACHMENTS_PER_CAMPAIGN) {
    blocking.push(`the campaign carries more than ${MAX_ATTACHMENTS_PER_CAMPAIGN} files`);
  }
  for (const file of input.attachments) {
    const blocked = blockedReason(file.fileName);
    if (blocked) blocking.push(`${file.fileName}: ${blocked}`);
  }

  const provided = new Set(input.attachments.map((file) => file.contentId.toLowerCase()));
  if (html) {
    const missing = [...referencedContentIds(input.body)].filter((id) => !provided.has(id));
    if (missing.length > 0) {
      blocking.push(
        `the body shows ${missing.map((id) => `cid:${id}`).join(", ")}, which no attachment provides — every reader would see a broken image`,
      );
    }
  } else if (referencedContentIds(input.body).size > 0) {
    warnings.push(
      "the body is plain text, so its cid: references are shown as text — switch it to HTML to show those images",
    );
  }

  if (input.attachments.length === 0) return { blocking, warnings, totalBytes, path };

  if (totalBytes > LARGE_MESSAGE_WARNING_BYTES) {
    warnings.push(
      `every message carries ${humanBytes(totalBytes)} of files — some receiving servers refuse messages this large, and a refusal comes back as a bounce`,
    );
  }

  if (path === "draft") {
    warnings.push(
      input.canBuildDrafts === false
        ? `at ${humanBytes(totalBytes)} the files are too large for one sendMail request, so each message is built as a draft — that needs the Mail.ReadWrite application permission, which this application's token does not carry; unless Exchange grants it another way, the first message will be refused and the campaign will pause`
        : `at ${humanBytes(totalBytes)} the files are too large for one sendMail request, so each message is built as a draft and its files uploaded in pieces (this uses the Mail.ReadWrite permission)`,
    );
  }

  const perMessage = path === "sendmail" ? base64Length(totalBytes) : totalBytes;
  const perFive = messagesPerFiveMinutes(input);
  if (perMessage * perFive > MAILBOX_UPLOAD_ALLOWANCE_BYTES) {
    const sustainable = Math.max(1, Math.floor(MAILBOX_UPLOAD_ALLOWANCE_BYTES / perMessage));
    warnings.push(
      `Microsoft lets one mailbox upload about ${humanBytes(MAILBOX_UPLOAD_ALLOWANCE_BYTES)} in five minutes; with ${humanBytes(totalBytes)} on every message that is about ${sustainable} message${sustainable === 1 ? "" : "s"} per five minutes, fewer than these rules allow (${perFive}) — expect Microsoft to throttle, which slows the campaign but never loses or repeats a message`,
    );
  }

  return { blocking, warnings, totalBytes, path };
}

/**
 * The preview's body with each inline `cid:` swapped for a URL the browser can
 * load. Only the preview: the message itself keeps `cid:`, which is what a
 * mail client resolves against the attachment.
 */
export function previewInlineImages(body: string, urls: Map<string, string>): string {
  return String(body ?? "").replace(CID_REFERENCE, (whole, id: string) => {
    const url = urls.get(id.toLowerCase().replace(/[._-]+$/, ""));
    return url ? escapeHtml(url) : whole;
  });
}
