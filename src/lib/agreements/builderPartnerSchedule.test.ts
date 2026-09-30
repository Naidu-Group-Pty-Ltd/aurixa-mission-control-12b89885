/**
 * The Execution Schedule is the page DocuSign acts on, so the properties its
 * header promises are asserted against the PDF it actually writes: the bytes
 * are read back, every content stream decoded, and every string the page shows
 * recovered. A test of the input would pass while the page painted nothing.
 */
import { describe, expect, it } from "vitest";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  type PDFObject,
} from "pdf-lib";
import {
  BUILDER_PARTNER_ANCHORS,
  DEFAULT_EXECUTION_STATEMENT,
  EXECUTION_STATEMENT_MAX,
  emptyParticulars,
  type BuilderPartnerParticulars,
} from "./builderPartner.pure";
import {
  buildExecutionSchedule,
  byteSizeLabel,
  fingerprintLines,
  ISSUER_LEGAL_NAME,
  longDate,
  scheduleAnchors,
  type ExecutionScheduleInput,
} from "./builderPartnerSchedule.pure";

const SHA = "0123456789abcdef".repeat(4);
const ALL_ANCHORS = Object.values(BUILDER_PARTNER_ANCHORS);

function particulars(
  over: {
    partner?: Partial<BuilderPartnerParticulars["partner"]>;
    signatory?: Partial<BuilderPartnerParticulars["signatory"]>;
  } = {},
): BuilderPartnerParticulars {
  const base = emptyParticulars();
  return {
    schema: 1,
    partner: {
      ...base.partner,
      legalName: "Example Homes Pty Ltd",
      tradingName: "Example Homes",
      abn: "51 824 753 556",
      address: "1 Builder Street, Parramatta NSW 2150",
      email: "office@examplehomes.test",
      phone: "02 9000 0000",
      ...over.partner,
    },
    signatory: {
      ...base.signatory,
      name: "Sam Builder",
      email: "sam@examplehomes.test",
      title: "Director",
      ...over.signatory,
    },
  };
}

function input(
  over: Partial<Omit<ExecutionScheduleInput, "terms">> & {
    terms?: Partial<ExecutionScheduleInput["terms"]>;
  } = {},
): ExecutionScheduleInput {
  const { terms, ...rest } = over;
  return {
    reference: "AUR-BPA-20260928-ABCDEF",
    issuedOn: "2026-09-28",
    preview: false,
    particulars: particulars(),
    countersignerName: "Alex Aurixa",
    ...rest,
    terms: {
      name: "Builder Partner Terms",
      versionLabel: "2026.1",
      fileName: "builder-partner-terms-2026.1.pdf",
      sha256: SHA,
      byteSize: 412345,
      pageCount: 14,
      executionStatement: DEFAULT_EXECUTION_STATEMENT,
      countersignatureRequired: false,
      ...terms,
    },
  };
}

function hexToLatin1(hex: string): string {
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  // WinAnsi is the encoding the standard fonts draw in.
  return new TextDecoder("windows-1252").decode(bytes);
}

type ReadBack = {
  title: string | undefined;
  /** Every string each page shows, in drawing order. */
  pages: string[][];
};

/** Load the bytes and recover every string drawn on every page. */
async function readBack(bytes: Uint8Array): Promise<ReadBack> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const resolve = (obj: PDFObject | undefined): PDFObject | undefined =>
    obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  const pages = doc.getPages().map((page) => {
    const contents = resolve(page.node.get(PDFName.of("Contents")));
    const streams = contents instanceof PDFArray ? contents.asArray().map(resolve) : [contents];
    let source = "";
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;
      source += new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
      source += "\n";
    }
    return [...source.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => hexToLatin1(m[1]));
  });
  return { title: doc.getTitle(), pages };
}

function countOn(pages: string[][], value: string): number {
  return pages.flat().filter((s) => s === value).length;
}

function pageOf(pages: string[][], predicate: (s: string) => boolean): number {
  return pages.findIndex((strings) => strings.some(predicate));
}

