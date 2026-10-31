/**
 * A clone's extensions go in the schema the prime keeps them in.
 *
 * Measured 31 Oct 2026 on the tutorial demo: `btree_gist` in `public` where
 * the prime keeps it in `extensions`, because the create named no schema and
 * `public` is first on the search path. See `extensionPlacement.pure.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  extensionCreateSchema,
  extensionCreateStatement,
  extensionSchemaSkew,
  extensionSchemaSkewWords,
  isSchemaClauseRefusal,
  quoteExtensionIdent,
} from "./extensionPlacement.pure";

/** A refusal as `runSqlOnProject` throws it: the Management API's body, verbatim in form. */
function refusal(status: number, sqlstate: string, message: string): string {
  return `SQL execution failed on clone-ref: ${status} — ${JSON.stringify({
    message: `Failed to run sql query: ERROR:  ${sqlstate}: ${message}\n`,
  })}`;
}

describe("extensionCreateSchema", () => {
  it("names the prime's schema when the clone has one by that name", () => {
    expect(extensionCreateSchema("extensions", new Set(["public", "extensions"]))).toBe(
      "extensions",
    );
    expect(extensionCreateSchema("public", new Set(["public", "extensions"]))).toBe("public");
  });

  it("names none when the clone lacks the prime's schema, so a fixed schema still applies", () => {
    // `supabase_vault` is fixed to `vault` by its control file, and Postgres
    // creates the schema itself. Naming `vault` before it exists refuses the
    // whole create instead.
    expect(extensionCreateSchema("vault", new Set(["public", "extensions"]))).toBeNull();
  });

  it("names none for an extension the prime does not run, or whose schema it did not say", () => {
    // The floor installs `pg_graphql` whether or not the prime runs it.
    expect(extensionCreateSchema(null, new Set(["public"]))).toBeNull();
    expect(extensionCreateSchema(undefined, new Set(["public"]))).toBeNull();
    expect(extensionCreateSchema("", new Set(["", "public"]))).toBeNull();
  });

  it("names none when the clone's schemas could not be read", () => {
    expect(extensionCreateSchema("extensions", new Set())).toBeNull();
  });
});

describe("extensionCreateStatement", () => {
  it("writes the schema into the create when one is named", () => {
    expect(extensionCreateStatement("btree_gist", "extensions")).toBe(
      "create extension if not exists btree_gist with schema extensions;",
    );
  });

  it("writes the create as before when none is", () => {
    expect(extensionCreateStatement("pg_graphql", null)).toBe(
      "create extension if not exists pg_graphql;",
    );
  });

  it("quotes a name or schema that is not a bare identifier", () => {
    expect(extensionCreateStatement("uuid-ossp", "extensions")).toBe(
      'create extension if not exists "uuid-ossp" with schema extensions;',
    );
    expect(extensionCreateStatement("btree_gist", 'Ext"s')).toBe(
      'create extension if not exists btree_gist with schema "Ext""s";',
    );
  });

  it("keeps quoteExtensionIdent's rule", () => {
    expect(quoteExtensionIdent("pgcrypto")).toBe("pgcrypto");
    expect(quoteExtensionIdent("uuid-ossp")).toBe('"uuid-ossp"');
  });
});

describe("isSchemaClauseRefusal", () => {
  it("is true for a control file that fixes another schema", () => {
    expect(
      isSchemaClauseRefusal(
        refusal(400, "0A000", 'extension "pg_cron" must be installed in schema "pg_catalog"'),
      ),
    ).toBe(true);
  });

  it("is true for a schema that is gone, and for one the credential may not create in", () => {
    expect(isSchemaClauseRefusal(refusal(400, "3F000", 'schema "extensions" does not exist'))).toBe(
      true,
    );
    expect(
      isSchemaClauseRefusal(refusal(400, "42501", "permission denied for schema extensions")),
    ).toBe(true);
  });

  it("is false for a refusal that is not about where it goes", () => {
    // Not on the clone at all: written without a schema it fails the same way,
    // and is reported as the failure it is.
    expect(isSchemaClauseRefusal(refusal(400, "58P01", 'extension "nope" is not available'))).toBe(
      false,
    );
  });

  it("is false for a failure that carries no code", () => {
    // A gateway failure says nothing about the schema. Retrying without one
    // would put a relocatable extension in `public` for no reason at all.
    expect(isSchemaClauseRefusal("SQL execution failed on clone-ref: 503 — upstream timeout")).toBe(
      false,
    );
    expect(isSchemaClauseRefusal("fetch failed")).toBe(false);
  });
});

describe("extensionSchemaSkew", () => {
  const prime = new Map([
    ["btree_gist", "extensions"],
    ["pg_cron", "pg_catalog"],
    ["vector", "public"],
    ["uuid-ossp", "extensions"],
  ]);

  it("names an extension both run in different schemas: the demo's reading", () => {
    const demo = new Map([
      ["btree_gist", "public"],
      ["pg_cron", "pg_catalog"],
      ["vector", "public"],
      ["uuid-ossp", "extensions"],
      ["pg_graphql", "graphql"],
    ]);
    expect(extensionSchemaSkew(prime, demo)).toEqual([
      { name: "btree_gist", prime: "extensions", target: "public" },
    ]);
  });

  it("says nothing of an extension one side lacks: that is presence, not placement", () => {
    expect(extensionSchemaSkew(prime, new Map([["vector", "public"]]))).toEqual([]);
    expect(extensionSchemaSkew(new Map(), new Map([["btree_gist", "public"]]))).toEqual([]);
  });

  it("is sorted by name, so two readings of one clone compare equal", () => {
    const skew = extensionSchemaSkew(
      prime,
      new Map([
        ["vector", "extensions"],
        ["btree_gist", "public"],
      ]),
    );
    expect(skew.map((s) => s.name)).toEqual(["btree_gist", "vector"]);
  });

  it("is worded with the clone's schema first and the prime's after", () => {
    expect(
      extensionSchemaSkewWords([{ name: "btree_gist", prime: "extensions", target: "public" }]),
    ).toBe("btree_gist in public (the prime: extensions)");
  });
});
