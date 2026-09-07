import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeExposedSchemas } from "./backend-provisioning.server";
import {
  buildSchemaGrantDdl,
  buildDefaultAclDdl,
  defaultAclNoun,
} from "./schema-introspection.server";

/**
 * A clone is a PROJECT, not only a database.
 *
 * Catalog introspection replicates the database exactly and had replicated
 * almost nothing ABOUT the project, so two settings that live on the project
 * decided whether a whole module worked and no check could see either of them.
 * These pin the pair: the exposed schemas, and the grants that make an exposed
 * schema mean anything.
 */

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

describe("mergeExposedSchemas", () => {
  it("adds what the prime exposes and the clone lacks", () => {
    expect(mergeExposedSchemas("public, graphql_public", "public, graphql_public, aml")).toBe(
      "public, graphql_public, aml",
    );
  });

  it("NEVER narrows — a schema only the clone exposes survives", () => {
    expect(mergeExposedSchemas("public, graphql_public, tenant_x", "public, aml")).toBe(
      "public, graphql_public, tenant_x, aml",
    );
  });

  it("is idempotent, so a settled clone reports already_matches", () => {
    const once = mergeExposedSchemas("public, graphql_public", "public, graphql_public, aml");
    expect(mergeExposedSchemas(once, "public, graphql_public, aml")).toBe(once);
  });

  it("never duplicates and tolerates spacing and empties", () => {
    expect(mergeExposedSchemas("", "public,aml")).toBe("public, aml");
    expect(mergeExposedSchemas("public,  aml ,", "aml, public")).toBe("public, aml");
  });
});

describe("grant DDL builders", () => {
  it("grants on the SCHEMA, which is a different act from granting on its tables", () => {
    expect(buildSchemaGrantDdl("aml", "service_role", "USAGE")).toBe(
      'grant usage on schema "aml" to "service_role"',
    );
  });

  it("renders a default privilege against the prime's owning role", () => {
    expect(buildDefaultAclDdl("postgres", "aml", "r", "service_role", "SELECT")).toBe(
      'alter default privileges for role "postgres" in schema "aml" grant select on tables to "service_role"',
    );
    expect(buildDefaultAclDdl("postgres", "aml", "S", "service_role", "USAGE")).toContain(
      "on sequences to",
    );
    expect(buildDefaultAclDdl("postgres", "aml", "f", "service_role", "EXECUTE")).toContain(
      "on functions to",
    );
  });

  it("returns null for an object type it has no noun for, rather than guessing one", () => {
    expect(defaultAclNoun("zzz")).toBeNull();
    expect(buildDefaultAclDdl("postgres", "aml", "zzz", "service_role", "SELECT")).toBeNull();
  });
});

describe("the engine replicates the project's API surface, not only its database", () => {
  const prov = read("backend-provisioning.server.ts");
  const intro = read("schema-introspection.server.ts");

  it("calls replicateApiConfig inside the pipeline, beside the other project setting", () => {
    expect(prov).toContain("apiConfig = await replicateApiConfig(primeRef, projectRef)");
    // Ordered with the storage limit: both are project settings, both non-fatal.
    expect(prov.indexOf("storageConfig = await replicateStorageConfig(")).toBeLessThan(
      prov.indexOf("apiConfig = await replicateApiConfig("),
    );
  });

  it("PATCHes the project's postgrest config — the role setting alone does not reach it", () => {
    const fn = prov.slice(prov.indexOf("export async function replicateApiConfig"));
    expect(fn).toContain("/postgrest`");
    expect(fn).toContain('method: "PATCH"');
    expect(fn).toContain("db_schema");
  });

  it("carries the result to a reader rather than only logging it", () => {
    expect(prov).toContain("apiConfig: ApiConfigResult;");
    expect(prov.match(/^\s*apiConfig,$/gm)?.length).toBe(2);
  });

  it("never reads grants from the role-filtered information_schema view", () => {
    // That view shows only grants whose grantor or grantee is a role the
    // CURRENT user belongs to, so two projects read by two connections answer
    // two different questions. `relacl` is the same set whoever asks.
    // Matched as a FROM clause, so the rule may still be explained in prose.
    expect(intro).not.toContain("from information_schema.role_table_grants");
    expect(intro).toContain("aclexplode(c.relacl)");
  });

  it("digests grants, so a surplus on one schema cannot mask an absence on another", () => {
    const digests = intro.slice(intro.indexOf("const DIGESTS"));
    const body = digests.slice(0, digests.indexOf("\n};"));
    expect(body).toContain("grants:");
    // The SCHEMA acl rides in the same digest: a missing `usage` makes every
    // table grant inside it unreachable, and a digest blind to it reconciles a
    // clone that cannot read one row.
    expect(body).toContain("aclexplode(n.nspacl)");
  });

  it("applies only what the clone lacks, so entering the stage stays cheap", () => {
    const stage = intro.slice(intro.indexOf('enterStage("grants")'));
    const body = stage.slice(0, stage.indexOf("        60,"));
    expect(body).toContain("Q.schemaGrants");
    expect(body).toContain("Q.defaultAcls");
    expect(body).toContain("cloneRef");
    // Schema usage first: every table grant under it is inert until it lands.
    expect(body.indexOf("buildSchemaGrantDdl")).toBeLessThan(body.indexOf("buildGrantDdl"));
    expect(body).toContain("[...schemaDdl, ...tableDdl, ...defaultDdl]");
  });

  it("replicates DEFAULT privileges, so a later cascaded table is not born unreachable", () => {
    expect(intro).toContain("defaultAcls:");
    expect(intro).toContain("pg_default_acl");
  });
});

describe("a value a COLUMN refuses must not read as a write nobody attempted", () => {
  /*
    `verify_domain_txt` was added to the TypeScript and to the edge worker and
    never to the `action` CHECK constraint that stores it, so every enqueue
    answered 23514 and nothing queued. It stayed invisible for four days
    because the caller counted the failure as a "skip" and threw the reason
    away — which is indistinguishable from the provider asking for nothing.
  */
  const jobs = read("hosting/subdomainJobs.server.ts");
  const drain = readFileSync(join(__dirname, "..", "routes", "hooks.deployment-drain.tsx"), "utf8");

  it("carries the database's reason out of the enqueue", () => {
    expect(jobs).toContain("errors: string[]");
    expect(jobs).toContain("errors.push(");
  });

  it("says so on the row an operator reads, rather than 'waiting for DNS'", () => {
    expect(drain).toContain("could NOT be queued");
    // The failure branch must be tested BEFORE the happy count, or a zero
    // enqueue with an error still renders as the reassuring line.
    expect(drain.indexOf("txt.errors.length > 0")).toBeLessThan(
      drain.indexOf("txt.enqueued > 0"),
    );
  });

  it("the migration teaches the column every action the worker dispatches", () => {
    const sql = readFileSync(
      join(__dirname, "..", "..", "supabase", "migrations",
        "20260906180000_edge_job_verify_domain_txt_action.sql"),
      "utf8",
    );
    const worker = readFileSync(join(__dirname, "..", "routes", "hooks.edge-drain.tsx"), "utf8");
    for (const action of worker.matchAll(/job\.action === "([a-z_]+)"/g)) {
      expect(sql).toContain(`'${action[1]}'`);
    }
  });
});
