import { describe, expect, it } from "vitest";
import {
  MAX_BRIDGE_BYTES,
  bridgeCandidates,
  bridgeSuffixFor,
  bridgesOwed,
  describeBridges,
} from "./reExportBridges.pure";

/**
 * Verbatim from cascade PR #29 to `npc-crm-independent-6505dc`: five new
 * modules crossed into `_shared/reportDesign/`, and the clone held the
 * bridge directory with every older bridge in it.
 */
const CANONICAL = "supabase/functions/_shared/reportDesign/templateDesignCss.pure.ts";
const BRIDGE = "src/lib/reportDesign/templateDesignCss.pure.ts";
const SIBLING = "src/lib/reportDesign/tokens.pure.ts";
const BRIDGE_TEXT = `/**
 * Frontend entry point — re-exports the single CANONICAL implementation in
 * \`_shared\`. Do not add logic here.
 */
export * from '../../../supabase/functions/_shared/reportDesign/templateDesignCss.pure.ts';
`;

const tree = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("bridgeCandidates — what could be a missing bridge, by path and size alone", () => {
  const prime = tree({
    [BRIDGE]: "b",
    [SIBLING]: "s",
    [CANONICAL]: "c",
    "src/lib/newFeature/whole.ts": "n",
    "src/lib/reportDesign/large.pure.ts": "l",
    "src/lib/reportDesign/data.json": "j",
  });
  const sizes = new Map([
    [BRIDGE, 510],
    [SIBLING, 490],
    [CANONICAL, 14_670],
    ["src/lib/newFeature/whole.ts", 300],
    ["src/lib/reportDesign/large.pure.ts", MAX_BRIDGE_BYTES + 1],
    ["src/lib/reportDesign/data.json", 20],
  ]);
  const clone = tree({ [SIBLING]: "s" });

  it("names a small source file prime holds, the clone lacks, beside a file the clone holds", () => {
    expect(bridgeCandidates({ prime, primeSizes: sizes, clone })).toEqual([BRIDGE]);
  });

  it("never plants a file in a directory the clone does not carry", () => {
    expect(bridgeCandidates({ prime, primeSizes: sizes, clone })).not.toContain(
      "src/lib/newFeature/whole.ts",
    );
  });

  it("reads nothing larger than any bridge prime holds, and nothing that is not source", () => {
    const got = bridgeCandidates({ prime, primeSizes: sizes, clone });
    expect(got).not.toContain("src/lib/reportDesign/large.pure.ts");
    expect(got).not.toContain("src/lib/reportDesign/data.json");
  });

  it("names nothing outside src/, and nothing the clone already has", () => {
    const got = bridgeCandidates({ prime, primeSizes: sizes, clone });
    expect(got).not.toContain(CANONICAL);
    expect(got).not.toContain(SIBLING);
  });

  it("names nothing whose size the listing did not give", () => {
    expect(bridgeCandidates({ prime, primeSizes: new Map(), clone })).toEqual([]);
  });
});

