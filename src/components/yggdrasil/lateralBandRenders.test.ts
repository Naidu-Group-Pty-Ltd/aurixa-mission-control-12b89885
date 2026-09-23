/**
 * THE LATERAL BAND IS ASKED WHERE, AND WHICH WAY, IT ACTUALLY DRAWS.
 *
 * `membraneBandRenders.test.ts` records why this directory renders a band
 * through the real library instead of reading its source: framer-motion moves
 * a `transform` attribute off any animated SVG element, and the band that
 * shipped that way drew at the origin while its source read exactly as
 * intended. The lateral band is the same construction, so it is asked the
 * same questions — and the ones only it can get wrong, because it is crossed
 * both ways: which way each lane runs on the SCREEN, whether the drawing says
 * each direction's rule rather than one of them twice, and whether what
 * crosses is drawn crossing — each way, on its own lane, through an opening
 * rather than through a plug.
 *
 * Every expectation below is read off the lateral registry or off the markup,
 * never typed in: the counts are the registry's channels, the lane positions
 * are the pure module's layout, the flow is the pure module's timing, and the
 * screen direction is the markup's own transform applied to the markup's own
 * arrowheads.
 */

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LateralBand } from "./lateral-band";
import {
  LATERAL_FLOW,
  LATERAL_LANE_OFFSET,
  LATERAL_PASSAGE_HALF,
  LATERAL_PORE_HALF,
  lateralArcLength,
  lateralArchArrow,
  lateralFlowTiming,
  lateralLanePath,
  lateralLaneY,
  lateralLayout,
  lateralPores,
  placeLateral,
  type LaneState,
  type LateralInto,
  type Point,
} from "./lateralBand.pure";
import {
  CRM_DEPENDENT_PARENT,
  CRM_INDEPENDENT_PARENT,
  FLEET_LATERALS,
  type LateralBoundary,
} from "@/lib/cascade/membrane/lateralMembranes.pure";
import type { IonChannel, Membrane } from "@/lib/cascade/membrane/membrane.pure";

/**
 * What the reader's system says about motion. Null is what framer-motion
 * answers on a server, where nobody has said anything; a test that needs
 * another answer sets it and puts it back.
 */
const motionPreference = vi.hoisted(() => ({ reduce: null as boolean | null }));
vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => motionPreference.reduce };
});

const BOUNDARY = FLEET_LATERALS[0];
const [SIDE_A, SIDE_B] = BOUNDARY.sides;
const LEFT = { x: 560, y: 200 };
const RIGHT = { x: 840, y: 200 };
const TRUNK = { x: 700, y: 80 };

