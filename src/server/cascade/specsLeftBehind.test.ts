import { describe, expect, it } from "vitest";
import { MAX_OUTSIDE_ROOT_PROBES } from "./outsideRootSubjects.pure";
import {
  describeSpecsBroughtAcross,
  isReExportShim,
  leftBehindSpecHold,
  reExportSpecifiers,
  MAX_LEFT_BEHIND_PROBES,
  MAX_SHIM_HOPS,
  pathsTheDeliveryChanges,
  specSubjects,
  specsBothSidesHoldDifferently,
  specsLeftBehind,
  subjectsOfKeptSpec,
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

describe("reExportSpecifiers — what a shim re-exports, in the shim rule's own reading", () => {
  it("returns every specifier of a pure re-export, in order", () => {
    expect(
      reExportSpecifiers(
        `/** header */\nexport * from "../a.pure.ts";\nexport { b as c } from './b';\nexport type { T } from "@/t";\n`,
      ),
    ).toEqual(["../a.pure.ts", "./b", "@/t"]);
  });

  it("returns null for anything isReExportShim refuses, and agrees with it everywhere", () => {
    for (const text of [
      `export * from "./x";\nexport const y = 1;\n`,
      `import x from "./x";\nexport default x;\n`,
      "",
      "// only a comment\n",
    ]) {
      expect(reExportSpecifiers(text)).toBeNull();
      expect(isReExportShim(text)).toBe(false);
    }
    expect(isReExportShim(`export * from "./x";`)).toBe(true);
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
      tree: prime,
      readText: () => undefined,
    });
    expect(got).toContain("docs/integrations/GEOCODING_WITHOUT_GOOGLE.md");
  });

  it("reads a file it names outside the content roots, so both halves agree on what a subject is", () => {
    const got = specSubjects({
      specPath: "src/lib/reportDesign/__tests__/reportTypography.spec.ts",
      specText: `readFileSync(resolve(REPO, '.claude/skills/npc-services-design/reports/REPORT_RULES.md'))`,
      tree: tree(),
      readText: () => undefined,
    });
    expect(got).toContain(".claude/skills/npc-services-design/reports/REPORT_RULES.md");
  });

  it("reads a module it imports, in both specifier forms", () => {
    const prime = tree(SPEC, SHIM, "src/lib/geocode/geocodeResult.pure.ts");
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { a } from "@/lib/geocode/osmGeocode.pure";\nimport { b } from "../geocodeResult.pure";\n`,
      tree: prime,
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
      tree: prime,
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
      tree: prime,
      readText: (path) => texts[path],
    });
    expect(got).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(got).not.toContain("src/d.ts");
  });

  it("reads the modules a directory's index imports from its own directory", () => {
    // `adapterListings.spec.ts` on the independent, cascade PR #29: the spec
    // imports `../adapters`, whose `index.ts` is a registry that does work, and
    // `qaAdapter.ts` behind it crossed while the clone's spec stayed behind.
    const S = "src/lib/reportTemplate/__tests__/adapterListings.spec.ts";
    const INDEX = "src/lib/reportTemplate/adapters/index.ts";
    const QA = "src/lib/reportTemplate/adapters/qaAdapter.ts";
    const CLIENT = "src/lib/reportTemplate/adapters/clientDetailsAdapter.ts";
    const OUTSIDE = "supabase/functions/_shared/reports/reportTemplateSelection.pure.ts";
    const prime = tree(S, INDEX, QA, CLIENT, OUTSIDE);
    const got = specSubjects({
      specPath: S,
      specText: `import { listAdapters, getAdapter } from '../adapters';\n`,
      tree: prime,
      readText: (path) =>
        path === INDEX
          ? `import { qaAdapter } from './qaAdapter';\n` +
            `import { clientDetailsAdapter } from './clientDetailsAdapter';\n` +
            `import { normaliseReportType } from '../../../../supabase/functions/_shared/reports/reportTemplateSelection.pure.ts';\n` +
            `export const REPORT_TEMPLATE_ADAPTERS = [qaAdapter, clientDetailsAdapter];\n` +
            `export function getAdapter(t: string) { return normaliseReportType(t); }\n`
          : undefined,
    });
    expect(got).toEqual(expect.arrayContaining([INDEX, QA, CLIENT]));
    // The index's own directory only: a module it imports from elsewhere is
    // the index's subject, not the spec's.
    expect(got).not.toContain(OUTSIDE);
    expect(specsLeftBehind({ kept: new Map([[S, got]]), crossing: new Set([QA]) })).toEqual([
      { spec: S, touchedBy: [QA], removed: [] },
    ]);
  });

  it("stops at the index's members rather than walking on through them", () => {
    const S = "src/pkg/__tests__/pkg.spec.ts";
    const prime = tree(S, "src/pkg/index.ts", "src/pkg/member.ts", "src/pkg/deep.ts");
    const got = specSubjects({
      specPath: S,
      specText: `import { m } from "../index";`,
      tree: prime,
      readText: (path) =>
        path === "src/pkg/index.ts"
          ? `import { m } from "./member";\nexport const run = () => m;`
          : path === "src/pkg/member.ts"
            ? `import { d } from "./deep";\nexport const m = d;`
            : undefined,
    });
    expect(got).toEqual(["src/pkg/index.ts", "src/pkg/member.ts"]);
  });

  it("does not look through a module that does work, however few lines it has", () => {
    const prime = tree(SPEC, "src/wrapper.ts", "src/inner.ts");
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { w } from "@/wrapper";`,
      tree: prime,
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
      tree: prime,
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
      tree: tree(SPEC, SHIM),
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
      tree: prime,
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
      tree: prime,
      readText: (path) => {
        const i = chain.indexOf(path);
        return i >= 0 && i < chain.length - 1 ? `export * from "./s${i + 1}";` : undefined;
      },
    });
    // The import itself, then one module per hop.
    expect(got).toHaveLength(MAX_SHIM_HOPS + 1);
  });

  it("drops a specifier the tree does not hold rather than guessing a path", () => {
    const got = specSubjects({
      specPath: SPEC,
      specText: `import { x } from "@/lib/nowhere";`,
      tree: tree(SPEC),
      readText: () => undefined,
    });
    expect(got).toEqual([]);
  });
});

