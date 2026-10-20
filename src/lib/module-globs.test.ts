import { describe, expect, it } from "vitest";
import { globToRegex, globsMatcher, validateModuleGlobs } from "./module-globs";

/** The question `globsMatcher` answers, asked the way every caller asked it before. */
const anyOf = (globs: readonly string[]) => (path: string) =>
  globs.map(globToRegex).some((rx) => rx.test(path));

describe("globsMatcher — one expression for many globs", () => {
  const GLOBS = [
    "supabase/functions/_shared/**",
    "supabase/functions/admin-user-management/**",
    "src/pages/AcceptInvite.tsx",
    "src/lib/*.ts",
    "src/components/?ard/**",
    "docs/(draft)/notes+v2.md",
    "public/brand/aurixa-emblem-[240].png",
    "scripts/{a,b}.mjs",
    "src/lib/reportTemplate/**/__tests__/*.spec.ts",
  ];
  const PATHS = [
    "supabase/functions/_shared/aml/regulatedActs.pure.ts",
    "supabase/functions/_shared",
    "supabase/functions/_sharedX/a.ts",
    "supabase/functions/admin-user-management/index.ts",
    "src/pages/AcceptInvite.tsx",
    "src/pages/AcceptInvite.tsx.bak",
    "xsrc/pages/AcceptInvite.tsx",
    "src/lib/secureInvoke.ts",
    "src/lib/agent/secureInvoke.ts",
    "src/components/card/Card.tsx",
    "src/components/board/Card.tsx",
    "docs/(draft)/notes+v2.md",
    "docs/draft/notesv2.md",
    "public/brand/aurixa-emblem-[240].png",
    "public/brand/aurixa-emblem-2.png",
    "scripts/{a,b}.mjs",
    "scripts/a.mjs",
    "src/lib/reportTemplate/__tests__/x.spec.ts",
    "src/lib/reportTemplate/a/b/__tests__/x.spec.ts",
    "src/lib/reportTemplate/a/__tests__/deep/x.spec.ts",
  ];

  it("answers every path exactly as asking each glob in turn does", () => {
    const one = globsMatcher(GLOBS);
    const each = anyOf(GLOBS);
    for (const path of PATHS) expect(one(path), path).toBe(each(path));
    // The fixture exercises both answers, or it proves nothing.
    expect(PATHS.filter(one).length).toBeGreaterThan(5);
    expect(PATHS.filter((p) => !one(p)).length).toBeGreaterThan(5);
  });

  it("matches a path only whole, since every alternative is anchored at both ends", () => {
    const one = globsMatcher(["src/lib/*.ts", "docs/**"]);
    expect(one("src/lib/a.ts")).toBe(true);
    expect(one("src/lib/a.tsx")).toBe(false);
    expect(one("vendor/src/lib/a.ts")).toBe(false);
    expect(one("docs/x/y.md")).toBe(true);
    expect(one("xdocs/y.md")).toBe(false);
  });

  it("selects nothing for no globs, as `[].some` does", () => {
    expect(globsMatcher([])("src/anything.ts")).toBe(false);
  });

  it("agrees across a whole module catalogue's worth of globs", () => {
    // The shape that made one test per glob expensive: hundreds of function
    // directories, a shared tree named by most of them, and a few literals.
    const globs = validateModuleGlobs([
      ...Array.from({ length: 400 }, (_, i) => `supabase/functions/fn-${i}/**`),
      ...Array.from({ length: 120 }, () => "supabase/functions/_shared/**"),
      ...Array.from({ length: 200 }, (_, i) => `src/pages/Page${i}.tsx`),
    ]).valid;
    const one = globsMatcher(globs);
    const each = anyOf(globs);
    const paths = [
      ...Array.from({ length: 500 }, (_, i) => `supabase/functions/fn-${i}/index.ts`),
      ...Array.from({ length: 250 }, (_, i) => `src/pages/Page${i}.tsx`),
      "supabase/functions/_shared/cors.ts",
      "supabase/functions/fn-1x/index.ts",
    ];
    for (const path of paths) expect(one(path), path).toBe(each(path));
  });
});
