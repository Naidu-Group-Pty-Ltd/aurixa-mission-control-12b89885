import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceAppearanceSeedSql,
  CLONE_DEFAULT_THEME,
  describeWorkspaceAppearanceSeed,
  readWorkspaceAppearanceSeed,
  type WorkspaceThemeMode,
} from "./workspaceAppearance";

describe("a new workspace's first appearance", () => {
  it("is dark, by the owner's decision of 31 Oct 2026", () => {
    expect(CLONE_DEFAULT_THEME).toBe("dark");
  });

  it("writes the theme default into an empty table and nothing else", () => {
    const sql = buildWorkspaceAppearanceSeedSql();
    expect(sql).toContain("INSERT INTO public.whitelabel_settings (dark_mode_default)");
    expect(sql).toContain("SELECT 'dark'");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM public.whitelabel_settings)");
    // The name stays at its catalogue default (empty since the prime's
    // 20260901001200): a name written here would print as the masthead of the
    // workspace's agreements.
    expect(sql).not.toMatch(/company_name/);
    // A row that exists is read, never written.
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/ON CONFLICT/i);
  });

  it("reads the theme back as the workspace derives it: theme_config first, then the column", () => {
    const sql = buildWorkspaceAppearanceSeedSql();
    expect(
      sql.match(/COALESCE\(theme_config->>'darkModeDefault', dark_mode_default\)/g),
    ).toHaveLength(2);
  });

  it("takes another of the three themes, and refuses anything else", () => {
    expect(buildWorkspaceAppearanceSeedSql("system")).toContain("SELECT 'system'");
    expect(() =>
      buildWorkspaceAppearanceSeedSql("dark'); DROP TABLE x; --" as WorkspaceThemeMode),
    ).toThrow(/Not a workspace theme/);
  });
});

describe("what the clone answered", () => {
  it("is created or kept when it is one row of the expected shape", () => {
    expect(readWorkspaceAppearanceSeed([{ outcome: "created", theme: "dark" }])).toEqual({
      outcome: "created",
      theme: "dark",
    });
    expect(readWorkspaceAppearanceSeed([{ outcome: "kept", theme: "system" }])).toEqual({
      outcome: "kept",
      theme: "system",
    });
  });

  it("is a failure, never a success, when it is anything else", () => {
    for (const answer of [
      [],
      [{ outcome: "created" }, { outcome: "kept" }],
      [{ outcome: "inserted" }],
      null,
      {},
    ]) {
      expect(readWorkspaceAppearanceSeed(answer).outcome).toBe("failed");
    }
  });
});

describe("the line an operator reads", () => {
  it("says a created workspace is dark, and says so only when it read back dark", () => {
    expect(describeWorkspaceAppearanceSeed({ outcome: "created", theme: "dark" })).toBe(
      "The workspace's appearance was created with theme default dark.",
    );
    expect(describeWorkspaceAppearanceSeed({ outcome: "created", theme: "light" })).toMatch(
      /reads back with theme default light where dark was written/,
    );
  });

  it("says a workspace's own settings were left as they are", () => {
    expect(describeWorkspaceAppearanceSeed({ outcome: "kept", theme: "light" })).toMatch(
      /left as they are \(theme default: light\)/,
    );
  });

  it("says a failure, and what the workspace opens in because of it", () => {
    expect(describeWorkspaceAppearanceSeed({ outcome: "failed", error: "boom" })).toMatch(
      /was not set \(boom\)\. It opens in light/,
    );
  });
});

describe("the build runs it", () => {
  const src = readFileSync(new URL("../backend-provisioning.server.ts", import.meta.url), "utf8");
  const pipeline = src.slice(src.indexOf("export async function provisionCloneBackend("));

  it("after the admin seed, past the return a repair takes, so a repair never touches a tenant's settings", () => {
    const repairReturn = pipeline.indexOf("if (input.repair) {");
    const adminSeed = pipeline.indexOf("await seedAdminUser(");
    const appearance = pipeline.indexOf("await seedWorkspaceAppearance(projectRef)");
    expect(repairReturn).toBeGreaterThan(-1);
    expect(adminSeed).toBeGreaterThan(repairReturn);
    expect(appearance).toBeGreaterThan(adminSeed);
    // The repair's own return says it was not attempted.
    expect(pipeline.slice(repairReturn, adminSeed)).toContain("workspaceAppearance: null,");
  });

  it("and keeps what it found in the build's audit row, which the ready write does not overwrite", () => {
    const runner = readFileSync(
      new URL("../../lib/backend-provisioning.functions.ts", import.meta.url),
      "utf8",
    );
    const audit = runner.slice(runner.indexOf('action: "clone_backend.provisioned"'));
    expect(audit.slice(0, audit.indexOf("});"))).toContain(
      "workspace_appearance: result.workspaceAppearance ?? null",
    );
  });
});
