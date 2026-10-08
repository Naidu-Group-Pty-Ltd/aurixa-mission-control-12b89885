import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { strandedSubjects, subjectsNamedBy } from "@/lib/cascade/membrane/membrane.pure";
import { subjectsImportedBy } from "./specImportSubjects.pure";
import { stripComments } from "../sourceComments.pure";

describe("a subject the spec imports rather than names", () => {
  // Cascade #81 on npc-crm-independent-6505dc, 8 Oct 2026, verbatim from
  // prime's spec. It reached `isElevationRefusal` through an extensionless
  // alias import, `secureInvoke.ts` was held for a person to reconcile, and
  // the spec crossed alone: `step_up_invalid: expected false to be true`.
  const specPath = "src/lib/aml/regulatedActs.test.ts";
  const SPEC = `
    import { readFileSync } from "node:fs";
    import { describe, expect, it, vi } from "vitest";
    import { isElevationRefusal } from "@/lib/secureInvoke";
    import { REGULATED_ACTS } from "../../../supabase/functions/_shared/aml/regulatedActs.pure";
    import { STEP_UP_PURPOSES } from "./regulatedActs";
  `;
  const prime = new Map([
    ["src/lib/secureInvoke.ts", "prime"],
    ["supabase/functions/_shared/aml/regulatedActs.pure.ts", "same"],
    ["src/lib/aml/regulatedActs.ts", "same"],
    [specPath, "spec-new"],
  ]);

  it("resolves both project forms against prime's tree, with the extension it omits", () => {
    expect(subjectsImportedBy(SPEC, specPath, prime)).toEqual([
      "src/lib/aml/regulatedActs.ts",
      "src/lib/secureInvoke.ts",
      "supabase/functions/_shared/aml/regulatedActs.pure.ts",
    ]);
  });

  it("finds what no literal rule reads, which is why it exists", () => {
    expect(subjectsNamedBy(SPEC, specPath)).not.toContain("src/lib/secureInvoke.ts");
  });

  it("strands the spec on the held module cascade #81 delivered it without", () => {
    const stranded = strandedSubjects({
      specPath,
      specText: SPEC,
      primeSha: prime,
      cloneSha: new Map([
        ["src/lib/secureInvoke.ts", "clone"],
        ["supabase/functions/_shared/aml/regulatedActs.pure.ts", "same"],
        ["src/lib/aml/regulatedActs.ts", "same"],
        [specPath, "spec-old"],
      ]),
      crossing: new Set([specPath]),
      imported: subjectsImportedBy(SPEC, specPath, prime),
    });
    expect(stranded).toEqual(["src/lib/secureInvoke.ts"]);
  });

  it("lets the spec cross when the module it imports crosses beside it", () => {
    expect(
      strandedSubjects({
        specPath,
        specText: SPEC,
        primeSha: prime,
        cloneSha: new Map([["src/lib/secureInvoke.ts", "clone"]]),
        crossing: new Set([specPath, "src/lib/secureInvoke.ts"]),
        imported: subjectsImportedBy(SPEC, specPath, prime),
      }),
    ).toEqual([]);
  });

  it("takes a package import, an unresolvable one, a comment and the spec itself as no subject", () => {
    const text = `
      import { z } from "zod";
      import x from "@/lib/doesNotExist";
      // import { y } from "@/lib/secureInvoke";
      import self from "./regulatedActs.test";
    `;
    expect(subjectsImportedBy(text, specPath, prime)).toEqual([]);
  });

  it("keeps the content-root rule: a relative import above the roots is no subject", () => {
    const tree = new Map([["vite.config.ts", "x"]]);
    expect(subjectsImportedBy('import c from "../../../vite.config";', specPath, tree)).toEqual([]);
  });
});

describe("both server callers hand the membrane what a spec imports", () => {
  it("the vertical carry loop resolves against prime's tree, and only with one", () => {
    const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
    const at = engine.indexOf("strandedSubjects({");
    expect(at).toBeGreaterThan(-1);
    expect(engine.slice(at, at + 400)).toContain(
      "imported: primeShaByPath ? subjectsImportedBy(specText, specPath, primeShaByPath) : []",
    );
  });

  it("the lateral lane resolves against the origin's tree", () => {
    const lateral = stripComments(
      readFileSync("src/server/cascade/lateralExchange.pure.ts", "utf8"),
    );
    const at = lateral.indexOf("strandedSubjects({");
    expect(at).toBeGreaterThan(-1);
    expect(lateral.slice(at, at + 400)).toContain(
      "imported: subjectsImportedBy(text, path, originTree)",
    );
  });
});
