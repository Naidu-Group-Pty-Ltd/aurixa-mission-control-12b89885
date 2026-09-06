/**
 * The SQL the reference-data copy runs, as pure string-building.
 *
 * Separated from the worker so the statements can be asserted character by
 * character in a test. Everything that decides what leaves the prime and what
 * lands on a tenant is here; the worker only sequences it.
 *
 * ## Why rows travel as JSON
 *
 * The obvious shape — read rows, render each value as a SQL literal, build a
 * multi-row INSERT — needs a correct literal renderer for every Postgres type
 * the corpus uses: jsonb, arrays, enums, timestamptz, numeric, bytea. It gets
 * that wrong quietly. A number that round-trips through a JavaScript double
 * loses precision, a `jsonb` re-serialised by hand changes key order, and each
 * one of those is a value written into a tenant's table that does not match the
 * prime's.
 *
 * So a page of rows crosses as ONE `jsonb` literal and Postgres does the
 * casting, via `jsonb_populate_recordset(null::public.<table>, $json)`. The
 * record type is the table itself, so every column is coerced by the same
 * engine that stored it. There is exactly one string to escape instead of one
 * per value, which is also the entire injection surface.
 *
 * Nulling an identity column is then the absence of a key: the base record is
 * `null::public.<table>`, so a key `jsonb_populate_recordset` does not find
 * stays NULL. The copy drops those keys server-side, in the SELECT on the
 * prime, so an identity value never enters Mission Control's memory at all —
 * not merely never reaches the clone.
 */

import type { ReferenceTable } from "./referenceTables.pure";

/**
 * Schema-qualify the table for SQL. The allow-list's `schema` field is a
 * closed union and the table names are our own, so this composes identifiers
 * from reviewed constants — never from a request.
 */
function qualified(entry: ReferenceTable): string {
  return `${entry.schema ?? "public"}.${quoteIdent(entry.table)}`;
}

/** Escape a string for a single-quoted SQL literal. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote an identifier. Table and column names come from our own allow-list and
 *  from `information_schema`, never from a request — but quoting them keeps a
 *  column called `order` or `user` from ending the statement. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Read one page from the prime.
 *
 * `to_jsonb(t) - '{nulled…}'::text[]` removes the identity keys **on the
 * prime**, which is the difference between "the clone never receives it" and
 * "it was never read". Only the second is true here.
 *
 * Paging is keyset, not OFFSET: `where pageKey > $cursor order by pageKey`.
 * OFFSET on a table being written to skips and repeats rows across pages, and
 * this copy is resumed across ticks by definition.
 */
export function buildPageQuery(
  entry: ReferenceTable,
  nulled: readonly string[],
  cursor: string | null,
  limit: number,
): string {
  const t = qualified(entry);
  const key = quoteIdent(entry.pageKey);
  const strip =
    nulled.length > 0
      ? ` - ARRAY[${nulled.map((c) => sqlLiteral(c)).join(", ")}]::text[]`
      : "";

  const conditions: string[] = [];
  if (entry.where) conditions.push(`(${entry.where})`);
  if (cursor !== null) conditions.push(`${key}::text > ${sqlLiteral(cursor)}`);
  const whereSql = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  return (
    `select ${key}::text as __cursor, to_jsonb(t)${strip} as __row ` +
    `from ${t} t ${whereSql} order by ${key}::text asc limit ${limit};`
  );
}

/**
 * Write one page to the clone.
 *
 * `on conflict do nothing` rather than `do update`: this copy must be safe to
 * re-run and must never overwrite. A clone is a live tenant that may have
 * edited a catalogue row, and a nightly sweep silently reverting their edit is
 * a worse failure than a row that is one version behind. Seeding is not
 * replication.
 */
export function buildInsertStatement(entry: ReferenceTable, rowsJson: string): string {
  const t = qualified(entry);
  const conflict = entry.conflictKey.map(quoteIdent).join(", ");
  return (
    `insert into ${t} ` +
    `select * from jsonb_populate_recordset(null::${t}, ${sqlLiteral(rowsJson)}::jsonb) ` +
    `on conflict (${conflict}) do nothing;`
  );
}

/** Count what the prime holds, so a run can report progress against a total. */
export function buildCountQuery(entry: ReferenceTable): string {
  const t = qualified(entry);
  const whereSql = entry.where ? `where ${entry.where}` : "";
  return `select count(*)::int as n from ${t} t ${whereSql};`;
}

/** Read a table's live column list from the prime, for {@link planColumns}. */
export function buildColumnsQuery(entry: ReferenceTable): string {
  return (
    `select column_name from information_schema.columns ` +
    `where table_schema = ${sqlLiteral(entry.schema ?? "public")} ` +
    `and table_name = ${sqlLiteral(entry.table)} ` +
    `order by ordinal_position;`
  );
}

/**
 * Does the clone even have this table?
 *
 * A clone provisioned before a reference table existed does not have it, and
 * the INSERT would fail with 42P01 mid-run. Asking first turns that into a
 * skip with a reason — the clone is behind on migrations, which is a different
 * problem with a different fix.
 */
export function buildTableExistsQuery(entry: ReferenceTable): string {
  return (
    `select to_regclass(${sqlLiteral(`${entry.schema ?? "public"}.${entry.table}`)}) ` +
    `is not null as present;`
  );
}