function draw({
  boundary = BOUNDARY,
  a = LEFT,
  b = RIGHT,
  selected = false,
}: { boundary?: LateralBoundary; a?: Point; b?: Point; selected?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(
      "svg",
      null,
      createElement(LateralBand, {
        boundary,
        a,
        b,
        toward: TRUNK,
        index: 0,
        selected,
        onSelect: () => {},
      }),
    ),
  );
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** The band's own markup, after the element that places it. */
function bandOf(html: string): string {
  const at = html.indexOf("translate(");
  expect(at).toBeGreaterThan(-1);
  return html.slice(at);
}

/** The arch's markup — the arch, its arrowheads and its flow — which comes before the band. */
function archOf(html: string): string {
  const at = html.indexOf("translate(");
  expect(at).toBeGreaterThan(-1);
  return html.slice(0, at);
}

/** The markup's transform, as a function from the band's frame to the page. */
function screenOf(html: string): (lx: number, ly: number) => Point {
  const m = html.match(/transform="translate\(([-\d.e]+) ([-\d.e]+)\) rotate\(([-\d.e]+)\)"/);
  expect(m).not.toBeNull();
  const [cx, cy, deg] = m!.slice(1, 4).map(Number);
  const cos = Math.cos((deg * Math.PI) / 180);
  const sin = Math.sin((deg * Math.PI) / 180);
  return (lx, ly) => ({ x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos });
}

type Arrow = { d: string; tip: Point; back: Point; stroke: string | null };

/** Every arrowhead in a stretch of markup: `M wing L tip L wing`, drawn with round joins. */
function arrowsIn(markup: string): Arrow[] {
  return [
    ...markup.matchAll(
      /<path d="(M ([-\d.e]+) ([-\d.e]+) L ([-\d.e]+) ([-\d.e]+) L ([-\d.e]+) ([-\d.e]+))"([^>]*)>/g,
    ),
  ]
    .filter((m) => attr(m[8], "stroke-linejoin") === "round")
    .map((m) => ({
      d: m[1],
      back: { x: (Number(m[2]) + Number(m[6])) / 2, y: (Number(m[3]) + Number(m[7])) / 2 },
      tip: { x: Number(m[4]), y: Number(m[5]) },
      stroke: attr(m[8], "stroke"),
    }));
}

/** Every lane's arrowhead on the band, in the band's frame. */
function arrowsOf(html: string): Arrow[] {
  return arrowsIn(bandOf(html));
}

/** Each plug the band draws, and whether it is drawn solid. */
function plugsOf(html: string): Array<{ y: number; solid: boolean; dashed: boolean }> {
  return [...bandOf(html).matchAll(/<rect([^>]*)>/g)]
    .map((m) => m[1])
    .filter((t) => attr(t, "rx") === "0.8")
    .map((t) => ({
      y: Number(attr(t, "y")) + Number(attr(t, "height")) / 2,
      solid: attr(t, "fill") !== "none",
      dashed: attr(t, "stroke-dasharray") !== null,
    }));
}

type LaneReading = {
  /** The species the lane belongs to, or null for one of the passage's. */
  species: string | null;
  into: "a" | "b";
  state: LaneState | "passage";
};

/** The lane a y in the band's frame belongs to, by the pure module's layout. */
function laneAt(y: number, boundary = BOUNDARY): LaneReading {
  const pores = lateralPores(boundary);
  const { slots } = lateralLayout(pores.length);
  const rows: Array<{ at: number } & LaneReading> = [
    { at: lateralLaneY("b", LATERAL_LANE_OFFSET), species: null, into: "b", state: "passage" },
    { at: lateralLaneY("a", LATERAL_LANE_OFFSET), species: null, into: "a", state: "passage" },
  ];
  pores.forEach((pore, i) => {
    rows.push(
      {
        at: slots[i] + lateralLaneY("b", LATERAL_LANE_OFFSET),
        species: pore.species,
        into: "b",
        state: pore.intoB,
      },
      {
        at: slots[i] + lateralLaneY("a", LATERAL_LANE_OFFSET),
        species: pore.species,
        into: "a",
        state: pore.intoA,
      },
    );
  });
  const row = rows.find((r) => Math.abs(r.at - y) < 1e-6);
  if (!row) throw new Error(`no lane at y=${y}`);
  return { species: row.species, into: row.into, state: row.state };
}

/** What the registry itself says each direction does, channel by channel. */
function registryCounts(side: string) {
  const channels = BOUNDARY.toward[side]!.channels;
  // One channel per species each way, so a lane is a channel. Asserted here
  // because the counts below lean on it.
  expect(new Set(channels.map((c) => c.species)).size).toBe(channels.length);
  return {
    closed: channels.filter((c) => c.state === "closed").length,
    gated: channels.filter((c) => c.state === "gated").length,
    open: channels.filter((c) => c.state === "open").length,
  };
}

type Particle = { fill: string | null; motion: string; fade: string };

/** Every particle on the arch: a circle carrying an `animateMotion` and an opacity `animate`. */
function particlesOf(html: string): Particle[] {
  return [...archOf(html).matchAll(/<circle([^>]*)>([\s\S]*?)<\/circle>/g)].map((m) => ({
    fill: attr(m[1], "fill"),
    motion: m[2].match(/<animateMotion([^>]*)>/)?.[1] ?? "",
    fade: m[2].match(/<animate(\s[^>]*)>/)?.[1] ?? "",
  }));
}

describe("where the lateral band actually lands", () => {
  it("carries its own placement into the markup", () => {
    const { cx, cy, angle } = placeLateral(LEFT, RIGHT, TRUNK);
    expect(draw()).toContain(`transform="translate(${cx} ${cy}) rotate(${angle})"`);
  });

  it("never lets an animated transform sit on the element that is placed", () => {
    const placed = bandOf(draw());
    const openTag = placed.slice(0, placed.indexOf(">"));
    expect(openTag).not.toContain("style=");
    expect(openTag).not.toContain("transform:scale");
  });

  it("puts the animation on a DIFFERENT element from the placement", () => {
    const html = draw();
    const placedAt = html.indexOf("translate(");
    const scaledAt = html.indexOf("transform:scale");
    expect(scaledAt).toBeGreaterThan(html.indexOf(">", placedAt));
  });

  it("draws the arch it sits on, dashed, and never lets the arch or its flow take a click", () => {
    const arch = archOf(draw());
    const path = arch.match(/<path d="(M [^"]*C [^"]*)"([^>]*)>/);
    expect(path).not.toBeNull();
    expect(path![1]).toBe(placeLateral(LEFT, RIGHT, TRUNK).d);
    // Dashed: a lateral boundary is not a line of descent and must not read as one.
    expect(path![2]).toContain("stroke-dasharray");
    // A path the width of the diagram taking clicks would swallow the pan. The
    // arch, its arrowheads and its particles share one group that refuses
    // pointer events, and nothing inside it takes them back.
    const group = arch.indexOf('style="pointer-events:none"');
    expect(group).toBeGreaterThan(-1);
    expect(group).toBeLessThan(arch.indexOf(path![1]));
    expect(arch.match(/pointer-events:\s*\w+/g)).toEqual(["pointer-events:none"]);
    expect(arch.indexOf("<animateMotion")).toBeGreaterThan(group);
  });
});

describe("what the lateral band says about each direction", () => {
  it("plugs every closed lane solid and every gated one in outline, both ways", () => {
    const plugs = plugsOf(draw());
    const intoA = registryCounts(SIDE_A);
    const intoB = registryCounts(SIDE_B);
    expect(plugs.filter((p) => p.solid && !p.dashed)).toHaveLength(intoA.closed + intoB.closed);
    expect(plugs.filter((p) => !p.solid && p.dashed)).toHaveLength(intoA.gated + intoB.gated);
    // And each plug sits in a lane the registry says it should.
    for (const plug of plugs) {
      expect(laneAt(plug.y).state).toBe(plug.solid ? "closed" : "gated");
    }
  });

  it("draws an arrowhead on every lane that crosses, and on no other", () => {
    const lanes = arrowsOf(draw()).map((arrow) => laneAt(arrow.tip.y));
    const species = lanes.filter((lane) => lane.state !== "passage");
    expect(species).toHaveLength(registryCounts(SIDE_A).open + registryCounts(SIDE_B).open);
    for (const lane of species) expect(lane.state).toBe("open");
  });

  it("points each crossing lane at the parent it enters, on the screen", () => {
    // Asked of the page, not the band's frame: the markup's transform applied
    // to the markup's arrowheads. Drawn both ways round, because a lane that
    // pointed the right way only while `a` sat on the left would be the
    // defect a static reading of the component cannot see. The passage's
    // two lanes are asked with the rest.
    for (const [a, b] of [
      [LEFT, RIGHT],
      [RIGHT, LEFT],
    ] as const) {
      const html = draw({ a, b });
      const toScreen = screenOf(html);
      for (const arrow of arrowsOf(html)) {
        const target = laneAt(arrow.tip.y).into === "a" ? a : b;
        const tip = toScreen(arrow.tip.x, arrow.tip.y);
        const back = toScreen(arrow.back.x, arrow.back.y);
        const towardTarget =
          (tip.x - back.x) * (target.x - tip.x) + (tip.y - back.y) * (target.y - tip.y);
        expect(towardTarget).toBeGreaterThan(0);
      }
    }
  });

  it("runs the CRM line opposite ways across the boundary", () => {
    // The reason a pore carries two lanes, read off the drawing. A routed CRM
    // name crosses only toward the CRM-dependent parent, and the independent's
    // routing layer only toward the independent.
    expect([SIDE_A, SIDE_B]).toEqual([CRM_DEPENDENT_PARENT, CRM_INDEPENDENT_PARENT]);
    const crossings = arrowsOf(draw()).map((arrow) => laneAt(arrow.tip.y));
    expect(crossings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ species: "routed_crm_name", into: "a" }),
        expect.objectContaining({ species: "crm_routing_layer", into: "b" }),
      ]),
    );
    expect(crossings.some((c) => c.species === "routed_crm_name" && c.into === "b")).toBe(false);
    expect(crossings.some((c) => c.species === "crm_routing_layer" && c.into === "a")).toBe(false);
  });

  it("keeps the pores in the boundary's order whichever parent is drawn on the left", () => {
    // Turned upright rather than a half-turn, so the plugs land on the same
    // rows and only the arrowheads change sides.
    const ordered = (html: string) =>
      plugsOf(html)
        .map((p) => `${p.y.toFixed(3)}:${p.solid ? "solid" : "outline"}`)
        .sort();
    expect(ordered(draw({ a: RIGHT, b: LEFT }))).toEqual(ordered(draw()));
  });

  it("moves an ion along every open lane, from the far side toward its arrowhead", () => {
    const html = draw();
    const arrows = arrowsOf(html).filter((arrow) => laneAt(arrow.tip.y).state === "open");
    const ions = [...bandOf(html).matchAll(/<circle([^>]*)>/g)].map((m) => ({
      x: Number(attr(m[1], "cx")),
      y: Number(attr(m[1], "cy")),
      hollow: attr(m[1], "fill") === "none",
    }));
    expect(ions).toHaveLength(arrows.length);
    for (const ion of ions) {
      const arrow = arrows.find((a) => Math.abs(a.tip.y - ion.y) < 1e-6);
      expect(arrow).toBeDefined();
      // The opening frame: the far side of the bilayer from where it will leave.
      expect(Math.sign(ion.x)).toBe(-Math.sign(arrow!.tip.x));
      // An OPEN lane's ion is solid; hollow is reserved for what no rule speaks for.
      expect(ion.hollow).toBe(false);
    }
  });

  it("names the passage and both directions for a screen reader, with the registry's counts", () => {
    const label = draw().match(/role="button"[^>]*aria-label="([^"]*)"/)?.[1];
    expect(label).toBeDefined();
    expect(label!.startsWith(`${BOUNDARY.label}: parent-level work crosses both ways; `)).toBe(
      true,
    );
    for (const side of [SIDE_A, SIDE_B]) {
      const c = registryCounts(side);
      expect(label).toContain(`into ${side}: ${c.closed} closed, ${c.gated} held for a person`);
    }
  });

  it("can be reached from a keyboard", () => {
    // Operable, too — `onKeyDown` does not survive into static markup, so the
    // handler is pinned in `membraneIsDrawn.contract.test.ts`.
    expect(draw()).toMatch(/role="button"[^>]*tabindex="0"/);
  });

  it("draws a selection ring only when selected, round the whole band", () => {
    expect(draw({ selected: false })).not.toContain("oklch(0.78 0.16 200 / 0.10)");
    const ring = bandOf(draw({ selected: true })).match(
      /<rect([^>]*fill="oklch\(0\.78 0\.16 200 \/ 0\.10\)"[^>]*)>/,
    );
    expect(ring).not.toBeNull();
    // The band is not symmetric about the arch, so the ring is asked to
    // enclose its actual ends rather than a span either side of zero.
    const { top, bottom } = lateralLayout(lateralPores(BOUNDARY).length);
    const y = Number(attr(ring![1], "y"));
    const height = Number(attr(ring![1], "height"));
    expect(y).toBeLessThan(top);
    expect(y + height).toBeGreaterThan(bottom);
  });
});

