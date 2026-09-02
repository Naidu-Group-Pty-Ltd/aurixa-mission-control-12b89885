import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertMirrorPolicy,
  backendIdentityHold,
  backendRefsIn,
  DEFAULT_MIRROR_EXCLUSIONS,
  isShippedPath,
  MissingExclusionPolicyError,
  partitionCascadePaths,
  reconcileSuffixFor,
  reportableHeld,
  summaryOwesReconcile,
  requireExclusions,
  type SyncExclusion,
  CASCADE_MAX_FILE_BYTES,
  oversizeHold,
} from "./syncExclusions.pure";

const BACKEND_IDENTITY = "src/integrations/supabase/env.ts";

describe("the guarantee", () => {
  it("never writes the file that decides which backend a clone talks to", () => {
    const { write, held } = partitionCascadePaths(
      [BACKEND_IDENTITY, "src/pages/Index.tsx"],
      DEFAULT_MIRROR_EXCLUSIONS,
    );
    expect(write).toEqual(["src/pages/Index.tsx"]);
    expect(held.map((h) => h.path)).toContain(BACKEND_IDENTITY);
  });

  it("keeps that file in the default set — the set cannot be trimmed to nothing", () => {
    // The regression this guards is a quiet one: an operator tidying the
    // exclusion list, or a future refactor rebuilding the defaults, drops the
    // one entry whose absence points a customer's dashboard at another
    // tenant's database. Nothing downstream of the commit can tell that apart
    // from a correct sync.
    const patterns = DEFAULT_MIRROR_EXCLUSIONS.map((e) => e.pattern);
    expect(patterns).toContain(BACKEND_IDENTITY);
    expect(patterns).toContain("supabase/config.toml");
    expect(patterns).toContain("supabase/.temp/**");
    for (const e of DEFAULT_MIRROR_EXCLUSIONS) {
      expect(e.pattern.trim()).not.toBe("");
    }
  });
});

describe("fail closed", () => {
  it("throws when the policy read errored", () => {
    expect(() => requireExclusions("c1", null, { message: "connection reset" })).toThrow(
      MissingExclusionPolicyError,
    );
  });

  it("throws when nothing came back at all", () => {
    expect(() => requireExclusions("c1", null)).toThrow(MissingExclusionPolicyError);
    expect(() => requireExclusions("c1", undefined)).toThrow(MissingExclusionPolicyError);
  });

  it("accepts an empty set that was actually read", () => {
    // A module-scoped clone legitimately has no exclusions. The distinction is
    // between "read, and empty" and "not read".
    expect(requireExclusions("c1", [])).toEqual([]);
  });

  it("reports the error it was given, so the failure is diagnosable", () => {
    expect(() => requireExclusions("c1", null, { message: "connection reset" })).toThrow(
      /connection reset/,
    );
  });
});

describe("partitioning", () => {
  const rules: SyncExclusion[] = [
    { pattern: "src/App.tsx", reason: "manual_reconcile", note: "superset" },
    { pattern: "src/**", reason: "protected", note: "everything under src" },
  ];

  it("attributes a doubly-matched path to protected, the stronger reason", () => {
    const { held } = partitionCascadePaths(["src/App.tsx"], rules);
    expect(held).toHaveLength(1);
    expect(held[0].reason).toBe("protected");
  });

  it("reports manual_reconcile paths and stays quiet about protected ones", () => {
    const { held } = partitionCascadePaths(
      [BACKEND_IDENTITY, "src/App.tsx"],
      DEFAULT_MIRROR_EXCLUSIONS,
    );
    const reportable = reportableHeld(held).map((h) => h.path);
    expect(reportable).toEqual(["src/App.tsx"]);
    expect(reportable).not.toContain(BACKEND_IDENTITY);
  });

  it("carries the note through, so a pull request can say why", () => {
    const { held } = partitionCascadePaths(["src/App.tsx"], DEFAULT_MIRROR_EXCLUSIONS);
    expect(held[0].note).toMatch(/RouteExcludedFromBuild/);
  });

  it("withholds a path that is not a safe repo path regardless of the rules", () => {
    const { write, held } = partitionCascadePaths(["../../etc/passwd", "ok.ts"], []);
    expect(write).toEqual(["ok.ts"]);
    expect(held[0].reason).toBe("protected");
  });

  it("writes everything when a clone has no exclusions", () => {
    const { write, held } = partitionCascadePaths(["a.ts", "b/c.ts"], []);
    expect(write).toEqual(["a.ts", "b/c.ts"]);
    expect(held).toEqual([]);
  });
});

