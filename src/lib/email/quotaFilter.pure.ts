/**
 * A parsed spreadsheet column, as a PostgREST filter.
 *
 * Quota usage is counted straight off the recipient ledger — `how many rows of
 * this campaign are `sent` today whose `attributes_norm->>state` is one of
 * these values` — which means a column NAME chosen by whoever wrote the
 * spreadsheet ends up in a filter expression. So both halves are built here,
 * with their own tests, rather than composed at each call site:
 *
 * **The key is validated, never interpolated on trust.** `columnKey()` emits
 * only `[a-z][a-z0-9_]*`, so anything else reaching this came from somewhere
 * that is not a parsed heading, and the right answer is to refuse rather than
 * to pass it through and find out.
 *
 * **Every value is quoted.** PostgREST splits an `in.(…)` list on commas, and a
 * real column value contains commas — `Sydney, NSW` unquoted becomes two values
 * that match nothing, which reads on screen as a quota with no usage rather
 * than as a broken filter.
 */

/** `attributes_norm` + `state` → `attributes_norm->>state`. */
export function jsonPathColumn(column: string, key: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new Error(`refusing to filter on an unrecognised attribute key: ${key}`);
  }
  return `${column}->>${key}`;
}

/** PostgREST's `in.(…)` list, with values quoted and escaped. */
export function pgInList(values: string[]): string {
  const quoted = values.map(
    (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `(${quoted.join(",")})`;
}
