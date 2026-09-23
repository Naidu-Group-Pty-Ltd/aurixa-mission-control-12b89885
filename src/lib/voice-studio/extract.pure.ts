// Text out of a client's documents, for the planner to read and for citations
// to be checked against.
//
// Four of the five kinds are read here, with the readers the email list import
// already trusts (zip.pure / xlsx.pure / workbook.pure). A PDF is not: it goes
// to the model whole, through the Anthropic Files API, because a PDF's text
// layer is often absent, reordered or split mid-word, and the model reads the
// page itself better than any text extraction this Worker could do. The cost
// of that is recorded honestly - a PDF citation cannot be checked against text
// we hold, so it is "model asserted" (confidence.pure.ts), never "verified".
//
// Two rules:
//
// - **Nothing is truncated silently.** Every reader has a ceiling, and a
//   document that hit one says so (`truncated`), which the Documents tab shows
//   and the planner is told - a plan built on the first half of a price list
//   must not look like one built on all of it.
// - **Extracted text is data.** It is handed to the model inside a document
//   block and never concatenated into an instruction (LESSONS.DOCUMENTS_ARE_DATA).
import { readCentralDirectory, readZipText, ZipError } from "../email/zip.pure";
import { decodeXmlText, readXlsx } from "../email/xlsx.pure";
import { decodeText, parseListFile, UnreadableFileError } from "../email/workbook.pure";

export const DOCUMENT_KINDS = ["pdf", "docx", "xlsx", "csv", "text"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Per-document ceiling on extracted text. About 100k tokens. */
export const MAX_DOCUMENT_CHARS = 400_000;
/** Per-sheet ceiling on rows read from a workbook or CSV. */
export const MAX_TABLE_ROWS = 5_000;
/** The bucket's own limit (20260924130000), repeated so the browser refuses first. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The Messages API refuses a request carrying more PDF pages than this. */
export const MAX_PDF_PAGES = 500;

export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"] as const;

export const MIME_FOR_KIND: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  text: "text/plain",
};

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

/**
 * The kind of a file, from its name first and its type second. A legacy .doc
 * or .xls is refused by name: a partial read of those formats produces text
 * that looks extracted and is not.
 */
export function documentKind(fileName: string, mimeType = ""): DocumentKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".markdown")) return "text";
  if (lower.endsWith(".doc") || lower.endsWith(".xls")) return null;
  const mime = mimeType.toLowerCase();
  for (const kind of DOCUMENT_KINDS) if (MIME_FOR_KIND[kind] === mime) return kind;
  if (mime === "text/markdown") return "text";
  return null;
}

export type Extracted = {
  kind: DocumentKind;
  /** null for a PDF - the model reads it natively. */
  text: string | null;
  truncated: boolean;
  /** PDFs only: an estimate from the page objects, used to refuse oversize requests. */
  pageCount: number | null;
  notes: string[];
};

/** Normalise whitespace and drop control characters a model has no use for. */
export function tidyText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Cut to the ceiling at a line boundary, and say so. */
export function capText(text: string, max = MAX_DOCUMENT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  return { text: text.slice(0, cut > max * 0.8 ? cut : max), truncated: true };
}

// ── Word ────────────────────────────────────────────────────────────────────

/**
 * The visible text of word/document.xml, paragraph by paragraph. Headings keep
 * a Markdown marker, list items a bullet and table rows their cells joined with
 * " | ", because the planner reads structure as well as words: a price list in
 * a table is a price list, not a run-on sentence.
 */
export function docxXmlToText(xml: string): string {
  const body = xml.replace(/<w:(?:instrText|delText)\b[^>]*>[\s\S]*?<\/w:(?:instrText|delText)>/g, "");
  const out: string[] = [];

  const paragraphText = (p: string): string => {
    let s = "";
    for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
      if (m[1] !== undefined) s += decodeXmlText(m[1]);
      else s += m[2] === "tab" ? "\t" : "\n";
    }
    return s;
  };

  const paragraph = (p: string): string => {
    const text = paragraphText(p).trim();
    if (!text) return "";
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(p)?.[1] ?? "";
    const heading = /^heading\s*([1-6])$/i.exec(style)?.[1];
    if (heading) return `${"#".repeat(Number(heading))} ${text}`;
    if (/^Title$/i.test(style)) return `# ${text}`;
    if (/<w:numPr>/.test(p) || /^List/i.test(style)) return `- ${text}`;
    return text;
  };

  // Walk top-level blocks: a table is emitted row by row; a paragraph once.
  const blocks = body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g);
  for (const b of blocks) {
    const block = b[0];
    if (block.startsWith("<w:tbl>")) {
      for (const row of block.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        const cells = [...row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) =>
          [...c[1].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
            .map((p) => paragraphText(p[0]).trim())
            .filter(Boolean)
            .join(" ")
            .replace(/\|/g, "/"),
        );
        if (cells.some(Boolean)) out.push(`| ${cells.join(" | ")} |`);
      }
      out.push("");
    } else {
      const line = paragraph(block);
      if (line) out.push(line, "");
    }
  }
  return tidyText(out.join("\n"));
}

