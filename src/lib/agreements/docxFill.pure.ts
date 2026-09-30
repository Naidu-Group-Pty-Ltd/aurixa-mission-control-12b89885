/**
 * Completing a Word template: fill every tagged content control, then remove
 * the controls, so what is issued is a document rather than a form.
 *
 * The subscription agreements are authored in Word with one plain-text
 * content control per Order field (`<w:sdt>` carrying a `<w:tag>` such as
 * `customer.legal_name`) and one repeating section for the additional-purchase
 * records. This module works on `word/document.xml` as a string, which is
 * deliberate: a DOM parser is not available in a Worker, and a full XML
 * round-trip would re-serialise 1.4 MB of Word's markup and risk changing
 * bytes nobody meant to touch. Only the control spans are rewritten; every
 * other byte of the template passes through untouched.
 *
 * The contract is strict in both directions, because the failure it prevents
 * is silent:
 *
 *  - a control with no value is an ERROR, not a blank — clause 1.2 of the
 *    agreement itself says "An uncompleted template is not an offer";
 *  - a value for a tag the template does not contain is an ERROR, because it
 *    means the composer and the template disagree about the form, and the
 *    field the customer should have seen is somewhere else, unfilled;
 *  - a control kind this module does not understand is an ERROR rather than
 *    left in place.
 *
 * `assertIssuedDocument` is the last gate before a document leaves: no
 * control survives, no `[placeholder]` bracket survives, every DocuSign anchor
 * appears exactly once, and the XML is well-formed. The templates carry no
 * square bracket outside their placeholders (a test pins that), so "no
 * bracket in the text" is exactly "no placeholder left".
 */

/** A run of field text, or an invisible DocuSign anchor token. */
export type FieldSegment = { text: string } | { anchor: string };

/**
 * A field's value. A string is plain text in the control's own formatting:
 * `\n` becomes a line break and `\t` a tab. Segments are needed only to place
 * an anchor.
 */
export type FieldValue = string | readonly FieldSegment[];

export type RepeatingFill = {
  /** One record per item, keyed by the item's field tags. */
  items: ReadonlyArray<Readonly<Record<string, FieldValue>>>;
  /** Printed in place of the section when there are no items. */
  whenEmpty: string;
};

export type DocumentFill = {
  fields: Readonly<Record<string, FieldValue>>;
  repeating: Readonly<Record<string, RepeatingFill>>;
};

export type ControlInventory = {
  /** Plain-text controls outside any repeating section, in document order. */
  fields: string[];
  /** Repeating sections, with the field tags of their item. */
  repeating: Array<{ tag: string; itemFields: string[] }>;
};

export class DocxFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxFillError";
  }
}

/* ───────────────────────────── low-level scanning ───────────────────────────── */

/**
 * An `<w:sdt>` open or close. The lookahead matters: `<w:sdtPr>`,
 * `<w:sdtContent>` and `<w:sdtEndPr>` all begin with `<w:sdt`.
 */
const SDT_BOUNDARY = /<w:sdt(?=[\s>])[^>]*>|<\/w:sdt>/g;

type Span = { start: number; end: number };

