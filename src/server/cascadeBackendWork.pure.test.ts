import { describe, expect, it } from "vitest";

import {
  cascadeBackendWork,
  hasBackendWork,
  NO_BACKEND_WORK,
} from "@/server/cascadeBackendWork.pure";

describe("what a cascade owes the backend", () => {
  it("names the functions it touched and nothing else", () => {
    const work = cascadeBackendWork([
      "src/pages/Dashboard.tsx",
      "supabase/functions/aml-cases/index.ts",
      "supabase/functions/aml-cases/helpers.ts",
      "supabase/functions/send-invite/index.ts",
      "README.md",
    ]);
    expect(work.staleFunctions).toEqual(["aml-cases", "send-invite"]);
    expect(work.migrationsOwed).toBe(false);
  });

  it("owes nothing for a cascade that touched no backend path", () => {
    const work = cascadeBackendWork(["src/index.css", "package.json", "docs/aml/README.md"]);
    expect(work).toEqual(NO_BACKEND_WORK);
    expect(hasBackendWork(work)).toBe(false);
  });

  it("widens to every function when a shared file changed", () => {
    /*
      The rule this pins is the one that would be silently wrong the other way.
      `_shared/**` maps to no slug, so a naive reading deploys NOTHING for the
      cascade that changed the most — `groupFunctionPaths` is explicit that
      these files ship inside every bundle.
    */
    const work = cascadeBackendWork([
      "supabase/functions/_shared/logApiUsage.ts",
      "supabase/functions/aml-cases/index.ts",
    ]);
    expect(work.staleFunctions).toBeNull();
    expect(work.reasons.join(" ")).toContain("every bundle");
  });

  it("widens for the root import map and deno config too", () => {
    for (const root of ["import_map.json", "deno.json", "deno.jsonc"]) {
      const work = cascadeBackendWork([`supabase/functions/${root}`]);
      expect(work.staleFunctions).toBeNull();
    }
  });

  it("widens for config.toml, which declares every function's verify_jwt", () => {
    // A config-only edit that deploys nothing is a declaration and a gateway
    // that disagree — the failure mode this repository has already paid for.
    const work = cascadeBackendWork(["supabase/config.toml"]);
    expect(work.staleFunctions).toBeNull();
    expect(work.reasons.join(" ")).toContain("verify_jwt");
  });

  it("counts migrations, and only the SQL", () => {
    const work = cascadeBackendWork([
      "supabase/migrations/20260101000000_add_column.sql",
      "supabase/migrations/20260102000000_backfill.sql",
      "supabase/migrations/README.md",
    ]);
    expect(work.migrationsOwed).toBe(true);
    expect(work.reasons.join(" ")).toContain("2 migration files");
    expect(work.staleFunctions).toEqual([]);
  });

  it("ignores the files a bundle never carries", () => {
    const work = cascadeBackendWork([
      "supabase/functions/aml-cases/.env",
      "supabase/functions/aml-cases/.DS_Store",
      "supabase/functions/.gitignore",
    ]);
    expect(hasBackendWork(work)).toBe(false);
  });

  it("says each reason once, however many files carried it", () => {
    const work = cascadeBackendWork(
      Array.from({ length: 12 }, (_, i) => `supabase/functions/_shared/mod${i}.ts`),
    );
    expect(work.reasons).toHaveLength(1);
  });

  it("does not turn a deleted function into work", () => {
    /*
      Deploying cannot remove a function. Treating an absent path as a removal
      would make a cascade delete a tenant's endpoint as a side effect of an
      upstream tidy-up — destructive in a way redeploying never is.
      Deletions arrive here as paths like any other write, and the ONLY thing
      that happens is a redeploy of the slug, which is a no-op for a bundle
      whose files are gone from the prime.
    */
    const work = cascadeBackendWork(["supabase/functions/retired-thing/index.ts"]);
    expect(work.staleFunctions).toEqual(["retired-thing"]);
    expect(work.migrationsOwed).toBe(false);
  });

  it("is stable in order, so two identical cascades read identically", () => {
    const a = cascadeBackendWork(["supabase/functions/b/i.ts", "supabase/functions/a/i.ts"]);
    const b = cascadeBackendWork(["supabase/functions/a/i.ts", "supabase/functions/b/i.ts"]);
    expect(a.staleFunctions).toEqual(b.staleFunctions);
    expect(a.staleFunctions).toEqual(["a", "b"]);
  });

  it("counts a function and a migration in the same cascade as both", () => {
    const work = cascadeBackendWork([
      "supabase/migrations/20260101000000_x.sql",
      "supabase/functions/aml-cases/index.ts",
    ]);
    expect(work.migrationsOwed).toBe(true);
    expect(work.staleFunctions).toEqual(["aml-cases"]);
    expect(hasBackendWork(work)).toBe(true);
  });
});

describe("what the prime keeps for itself", () => {
  /*
    The paths arrive from the PRIME's history (`workForCascade` compares two
    prime revisions), so the prime's own feature's edits arrive here too. None
    of it is anything a clone is given.
  */
  it("owes a clone nothing for the prime's own functions", () => {
    const work = cascadeBackendWork([
      "supabase/functions/migration-dispatcher/index.ts",
      "supabase/functions/ghl-migrate-contacts-worker/index.ts",
    ]);
    expect(work).toEqual(NO_BACKEND_WORK);
    expect(hasBackendWork(work)).toBe(false);
  });

  it("does not widen to every function for the prime's own shared files", () => {
    // A `_shared/` edit widens to every bundle — but these three ship only in
    // the prime's own functions, and widening on them would redeploy the
    // whole fleet for code no clone carries.
    const work = cascadeBackendWork([
      "supabase/functions/_shared/migration-jobs.ts",
      "supabase/functions/_shared/ghl-worker-fetch.ts",
      "supabase/functions/_shared/ghl-asset-harvester.ts",
    ]);
    expect(work).toEqual(NO_BACKEND_WORK);
  });

  it("still owes what else the same cascade changed", () => {
    const work = cascadeBackendWork([
      "supabase/functions/migration-orchestrator/index.ts",
      "supabase/functions/_shared/migration-jobs.ts",
      "supabase/functions/aml-cases/index.ts",
      "supabase/migrations/20261230000000_x.sql",
    ]);
    expect(work.staleFunctions).toEqual(["aml-cases"]);
    expect(work.migrationsOwed).toBe(true);
  });

  it("still widens for a shared file the clones do carry", () => {
    const work = cascadeBackendWork([
      "supabase/functions/_shared/migration-jobs.ts",
      "supabase/functions/_shared/logApiUsage.ts",
    ]);
    expect(work.staleFunctions).toBeNull();
  });
});
