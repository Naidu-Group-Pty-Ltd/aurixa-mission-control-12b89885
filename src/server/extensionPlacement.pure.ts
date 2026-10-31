import { readSqlFailure } from "./primeMigrationDiagnosis.pure";

/**
 * Where a clone's extensions are installed: in the schema the prime keeps each
 * one in.
 *
 * `enforceRequiredExtensions` creates every extension the prime runs and the
 * clone lacks, before the schema build. It wrote `create extension if not
 * exists <name>;` and nothing more, which puts a RELOCATABLE extension in the
 * first schema on the search path: `public`. Measured 31 Oct 2026 on the
 * tutorial demo, the first clone built since `btree_gist` reached the prime:
 * the prime keeps `btree_gist` 1.7 in `extensions`, the demo had it in
 * `public`, and its 188 functions sat in the clone's API schema. Parity read
 * them as 188 functions the prime does not have and called them the tenant's
 * own, and the security advisor flagged the extension. The four clones built
 * before it got `btree_gist` from the prime's own migration, which says `with
 * schema extensions`, and match.
 *
 * So the create names the prime's schema wherever the clone has a schema of
 * that name. Where it does not, the create is written as before: an extension
 * whose control file fixes its schema (`supabase_vault` in `vault`) is put
 * there by Postgres, which creates the schema itself, while naming a schema
 * that does not exist yet refuses the create.
 */
export type ProjectExtension = { readonly name: string; readonly schema: string | null };

/**
 * Quote an identifier for `create extension`. Most are bare identifiers, but
 * `uuid-ossp` contains a hyphen and is a syntax error unquoted — which is the
 * second reason a clone could end up without an extension the prime has.
 */
export function quoteExtensionIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * The schema to name when creating an extension on a clone: the prime's, if
 * the clone has a schema of that name. Null writes the create without one.
 */
export function extensionCreateSchema(
  primeSchema: string | null | undefined,
  cloneSchemas: ReadonlySet<string>,
): string | null {
  return primeSchema && cloneSchemas.has(primeSchema) ? primeSchema : null;
}

/** The statement that creates one extension, in `schema` when one is named. */
export function extensionCreateStatement(name: string, schema: string | null): string {
  const ext = quoteExtensionIdent(name);
  return schema
    ? `create extension if not exists ${ext} with schema ${quoteExtensionIdent(schema)};`
    : `create extension if not exists ${ext};`;
}

/**
 * The refusals that may be the named schema's doing, so a create written
 * without it is the next thing to try:
 *
 * - `0A000`: the clone's control file fixes another schema ("extension … must
 *   be installed in schema …").
 * - `3F000`: the schema has gone since the clone was read.
 * - `42501`: the credential may not create in it.
 *
 * If one of these was not the schema's doing, the create without it fails the
 * same way and is reported as failed, so trying costs one statement. Anything
 * else (a transport failure, an extension the clone does not have, a code
 * this does not know) is reported as it is, not retried: writing the create
 * without a schema after a failure that had nothing to do with the schema
 * would put a relocatable extension in `public`, the fault this module ends.
 * A clone must have the extension first, so a refusal does not leave it
 * without one, and the placement is reported where it differs.
 */
const SCHEMA_CLAUSE_REFUSALS: ReadonlySet<string> = new Set(["0A000", "3F000", "42501"]);

/** Whether a failed create that named a schema may succeed written without it. */
export function isSchemaClauseRefusal(error: string): boolean {
  const { sqlstate } = readSqlFailure(error);
  return sqlstate !== null && SCHEMA_CLAUSE_REFUSALS.has(sqlstate);
}

export type ExtensionSchemaSkew = { name: string; prime: string; target: string };

/**
 * The extensions both projects run in different schemas, by name.
 *
 * Read by the extension step for what it found and created, and by parity for
 * every extension, so the two cannot come to disagree about what "not where
 * the prime keeps it" means. An extension whose schema either side could not
 * read is not in either map, and is not called misplaced.
 */
export function extensionSchemaSkew(
  prime: ReadonlyMap<string, string>,
  target: ReadonlyMap<string, string>,
): ExtensionSchemaSkew[] {
  const skew: ExtensionSchemaSkew[] = [];
  for (const [name, schema] of prime) {
    const t = target.get(name);
    if (t !== undefined && t !== schema) skew.push({ name, prime: schema, target: t });
  }
  return skew.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One clause per misplaced extension: "btree_gist in public (the prime: extensions)". */
export function extensionSchemaSkewWords(skew: readonly ExtensionSchemaSkew[]): string {
  return skew.map((s) => `${s.name} in ${s.target} (the prime: ${s.prime})`).join(", ");
}
