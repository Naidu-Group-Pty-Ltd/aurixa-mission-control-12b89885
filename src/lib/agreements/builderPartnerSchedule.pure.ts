/**
 * The Execution Schedule — the one document of a Builder Partner Agreement
 * that Mission Control writes, and the one DocuSign acts on.
 *
 * The terms are supplied later, by an admin, as whatever file the agreement
 * is (see `builderPartner.pure.ts`). This page is what makes any such file
 * signable without anybody authoring anchors into it: it names the parties,
 * identifies the terms by title, version and SHA-256 fingerprint, carries the
 * execution statement registered with them, and holds the signature blocks.
 * Signing it is what enters the agreement, and the fingerprint is what ties
 * the signature to exactly the terms that were sent.
 *
 * Four properties are guaranteed, and tested.
 *
 *  * **Deterministic.** The same input produces the same bytes: no clock but
 *    the issuing day passed in, no generated identifiers, fixed document
 *    properties. So the digest the snapshot records can be proved by
 *    regenerating the page. A preview is the issued page in every respect but
 *    its markings, and they take no room: a notice in the masthead, a faint
 *    diagonal watermark and a word in the footer, never a block that moves the
 *    layout. What a reviewer approves is what the Builder Partner receives.
 *
 *  * **Every anchor exactly once, and only the ones the envelope uses.** The
 *    anchors are painted in the colour of the panel they sit on — invisible to
 *    a reader, found by DocuSign's text scanner — and the envelope's tabs are
 *    STRICT, so an anchor that did not print refuses the envelope rather than
 *    sending one with nowhere to sign. A preview paints none: it cannot be
 *    signed, by construction.
 *
 *  * **The execution clause is never parted from the signatures.** The
 *    statement and both signature blocks are laid out as one unit: when they
 *    do not fit under the particulars they move to the next page together, so
 *    no page carries a signature without the words it is a signature to.
 *
 *  * **Anything a builder can be called can be printed.** The standard PDF
 *    fonts cover Windows-1252; a character outside it is decomposed to its
 *    base letters where it has them, and shown as "?" where it has not — never
 *    a thrown error that costs the builder their agreement.
 *
 * Geometry follows the Service Level Agreement's execution page, with one
 * deliberate difference: the anchors for text a signer supplies (the date, the
 * title) sit just ABOVE their line and the labels below it, so the value
 * DocuSign writes can never land on the label, whichever corner of the anchor
 * DocuSign measures from.
 *
 * No registration number is printed for Aurixa, for the reason
 * `AURIXA_INVOICE_FOOTER` records: a number typed here would be printed on
 * every agreement, and the only one to hand is not the ABN.
 */
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  BUILDER_PARTNER_ANCHORS,
  BUILDER_PARTNER_DOCUMENT_NAME,
  normaliseParticulars,
  type BuilderPartnerParticulars,
} from "./builderPartner.pure";

/** Bumped whenever the page's layout or wording changes; recorded in the snapshot. */
export const SCHEDULE_LAYOUT_VERSION = 1;

/** Who issues every Builder Partner Agreement. */
export const ISSUER_LEGAL_NAME = "Aurixa Systems Pty Ltd";

const PAGE = { width: 595.28, height: 841.89 };
const M = 56;
const CONTENT_W = PAGE.width - M * 2;
const MASTHEAD_H = 64;
const FOOTER_RULE_Y = 48;
const CONTENT_FLOOR = 58;

