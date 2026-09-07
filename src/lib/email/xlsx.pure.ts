/**
 * An Excel workbook, read from its parts.
 *
 * The four things that decide whether a real export comes out right:
 *
 * **Shared strings.** Text is not in the sheet. `<c t="s"><v>7</v></c>` means
 * "entry 7 of `sharedStrings.xml`", so a reader that takes `<v>` at face value
 * turns every name and address in the file into a small integer.
 *
 * **Missing cells.** An empty cell is usually absent rather than empty, so
 * columns are placed by their `A1` reference and never by counting `<c>`
 * elements. Counting is how one blank cell shifts the email column onto the
 * postcode.
 *
 * **Dates are numbers.** `2023-03-15` is stored as `45000` and the only thing
 * that says otherwise is a number format id in `styles.xml`. Without that
 * lookup a "last contacted" column reads as five-digit integers, which is not
 * obviously wrong on screen and is completely wrong as a campaign parameter.
 *
 * **The 1900 leap-year bug is real.** Excel believes 1900-02-29 existed.
 * Serials at or below 60 are therefore off by a day unless the conversion says
 * so, and the workbook may also be on the 1904 epoch instead.
 */
import { readCentralDirectory, readZipEntry, ZipError, type ZipEntry } from "./zip.pure";

export type XlsxSheet = { name: string; path: string; hidden: boolean };

export type XlsxRead = {
  sheets: XlsxSheet[];
  sheetIndex: number;
  /** Dense grid: every row padded to the widest row seen. */
  grid: string[][];
  truncated: boolean;
};

export type XlsxOptions = {
  sheetIndex?: number;
  /** Hard ceiling so a mis-sized workbook cannot exhaust the tab's memory. */
  maxRows?: number;
  maxColumns?: number;
};

export const DEFAULT_MAX_ROWS = 1_000_000;
export const DEFAULT_MAX_COLUMNS = 512;

/** Number-format ids Excel reserves for dates and times. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode XML text. `_x000D_` is not an XML entity — it is Excel's own escape
 * for a carriage return inside a shared string, and left in place it appears
 * verbatim in the middle of an address.
 */
export function decodeXmlText(raw: string): string {
  return raw
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return XML_ENTITIES[body] ?? whole;
    })
    .replace(/_x000D_/g, "\r")
    .replace(/_x000A_/g, "\n");
}

/** An attribute off a start tag's attribute text. */
export function attr(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match ? decodeXmlText(match[1]) : null;
}

/** `A1` / `BC42` → zero-based column index. */
export function columnIndexOf(reference: string): number {
  let index = 0;
  for (const ch of reference) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) index = index * 26 + (code - 64);
    else if (code >= 97 && code <= 122) index = index * 26 + (code - 96);
    else break;
  }
  return index - 1;
}

/**
 * Excel serial → a naive ISO string.
 *
 * Serial 25569 is 1970-01-01 on the 1900 epoch; below 61 a day is added back,
 * because everything at or under Excel's phantom 1900-02-29 is shifted by the
 * bug it inherited from Lotus. The result carries no timezone: a date in a
 * spreadsheet has none, and attaching the reader's own is how a birthday moves
 * overnight.
 */
export function excelSerialToIso(serial: number, date1904: boolean): string {
  const days = date1904 ? serial : serial < 61 ? serial + 1 : serial;
  const epochDays = date1904 ? 24107 : 25569;
  const ms = Math.round((days - epochDays) * 86400000);
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = date.toISOString();
  // A whole-day serial is a date, not a moment. Printing midnight on it
  // invents a precision the cell never had.
  return Math.abs(serial - Math.floor(serial)) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 19);
}

/**
 * Whether a format code describes a date.
 *
 * Literals are removed first: `"May"` in quotes, `[Red]` colour sections and
 * `\d` escapes all contain letters that would otherwise read as date tokens,
 * and `General` is spelled with an `e` and an `n` but is not a date.
 */
export function formatCodeIsDate(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  if (/^\s*general\s*$/i.test(bare)) return false;
  return /[ymdhs]/i.test(bare);
}

function tagBody(xml: string, tag: string): string | null {
  const open = new RegExp(`<${tag}\\b[^>]*?(/)?>`, "i").exec(xml);
  if (!open) return null;
  if (open[1]) return "";
  const start = open.index + open[0].length;
  const close = xml.indexOf(`</${tag}`, start);
  return close < 0 ? xml.slice(start) : xml.slice(start, close);
}

/** All `<t>` text inside a shared-string or inline-string element. */
function stringElementText(body: string): string {
  // Phonetic runs carry their own <t> and are furniture, not content.
  const withoutPhonetics = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let text = "";
  for (const match of withoutPhonetics.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    text += decodeXmlText(match[1] ?? "");
  }
  return text;
}

export function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    out.push(match[1] ? stringElementText(match[1]) : "");
  }
  return out;
}

/** For each `cellXfs` entry, whether that style renders as a date. */
export function parseDateStyles(xml: string | null): boolean[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  const numFmts = tagBody(xml, "numFmts");
  if (numFmts) {
    for (const match of numFmts.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
      const id = Number(attr(match[1], "numFmtId"));
      const code = attr(match[1], "formatCode");
      if (Number.isFinite(id) && code != null) custom.set(id, code);
    }
  }
  const cellXfs = tagBody(xml, "cellXfs");
  if (!cellXfs) return [];
  const out: boolean[] = [];
  for (const match of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(attr(match[1], "numFmtId") ?? "0");
    const code = custom.get(id);
    out.push(code != null ? formatCodeIsDate(code) : BUILTIN_DATE_FORMATS.has(id));
  }
  return out;
}