describe("what crosses, crossing", () => {
  it("opens a passage on the arch, drawn crossing into each side and plugged in neither", () => {
    const html = draw();
    // The arch meets the band at the band's own zero; nothing there refuses.
    for (const plug of plugsOf(html)) {
      expect(Math.abs(plug.y)).toBeGreaterThan(LATERAL_PASSAGE_HALF);
    }
    const passage = arrowsOf(html).filter((arrow) => laneAt(arrow.tip.y).state === "passage");
    expect(passage.map((arrow) => laneAt(arrow.tip.y).into).sort()).toEqual(["a", "b"]);
    // Its traffic is the arch's own flow, so it carries no ion of its own.
    const ions = [...bandOf(html).matchAll(/<circle([^>]*)>/g)].map((m) =>
      Number(attr(m[1], "cy")),
    );
    expect(ions.every((y) => Math.abs(y) > LATERAL_PASSAGE_HALF)).toBe(true);
  });

  it("carries each direction's traffic along its own lane, into the side it names", () => {
    for (const [a, b] of [
      [LEFT, RIGHT],
      [RIGHT, LEFT],
    ] as const) {
      const html = draw({ a, b });
      const placement = placeLateral(a, b, TRUNK);
      const timing = lateralFlowTiming(lateralArcLength(a, b, placement))!;
      expect(timing).not.toBeNull();
      const particles = particlesOf(html);
      expect(particles).toHaveLength(2 * LATERAL_FLOW.count);
      for (const into of ["a", "b"] as LateralInto[]) {
        // The path runs from `a` to `b`, so a particle entering `b` walks it
        // forward and one entering `a` walks it back.
        const walking = into === "b" ? "0;1" : "1;0";
        const mine = particles.filter((p) => attr(p.motion, "keyPoints") === walking);
        expect(mine).toHaveLength(LATERAL_FLOW.count);
        expect(mine.map((p) => attr(p.motion, "begin"))).toEqual(
          timing.begins[into].map((begin) => `${begin}s`),
        );
        for (const p of mine) {
          expect(attr(p.motion, "path")).toBe(lateralLanePath(a, b, placement, into));
          expect(attr(p.motion, "keyTimes")).toBe("0;1");
          expect(attr(p.motion, "calcMode")).toBe("linear");
          expect(attr(p.motion, "repeatCount")).toBe("indefinite");
          expect(attr(p.motion, "dur")).toBe(`${timing.dur}s`);
          // The fade keeps time with the motion — same clock, same start — so
          // a particle is dark exactly where the timing says: under the nodes.
          expect(attr(p.fade, "attributeName")).toBe("opacity");
          expect(attr(p.fade, "values")).toBe(timing.values.join(";"));
          expect(attr(p.fade, "keyTimes")).toBe(timing.keyTimes.join(";"));
          expect(attr(p.fade, "dur")).toBe(attr(p.motion, "dur"));
          expect(attr(p.fade, "begin")).toBe(attr(p.motion, "begin"));
          expect(attr(p.fade, "repeatCount")).toBe("indefinite");
        }
      }
    }
  });

  it("points an arrowhead on the arch into each side, where the pure module puts it", () => {
    for (const [a, b] of [
      [LEFT, RIGHT],
      [RIGHT, LEFT],
    ] as const) {
      const html = draw({ a, b });
      const placement = placeLateral(a, b, TRUNK);
      const arrows = arrowsIn(archOf(html));
      expect(arrows.map((arrow) => arrow.d).sort()).toEqual(
        (["a", "b"] as LateralInto[])
          .map((into) => lateralArchArrow(a, b, placement, into).d)
          .sort(),
      );
      // Asked of the page as well: one points at each parent, and each at
      // one only.
      const pointsAt = (arrow: Arrow, node: Point) =>
        (arrow.tip.x - arrow.back.x) * (node.x - arrow.tip.x) +
          (arrow.tip.y - arrow.back.y) * (node.y - arrow.tip.y) >
        0;
      for (const arrow of arrows) expect(pointsAt(arrow, a)).not.toBe(pointsAt(arrow, b));
      expect(arrows.filter((arrow) => pointsAt(arrow, a))).toHaveLength(1);
    }
  });

  it("draws parent-level work in one ink of its own, never a channel's", () => {
    // The arrowheads on the arch, the passage's lanes and the particles are
    // one thing — what no channel names — and read as one. The open lane's
    // green says a CHANNEL opened a species; this must not borrow it.
    const html = draw();
    const particleInks = new Set(particlesOf(html).map((p) => p.fill));
    expect(particleInks.size).toBe(1);
    const [flow] = particleInks;
    const marks = [
      ...arrowsIn(archOf(html)),
      ...arrowsOf(html).filter((arrow) => laneAt(arrow.tip.y).state === "passage"),
    ];
    expect(marks).toHaveLength(4);
    for (const mark of marks) expect(mark.stroke).toBe(flow);
    const open = arrowsOf(html)
      .filter((arrow) => laneAt(arrow.tip.y).state === "open")
      .map((arrow) => arrow.stroke);
    expect(open.length).toBeGreaterThan(0);
    expect(open).not.toContain(flow);
  });

  it("stands still for a reader who asked for less motion, and still says both ways", () => {
    motionPreference.reduce = true;
    try {
      const html = draw();
      expect(html).not.toContain("<animateMotion");
      expect(html).not.toContain("<animate ");
      expect(particlesOf(html)).toHaveLength(0);
      // What the flow said, the arrowheads still say.
      expect(arrowsIn(archOf(html))).toHaveLength(2);
      expect(
        arrowsOf(html).filter((arrow) => laneAt(arrow.tip.y).state === "passage"),
      ).toHaveLength(2);
    } finally {
      motionPreference.reduce = null;
    }
    // And a reader who said nothing, or asked for motion, gets the flow.
    for (const reduce of [null, false]) {
      motionPreference.reduce = reduce;
      try {
        expect(particlesOf(draw())).toHaveLength(2 * LATERAL_FLOW.count);
      } finally {
        motionPreference.reduce = null;
      }
    }
  });

  it("carries no particle on an arch too short to show one", () => {
    // Two parents drawn almost on each other: nothing would be visible between
    // the nodes, so nothing is drawn — and the arrowheads still say both ways.
    const html = draw({ a: LEFT, b: { x: LEFT.x + 40, y: LEFT.y } });
    expect(particlesOf(html)).toHaveLength(0);
    expect(arrowsIn(archOf(html))).toHaveLength(2);
  });
});