/** The depth-1 `<w:sdt>` spans in `xml[from, to)`, in order. */
function topLevelSdts(xml: string, from = 0, to = xml.length): Span[] {
  const spans: Span[] = [];
  const re = new RegExp(SDT_BOUNDARY.source, "g");
  re.lastIndex = from;
  let depth = 0;
  let start = -1;
  for (let m = re.exec(xml); m && m.index < to; m = re.exec(xml)) {
    if (m[0] === "</w:sdt>") {
      depth--;
      if (depth < 0) throw new DocxFillError("unbalanced_sdt: a close with no open");
      if (depth === 0) spans.push({ start, end: m.index + m[0].length });
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  if (depth !== 0) throw new DocxFillError("unbalanced_sdt: an open with no close");
  return spans;
}

type SdtKind = "text" | "repeating" | "item";

type ParsedSdt = {
  tag: string | null;
  kind: SdtKind;
  /** The inner XML of `<w:sdtContent>`. */
  content: string;
};

function parseSdt(block: string): ParsedSdt {
  const prOpen = block.indexOf("<w:sdtPr>");
  const prClose = block.indexOf("</w:sdtPr>");
  if (prOpen < 0 || prClose < prOpen) throw new DocxFillError("sdt_without_properties");
  const pr = block.slice(prOpen, prClose);
  const contentOpen = /<w:sdtContent(?:\s[^>]*)?>/.exec(block.slice(prClose));
  const contentClose = block.lastIndexOf("</w:sdtContent>");
  if (!contentOpen || contentClose < 0) throw new DocxFillError("sdt_without_content");
  const contentStart = prClose + contentOpen.index + contentOpen[0].length;

  const tag = /<w:tag w:val="([^"]*)"/.exec(pr)?.[1] ?? null;
  let kind: SdtKind;
  if (/<w15:repeatingSectionItem\b/.test(pr)) kind = "item";
  else if (/<w15:repeatingSection(?=[\s>/])/.test(pr)) kind = "repeating";
  else if (/<w:text(?=[\s>/])/.test(pr)) kind = "text";
  else {
    throw new DocxFillError(
      `unsupported_control: ${tag ?? "(untagged)"} is not a plain-text control or repeating section`,
    );
  }
  return { tag, kind, content: block.slice(contentStart, contentClose) };
}

/* ───────────────────────────── inventory ───────────────────────────── */

/** Every control the template declares, without changing anything. */
export function inventoryControls(xml: string): ControlInventory {
  const fields: string[] = [];
  const repeating: ControlInventory["repeating"] = [];

  const walk = (fragment: string, into: string[], allowRepeating: boolean) => {
    for (const span of topLevelSdts(fragment)) {
      const sdt = parseSdt(fragment.slice(span.start, span.end));
      if (sdt.kind === "text") {
        if (!sdt.tag) throw new DocxFillError("untagged_text_control");
        into.push(sdt.tag);
      } else if (sdt.kind === "repeating") {
        if (!allowRepeating || !sdt.tag) throw new DocxFillError("nested_or_untagged_repeating");
        const itemFields: string[] = [];
        for (const itemSpan of topLevelSdts(sdt.content)) {
          const item = parseSdt(sdt.content.slice(itemSpan.start, itemSpan.end));
          if (item.kind !== "item") throw new DocxFillError(`repeating_without_item: ${sdt.tag}`);
          walk(item.content, itemFields, false);
        }
        repeating.push({ tag: sdt.tag, itemFields: [...new Set(itemFields)] });
      } else {
        throw new DocxFillError("repeating_item_outside_section");
      }
    }
  };

  walk(xml, fields, true);
  return { fields, repeating };
}

/* ───────────────────────────── output ───────────────────────────── */

// XML 1.0 forbids these code points outright; stripping them is the point.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeXmlText(s: string): string {
  return s
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textRunChildren(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines
    .map((line, i) => {
      const pieces = line.split("\t").map((piece, j) => {
        const t = piece ? `<w:t xml:space="preserve">${escapeXmlText(piece)}</w:t>` : "";
        return (j > 0 ? "<w:tab/>" : "") + t;
      });
      return (i > 0 ? "<w:br/>" : "") + pieces.join("");
    })
    .join("");
}

/** The first run's `<w:rPr>` in a control's content — the formatting its value inherits. */
function firstRunProperties(content: string): string {
  const run = /<w:r(?=[\s>])[^>]*>/.exec(content);
  if (!run) throw new DocxFillError("text_control_without_run");
  const runEnd = content.indexOf("</w:r>", run.index);
  const inner = content.slice(run.index, runEnd < 0 ? undefined : runEnd);
  return /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(inner)?.[0] ?? "";
}

/**
 * The shading of the table cell enclosing `pos`, so an anchor can be painted
 * in the colour of what it sits on. A forward scan with a stack, because the
 * nearest `<w:tc>` before a position is not the enclosing one when a nested
 * table closes in between.
 */
