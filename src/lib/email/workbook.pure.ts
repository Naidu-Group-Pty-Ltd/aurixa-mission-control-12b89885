/**
 * Whatever the operator dropped on the page, read as a table.
 *
 * The rule here is that **the bytes decide the format, never the MIME type or
 * the extension**. A contact list arrives from a CRM export, a mail-merge
 * template, a colleague's Downloads folder — and the label it carries is
 * whatever the sending tool felt like: `text/csv`, `application/vnd.ms-excel`
 * on a file that is really CSV, `application/octet-stream` from a browser that
 * recognised nothing, or an empty string. Refusing on the label rejects files
 * this parser reads perfectly; trusting it hands a ZIP to the CSV reader. So
 * the uploader accepts every MIME type and this module opens the file and
 * looks.
 *
 * One format is deliberately refused rather than guessed at: the legacy
 * OLE2 `.xls`. It is a compound binary document, nothing here can read it, and
 * a reader that half-succeeds on it produces a table of mojibake that looks
 * like a parsing bug rather than an unsupported format. The refusal names the
 * remedy instead.
 */
import { readDelimited, stripBom } from "./tabular.pure";
import { readXlsx, type XlsxSheet } from "./xlsx.pure";

export type TableFormat = "delimited" | "xlsx" | "json" | "ndjson";

export type ParsedTable = {
  headers: string[];
  rows: string[][];
  format: TableFormat;
  delimiter?: string;
  sheets?: XlsxSheet[];
  sheetIndex?: number;
  /** True when a ceiling stopped the read before the end of the data. */
  truncated: boolean;
  /** Things the operator should know about how this was read. */
  notes: string[];
};

export class UnreadableFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableFileError";
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06];
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

/**
 * Decode bytes as text, honouring a byte-order mark and recognising UTF-16
 * without one.
 *
 * Excel's "Unicode Text" export is UTF-16LE, and read as UTF-8 it becomes
 * every character followed by a NUL — which parses as a table with one
 * enormous column rather than failing.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let nulls = 0;
  for (const byte of sample) if (byte === 0) nulls++;
  if (sample.length > 8 && nulls / sample.length > 0.25) {
    // Which endianness: ASCII text in UTF-16LE puts the NUL on odd offsets.
    let oddNulls = 0;
    for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) oddNulls++;
    return new TextDecoder(oddNulls * 2 > nulls ? "utf-16le" : "utf-16be").decode(bytes);
  }
  // `fatal: false` — one bad byte in a 40 MB export must not lose the file.
  return new TextDecoder("utf-8").decode(bytes);
}

/** The first row carrying any content is the header; everything above is furniture. */
export function splitHeaderRow(grid: string[][]): { headers: string[]; rows: string[][] } {
  let headerIndex = grid.findIndex((row) => row.some((cell) => (cell ?? "").trim() !== ""));
  if (headerIndex < 0) headerIndex = 0;
  const headers = (grid[headerIndex] ?? []).map((cell) => (cell ?? "").trim());
  const width = headers.length;
  const rows = grid.slice(headerIndex + 1).map((row) => {
    const next = row.slice(0, Math.max(width, row.length)).map((cell) => cell ?? "");
    while (next.length < width) next.push("");
    return next;
  });
  return { headers, rows };
}

/** Records → a table, with the union of every record's keys as the header. */
export function tableFromRecords(records: Record<string, unknown>[]): {
  headers: string[];
  rows: string[][];
} {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const rows = records.map((record) =>
    headers.map((key) => {
      const value = (record ?? {})[key];
      if (value == null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }),
  );
  return { headers, rows };
}

function readJsonish(text: string): { headers: string[]; rows: string[][]; format: TableFormat } {
  const trimmed = stripBom(text).trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && Array.isArray(parsed[0])) {
        const grid = (parsed as unknown[][]).map((row) =>
          row.map((cell) => (cell == null ? "" : String(cell))),
        );
        return { ...splitHeaderRow(grid), format: "json" };
      }
      return {
        ...tableFromRecords(parsed as Record<string, unknown>[]),
        format: "json",
      };
    }
    if (parsed && typeof parsed === "object") {
      // A wrapped payload: `{ "contacts": [ … ] }`, which is what most APIs
      // hand back and what an operator will paste in as-is.
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
          return {
            ...tableFromRecords(value as Record<string, unknown>[]),
            format: "json",
          };
        }
      }
      return { ...tableFromRecords([parsed as Record<string, unknown>]), format: "json" };
    }
  } catch {
    // Fall through to newline-delimited JSON.
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UnreadableFileError("this looks like JSON but is not a list of records");
    }
    records.push(value as Record<string, unknown>);
  }
  if (records.length === 0) throw new UnreadableFileError("this JSON file holds no records");
  return { ...tableFromRecords(records), format: "ndjson" };
}

export type ParseOptions = {
  /** Which worksheet to read. Ignored for every other format. */
  sheetIndex?: number;
  maxRows?: number;
  maxColumns?: number;
};

export async function parseListFile(
  bytes: Uint8Array,
  fileName = "",
  options: ParseOptions = {},
): Promise<ParsedTable> {
  const notes: string[] = [];

  if (bytes.length === 0) throw new UnreadableFileError("the file is empty");

  if (startsWith(bytes, OLE2_MAGIC)) {
    throw new UnreadableFileError(
      "this is a legacy .xls workbook. Open it in Excel and save as .xlsx or CSV — a partial read of this format would produce a table that looks parsed and is not.",
    );
  }

  if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, ZIP_EMPTY_MAGIC)) {
    const read = await readXlsx(bytes, options);
    const sheet = read.sheets[read.sheetIndex];
    if (read.sheets.length > 1) {
      notes.push(
        `The workbook has ${read.sheets.length} sheets; "${sheet?.name ?? "the first"}" was read.`,
      );
    }
    if (read.truncated)
      notes.push("The sheet was larger than this reader's ceiling and was cut short.");
    const { headers, rows } = splitHeaderRow(read.grid);
    return {
      headers,
      rows,
      format: "xlsx",
      sheets: read.sheets,
      sheetIndex: read.sheetIndex,
      truncated: read.truncated,
      notes,
    };
  }

  const text = decodeText(bytes);
  const head = stripBom(text).trimStart();

  if (head.startsWith("{") || head.startsWith("[")) {
    const { headers, rows, format } = readJsonish(text);
    return { headers, rows, format, truncated: false, notes };
  }

  const lower = fileName.toLowerCase();
  const forced = lower.endsWith(".tsv") ? "\t" : undefined;
  const table = readDelimited(text, forced);
  if (table.headers.length === 0) {
    throw new UnreadableFileError("nothing in this file reads as a table of rows and columns");
  }
  if (table.headers.length === 1) {
    notes.push(
      "Only one column was found — if this file uses an unusual separator, save it as CSV and upload that.",
    );
  }
  return {
    headers: table.headers,
    rows: table.rows,
    format: "delimited",
    delimiter: table.delimiter,
    truncated: false,
    notes,
  };
}
