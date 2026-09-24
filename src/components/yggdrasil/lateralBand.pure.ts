/**
 * WHERE THE LATERAL MEMBRANE SITS, AND WHAT EACH OF ITS PORES SAYS.
 *
 * Every other membrane on the diagram sits ON a branch, because every other
 * boundary is a line of descent: the prime above, a deployment below. The
 * boundary between the two parents is not one. Neither is upstream of the
 * other, nothing joins them in the lineage, and so there is no branch to put
 * a band on. It gets an edge of its own — an ARCH from one parent's node to
 * the other's — and the band sits at its apex.
 *
 * ## The arch
 *
 * A cubic whose two control points are both the chord's ends pushed the same
 * distance along the chord's normal:
 *
 *   M a  C (a + h), (b + h), b          h = n · (4/3)·sag
 *
 * The (4/3) is not a style choice. At t = 0.5 a cubic evaluates to
 * (P0 + 3·P1 + 3·P2 + P3)/8, which here is the chord midpoint plus ¾·h — so
 * h = (4/3)·sag·n puts the curve's own midpoint exactly `sag` off the chord,
 * and the band drawn there sits ON the line rather than near it. The tangent
 * there is 1½·(b − a): parallel to the chord, whatever the sag, so the band
 * stands square across the arch without a curve solver.
 *
 * Square across it, and never upside down. Rotated to the chord's own
 * direction, a band whose parents the layout drew the other way round would
 * turn a half-turn and read its pores bottom to top — the same boundary,
 * reshuffled under whoever was reading it, because of where a sibling landed.
 * So the band is turned to whichever of the chord's two directions points
 * right, and `bSign` says which way along it `b` then lies. Each lane is
 * drawn by that sign, so it still runs into the side it names.
 *
 * It bows TOWARD THE TRUNK, and that is measured rather than preferred. The
 * parents' captions hang below their nodes and their own children descend
 * below those, so an arch bowed downward runs through the name of the parent
 * it leaves. Upward it passes under the trunk's label with the vertical
 * membranes either side of it. `membraneClearsLabels.test.ts` asks both of
 * the drawing rather than trusting this paragraph: the upward arch clears
 * every caption, node and vertical band at every corner of the layout's
 * jitter, and the downward one, drawn at the same corners, runs through a
 * parent's name. The recorded fleet alone does not show the second — its
 * parents happen to sit where a downward arch squeezes past — which is why
 * the corners are searched for rather than assumed.
 *
 * The sag is small and bounded. A deep arch lifts the band into the trunk's
 * label; a flat one reads as a lineage branch drawn sideways, which is the
 * one thing this edge must not be mistaken for.
 *
 * ## The passage
 *
 * What this boundary exists to carry is not a species. It is parent-level
 * work — a file the prime's history has never held — and most of it is
 * ordinary code no channel names: `permeate` refuses only on a closed
 * channel, so a file of no species crosses, either way, under the
 * destination's own standing filters. Drawn as a stack of pores alone, the
 * boundary said none of that. Five of its seven species are plugged both ways
 * — four closed, one gated — so the band read as a wall of plugs, the opposite
 * of what it does.
 *
 * So the band has an open PASSAGE at its centre, on the arch itself, with a
 * lane each way, and each direction's traffic flows along the arch and through
 * it. It is drawn unconditionally, and that is the data rather than a
 * decoration: every lateral boundary is crossed both ways (the lane runs a
 * pass into each side, every time), and a file no channel names is
 * `permeate`'s to admit on every membrane there is. The species pores split
 * around the passage — the first half above it, the rest below — so the arch
 * runs into neither a plug nor the wall.
 *
 * ## The pores
 *
 * One pore per ion species, not one per channel, and each pore carries TWO
 * lanes — because the boundary is crossed both ways and what may enter one
 * parent is not what may enter the other. The lateral registry declares the
 * CRM line twice, in opposite senses: a routed CRM name is closed into the
 * CRM-independent parent's browser layer and open into the dependent, and
 * the independent's routing layer is closed into the dependent and open the
 * other way. A single state per pore could not say that; a pore with a lane
 * each way says it without a word.
 *
 * A lane is the membrane INTO the side it moves toward, read straight off
 * `boundary.toward`. Where one direction declares several channels for a
 * species (different `within` globs), the lane shows the strictest of them —
 * the drawing never looks more permeable than the rule, and the panel prints
 * each glob. A species a direction does not declare at all is `undeclared`:
 * `permeate` refuses only on a closed channel, so it crosses, and the lane
 * says so rather than inventing a plug.
 *
 * ## One limit, stated
 *
 * The band sits at the midpoint between the two parents, which is clear on
 * the fleet as recorded: they are the prime's only direct children and so
 * lie side by side on one row. A clone recorded as a prime child and created
 * between them would be laid out BETWEEN them, under the band. That is
 * visible rather than silent — a node drawn through a band — and the
 * clearance test is where the day it happens gets noticed.
 *
 * ## The flow
 *
 * Each direction's traffic travels the arch moved across by its lane's offset,
 * so that at the apex it runs through that direction's lane of the passage:
 * the line INTO `b` on the band's upper side and the line INTO `a` on its
 * lower one, as the band's own frame reads them — the rows every pore's lanes
 * use. A translated cubic is not a true parallel curve: at its very ends,
 * where the arch leaves each node square to the chord, a lane line runs back
 * into the arch. That is under the node, where no particle is drawn. Wherever
 * one is visible the gap stays within a tenth of a unit of the lane's offset,
 * and at the one point that has to be exact, the passage, it is exact.
 *
 * A particle is hidden while it is under either node, because the node is
 * drawn over the arch and its glow is not opaque. The rest is timed along the
 * arch's LENGTH: `animateMotion` measures progress by distance, not by the
 * curve's parameter, and a fade keyed on `t` would switch a particle off in
 * the wrong place.
 *
 * Nothing here reads the DOM or a clock, so all of it is asserted without a
 * renderer.
 */

