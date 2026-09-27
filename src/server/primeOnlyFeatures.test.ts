import { describe, expect, it } from "vitest";
import { isSafeRepoPath } from "@/lib/module-globs";
import {
  PRIME_ONLY_FEATURES,
  describeWithheldFunctions,
  isPrimeOnlyBucket,
  isPrimeOnlyCronJob,
  isPrimeOnlyFunction,
  isPrimeOnlyPath,
  primeOnlyCronReason,
  primeOnlyFeatureForPath,
  primeOnlyFunctionNames,
  primeOnlyPathsIn,
  withheldPrimeOnlyFunctions,
} from "./primeOnlyFeatures.pure";

const migration = PRIME_ONLY_FEATURES.find((f) => f.key === "ghl-account-migration")!;

// The dispatcher job exactly as migration 20260725000000 writes it: over four lines.
const LIVE_DISPATCHER_COMMAND = `
  SELECT public.cron_invoke_signed_function(
    'migration-dispatcher',
    jsonb_build_object('tick', to_char(now(), 'SS')),
    'pg_cron'
  );`;

describe("the prime-only register is kept honest", () => {
  it("lists the GoHighLevel account migration as measured on the prime", () => {
    expect(migration).toBeDefined();
    expect(migration.functions).toHaveLength(28);
    expect(migration.files).toHaveLength(11);
    expect(new Set(migration.functions).size).toBe(migration.functions.length);
    expect(new Set(migration.files).size).toBe(migration.files.length);
  });

  it("names only safe repository paths, and never a migration", () => {
    for (const f of migration.files) {
      expect(isSafeRepoPath(f)).toBe(true);
      expect(f.startsWith("supabase/migrations/")).toBe(false);
    }
    for (const fn of migration.functions) expect(/^[a-z0-9-]+$/.test(fn)).toBe(true);
  });

  it("keeps its reason short enough for the lateral detail panel", () => {
    expect(migration.reason.length).toBeLessThanOrEqual(100);
  });
});

describe("path matching", () => {
  it("matches every listed file and every file in a listed function's directory", () => {
    for (const f of migration.files) expect(primeOnlyFeatureForPath(f)?.key).toBe(migration.key);
    for (const fn of migration.functions) {
      expect(isPrimeOnlyPath(`supabase/functions/${fn}/index.ts`)).toBe(true);
      expect(isPrimeOnlyPath(`supabase/functions/${fn}/deno.json`)).toBe(true);
    }
  });

  it("leaves the ordinary GoHighLevel integration and every look-alike alone", () => {
    for (const p of [
      "supabase/functions/_shared/ghl-account.ts",
      "supabase/functions/_shared/ghl-rate-limiter.ts",
      "supabase/functions/_shared/ghlConversationMap.pure.ts",
      "supabase/functions/sync-ghl-marketing-assets/index.ts",
      "supabase/functions/ghl-calendar/index.ts",
      "supabase/functions/ghl-webhook-receiver/index.ts",
      "supabase/functions/ghl-conversations-cron/index.ts",
      "supabase/functions/migration-dispatcher-v2/index.ts",
      "supabase/functions/migration-dispatcher",
      "supabase/migrations/20260725000000_fix_migration_dispatcher_cron_auth.sql",
      "src/App.tsx",
      "src/pages/admin/GhlMigrationHelp.tsx",
    ]) {
      expect(isPrimeOnlyPath(p), p).toBe(false);
    }
  });

  it("reports the prime-only paths in a list, sorted and once each", () => {
    expect(
      primeOnlyPathsIn([
        "src/App.tsx",
        "supabase/functions/migration-dispatcher/index.ts",
        "src/pages/admin/GhlMigration.tsx",
        "supabase/functions/migration-dispatcher/index.ts",
      ]),
    ).toEqual([
      "src/pages/admin/GhlMigration.tsx",
      "supabase/functions/migration-dispatcher/index.ts",
    ]);
  });
});

