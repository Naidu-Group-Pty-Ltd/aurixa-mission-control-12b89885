/**
 * Registering terms reads the file itself. These build real PDFs and real
 * Word packages — the same archive writer the issued agreements use — so what
 * is asserted is what `inspectTermsFile` makes of bytes, not of a description.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { writeDocx, type DocxPackage } from "./docxPackage.pure";
import {
  inspectTermsFile,
  isWordStoryPart,
  readWordPackageFacts,
} from "./builderPartnerTermsFile.pure";

const enc = new TextEncoder();

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const MACRO_CONTENT_TYPES = CONTENT_TYPES.replace(
  "wordprocessingml.document.main+xml",
  "application/vnd.ms-word.document.macroEnabled.main+xml",
);

function documentXml(body: string) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`
  );
}

const CLAUSE = "<w:p><w:r><w:t>The Builder Partner agrees to these terms.</w:t></w:r></w:p>";

function rels(...relationships: string[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    relationships.join("") +
    "</Relationships>"
  );
}

async function docx(parts: Record<string, string | Uint8Array> = {}): Promise<Uint8Array> {
  const all: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": CONTENT_TYPES,
    "word/document.xml": documentXml(CLAUSE),
    ...parts,
  };
  const pkg: DocxPackage = { order: [], parts: new Map() };
  for (const [name, value] of Object.entries(all)) {
    pkg.order.push(name);
    pkg.parts.set(name, typeof value === "string" ? enc.encode(value) : value);
  }
  return writeDocx(pkg);
}

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage().drawText(`Clause ${i + 1}`, { x: 50, y: 700 });
  return doc.save();
}

describe("which Word parts are the text a reader sees", () => {
  it("is the body and every header, footer, footnote and endnote", () => {
    for (const name of [
      "word/document.xml",
      "word/header1.xml",
      "word/footer12.xml",
      "word/header.xml",
      "word/footnotes.xml",
      "word/endnotes.xml",
    ]) {
      expect(isWordStoryPart(name)).toBe(true);
    }
  });

  it("is not the styles, settings, comments or relationships", () => {
    for (const name of [
      "word/styles.xml",
      "word/settings.xml",
      "word/comments.xml",
      "word/_rels/document.xml.rels",
      "customXml/document.xml",
      "word/document.xml.bak",
    ]) {
      expect(isWordStoryPart(name)).toBe(false);
    }
  });
});

describe("reading a Word package", () => {
  it("returns the parts, the content types, the story text and the relationships", async () => {
    const bytes = await docx({
      "word/footer1.xml": '<w:ftr xmlns:w="x"><w:p/></w:ftr>',
      "word/styles.xml": "<w:styles/>",
      "word/_rels/document.xml.rels": rels(),
    });
    const facts = await readWordPackageFacts(bytes);
    expect(facts.partNames).toEqual([
      "[Content_Types].xml",
      "word/document.xml",
      "word/footer1.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
    ]);
    expect(facts.contentTypesXml).toBe(CONTENT_TYPES);
    expect(facts.storyXml).toHaveLength(2);
    expect(facts.documentRelsXml).toContain("<Relationships");
  });

  it("reads a package with no document relationships as having none", async () => {
    const facts = await readWordPackageFacts(await docx());
    expect(facts.documentRelsXml).toBeNull();
  });
});

describe("inspectTermsFile", () => {
  it("registers a PDF and counts its pages", async () => {
    const result = await inspectTermsFile(await pdf(3), "Builder Partner Terms.pdf");
    expect(result).toEqual({
      ok: true,
      extension: "pdf",
      mediaType: "application/pdf",
      pageCount: 3,
      warnings: [],
    });
  });

  it("refuses an encrypted PDF, because DocuSign will not carry one", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.trailerInfo.Encrypt = doc.context.register(
      doc.context.obj({ Filter: "Standard", V: 1, R: 2 }),
    );
    const result = await inspectTermsFile(await doc.save(), "terms.pdf");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/password-protected or encrypted/);
  });

  it("refuses a PDF with no pages", async () => {
    // pdf-lib adds a blank page to a pageless document unless told not to.
    const empty = await (await PDFDocument.create()).save({ addDefaultPage: false });
    expect(await inspectTermsFile(empty, "terms.pdf")).toEqual({
      ok: false,
      error: "The PDF has no pages.",
    });
  });

  it("refuses a file that only begins like a PDF", async () => {
    const result = await inspectTermsFile(enc.encode("%PDF-1.7\nnot really a pdf"), "terms.pdf");
    expect(result.ok).toBe(false);
  });

  it("refuses a file whose name claims one kind and whose bytes are the other", async () => {
    const result = await inspectTermsFile(await pdf(1), "terms.docx");
    expect(result).toEqual({
      ok: false,
      error: "The file is named .docx but its contents are a PDF.",
    });
  });

  it("refuses anything that is neither a PDF nor a Word package", async () => {
    const result = await inspectTermsFile(enc.encode("{\\rtf1 terms}"), "terms.rtf");
    expect(result).toEqual({
      ok: false,
      error: "The terms must be a PDF or a Word (.docx) document.",
    });
  });

  it("registers a plain Word document with no page count and no warnings", async () => {
    const result = await inspectTermsFile(await docx(), "terms.docx");
    expect(result).toEqual({
      ok: true,
      extension: "docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pageCount: null,
      warnings: [],
    });
  });

  it("refuses a ZIP that is not a Word document", async () => {
    const pkg: DocxPackage = {
      order: ["notes.txt"],
      parts: new Map([["notes.txt", enc.encode("hello")]]),
    };
    const result = await inspectTermsFile(await writeDocx(pkg), "terms.docx");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be opened/);
  });

  it("refuses macros, in any of the three places they hide", async () => {
    for (const bytes of [
      await docx({ "word/vbaProject.bin": new Uint8Array([1, 2, 3]) }),
      await docx({ "word/activeX/activeX1.xml": "<ax/>" }),
      await docx({ "[Content_Types].xml": MACRO_CONTENT_TYPES }),
    ]) {
      const result = await inspectTermsFile(bytes, "terms.docx");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/macros or other active content/);
    }
  });

  it("refuses tracked changes in the body or in a footer", async () => {
    const inBody = await docx({
      "word/document.xml": documentXml(
        '<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>new words</w:t></w:r></w:ins></w:p>',
      ),
    });
    const inFooter = await docx({
      "word/footer1.xml":
        '<w:ftr xmlns:w="x"><w:p><w:del w:id="2"><w:r><w:delText>old</w:delText></w:r></w:del></w:p></w:ftr>',
    });
    for (const bytes of [inBody, inFooter]) {
      const result = await inspectTermsFile(bytes, "terms.docx");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/tracked changes/);
    }
  });

  it("does not mistake a table border for a tracked insertion", async () => {
    const bytes = await docx({
      "word/document.xml": documentXml(
        `<w:tbl><w:tblPr><w:tblBorders><w:insideH w:val="single"/></w:tblBorders></w:tblPr></w:tbl>${CLAUSE}`,
      ),
    });
    const result = await inspectTermsFile(bytes, "terms.docx");
    expect(result.ok).toBe(true);
  });

  it("refuses a master document whose sections live in other files", async () => {
    const bytes = await docx({
      "word/_rels/document.xml.rels": rels(
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/subDocument" Target="section2.docx" TargetMode="External"/>',
      ),
    });
    const result = await inspectTermsFile(bytes, "terms.docx");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/master document/);
  });

  it("registers, with a warning each, comments, a linked picture and a document with no text", async () => {
    const bytes = await docx({
      "word/document.xml": documentXml('<w:p><w:r><w:commentReference w:id="0"/></w:r></w:p>'),
      "word/comments.xml": '<w:comments xmlns:w="x"/>',
      "word/_rels/document.xml.rels": rels(
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///C:/logo.png" TargetMode="External"/>',
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://aurixa.example" TargetMode="External"/>',
      ),
    });
    const result = await inspectTermsFile(bytes, "terms.docx");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(3);
      expect(result.warnings[0]).toMatch(/comments/);
      // The hyperlink is a link a reader follows, not part of the file: one linked file.
      expect(result.warnings[1]).toMatch(/links to a file outside itself/);
      expect(result.warnings[2]).toMatch(/no text in it/);
    }
  });
});
