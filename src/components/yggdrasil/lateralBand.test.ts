/**
 * THE LATERAL BAND'S PLACEMENT, ITS PORES AND ITS FLOW, ASSERTED WITHOUT A RENDERER.
 *
 * Three claims carry the drawing. The band sits ON the arch it belongs to — at
 * the curve's own midpoint, square across it. Each lane of each pore is the
 * membrane INTO the side it runs toward, read off the registry rather than
 * restated. And what crosses both ways travels the arch through the passage
 * at the band's centre, each direction on the lane the band keeps for it,
 * timed by distance so it is dark under both nodes. All three are arithmetic,
 * so all three are computed here.
 */

import { describe, expect, it } from "vitest";
import {
  CRM_DEPENDENT_PARENT,
  CRM_INDEPENDENT_PARENT,
  FLEET_LATERALS,
  type LateralBoundary,
} from "@/lib/cascade/membrane/lateralMembranes.pure";
import type { IonChannel, Membrane } from "@/lib/cascade/membrane/membrane.pure";
import {
  LATERAL_ARCH_ARROW,
  LATERAL_FLOW,
  LATERAL_LANE_OFFSET,
  LATERAL_PASSAGE_HALF,
  LATERAL_PLUG,
  LATERAL_PORE_HALF,
  LATERAL_PORE_SPACING,
  LATERAL_SAG,
  laneCounts,
  lateralArcLength,
  lateralArchArrow,
  lateralFlowTiming,
  lateralLanePath,
  lateralLaneY,
  lateralLayout,
  lateralPointAt,
  lateralPores,
  lateralTAtShare,
  lateralTangentAt,
  placeLateral,
  type LateralInto,
  type LateralPlacement,
  type Point,
} from "./lateralBand.pure";

const A = { x: 560, y: 200 };
const B = { x: 840, y: 200 };
const TRUNK = { x: 700, y: 80 };

