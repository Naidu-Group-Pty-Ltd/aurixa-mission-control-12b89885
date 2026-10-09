import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The engine is one implementation held in two repositories. This suite pins
 * Mission Control's copy to `MARKETING_ENGINE.lock.json` — the same lock the
 * prime carries — and holds every file to the rule that lets it be copied at
 * all: it imports nothing outside its own directory and touches no runtime
 * global.
 */
const ENGINE_DIR = resolve(process.cwd(), "src/lib/marketing/engine");
const BARREL = resolve(process.cwd(), "src/lib/marketing/marketingEngine.ts");

const engineFiles = () =>
  readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith(".pure.ts"))
    .sort();

describe("the marketing engine lock", () => {
  it("matches the bytes recorded in MARKETING_ENGINE.lock.json", () => {
    const lock = JSON.parse(
      readFileSync(join(ENGINE_DIR, "MARKETING_ENGINE.lock.json"), "utf8"),
    ) as {
      engineVersion: string;
      files: Record<string, { sha256: string }>;
    };
    const recorded = Object.fromEntries(
      Object.entries(lock.files).map(([f, entry]) => [f, entry.sha256]),
    );
    const actual = Object.fromEntries(
      engineFiles().map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(join(ENGINE_DIR, f)))
          .digest("hex"),
      ]),
    );
    expect(actual).toEqual(recorded);
    const version = createHash("sha256")
      .update(
        engineFiles()
          .map((f) => `${f}:${actual[f]}`)
          .join("\n"),
      )
      .digest("hex")
      .slice(0, 16);
    expect(version).toBe(lock.engineVersion);
  });

  // The lock travels to every clone the engine is cascaded to, and each clone
  // scans its working tree with its OWN `.gitleaks.toml`; this repository's
  // remediation guard scans with the default rules. A filename carrying `Api`
  // and a 64-hex digest on one line is a credential to generic-api-key, and no
  // exception written here reaches a clone's config.
  it("never puts a digest on the same line as an engine filename", () => {
    const lines = readFileSync(join(ENGINE_DIR, "MARKETING_ENGINE.lock.json"), "utf8").split("\n");
    for (const line of lines) {
      expect(line, "a filename and its digest share a line").not.toMatch(
        /\.pure\.ts"\s*:\s*"[0-9a-f]{64}"/,
      );
    }
  });

  it("keeps every engine file pure: relative engine imports only, no runtime globals", () => {
    for (const file of engineFiles()) {
      const source = readFileSync(join(ENGINE_DIR, file), "utf8");
      const specifiers = [
        ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm),
      ].map((m) => m[1]);
      for (const spec of specifiers) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\/[A-Za-z]+\.pure\.ts$/);
      }
      expect(source, `${file} reads Deno`).not.toMatch(/\bDeno\./);
      expect(source, `${file} reads process`).not.toMatch(/\bprocess\./);
      expect(source, `${file} calls fetch`).not.toMatch(/\bfetch\(/);
    }
  });

  it("is exported whole through the barrel the app and the suite import", () => {
    const barrel = readFileSync(BARREL, "utf8");
    for (const file of engineFiles()) {
      expect(barrel, `${file} missing from marketingEngine.ts`).toContain(`/${file}"`);
    }
  });
});