describe("the words the page prints", () => {
  it("writes the issuing day in full, with no locale data", () => {
    expect(longDate("2026-09-28")).toBe("28 September 2026");
    expect(longDate("2027-01-05")).toBe("5 January 2027");
  });

  it("returns anything that is not a calendar day unchanged rather than inventing one", () => {
    expect(longDate("28/09/2026")).toBe("28/09/2026");
    expect(longDate("2026-13-01")).toBe("2026-13-01");
    expect(longDate("")).toBe("");
  });

  it("sizes the terms file as a person reads it", () => {
    expect(byteSizeLabel(512)).toBe("512 bytes");
    expect(byteSizeLabel(2048)).toBe("2.0 KB");
    expect(byteSizeLabel(412345)).toBe("402.7 KB");
    expect(byteSizeLabel(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("prints the fingerprint whole, in eight groups over two lines", () => {
    const lines = fingerprintLines(SHA.toUpperCase());
    expect(lines).toEqual([
      "01234567 89abcdef 01234567 89abcdef",
      "01234567 89abcdef 01234567 89abcdef",
    ]);
    expect(lines.join("").replace(/ /g, "")).toBe(SHA);
  });
});

describe("the anchors an issued schedule paints", () => {
  it("asks the signer for a title only when the particulars do not know it", () => {
    expect(
      scheduleAnchors({ signatoryTitle: "Director", countersignatureRequired: false }),
    ).toEqual([BUILDER_PARTNER_ANCHORS.partnerSignature, BUILDER_PARTNER_ANCHORS.partnerDate]);
    expect(scheduleAnchors({ signatoryTitle: "  ", countersignatureRequired: false })).toEqual([
      BUILDER_PARTNER_ANCHORS.partnerSignature,
      BUILDER_PARTNER_ANCHORS.partnerTitle,
      BUILDER_PARTNER_ANCHORS.partnerDate,
    ]);
  });

  it("adds Aurixa's signature and date only when the terms require a countersignature", () => {
    expect(scheduleAnchors({ signatoryTitle: "Director", countersignatureRequired: true })).toEqual(
      [
        BUILDER_PARTNER_ANCHORS.partnerSignature,
        BUILDER_PARTNER_ANCHORS.partnerDate,
        BUILDER_PARTNER_ANCHORS.aurixaSignature,
        BUILDER_PARTNER_ANCHORS.aurixaDate,
      ],
    );
  });
});

describe("buildExecutionSchedule", () => {
  it("is deterministic: the same input produces the same bytes", async () => {
    const a = await buildExecutionSchedule(input());
    const b = await buildExecutionSchedule(input());
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);

    const c = await buildExecutionSchedule(input({ terms: { sha256: "f".repeat(64) } }));
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(false);
  });

  const cases = [
    { title: "Director", countersign: false },
    { title: "", countersign: false },
    { title: "Director", countersign: true },
    { title: "", countersign: true },
  ];

  it.each(cases)(
    "paints exactly the anchors the envelope expects, each once (title $title, countersign $countersign)",
    async ({ title, countersign }) => {
      const schedule = await buildExecutionSchedule(
        input({
          particulars: particulars({ signatory: { title } }),
          terms: { countersignatureRequired: countersign },
        }),
      );
      const expected = scheduleAnchors({
        signatoryTitle: title,
        countersignatureRequired: countersign,
      });
      expect(schedule.anchors).toEqual(expected);

      const { pages } = await readBack(schedule.bytes);
      for (const anchor of ALL_ANCHORS) {
        expect(countOn(pages, anchor)).toBe(expected.includes(anchor) ? 1 : 0);
      }
    },
  );

  it("prints a known title rather than asking for it", async () => {
    const { pages } = await readBack((await buildExecutionSchedule(input())).bytes);
    expect(countOn(pages, "Director")).toBe(1);
    expect(countOn(pages, "Sam Builder")).toBe(1);
  });

  it("names the parties and identifies the terms by title, version and fingerprint", async () => {
    const schedule = await buildExecutionSchedule(input());
    const { pages, title } = await readBack(schedule.bytes);
    const all = pages.flat();
    expect(all).toContain(ISSUER_LEGAL_NAME);
    expect(all).toContain("Example Homes Pty Ltd");
    expect(all).toContain("Trading as Example Homes");
    expect(all).toContain("Builder Partner Terms");
    expect(all).toContain("2026.1");
    expect(all).toContain("builder-partner-terms-2026.1.pdf (402.7 KB · 14 pages)");
    for (const line of fingerprintLines(SHA)) expect(all).toContain(line);
    expect(all).toContain("Reference AUR-BPA-20260928-ABCDEF   ·   Issued 28 September 2026");
    expect(title).toBe("Execution Schedule - Builder Partner Agreement AUR-BPA-20260928-ABCDEF");
  });

  it("says Aurixa's signature is not required when the terms do not ask for one", async () => {
    const { pages } = await readBack((await buildExecutionSchedule(input())).bytes);
    const all = pages.flat();
    expect(all).toContain(`Issued by ${ISSUER_LEGAL_NAME}`);
    expect(all).not.toContain(`Signed by ${ISSUER_LEGAL_NAME}`);
  });

  it("prints the countersigner's name in Aurixa's block when a countersignature is required", async () => {
    const { pages } = await readBack(
      (await buildExecutionSchedule(input({ terms: { countersignatureRequired: true } }))).bytes,
    );
    const all = pages.flat();
    expect(all).toContain(`Signed by ${ISSUER_LEGAL_NAME}`);
    expect(all).toContain("Alex Aurixa");
  });

  it("paints no anchor on a preview, so a preview cannot be signed", async () => {
    const preview = await buildExecutionSchedule(
      input({
        preview: true,
        particulars: particulars({ signatory: { title: "" } }),
        terms: { countersignatureRequired: true },
      }),
    );
    expect(preview.anchors).toEqual([]);
    const { pages, title } = await readBack(preview.bytes);
    for (const anchor of ALL_ANCHORS) expect(countOn(pages, anchor)).toBe(0);
    expect(title?.startsWith("PREVIEW - ")).toBe(true);
    expect(pages.flat()).toContain("PREVIEW · NOT AN ISSUED AGREEMENT");
    // The watermark is drawn on every page.
    for (const strings of pages) expect(strings).toContain("PREVIEW");
  });

  it("lays a preview out exactly as the issued page: its markings take no room", async () => {
    const long = input({ terms: { executionStatement: "Executed as an agreement. ".repeat(40) } });
    const issued = await buildExecutionSchedule(long);
    const preview = await buildExecutionSchedule({ ...long, preview: true });
    expect(preview.pageCount).toBe(issued.pageCount);
  });

  it("never parts the execution statement from the signatures", async () => {
    // Long particulars and a statement at the length ceiling push the
    // execution unit onto a page of its own.
    const statement =
      `${"Executed as an agreement by the parties named in this schedule. ".repeat(40)}`
        .slice(0, EXECUTION_STATEMENT_MAX)
        .trim();
    const schedule = await buildExecutionSchedule(
      input({
        particulars: particulars({
          partner: {
            address: "Suite 1204, Level 12, 100 A Very Long Street Name Boulevard, ".repeat(3),
          },
        }),
        terms: { executionStatement: statement },
      }),
    );
    expect(schedule.pageCount).toBeGreaterThan(1);
    const { pages } = await readBack(schedule.bytes);
    const heading = pageOf(pages, (s) => s === "EXECUTION");
    const firstWords = pageOf(pages, (s) => s.startsWith("Executed as an agreement by the"));
    const signature = pageOf(pages, (s) => s === BUILDER_PARTNER_ANCHORS.partnerSignature);
    const date = pageOf(pages, (s) => s === BUILDER_PARTNER_ANCHORS.partnerDate);
    expect(heading).toBeGreaterThan(0);
    expect(firstWords).toBe(heading);
    expect(signature).toBe(heading);
    expect(date).toBe(heading);
  });

  it("numbers every page of the whole", async () => {
    const schedule = await buildExecutionSchedule(
      input({ terms: { executionStatement: "Executed as an agreement. ".repeat(40) } }),
    );
    const { pages } = await readBack(schedule.bytes);
    expect(pages).toHaveLength(schedule.pageCount);
    pages.forEach((strings, i) => {
      expect(strings).toContain(`AUR-BPA-20260928-ABCDEF · Page ${i + 1} of ${schedule.pageCount}`);
    });
  });

  it("prints any name a builder can have, decomposing what the font cannot draw", async () => {
    const schedule = await buildExecutionSchedule(
      input({
        particulars: particulars({
          partner: { legalName: "Łódź Constructions 建筑 🏗 Pty Ltd", tradingName: "" },
          signatory: { name: "Zoë Ångström-Nguyễn" },
        }),
      }),
    );
    const { pages } = await readBack(schedule.bytes);
    const all = pages.flat();
    // Ł has no decomposition, so it is a "?"; ź decomposes to its base z.
    expect(all).toContain("?ódz Constructions ?? ? Pty Ltd");
    expect(all).toContain("Zoë Ångström-Nguyen");
    expect(schedule.anchors).toEqual(
      scheduleAnchors({ signatoryTitle: "Director", countersignatureRequired: false }),
    );
  });

  it("says what is missing rather than printing a blank party", async () => {
    const schedule = await buildExecutionSchedule(
      input({
        particulars: particulars({
          partner: { legalName: "", tradingName: "", abn: "", address: "", email: "", phone: "" },
        }),
      }),
    );
    const all = (await readBack(schedule.bytes)).pages.flat();
    expect(all).toContain("Legal name not provided");
    expect(all).toContain("ABN not provided");
    expect(all).toContain("Address not provided");
    expect(all).toContain("for and on behalf of the Builder Partner");
  });
});
