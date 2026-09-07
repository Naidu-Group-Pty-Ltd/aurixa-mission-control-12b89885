/**
 * Delimited text — CSV, TSV, semicolon-separated, pipe-separated.
 *
 * Written rather than depended on, for a reason worth stating once: the
 * obvious package for the neighbouring format (SheetJS `xlsx` on npm) is
 * frozen at a version carrying published prototype-pollution and ReDoS
 * advisories, and this repository already keeps a note in `package.json` about
 * pinning transitive dependencies away from exactly that. A parser this size,
 * with its own tests, has no supply chain.
 *
 * Three things that decide whether a real export reads correctly:
 *
 *   * **A quoted field may contain the delimiter, a newline, and quotes.** The
 *     naive `line.split(",")` splits `"Smith, John"` into two fields and
 *     shifts every column after it — which does not fail, it silently reads
 *     the phone column as the email column.
 *   * **The delimiter is sniffed, not assumed.** A European Excel writes
 *     semicolons; a database export writes tabs; "CSV" names none of them.
 *   * **The byte-order mark is not part of the first header.** A BOM left in
 *     place makes the first column key `\uFEFFemail` rather than `email`, which
 *     then matches no merge field and no email-column heuristic.
 */

export type DelimitedTable = {
  /** Header cells, in order, exactly as written. */
  headers: string[];
  /** Data rows. Short rows are padded, long rows are kept whole. */
  rows: string[][];
  delimiter: string;
};

export const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

/** Strip a UTF-8 BOM. Excel writes one on every CSV it exports. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Which delimiter this text uses.
 *
 * Decided by consistency rather than by frequency: the winner is the character
 * that gives the most rows the SAME field count, because a delimiter that
 * merely occurs a lot is usually prose. Ties go to the earlier candidate, so
 * a comma wins where nothing distinguishes them.
 */
export function sniffDelimiter(text: string, sampleRows = 20): string {
  const sample = stripBom(text);
  let best = { delimiter: ",", score: -1, fields: 0 };

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const rows = parseDelimited(sample, delimiter, sampleRows + 1).all;
    if (rows.length === 0) continue;
    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    let modal = 0;
    let modalCount = 0;
    for (const [fields, count] of counts) {
      if (count > modalCount || (count === modalCount && fields > modal)) {
        modal = fields;
        modalCount = count;
      }
    }
    // One field means the delimiter never appeared — not a candidate at all.
    if (modal < 2) continue;
    // Agreement across rows, weighted by how many columns that agreement is
    // about: a file that is genuinely 6 columns of semicolons should beat the
    // same file read as 2 columns of commas.
    const score = modalCount * 100 + modal;
    if (score > best.score) best = { delimiter, score, fields: modal };
  }

  return best.score < 0 ? "," : best.delimiter;
}

/**
 * RFC 4180-ish scan. `limit` caps the number of records read, which is what
 * makes delimiter sniffing cheap on a 200 MB file.
 */
export function parseDelimited(
  text: string,
  delimiter: string,
  limit = Number.POSITIVE_INFINITY,
): { all: string[][] } {
  const source = stripBom(text);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;

  const endField = () => {
    row.push(field);
    field = "";
    sawAny = true;
  };
  const endRow = () => {
    endField();
    // A trailing newline produces one empty field; that is not a record.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === "\r") {
      // CRLF and a lone CR both end the record.
      if (source[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= limit) return { all: rows };
      continue;
    }
    if (ch === "\n") {
      endRow();
      if (rows.length >= limit) return { all: rows };
      continue;
    }
    field += ch;
  }

  if (field !== "" || sawAny || row.length > 0) endRow();
  return { all: rows };
}

/**
 * Read delimited text into headers plus rows.
 *
 * The header row is the first record that carries at least one non-empty cell.
 * Exports routinely begin with a title line or a blank line, and taking record
 * zero unconditionally makes every column key an empty string.
 */
export function readDelimited(text: string, delimiter?: string): DelimitedTable {
  const chosen = delimiter ?? sniffDelimiter(text);
  const records = parseDelimited(text, chosen).all;

  let headerIndex = records.findIndex((r) => r.some((cell) => cell.trim() !== ""));
  if (headerIndex < 0) headerIndex = 0;

  const headers = (records[headerIndex] ?? []).map((cell) => cell.trim());
  const width = headers.length;
  const rows = records.slice(headerIndex + 1).map((record) => {
    if (record.length >= width) return record;
    // Pad rather than leave holes: a short row is a row whose trailing cells
    // were empty, and callers index by column position.
    return record.concat(new Array(width - record.length).fill(""));
  });

  return { headers, rows, delimiter: chosen };
}
