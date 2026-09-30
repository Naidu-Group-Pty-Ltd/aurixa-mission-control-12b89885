/**
 * The fill engine on a small document with the same control shapes the
 * approved templates use: tagged plain-text controls, one in a shaded table
 * cell, and a repeating section whose item is a table.
 */
import { describe, expect, it } from "vitest";
import {
  assertIssuedDocument,
  assertWellFormedXml,
  documentText,
  fillDocumentXml,
  inventoryControls,
  type DocumentFill,
} from "./docxFill.pure";

const text = (tag: string, placeholder: string, rPr = "") =>
  `<w:sdt><w:sdtPr>${rPr}<w:alias w:val="${tag}"/><w:tag w:val="${tag}"/><w:showingPlcHdr/><w:text/></w:sdtPr>` +
  `<w:sdtContent><w:r>${rPr}<w:t>${placeholder}</w:t></w:r></w:sdtContent></w:sdt>`;

const BOLD = '<w:rPr><w:b/><w:color w:val="235D79"/></w:rPr>';

const DOC =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w:body>' +
  `<w:p><w:r><w:t xml:space="preserve">Customer: </w:t></w:r>${text("customer.name", "[Customer name]", BOLD)}</w:p>` +
  '<w:tbl><w:tr><w:tc><w:tcPr><w:tcW w:w="9000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="eaf4f4"/></w:tcPr>' +
  `<w:p><w:r><w:t xml:space="preserve">Accept: </w:t></w:r>${text("sign", "[Electronic acceptance]")}</w:p></w:tc></w:tr></w:tbl>` +
  '<w:sdt><w:sdtPr><w:alias w:val="Lines"/><w:tag w:val="lines"/><w15:repeatingSection/></w:sdtPr><w:sdtContent>' +
  "<w:sdt><w:sdtPr><w15:repeatingSectionItem/></w:sdtPr><w:sdtContent>" +
  `<w:tbl><w:tr><w:tc><w:p>${text("line.name", "[Line name]")}</w:p></w:tc>` +
  `<w:tc><w:p>${text("line.total", "[Line total]")}</w:p></w:tc></w:tr></w:tbl>` +
  "</w:sdtContent></w:sdt></w:sdtContent></w:sdt>" +
  "<w:p><w:r><w:t>Fixed text after the section.</w:t></w:r></w:p>" +
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';

const ANCHOR = "\\sub_sig_client\\";

function fill(overrides: Partial<DocumentFill> = {}): DocumentFill {
  return {
    fields: {
      "customer.name": "Smith & Jones <Pty> Ltd",
      sign: [{ text: "Sign here: " }, { anchor: ANCHOR }],
    },
    repeating: {
      lines: {
        items: [
          { "line.name": "Seat", "line.total": "$49.00" },
          { "line.name": "Agent", "line.total": "$495.00" },
        ],
        whenEmpty: "No additional purchases.",
      },
    },
    ...overrides,
  };
}

describe("inventoryControls", () => {
  it("lists the plain-text controls and the repeating section's item fields", () => {
    expect(inventoryControls(DOC)).toEqual({
      fields: ["customer.name", "sign"],
      repeating: [{ tag: "lines", itemFields: ["line.name", "line.total"] }],
    });
  });

  it("refuses a control kind it cannot fill", () => {
    const dated = DOC.replace(
      '<w:tag w:val="sign"/><w:showingPlcHdr/><w:text/>',
      '<w:tag w:val="sign"/><w:date w:fullDate="2026-01-01T00:00:00Z"/>',
    );
    expect(() => inventoryControls(dated)).toThrow(/unsupported_control: sign/);
  });
});