/** `<sheet>` entries joined to their part paths through the workbook rels. */
export function parseWorkbookSheets(workbookXml: string, relsXml: string | null): XlsxSheet[] {
  const targets = new Map<string, string>();
  if (relsXml) {
    for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = attr(match[1], "Id");
      const target = attr(match[1], "Target");
      if (id && target) targets.set(id, target);
    }
  }
  const sheets: XlsxSheet[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(match[1], "name") ?? `Sheet${sheets.length + 1}`;
    const rid = attr(match[1], "r:id") ?? attr(match[1], "id");
    const state = attr(match[1], "state");
    const target = (rid && targets.get(rid)) || `worksheets/sheet${sheets.length + 1}.xml`;
    const path = target.startsWith("/")
      ? target.slice(1)
      : target.startsWith("xl/")
        ? target
        : `xl/${target}`;
    sheets.push({ name, path, hidden: state === "hidden" || state === "veryHidden" });
  }
  return sheets;
}

/** One worksheet part → a dense grid of display strings. */
export function parseWorksheet(
  xml: string,
  shared: string[],
  dateStyles: boolean[],
  date1904: boolean,
  maxRows: number,
  maxColumns: number,
): { grid: string[][]; truncated: boolean } {
  const data = tagBody(xml, "sheetData") ?? "";
  const grid: string[][] = [];
  let width = 0;
  let truncated = false;
  let rowCursor = 0;

  for (const rowMatch of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (grid.length >= maxRows) {
      truncated = true;
      break;
    }
    const declared = Number(attr(rowMatch[1], "r") ?? "");
    // A skipped row number is a blank row; keeping the gap preserves the
    // alignment between what the operator sees in Excel and what we parsed.
    const rowIndex = Number.isFinite(declared) && declared > 0 ? declared - 1 : rowCursor;
    rowCursor = rowIndex + 1;
    const cells: string[] = [];
    let cellCursor = 0;

    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const reference = attr(attributes, "r");
      const column = reference ? columnIndexOf(reference) : cellCursor;
      cellCursor = column + 1;
      if (column < 0 || column >= maxColumns) {
        if (column >= maxColumns) truncated = true;
        continue;
      }

      const type = attr(attributes, "t") ?? "n";
      let value = "";

      if (type === "inlineStr") {
        const is = tagBody(body, "is");
        value = is != null ? stringElementText(is) : stringElementText(body);
      } else {
        const raw = decodeXmlText(tagBody(body, "v") ?? "");
        if (type === "s") {
          const index = Number(raw);
          value = Number.isFinite(index) ? (shared[index] ?? "") : "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
        } else if (type === "str" || type === "e" || type === "d") {
          value = raw;
        } else {
          const styleIndex = Number(attr(attributes, "s") ?? "");
          const isDate = Number.isFinite(styleIndex) && dateStyles[styleIndex] === true;
          const numeric = Number(raw);
          value =
            isDate && raw !== "" && Number.isFinite(numeric)
              ? excelSerialToIso(numeric, date1904)
              : raw;
        }
      }

      while (cells.length < column) cells.push("");
      cells[column] = value;
    }

    while (grid.length < rowIndex) grid.push([]);
    grid[rowIndex] = cells;
    if (cells.length > width) width = cells.length;
  }

  for (const row of grid) {
    while (row.length < width) row.push("");
  }
  return { grid, truncated };
}

/** Read a workbook's bytes into one sheet's grid. */
export async function readXlsx(bytes: Uint8Array, options: XlsxOptions = {}): Promise<XlsxRead> {
  const entries: ZipEntry[] = readCentralDirectory(bytes);
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e] as const));
  const text = async (name: string): Promise<string | null> => {
    const entry = byName.get(name.toLowerCase());
    return entry ? new TextDecoder().decode(await readZipEntry(bytes, entry)) : null;
  };

  const workbookXml = await text("xl/workbook.xml");
  if (!workbookXml) {
    throw new ZipError(
      "this is a zip archive but not a spreadsheet — it carries no xl/workbook.xml",
    );
  }
  const sheets = parseWorkbookSheets(workbookXml, await text("xl/_rels/workbook.xml.rels"));
  if (sheets.length === 0) throw new ZipError("the workbook declares no sheets");

  const requested = options.sheetIndex ?? -1;
  const sheetIndex =
    requested >= 0 && requested < sheets.length
      ? requested
      : Math.max(
          0,
          sheets.findIndex((s) => !s.hidden),
        );
  const sheet = sheets[sheetIndex];

  const date1904 = /date1904\s*=\s*"(1|true)"/i.test(workbookXml);
  const shared = parseSharedStrings(await text("xl/sharedStrings.xml"));
  const dateStyles = parseDateStyles(await text("xl/styles.xml"));

  const sheetXml = await text(sheet.path);
  if (sheetXml == null)
    throw new ZipError(`the workbook names "${sheet.path}" but does not hold it`);

  const { grid, truncated } = parseWorksheet(
    sheetXml,
    shared,
    dateStyles,
    date1904,
    options.maxRows ?? DEFAULT_MAX_ROWS,
    options.maxColumns ?? DEFAULT_MAX_COLUMNS,
  );

  return { sheets, sheetIndex, grid, truncated };
}
