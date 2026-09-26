import { describe, expect, it } from "vitest";
import { MAX_OUTSIDE_ROOT_PROBES } from "./outsideRootSubjects.pure";
import {
  describeSpecsBroughtAcross,
  isReExportShim,
  leftBehindSpecHold,
  MAX_LEFT_BEHIND_PROBES,
  MAX_SHIM_HOPS,
  specSubjects,
  specsBothSidesHoldDifferently,
  specsLeftBehind,
  withLeftBehindNote,
} from "./specsLeftBehind.pure";

/** A prime tree of the given paths. The shas are irrelevant to resolution. */
const tree = (...paths: string[]) => new Map(paths.map((p) => [p, `sha:${p}`]));

describe("isReExportShim — a module with no behaviour of its own", () => {
  it("is every spelling of a re-export, alone", () => {
    expect(isReExportShim(`export * from "../../../supabase/functions/_shared/a.pure.ts";\n`)).toBe(
      true,
    );
    expect(isReExportShim(`export * as ns from './n';`)).toBe(true);
    expect(isReExportShim(`export type { T } from "./t";\nexport { a, b as c } from "./a";`)).toBe(
      true,
    );
    // The brace list is allowed to span lines, which is how Prettier writes a long one.
    expect(isReExportShim(`export {\n  a,\n  b,\n} from "@/lib/b";\n`)).toBe(true);
  });

  it("reads past the header a shim is always written with", () => {
    const shim =
      `/**\n * One implementation lives in _shared; this file only re-exports it.\n */\n` +
      `// Deno and Vite resolve the same module.\n` +
      `export * from "../../../supabase/functions/_shared/geocode/osmGeocode.pure.ts";\n`;
    expect(isReExportShim(shim)).toBe(true);
  });

  it("is not a module that adds anything, however little", () => {
    expect(isReExportShim(`export * from "./x";\nexport const y = 1;\n`)).toBe(false);
    expect(isReExportShim(`import x from "./x";\nexport default x;\n`)).toBe(false);
    expect(isReExportShim(`export * from "./x";\nconsole.log("side effect");\n`)).toBe(false);
  });

  it("is not a module with nothing in it", () => {
    expect(isReExportShim("")).toBe(false);
    expect(isReExportShim("// just a comment\n")).toBe(false);
  });
});

