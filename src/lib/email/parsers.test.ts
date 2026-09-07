import { describe, expect, it } from "vitest";
import { emailKey, extractAddresses, isValidEmail, unwrapAddress } from "./emailAddress.pure";
import { readDelimited, sniffDelimiter, parseDelimited } from "./tabular.pure";
import { readCentralDirectory, readZipEntry } from "./zip.pure";
import {
  columnIndexOf,
  decodeXmlText,
  excelSerialToIso,
  formatCodeIsDate,
  parseDateStyles,
  parseSharedStrings,
  parseWorkbookSheets,
  parseWorksheet,
  readXlsx,
} from "./xlsx.pure";
import { decodeText, parseListFile, splitHeaderRow, tableFromRecords } from "./workbook.pure";

// ── A minimal ZIP writer, so the reader is tested against bytes rather than
// against a fixture nobody can inspect. CRC fields are left zero: this reader
// deliberately does not verify them (a corrupt member fails at inflate), so
// writing a real CRC here would test nothing.
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeZip(files: { name: string; text: string; deflate?: boolean }[]) {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = encoder.encode(file.text);
    const method = file.deflate ? 8 : 0;
    const payload = file.deflate ? await deflateRaw(raw) : raw;

    const local = new Uint8Array(30 + name.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(payload, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const directorySize = centrals.reduce((total, c) => total + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);

  const total = locals.reduce((t, l) => t + l.length, 0) + directorySize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const WORKBOOK_XML = `<?xml version="1.0"?><workbook><sheets>
  <sheet name="Contacts" sheetId="1" r:id="rId1"/>
  <sheet name="Notes" sheetId="2" r:id="rId2" state="hidden"/>
</sheets></workbook>`;

const RELS_XML = `<?xml version="1.0"?><Relationships>
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>`;

describe("emailAddress.pure", () => {
  it("reads one identity out of every spelling of the same mailbox", () => {
    const spellings = [
      "Bob@Example.COM",
      "  bob@example.com  ",
      '"Bob Smith" <BOB@Example.com>',
      "<bob@example.com>",
      "mailto:Bob@Example.com",
    ];
    expect(new Set(spellings.map(emailKey))).toEqual(new Set(["bob@example.com"]));
  });

  it("keeps the address as written separate from the identity", () => {
    expect(unwrapAddress('"Jane Doe" <Jane.Doe@Example.com>')).toBe("Jane.Doe@Example.com");
  });

  it("refuses the shapes a mangled cell produces", () => {
    for (const bad of [
      "",
      "not-an-address",
      "no-domain@",
      "@no-local.com",
      "two@@ats.com",
      "spaces in@example.com",
      "trailing.dot.@example.com",
      "double..dot@example.com",
      "user@localhost",
      "user@example.123",
      "user@-leading-hyphen.com",
      `${"a".repeat(65)}@example.com`,
    ]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it("accepts the addresses a real list carries", () => {
    for (const good of [
      "a@b.co",
      "first.last+campaign@sub.domain.com.au",
      "o'brien@example.org",
      "user_name-123@example-host.net",
    ]) {
      expect(isValidEmail(good), good).toBe(true);
    }
  });

  it("pulls addresses out of prose without the surrounding punctuation", () => {
    const text =
      "Delivery failed for <a.person@example.com>. Also b@x.co.uk, and a.person@EXAMPLE.com.";
    expect(extractAddresses(text)).toEqual(["a.person@example.com", "b@x.co.uk"]);
  });
});

describe("tabular.pure", () => {
  it("keeps a quoted field whole when it contains the delimiter", () => {
    const table = readDelimited('name,email\n"Smith, John",j@x.com\n');
    expect(table.rows[0]).toEqual(["Smith, John", "j@x.com"]);
  });

  it("handles doubled quotes and embedded newlines", () => {
    const table = readDelimited('a,b\n"He said ""hi""","line one\nline two"\n');
    expect(table.rows[0]).toEqual(['He said "hi"', "line one\nline two"]);
  });

  it("sniffs semicolons and tabs rather than assuming a comma", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3\n4;5;6\n")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(sniffDelimiter("a,b,c\n1,2,3\n")).toBe(",");
  });

  it("does not let a comma inside prose beat the real separator", () => {
    const text = "name;email\nSmith, John;j@x.com\nDoe, Jane;d@x.com\n";
    expect(sniffDelimiter(text)).toBe(";");
  });

  it("strips the byte-order mark Excel writes, so the first key is usable", () => {
    const table = readDelimited("\uFEFFemail,state\na@b.com,NSW\n");
    expect(table.headers).toEqual(["email", "state"]);
  });

  it("skips leading furniture and takes the first row with content as the header", () => {
    const table = readDelimited("\n\nemail,state\na@b.com,NSW\n");
    expect(table.headers).toEqual(["email", "state"]);
    expect(table.rows).toEqual([["a@b.com", "NSW"]]);
  });

  it("pads a short row so callers can index by column", () => {
    const table = readDelimited("a,b,c\n1,2\n");
    expect(table.rows[0]).toEqual(["1", "2", ""]);
  });

  it("treats CRLF and a lone CR as record ends", () => {
    expect(parseDelimited("a,b\r\n1,2\r3,4", ",").all).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("zip.pure", () => {
  it("reads stored and deflated members from the central directory", async () => {
    const bytes = await makeZip([
      { name: "plain.txt", text: "hello" },
      { name: "packed.txt", text: "x".repeat(500), deflate: true },
    ]);
    const entries = readCentralDirectory(bytes);
    expect(entries.map((e) => e.name)).toEqual(["plain.txt", "packed.txt"]);
    expect(new TextDecoder().decode(await readZipEntry(bytes, entries[0]))).toBe("hello");
    expect(new TextDecoder().decode(await readZipEntry(bytes, entries[1]))).toBe("x".repeat(500));
  });

  it("refuses something that is not an archive", () => {
    expect(() =>
      readCentralDirectory(new TextEncoder().encode("just some text, not a zip at all")),
    ).toThrow(/not a zip archive/);
  });
});

describe("xlsx.pure", () => {
  it("maps A1 references to column indexes past Z", () => {
    expect(columnIndexOf("A1")).toBe(0);
    expect(columnIndexOf("Z9")).toBe(25);
    expect(columnIndexOf("AA1")).toBe(26);
    expect(columnIndexOf("BC42")).toBe(54);
  });

  it("decodes entities and Excel's own carriage-return escape", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &#65;&#x42;")).toBe("a & b <c> AB");
    expect(decodeXmlText("line_x000D_break")).toBe("line\rbreak");
  });

  it("converts serials on both sides of the 1900 leap-year bug", () => {
    expect(excelSerialToIso(45000, false)).toBe("2023-03-15");
    expect(excelSerialToIso(1, false)).toBe("1900-01-01");
    expect(excelSerialToIso(61, false)).toBe("1900-03-01");
    expect(excelSerialToIso(0, true)).toBe("1904-01-01");
  });

  it("keeps the time when the serial carries one", () => {
    expect(excelSerialToIso(45000.5, false)).toBe("2023-03-15T12:00:00");
  });

  it("does not read literals in a format code as date tokens", () => {
    expect(formatCodeIsDate("dd/mm/yyyy")).toBe(true);
    expect(formatCodeIsDate("General")).toBe(false);
    expect(formatCodeIsDate('[Red]#,##0.00;"deficit"')).toBe(false);
    expect(formatCodeIsDate("0.00%")).toBe(false);
  });

  it("joins rich-text runs and ignores phonetic runs", () => {
    const xml =
      `<sst><si><t>plain</t></si><si><r><t>rich </t></r><r><t>text</t></r></si>` +
      `<si><t>kanji</t><rPh sb="0"><t>furigana</t></rPh></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(["plain", "rich text", "kanji"]);
  });

  it("resolves built-in and custom date formats through cellXfs", () => {
    const xml =
      `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>` +
      `<numFmt numFmtId="165" formatCode="0.000"/></numFmts>` +
      `<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
    expect(parseDateStyles(xml)).toEqual([false, true, true, false]);
  });

  it("joins sheets to their parts through the relationships", () => {
    const sheets = parseWorkbookSheets(WORKBOOK_XML, RELS_XML);
    expect(sheets).toEqual([
      { name: "Contacts", path: "xl/worksheets/sheet1.xml", hidden: false },
      { name: "Notes", path: "xl/worksheets/sheet2.xml", hidden: true },
    ]);
  });

  it("places cells by their reference, so a missing cell does not shift the row", () => {
    const xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2" t="s"><v>4</v></c></row>
    </sheetData></worksheet>`;
    const { grid } = parseWorksheet(
      xml,
      ["email", "state", "phone", "a@b.com", "0400"],
      [],
      false,
      1000,
      100,
    );
    // The phone lands in column C, not in B where counting would have put it.
    expect(grid[1]).toEqual(["a@b.com", "", "0400"]);
  });

  it("reads inline strings, booleans and date-styled numbers", () => {
    const xml = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c>
                 <c r="B1" t="b"><v>1</v></c>
                 <c r="C1" s="1"><v>45000</v></c>
                 <c r="D1"><v>2000</v></c></row>
    </sheetData></worksheet>`;
    const { grid } = parseWorksheet(xml, [], [false, true], false, 1000, 100);
    expect(grid[0]).toEqual(["Inline", "TRUE", "2023-03-15", "2000"]);
  });

  it("reads a whole workbook out of zip bytes", async () => {
    const bytes = await makeZip([
      { name: "xl/workbook.xml", text: WORKBOOK_XML },
      { name: "xl/_rels/workbook.xml.rels", text: RELS_XML },
      {
        name: "xl/sharedStrings.xml",
        text: `<sst><si><t>Email</t></si><si><t>State</t></si><si><t>a@b.com</t></si><si><t>NSW</t></si></sst>`,
        deflate: true,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        text: `<worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
          <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
        </sheetData></worksheet>`,
        deflate: true,
      },
    ]);
    const read = await readXlsx(bytes);
    expect(read.sheets.map((s) => s.name)).toEqual(["Contacts", "Notes"]);
    expect(read.grid).toEqual([
      ["Email", "State"],
      ["a@b.com", "NSW"],
    ]);
  });

  it("names the problem when a zip is not a workbook", async () => {
    const bytes = await makeZip([{ name: "word/document.xml", text: "<document/>" }]);
    await expect(readXlsx(bytes)).rejects.toThrow(/not a spreadsheet/);
  });
});

describe("workbook.pure", () => {
  it("decodes UTF-16 with a byte-order mark", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00]);
    expect(decodeText(utf16)).toBe("a,b");
  });

  it("recognises UTF-16 that carries no mark", () => {
    const bytes = new Uint8Array(
      "email,state\na@b.com,NSW\n".split("").flatMap((ch) => [ch.charCodeAt(0), 0]),
    );
    expect(decodeText(bytes)).toContain("email,state");
  });

  it("takes the union of keys across records, in first-seen order", () => {
    const table = tableFromRecords([
      { email: "a@b.com", state: "NSW" },
      { email: "c@d.com", suburb: "Bondi" },
    ]);
    expect(table.headers).toEqual(["email", "state", "suburb"]);
    expect(table.rows).toEqual([
      ["a@b.com", "NSW", ""],
      ["c@d.com", "", "Bondi"],
    ]);
  });

  it("splits a header off a grid that begins with blank rows", () => {
    expect(splitHeaderRow([[], ["", ""], ["email", "state"], ["a@b.com", "NSW"]])).toEqual({
      headers: ["email", "state"],
      rows: [["a@b.com", "NSW"]],
    });
  });

  it("routes on the bytes, not on the file name", async () => {
    const csv = new TextEncoder().encode("email,state\na@b.com,NSW\n");
    // Named as a workbook, and read correctly as CSV regardless.
    const table = await parseListFile(csv, "contacts.xlsx");
    expect(table.format).toBe("delimited");
    expect(table.headers).toEqual(["email", "state"]);
  });

  it("reads a JSON array of records", async () => {
    const json = new TextEncoder().encode('[{"email":"a@b.com","state":"NSW"}]');
    const table = await parseListFile(json, "list.json");
    expect(table.format).toBe("json");
    expect(table.rows).toEqual([["a@b.com", "NSW"]]);
  });

  it("reads a wrapped JSON payload and newline-delimited JSON", async () => {
    const wrapped = new TextEncoder().encode('{"contacts":[{"email":"a@b.com"}]}');
    expect((await parseListFile(wrapped, "x.json")).rows).toEqual([["a@b.com"]]);

    const ndjson = new TextEncoder().encode('{"email":"a@b.com"}\n{"email":"c@d.com"}\n');
    const table = await parseListFile(ndjson, "x.ndjson");
    expect(table.format).toBe("ndjson");
    expect(table.rows).toEqual([["a@b.com"], ["c@d.com"]]);
  });

  it("refuses a legacy .xls by name rather than half-reading it", async () => {
    const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(parseListFile(ole2, "old.xls")).rejects.toThrow(/legacy \.xls/);
  });

  it("refuses an empty file", async () => {
    await expect(parseListFile(new Uint8Array(0), "x.csv")).rejects.toThrow(/empty/);
  });
});
