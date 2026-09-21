/**
 * The band's placement is arithmetic on two points, so it is asserted rather
 * than looked at. Every case here is checked against the curve
 * `TreeBranchPath` actually draws, evaluated independently in this file —
 * comparing the module to a restatement of its own formula would prove only
 * that it had been copied correctly.
 */

import { describe, it, expect } from "vitest";
import {
  BAND_HALF_SPAN,
  CONTROL_PULL,
  leafletRuns,
  placeMembrane,
  PORE_HALF_HEIGHT,
  slotOffsets,
  type BranchEnds,
} from "./membraneGeometry.pure";

/** The cubic `TreeBranchPath` composes, evaluated at t. Independent of the module. */
function branchPointAt(branch: BranchEnds, t: number): { x: number; y: number } {
  const midY = (branch.from.y + branch.to.y) / 2;
  const k = (branch.to.x - branch.from.x) * CONTROL_PULL;
  const p0 = branch.from;
  const p1 = { x: branch.from.x + k, y: midY };
  const p2 = { x: branch.to.x - k, y: midY };
  const p3 = branch.to;
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

const BRANCHES: Array<[string, BranchEnds]> = [
  ["a wide right-hand branch", { from: { x: 500, y: 120 }, to: { x: 860, y: 430 } }],
  ["a wide left-hand branch", { from: { x: 500, y: 120 }, to: { x: 140, y: 430 } }],
  ["a near-vertical branch", { from: { x: 500, y: 120 }, to: { x: 505, y: 400 } }],
  ["a shallow branch", { from: { x: 300, y: 300 }, to: { x: 700, y: 320 } }],
];

describe("placeMembrane", () => {
  it.each(BRANCHES)("sits exactly on the drawn curve for %s", (_name, branch) => {
    const drawn = branchPointAt(branch, 0.5);
    const placed = placeMembrane(branch);
    expect(placed.cx).toBeCloseTo(drawn.x, 9);
    expect(placed.cy).toBeCloseTo(drawn.y, 9);
  });

  it.each(BRANCHES)("lines up with the curve's own direction for %s", (_name, branch) => {
    // A numeric derivative of the same independently-evaluated curve.
    const h = 1e-6;
    const before = branchPointAt(branch, 0.5 - h);
    const after = branchPointAt(branch, 0.5 + h);
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const len = Math.hypot(dx, dy);

    const placed = placeMembrane(branch);
    expect(placed.tx).toBeCloseTo(dx / len, 6);
    expect(placed.ty).toBeCloseTo(dy / len, 6);
  });

  it("returns a unit tangent and a normal at right angles to it", () => {
    for (const [, branch] of BRANCHES) {
      const p = placeMembrane(branch);
      expect(Math.hypot(p.tx, p.ty)).toBeCloseTo(1, 12);
      expect(Math.hypot(p.nx, p.ny)).toBeCloseTo(1, 12);
      expect(p.tx * p.nx + p.ty * p.ny).toBeCloseTo(0, 12);
    }
  });

  it("reports the angle an SVG rotate() would need", () => {
    const p = placeMembrane({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 } });
    expect(p.angle).toBeCloseTo(0, 9);

    const down = placeMembrane({ from: { x: 0, y: 0 }, to: { x: 0, y: 100 } });
    expect(down.angle).toBeCloseTo(90, 9);
  });

  it("does not divide by zero on a branch of no length", () => {
    const p = placeMembrane({ from: { x: 400, y: 200 }, to: { x: 400, y: 200 } });
    expect(Number.isFinite(p.tx)).toBe(true);
    expect(Number.isFinite(p.ty)).toBe(true);
    expect(Number.isFinite(p.angle)).toBe(true);
    // Down is the tree's own default; every branch descends.
    expect(p.tx).toBe(0);
    expect(p.ty).toBe(1);
    expect(p.cx).toBe(400);
    expect(p.cy).toBe(200);
  });
});

describe("slotOffsets", () => {
  it("puts a single slot in the middle rather than at an edge", () => {
    expect(slotOffsets(1, 12)).toEqual([0]);
  });

  it("centres an even run on zero", () => {
    expect(slotOffsets(2, 12)).toEqual([-6, 6]);
    expect(slotOffsets(4, 10)).toEqual([-15, -5, 5, 15]);
  });

  it("centres an odd run on zero", () => {
    expect(slotOffsets(3, 12)).toEqual([-12, 0, 12]);
  });

  it("is empty for no channels, so a membrane with none draws an unbroken band", () => {
    expect(slotOffsets(0, 12)).toEqual([]);
    expect(slotOffsets(-1, 12)).toEqual([]);
  });

  it("keeps the requested spacing between neighbours", () => {
    const slots = slotOffsets(5, 9);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i] - slots[i - 1]).toBeCloseTo(9, 12);
    }
  });
});