describe("fillDocumentXml", () => {
  it("replaces each control with its value and removes every wrapper", () => {
    const out = fillDocumentXml(DOC, fill());
    expect(out).not.toMatch(/<w:sdt(?=[\s>])/);
    expect(out).not.toContain("repeatingSection");
    const visible = documentText(out);
    expect(visible).toContain("Customer: Smith & Jones <Pty> Ltd");
    expect(visible).toContain("Seat");
    expect(visible).toContain("$495.00");
    expect(visible).toContain("Fixed text after the section.");
    expect(visible).not.toContain("[");
    assertWellFormedXml(out);
  });

  it("escapes markup and keeps the control's own run formatting", () => {
    const out = fillDocumentXml(DOC, fill());
    expect(out).toContain(
      `<w:r>${BOLD}<w:t xml:space="preserve">Smith &amp; Jones &lt;Pty&gt; Ltd</w:t></w:r>`,
    );
  });

  it("turns line breaks and tabs into Word's own", () => {
    const out = fillDocumentXml(
      DOC,
      fill({ fields: { "customer.name": "Line one\nLine two\tTabbed", sign: fill().fields.sign } }),
    );
    expect(out).toContain(
      '<w:t xml:space="preserve">Line one</w:t><w:br/><w:t xml:space="preserve">Line two</w:t><w:tab/><w:t xml:space="preserve">Tabbed</w:t>',
    );
  });

  it("paints an anchor in the enclosing cell's fill, at six points", () => {
    const out = fillDocumentXml(DOC, fill());
    expect(out).toContain(
      '<w:r><w:rPr><w:color w:val="EAF4F4"/><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr>' +
        '<w:t xml:space="preserve">\\sub_sig_client\\</w:t></w:r>',
    );
  });

  it("clones the repeating item once per record, separated so tables do not merge", () => {
    const out = fillDocumentXml(DOC, fill());
    expect(out.match(/<w:tbl>/g)).toHaveLength(3);
    expect(out).toContain('</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0"');
  });

  it("states the empty case in place of a section with no records", () => {
    const out = fillDocumentXml(
      DOC,
      fill({ repeating: { lines: { items: [], whenEmpty: "No additional purchases." } } }),
    );
    expect(documentText(out)).toContain("No additional purchases.");
    expect(out.match(/<w:tbl>/g)).toHaveLength(1);
  });

  it("refuses a control left without a value", () => {
    expect(() => fillDocumentXml(DOC, fill({ fields: { sign: fill().fields.sign } }))).toThrow(
      "unfilled_field: customer.name",
    );
  });

  it("refuses a value no control asks for", () => {
    expect(() =>
      fillDocumentXml(DOC, fill({ fields: { ...fill().fields, "customer.nickname": "x" } })),
    ).toThrow("unused_field_value: customer.nickname");
  });

  it("refuses an empty value", () => {
    expect(() =>
      fillDocumentXml(DOC, fill({ fields: { ...fill().fields, "customer.name": "   " } })),
    ).toThrow("empty_field_value: customer.name");
    expect(() =>
      fillDocumentXml(DOC, fill({ fields: { ...fill().fields, sign: [{ anchor: ANCHOR }] } })),
    ).toThrow("empty_field_value: sign");
  });

  it("refuses a malformed anchor", () => {
    expect(() =>
      fillDocumentXml(
        DOC,
        fill({ fields: { ...fill().fields, sign: [{ text: "x" }, { anchor: "sig" }] } }),
      ),
    ).toThrow(/bad_anchor/);
  });

  it("refuses a missing section, an unknown section and an unknown record field", () => {
    expect(() => fillDocumentXml(DOC, fill({ repeating: {} }))).toThrow(
      "unfilled_repeating_section: lines",
    );
    expect(() =>
      fillDocumentXml(
        DOC,
        fill({ repeating: { ...fill().repeating, extras: { items: [], whenEmpty: "x" } } }),
      ),
    ).toThrow("unused_repeating_value: extras");
    expect(() =>
      fillDocumentXml(
        DOC,
        fill({
          repeating: {
            lines: {
              items: [{ "line.name": "Seat", "line.total": "$49.00", "line.note": "extra" }],
              whenEmpty: "x",
            },
          },
        }),
      ),
    ).toThrow("unused_item_value: lines[0] line.note");
  });

  it("leaves every byte outside the controls untouched", () => {
    const out = fillDocumentXml(DOC, fill());
    expect(out.startsWith(DOC.slice(0, DOC.indexOf("<w:sdt>")))).toBe(true);
    const tail = DOC.slice(DOC.lastIndexOf("</w:sdt>") + "</w:sdt>".length);
    expect(out.endsWith(tail)).toBe(true);
  });
});

describe("assertIssuedDocument", () => {
  const issued = () => fillDocumentXml(DOC, fill());

  it("passes a completed document", () => {
    expect(() => assertIssuedDocument(issued(), { anchors: [ANCHOR] })).not.toThrow();
  });

  it("refuses a document that still holds a control", () => {
    expect(() => assertIssuedDocument(DOC, { anchors: [] })).toThrow(
      "issued_document_still_has_controls",
    );
  });

  it("refuses a surviving placeholder and says where it is", () => {
    const withPlaceholder = issued().replace(
      "Fixed text after the section.",
      "Fixed text [Forgotten placeholder] here.",
    );
    expect(() => assertIssuedDocument(withPlaceholder, { anchors: [ANCHOR] })).toThrow(
      /issued_document_has_placeholder: .*\[Forgotten placeholder\]/,
    );
  });

  it("requires each anchor exactly once", () => {
    expect(() =>
      assertIssuedDocument(issued(), { anchors: [ANCHOR, "\\sub_date_client\\"] }),
    ).toThrow("issued_document_anchor_count: \\sub_date_client\\ appears 0 times");
  });
});

describe("assertWellFormedXml", () => {
  it("finds the defects string surgery can introduce", () => {
    expect(() => assertWellFormedXml("<a><b></a></b>")).toThrow(/closes <b>/);
    expect(() => assertWellFormedXml("<a>x & y</a>")).toThrow(/bad text/);
    expect(() => assertWellFormedXml("<a><b/>")).toThrow(/never closed/);
    expect(() =>
      assertWellFormedXml('<?xml version="1.0"?><a x="1 > 0"><!-- c --><b/>&amp;</a>'),
    ).not.toThrow();
  });
});