describe("functions and buckets", () => {
  it("names the functions and the bucket exactly", () => {
    expect(primeOnlyFunctionNames().size).toBe(28);
    expect(isPrimeOnlyFunction("migration-dispatcher")).toBe(true);
    expect(isPrimeOnlyFunction("ghl-calendar")).toBe(false);
    expect(isPrimeOnlyBucket("ghl-marketing-dump")).toBe(true);
    expect(isPrimeOnlyBucket("listing-images")).toBe(false);
  });

  it("finds the functions a tree no longer holds", () => {
    const all = migration.functions.map((fn) => `supabase/functions/${fn}/index.ts`);
    expect(withheldPrimeOnlyFunctions(all)).toEqual([]);
    expect(withheldPrimeOnlyFunctions(["src/App.tsx"])).toEqual([...migration.functions].sort());
    expect(
      withheldPrimeOnlyFunctions(all.filter((p) => !p.includes("/migration-dispatcher/"))),
    ).toEqual(["migration-dispatcher"]);
  });
});

describe("cron jobs", () => {
  it("catches the live dispatcher and every name the migrations have used", () => {
    expect(
      isPrimeOnlyCronJob({ jobname: "migration-dispatcher-15s", command: LIVE_DISPATCHER_COMMAND }),
    ).toBe(true);
    expect(isPrimeOnlyCronJob({ jobname: "migration-dispatcher-5s", command: "" })).toBe(true);
    expect(isPrimeOnlyCronJob({ jobname: "migration-dispatcher-30s" })).toBe(true);
  });

  it("catches a differently named job by what it invokes, across lines and by URL", () => {
    expect(isPrimeOnlyCronJob({ jobname: "renamed", command: LIVE_DISPATCHER_COMMAND })).toBe(true);
    expect(
      isPrimeOnlyCronJob({
        jobname: "renamed",
        command:
          "select net.http_post(url := 'https://x.supabase.co/functions/v1/migration-dispatcher')",
      }),
    ).toBe(true);
    expect(primeOnlyCronReason({ jobname: "renamed", command: LIVE_DISPATCHER_COMMAND })).toContain(
      "migration-dispatcher",
    );
  });

  it("leaves the ordinary GoHighLevel jobs alone", () => {
    for (const [jobname, fn] of [
      ["sync-ghl-marketing-assets-6h", "sync-ghl-marketing-assets"],
      ["import-clients-from-ghl-6h", "import-clients-from-ghl"],
      ["sync-ghl-conversations-cron", "sync-ghl-conversations"],
      ["sync-ghl-pipelines-hourly", "sync-ghl-pipelines"],
      ["ghl-marketing-backfill-once", "sync-ghl-marketing-assets"],
    ]) {
      const command = `select public.cron_invoke_signed_function('${fn}', '{}'::jsonb, 'pg_cron');`;
      expect(isPrimeOnlyCronJob({ jobname, command }), jobname).toBe(false);
    }
    expect(primeOnlyCronReason({ jobname: null, command: null })).toBeNull();
  });
});

describe("naming a withheld set in a sentence", () => {
  // It is written into hold notes, a comment in the clone's own ratchet spec
  // and the pull request body, so a regression here is a wrong sentence in
  // three places at once.
  it("names the whole feature by title and count, never as twenty-eight names", () => {
    const text = describeWithheldFunctions(migration.functions);
    expect(text).toBe("the GoHighLevel account migration (all 28 functions)");
    expect(text).not.toContain("migration-dispatcher");
  });

  it("keeps the title's own casing", () => {
    // A proper noun opens it, so lower-casing a title's first letter to fit
    // it mid-sentence would print "goHighLevel".
    expect(describeWithheldFunctions(["migration-dispatcher"])).toContain("GoHighLevel");
  });

  it("names a partial set member by member, because that is the case to look at", () => {
    expect(describeWithheldFunctions(["migration-job-status", "migration-dispatcher"])).toBe(
      "the GoHighLevel account migration (2 of 28 functions: migration-dispatcher, migration-job-status)",
    );
  });

  it("does not depend on the order or repetition of what it is handed", () => {
    const a = describeWithheldFunctions(["migration-job-status", "migration-dispatcher"]);
    const b = describeWithheldFunctions([
      "migration-dispatcher",
      "migration-job-status",
      "migration-dispatcher",
    ]);
    expect(b).toBe(a);
  });

  it("lists a name belonging to no feature as itself, after the features", () => {
    expect(describeWithheldFunctions(["zeta-fn", "migration-dispatcher", "alpha-fn"])).toBe(
      "the GoHighLevel account migration (1 of 28 functions: migration-dispatcher); alpha-fn, zeta-fn",
    );
    expect(describeWithheldFunctions(["alpha-fn"])).toBe("alpha-fn");
  });

  it("says nothing about an empty set", () => {
    expect(describeWithheldFunctions([])).toBe("");
  });
});