describe("glob semantics match the file selector", () => {
  it("** crosses directory separators", () => {
    const { write } = partitionCascadePaths(
      ["supabase/.temp/linked-project.json", "supabase/config.toml", "supabase/functions/x/i.ts"],
      DEFAULT_MIRROR_EXCLUSIONS,
    );
    expect(write).toEqual(["supabase/functions/x/i.ts"]);
  });

  it("* does not cross them", () => {
    const rules: SyncExclusion[] = [{ pattern: "docs/*.md", reason: "protected" }];
    const { write } = partitionCascadePaths(["docs/a.md", "docs/nested/b.md"], rules);
    expect(write).toEqual(["docs/nested/b.md"]);
  });

  it("anchors — a pattern matches the whole path, not a fragment of it", () => {
    const rules: SyncExclusion[] = [{ pattern: "vercel.json", reason: "protected" }];
    const { write } = partitionCascadePaths(["packages/x/vercel.json", "vercel.json"], rules);
    expect(write).toEqual(["packages/x/vercel.json"]);
  });
});

describe("a mirror must have a policy", () => {
  it("refuses to cascade a whole tree with no exclusions", () => {
    expect(() => assertMirrorPolicy("c1", [])).toThrow(MissingExclusionPolicyError);
    expect(() => assertMirrorPolicy("c1", [])).toThrow(
      /would overwrite this clone's backend identity/,
    );
  });

  it("accepts one that has been seeded", () => {
    expect(() => assertMirrorPolicy("c1", DEFAULT_MIRROR_EXCLUSIONS)).not.toThrow();
  });

  it("does not constrain module-scoped clones — the engine only asks for mirrors", () => {
    // An empty set stays valid on the read path; it is the mirror-specific
    // assertion that rejects it.
    expect(requireExclusions("c1", [])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The content rule
// ─────────────────────────────────────────────────────────────────────────────

const PRIME = "dduzbchuswwbefdunfct";
const CLONE = "plisdzywzleljorrphxv";

/** The two shapes as they actually appeared in the file that was reverted. */
const primeEmbed = `
  <script>
    (function () {
      var SUPABASE_URL = 'https://${PRIME}.supabase.co';
      var ANON_KEY = 'eyJhbG.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IiR7UFJJTUV9In0.sig';
    })();
  </script>`;
const cloneEmbed = primeEmbed.replaceAll(PRIME, CLONE);

describe("backendRefsIn", () => {
  it("reads a project out of its URL", () => {
    expect(backendRefsIn(`https://${PRIME}.supabase.co/rest/v1/x`)).toEqual([PRIME]);
  });

  it("reads a project out of an anon key's ref claim", () => {
    expect(backendRefsIn(`{"iss":"supabase","ref":"${CLONE}","role":"anon"}`)).toEqual([CLONE]);
  });

  it("finds both halves of a mismatched pair, because that pair authenticates to nothing", () => {
    expect(backendRefsIn(`url=https://${PRIME}.supabase.co key={"ref":"${CLONE}"}`).sort()).toEqual(
      [CLONE, PRIME].sort(),
    );
  });

  it("does not mistake an ordinary word for a project ref", () => {
    // Twenty lowercase letters is the whole shape, so the boundary matters.
    expect(backendRefsIn("see supabase.co for docs")).toEqual([]);
    expect(backendRefsIn("https://short.supabase.co")).toEqual([]);
  });
});

describe("isShippedPath — the same rule the clone's own isolation spec enforces", () => {
  it("covers everything under public/, which is copied into dist untouched", () => {
    expect(isShippedPath("public/lead-magnet-embed.html")).toBe(true);
    expect(isShippedPath("public/robots.txt")).toBe(true);
  });

  it("covers src/ source but not its tests", () => {
    expect(isShippedPath("src/lib/env.ts")).toBe(true);
    expect(isShippedPath("src/pages/Index.tsx")).toBe(true);
    expect(isShippedPath("src/lib/__tests__/thing.ts")).toBe(false);
    expect(isShippedPath("src/lib/thing.spec.ts")).toBe(false);
    expect(isShippedPath("src/lib/thing.test.tsx")).toBe(false);
  });

  it("leaves docs alone", () => {
    // 185 tracked files in the mirror name the prime, nearly all of them prose
    // and captured integration payloads. A section that is never empty is one
    // nobody reads.
    expect(isShippedPath("docs/BACKEND_ISOLATION.md")).toBe(false);
    expect(isShippedPath("docs/integrations/blueprints/make/x.json")).toBe(false);
  });
});

describe("backendIdentityHold", () => {
  it("holds prime's copy when the clone's has been fixed — the reverted case", () => {
    const hold = backendIdentityHold({
      path: "public/lead-magnet-embed.html",
      primeContent: primeEmbed,
      cloneContent: cloneEmbed,
      ownRef: CLONE,
    });
    expect(hold).not.toBeNull();
    expect(hold!.reason).toBe("manual_reconcile");
    expect(hold!.note).toContain(PRIME);
  });

  it("stays quiet when the clone's copy names the prime too", () => {
    // Nothing is being reverted: this is prime moving and the clone following.
    // Three supabase/functions files in the mirror are in exactly this state,
    // and reporting them on every cascade forever is how a guard becomes noise.
    expect(
      backendIdentityHold({
        path: "src/lib/thing.ts",
        primeContent: `https://${PRIME}.supabase.co`,
        cloneContent: `https://${PRIME}.supabase.co`,
        ownRef: CLONE,
      }),
    ).toBeNull();
  });

  it("holds a NEW upstream file that would introduce a foreign project", () => {
    const hold = backendIdentityHold({
      path: "public/new-embed.html",
      primeContent: primeEmbed,
      cloneContent: null,
      ownRef: CLONE,
    });
    expect(hold).not.toBeNull();
    expect(hold!.note).toContain("Bring it across");
  });

  it("says nothing about a file that names only this clone's own project", () => {
    expect(
      backendIdentityHold({
        path: "src/lib/env.ts",
        primeContent: `https://${CLONE}.supabase.co`,
        cloneContent: null,
        ownRef: CLONE,
      }),
    ).toBeNull();
  });

  it("treats every ref as foreign when the clone has no registered backend", () => {
    // Unknown is not absent. A clone with no backend cannot have "its own
    // project" compared against, so the cascade names the paths instead of
    // writing them blind.
    const hold = backendIdentityHold({
      path: "public/lead-magnet-embed.html",
      primeContent: primeEmbed,
      cloneContent: "<html>no project here</html>",
      ownRef: null,
    });
    expect(hold).not.toBeNull();
  });

  it("ignores docs however loudly they name another project", () => {
    expect(
      backendIdentityHold({
        path: "docs/BACKEND_ISOLATION.md",
        primeContent: primeEmbed,
        cloneContent: "clean",
        ownRef: CLONE,
      }),
    ).toBeNull();
  });
});

describe("the two paths the 26 Aug cascade reverted are now listed as well", () => {
  // Belt and braces: `backendIdentityHold` would catch the embed on content
  // alone, but the spec file it also reverted is a *test* file and so outside
  // the shipped-path rule by design. A list and a property, covering each
  // other's gap.
  it("withholds both, and reports both to a human", () => {
    const paths = [
      "public/lead-magnet-embed.html",
      "src/lib/reportTemplate/__tests__/renderAssetNormalisation.spec.ts",
      "src/pages/Index.tsx",
    ];
    const { write, held } = partitionCascadePaths(paths, DEFAULT_MIRROR_EXCLUSIONS);
    expect(write).toEqual(["src/pages/Index.tsx"]);
    expect(
      reportableHeld(held)
        .map((h) => h.path)
        .sort(),
    ).toEqual([
      "public/lead-magnet-embed.html",
      "src/lib/reportTemplate/__tests__/renderAssetNormalisation.spec.ts",
    ]);
  });
});

describe("the seeding migration is a projection of this constant, not a second copy", () => {
  // A hand-maintained second copy of a safety list is precisely how
  // `public/lead-magnet-embed.html` came to be missing from the live table
  // while sitting in nobody's list at all. There is one authority; this asserts
  // the migration says what it says.
  const MIGRATION = "supabase/migrations/20260826070000_seed_mirror_exclusions.sql";

  const rows = () => {
    const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");
    const values = sql.slice(sql.indexOf("CROSS JOIN (VALUES"), sql.indexOf(") AS d(pattern"));
    // ('pattern', 'reason', 'note') with '' as the escaped quote.
    const rx = /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*\)/g;
    return [...values.matchAll(rx)].map((m) => ({
      pattern: m[1].replaceAll("''", "'"),
      reason: m[2].replaceAll("''", "'"),
      note: m[3].replaceAll("''", "'"),
    }));
  };

  it("carries every default, in order, with the same reason and note", () => {
    expect(rows()).toEqual(
      DEFAULT_MIRROR_EXCLUSIONS.map((e) => ({
        pattern: e.pattern,
        reason: e.reason,
        note: e.note ?? "",
      })),
    );
  });

  it("adds rows and removes none — an operator's own exclusion is not ours to withdraw", () => {
    const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");
    expect(sql).toContain("ON CONFLICT (clone_id, pattern) DO NOTHING");
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it("touches mirrors only — a module-scoped clone has no business with this set", () => {
    expect(readFileSync(join(process.cwd(), MIGRATION), "utf8")).toContain(
      "WHERE c.sync_scope = 'mirror'",
    );
  });
});

/**
 * The writer and the reader of the reconcile marker are in different files and
 * ran twelve hours apart in production, which is exactly how a clone stayed red
 * while its cascade reported `completed · success · 0 merged`.
 */
describe("the reconcile marker round-trips", () => {
  it("says nothing when nothing is owed", () => {
    expect(reconcileSuffixFor(0)).toBe("");
    expect(summaryOwesReconcile("a.ts, b.ts (+3 more)")).toBe(false);
  });

  it("is readable back out of the summary it was written into", () => {
    const suffix = reconcileSuffixFor(2);
    expect(suffix).toContain("2");
    expect(summaryOwesReconcile(`src/App.tsx, src/lib/clientFacing.ts${suffix}`)).toBe(true);
  });

  it("survives the other suffixes it sits beside", () => {
    const summary = `src/App.tsx (+9 more) · 3 pins · 8 withheld${reconcileSuffixFor(1)}`;
    expect(summaryOwesReconcile(summary)).toBe(true);
  });

  it("reads an absent or null summary as owing nothing, never as owing work", () => {
    expect(summaryOwesReconcile(null)).toBe(false);
    expect(summaryOwesReconcile(undefined)).toBe(false);
  });

  it("counts only the manual_reconcile half of what was held", () => {
    const held = [
      {
        path: "src/App.tsx",
        pattern: "src/App.tsx",
        reason: "manual_reconcile" as const,
        note: null,
      },
      { path: "vercel.json", pattern: "vercel.json", reason: "protected" as const, note: null },
    ];
    expect(reportableHeld(held)).toHaveLength(1);
    expect(reconcileSuffixFor(reportableHeld(held).length)).toContain("1");
  });
});

describe("a file over the cascade ceiling is held, and says so", () => {
  it("is reportable, so a person is told rather than the file vanishing", () => {
    /*
      Measured 2 Sep 2026: one 39 MB migration seed among 48 files killed the
      pass on every attempt. Held as `manual_reconcile` it is counted in the
      proposal and listed with its size; held silently it would be a cascade
      that reports success while the clone is missing a file.
    */
    const held = oversizeHold("supabase/migrations/x.sql", 41_010_000, CASCADE_MAX_FILE_BYTES);
    expect(held.reason).toBe("manual_reconcile");
    expect(reportableHeld([held])).toHaveLength(1);
    expect(held.note).toMatch(/39\.1 MB/);
    expect(held.note).toMatch(/8\.0 MB/);
    expect(held.path).toBe("supabase/migrations/x.sql");
  });

  it("the ceiling is the migration corpus's own", () => {
    // A body the migration sync refuses to carry is not one the repository
    // cascade should carry either.
    expect(CASCADE_MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
  });
});
