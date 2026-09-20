/**
 * Remove SQL comments — which is NOT the same rule as removing TypeScript's.
 *
 * `sourceComments.pure.ts` is the other one, and conflating them is the
 * mistake this module exists to make impossible to commit by accident. SQL
 * has no `//`; it has `--` to end of line, and `/* … *\/` blocks that Postgres
 * allows to NEST. TypeScript has no `--`, and its strings and template
 * literals routinely spell `/*` as data — which is why that module scans and
 * this one does not need to.
 *
 * Four copies of this rule existed in `src/`, three of them byte-identical.
 * They are one now, for the reason the other module gives: two copies of a
 * rule is how two copies come to disagree.
 *
 * ## Why this one is a regex and the TypeScript one is not
 *
 * The failure that matters here runs the opposite way. Over-stripping SQL can
 * only make a check MORE permissive about what it refuses to see — and each
 * caller is written so that means "report it" rather than "allow it". A
 * TypeScript strip that over-reaches deletes the code a contract test was
 * about, and the test then passes on nothing. So this stays deliberately
 * simple, and does not attempt to understand dollar-quoting or nesting.
 */

/**
 * Blocks first, then line comments.
 *
 * The order every caller but one wants: a `--` inside a block comment is part
 * of the comment, and goes with it.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Line comments first, then blocks — deliberately over-strict.
 *
 * This is what `isReadOnlySourceQuery` guards a read-only decision with, and
 * the order is load-bearing rather than incidental. On `/* -- *\/ select 1`
 * the `--` rule eats the block's closer, the block is then left unterminated
 * and nothing is stripped, and the statement does not begin with `select` —
 * so the gate refuses a query that is in fact harmless.
 *
 * That is the correct direction for this one caller and the wrong direction
 * for every other, which is why it is a second named function and not an
 * argument. A reader choosing between them is choosing which way to be wrong,
 * and should have to say so.
 */
export function stripSqlCommentsFailingClosed(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}