import type { IonChannel, Membrane } from "@/lib/cascade/membrane/membrane.pure";
import type { IonSpeciesName } from "@/lib/cascade/membrane/ionSpecies.pure";
import type { LateralBoundary } from "@/lib/cascade/membrane/lateralMembranes.pure";
import { leafletRunsAround } from "./membraneGeometry.pure";

export type Point = { x: number; y: number };

export type LateralPlacement = {
  /** The arch as an SVG path, from `a` to `b`. */
  d: string;
  /** Its control points, so the band can be asserted to sit on the drawn curve. */
  c1: Point;
  c2: Point;
  /** The arch's apex, where the band is centred. */
  cx: number;
  cy: number;
  /** Unit vector along the chord from `a` toward `b`. */
  tx: number;
  ty: number;
  /** Unit vector across the chord, on the trunk's side — the way the arch bows. */
  nx: number;
  ny: number;
  /**
   * Degrees, for an SVG `rotate(...)` that lines the band up with the arch at
   * its apex. Always in (−90, 90], so the band is never drawn upside down.
   */
  angle: number;
  /**
   * Which way along the band's own x axis `b` lies once it is turned upright:
   * +1 where `a` is drawn on the left, −1 where the layout drew `b` there. The
   * `into b` lane runs this way and the `into a` lane the other.
   */
  bSign: 1 | -1;
  /** How far the apex stands off the chord. */
  sag: number;
};

/** How far the arch bows, as a share of the chord, and the bounds on it. See the header. */
export const LATERAL_SAG = { ratio: 0.08, min: 10, max: 18 } as const;