describe("leafletRuns", () => {
  it("draws one unbroken leaflet when the membrane declares no channel", () => {
    expect(leafletRuns([])).toEqual([[-BAND_HALF_SPAN, BAND_HALF_SPAN]]);
  });

  it("opens a gap at every slot and never draws through one", () => {
    const slots = slotOffsets(2, 12);
    const runs = leafletRuns(slots);
    for (const y of slots) {
      for (const [a, b] of runs) {
        // A run that straddles a slot would paint the leaflet across the pore.
        expect(a < y && y < b).toBe(false);
      }
    }
  });

  it("leaves exactly the pore's height open around each slot", () => {
    const runs = leafletRuns([0]);
    expect(runs).toEqual([
      [-BAND_HALF_SPAN, -PORE_HALF_HEIGHT],
      [PORE_HALF_HEIGHT, BAND_HALF_SPAN],
    ]);
  });

  it("reaches both ends of the band", () => {
    const runs = leafletRuns(slotOffsets(3, 12));
    expect(runs[0][0]).toBe(-BAND_HALF_SPAN);
    expect(runs[runs.length - 1][1]).toBe(BAND_HALF_SPAN);
  });

  it("emits no run of negative or zero length", () => {
    for (const count of [1, 2, 3, 4, 5]) {
      for (const [a, b] of leafletRuns(slotOffsets(count, 12))) {
        expect(b).toBeGreaterThan(a);
      }
    }
  });

  it("drops the end caps rather than inverting them when the pores fill the band", () => {
    // Five slots at 12 apart span -24..24 against a half-span of 21, so the
    // outermost pores reach past the band's own ends. A run of negative
    // length there would draw backwards.
    const runs = leafletRuns(slotOffsets(5, 12));
    for (const [a, b] of runs) expect(b).toBeGreaterThan(a);
  });
});

describe("the band does not reach a node", () => {
  /**
   * Measured rather than eyed, and in the BAND'S OWN FRAME — which is the
   * part that is easy to get wrong. The group is rotated onto the branch's
   * tangent, so its half-span runs ACROSS the branch and only its half-width
   * reaches along it, toward the nodes. Conflating the two reports a
   * collision on every short branch and there is none.
   *
   * `use-tree-layout.ts` spaces levels 120 apart with jitter; `tree-node.tsx`
   * draws r=18 for the trunk and r=max(8, 14 − 2·depth) below it, each with a
   * 12-unit halo. The worst case the layout can produce is the shortest
   * jittered branch off the trunk.
   */
  const HIT_ALONG = 12;
  const HIT_ACROSS = 27;
  const LEVEL_SPACING = 120;
  const MAX_JITTER = 30;

  /** Nearest distance from a rect centred on the origin to a local point. */
  function rectToPoint(hx: number, hy: number, px: number, py: number): number {
    return Math.hypot(Math.max(Math.abs(px) - hx, 0), Math.max(Math.abs(py) - hy, 0));
  }

  it.each([
    ["vertical off the trunk", 0, LEVEL_SPACING, 18 + 12],
    ["shortest jittered, off the trunk", 20, LEVEL_SPACING - MAX_JITTER, 18 + 12],
    ["shortest jittered, one level down", 20, LEVEL_SPACING - MAX_JITTER, 12 + 12],
    ["a wide branch", 140, LEVEL_SPACING, 12 + 12],
  ])("clears both nodes on %s", (_label, dx, dy, nodeReach) => {
    const p = placeMembrane({ from: { x: 500, y: 100 }, to: { x: 500 + dx, y: 100 + dy } });
    expect(p.cx).toBeCloseTo(500 + dx / 2, 9);
    // A node sits at half the chord along the tangent, on the band's own axis.
    const half = Math.hypot(dx, dy) / 2;
    expect(rectToPoint(HIT_ALONG, HIT_ACROSS, half, 0)).toBeGreaterThan(nodeReach);
  });

  it("would collide on a branch shorter than the layout can make", () => {
    // Stated as the boundary rather than left implicit: the guard above is a
    // claim about THIS layout, and it stops being true somewhere. A future
    // `levelSpacing` below ~84 brings the band's hit target into the trunk's
    // halo, and this is what will say so.
    const shortest = LEVEL_SPACING - MAX_JITTER;
    expect(shortest / 2).toBeGreaterThan(HIT_ALONG + 18 + 12 - HIT_ALONG);
    expect(rectToPoint(HIT_ALONG, HIT_ACROSS, 20, 0)).toBeLessThan(18 + 12);
  });
});
