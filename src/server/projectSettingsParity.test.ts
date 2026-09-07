/**
 * The parity section that can see what the database cannot.
 *
 * The case it exists for: `aml` was present on three clones with every table,
 * policy and function correct, and every call against it answered
 * `Invalid schema: aml`, because the PROJECT's exposed-schema list did not
 * name it. Twenty database sections reported reconciled. Nothing measured the
 * setting that made the module dead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  diffProjectSettings,
  parseSchemaList,
  projectSettingsBlockers,
  projectSettingsSummary,
  type ProjectSettingsSnapshot,
} from "./projectSettingsParity.pure";

const read = <T>(value: T | null): { state: "read"; value: T | null } => ({ state: "read", value });
const gone = (error: string) => ({ state: "unavailable" as const, error });

const PRIME: ProjectSettingsSnapshot = {
  exposedSchemas: read("public, graphql_public, aml"),
  uploadLimitBytes: read(52428800),
};

describe("a schema the prime exposes and the clone does not", () => {
  const clone: ProjectSettingsSnapshot = {
    exposedSchemas: read("public, graphql_public"),
    uploadLimitBytes: read(52428800),
  };

  it("is found, named, and BLOCKING", () => {
    const d = diffProjectSettings(PRIME, clone);
    expect(d.exposed_schemas.missing_in_target).toEqual(["aml"]);
    expect(projectSettingsBlockers(d)).toEqual(["unexposed_schemas:1"]);
  });

  it("names the schema in the summary rather than counting it", () => {
    // "1 unexposed schema" sends nobody anywhere. `aml` says which module.
    const line = projectSettingsSummary(diffProjectSettings(PRIME, clone));
    expect(line).toContain("aml");
    expect(line).toContain("Invalid schema");
  });
});

describe("extra is not a defect", () => {
  it("a schema the clone exposes and the prime does not never blocks", () => {
    const clone: ProjectSettingsSnapshot = {
      exposedSchemas: read("public, graphql_public, aml, tenant_extras"),
      uploadLimitBytes: read(52428800),
    };
    const d = diffProjectSettings(PRIME, clone);
    expect(d.exposed_schemas.extra_in_target).toEqual(["tenant_extras"]);
    expect(d.exposed_schemas.missing_in_target).toEqual([]);
    expect(projectSettingsBlockers(d)).toEqual([]);
  });

  it("an upload limit HIGHER than the prime's is not a shortfall", () => {
    // The same asymmetry `replicateStorageConfig` applies when it refuses to
    // lower a limit: the buckets are what need room.
    const clone: ProjectSettingsSnapshot = { ...PRIME, uploadLimitBytes: read(104857600) };
    expect(diffProjectSettings(PRIME, clone).upload_limit.target_is_lower).toBe(false);
  });

  it("but a LOWER one is reported, and says what it costs", () => {
    const clone: ProjectSettingsSnapshot = { ...PRIME, uploadLimitBytes: read(1048576) };
    const d = diffProjectSettings(PRIME, clone);
    expect(d.upload_limit.target_is_lower).toBe(true);
    expect(projectSettingsSummary(d)).toContain("refused");
    // Real, and still not blocking: it refuses one upload where an unexposed
    // schema refuses an entire module for ever.
    expect(projectSettingsBlockers(d)).toEqual([]);
  });
});

describe("a read that FAILED is not a setting that MATCHES", () => {
  it("two unavailable readings produce no difference AND no all-clear", () => {
    // An unguarded diff of two nulls reports "nothing missing", which is
    // exactly the blindness this section exists to remove.
    const dead: ProjectSettingsSnapshot = {
      exposedSchemas: gone("503 — upstream"),
      uploadLimitBytes: gone("503 — upstream"),
    };
    const d = diffProjectSettings(dead, dead);
    expect(d.exposed_schemas.missing_in_target).toEqual([]);
    expect(d.exposed_schemas.prime).toBeNull();
    expect(d.exposed_schemas.target).toBeNull();
    expect(d.unavailable.length).toBeGreaterThan(0);
    expect(projectSettingsSummary(d)).toContain("not judged");
  });

  it("one side unreadable is still not a comparison", () => {
    const clone: ProjectSettingsSnapshot = {
      exposedSchemas: gone("401 — no token"),
      uploadLimitBytes: read(52428800),
    };
    const d = diffProjectSettings(PRIME, clone);
    expect(d.exposed_schemas.missing_in_target).toEqual([]);
    expect(d.exposed_schemas.unavailable).toContain("401");
    expect(projectSettingsBlockers(d)).toEqual([]);
  });

  it("says so in the summary rather than going quiet", () => {
    const clone: ProjectSettingsSnapshot = {
      exposedSchemas: gone("timeout"),
      uploadLimitBytes: gone("timeout"),
    };
    // A section that reports nothing when it cannot see is indistinguishable
    // from one that looked and found nothing wrong.
    expect(projectSettingsSummary(diffProjectSettings(PRIME, clone))).toContain("not judged");
  });
});

describe("an exact match says nothing at all", () => {
  it("no blockers, no summary line", () => {
    const d = diffProjectSettings(PRIME, { ...PRIME });
    expect(projectSettingsBlockers(d)).toEqual([]);
    expect(projectSettingsSummary(d)).toBe("");
  });
});

describe("the schema list is parsed the way PostgREST writes it", () => {
  it("splits, trims, lowercases and de-duplicates", () => {
    expect(parseSchemaList(" public , graphql_public,AML , public ")).toEqual([
      "public",
      "graphql_public",
      "aml",
    ]);
  });

  it("an absent list is empty, not a crash", () => {
    expect(parseSchemaList(null)).toEqual([]);
    expect(parseSchemaList("")).toEqual([]);
  });
});

describe("the section is wired into the report it belongs to", () => {
  const parity = readFileSync("src/server/handoff-parity.server.ts", "utf8");

  it("computeParity returns it", () => {
    expect(parity).toContain("project_settings_diff: projectSettings");
  });

  it("its blockers join the report's blocking list", () => {
    expect(parity).toContain("blocking.push(...projectSettingsBlockers(projectSettings))");
  });

  it("and a settings read can never fail the whole run", () => {
    // Twenty database sections are still worth having when the Management
    // API is unreachable.
    const server = readFileSync("src/server/projectSettingsParity.server.ts", "utf8");
    expect(server).toContain("catch");
    expect(server).toContain('state: "unavailable"');
  });
});
