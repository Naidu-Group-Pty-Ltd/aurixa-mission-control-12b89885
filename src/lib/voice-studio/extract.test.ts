import { describe, expect, it } from "vitest";
import {
  capText,
  docxXmlToText,
  documentKind,
  estimatePdfPages,
  extractDocument,
  ExtractionError,
  gridToPipeText,
  sha256OfBytes,
} from "./extract.pure";

// A stored (uncompressed) ZIP writer, so extraction is tested against real
// archive bytes. parsers.test.ts has the deflating version; stored is enough
// here because inflation is zip.pure's concern and is tested there.
function makeZip(files: { name: string; text: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.text);
    const local = new Uint8Array(30 + name.length + raw.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, raw.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(raw, 30 + name.length);
    locals.push(local);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, raw.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const dirSize = centrals.reduce((t, c) => t + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const DOCX_XML = `<w:document><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Harbourside Dental</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">We offer check-ups &amp; cleans.</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Whitening</w:t></w:r></w:p>
  <w:p/>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>Service</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Price</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Clean</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$190</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:instrText>HYPERLINK "x"</w:instrText><w:t>Book online</w:t></w:r></w:p>
</w:body></w:document>`;

describe("documentKind", () => {
  it("reads the kind from the name, then the type", () => {
    expect(documentKind("Brochure.PDF")).toBe("pdf");
    expect(documentKind("faq.docx")).toBe("docx");
    expect(documentKind("prices.xlsx")).toBe("xlsx");
    expect(documentKind("list.csv")).toBe("csv");
    expect(documentKind("notes.md")).toBe("text");
    expect(documentKind("blob", "application/pdf")).toBe("pdf");
  });

  it("refuses legacy Office formats rather than half-reading them", () => {
    expect(documentKind("old.doc")).toBeNull();
    expect(documentKind("old.xls")).toBeNull();
    expect(documentKind("image.png", "image/png")).toBeNull();
  });
});

describe("docx", () => {
  it("keeps headings, bullets and table rows, and drops field codes", () => {
    const text = docxXmlToText(DOCX_XML);
    expect(text).toContain("# Harbourside Dental");
    expect(text).toContain("We offer check-ups & cleans.");
    expect(text).toContain("- Whitening");
    expect(text).toContain("| Service | Price |");
    expect(text).toContain("| Clean | $190 |");
    expect(text).toContain("Book online");
    expect(text).not.toContain("HYPERLINK");
  });

  it("reads word/document.xml out of a real archive", async () => {
    const bytes = makeZip([{ name: "word/document.xml", text: DOCX_XML }]);
    const r = await extractDocument(bytes, "faq.docx");
    expect(r.kind).toBe("docx");
    expect(r.text).toContain("| Clean | $190 |");
    expect(r.truncated).toBe(false);
  });

  it("names a zip that is not a Word document", async () => {
    const bytes = makeZip([{ name: "xl/workbook.xml", text: "<workbook/>" }]);
    await expect(extractDocument(bytes, "faq.docx")).rejects.toThrow(/not a Word document/);
  });
});

describe("xlsx", () => {
  it("reads every visible sheet as a pipe table and names the hidden one", async () => {
    const bytes = makeZip([
      {
        name: "xl/workbook.xml",
        text: `<workbook><sheets><sheet name="Prices" sheetId="1" r:id="rId1"/><sheet name="Staff" sheetId="2" r:id="rId2"/><sheet name="Secret" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        text: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        text: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Service</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Clean</t></is></c><c r="B2"><v>190</v></c></row></sheetData></worksheet>`,
      },
      {
        name: "xl/worksheets/sheet2.xml",
        text: `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Dr Lee</t></is></c></row></sheetData></worksheet>`,
      },
      { name: "xl/worksheets/sheet3.xml", text: `<worksheet><sheetData/></worksheet>` },
    ]);
    const r = await extractDocument(bytes, "prices.xlsx");
    expect(r.text).toContain("## Sheet: Prices");
    expect(r.text).toContain("| Clean | 190 |");
    expect(r.text).toContain("## Sheet: Staff");
    expect(r.text).not.toContain("Secret");
    expect(r.notes.join(" ")).toMatch(/Hidden sheet "Secret"/);
  });
});

describe("csv and text", () => {
  it("reads a CSV as a table", async () => {
    const r = await extractDocument(new TextEncoder().encode("Service,Price\nClean,190\n"), "prices.csv");
    expect(r.text).toBe("| Service | Price |\n| Clean | 190 |");
  });

  it("reads Markdown as text and tidies it", async () => {
    const r = await extractDocument(new TextEncoder().encode("# Hours\r\n\r\n\r\n\r\nMon-Fri  \r\n"), "about.md");
    expect(r.text).toBe("# Hours\n\nMon-Fri");
  });

  it("refuses an empty file", async () => {
    await expect(extractDocument(new Uint8Array(), "a.txt")).rejects.toBeInstanceOf(ExtractionError);
  });
});

describe("ceilings are said, never silent", () => {
  it("capText cuts at a line and flags it", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const r = capText(text, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r.text.endsWith("\n")).toBe(false);
  });

  it("a table over the row ceiling says so", () => {
    const grid = Array.from({ length: 12 }, (_, i) => [`r${i}`, ""]);
    const r = gridToPipeText(grid, 10);
    expect(r.truncated).toBe(true);
    expect(r.text.split("\n")).toHaveLength(10);
    expect(r.text.split("\n")[0]).toBe("| r0 |");
  });
});

describe("pdf", () => {
  it("is not extracted here - it goes to the model whole - but its pages are counted", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj <</Type /Pages /Count 2>>\n2 0 obj <</Type /Page>>\n3 0 obj <</Type /Page>>\n");
    expect(estimatePdfPages(pdf)).toBe(2);
    const r = await extractDocument(pdf, "brochure.pdf");
    expect(r).toMatchObject({ kind: "pdf", text: null, pageCount: 2 });
  });

  it("refuses a PDF the API would refuse", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n" + "<</Type /Page>>\n".repeat(501));
    await expect(extractDocument(pdf, "huge.pdf")).rejects.toThrow(/split it/);
  });

  it("refuses a file that only claims to be a PDF", async () => {
    await expect(extractDocument(new TextEncoder().encode("hello"), "fake.pdf")).rejects.toThrow(/does not start like a PDF/);
  });
});

it("hashes bytes", async () => {
  expect(await sha256OfBytes(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
