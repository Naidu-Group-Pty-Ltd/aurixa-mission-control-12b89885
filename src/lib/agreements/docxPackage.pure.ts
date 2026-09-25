/**
 * A Word package, opened and written back out — and the one function that
 * turns an approved template into an issued offer document.
 *
 * `completeSubscriptionDocument` is deliberately the only path from template
 * bytes to issued bytes, so every issued document has passed the same gates
 * in the same order:
 *
 *   1. the template is opened (and must be a WordprocessingML package);
 *   2. every Order control is filled and unwrapped (`fillDocumentXml`, which
 *      refuses an unfilled or unknown field);
 *   3. the result must be an issued document — no control, no `[placeholder]`,
 *      each DocuSign anchor exactly once, well-formed XML — and no header,
 *      footer or note part may carry a control or a placeholder either;
 *   4. the document properties are replaced: the template's say "Approval
 *      draft … Populate the accepted Order before issue" and carry the last
 *      editor's personal name, neither of which belongs on an offer sent to a
 *      customer;
 *   5. the package is written and then READ BACK, and the document part must
 *      round-trip byte-for-byte — the archive is proven by reopening it, not
 *      assumed from having written it;
 *   6. its SHA-256 is taken, so the record says exactly which bytes went out.
 */
import { readCentralDirectory, readZipEntry } from "@/lib/email/zip.pure";
import {
  assertIssuedDocument,
  documentText,
  DocxFillError,
  escapeXmlText,
  fillDocumentXml,
  type DocumentFill,
} from "./docxFill.pure";
import { writeZip } from "./zipWriter.pure";

export type DocxPackage = {
  /** Part names in the order the source archive listed them. */
  order: string[];
  parts: Map<string, Uint8Array>;
};

const DOCUMENT_PART = "word/document.xml";
const CORE_PART = "docProps/core.xml";
const CONTENT_TYPES_PART = "[Content_Types].xml";

function checkPartName(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((seg) => seg === ".." || seg === ".")
  ) {
    throw new DocxFillError(`docx_bad_part_name: ${JSON.stringify(name)}`);
  }
}

/** Open a `.docx`. Directory entries are dropped; every part's bytes are held. */
export async function readDocx(bytes: Uint8Array): Promise<DocxPackage> {
  const entries = readCentralDirectory(bytes);
  const order: string[] = [];
  const parts = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    checkPartName(entry.name);
    if (parts.has(entry.name)) throw new DocxFillError(`docx_duplicate_part: ${entry.name}`);
    // Copy: a stored entry comes back as a view onto the source buffer.
    parts.set(entry.name, new Uint8Array(await readZipEntry(bytes, entry)));
    order.push(entry.name);
  }
  if (!parts.has(CONTENT_TYPES_PART) || !parts.has(DOCUMENT_PART)) {
    throw new DocxFillError("docx_not_wordprocessing: missing content types or document part");
  }
  return { order, parts };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function partText(pkg: DocxPackage, name: string): string {
  const bytes = pkg.parts.get(name);
  if (!bytes) throw new DocxFillError(`docx_missing_part: ${name}`);
  return utf8.decode(bytes);
}

export function setPartText(pkg: DocxPackage, name: string, text: string): void {
  checkPartName(name);
  if (!pkg.parts.has(name)) pkg.order.push(name);
  pkg.parts.set(name, encoder.encode(text));
}

/**
 * Write the package. XML parts are deflated; everything else (the JPEG and
 * PNG artwork, already compressed) is stored, which is what Word does too.
 */
export async function writeDocx(pkg: DocxPackage): Promise<Uint8Array> {
  return writeZip(
    pkg.order.map((name) => {
      const data = pkg.parts.get(name);
      if (!data) throw new DocxFillError(`docx_missing_part: ${name}`);
      return { name, data, compress: /\.(xml|rels)$/i.test(name) };
    }),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ───────────────────────────── document properties ───────────────────────────── */

export type IssuedDocumentMeta = {
  title: string;
  subject: string;
  keywords: string;
  description: string;
  /** ISO-8601; seconds precision is kept, milliseconds dropped. */
  issuedAt: string;
};

const ISSUER = "Aurixa Systems Pty Ltd";

function w3cdtf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new DocxFillError(`docx_bad_issue_time: ${iso}`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A fresh `docProps/core.xml`. Rebuilt rather than edited, so nothing from
 * the template's properties — a draft notice, an editor's name, a revision
 * count — can survive by being overlooked.
 */
export function issuedCoreProperties(meta: IssuedDocumentMeta): string {
  const at = w3cdtf(meta.issuedAt);
  const el = (tag: string, value: string) => `<${tag}>${escapeXmlText(value)}</${tag}>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    el("dc:title", meta.title) +
    el("dc:subject", meta.subject) +
    el("dc:creator", ISSUER) +
    el("cp:keywords", meta.keywords) +
    el("dc:description", meta.description) +
    el("cp:lastModifiedBy", ISSUER) +
    "<cp:revision>1</cp:revision>" +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${at}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${at}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

/* ───────────────────────────── issuing ───────────────────────────── */

/** Word parts other than the body that a reader sees: headers, footers, notes. */
function isSecondaryTextPart(name: string): boolean {
  return /^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(name);
}

export type CompletedDocument = {
  bytes: Uint8Array;
  sha256: string;
  /** The filled `word/document.xml`, for tests and previews. */
  documentXml: string;
};

export async function completeSubscriptionDocument(
  templateBytes: Uint8Array,
  fill: DocumentFill,
  opts: { anchors: readonly string[]; meta: IssuedDocumentMeta },
): Promise<CompletedDocument> {
  const pkg = await readDocx(templateBytes);
  if (!pkg.parts.has(CORE_PART)) throw new DocxFillError(`docx_missing_part: ${CORE_PART}`);

  const filled = fillDocumentXml(partText(pkg, DOCUMENT_PART), fill);
  assertIssuedDocument(filled, { anchors: opts.anchors });

  for (const name of pkg.order) {
    if (!isSecondaryTextPart(name)) continue;
    const xml = partText(pkg, name);
    if (/<w:sdt(?=[\s>])/.test(xml)) {
      throw new DocxFillError(`issued_document_still_has_controls: ${name}`);
    }
    if (documentText(xml).includes("[")) {
      throw new DocxFillError(`issued_document_has_placeholder: ${name}`);
    }
  }

  setPartText(pkg, DOCUMENT_PART, filled);
  setPartText(pkg, CORE_PART, issuedCoreProperties(opts.meta));
  const bytes = await writeDocx(pkg);

  const reopened = await readDocx(bytes);
  if (partText(reopened, DOCUMENT_PART) !== filled) {
    throw new DocxFillError("issued_document_round_trip_mismatch");
  }
  if (reopened.order.length !== pkg.order.length) {
    throw new DocxFillError("issued_document_part_count_mismatch");
  }

  return { bytes, sha256: await sha256Hex(bytes), documentXml: filled };
}