describe("subjectsOfKeptSpec — each copy read against its own tree", () => {
  const SPEC = "src/lib/crm/__tests__/crmInbox.spec.ts";
  const CLONE_ONLY = "src/lib/crm/crmInboxClone.ts";
  const SHARED = "src/lib/crm/inboxShared.ts";

  it("resolves the clone's copy against the clone's tree, where prime's tree holds nothing to resolve to", () => {
    // The clone's copy imports a module only the clone holds. Against prime's
    // tree that import resolves to nothing, so a removal of the module read as
    // no change to the spec that imports it.
    const cloneText = `import { inbox } from "../crmInboxClone";\n`;
    const primeTree = tree(SPEC, SHARED);
    const cloneTree = tree(SPEC, SHARED, CLONE_ONLY);
    expect(
      specSubjects({
        specPath: SPEC,
        specText: cloneText,
        tree: primeTree,
        readText: () => undefined,
      }),
    ).toEqual([]);
    const got = subjectsOfKeptSpec({
      specPath: SPEC,
      sides: [
        {
          side: "prime",
          text: `import { s } from "../inboxShared";\n`,
          tree: primeTree,
          readText: () => undefined,
        },
        { side: "clone", text: cloneText, tree: cloneTree, readText: () => undefined },
      ],
    });
    expect(got).toEqual([CLONE_ONLY, SHARED]);
  });

  it("looks through each side's shim with that side's own text", () => {
    // Both copies import the same shim path, and the shim re-exports a
    // different module on each side. Each side's target is its own.
    const shim = "src/lib/crm/inbox.ts";
    const text = `import { i } from "../inbox";\n`;
    const primeTree = tree(SPEC, shim, "src/lib/crm/x.ts");
    const cloneTree = tree(SPEC, shim, "src/lib/crm/y.ts");
    const got = subjectsOfKeptSpec({
      specPath: SPEC,
      sides: [
        {
          side: "prime",
          text,
          tree: primeTree,
          readText: (p) => (p === shim ? `export * from "./x";` : undefined),
        },
        {
          side: "clone",
          text,
          tree: cloneTree,
          readText: (p) => (p === shim ? `export * from "./y";` : undefined),
        },
      ],
    });
    expect(got).toEqual([shim, "src/lib/crm/x.ts", "src/lib/crm/y.ts"]);
  });

  it("says which side a module could not be read from, so it is read from that repository", () => {
    const shim = "src/lib/crm/inbox.ts";
    const unread: Array<[string, string]> = [];
    subjectsOfKeptSpec({
      specPath: SPEC,
      sides: [
        {
          side: "prime",
          text: `import { i } from "../inbox";`,
          tree: tree(SPEC, shim),
          readText: () => undefined,
        },
        {
          side: "clone",
          text: `import { i } from "../inbox";`,
          tree: tree(SPEC, shim),
          readText: () => undefined,
        },
      ],
      onUnread: (side, path) => unread.push([side, path]),
    });
    expect(unread).toEqual([
      ["prime", shim],
      ["clone", shim],
    ]);
  });

  it("skips a side whose copy was not read, rather than reading it as a spec with no subjects", () => {
    const got = subjectsOfKeptSpec({
      specPath: SPEC,
      sides: [
        { side: "prime", text: undefined, tree: tree(SPEC, SHARED), readText: () => undefined },
        {
          side: "clone",
          text: `import { s } from "../inboxShared";`,
          tree: tree(SPEC, SHARED),
          readText: () => undefined,
        },
      ],
    });
    expect(got).toEqual([SHARED]);
  });
});