export async function docxToText(bytes: Uint8Array): Promise<string> {
  let entries;
  try {
    entries = readCentralDirectory(bytes);
  } catch (err) {
    throw new ExtractionError(err instanceof ZipError ? `not a Word document: ${err.message}` : "not a Word document");
  }
  const xml = await readZipText(bytes, entries, "word/document.xml");
  if (xml == null) throw new ExtractionError("this is a zip archive but not a Word document - it carries no word/document.xml");
  return docxXmlToText(xml);
}

// ── Tables ──────────────────────────────────────────────────────────────────

/** Rows as pipe-table lines, with empty rows and empty trailing columns dropped. */
export function gridToPipeText(grid: string[][], maxRows = MAX_TABLE_ROWS): { text: string; truncated: boolean } {
  const rows = grid
    .map((r) => r.map((c) => String(c ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim()))
    .filter((r) => r.some(Boolean));
  let width = 0;
  for (const r of rows) {
    let last = r.length;
    while (last > 0 && !r[last - 1]) last--;
    if (last > width) width = last;
  }
  const kept = rows.slice(0, maxRows);
  const text = kept.map((r) => `| ${r.slice(0, width).join(" | ")} |`).join("\n");
  return { text, truncated: rows.length > maxRows };
}

export async function xlsxToText(bytes: Uint8Array): Promise<{ text: string; truncated: boolean; notes: string[] }> {
  let first;
  try {
    first = await readXlsx(bytes, { maxRows: MAX_TABLE_ROWS + 1, maxColumns: 64 });
  } catch (err) {
    throw new ExtractionError(err instanceof Error ? err.message : "the workbook could not be read");
  }
  const notes: string[] = [];
  const parts: string[] = [];
  let truncated = false;
  for (let i = 0; i < first.sheets.length; i++) {
    const sheet = first.sheets[i];
    if (sheet.hidden) {
      notes.push(`Hidden sheet "${sheet.name}" was not read.`);
      continue;
    }
    const read = i === first.sheetIndex ? first : await readXlsx(bytes, { sheetIndex: i, maxRows: MAX_TABLE_ROWS + 1, maxColumns: 64 });
    const table = gridToPipeText(read.grid);
    if (read.truncated || table.truncated) {
      truncated = true;
      notes.push(`Sheet "${sheet.name}" was longer than ${MAX_TABLE_ROWS} rows and was cut short.`);
    }
    if (table.text) parts.push(`## Sheet: ${sheet.name}\n\n${table.text}`);
  }
  return { text: tidyText(parts.join("\n\n")), truncated, notes };
}

export async function csvToText(bytes: Uint8Array, fileName: string): Promise<{ text: string; truncated: boolean; notes: string[] }> {
  try {
    const t = await parseListFile(bytes, fileName, { maxRows: MAX_TABLE_ROWS + 1 });
    const table = gridToPipeText([t.headers, ...t.rows]);
    return { text: tidyText(table.text), truncated: t.truncated || table.truncated, notes: t.notes };
  } catch (err) {
    // A "CSV" that is not a table is still text worth reading.
    if (err instanceof UnreadableFileError) return { text: tidyText(decodeText(bytes)), truncated: false, notes: [err.message] };
    throw err;
  }
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/**
 * Pages in a PDF, counted from its page objects. An estimate, used only to
 * refuse a request the API would refuse anyway; compressed object streams can
 * hide page objects, so null means "could not count", never zero.
 */
export function estimatePdfPages(bytes: Uint8Array): number | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 5));
  if (head !== "%PDF-") throw new ExtractionError("this file does not start like a PDF");
  const text = new TextDecoder("latin1").decode(bytes);
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages > 0) return pages;
  const count = [...text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,200}?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return count.length ? Math.max(...count) : null;
}

// ── One entry point ─────────────────────────────────────────────────────────

export async function extractDocument(bytes: Uint8Array, fileName: string, mimeType = ""): Promise<Extracted> {
  const kind = documentKind(fileName, mimeType);
  if (!kind) throw new ExtractionError(`"${fileName}" is not a type the studio reads (pdf, docx, xlsx, csv, txt, md)`);
  if (bytes.length === 0) throw new ExtractionError("the file is empty");

  if (kind === "pdf") {
    const pageCount = estimatePdfPages(bytes);
    if (pageCount != null && pageCount > MAX_PDF_PAGES) {
      throw new ExtractionError(`this PDF has about ${pageCount} pages; the model reads at most ${MAX_PDF_PAGES} in one request - split it`);
    }
    return { kind, text: null, truncated: false, pageCount, notes: [] };
  }

  let raw: string;
  let truncated = false;
  let notes: string[] = [];
  if (kind === "docx") raw = await docxToText(bytes);
  else if (kind === "xlsx") ({ text: raw, truncated, notes } = await xlsxToText(bytes));
  else if (kind === "csv") ({ text: raw, truncated, notes } = await csvToText(bytes, fileName));
  else raw = tidyText(decodeText(bytes));

  if (!raw) throw new ExtractionError("no readable text was found in this file");
  const capped = capText(raw);
  if (capped.truncated) notes = [...notes, `Only the first ${MAX_DOCUMENT_CHARS.toLocaleString("en-AU")} characters were kept.`];
  return { kind, text: capped.text, truncated: truncated || capped.truncated, pageCount: null, notes };
}

/** Hex SHA-256 of the bytes - the document's identity within a project. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
