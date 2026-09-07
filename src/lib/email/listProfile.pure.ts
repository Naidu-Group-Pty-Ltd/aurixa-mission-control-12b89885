/**
 * What an uploaded list actually contains, and which of its columns can carry
 * a rule.
 *
 * The product's distinguishing feature is that a quota may be set on a column
 * the operator never told us about — "no more than 20 a day to NSW", where
 * `State` is simply a heading that happened to be in the spreadsheet. That
 * only works if the parse produces a description of each column good enough to
 * offer as a control: how full it is, how many distinct values it holds, and
 * what those values are.
 *
 * Two judgements are made here and both are visible to the operator rather
 * than silent:
 *
 * **Which column holds the address.** Guessed from the heading first and from
 * the content second, and always overridable — a list whose email column is
 * called `Primary Contact` and whose `Email` column is empty is common enough
 * that content has to be able to outvote a heading.
 *
 * **Which columns are worth offering as parameters.** A column is a parameter
 * when its values REPEAT: `State` with four distinct values across 800 rows is
 * a control, `Full Name` with 800 distinct values across 800 rows is not, and
 * offering the second one produces a picker with 800 entries and no meaning.
 *
 * What is NOT done here is normalising anybody's data. `NSW` and
 * `New South Wales` are left as two values, because collapsing them is a
 * decision about somebody's list that the product is not entitled to take
 * quietly — a quota rule covers a SET of values instead, and the operator
 * selects both. `auStateSiblings` exists only to pre-tick that box.
 */
import { emailKey, isValidEmail } from "./emailAddress.pure";

/** Above this a column is a free-text field, not a control. */
export const MAX_DIMENSION_VALUES = 200;
/** Attribute keys carried onto every recipient row. */
export const MAX_ATTRIBUTES = 64;
/** Longest attribute value stored. Merge data, not documents. */
export const MAX_ATTRIBUTE_LENGTH = 1024;

export type ColumnValue = {
  /** The normalised value a quota rule matches on. */
  value: string;
  /** A representative spelling, for the operator to read. */
  label: string;
  count: number;
};

export type ColumnProfile = {
  key: string;
  header: string;
  index: number;
  filled: number;
  distinct: number;
  /** Share of the non-empty cells that read as an email address. */
  emailRatio: number;
  isDimension: boolean;
  /** Most common values first. Capped at MAX_DIMENSION_VALUES. */
  values: ColumnValue[];
  truncatedValues: boolean;
};

export type ListProfile = {
  columns: ColumnProfile[];
  emailColumnKey: string | null;
  totalRows: number;
};

/** Headings that name an address column outright, most specific first. */
const EMAIL_HEADER_PATTERNS = [
  /^e[\s_-]?mail(\s*address)?$/i,
  /^email$/i,
  /(^|[\s_-])e[\s_-]?mail([\s_-]|$)/i,
  /(^|[\s_-])mail([\s_-]|$)/i,
  /contact.*(e[\s_-]?mail)/i,
];