export function placeLateral(a: Point, b: Point, toward: Point | null = null): LateralPlacement {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);

  // Two nodes drawn on one point have no chord. Left to right is the
  // diagram's reading order, and it keeps every later term finite.
  const tx = len === 0 ? 1 : dx / len;
  const ty = len === 0 ? 0 : dy / len;

  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;

  // Of the chord's two normals, the one on the trunk's side. With no trunk, or
  // a trunk ON the chord's own line, up the screen — the side the tree grows
  // from, and the side the captions are not on.
  let nx = ty;
  let ny = -tx;
  const side = toward ? (toward.x - mx) * nx + (toward.y - my) * ny : 0;
  if (side < 0 || (side === 0 && ny > 0)) {
    nx = -nx;
    ny = -ny;
  }

  const sag = Math.min(LATERAL_SAG.max, Math.max(LATERAL_SAG.min, LATERAL_SAG.ratio * len));
  const pull = (4 / 3) * sag;
  const c1 = { x: a.x + nx * pull, y: a.y + ny * pull };
  const c2 = { x: b.x + nx * pull, y: b.y + ny * pull };

  // Of the chord's two directions, the one pointing right — or, for a chord
  // straight up the screen, the one pointing down, which is what (−90, 90]
  // leaves at its closed end.
  const bSign: 1 | -1 = tx > 0 || (tx === 0 && ty > 0) ? 1 : -1;

  return {
    d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
    c1,
    c2,
    cx: mx + nx * sag,
    cy: my + ny * sag,
    tx,
    ty,
    nx,
    ny,
    angle: (Math.atan2(bSign * ty, bSign * tx) * 180) / Math.PI,
    bSign,
    sag,
  };
}

/** A point on the arch at `t`, evaluated from the same four points the path is drawn from. */
export function lateralPointAt(a: Point, b: Point, placement: LateralPlacement, t: number): Point {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * placement.c1.x + w2 * placement.c2.x + w3 * b.x,
    y: w0 * a.y + w1 * placement.c1.y + w2 * placement.c2.y + w3 * b.y,
  };
}