describe("the lateral band's wall", () => {
  it("leaves leaflet between every two mouths, each stretch longer than the leaflet is thick", () => {
    // The ladder, asked of the drawing: with the mouths too close the
    // stretches between them shrink to their own round caps, and the wall the
    // pores are holes IN stops reading as a wall.
    const html = draw();
    const pores = lateralPores(BOUNDARY).length;
    const lines = [...bandOf(html).matchAll(/<line([^>]*)>/g)].map((m) => m[1]);
    const sides = new Map<string, Array<{ from: number; to: number; width: number }>>();
    for (const t of lines) {
      const x = attr(t, "x1")!;
      expect(attr(t, "x2")).toBe(x);
      const [y1, y2] = [Number(attr(t, "y1")), Number(attr(t, "y2"))];
      const run = {
        from: Math.min(y1, y2),
        to: Math.max(y1, y2),
        width: Number(attr(t, "stroke-width")),
      };
      sides.set(x, [...(sides.get(x) ?? []), run]);
    }
    expect(sides.size).toBe(2);
    for (const runs of sides.values()) {
      // One run more than there are mouths: the pores' and the passage's.
      expect(runs).toHaveLength(pores + 2);
      for (const run of runs) expect(run.to - run.from).toBeGreaterThan(run.width);
    }
  });

  it("frames every mouth, the passage's included, with a wall on each side of the bilayer", () => {
    // A gap in the leaflets alone reads as a break in the drawing; the walls
    // are what make it a mouth, and the passage is a mouth like any pore's.
    // Walls are drawn in the leaflet's ink, read off the leaflets themselves.
    const band = bandOf(draw());
    const leafletInk = new Set(
      [...band.matchAll(/<line([^>]*)>/g)].map((m) => attr(m[1], "stroke")),
    );
    expect(leafletInk.size).toBe(1);
    const [ink] = [...leafletInk];
    const walls = [...band.matchAll(/<path([^>]*)>/g)]
      .map((m) => m[1])
      .filter((t) => attr(t, "stroke") === ink)
      .map((t) => {
        const v = [...attr(t, "d")!.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
        expect(v).toHaveLength(6);
        return {
          side: Math.sign(v[2]),
          y: v[3],
          from: Math.min(v[1], v[5]),
          to: Math.max(v[1], v[5]),
        };
      });
    const { slots } = lateralLayout(lateralPores(BOUNDARY).length);
    const mouths: Array<[number, number]> = [
      ...slots.map((y): [number, number] => [y, LATERAL_PORE_HALF]),
      [0, LATERAL_PASSAGE_HALF],
    ];
    expect(walls).toHaveLength(2 * mouths.length);
    for (const [y, half] of mouths) {
      const framing = walls.filter((w) => w.y === y);
      expect(framing.map((w) => w.side).sort()).toEqual([-1, 1]);
      for (const w of framing) {
        // Inside the mouth, so a wall never meets the leaflet it interrupts.
        expect(w.from).toBeGreaterThan(y - half);
        expect(w.to).toBeLessThan(y + half);
      }
    }
  });

  it("puts no leaflet across any mouth, and none within reach of a particle in the passage", () => {
    const html = draw();
    const { slots } = lateralLayout(lateralPores(BOUNDARY).length);
    const mouths: Array<[number, number]> = [
      ...slots.map((y): [number, number] => [y, LATERAL_PORE_HALF]),
      [0, LATERAL_PASSAGE_HALF],
    ];
    for (const m of bandOf(html).matchAll(/<line([^>]*)>/g)) {
      const y1 = Number(attr(m[1], "y1"));
      const y2 = Number(attr(m[1], "y2"));
      for (const [y, half] of mouths) {
        expect(Math.max(y1, y2) <= y - half + 1e-9 || Math.min(y1, y2) >= y + half - 1e-9).toBe(
          true,
        );
      }
      // A leaflet's round cap reaches past its end by half its width; a
      // particle on either lane of the passage stays clear of even that.
      const cap = Number(attr(m[1], "stroke-width")) / 2;
      const reach = LATERAL_LANE_OFFSET + LATERAL_FLOW.r;
      expect(Math.max(y1, y2) + cap <= -reach || Math.min(y1, y2) - cap >= reach).toBe(true);
    }
  });
});

describe("a lane no rule speaks for", () => {
  // Not this fleet's shape — every species either way is declared both ways —
  // and exactly why it is drawn here: the first boundary that leaves one out
  // must not read as a boundary that opened it.
  const channel = (species: IonChannel["species"], state: IonChannel["state"]) =>
    ({ species, state, within: "**", reason: "protected", note: "" }) as IonChannel;
  const membrane = (from: string, to: string, channels: IonChannel[]): Membrane => ({
    from,
    to,
    label: `${from} → ${to}`,
    rationale: "",
    channels,
    standing: [],
  });
  const boundary: LateralBoundary = {
    id: "a~b",
    ledgerId: "00000000-0000-0000-0000-000000000000",
    sides: ["a", "b"],
    label: "a ⇄ b",
    rationale: "",
    toward: { a: membrane("b", "a", [channel("spec", "gated")]), b: membrane("a", "b", []) },
    standing: [],
  };

  it("crosses, in the leaflet's ink with a hollow ion — never drawn as open", () => {
    const html = draw({ boundary });
    const arrows = arrowsOf(html).filter(
      (arrow) => laneAt(arrow.tip.y, boundary).state !== "passage",
    );
    expect(arrows).toHaveLength(1);
    expect(laneAt(arrows[0].tip.y, boundary)).toEqual({
      species: "spec",
      into: "b",
      state: "undeclared",
    });
    const ions = [...bandOf(html).matchAll(/<circle([^>]*)>/g)].map((m) => m[1]);
    expect(ions).toHaveLength(1);
    expect(attr(ions[0], "fill")).toBe("none");
    // The open lane's ink is not borrowed: read off the fleet's own open
    // lanes, all of which share it, and absent here.
    const openInks = new Set(
      arrowsOf(draw())
        .filter((arrow) => laneAt(arrow.tip.y).state === "open")
        .map((arrow) => arrow.stroke),
    );
    expect(openInks.size).toBe(1);
    expect(openInks.has(arrows[0].stroke)).toBe(false);
  });

  it("is counted in the band's accessible name", () => {
    const label = draw({ boundary }).match(/role="button"[^>]*aria-label="([^"]*)"/)?.[1];
    expect(label).toContain("into b: 0 closed, 0 held for a person, 1 no rule speaks for");
    expect(label).toContain("into a: 0 closed, 1 held for a person");
    expect(label).not.toContain("into a: 0 closed, 1 held for a person, ");
  });

  it("still opens the passage: a boundary is crossed both ways whatever its channels", () => {
    const passage = arrowsOf(draw({ boundary })).filter(
      (arrow) => laneAt(arrow.tip.y, boundary).state === "passage",
    );
    expect(passage.map((arrow) => laneAt(arrow.tip.y, boundary).into).sort()).toEqual(["a", "b"]);
  });
});