describe("specSubjects — what a spec asserts about, from its own text", () => {
  const SPEC = "src/lib/geocode/__tests__/osmGeocode.spec.ts";
  const SHIM = "src/lib/geocode/osmGeocode.pure.ts";
  const EDGE = "supabase/functions/_shared/geocode/osmGeocode.pure.ts";

  it("reads a path it names, the forward half's own rule", () => {
    const prime = tree("docs/integrations/GEOCODING_WITHOUT_GOOGLE.md");
    const got = specSubjects({
      specPath: "src/lib/geocode/__tests__/geocoderWiring.spec.ts",
      specText: `readFileSync("docs/integrations/GEOCODING_WITHOUT_GOOGLE.md", "utf8")`,
      prime,
      readText: () => undefined,
    });
    expect(got).toContain("docs/integrations/GEOCODING_WITHOUT_GOOGLE.md");
  });

  it("reads a file it names outside the content roots, so both halves agree on what a subject is", () => {
    const got = specSubjects({
      specPath: "src/lib/reportDesign/__tests__/reportTypography.spec.ts",
      specText: `readFileSync(resolve(REPO, '.claude/skills/npc-services-design/reports/REPORT_RULES.md'))`,
      prime: tree(),
      readText: () => undefined,
    });
    expect(got).toContain(".claude/skills/npc-services-design/reports/REPORT_RULES.md");
  });

  it("reads a module it imports, in both specifier forms", () => {
    const prime = tree(SPEC, SHIM, "src/lib/geocode/geocodeResult.pure.ts");
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { a } from "@/lib/geocode/osmGeocode.pure";\nimport { b } from "../geocodeResult.pure";\n`,
      prime,
      readText: () => "export const z = 1;",
    });
    expect(got).toEqual(expect.arrayContaining([SHIM, "src/lib/geocode/geocodeResult.pure.ts"]));
  });

  it("looks through a re-export shim to the module that does the work", () => {
    // `osmGeocode.spec.ts` on the CRM clone: the shim is byte-identical on
    // both sides and only the edge module behind it crossed.
    const prime = tree(SPEC, SHIM, EDGE);
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { parseProviderOrder } from "../osmGeocode.pure";\n`,
      prime,
      readText: (path) =>
        path === SHIM
          ? `export * from "../../../supabase/functions/_shared/geocode/osmGeocode.pure.ts";`
          : undefined,
    });
    expect(got).toEqual(expect.arrayContaining([EDGE, SHIM]));
  });

  it("follows a chain of shims, and only shims", () => {
    const prime = tree(SPEC, "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts");
    const texts: Record<string, string> = {
      "src/a.ts": `export * from "./b";`,
      "src/b.ts": `export { thing } from "./c";`,
      // `c` does work of its own, so what it imports is ITS subject, not the spec's.
      "src/c.ts": `import { d } from "./d";\nexport const thing = d + 1;`,
      "src/d.ts": `export const d = 1;`,
    };
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { thing } from "@/a";`,
      prime,
      readText: (path) => texts[path],
    });
    expect(got).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(got).not.toContain("src/d.ts");
  });

  it("does not look through a module that does work, however few lines it has", () => {
    const prime = tree(SPEC, "src/wrapper.ts", "src/inner.ts");
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { w } from "@/wrapper";`,
      prime,
      readText: (path) =>
        path === "src/wrapper.ts" ? `import { i } from "./inner";\nexport const w = i;` : undefined,
    });
    expect(got).toEqual(["src/wrapper.ts"]);
  });

  it("names a module it could not read, keeps it as a subject, and invents nothing behind it", () => {
    const prime = tree(SPEC, SHIM, EDGE);
    const unread: string[] = [];
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { a } from "../osmGeocode.pure";`,
      prime,
      readText: () => undefined,
      onUnread: (path) => unread.push(path),
    });
    expect(got).toContain(SHIM);
    expect(got).not.toContain(EDGE);
    expect(unread).toEqual([SHIM]);
  });

  it("keeps a named path whether or not it resolves, because only a real path can cross", () => {
    // `subjectsNamedBy` reads `"../osmGeocode.pure"` as a relative literal with
    // an extension, and names a path no tree holds. Harmless by construction:
    // a left-behind spec is found by intersecting with what CROSSES, and a
    // path on neither side never does. Kept rather than filtered against
    // prime's tree, because a path prime DELETED crosses as a removal.
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { a } from "../osmGeocode.pure";`,
      prime: tree(SPEC, SHIM),
      readText: () => undefined,
    });
    expect(got).toContain("src/lib/geocode/osmGeocode.pure");
    expect(specsLeftBehind({ kept: new Map([[SPEC, got]]), crossing: new Set([EDGE]) })).toEqual(
      [],
    );
  });

  it("terminates on a cycle of shims", () => {
    const prime = tree(SPEC, "src/a.ts", "src/b.ts");
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { x } from "@/a";`,
      prime,
      readText: (path) => (path === "src/a.ts" ? `export * from "./b";` : `export * from "./a";`),
    });
    expect(got).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("gives up after MAX_SHIM_HOPS rather than walking for ever", () => {
    const chain = Array.from({ length: MAX_SHIM_HOPS + 3 }, (_, i) => `src/s${i}.ts`);
    const prime = tree(SPEC, ...chain);
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { x } from "@/s0";`,
      prime,
      readText: (path) => {
        const i = chain.indexOf(path);
        return i >= 0 && i < chain.length - 1 ? `export * from "./s${i + 1}";` : undefined;
      },
    });
    // The import itself, then one module per hop.
    expect(got).toHaveLength(MAX_SHIM_HOPS + 1);
  });

  it("drops a specifier prime's tree does not hold rather than guessing a path", () => {
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { x } from "@/lib/nowhere";`,
      prime: tree(SPEC),
      readText: () => undefined,
    });
    expect(got).toEqual([]);
  });
});

describe("specsBothSidesHoldDifferently — the only specs a delivery can leave behind", () => {
  it("is a spec both sides hold at different versions, sorted", () => {
    const primeSha = new Map([
      ["src/lib/b/__tests__/b.spec.ts", "p2"],
      ["src/lib/a/__tests__/a.spec.ts", "p1"],
      ["src/lib/same.test.ts", "s"],
      ["src/lib/primeOnly.spec.ts", "x"],
      ["src/lib/code.ts", "c1"],
    ]);
    const cloneSha = new Map([
      ["src/lib/b/__tests__/b.spec.ts", "c2"],
      ["src/lib/a/__tests__/a.spec.ts", "c1"],
      ["src/lib/same.test.ts", "s"],
      ["src/lib/cloneOnly.spec.ts", "y"],
      ["src/lib/code.ts", "c2"],
    ]);
    expect(specsBothSidesHoldDifferently({ primeSha, cloneSha })).toEqual([
      "src/lib/a/__tests__/a.spec.ts",
      "src/lib/b/__tests__/b.spec.ts",
    ]);
  });

  it("is never a fixture: data under __tests__ has no subjects to read", () => {
    const primeSha = new Map([["src/lib/reports/__tests__/fixtures/q.json", "p"]]);
    const cloneSha = new Map([["src/lib/reports/__tests__/fixtures/q.json", "c"]]);
    expect(specsBothSidesHoldDifferently({ primeSha, cloneSha })).toEqual([]);
  });
});

describe("specsLeftBehind — a kept spec whose subject is crossing", () => {
  const kept = new Map<string, string[]>([
    ["src/z/__tests__/z.spec.ts", ["src/z.ts", "src/y.ts"]],
    ["src/a/__tests__/a.spec.ts", ["src/a.ts"]],
    ["src/quiet.spec.ts", ["src/untouched.ts"]],
  ]);

  it("names each one with the crossing files it asserts about, in a stable order", () => {
    const got = specsLeftBehind({
      kept,
      crossing: new Set(["src/y.ts", "src/z.ts", "src/a.ts"]),
    });
    expect(got).toEqual([
      { spec: "src/a/__tests__/a.spec.ts", touchedBy: ["src/a.ts"] },
      { spec: "src/z/__tests__/z.spec.ts", touchedBy: ["src/y.ts", "src/z.ts"] },
    ]);
  });

  it("is not a spec that is itself crossing — that one travels with its subject", () => {
    const got = specsLeftBehind({
      kept,
      crossing: new Set(["src/a.ts", "src/a/__tests__/a.spec.ts"]),
    });
    expect(got).toEqual([]);
  });

  it("is nothing when no subject crosses", () => {
    expect(specsLeftBehind({ kept, crossing: new Set(["src/other.ts"]) })).toEqual([]);
  });
});

describe("leftBehindSpecHold — what a person is told", () => {
  const membrane = { from: "npc-property-dashbord", to: "npc-crm-independent-6505dc" };

  it("is a manual_reconcile hold on the spec, so an operator can approve overwriting it", () => {
    const held = leftBehindSpecHold({
      membrane,
      spec: "src/pages/__tests__/crmConversations.spec.ts",
      touchedBy: ["supabase/config.toml"],
      why: "This clone's copy matches no version prime ever held at this path — it carries work done here.",
    });
    expect(held.path).toBe("src/pages/__tests__/crmConversations.spec.ts");
    expect(held.reason).toBe("manual_reconcile");
    expect(held.pattern).toContain("npc-property-dashbord→npc-crm-independent-6505dc");
    expect(held.note).toContain("supabase/config.toml");
    expect(held.note).toContain("it carries work done here");
    expect(held.note).toContain("a spec and its subject travel together or neither does");
  });

  it("names at most three subjects and counts the rest", () => {
    const held = leftBehindSpecHold({
      membrane,
      spec: "src/s.spec.ts",
      touchedBy: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
      why: "x",
    });
    expect(held.note).toContain("updates 5 file(s)");
    expect(held.note).toContain("src/a.ts, src/b.ts, src/c.ts (and 2 more)");
    expect(held.note).not.toContain("src/d.ts");
  });

  it("says 'did not get to' in words of its own, never as a verdict about the spec", () => {
    const budget = leftBehindSpecHold({
      membrane,
      spec: "s",
      touchedBy: ["a"],
      cutShort: "budget",
    });
    const ceiling = leftBehindSpecHold({
      membrane,
      spec: "s",
      touchedBy: ["a"],
      cutShort: "ceiling",
    });
    const probes = leftBehindSpecHold({
      membrane,
      spec: "s",
      touchedBy: ["a"],
      cutShort: "probes",
    });
    const outside = leftBehindSpecHold({
      membrane,
      spec: "s",
      touchedBy: ["a"],
      cutShort: "outside_probes",
    });
    expect(budget.note).toContain("time budget");
    expect(ceiling.note).toContain("ceiling");
    expect(probes.note).toContain(`${MAX_LEFT_BEHIND_PROBES} specs checked`);
    // What was not asked is a file prime's version needs, and the note says which kind.
    expect(outside.note).toContain("outside the content roots");
    expect(outside.note).toContain(`${MAX_OUTSIDE_ROOT_PROBES} such files`);
    for (const h of [budget, ceiling, probes, outside]) {
      expect(h.note).toMatch(/next one (resumes|continues)/);
      expect(h.note).not.toContain("carries work done here");
    }
  });
});

describe("withLeftBehindNote — a forward hold on a spec brought in from behind", () => {
  it("keeps the forward hold's own words and adds why the spec was in play", () => {
    const hold = {
      path: "src/lib/navigation/__tests__/registry.spec.ts",
      pattern: "(membrane: a→b · spec channel gated on its subject)",
      reason: "manual_reconcile" as const,
      note: "This spec asserts about 1 file(s) that differ upstream.",
    };
    const out = withLeftBehindNote(hold, ["src/lib/navigation/registry.ts"]);
    expect(out.path).toBe(hold.path);
    expect(out.pattern).toBe(hold.pattern);
    expect(out.note?.startsWith(hold.note)).toBe(true);
    expect(out.note).toContain("src/lib/navigation/registry.ts");
    expect(out.note).toContain("older copy is what stays");
  });

  it("stands on its own where the hold carried no note", () => {
    const out = withLeftBehindNote(
      { path: "p", pattern: "x", reason: "manual_reconcile", note: null },
      ["src/a.ts"],
    );
    expect(out.note).toMatch(/^It was brought in because/);
  });
});

describe("describeSpecsBroughtAcross — why a file outside this clone's scope is in the diff", () => {
  it("is nothing when nothing was brought across", () => {
    expect(describeSpecsBroughtAcross({ specs: [], outside: [] })).toBe("");
  });

  it("names each spec with the files it follows, sorted, and how it was allowed to move", () => {
    const text = describeSpecsBroughtAcross({
      specs: [
        {
          spec: "src/lib/geocode/__tests__/osmGeocode.spec.ts",
          touchedBy: ["supabase/functions/_shared/geocode/osmGeocode.pure.ts"],
          basis: "unedited",
        },
        {
          spec: "src/lib/geocode/__tests__/geocoderWiring.spec.ts",
          touchedBy: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
          basis: "approved",
        },
      ],
      outside: [],
    });
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("geocoderWiring.spec.ts");
    expect(lines[0]).toContain("`a.ts`, `b.ts`, `c.ts` (and 2 more)");
    expect(lines[0]).toContain("an operator recorded an overwrite approval");
    expect(lines[1]).toContain("osmGeocode.spec.ts");
    expect(lines[1]).toContain("byte-identical to an older version of prime's");
  });

  it("names a file carried beside the spec that asserts about it", () => {
    const text = describeSpecsBroughtAcross({
      specs: [],
      outside: [
        {
          path: ".claude/skills/npc-services-design/reports/REPORT_RULES.md",
          specs: ["src/lib/reportDesign/__tests__/reportTypography.spec.ts"],
          basis: "unedited",
        },
      ],
    });
    expect(text).toContain(
      "REPORT_RULES.md` — carried beside `src/lib/reportDesign/__tests__/reportTypography.spec.ts`",
    );
    expect(text).toContain("which asserts about it");
  });
});