describe("pathsTheDeliveryChanges — what crossing means on this side of the channel", () => {
  const none = new Set<string>();

  it("counts a verbatim write, and never a tree entry that removes", () => {
    const got = pathsTheDeliveryChanges({
      entries: [
        { path: "src/a.ts", sha: "blob-a" },
        { path: "src/gone.ts", sha: null },
      ],
      reconciled: none,
      reconcileWrites: none,
      rehearsed: none,
      removing: none,
    });
    expect([...got]).toEqual(["src/a.ts"]);
  });

  it("does not count a reconcile pump whose merge writes the clone's own bytes back", () => {
    // The first replay held the clone's own crmConversations.spec.ts under
    // "this delivery updates supabase/config.toml" on a delivery that changed
    // no config.toml.
    const got = pathsTheDeliveryChanges({
      entries: [{ path: "supabase/config.toml", sha: "same-as-clone" }],
      reconciled: new Set(["supabase/config.toml"]),
      reconcileWrites: none,
      rehearsed: none,
      removing: none,
    });
    expect(got.size).toBe(0);
  });

  it("does count a reconcile pump whose merge changes the file", () => {
    const got = pathsTheDeliveryChanges({
      entries: [{ path: "supabase/config.toml", sha: "merged" }],
      reconciled: new Set(["supabase/config.toml"]),
      reconcileWrites: new Set(["supabase/config.toml"]),
      rehearsed: none,
      removing: none,
    });
    expect([...got]).toEqual(["supabase/config.toml"]);
  });

  it("counts what a rehearsal would write, so a dry run answers as the real pass would", () => {
    const got = pathsTheDeliveryChanges({
      entries: [],
      reconciled: none,
      reconcileWrites: none,
      rehearsed: new Set(["supabase/security/SECURITY_REGISTRY.json"]),
      removing: none,
    });
    expect([...got]).toEqual(["supabase/security/SECURITY_REGISTRY.json"]);
  });

  it("counts a removal only from the finished plan, never from the tree's own removing entries", () => {
    // A removal the reference check withheld still has no place in `removing`,
    // and the entry that would have made it is ignored here, so a withheld
    // removal can never read as crossing.
    const got = pathsTheDeliveryChanges({
      entries: [
        { path: "src/planned.ts", sha: null },
        { path: "src/withheld.ts", sha: null },
      ],
      reconciled: none,
      reconcileWrites: none,
      rehearsed: none,
      removing: new Set(["src/planned.ts"]),
    });
    expect([...got]).toEqual(["src/planned.ts"]);
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
      { spec: "src/a/__tests__/a.spec.ts", touchedBy: ["src/a.ts"], removed: [] },
      { spec: "src/z/__tests__/z.spec.ts", touchedBy: ["src/y.ts", "src/z.ts"], removed: [] },
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

  it("says which of the crossing subjects the delivery removes", () => {
    const got = specsLeftBehind({
      kept,
      crossing: new Set(["src/y.ts", "src/z.ts"]),
      removing: new Set(["src/y.ts"]),
    });
    expect(got).toEqual([
      {
        spec: "src/z/__tests__/z.spec.ts",
        touchedBy: ["src/y.ts", "src/z.ts"],
        removed: ["src/y.ts"],
      },
    ]);
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
  it("says a delivery that only updates its subjects in exactly the words it always has", () => {
    // Pinned whole: every hold written before removals were told apart used
    // these words, and an operator's reading of them must not move.
    const held = leftBehindSpecHold({
      membrane,
      spec: "src/pages/__tests__/crmConversations.spec.ts",
      touchedBy: ["supabase/config.toml"],
      why: "This clone's copy matches no version prime ever held at this path — it carries work done here.",
    });
    expect(held.note).toBe(
      "This clone keeps its own version of this spec, and this delivery updates 1 file(s) it " +
        "asserts about: supabase/config.toml. Prime's version did not travel with them: This " +
        "clone's copy matches no version prime ever held at this path — it carries work done " +
        "here. Until it is reconciled, this spec's older assertions run against the updated " +
        "files — a spec and its subject travel together or neither does, so bring prime's " +
        "version across or update this clone's to match.",
    );
  });

  it("never calls a removed file updated, and says the spec runs against a tree without it", () => {
    const held = leftBehindSpecHold({
      membrane,
      spec: "src/s.spec.ts",
      touchedBy: ["src/gone.ts"],
      removed: ["src/gone.ts"],
      why: "x.",
    });
    expect(held.note).toContain(
      "this delivery removes 1 file(s) it asserts about, which prime deleted: src/gone.ts.",
    );
    expect(held.note).not.toContain("updates");
    expect(held.note).toContain("run against a tree without them");
    expect(held.note).not.toContain("the updated files");
  });

  it("names both halves when a delivery updates some subjects and removes others", () => {
    const held = leftBehindSpecHold({
      membrane,
      spec: "src/s.spec.ts",
      touchedBy: ["src/a.ts", "src/gone.ts"],
      removed: ["src/gone.ts"],
      why: "x.",
    });
    expect(held.note).toContain(
      "this delivery updates 1 file(s) it asserts about (src/a.ts) and removes 1 that prime deleted (src/gone.ts).",
    );
    expect(held.note).toContain("run against the updated files");
  });

  it("names a removal the delivery withheld beside what it does change", () => {
    const held = leftBehindSpecHold({
      membrane,
      spec: "src/s.spec.ts",
      touchedBy: ["src/a.ts"],
      withheld: ["src/kept-import.ts"],
      why: "x.",
    });
    expect(held.note).toContain("updates 1 file(s) it asserts about: src/a.ts.");
    expect(held.note).toContain(
      "Prime also deleted src/kept-import.ts, which it asserts about; that removal is withheld this pass because a file this clone keeps still imports it.",
    );
  });

  it("stays and says why where the only subject that moved had its removal withheld", () => {
    // The hold is the row an operator approves to let the spec — and so the
    // removal — through, so it is not dropped when nothing else changes.
    const held = leftBehindSpecHold({
      membrane,
      spec: "src/s.spec.ts",
      touchedBy: [],
      withheld: ["src/kept-import.ts"],
      why: "x.",
    });
    expect(held.note).toContain("it asserts about 1 file(s) prime deleted: src/kept-import.ts.");
    expect(held.note).toContain(
      "This delivery withholds that removal because a file this clone keeps still imports it.",
    );
    expect(held.note).toContain("Nothing it asserts about changes on this pass.");
    expect(held.note).not.toContain("updates");
    expect(held.note).not.toContain("older assertions run against");
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
    const out = withLeftBehindNote(hold, { touchedBy: ["src/lib/navigation/registry.ts"] });
    expect(out.path).toBe(hold.path);
    expect(out.pattern).toBe(hold.pattern);
    expect(out.note?.startsWith(hold.note)).toBe(true);
    expect(out.note).toContain("src/lib/navigation/registry.ts");
    expect(out.note).toContain("older copy is what stays");
  });

  it("stands on its own where the hold carried no note", () => {
    const out = withLeftBehindNote(
      { path: "p", pattern: "x", reason: "manual_reconcile", note: null },
      { touchedBy: ["src/a.ts"] },
    );
    expect(out.note).toMatch(/^It was brought in because/);
  });
  const hold = {
    path: "src/s.spec.ts",
    pattern: "(membrane: a→b · spec channel gated on its subject)",
    reason: "manual_reconcile" as const,
    note: "Forward.",
  };

  it("adds exactly the words it always has where the delivery only updates", () => {
    expect(withLeftBehindNote(hold, { touchedBy: ["src/a.ts"] }).note).toBe(
      "Forward. It was brought in because this delivery updates src/a.ts, which this clone's own " +
        "older copy asserts about; that older copy is what stays, so reconcile it against the " +
        "updated files.",
    );
  });

  it("says a removed subject was removed, and what the older copy is reconciled against", () => {
    const note = withLeftBehindNote(hold, {
      touchedBy: ["src/gone.ts"],
      removed: ["src/gone.ts"],
    }).note;
    expect(note).toContain("this delivery removes src/gone.ts");
    expect(note).toContain("reconcile it against a tree without them.");
    expect(note).not.toContain("updates");
  });

  it("says why the spec was in play when the only thing that moved was a withheld removal", () => {
    const note = withLeftBehindNote(hold, { touchedBy: [], withheld: ["src/kept-import.ts"] }).note;
    expect(note).toContain("It was brought in because prime deleted src/kept-import.ts");
    expect(note).toContain(
      "that removal is withheld this pass because a file this clone keeps still imports it.",
    );
  });

  it("leaves the hold exactly as it was when nothing it asserts about moved at all", () => {
    expect(withLeftBehindNote(hold, { touchedBy: [] })).toBe(hold);
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

  it("names a spec in exactly the words it always has where the delivery only updates", () => {
    expect(
      describeSpecsBroughtAcross({
        specs: [{ spec: "src/s.spec.ts", touchedBy: ["src/a.ts"], basis: "unedited" }],
        outside: [],
      }),
    ).toBe(
      "- `src/s.spec.ts` — follows `src/a.ts`, which this delivery updates; this clone's copy was " +
        "byte-identical to an older version of prime's.",
    );
  });

  it("tells a removed subject from an updated one", () => {
    const removedOnly = describeSpecsBroughtAcross({
      specs: [
        {
          spec: "src/s.spec.ts",
          touchedBy: ["src/gone.ts"],
          removed: ["src/gone.ts"],
          basis: "unedited",
        },
      ],
      outside: [],
    });
    expect(removedOnly).toContain("follows `src/gone.ts`, which this delivery removes;");
    const mixed = describeSpecsBroughtAcross({
      specs: [
        {
          spec: "src/s.spec.ts",
          touchedBy: ["src/a.ts", "src/gone.ts"],
          removed: ["src/gone.ts"],
          basis: "approved",
        },
      ],
      outside: [],
    });
    expect(mixed).toContain(
      "follows `src/a.ts`, which this delivery updates, and `src/gone.ts`, which it removes;",
    );
  });

  it("owns up to a subject the finished delivery no longer changes, because prime's version still landed", () => {
    const partly = describeSpecsBroughtAcross({
      specs: [
        {
          spec: "src/s.spec.ts",
          touchedBy: ["src/a.ts"],
          unchanged: ["src/held.ts"],
          basis: "unedited",
        },
      ],
      outside: [],
    });
    expect(partly).toContain(
      "follows `src/a.ts`, which this delivery updates (it was also brought across for `src/held.ts`, which this delivery no longer changes);",
    );
    const wholly = describeSpecsBroughtAcross({
      specs: [
        { spec: "src/s.spec.ts", touchedBy: [], unchanged: ["src/held.ts"], basis: "unedited" },
      ],
      outside: [],
    });
    expect(wholly).toContain(
      "— was brought across for `src/held.ts`, which this delivery no longer changes;",
    );
    expect(wholly).not.toContain("follows");
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