/** The unit tangent at `t`, pointing from `a` toward `b`. Up the screen where the curve has none. */
export function lateralTangentAt(
  a: Point,
  b: Point,
  placement: LateralPlacement,
  t: number,
): Point {
  const u = 1 - t;
  const { c1, c2 } = placement;
  const x = 3 * u * u * (c1.x - a.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (b.x - c2.x);
  const y = 3 * u * u * (c1.y - a.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (b.y - c2.y);
  const len = Math.hypot(x, y);
  return len === 0 ? { x: 0, y: -1 } : { x: x / len, y: y / len };
}

/** How finely the arch is walked to measure it: well under a unit a step on any screen's arch. */
const ARC_STEPS = 512;

/** The arch's length from `a` up to each of `ARC_STEPS + 1` evenly spaced values of `t`. */
function arcTable(a: Point, b: Point, placement: LateralPlacement): number[] {
  const table = [0];
  let prev = a;
  for (let i = 1; i <= ARC_STEPS; i += 1) {
    const next = lateralPointAt(a, b, placement, i / ARC_STEPS);
    table.push(table[i - 1] + Math.hypot(next.x - prev.x, next.y - prev.y));
    prev = next;
  }
  return table;
}

/** How long the arch is, measured along it. */
export function lateralArcLength(a: Point, b: Point, placement: LateralPlacement): number {
  return arcTable(a, b, placement)[ARC_STEPS];
}

/**
 * The `t` at which the arch has run `share` of its length from `a`.
 *
 * Needed because `t` is not distance. The arch leaves each node square to the
 * chord and turns over, so its parameter crowds at the ends: a quarter of `t`
 * is not a quarter of the way along, and it is distance a reader sees.
 */
export function lateralTAtShare(
  a: Point,
  b: Point,
  placement: LateralPlacement,
  share: number,
): number {
  const table = arcTable(a, b, placement);
  const total = table[ARC_STEPS];
  if (!(total > 0)) return Math.min(1, Math.max(0, share));
  const want = Math.min(1, Math.max(0, share)) * total;
  let lo = 0;
  let hi = ARC_STEPS;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < want) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  const within = span > 0 ? (want - table[lo]) / span : 0;
  return (lo + within) / ARC_STEPS;
}

// ─────────────────────────────────────────────────────────────────────────────
// The flow along the arch
// ─────────────────────────────────────────────────────────────────────────────

/** The side a direction delivers INTO. */
export type LateralInto = "a" | "b";

/**
 * Where a direction's lane sits on the band's own y axis: the pores draw the
 * lane into `b` above their centre line and the lane into `a` below it, and
 * the passage and the arch's flow keep the same rows.
 */
export function lateralLaneY(into: LateralInto, offset: number): number {
  return into === "b" ? -offset : offset;
}

/**
 * How far a direction's line is moved off the arch, in page coordinates:
 * its lane's row, carried along the band's own y axis. The band is turned by
 * `angle`, whose cosine and sine are `bSign·tx` and `bSign·ty`, so that axis
 * is (−bSign·ty, bSign·tx) on the page.
 */
export function lateralLaneShift(placement: LateralPlacement, into: LateralInto): Point {
  const row = lateralLaneY(into, LATERAL_LANE_OFFSET);
  return { x: -placement.bSign * placement.ty * row, y: placement.bSign * placement.tx * row };
}

/** A direction's line: the arch, moved across to its lane. Drawn from `a` to `b`, as the arch is. */
export function lateralLanePath(
  a: Point,
  b: Point,
  placement: LateralPlacement,
  into: LateralInto,
): string {
  const s = lateralLaneShift(placement, into);
  const { c1, c2 } = placement;
  return (
    `M ${a.x + s.x} ${a.y + s.y} ` +
    `C ${c1.x + s.x} ${c1.y + s.y}, ${c2.x + s.x} ${c2.y + s.y}, ${b.x + s.x} ${b.y + s.y}`
  );
}

/** The particles that carry each direction's traffic, and how they move. */
export const LATERAL_FLOW = {
  /** Units a second. Slow enough to read as a current rather than as traffic. */
  speed: 30,
  /** Particles each way, spaced evenly in time. */
  count: 3,
  r: 1.5,
  /**
   * How far from each end a particle stays hidden: past the largest radius a
   * clone's node is drawn at (14) and the glow drawn round it (6), with room
   * to spare.
   */
  clear: 24,
  /** Over how much of the arch a particle fades in, and out again. */
  ramp: 10,
  /** Full strength. Not 1: a particle is a mark in passing, not a node. */
  peak: 0.9,
} as const;

export type LateralFlowTiming = {
  /** Seconds to travel the arch end to end. */
  dur: number;
  /**
   * Each particle's `begin`, in seconds, per direction: negative, so every one
   * is already on its way. The two directions are half a spacing out of step,
   * so opposing particles pass one another rather than travelling in pairs.
   */
  begins: Record<LateralInto, number[]>;
  /**
   * The opacity's own keyframes, as shares of the journey. The same both ways:
   * the hidden stretch at each end is the same length, so a particle leaving
   * `b` is dark exactly as long as one leaving `a`.
   */
  keyTimes: number[];
  values: number[];
};

/**
 * How a particle crosses an arch `length` long, or null where nothing would
 * be visible between the two nodes — too short an arch to carry a particle
 * out from under one before it is under the other.
 */
export function lateralFlowTiming(length: number): LateralFlowTiming | null {
  const { speed, count, clear, ramp, peak } = LATERAL_FLOW;
  if (!(length > 2 * (clear + ramp))) return null;
  // Rounded because these are written into the markup as they are, and a
  // share printed to sixteen places is noise. Four places keep every
  // keyframe apart: the closest two are `ramp / length` apart, which rounds
  // to zero only on an arch longer than any screen.
  const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;
  const dur = round(length / speed, 3);
  // Rounded outward, so the dark stretch at each end is never shorter than `clear`.
  const hidden = Math.ceil((clear / length) * 1e4) / 1e4;
  const lit = round((clear + ramp) / length, 4);
  const spaced = (phase: number) =>
    Array.from({ length: count }, (_, i) => round(-((i + phase) * dur) / count, 3));
  return {
    dur,
    begins: { b: spaced(0), a: spaced(0.5) },
    keyTimes: [0, hidden, lit, round(1 - lit, 4), round(1 - hidden, 4), 1],
    values: [0, 0, peak, peak, 0, 0],
  };
}

/**
 * Each direction's arrowhead on the arch: on its own lane, a quarter of the
 * arch's length in from the side it points at, pointing into that side.
 *
 * The flow says the same thing, but the flow moves and a screenshot does not,
 * and a reader who asked for less motion sees none of it. The arrowheads say
 * it standing still: this edge is crossed, and both ways.
 */
export const LATERAL_ARCH_ARROW = { at: 0.25, depth: 3.2, half: 2 } as const;

export function lateralArchArrow(
  a: Point,
  b: Point,
  placement: LateralPlacement,
  into: LateralInto,
): { tip: Point; wings: [Point, Point]; d: string } {
  const share = into === "a" ? LATERAL_ARCH_ARROW.at : 1 - LATERAL_ARCH_ARROW.at;
  const t = lateralTAtShare(a, b, placement, share);
  const on = lateralPointAt(a, b, placement, t);
  const shift = lateralLaneShift(placement, into);
  const centre = { x: on.x + shift.x, y: on.y + shift.y };
  const along = lateralTangentAt(a, b, placement, t);
  const sign = into === "b" ? 1 : -1;
  const dir = { x: sign * along.x, y: sign * along.y };
  const across = { x: -dir.y, y: dir.x };
  const { depth, half } = LATERAL_ARCH_ARROW;
  const tip = { x: centre.x + (dir.x * depth) / 2, y: centre.y + (dir.y * depth) / 2 };
  const back = { x: centre.x - (dir.x * depth) / 2, y: centre.y - (dir.y * depth) / 2 };
  const wings: [Point, Point] = [
    { x: back.x + across.x * half, y: back.y + across.y * half },
    { x: back.x - across.x * half, y: back.y - across.y * half },
  ];
  return {
    tip,
    wings,
    d: `M ${wings[0].x} ${wings[0].y} L ${tip.x} ${tip.y} L ${wings[1].x} ${wings[1].y}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The band's own dimensions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Centre to centre, between two pores.
 *
 * Wider than two mouths by a clear stretch of leaflet, and that stretch is the
 * point: at ten units the mouths of seven pores touched end to end, and the
 * bilayer — the wall the pores are holes IN — vanished from everywhere but its
 * two tips. A membrane drawn as a stack of holes reads as a ladder.
 */
export const LATERAL_PORE_SPACING = 12;
/** How far a pore's mouth reaches either side of its slot. */
export const LATERAL_PORE_HALF = 4.5;
/** How far each lane sits from its pore's centre line. */
export const LATERAL_LANE_OFFSET = 2.2;
/** A plug's side. Two of them, one per lane, fit inside one mouth with a gap between. */
export const LATERAL_PLUG = 3.4;
/** How far a pore's walls reach from its centre line: inside the mouth, so they never touch a leaflet. */
export const LATERAL_WALL_HALF = LATERAL_PORE_HALF - 0.8;
/**
 * How far the passage's mouth reaches either side of the arch. Wider than a
 * pore's, because it is the one opening both directions' traffic flows
 * through rather than a rule about one kind of file — and wide enough that a
 * particle on either lane passes it without touching a leaflet.
 */
export const LATERAL_PASSAGE_HALF = 6;
/** How far the passage's walls reach: inside its mouth, as a pore's are inside its own. */
export const LATERAL_PASSAGE_WALL_HALF = LATERAL_PASSAGE_HALF - 0.8;
/** Where a lane's arrowhead sits along the band's x axis, beyond the pore's outer wall. */
export const LATERAL_ARROW_AT = 8.2;
/** Clear leaflet beyond the outermost pore, so the band reads as a wall with holes in it. */
const LATERAL_END_MARGIN = 3;
/** The leaflet left between two neighbouring mouths — the stretch that keeps the band a wall. */
const LATERAL_STRETCH = LATERAL_PORE_SPACING - 2 * LATERAL_PORE_HALF;

export type LateralBandLayout = {
  /** Each species pore's centre along the band, in the boundary's order, top to bottom. */
  slots: number[];
  /**
   * The band's two ends, along its own y axis. Not symmetric: the passage
   * sits on the arch and the pores split around it, the extra one of an odd
   * count going below — away from the trunk's label, toward the open chord.
   */
  top: number;
  bottom: number;
  /** The stretches of leaflet: everything between the ends that is not a mouth. */
  runs: Array<[number, number]>;
};

/**
 * Where everything on the band sits, for `pores` species pores and the
 * passage between them.
 *
 * The passage is at zero — on the arch — and the pores step away from it
 * each way at the vertical band's own rhythm: a mouth, a stretch of leaflet,
 * a mouth. The band grows with the registry rather than crowding it.
 */
export function lateralLayout(pores: number): LateralBandLayout {
  const count = Math.max(0, Math.floor(pores));
  const above = Math.floor(count / 2);
  const below = count - above;
  const first = LATERAL_PASSAGE_HALF + LATERAL_STRETCH + LATERAL_PORE_HALF;

  const slots: number[] = [];
  for (let i = 0; i < above; i += 1) {
    slots.push(-(first + (above - 1 - i) * LATERAL_PORE_SPACING));
  }
  for (let j = 0; j < below; j += 1) slots.push(first + j * LATERAL_PORE_SPACING);

  const top =
    (above > 0 ? slots[0] - LATERAL_PORE_HALF : -LATERAL_PASSAGE_HALF) - LATERAL_END_MARGIN;
  const bottom =
    (below > 0 ? slots[count - 1] + LATERAL_PORE_HALF : LATERAL_PASSAGE_HALF) + LATERAL_END_MARGIN;

  // The vertical band's rule for where a leaflet stops, given every mouth in
  // order — the passage's included, at its own size.
  const runs = leafletRunsAround(
    [
      ...slots.slice(0, above).map((y) => [y, LATERAL_PORE_HALF] as const),
      [0, LATERAL_PASSAGE_HALF] as const,
      ...slots.slice(above).map((y) => [y, LATERAL_PORE_HALF] as const),
    ],
    top,
    bottom,
  );

  return { slots, top, bottom, runs };
}

// ─────────────────────────────────────────────────────────────────────────────
// What each pore says
// ─────────────────────────────────────────────────────────────────────────────

/** A lane's state: a channel's, or `undeclared` where the direction has no channel for the species. */
export type LaneState = IonChannel["state"] | "undeclared";

export type LateralPore = {
  species: IonSpeciesName;
  /** What a delivery INTO `boundary.sides[0]` meets for this species. */
  intoA: LaneState;
  /** What a delivery INTO `boundary.sides[1]` meets for this species. */
  intoB: LaneState;
};

const STRICTNESS: Record<IonChannel["state"], number> = { open: 0, gated: 1, closed: 2 };

function laneState(membrane: Membrane | undefined, species: IonSpeciesName): LaneState {
  let state: LaneState = "undeclared";
  for (const channel of membrane?.channels ?? []) {
    if (channel.species !== species) continue;
    if (state === "undeclared" || STRICTNESS[channel.state] > STRICTNESS[state]) {
      state = channel.state;
    }
  }
  return state;
}

/**
 * One pore per species either direction declares, in the order the membrane
 * into `sides[1]` declares them and then any only the other direction names.
 *
 * The order is the boundary's, not the screen's: it does not depend on which
 * parent the layout happens to draw on the left, so a re-layout never
 * reshuffles the pores under an operator who is reading them.
 */
export function lateralPores(boundary: LateralBoundary): LateralPore[] {
  const [a, b] = boundary.sides;
  const intoA = boundary.toward[a];
  const intoB = boundary.toward[b];

  const order: IonSpeciesName[] = [];
  for (const membrane of [intoB, intoA]) {
    for (const channel of membrane?.channels ?? []) {
      if (!order.includes(channel.species)) order.push(channel.species);
    }
  }
  return order.map((species) => ({
    species,
    intoA: laneState(intoA, species),
    intoB: laneState(intoB, species),
  }));
}

/**
 * How many lanes INTO a side refuse, how many wait on a person, and how many
 * no rule speaks for. For the band's accessible name, which has to carry what
 * the drawing carries — a hollow ion is a distinction a screen reader would
 * otherwise never hear.
 */
export function laneCounts(
  pores: readonly LateralPore[],
  into: "intoA" | "intoB",
): { closed: number; gated: number; undeclared: number } {
  let closed = 0;
  let gated = 0;
  let undeclared = 0;
  for (const pore of pores) {
    if (pore[into] === "closed") closed += 1;
    else if (pore[into] === "gated") gated += 1;
    else if (pore[into] === "undeclared") undeclared += 1;
  }
  return { closed, gated, undeclared };
}