function hex(value: string) {
  const n = Number.parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

type Colour = ReturnType<typeof rgb>;

const INK = hex("#0B1220");
const BODY = hex("#1F2937");
const MUTED = hex("#5B6472");
const HAIRLINE = hex("#D9D4C7");
const GOLD = hex("#C89B3C");
/** Gold dark enough to read as text on white (the logo gold is ~2.6:1). */
const GOLD_TEXT = hex("#7A5B16");
const GOLD_LIGHT = hex("#F5D17A");
const BAND = hex("#040B16");
const PANEL = hex("#F7F4EC");
const PANEL_EDGE = hex("#E6DFCC");
/** The preview's markings: amber, so nobody can take the page for an issued one. */
const PREVIEW_MARK = hex("#D97706");
const PREVIEW_ON_BAND = hex("#FBBF24");
const PREVIEW_WATERMARK = "PREVIEW";

export type ExecutionScheduleTerms = {
  name: string;
  versionLabel: string;
  fileName: string;
  sha256: string;
  byteSize: number;
  pageCount: number | null;
  executionStatement: string;
  countersignatureRequired: boolean;
};

export type ExecutionScheduleInput = {
  reference: string;
  /** The issuing day in Sydney, `YYYY-MM-DD`. */
  issuedOn: string;
  preview: boolean;
  particulars: BuilderPartnerParticulars;
  terms: ExecutionScheduleTerms;
  /** Printed in Aurixa's block when the terms require a countersignature. */
  countersignerName: string | null;
};

export type ExecutionSchedule = {
  bytes: Uint8Array;
  pageCount: number;
  /** The anchors painted, in order. Empty for a preview. */
  anchors: string[];
};

/** The anchors an issued schedule paints for these inputs — and the envelope places tabs on. */
export function scheduleAnchors(input: {
  signatoryTitle: string;
  countersignatureRequired: boolean;
}): string[] {
  const anchors: string[] = [BUILDER_PARTNER_ANCHORS.partnerSignature];
  if (!input.signatoryTitle.trim()) anchors.push(BUILDER_PARTNER_ANCHORS.partnerTitle);
  anchors.push(BUILDER_PARTNER_ANCHORS.partnerDate);
  if (input.countersignatureRequired) {
    anchors.push(BUILDER_PARTNER_ANCHORS.aurixaSignature, BUILDER_PARTNER_ANCHORS.aurixaDate);
  }
  return anchors;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2026-09-28` → `28 September 2026`. No locale data: the words are fixed. */
export function longDate(isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return isoDay;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return isoDay;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** `412345` → `402.7 KB`. */
export function byteSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** The fingerprint in eight groups of eight, two lines, as a person reads it aloud. */
export function fingerprintLines(sha256: string): string[] {
  const groups = sha256.toLowerCase().match(/.{1,8}/g) ?? [];
  return [groups.slice(0, 4).join(" "), groups.slice(4).join(" ")].filter(Boolean);
}

type Sanitise = (text: string) => string;

/**
 * Keep what the font can draw. A character outside its encoding is decomposed
 * (NFKD, marks dropped) when every part of that survives, and is a "?" when
 * it does not. Line breaks and tabs are spaces: the layout wraps, not the text.
 */
function makeSanitiser(font: PDFFont): Sanitise {
  const supported = new Set(font.getCharacterSet());
  return (text: string) => {
    let out = "";
    for (const ch of text.replace(/[\t\r\n\f\v]+/g, " ")) {
      const cp = ch.codePointAt(0) ?? 0;
      if (supported.has(cp)) {
        out += ch;
        continue;
      }
      const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      const drawable =
        base.length > 0 && [...base].every((b) => supported.has(b.codePointAt(0) ?? 0));
      out += drawable ? base : "?";
    }
    return out;
  };
}

/** Wrap into lines no wider than `width`; a word wider than a line is broken. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (font.widthOfTextAtSize(word, size) <= width) {
      line = word;
      continue;
    }
    let chunk = "";
    for (const ch of word) {
      if (chunk && font.widthOfTextAtSize(chunk + ch, size) > width) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/** At most `max` lines; the last one ends in an ellipsis when anything was cut. */
function clampLines(lines: string[], max: number, font: PDFFont, size: number, width: number) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1];
  while (last && font.widthOfTextAtSize(`${last}...`, size) > width) last = last.slice(0, -1);
  kept[max - 1] = `${last.trimEnd()}...`;
  return kept;
}

/** One line of a panel row's value; a long one wraps within the value column. */
type PanelLine = { text: string; bold?: boolean; muted?: boolean };

type PanelItem =
  | { kind: "divider" }
  | {
      kind: "row";
      label: string;
      /** A party's name is set as a heading; a field's as a quiet label. */
      labelStyle?: "party" | "field";
      lines: PanelLine[];
      mono?: boolean;
    };

function row(
  label: string,
  value: string,
  opts: { muted?: boolean; mono?: boolean } = {},
): PanelItem {
  return {
    kind: "row",
    label,
    lines: value.split("\n").map((text) => ({ text, muted: opts.muted })),
    mono: opts.mono,
  };
}

/* The signature blocks' geometry, measured down from the block's top edge. */
const BLOCK = {
  height: 210,
  heading: 20,
  subFirst: 33,
  subLeading: 10,
  signLine: 88,
  rowGap: 34,
  labelDrop: 11,
  printedRise: 4,
  anchorRise: 3,
};

/**
 * Draw the Execution Schedule. Pure in the sense that matters: the output is
 * a function of the input alone.
 */
export async function buildExecutionSchedule(
  input: ExecutionScheduleInput,
): Promise<ExecutionSchedule> {
  const particulars = normaliseParticulars(input.particulars);
  const partner = particulars.partner;
  const signatory = particulars.signatory;
  const terms = input.terms;
  const issuedLabel = longDate(input.issuedOn);

  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRomanBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const sanitisers = new Map<PDFFont, Sanitise>(
    Object.values(fonts).map((f) => [f, makeSanitiser(f)] as const),
  );
  const safe = (font: PDFFont, text: string) => (sanitisers.get(font) ?? ((t: string) => t))(text);

  const title = `Execution Schedule - ${BUILDER_PARTNER_DOCUMENT_NAME} ${input.reference}`;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(input.issuedOn) ? input.issuedOn : "2000-01-01";
  const fixedDate = new Date(`${day}T00:00:00Z`);
  doc.setTitle(safe(fonts.regular, input.preview ? `PREVIEW - ${title}` : title));
  doc.setAuthor(ISSUER_LEGAL_NAME);
  doc.setSubject(
    safe(
      fonts.regular,
      `${BUILDER_PARTNER_DOCUMENT_NAME} ${input.reference} between ${ISSUER_LEGAL_NAME} and ${
        partner.legalName || "the Builder Partner"
      }`,
    ),
  );
  doc.setKeywords([
    "Aurixa Systems",
    BUILDER_PARTNER_DOCUMENT_NAME,
    "Execution Schedule",
    input.reference,
  ]);
  doc.setCreator("Aurixa Mission Control");
  doc.setProducer("Aurixa Mission Control");
  doc.setCreationDate(fixedDate);
  doc.setModificationDate(fixedDate);

  const pages: PDFPage[] = [];
  const anchors: string[] = [];
  let page!: PDFPage;
  let y = 0;

  const text = (
    value: string,
    opts: { x: number; y: number; size: number; font?: PDFFont; color?: Colour },
  ) => {
    const font = opts.font ?? fonts.regular;
    page.drawText(safe(font, value), {
      x: opts.x,
      y: opts.y,
      size: opts.size,
      font,
      color: opts.color ?? BODY,
    });
  };
  const textRight = (
    value: string,
    opts: { right: number; y: number; size: number; font?: PDFFont; color?: Colour },
  ) => {
    const font = opts.font ?? fonts.regular;
    const clean = safe(font, value);
    page.drawText(clean, {
      x: opts.right - font.widthOfTextAtSize(clean, opts.size),
      y: opts.y,
      size: opts.size,
      font,
      color: opts.color ?? BODY,
    });
  };
  const lines = (value: string, font: PDFFont, size: number, width: number) =>
    wrap(safe(font, value.replace(/\s+/g, " ").trim()), font, size, width);
  const rule = (atY: number, color = HAIRLINE, thickness = 0.6, x = M, width = CONTENT_W) =>
    page.drawRectangle({ x, y: atY, width, height: thickness, color });
  // An anchor token, in the colour of the panel it sits on. Never on a preview.
  const anchor = (token: string, x: number, atY: number) => {
    if (input.preview) return;
    page.drawText(token, { x, y: atY, size: 6, font: fonts.regular, color: PANEL });
    anchors.push(token);
  };

  const startPage = (first: boolean) => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    if (first) {
      // The masthead: the gold wordmark on its own dark band, as every Aurixa
      // document on white paper carries it.
      const bandY = PAGE.height - MASTHEAD_H;
      page.drawRectangle({ x: 0, y: bandY, width: PAGE.width, height: MASTHEAD_H, color: BAND });
      page.drawRectangle({ x: 0, y: bandY - 2, width: PAGE.width, height: 2, color: GOLD });
      text("AURIXA", { x: M, y: bandY + 24, size: 20, font: fonts.serif, color: GOLD_LIGHT });
      text("SYSTEMS", {
        x: M + fonts.serif.widthOfTextAtSize("AURIXA", 20) + 7,
        y: bandY + 27,
        size: 8,
        font: fonts.bold,
        color: GOLD,
      });
      textRight(BUILDER_PARTNER_DOCUMENT_NAME.toUpperCase(), {
        right: PAGE.width - M,
        y: bandY + 36,
        size: 8,
        font: fonts.bold,
        color: GOLD_LIGHT,
      });
      textRight(input.reference, {
        right: PAGE.width - M,
        y: bandY + 24,
        size: 8,
        color: GOLD,
      });
      if (input.preview) {
        // Between the wordmark and the document name, where it moves nothing.
        const notice = "PREVIEW · NOT AN ISSUED AGREEMENT";
        const size = 8;
        const w = fonts.bold.widthOfTextAtSize(notice, size);
        const x = (PAGE.width - w) / 2;
        page.drawRectangle({
          x: x - 8,
          y: bandY + 22,
          width: w + 16,
          height: 17,
          borderColor: PREVIEW_ON_BAND,
          borderWidth: 0.8,
        });
        text(notice, { x, y: bandY + 27.5, size, font: fonts.bold, color: PREVIEW_ON_BAND });
      }
      y = bandY - 2 - 34;
    } else {
      text("AURIXA SYSTEMS", {
        x: M,
        y: PAGE.height - 42,
        size: 8,
        font: fonts.bold,
        color: GOLD_TEXT,
      });
      textRight(`Execution Schedule, continued · ${input.reference}`, {
        right: PAGE.width - M,
        y: PAGE.height - 42,
        size: 8,
        color: MUTED,
      });
      rule(PAGE.height - 50, GOLD, 0.8);
      y = PAGE.height - 66;
    }
  };

  const ensure = (height: number) => {
    if (y - height < CONTENT_FLOOR) startPage(false);
  };

  type ParagraphOpts = { size?: number; leading?: number; color?: Colour; font?: PDFFont };
  const paragraphLines = (value: string, opts: ParagraphOpts = {}) =>
    lines(value, opts.font ?? fonts.regular, opts.size ?? 9.5, CONTENT_W);
  const paragraph = (value: string, opts: ParagraphOpts = {}) => {
    const size = opts.size ?? 9.5;
    const leading = opts.leading ?? size * 1.42;
    const font = opts.font ?? fonts.regular;
    for (const line of paragraphLines(value, opts)) {
      ensure(leading);
      y -= leading;
      text(line, { x: M, y, size, font, color: opts.color ?? BODY });
    }
  };

  const SECTION_H = 26;
  const section = (number: number, heading: string) => {
    y -= 18;
    text(`${number}`, { x: M, y, size: 9, font: fonts.bold, color: GOLD_TEXT });
    text(heading.toUpperCase(), { x: M + 16, y, size: 9, font: fonts.bold, color: INK });
    y -= 6;
    rule(y, GOLD, 0.8);
    y -= 2;
  };

  /** A panel of rows, measured before it is drawn and never split across a page. */
  const panel = (items: PanelItem[]) => {
    const labelW = 124;
    const valueX = M + 16 + labelW;
    const valueW = CONTENT_W - 30 - labelW;
    const leading = 12;
    type Placed = {
      item: PanelItem;
      offset: number;
      drawn: Array<{ text: string; font: PDFFont; size: number; color: Colour }>;
    };
    const placed: Placed[] = [];
    let offset = 17;
    let lastBaseline = offset;
    for (const item of items) {
      if (item.kind === "divider") {
        const at = lastBaseline + 8;
        placed.push({ item, offset: at, drawn: [] });
        offset = at + 15;
        continue;
      }
      const drawn: Placed["drawn"] = [];
      for (const line of item.lines) {
        const font = item.mono ? fonts.mono : line.bold ? fonts.bold : fonts.regular;
        const size = item.mono ? 8.5 : line.bold ? 10 : 9.5;
        const color = line.muted ? MUTED : line.bold ? INK : BODY;
        const wrapped = item.mono ? [safe(font, line.text)] : lines(line.text, font, size, valueW);
        for (const w of wrapped) drawn.push({ text: w, font, size, color });
      }
      placed.push({ item, offset, drawn });
      lastBaseline = offset + (Math.max(1, drawn.length) - 1) * leading;
      offset = lastBaseline + leading + 2.5;
    }
    const height = lastBaseline + 10;
    ensure(height + 8);
    y -= 8;
    const top = y;
    page.drawRectangle({
      x: M,
      y: top - height,
      width: CONTENT_W,
      height,
      color: PANEL,
      borderColor: PANEL_EDGE,
      borderWidth: 0.6,
    });
    page.drawRectangle({ x: M, y: top - height, width: 2.5, height, color: GOLD });
    for (const p of placed) {
      const at = top - p.offset;
      if (p.item.kind === "divider") {
        rule(at, PANEL_EDGE, 0.6, M + 16, CONTENT_W - 30);
        continue;
      }
      if (p.item.labelStyle === "party") {
        text(p.item.label.toUpperCase(), {
          x: M + 16,
          y: at,
          size: 8,
          font: fonts.bold,
          color: GOLD_TEXT,
        });
      } else {
        text(p.item.label, { x: M + 16, y: at, size: 8, color: MUTED });
      }
      p.drawn.forEach((d, i) => {
        text(d.text, {
          x: valueX,
          y: at - i * leading,
          size: d.size,
          font: d.font,
          color: d.color,
        });
      });
    }
    y = top - height;
  };

  /* ─────────────────────────── the page ─────────────────────────── */

  startPage(true);

  text("Execution Schedule", { x: M, y, size: 24, font: fonts.serif, color: INK });
  y -= 17;
  text(`Schedule to the Aurixa Systems ${BUILDER_PARTNER_DOCUMENT_NAME}`, {
    x: M,
    y,
    size: 10.5,
    font: fonts.bold,
    color: GOLD_TEXT,
  });
  y -= 14;
  text(`Reference ${input.reference}   ·   Issued ${issuedLabel}`, {
    x: M,
    y,
    size: 8.5,
    color: MUTED,
  });
  y -= 10;
  rule(y, GOLD, 1.2);

  y -= 4;
  paragraph(
    `This Execution Schedule forms part of the ${BUILDER_PARTNER_DOCUMENT_NAME} between ${ISSUER_LEGAL_NAME} ` +
      `("Aurixa") and the Builder Partner named below (the "Builder Partner"). It identifies the terms of the ` +
      `agreement, records the Builder Partner's particulars, and is where the agreement is signed.`,
    { size: 9.5, leading: 13.5 },
  );

  // 1 — the parties, set the way an agreement's front page sets them.
  const identifiers = [
    partner.abn ? `ABN ${partner.abn}` : "ABN not provided",
    partner.acn ? `ACN ${partner.acn}` : null,
  ]
    .filter(Boolean)
    .join("   ·   ");
  const partnerLines: PanelLine[] = [
    partner.legalName
      ? { text: partner.legalName, bold: true }
      : { text: "Legal name not provided", muted: true },
  ];
  if (partner.tradingName) partnerLines.push({ text: `Trading as ${partner.tradingName}` });
  partnerLines.push({ text: identifiers, muted: !partner.abn && !partner.acn });
  partnerLines.push(
    partner.address ? { text: partner.address } : { text: "Address not provided", muted: true },
  );
  if (partner.email) partnerLines.push({ text: `Email for notices: ${partner.email}` });
  if (partner.phone) partnerLines.push({ text: `Phone: ${partner.phone}` });
  ensure(SECTION_H + 60);
  section(1, "The parties");
  panel([
    {
      kind: "row",
      label: "Aurixa",
      labelStyle: "party",
      lines: [{ text: ISSUER_LEGAL_NAME, bold: true }],
    },
    { kind: "divider" },
    { kind: "row", label: "The Builder Partner", labelStyle: "party", lines: partnerLines },
  ]);

  // 2 — the terms.
  ensure(SECTION_H + 90);
  section(2, "The terms");
  paragraph(
    "The terms are the document identified here. Any change to it, however small, changes its fingerprint.",
    { size: 8.5, leading: 12, color: MUTED },
  );
  const fileFacts = [
    byteSizeLabel(terms.byteSize),
    terms.pageCount ? `${terms.pageCount} page${terms.pageCount === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  panel([
    row("Title", terms.name),
    row("Version", terms.versionLabel),
    row("File", `${terms.fileName}${fileFacts ? ` (${fileFacts})` : ""}`),
    row("SHA-256 fingerprint", fingerprintLines(terms.sha256).join("\n"), { mono: true }),
  ]);

  // 3 — execution. The statement and the signatures are one unit: measured
  // together, moved to the next page together.
  const statementSize = 9.5;
  const statementLeading = 13.5;
  const statement = paragraphLines(terms.executionStatement, { size: statementSize });
  const blockGap = 10;
  ensure(SECTION_H + statement.length * statementLeading + blockGap + BLOCK.height);
  section(3, "Execution");
  for (const line of statement) {
    y -= statementLeading;
    text(line, { x: M, y, size: statementSize, color: INK });
  }
  y -= blockGap;
  const top = y;
  const colGap = 16;
  const colW = (CONTENT_W - colGap) / 2;
  const innerW = colW - 28;

  const block = (x: number, heading: string, sub: string[]) => {
    page.drawRectangle({
      x,
      y: top - BLOCK.height,
      width: colW,
      height: BLOCK.height,
      color: PANEL,
      borderColor: PANEL_EDGE,
      borderWidth: 0.6,
    });
    page.drawRectangle({ x, y: top - 3, width: colW, height: 3, color: GOLD });
    text(heading, { x: x + 14, y: top - BLOCK.heading, size: 10, font: fonts.bold, color: INK });
    sub.forEach((line, i) =>
      text(line, {
        x: x + 14,
        y: top - BLOCK.subFirst - i * BLOCK.subLeading,
        size: 8,
        color: MUTED,
      }),
    );
  };
  const lineAt = (x: number, atY: number) =>
    page.drawRectangle({ x: x + 14, y: atY, width: innerW, height: 0.8, color: GOLD });
  const label = (x: number, value: string, atY: number) =>
    text(value, { x: x + 14, y: atY - BLOCK.labelDrop, size: 7.5, color: MUTED });
  const printed = (x: number, value: string, atY: number) => {
    const clean = clampLines(lines(value, fonts.regular, 10, innerW), 1, fonts.regular, 10, innerW);
    text(clean[0], { x: x + 14, y: atY + BLOCK.printedRise, size: 10, color: INK });
  };
  const rows = {
    sign: top - BLOCK.signLine,
    name: top - BLOCK.signLine - BLOCK.rowGap,
    title: top - BLOCK.signLine - BLOCK.rowGap * 2,
    date: top - BLOCK.signLine - BLOCK.rowGap * 3,
  };

  // The Builder Partner.
  {
    const x = M;
    const sub = clampLines(
      lines(
        `for and on behalf of ${partner.legalName || "the Builder Partner"}`,
        fonts.regular,
        8,
        innerW,
      ),
      2,
      fonts.regular,
      8,
      innerW,
    );
    block(x, "Signed by the Builder Partner", sub);

    lineAt(x, rows.sign);
    anchor(BUILDER_PARTNER_ANCHORS.partnerSignature, x + 14, rows.sign + BLOCK.anchorRise);
    label(x, "Signature of authorised signatory", rows.sign);

    lineAt(x, rows.name);
    if (signatory.name) printed(x, signatory.name, rows.name);
    label(x, "Name", rows.name);

    lineAt(x, rows.title);
    if (signatory.title) printed(x, signatory.title, rows.title);
    else anchor(BUILDER_PARTNER_ANCHORS.partnerTitle, x + 14, rows.title + BLOCK.anchorRise);
    label(x, "Title or position", rows.title);

    lineAt(x, rows.date);
    anchor(BUILDER_PARTNER_ANCHORS.partnerDate, x + 14, rows.date + BLOCK.anchorRise);
    label(x, "Date signed", rows.date);
  }

  // Aurixa: a countersignature, or the statement that none is required.
  {
    const x = M + colW + colGap;
    if (terms.countersignatureRequired) {
      block(x, `Signed by ${ISSUER_LEGAL_NAME}`, ["by its authorised signatory"]);

      lineAt(x, rows.sign);
      anchor(BUILDER_PARTNER_ANCHORS.aurixaSignature, x + 14, rows.sign + BLOCK.anchorRise);
      label(x, "Signature of authorised signatory", rows.sign);

      lineAt(x, rows.name);
      printed(x, input.countersignerName?.trim() || "Authorised signatory", rows.name);
      label(x, "Name", rows.name);

      // No title row: the date lines stay level across both blocks.
      lineAt(x, rows.date);
      anchor(BUILDER_PARTNER_ANCHORS.aurixaDate, x + 14, rows.date + BLOCK.anchorRise);
      label(x, "Date signed", rows.date);
    } else {
      block(x, `Issued by ${ISSUER_LEGAL_NAME}`, []);
      const note = lines(
        `Aurixa issues this agreement on the terms identified in this schedule. The terms do not ` +
          `require an Aurixa countersignature: the agreement is entered when the Builder Partner signs, ` +
          `and Aurixa receives a copy of the completed agreement.`,
        fonts.regular,
        9,
        innerW,
      );
      note.forEach((line, i) =>
        text(line, { x: x + 14, y: top - 44 - i * 13, size: 9, color: BODY }),
      );
    }
  }
  y = top - BLOCK.height;

  // Every page: the footer, now the page count is known.
  const total = pages.length;
  pages.forEach((p, i) => {
    page = p;
    rule(FOOTER_RULE_Y, HAIRLINE, 0.6);
    text(
      `${input.preview ? "PREVIEW · " : ""}${ISSUER_LEGAL_NAME} · ${BUILDER_PARTNER_DOCUMENT_NAME} · Execution Schedule`,
      { x: M, y: FOOTER_RULE_Y - 13, size: 7.5, color: MUTED },
    );
    textRight(`${input.reference} · Page ${i + 1} of ${total}`, {
      right: PAGE.width - M,
      y: FOOTER_RULE_Y - 13,
      size: 7.5,
      color: MUTED,
    });
    if (input.preview) {
      // Drawn last, over everything, faint enough to read through; centred on
      // the page along its diagonal.
      const size = 118;
      const angle = 38;
      const rad = (angle * Math.PI) / 180;
      const w = fonts.bold.widthOfTextAtSize(PREVIEW_WATERMARK, size);
      const capHalf = (fonts.bold.heightAtSize(size, { descender: false }) * 0.72) / 2;
      const cx = PAGE.width / 2;
      const cy = PAGE.height / 2;
      p.drawText(PREVIEW_WATERMARK, {
        x: cx - (w / 2) * Math.cos(rad) + capHalf * Math.sin(rad),
        y: cy - (w / 2) * Math.sin(rad) - capHalf * Math.cos(rad),
        size,
        font: fonts.bold,
        color: PREVIEW_MARK,
        opacity: 0.08,
        rotate: degrees(angle),
      });
    }
  });

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: total, anchors };
}