function cellFillAt(xml: string, pos: number): string {
  const re = /<w:tc(?=[\s>])[^>]*>|<\/w:tc>/g;
  const stack: number[] = [];
  for (let m = re.exec(xml); m && m.index < pos; m = re.exec(xml)) {
    if (m[0] === "</w:tc>") stack.pop();
    else stack.push(m.index);
  }
  const open = stack.at(-1);
  if (open === undefined) return "FFFFFF";
  const prEnd = xml.indexOf("</w:tcPr>", open);
  if (prEnd < 0 || prEnd > pos) return "FFFFFF";
  const fill = /<w:shd\b[^>]*\bw:fill="([0-9A-Fa-f]{6})"/.exec(xml.slice(open, prEnd))?.[1];
  return fill ? fill.toUpperCase() : "FFFFFF";
}

/** Anchor size: 6pt, as the SLA template prints its tokens. */
const ANCHOR_HALF_POINTS = 12;

function renderValue(value: FieldValue, rPr: string, fill: () => string): string {
  const segments: readonly FieldSegment[] = typeof value === "string" ? [{ text: value }] : value;
  const hasText = segments.some((s) => "text" in s && s.text.trim().length > 0);
  if (!hasText) throw new DocxFillError("empty_field_value");
  return segments
    .map((s) => {
      if ("anchor" in s) {
        if (!/^\\[a-z0-9_]+\\$/.test(s.anchor)) throw new DocxFillError(`bad_anchor: ${s.anchor}`);
        const colour = fill();
        return (
          `<w:r><w:rPr><w:color w:val="${colour}"/><w:sz w:val="${ANCHOR_HALF_POINTS}"/>` +
          `<w:szCs w:val="${ANCHOR_HALF_POINTS}"/></w:rPr>` +
          `<w:t xml:space="preserve">${escapeXmlText(s.anchor)}</w:t></w:r>`
        );
      }
      return s.text ? `<w:r>${rPr}${textRunChildren(s.text)}</w:r>` : "";
    })
    .join("");
}

/** A 6pt gap, so consecutive copies of a table do not merge into one. */
const TABLE_SEPARATOR =
  '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/>' +
  '<w:rPr><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr></w:pPr></w:p>';

function emptySectionParagraph(text: string): string {
  return (
    '<w:p><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="120"/></w:pPr>' +
    '<w:r><w:rPr><w:b/><w:color w:val="102B41"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>' +
    `<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r></w:p>`
  );
}

/* ───────────────────────────── fill ───────────────────────────── */

/**
 * Fill every control in `word/document.xml` and remove the control wrappers.
 *
 * Throws `DocxFillError` for a control with no value, a value with no
 * control, an empty value, or a control kind it cannot fill. Returns the
 * rewritten XML; nothing outside the control spans changes.
 */
export function fillDocumentXml(xml: string, fill: DocumentFill): string {
  const usedFields = new Set<string>();
  const usedRepeating = new Set<string>();

  const transform = (
    fragment: string,
    scope: Readonly<Record<string, FieldValue>>,
    usedScope: Set<string>,
    allowRepeating: boolean,
    /** Where `fragment` starts in the full document, for cell-shading lookups. */
    base: number | null,
  ): string => {
    let out = "";
    let pos = 0;
    for (const span of topLevelSdts(fragment)) {
      out += fragment.slice(pos, span.start);
      pos = span.end;
      const sdt = parseSdt(fragment.slice(span.start, span.end));

      if (sdt.kind === "text") {
        if (!sdt.tag) throw new DocxFillError("untagged_text_control");
        const value = scope[sdt.tag];
        if (value === undefined) throw new DocxFillError(`unfilled_field: ${sdt.tag}`);
        usedScope.add(sdt.tag);
        const at = base === null ? null : base + span.start;
        try {
          out += renderValue(value, firstRunProperties(sdt.content), () =>
            at === null ? "FFFFFF" : cellFillAt(xml, at),
          );
        } catch (err) {
          if (err instanceof DocxFillError) throw new DocxFillError(`${err.message}: ${sdt.tag}`);
          throw err;
        }
        continue;
      }

      if (sdt.kind === "repeating") {
        if (!allowRepeating || !sdt.tag) throw new DocxFillError("nested_or_untagged_repeating");
        const section = fill.repeating[sdt.tag];
        if (!section) throw new DocxFillError(`unfilled_repeating_section: ${sdt.tag}`);
        usedRepeating.add(sdt.tag);
        const items = topLevelSdts(sdt.content).map((s) =>
          parseSdt(sdt.content.slice(s.start, s.end)),
        );
        if (items.length !== 1 || items[0].kind !== "item") {
          throw new DocxFillError(`repeating_section_shape: ${sdt.tag} must hold exactly one item`);
        }
        const prototype = items[0].content;
        if (section.items.length === 0) {
          out += emptySectionParagraph(section.whenEmpty);
          continue;
        }
        out += section.items
          .map((record, i) => {
            const used = new Set<string>();
            const filled = transform(prototype, record, used, false, null);
            const unused = Object.keys(record).filter((k) => !used.has(k));
            if (unused.length) {
              throw new DocxFillError(
                `unused_item_value: ${sdt.tag}[${i}] ${unused.sort().join(", ")}`,
              );
            }
            return filled;
          })
          .join(TABLE_SEPARATOR);
        continue;
      }

      throw new DocxFillError("repeating_item_outside_section");
    }
    return out + fragment.slice(pos);
  };

  const result = transform(xml, fill.fields, usedFields, true, 0);

  const unusedFields = Object.keys(fill.fields).filter((k) => !usedFields.has(k));
  if (unusedFields.length) {
    throw new DocxFillError(`unused_field_value: ${unusedFields.sort().join(", ")}`);
  }
  const unusedRepeating = Object.keys(fill.repeating).filter((k) => !usedRepeating.has(k));
  if (unusedRepeating.length) {
    throw new DocxFillError(`unused_repeating_value: ${unusedRepeating.sort().join(", ")}`);
  }
  return result;
}