describe("where the arch runs", () => {
  it("puts the band ON the drawn curve, exactly `sag` off the chord", () => {
    for (const [a, b] of [
      [A, B],
      [
        { x: 548, y: 193 },
        { x: 851, y: 208 },
      ],
    ] as const) {
      const p = placeLateral(a, b, TRUNK);
      const mid = lateralPointAt(a, b, p, 0.5);
      expect(mid.x).toBeCloseTo(p.cx, 9);
      expect(mid.y).toBeCloseTo(p.cy, 9);
      const chordMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      expect(Math.hypot(p.cx - chordMid.x, p.cy - chordMid.y)).toBeCloseTo(p.sag, 9);
    }
  });

  it("stands the band square across the arch: the tangent at the apex is the chord's", () => {
    // Measured off the curve itself, by a central difference, rather than
    // trusted from the derivation in the module's header. Either way along
    // the arch is the same line, so the comparison is taken modulo a half-turn.
    for (const [a, b] of [
      [A, { x: 851, y: 214 }],
      [{ x: 851, y: 214 }, A],
    ] as const) {
      const p = placeLateral(a, b, TRUNK);
      const e = 1e-5;
      const before = lateralPointAt(a, b, p, 0.5 - e);
      const after = lateralPointAt(a, b, p, 0.5 + e);
      const measured = (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI;
      const apart = (((measured - p.angle) % 180) + 180) % 180;
      expect(Math.min(apart, 180 - apart)).toBeCloseTo(0, 6);
    }
  });

  it("never turns the band upside down, and says which way `b` then lies", () => {
    // Every chord direction round the clock. The band's own x axis, times
    // `bSign`, must point from `a` toward `b` — that is what lets a lane be
    // drawn by the sign and still run into the side it names.
    for (let deg = -180; deg < 180; deg += 7.5) {
      const th = (deg * Math.PI) / 180;
      const b = { x: A.x + 200 * Math.cos(th), y: A.y + 200 * Math.sin(th) };
      const p = placeLateral(A, b, TRUNK);
      expect(p.angle).toBeGreaterThan(-90);
      expect(p.angle).toBeLessThanOrEqual(90);
      const rad = (p.angle * Math.PI) / 180;
      expect(p.bSign * Math.cos(rad)).toBeCloseTo(p.tx, 9);
      expect(p.bSign * Math.sin(rad)).toBeCloseTo(p.ty, 9);
    }
  });

  it("draws the path from the very points it reports", () => {
    const p = placeLateral(A, B, TRUNK);
    expect(p.d).toBe(`M ${A.x} ${A.y} C ${p.c1.x} ${p.c1.y}, ${p.c2.x} ${p.c2.y}, ${B.x} ${B.y}`);
  });

  it("bows toward the trunk, whichever parent the layout drew on the left", () => {
    // Up the screen is toward the trunk here; below the chord are the
    // parents' own captions, which a downward arch would run through.
    const leftToRight = placeLateral(A, B, TRUNK);
    const rightToLeft = placeLateral(B, A, TRUNK);
    expect(leftToRight.cy).toBeLessThan(A.y);
    expect(rightToLeft.cy).toBeLessThan(A.y);
    expect(rightToLeft.cx).toBeCloseTo(leftToRight.cx, 9);
    expect(rightToLeft.cy).toBeCloseTo(leftToRight.cy, 9);
    // And drawn the same way up, so the pores read in the boundary's order
    // either way; only which way along the band each lane runs changes.
    expect(rightToLeft.angle).toBeCloseTo(leftToRight.angle, 9);
    expect(leftToRight.bSign).toBe(1);
    expect(rightToLeft.bSign).toBe(-1);
  });

  it("bows up the screen with no trunk, or with one on the chord's own line", () => {
    expect(placeLateral(A, B).ny).toBe(-1);
    expect(placeLateral(B, A).ny).toBe(-1);
    expect(placeLateral(A, B, { x: 1200, y: 200 }).ny).toBe(-1);
  });

  it("follows the trunk to whichever side it is on", () => {
    // A trunk BELOW the chord is not this fleet's shape; it is here to show
    // the side is read, not assumed.
    expect(placeLateral(A, B, { x: 700, y: 400 }).ny).toBe(1);
  });

  it("bounds the sag at both ends and scales it in between", () => {
    expect(placeLateral(A, { x: 600, y: 200 }, TRUNK).sag).toBe(LATERAL_SAG.min);
    expect(placeLateral(A, { x: 1560, y: 200 }, TRUNK).sag).toBe(LATERAL_SAG.max);
    expect(placeLateral(A, { x: 760, y: 200 }, TRUNK).sag).toBeCloseTo(LATERAL_SAG.ratio * 200, 9);
  });

  it("stays finite for two nodes drawn on one point", () => {
    const p = placeLateral(A, A, TRUNK);
    for (const v of [p.cx, p.cy, p.tx, p.ty, p.nx, p.ny, p.angle, p.sag, p.c1.x, p.c2.y]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(p.d).not.toContain("NaN");
  });
});

describe("what each pore says", () => {
  const boundary = FLEET_LATERALS[0];
  const [sideA, sideB] = boundary.sides;
  const pores = lateralPores(boundary);

  it("joins the two parents the lateral registry names", () => {
    expect(boundary.sides).toEqual([CRM_DEPENDENT_PARENT, CRM_INDEPENDENT_PARENT]);
  });

  it("has one pore per species either direction declares, and no more", () => {
    const declared = new Set(
      [boundary.toward[sideA], boundary.toward[sideB]].flatMap((m) =>
        (m?.channels ?? []).map((c) => c.species),
      ),
    );
    expect(pores.map((p) => p.species).sort()).toEqual([...declared].sort());
    expect(new Set(pores.map((p) => p.species)).size).toBe(pores.length);
  });

  it("reads each lane off the membrane INTO the side it runs toward", () => {
    const strictest = (m: Membrane | undefined, species: string) => {
      const states = (m?.channels ?? []).filter((c) => c.species === species).map((c) => c.state);
      if (states.length === 0) return "undeclared";
      if (states.includes("closed")) return "closed";
      if (states.includes("gated")) return "gated";
      return "open";
    };
    for (const pore of pores) {
      expect(pore.intoA).toBe(strictest(boundary.toward[sideA], pore.species));
      expect(pore.intoB).toBe(strictest(boundary.toward[sideB], pore.species));
    }
  });

  it("draws the CRM line running opposite ways across the boundary", () => {
    // The whole reason a pore carries two lanes. Into the CRM-independent
    // parent a routed name is refused and the routing layer is its own; into
    // the GoHighLevel parent it is exactly the reverse.
    const byName = new Map(pores.map((p) => [p.species, p]));
    const intoIndependent = sideB === CRM_INDEPENDENT_PARENT ? "intoB" : "intoA";
    const intoDependent = intoIndependent === "intoB" ? "intoA" : "intoB";
    expect(byName.get("routed_crm_name")?.[intoIndependent]).toBe("closed");
    expect(byName.get("routed_crm_name")?.[intoDependent]).toBe("open");
    expect(byName.get("crm_routing_layer")?.[intoDependent]).toBe("closed");
    expect(byName.get("crm_routing_layer")?.[intoIndependent]).toBe("open");
  });

  it("keeps the boundary's order, not the screen's", () => {
    const first = boundary.toward[sideB]!.channels.map((c) => c.species);
    expect(pores.map((p) => p.species).slice(0, first.length)).toEqual([...new Set(first)]);
  });

  it("counts what each direction refuses and what it leaves to a person", () => {
    for (const [into, side] of [
      ["intoA", sideA],
      ["intoB", sideB],
    ] as const) {
      const channels = boundary.toward[side]!.channels;
      // One channel per species each way in this registry, so a lane is a
      // channel and the counts are the channels' own. Asserted, not assumed.
      expect(new Set(channels.map((c) => c.species)).size).toBe(channels.length);
      expect(laneCounts(pores, into)).toEqual({
        closed: channels.filter((c) => c.state === "closed").length,
        gated: channels.filter((c) => c.state === "gated").length,
        // Every species either way declares is declared both ways here.
        undeclared: 0,
      });
    }
  });
});

describe("a lane never looks more permeable than its rule", () => {
  const channel = (species: IonChannel["species"], state: IonChannel["state"], within = "**") =>
    ({ species, state, within, reason: "protected", note: "" }) as IonChannel;
  const membrane = (from: string, to: string, channels: IonChannel[]): Membrane => ({
    from,
    to,
    label: `${from} → ${to}`,
    rationale: "",
    channels,
    standing: [],
  });
  const synthetic = (intoA: IonChannel[], intoB: IonChannel[]): LateralBoundary => ({
    id: "a~b",
    ledgerId: "00000000-0000-0000-0000-000000000000",
    sides: ["a", "b"],
    label: "a ⇄ b",
    rationale: "",
    toward: { a: membrane("b", "a", intoA), b: membrane("a", "b", intoB) },
    standing: [],
  });

  it("shows the strictest channel where a direction declares a species twice", () => {
    const pores = lateralPores(
      synthetic(
        [],
        [channel("migration", "open", "docs/**"), channel("migration", "closed", "supabase/**")],
      ),
    );
    expect(pores).toEqual([{ species: "migration", intoA: "undeclared", intoB: "closed" }]);
  });

  it("says `undeclared`, never `open`, where a direction has no channel for a species", () => {
    // `permeate` refuses only on a closed channel, so an undeclared species
    // crosses — but nothing DECLARED it open, and the drawing does not claim so.
    const pores = lateralPores(synthetic([channel("spec", "gated")], []));
    expect(pores).toEqual([{ species: "spec", intoA: "gated", intoB: "undeclared" }]);
    // And the accessible name counts it, as the drawing shows it.
    expect(laneCounts(pores, "intoB")).toEqual({ closed: 0, gated: 0, undeclared: 1 });
    expect(laneCounts(pores, "intoA")).toEqual({ closed: 0, gated: 1, undeclared: 0 });
  });
});

describe("the band's size", () => {
  const FLEET_PORES = lateralPores(FLEET_LATERALS[0]).length;
  /** Every mouth on the band, top to bottom: the pores' and the passage's. */
  const mouths = (n: number): Array<[number, number]> => {
    const { slots } = lateralLayout(n);
    return [
      ...slots.map((y): [number, number] => [y, LATERAL_PORE_HALF]),
      [0, LATERAL_PASSAGE_HALF] as [number, number],
    ].sort((p, q) => p[0] - q[0]);
  };

  it("grows with the registry rather than crowding it", () => {
    for (const n of [0, 1, 2, 4, 7, 12]) {
      const { slots, top, bottom } = lateralLayout(n);
      expect(slots).toHaveLength(n);
      for (const [y, half] of mouths(n)) {
        expect(y - half).toBeGreaterThanOrEqual(top);
        expect(y + half).toBeLessThanOrEqual(bottom);
      }
    }
    const span = (n: number) => lateralLayout(n).bottom - lateralLayout(n).top;
    expect(span(12)).toBeGreaterThan(span(7));
  });

  it("puts the passage on the arch and every pore off it, in the boundary's order", () => {
    // Zero on the band's own y axis IS the arch: the band is centred on the
    // apex and the arch crosses it square. So no pore may reach zero, and the
    // pores must still read in the boundary's order from the top.
    for (const n of [1, 2, 5, 7, 12]) {
      const { slots } = lateralLayout(n);
      for (const y of slots)
        expect(Math.abs(y) - LATERAL_PORE_HALF).toBeGreaterThan(LATERAL_PASSAGE_HALF);
      for (let i = 1; i < n; i += 1) expect(slots[i]).toBeGreaterThan(slots[i - 1]);
      // The first half above the passage, the rest — the larger half — below it.
      expect(slots.filter((y) => y < 0)).toHaveLength(Math.floor(n / 2));
    }
  });

  it("gives the passage room for both lanes' particles, clear of its walls", () => {
    // A particle on either lane passes the passage without touching the
    // leaflet: the leaflet stops at the mouth and its round cap reaches in by
    // half its width, which is exactly what `LATERAL_PASSAGE_WALL_HALF` leaves.
    expect(LATERAL_LANE_OFFSET + LATERAL_FLOW.r).toBeLessThan(LATERAL_PASSAGE_HALF - 0.8);
    // And it is the widest mouth on the band, as the one everything else crosses by.
    expect(LATERAL_PASSAGE_HALF).toBeGreaterThan(LATERAL_PORE_HALF);
  });

  it("fits both of a pore's plugs inside its mouth, apart from each other", () => {
    const top = -LATERAL_LANE_OFFSET - LATERAL_PLUG / 2;
    const bottom = LATERAL_LANE_OFFSET + LATERAL_PLUG / 2;
    expect(top).toBeGreaterThan(-LATERAL_PORE_HALF);
    expect(bottom).toBeLessThan(LATERAL_PORE_HALF);
    // The lower edge of the upper plug is above the upper edge of the lower one.
    expect(-LATERAL_LANE_OFFSET + LATERAL_PLUG / 2).toBeLessThan(
      LATERAL_LANE_OFFSET - LATERAL_PLUG / 2,
    );
  });

  it("leaves the same stretch of leaflet between every two mouths, and some past each end", () => {
    // The ladder: at ten units apart the mouths of seven pores met end to end,
    // and the wall they are holes IN survived only at the band's two tips.
    // The passage keeps the pores' rhythm rather than crowding its neighbours.
    const { runs, top, bottom } = lateralLayout(FLEET_PORES);
    const all = mouths(FLEET_PORES);
    expect(runs).toHaveLength(all.length + 1);
    expect(runs[0][0]).toBe(top);
    expect(runs[runs.length - 1][1]).toBe(bottom);
    for (let k = 0; k < all.length; k += 1) {
      // Run k ends at mouth k and run k + 1 starts at its far side.
      expect(runs[k][1]).toBeCloseTo(all[k][0] - all[k][1], 9);
      expect(runs[k + 1][0]).toBeCloseTo(all[k][0] + all[k][1], 9);
    }
    const stretch = LATERAL_PORE_SPACING - 2 * LATERAL_PORE_HALF;
    for (const [from, to] of runs.slice(1, -1)) expect(to - from).toBeCloseTo(stretch, 9);
    for (const [from, to] of [runs[0], runs[runs.length - 1]]) expect(to - from).toBeGreaterThan(0);
  });

  it("leaves no leaflet across a mouth, and leaflet everywhere else", () => {
    const { runs, top, bottom } = lateralLayout(FLEET_PORES);
    for (const [y, half] of mouths(FLEET_PORES)) {
      for (const [from, to] of runs) expect(to <= y - half || from >= y + half).toBe(true);
    }
    const covered = runs.reduce((sum, [from, to]) => sum + (to - from), 0);
    const open = mouths(FLEET_PORES).reduce((sum, [, half]) => sum + 2 * half, 0);
    expect(covered).toBeCloseTo(bottom - top - open, 9);
  });

  it("draws an empty registry as a passage and nothing else", () => {
    // A boundary whose directions declare no channels still carries its
    // parent-level work — which is all it carries.
    const { slots, runs, top, bottom } = lateralLayout(0);
    expect(slots).toEqual([]);
    expect(runs).toEqual([
      [top, -LATERAL_PASSAGE_HALF],
      [LATERAL_PASSAGE_HALF, bottom],
    ]);
  });
});

/** The four points of a cubic `M … C …, …, …` path, read back off its markup. */
function cubicOf(d: string): [Point, Point, Point, Point] {
  const v = [...d.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)].map((m) => Number(m[0]));
  expect(v).toHaveLength(8);
  return [
    { x: v[0], y: v[1] },
    { x: v[2], y: v[3] },
    { x: v[4], y: v[5] },
    { x: v[6], y: v[7] },
  ];
}

function cubicAt([p0, p1, p2, p3]: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** A point on the page, in the band's own frame: its placement undone. */
function inBandFrame(p: Point, placement: LateralPlacement): Point {
  const rad = (placement.angle * Math.PI) / 180;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  const dx = p.x - placement.cx;
  const dy = p.y - placement.cy;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

describe("the flow along the arch", () => {
  const PAIRS: ReadonlyArray<readonly [Point, Point]> = [
    [A, B],
    [B, A],
    // The fleet's jitter, and a steep one no layout draws today.
    [
      { x: 548, y: 193 },
      { x: 851, y: 214 },
    ],
    [
      { x: 520, y: 150 },
      { x: 760, y: 330 },
    ],
    // A short arch and a wide one.
    [A, { x: 660, y: 205 }],
    [A, { x: 1480, y: 190 }],
  ];
  const INTO: readonly LateralInto[] = ["a", "b"];

  it("moves each direction's line through its own lane of the passage, exactly", () => {
    for (const [a, b] of PAIRS) {
      const p = placeLateral(a, b, TRUNK);
      for (const into of INTO) {
        const at = inBandFrame(cubicAt(cubicOf(lateralLanePath(a, b, p, into)), 0.5), p);
        expect(at.x).toBeCloseTo(0, 9);
        expect(at.y).toBeCloseTo(lateralLaneY(into, LATERAL_LANE_OFFSET), 9);
      }
    }
  });

  it("keeps each line within a tenth of a unit of its lane wherever a particle is visible", () => {
    // A translated cubic is not a parallel curve. Measured rather than
    // argued: every visible point of the line — past the dark stretch at each
    // end — against the nearest point of the arch itself.
    for (const [a, b] of PAIRS) {
      const p = placeLateral(a, b, TRUNK);
      const arch = Array.from({ length: 4001 }, (_, i) => lateralPointAt(a, b, p, i / 4000));
      const length = lateralArcLength(a, b, p);
      for (const into of INTO) {
        const line = cubicOf(lateralLanePath(a, b, p, into));
        let travelled = 0;
        let prev = cubicAt(line, 0);
        for (let i = 1; i <= 800; i += 1) {
          const here = cubicAt(line, i / 800);
          travelled += Math.hypot(here.x - prev.x, here.y - prev.y);
          prev = here;
          if (travelled < LATERAL_FLOW.clear || travelled > length - LATERAL_FLOW.clear) continue;
          const nearest = Math.min(...arch.map((q) => Math.hypot(q.x - here.x, q.y - here.y)));
          expect(Math.abs(nearest - LATERAL_LANE_OFFSET)).toBeLessThan(0.1);
        }
      }
    }
  });

  it("measures the arch it is timed along", () => {
    for (const [a, b] of PAIRS) {
      const p = placeLateral(a, b, TRUNK);
      const length = lateralArcLength(a, b, p);
      // A denser walk than the module's own agrees with it to a hundredth.
      let fine = 0;
      let prev = a;
      for (let i = 1; i <= 20000; i += 1) {
        const here = lateralPointAt(a, b, p, i / 20000);
        fine += Math.hypot(here.x - prev.x, here.y - prev.y);
        prev = here;
      }
      expect(length).toBeCloseTo(fine, 2);
      // And the share-to-`t` lookup walks the same measure: half the length is
      // the apex, because the arch is symmetric about it.
      expect(lateralTAtShare(a, b, p, 0.5)).toBeCloseTo(0.5, 6);
    }
  });

  it("times a particle by the distance it has travelled, dark under both nodes", () => {
    for (const length of [69, 120, 293.7, 1000, 4000]) {
      const timing = lateralFlowTiming(length)!;
      expect(timing).not.toBeNull();
      expect(timing.dur).toBeCloseTo(length / LATERAL_FLOW.speed, 3);
      const { keyTimes, values } = timing;
      expect(keyTimes[0]).toBe(0);
      expect(keyTimes[keyTimes.length - 1]).toBe(1);
      for (let i = 1; i < keyTimes.length; i += 1) {
        expect(keyTimes[i]).toBeGreaterThan(keyTimes[i - 1]);
      }
      expect(values).toHaveLength(keyTimes.length);
      // Dark for at least `clear` units at each end — never less, whatever
      // the rounding — and lit in the middle.
      const darkUntil = keyTimes[values.findIndex((v) => v > 0) - 1];
      const darkFrom = keyTimes[values.lastIndexOf(LATERAL_FLOW.peak) + 1];
      expect(darkUntil * length).toBeGreaterThanOrEqual(LATERAL_FLOW.clear);
      expect((1 - darkFrom) * length).toBeGreaterThanOrEqual(LATERAL_FLOW.clear - 1e-9);
      expect(Math.max(...values)).toBe(LATERAL_FLOW.peak);
      // The same both ways: a particle is timed by distance from where it
      // set out, so the keyframes read the same from either end.
      for (let i = 0; i < keyTimes.length; i += 1) {
        expect(keyTimes[i] + keyTimes[keyTimes.length - 1 - i]).toBeCloseTo(1, 4);
        expect(values[i]).toBe(values[values.length - 1 - i]);
      }
    }
  });

  it("spaces each direction's particles evenly, the two directions out of step", () => {
    const timing = lateralFlowTiming(300)!;
    const spacing = timing.dur / LATERAL_FLOW.count;
    for (const into of INTO) {
      const begins = timing.begins[into];
      expect(begins).toHaveLength(LATERAL_FLOW.count);
      for (const begin of begins) {
        expect(begin).toBeLessThanOrEqual(0);
        expect(begin).toBeGreaterThan(-timing.dur);
      }
      for (let i = 1; i < begins.length; i += 1) {
        expect(begins[i - 1] - begins[i]).toBeCloseTo(spacing, 2);
      }
    }
    // Half a spacing apart, so two opposing particles are never launched as a pair.
    expect(timing.begins.b[0] - timing.begins.a[0]).toBeCloseTo(spacing / 2, 2);
  });

  it("carries no particle on an arch too short to show one", () => {
    const shortest = 2 * (LATERAL_FLOW.clear + LATERAL_FLOW.ramp);
    expect(lateralFlowTiming(shortest)).toBeNull();
    expect(lateralFlowTiming(0)).toBeNull();
    expect(lateralFlowTiming(Number.NaN)).toBeNull();
    expect(lateralFlowTiming(shortest + 1)).not.toBeNull();
  });

  it("points each arch arrowhead into the side it names, from that side's lane", () => {
    for (const [a, b] of PAIRS) {
      const p = placeLateral(a, b, TRUNK);
      const length = lateralArcLength(a, b, p);
      for (const into of INTO) {
        const target = into === "a" ? a : b;
        const arrow = lateralArchArrow(a, b, p, into);
        const back = {
          x: (arrow.wings[0].x + arrow.wings[1].x) / 2,
          y: (arrow.wings[0].y + arrow.wings[1].y) / 2,
        };
        const centre = { x: (arrow.tip.x + back.x) / 2, y: (arrow.tip.y + back.y) / 2 };
        const share = into === "a" ? LATERAL_ARCH_ARROW.at : 1 - LATERAL_ARCH_ARROW.at;
        const t = lateralTAtShare(a, b, p, share);
        // It sits on its own lane's line, at the point that line reaches at `t`…
        const onLine = cubicAt(cubicOf(lateralLanePath(a, b, p, into)), t);
        expect(centre.x).toBeCloseTo(onLine.x, 9);
        expect(centre.y).toBeCloseTo(onLine.y, 9);
        // …a quarter of the arch's length in from the side it points at…
        let walked = 0;
        let prev = a;
        for (let i = 1; i <= 4000; i += 1) {
          const tt = (i / 4000) * t;
          const here = lateralPointAt(a, b, p, tt);
          walked += Math.hypot(here.x - prev.x, here.y - prev.y);
          prev = here;
        }
        expect(walked / length).toBeCloseTo(share, 2);
        // …and pointing along the arch, into that side.
        const along = lateralTangentAt(a, b, p, t);
        const toward = into === "b" ? along : { x: -along.x, y: -along.y };
        const pointing = { x: arrow.tip.x - back.x, y: arrow.tip.y - back.y };
        const cos =
          (pointing.x * toward.x + pointing.y * toward.y) / Math.hypot(pointing.x, pointing.y);
        expect(cos).toBeCloseTo(1, 9);
        // Nearer the side it names at the tip than at the back.
        expect(Math.hypot(target.x - arrow.tip.x, target.y - arrow.tip.y)).toBeLessThan(
          Math.hypot(target.x - back.x, target.y - back.y),
        );
      }
    }
  });
});
