/**
 * Whether an uploaded file can be registered as the Builder Partner Agreement
 * terms — read from the file itself, before anything is stored.
 *
 * The terms are supplied later, as whatever document the agreement is. What
 * Mission Control checks is not the wording (nothing here reads a clause) but
 * that the file is a document DocuSign will carry and a builder can be bound
 * to exactly:
 *
 *  * it is a PDF or a Word document by its own bytes, within the size limit
 *    (`checkTemplateUpload`);
 *  * a PDF opens, is not encrypted — DocuSign refuses a protected PDF, and one
 *    that failed at the send would stop every agreement — and has pages;
 *  * a Word document opens as a package and passes `assessWordTerms`: no
 *    active content, no tracked changes, no sections living in other files.
 *
 * It is separate from `builderPartner.pure.ts` because it opens files (pdf-lib
 * and the ZIP reader), and that module is imported by the browser.
 */
import { PDFDocument } from "pdf-lib";
import {
  assessWordTerms,
  checkTemplateUpload,
  type TemplateExtension,
  type TemplateMediaType,
  type WordPackageFacts,
} from "./builderPartner.pure";
import { partText, readDocx } from "./docxPackage.pure";

export type TermsFileInspection =
  | {
      ok: true;
      extension: TemplateExtension;
      mediaType: TemplateMediaType;
      /** A PDF's own page count; null for a Word document, which has none until it is laid out. */
      pageCount: number | null;
      /** Worth a person's look before the terms are put in force; none refuses the file. */
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * The Word parts a reader sees: the body and every header, footer, footnote
 * and endnote. Tracked changes or comments anywhere in these are in the text.
 */
export function isWordStoryPart(name: string): boolean {
  return /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name);
}

const CONTENT_TYPES_PART = "[Content_Types].xml";
const DOCUMENT_RELS_PART = "word/_rels/document.xml.rels";

/** The facts `assessWordTerms` judges, read out of the package. */
export async function readWordPackageFacts(bytes: Uint8Array): Promise<WordPackageFacts> {
  const pkg = await readDocx(bytes);
  return {
    partNames: [...pkg.order],
    contentTypesXml: partText(pkg, CONTENT_TYPES_PART),
    storyXml: pkg.order.filter(isWordStoryPart).map((name) => partText(pkg, name)),
    documentRelsXml: pkg.parts.has(DOCUMENT_RELS_PART) ? partText(pkg, DOCUMENT_RELS_PART) : null,
  };
}

export async function inspectTermsFile(
  bytes: Uint8Array,
  fileName: string,
): Promise<TermsFileInspection> {
  const upload = checkTemplateUpload(bytes, fileName);
  if (!upload.ok) return upload;

  if (upload.extension === "pdf") {
    const unreadable = {
      ok: false as const,
      error: "The PDF could not be read. Export it again from the original and upload that.",
    };
    // The document is asked whether it is encrypted; the error is not. pdf-lib
    // throws an `EncryptedPDFError`, but its classes are compiled down to ES5,
    // so what arrives is a bare `Error` and `instanceof` never matches — the
    // check read correctly and sent every protected PDF to the wrong remedy.
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    } catch {
      return unreadable;
    }
    if (doc.isEncrypted) {
      return {
        ok: false,
        error:
          "The PDF is password-protected or encrypted, and DocuSign will not carry a protected PDF. Save an unprotected copy and upload that.",
      };
    }
    let pageCount: number;
    try {
      pageCount = doc.getPageCount();
    } catch {
      return unreadable;
    }
    if (pageCount < 1) return { ok: false, error: "The PDF has no pages." };
    return {
      ok: true,
      extension: "pdf",
      mediaType: upload.mediaType,
      pageCount,
      warnings: [],
    };
  }

  let facts: WordPackageFacts;
  try {
    facts = await readWordPackageFacts(bytes);
  } catch {
    return {
      ok: false,
      error:
        "The Word document could not be opened. Save it again from Word as a .docx and upload that.",
    };
  }
  const assessed = assessWordTerms(facts);
  if (!assessed.ok) return assessed;
  return {
    ok: true,
    extension: "docx",
    mediaType: upload.mediaType,
    pageCount: null,
    warnings: assessed.warnings,
  };
}
