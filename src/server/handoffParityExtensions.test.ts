/**
 * Parity compares an extension on the extension: present, at a version, in a
 * schema. Its own functions are not counted again as the prime's or the
 * tenant's.
 *
 * Measured 31 Oct 2026 on the tutorial demo: `btree_gist` in `public` where
 * the prime keeps it in `extensions`. The comparison read its 188 functions as
 * clone-only, "the tenant's own", and said nothing about the extension.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { diffExtensions } from "./handoff-parity.server";

type SnapshotLike = Parameters<typeof diffExtensions>[0];

function snap(rows: Array<[name: string, version: string, schema: string | null]>): SnapshotLike {
  return {
    extensions: new Map(rows.map(([name, version]) => [name, version])),
    extensionSchemas: new Map(
      rows.filter(([, , schema]) => schema !== null).map(([name, , schema]) => [name, schema]),
    ),
  } as unknown as SnapshotLike;
}

/** The prime, as measured on 31 Oct 2026. */
const PRIME = snap([
  ["btree_gist", "1.7", "extensions"],
  ["pg_cron", "1.6", "pg_catalog"],
  ["pg_net", "0.14.0", "public"],
  ["vector", "0.8.0", "public"],
  ["uuid-ossp", "1.1", "extensions"],
]);

describe("diffExtensions", () => {
  it("names an extension the clone holds in another schema: the demo's reading", () => {
    const demo = snap([
      ["btree_gist", "1.7", "public"],
      ["pg_cron", "1.6.4", "pg_catalog"],
      ["pg_net", "0.20.4", "public"],
      ["vector", "0.8.2", "public"],
      ["uuid-ossp", "1.1", "extensions"],
      ["pg_graphql", "1.6.2", "graphql"],
    ]);

    const d = diffExtensions(PRIME, demo);

    expect(d.schema_skew).toEqual([{ name: "btree_gist", prime: "extensions", target: "public" }]);
    expect(d.missing_in_target).toEqual([]);
    expect(d.version_skew.map((v) => v.name)).toEqual(["pg_cron", "pg_net", "vector"]);
  });

  it("says nothing of placement for an extension the clone lacks: that is a missing one", () => {
    const d = diffExtensions(PRIME, snap([["pg_cron", "1.6", "pg_catalog"]]));
    expect(d.missing_in_target).toEqual(["btree_gist", "pg_net", "uuid-ossp", "vector"]);
    expect(d.schema_skew).toEqual([]);
  });

  it("does not call an extension misplaced when its schema was not read", () => {
    const d = diffExtensions(PRIME, snap([["btree_gist", "1.7", null]]));
    expect(d.schema_skew).toEqual([]);
  });

  it("matches a clone that holds each one where the prime does", () => {
    expect(diffExtensions(PRIME, PRIME).schema_skew).toEqual([]);
  });
});

describe("the function inventory leaves an extension's own functions out", () => {
  const read = (file: string) => readFileSync(resolve(__dirname, file), "utf8");
  const query = (src: string, name: string) => {
    const at = src.indexOf(`const ${name} = \``);
    expect(at, name).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("`", src.indexOf("`", at) + 1));
  };
  const EXTENSION_MEMBER = /left join pg_depend d on d\.objid = p\.oid[^\n]*d\.deptype = 'e'/;

  it("as the schema build does, which never creates them", () => {
    // The build reads the prime's functions without an extension's own, and
    // `create extension` installs those. Parity counting them is the one place
    // they could be called the prime's or the tenant's.
    const introspection = read("schema-introspection.server.ts");
    expect(introspection).toMatch(EXTENSION_MEMBER);

    const parity = query(read("handoff-parity.server.ts"), "FUNCTIONS_SQL");
    expect(parity).toMatch(EXTENSION_MEMBER);
    expect(parity).toMatch(/and d\.objid is null/);
  });

  it("and reads each extension's schema, which is where the extension is compared", () => {
    const extensions = query(read("handoff-parity.server.ts"), "EXTENSIONS_SQL");
    expect(extensions).toMatch(/join pg_namespace n on n\.oid = e\.extnamespace/);
    expect(extensions).toMatch(/n\.nspname as schema/);
  });
});