/** A heading → a stable key usable as a merge field and a jsonb key. */
export function columnKey(header: string, taken: Set<string>, index: number): string {
  let base = String(header ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = `column_${index + 1}`;
  if (/^[0-9]/.test(base)) base = `c_${base}`;
  let key = base;
  let suffix = 2;
  while (taken.has(key)) key = `${base}_${suffix++}`;
  taken.add(key);
  return key;
}

/**
 * The form a value is compared in. Case-folded and whitespace-collapsed, so
 * ` nsw` and `NSW` are one allowance — but nothing beyond that, because every
 * further step is an opinion about somebody else's data.
 */
export function normaliseValue(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const AU_STATES: Record<string, string[]> = {
  NSW: ["nsw", "new south wales", "n.s.w.", "n s w"],
  VIC: ["vic", "victoria", "v.i.c."],
  QLD: ["qld", "queensland", "q.l.d."],
  WA: ["wa", "western australia", "w.a."],
  SA: ["sa", "south australia", "s.a."],
  TAS: ["tas", "tasmania", "t.a.s."],
  ACT: ["act", "australian capital territory", "a.c.t."],
  NT: ["nt", "northern territory", "n.t."],
};

/**
 * Other spellings of the same Australian state, as normalised values.
 *
 * A hint for the quota builder and nothing more: it pre-selects the siblings a
 * list actually contains so `NSW` and `New South Wales` become one rule in one
 * click. It never rewrites a stored value, and a list that spells things some
 * third way is unaffected rather than mangled.
 */
export function auStateSiblings(value: string): string[] {
  const needle = normaliseValue(value);
  for (const spellings of Object.values(AU_STATES)) {
    if (spellings.includes(needle)) return spellings;
  }
  return [];
}

/** The canonical code for an Australian state spelling, or null. */
export function auStateCode(value: string): string | null {
  const needle = normaliseValue(value);
  for (const [code, spellings] of Object.entries(AU_STATES)) {
    if (spellings.includes(needle)) return code;
  }
  return null;
}

/** Profile every column of a parsed table and pick the address column. */
export function profileTable(headers: string[], rows: string[][]): ListProfile {
  const taken = new Set<string>();
  const keys = headers.map((header, index) => columnKey(header, taken, index));

  const columns: ColumnProfile[] = keys.map((key, index) => {
    const counts = new Map<string, { label: string; count: number }>();
    let filled = 0;
    let emails = 0;
    let overflowed = false;

    for (const row of rows) {
      const raw = row[index] ?? "";
      if (raw.trim() === "") continue;
      filled++;
      if (isValidEmail(raw)) emails++;
      const value = normaliseValue(raw);
      const existing = counts.get(value);
      if (existing) existing.count++;
      else if (counts.size < MAX_DIMENSION_VALUES + 1) {
        counts.set(value, { label: raw.trim(), count: 1 });
      } else {
        overflowed = true;
      }
    }

    const values = [...counts.entries()]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, MAX_DIMENSION_VALUES);

    const distinct = overflowed ? MAX_DIMENSION_VALUES + 1 : counts.size;
    // A column whose every value is unique is an identifier, not a control —
    // but only once there is enough of it to tell. On twelve rows, four of
    // which happen to be unique, "all unique" means nothing.
    const allUnique = distinct === filled && filled > 20;
    const isDimension =
      filled > 0 && distinct > 0 && distinct <= MAX_DIMENSION_VALUES && !allUnique;

    return {
      key,
      header: headers[index] ?? key,
      index,
      filled,
      distinct,
      emailRatio: filled === 0 ? 0 : emails / filled,
      isDimension,
      values,
      truncatedValues: overflowed,
    };
  });

  const emailColumnKey = pickEmailColumn(columns);
  // The address column is never also a parameter: a quota per address is a
  // quota of one, and it would fill the picker with every contact in the list.
  for (const column of columns) {
    if (column.key === emailColumnKey) column.isDimension = false;
  }

  return { columns, emailColumnKey, totalRows: rows.length };
}

/** Heading first, content second, content wins when the heading's column is empty. */
export function pickEmailColumn(columns: ColumnProfile[]): string | null {
  const named = columns.filter((column) =>
    EMAIL_HEADER_PATTERNS.some((pattern) => pattern.test(column.header.trim())),
  );
  const namedAndPopulated = named.filter((column) => column.emailRatio >= 0.5);
  if (namedAndPopulated.length > 0) {
    return namedAndPopulated.sort((a, b) => b.emailRatio - a.emailRatio || a.index - b.index)[0]
      .key;
  }

  const byContent = columns
    .filter((column) => column.emailRatio >= 0.5 && column.filled > 0)
    .sort((a, b) => b.emailRatio - a.emailRatio || b.filled - a.filled || a.index - b.index);
  if (byContent.length > 0) return byContent[0].key;

  // Nothing looks like an address. Fall back to the heading alone so the page
  // can show the operator a column and let them correct it, rather than
  // showing nothing and looking broken.
  return named.length > 0 ? named[0].key : null;
}

export type ContactRow = {
  email: string;
  email_key: string;
  row_number: number;
  attributes: Record<string, string>;
  attributes_norm: Record<string, string>;
};

export type ContactExtraction = {
  contacts: ContactRow[];
  invalid: { row_number: number; value: string }[];
  duplicates: number;
};

/**
 * Turn a parsed table into contacts.
 *
 * Deduplication happens here as well as in the database, and the two are not
 * redundant: the constraint stops a duplicate being STORED, this counts them
 * so the operator is told that 5,000 rows produced 4,812 contacts instead of
 * being left to wonder. The row number travels with every rejection for the
 * same reason — "112 addresses were unreadable" is not actionable; a list of
 * rows is.
 */
export function extractContacts(
  headers: string[],
  rows: string[][],
  profile: ListProfile,
  emailColumnKey?: string | null,
): ContactExtraction {
  const chosen = emailColumnKey ?? profile.emailColumnKey;
  const emailColumn = profile.columns.find((column) => column.key === chosen);
  if (!emailColumn) return { contacts: [], invalid: [], duplicates: 0 };

  // Attribute keys are capped: a spreadsheet with 300 columns would otherwise
  // copy all of them onto every recipient row, and the ones past the cap are
  // never offered as parameters anyway.
  const carried = profile.columns
    .filter((column) => column.key !== emailColumn.key && column.filled > 0)
    .slice(0, MAX_ATTRIBUTES);

  const contacts: ContactRow[] = [];
  const invalid: { row_number: number; value: string }[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const raw = row[emailColumn.index] ?? "";
    if (raw.trim() === "") return;
    const key = emailKey(raw);
    if (!key) {
      if (invalid.length < 500) invalid.push({ row_number: rowNumber, value: raw.slice(0, 120) });
      return;
    }
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);

    const attributes: Record<string, string> = {};
    const attributesNorm: Record<string, string> = {};
    for (const column of carried) {
      const cell = (row[column.index] ?? "").trim();
      if (cell === "") continue;
      const value = cell.slice(0, MAX_ATTRIBUTE_LENGTH);
      attributes[column.key] = value;
      attributesNorm[column.key] = normaliseValue(value);
    }

    contacts.push({
      email: raw.trim().slice(0, MAX_ATTRIBUTE_LENGTH),
      email_key: key,
      row_number: rowNumber,
      attributes,
      attributes_norm: attributesNorm,
    });
  });

  return { contacts, invalid, duplicates };
}