describe("bridgesOwed — a bridge travels with the shared module it re-exports", () => {
  const prime = tree({ [BRIDGE]: "b", [SIBLING]: "s", [CANONICAL]: "c" });
  const texts: Record<string, string> = { [BRIDGE]: BRIDGE_TEXT };
  const readPrime = (path: string) => texts[path];

  it("owes the bridge when the delivery lands its module", () => {
    const got = bridgesOwed({
      candidates: [BRIDGE],
      readPrime,
      prime,
      clone: tree({ [SIBLING]: "s" }),
      delivered: new Set([CANONICAL]),
    });
    expect(got).toEqual([{ path: BRIDGE, targets: [CANONICAL] }]);
  });

  it("owes the bridge when its module is already prime's copy on the clone", () => {
    // A module that crossed in an earlier delivery without its bridge.
    const got = bridgesOwed({
      candidates: [BRIDGE],
      readPrime,
      prime,
      clone: tree({ [SIBLING]: "s", [CANONICAL]: "c" }),
      delivered: new Set(),
    });
    expect(got.map((b) => b.path)).toEqual([BRIDGE]);
  });

  it("does not owe a bridge onto a module the delivery held back", () => {
    // It would re-export a file the clone does not have.
    expect(
      bridgesOwed({
        candidates: [BRIDGE],
        readPrime,
        prime,
        clone: tree({ [SIBLING]: "s" }),
        delivered: new Set(),
      }),
    ).toEqual([]);
  });

  it("does not owe a bridge onto an older copy of its module", () => {
    expect(
      bridgesOwed({
        candidates: [BRIDGE],
        readPrime,
        prime,
        clone: tree({ [SIBLING]: "s", [CANONICAL]: "older" }),
        delivered: new Set(),
      }),
    ).toEqual([]);
  });

  it("does not owe a file that does work of its own, however small", () => {
    const got = bridgesOwed({
      candidates: [BRIDGE],
      readPrime: () =>
        `export * from '../../../supabase/functions/_shared/reportDesign/templateDesignCss.pure.ts';\nexport const extra = 1;\n`,
      prime,
      clone: tree({ [SIBLING]: "s" }),
      delivered: new Set([CANONICAL]),
    });
    expect(got).toEqual([]);
  });

  it("does not owe a re-export of anything but the shared layer", () => {
    const local = "src/lib/reportDesign/local.ts";
    const got = bridgesOwed({
      candidates: [BRIDGE],
      readPrime: () => `export * from './local';\n`,
      prime: tree({ [BRIDGE]: "b", [local]: "l" }),
      clone: tree({ [SIBLING]: "s", [local]: "l" }),
      delivered: new Set(),
    });
    expect(got).toEqual([]);
    expect(
      bridgesOwed({
        candidates: [BRIDGE],
        readPrime: () => `export * from 'some-package';\n`,
        prime,
        clone: tree({ [SIBLING]: "s" }),
        delivered: new Set([CANONICAL]),
      }),
    ).toEqual([]);
  });

  it("owes nothing on a text it could not read, and nothing already delivered or held", () => {
    const clone = tree({ [SIBLING]: "s" });
    expect(
      bridgesOwed({
        candidates: [BRIDGE],
        readPrime: () => undefined,
        prime,
        clone,
        delivered: new Set([CANONICAL]),
      }),
    ).toEqual([]);
    expect(
      bridgesOwed({
        candidates: [BRIDGE],
        readPrime,
        prime,
        clone,
        delivered: new Set([CANONICAL, BRIDGE]),
      }),
    ).toEqual([]);
  });

  it("requires EVERY module a multi-line bridge re-exports to land", () => {
    const other = "supabase/functions/_shared/reportDesign/cssUnits.pure.ts";
    const text = `export * from '../../../supabase/functions/_shared/reportDesign/templateDesignCss.pure.ts';\nexport { px } from '../../../supabase/functions/_shared/reportDesign/cssUnits.pure.ts';\n`;
    const p = tree({ [BRIDGE]: "b", [CANONICAL]: "c", [other]: "u" });
    const args = {
      candidates: [BRIDGE],
      readPrime: () => text,
      prime: p,
      clone: tree({ [SIBLING]: "s" }),
    };
    expect(bridgesOwed({ ...args, delivered: new Set([CANONICAL]) })).toEqual([]);
    expect(bridgesOwed({ ...args, delivered: new Set([CANONICAL, other]) })).toEqual([
      { path: BRIDGE, targets: [other, CANONICAL].sort() },
    ]);
  });
});

describe("reporting what was carried", () => {
  it("names each bridge and the module it re-exports", () => {
    expect(describeBridges([{ path: BRIDGE, targets: [CANONICAL] }])).toBe(
      `- \`${BRIDGE}\` re-exports \`${CANONICAL}\``,
    );
    expect(bridgeSuffixFor([{ path: BRIDGE, targets: [CANONICAL] }])).toBe(
      " · 1 re-export bridge(s) carried",
    );
  });

  it("says nothing when nothing was carried", () => {
    expect(describeBridges([])).toBe("");
    expect(bridgeSuffixFor([])).toBe("");
  });
});
