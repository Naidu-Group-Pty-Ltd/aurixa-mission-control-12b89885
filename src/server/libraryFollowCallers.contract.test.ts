/**
 * The library follow approves entries with no person (D19, the owner's
 * decision of 29 Oct 2026), held at the source.
 *
 * `writeLibraryEntries` asks nobody's role: an admin's publication reaches it
 * after `requireLibraryAdmin`, and the follow reaches it from a hook that
 * answers only the cron secret. So the rule holds only while those are its
 * only two callers, and only the follow writes an entry with no publisher.
 * Both are derived from the source, comments stripped, so a third caller, or
 * a second null publisher, fails here the day it is added.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./sourceComments.pure";

/** Every production module under `src/`, as code (comments removed, strings kept). */
function productionSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "testing") walk(p);
      } else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith("types.ts")) {
        out.set(p, stripComments(readFileSync(p, "utf8")));
      }
    }
  };
  walk("src");
  return out;
}

const SOURCES = productionSources();
const PUBLISHER = "src/server/libraryApproval.server.ts";
const FOLLOW = "src/server/library-follow.server.ts";
const HOOK = "src/routes/hooks.module-library-follow.tsx";
const MIGRATION = "supabase/migrations/20261029140000_module_library_follows_the_prime.sql";

const filesCalling = (call: RegExp) =>
  [...SOURCES].filter(([, src]) => call.test(src)).map(([file]) => file);

function source(file: string): string {
  const src = SOURCES.get(file);
  if (src === undefined) throw new Error(`${file} is not in the scanned sources`);
  return src;
}

/** The body of `export async function <name>(` up to the next top-level export. */
function exportedFunction(file: string, name: string): string {
  const src = source(file);
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) throw new Error(`${name} is not exported from ${file}`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("who writes an entry no person approved", () => {
  it("the shared writer is called by the admin's publication and the follow, and by nothing else", () => {
    expect(filesCalling(/\bwriteLibraryEntries\(/).sort()).toEqual([FOLLOW, PUBLISHER]);
    const publication = exportedFunction(PUBLISHER, "publishModulesToLibrary");
    expect(publication).toContain("await requireLibraryAdmin(");
    expect(publication.indexOf("await requireLibraryAdmin(")).toBeLessThan(
      publication.indexOf("writeLibraryEntries("),
    );
    expect(publication).toContain("publisherId: request.userId,");
  });

  it("only the follow publishes with no publisher", () => {
    expect(filesCalling(/publisherId:\s*null/)).toEqual([FOLLOW]);
  });

  it("the follow is started by the cron hook alone, once the cron secret is checked", () => {
    expect(filesCalling(/\bfollowPrimeHead\(/).sort()).toEqual([FOLLOW, HOOK].sort());
    const hook = source(HOOK);
    expect(hook.indexOf("verifyCronAuth(request)")).toBeGreaterThan(-1);
    expect(hook.indexOf("if (!auth.ok) return auth.response;")).toBeLessThan(
      hook.indexOf("followPrimeHead("),
    );
  });

  it("the hook is scheduled where it is served, with the patience a detection needs", () => {
    const sql = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
    expect(source(HOOK)).toContain('createFileRoute("/hooks/module-library-follow")');
    expect(sql).toContain("v_base || '/hooks/module-library-follow'");
    expect(sql).toMatch(/'module-library-follow-15min',\s*'4,19,34,49 \* \* \* \*'/);
    expect(sql).toContain("timeout_milliseconds := 600000");
  });
});

describe("the follow changes no clone", () => {
  it("never reconciles, and never writes a clone, an install or a pin", () => {
    // A reconcile resolves a clone's plan from its metering tenant, and every
    // clone metered on `free` while Mission Control recorded its sold plan
    // (29 Oct 2026): reconciling from the follow would rewrite those records.
    const follow = source(FOLLOW);
    expect(follow).not.toMatch(/reconcileCloneEntitlements|entitlement-modules\.server/);
    expect(follow).not.toMatch(/\.from\("(clones|clone_modules|clone_library_pins)"\)/);
  });
});

describe("a new clone says which commit its catalogue was at", () => {
  it("both provisioning paths reconcile with the catalogue's settled run", () => {
    for (const file of [
      "src/server/clone-provisioning.server.ts",
      "src/server/agreement-provisioning.server.ts",
    ]) {
      expect(source(file), file).toMatch(/catalogue: await catalogueSettledAt\(supabase(Admin)?\)/);
    }
    expect(source("src/server/entitlement-modules.server.ts")).toContain(
      "catalogue_commit_sha: options.catalogue?.commitSha ?? null",
    );
  });
});
