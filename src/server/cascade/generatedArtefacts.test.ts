import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  GENERATED_ARTEFACTS,
  generatedArtefactsOwed,
  type GeneratedArtefact,
} from "./generatedArtefacts.pure";
import { API_SURFACE_PATH } from "./apiSurfaceReconcile.pure";

const TOKENS = "mobile/design-tokens.json";
const CSS = "src/styles/tokens.css";
const PORTAL_CSS = "src/styles/finance-portal.css";
const SCRIPT = "scripts/mobile/export-design-tokens.mjs";

/** Prime's tree as cascade #81 met it: a new palette and the artefact it generates. */
const prime = new Map([
  [TOKENS, "tokens-prime"],
  [CSS, "css-prime"],
  [PORTAL_CSS, "portal-prime"],
  [SCRIPT, "script-prime"],
]);

/** The clone before the pass: an older palette and the artefact generated from it. */
const clone = new Map([
  [TOKENS, "tokens-old"],
  [CSS, "css-old"],
  [PORTAL_CSS, "portal-prime"],
  [SCRIPT, "script-prime"],
]);

const none = new Set<string>();

function owed(over: Partial<Parameters<typeof generatedArtefactsOwed>[0]> = {}) {
  return generatedArtefactsOwed({
    prime,
    clone,
    deliveredAtPrime: new Set([CSS]),
    removed: none,
    held: none,
    ...over,
  });
}

describe("a generated file travels with the files it is generated from", () => {
  it("is owed when the delivery lands its last stale source at prime's version (cascade #81)", () => {
    // tokens.css crosses; finance-portal.css and the generator are already
    // prime's on the clone. Prime's committed artefact is then exactly what
    // `npm run mobile:tokens` writes on the clone.
    expect(owed()).toEqual([TOKENS]);
  });

  it("is owed when every source is already prime's on the clone and only the artefact lags", () => {
    expect(
      owed({
        clone: new Map([...clone, [CSS, "css-prime"]]),
        deliveredAtPrime: none,
      }),
    ).toEqual([TOKENS]);
  });

  it("is not owed while any source stays at the clone's own version", () => {
    // A clone that keeps its own palette: prime's artefact would describe
    // somebody else's palette there, and turn the same check red the other
    // way round.
    expect(owed({ deliveredAtPrime: none })).toEqual([]);
  });

  it("is not owed when the generator itself is the clone's own", () => {
    expect(owed({ clone: new Map([...clone, [SCRIPT, "script-clone"]]) })).toEqual([]);
  });

  it("is not owed when a rule holds a source", () => {
    expect(owed({ held: new Set([PORTAL_CSS]) })).toEqual([]);
  });

  it("is not owed when the delivery removes a source", () => {
    expect(owed({ removed: new Set([PORTAL_CSS]) })).toEqual([]);
  });

  it("is not owed when prime does not hold a source", () => {
    const thin = new Map(prime);
    thin.delete(PORTAL_CSS);
    expect(owed({ prime: thin })).toEqual([]);
  });

  it("is not owed where it is already crossing, held, removed or identical", () => {
    expect(owed({ deliveredAtPrime: new Set([CSS, TOKENS]) })).toEqual([]);
    expect(owed({ held: new Set([TOKENS]) })).toEqual([]);
    expect(owed({ removed: new Set([TOKENS]) })).toEqual([]);
    expect(owed({ clone: new Map([...clone, [TOKENS, "tokens-prime"]]) })).toEqual([]);
  });

  it("never widens scope: a clone without the artefact is owed nothing", () => {
    const without = new Map(clone);
    without.delete(TOKENS);
    expect(owed({ clone: without })).toEqual([]);
  });

  it("owes nothing for an entry naming no source", () => {
    const table: GeneratedArtefact[] = [{ artefact: TOKENS, sources: [], regenerate: "x" }];
    expect(owed({ table })).toEqual([]);
  });

  it("returns what is owed sorted, over the injected table", () => {
    const table: GeneratedArtefact[] = [
      { artefact: "z.json", sources: [CSS], regenerate: "z" },
      { artefact: "a.json", sources: [CSS], regenerate: "a" },
    ];
    expect(
      owed({
        table,
        prime: new Map([...prime, ["z.json", "z1"], ["a.json", "a1"]]),
        clone: new Map([...clone, ["z.json", "z0"], ["a.json", "a0"]]),
      }),
    ).toEqual(["a.json", "z.json"]);
  });
});

describe("the table", () => {
  it("never names the mobile API surface, which a clone composes from its own registry", () => {
    expect(GENERATED_ARTEFACTS.map((g) => g.artefact)).not.toContain(API_SURFACE_PATH);
    for (const g of GENERATED_ARTEFACTS) expect(g.sources).not.toContain(API_SURFACE_PATH);
  });

  it("names each artefact once, with its generator among its sources", () => {
    const names = GENERATED_ARTEFACTS.map((g) => g.artefact);
    expect(new Set(names).size).toBe(names.length);
    for (const g of GENERATED_ARTEFACTS) {
      expect(g.sources.some((s) => s.startsWith("scripts/"))).toBe(true);
    }
  });

  it("is wired into the engine's carry loop and offered to the carry plan", () => {
    const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
    expect(engine).toMatch(
      /import \{ generatedArtefactsOwed \} from "\.\/cascade\/generatedArtefacts\.pure"/,
    );
    expect(engine).toMatch(/\.\.\.artefactsOwedNow,/);
    expect(engine).toMatch(/artefactsOwedNow\.length === 0/);
  });
});