/* ───────────────────────────── reading and gates ───────────────────────────── */

function unescapeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * The visible text of a document part: `<w:t>` contents, one line per
 * paragraph. Tabs and breaks are rendered as whitespace. For gates and tests;
 * not a faithful rendering.
 */
export function documentText(xml: string): string {
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] !== undefined) out.push(unescapeXmlText(m[1]));
    else if (m[0] === "</w:p>") out.push("\n");
    else out.push(m[0] === "<w:tab/>" ? "\t" : "\n");
  }
  return out.join("");
}

/**
 * A tag-balance check over the whole part. Not a validating parser — enough to
 * catch the defects string surgery can introduce: an unclosed element, a
 * mismatched close, a stray `<` or an unescaped `&` in text.
 */
export function assertWellFormedXml(xml: string): void {
  const re =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const stack: string[] = [];
  let last = 0;
  const badText = /<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const gap = xml.slice(last, m.index);
    if (badText.test(gap)) throw new DocxFillError(`malformed_xml: bad text near offset ${last}`);
    last = m.index + m[0].length;
    const name = m[2];
    if (!name) continue; // comment, declaration, CDATA
    if (m[1]) {
      const open = stack.pop();
      if (open !== name) {
        throw new DocxFillError(
          `malformed_xml: </${name}> closes <${open ?? "nothing"}> at offset ${m.index}`,
        );
      }
    } else if (!m[4]) {
      stack.push(name);
    }
  }
  if (badText.test(xml.slice(last))) throw new DocxFillError("malformed_xml: bad trailing text");
  if (stack.length) throw new DocxFillError(`malformed_xml: <${stack.at(-1)}> is never closed`);
}

/**
 * The last gate before a completed document leaves: no control, no
 * placeholder, every anchor exactly once, well-formed.
 */
export function assertIssuedDocument(xml: string, opts: { anchors: readonly string[] }): void {
  if (new RegExp(SDT_BOUNDARY.source).test(xml) || xml.includes("w15:repeatingSection")) {
    throw new DocxFillError("issued_document_still_has_controls");
  }
  const text = documentText(xml);
  const bracket = text.indexOf("[");
  if (bracket >= 0) {
    const context = text.slice(Math.max(0, bracket - 40), bracket + 60).replace(/\s+/g, " ");
    throw new DocxFillError(`issued_document_has_placeholder: …${context}…`);
  }
  for (const anchor of opts.anchors) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      throw new DocxFillError(`issued_document_anchor_count: ${anchor} appears ${count} times`);
    }
  }
  assertWellFormedXml(xml);
}
