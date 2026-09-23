/**
 * THE BAND AND THE LABELS ARE MEASURED AGAINST EACH OTHER, ON THE REAL FLEET.
 *
 * A membrane is drawn at a branch's midpoint and a node's captions hang below
 * the node. Nothing in either module knows about the other, so whether they
 * collide is a property of the LAYOUT — and the layout is a hash-jittered
 * function of the clone ids, which no amount of reading either component can
 * settle. It has to be computed.
 *
 * It was not, and an adversarial review rendering the real tree found the
 * parent's status caption covering both depth-2 bands: the pump badge of one
 * and a painted leaflet of the other. The caption read `BEHIND · 12 BEHIND`,
 * saying it twice, and the second word was most of the width that reached.
 *
 * NOTHING HERE IS RESTATED. The label boxes are parsed out of a real
 * `TreeNodeCircle` render, the band's ink out of a real `MembraneBand`
 * render, and the positions out of `useTreeLayout` itself. The one estimate
 * is the monospace advance, which is bounded rather than assumed: the check
 * runs at 0.55, 0.60 and 0.65 em, and `var(--font-mono)` cannot be outside
 * that. Restating any of the rest would make this a statement about the
 * fixture, which is the failure this whole directory keeps paying for.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MembraneBand } from "./membrane-band";
import { LateralBand } from "./lateral-band";
import { TreeNodeCircle } from "./tree-node";
import { placeMembrane } from "./membraneGeometry.pure";
import { LATERAL_FLOW, lateralPointAt, placeLateral } from "./lateralBand.pure";
import { useTreeLayout, type TreeBranch, type TreeLateral, type TreeNode } from "./use-tree-layout";
import { membraneInto } from "@/lib/cascade/membrane/fleetMembranes.pure";
import { stripComments } from "@/server/sourceComments.pure";
import type { Clone } from "@/lib/queries";

/** The fleet as `cloneLineage.test.ts` records it, with the fields the drawing reads. */
function clone(id: string, name: string, parent: string | null, created: string): Clone {
  return {
    id,
    name,
    slug: id,
    parent_clone_id: parent,
    created_at: created,
    tags: [],
    sync_status: "behind",
    commits_behind: 12,
    github_repo: name,
    github_owner: "naidu-group-pty-ltd",
  } as unknown as Clone;
}

const FLEET: Clone[] = [
  clone("client-dashboard", "npc-client-dashboard", null, "2026-04-01T00:00:00Z"),
  clone("crm-independent", "npc-crm-independent-6505dc", null, "2026-09-19T00:00:00Z"),
  clone("preflight", "preflight-property-group", "client-dashboard", "2026-06-01T00:00:00Z"),
  clone("npc-test", "npc-test-76b3b3", "client-dashboard", "2026-07-01T00:00:00Z"),
];

type FleetLayout = {
  nodes: TreeNode[];
  branches: TreeBranch[];
  laterals: TreeLateral[];
  trunk: TreeNode | null;
};

/** `useTreeLayout` is a hook, so it is read through a render rather than called. */
function layoutOf(fleet: Clone[], width = 1400, height = 900): FleetLayout {
  // Collected through an array rather than a `let`: assigning to a captured
  // binding inside a component leaves TypeScript narrowing it to `never` at
  // the read below, and the suite passes while `tsc` does not.
  const caught: FleetLayout[] = [];
  function Probe() {
    const l = useTreeLayout(fleet, width, height);
    caught.push({ nodes: l.nodes, branches: l.branches, laterals: l.laterals, trunk: l.trunkNode });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const captured = caught[0];
  if (!captured) throw new Error("useTreeLayout drew nothing for the recorded fleet");
  return captured;
}

function layoutOfFleet(): FleetLayout {
  return layoutOf(FLEET);
}

const NODE_SRC = readFileSync("src/components/yggdrasil/tree-node.tsx", "utf8");
/** Prose mentions `attrY` too, so the count below reads code alone. */
const NODE_CODE = stripComments(NODE_SRC);

/**
 * How far the name caption travels on entry.
 *
 * `renderToStaticMarkup` gives the OPENING frame of an animation, so the `y`
 * in the markup is where the caption starts, not where it rests — eight units
 * low, which is enough to put it through a band it clears once settled. The
 * band has no such offset: its placement is on a plain `<g>` precisely so
 * motion cannot touch it, so its markup IS its settled position.
 *
 * A transient crossing during a half-second entrance, while both are still
 * fading in, is not what a reader looks at. This measures the rest state, and
 * reads the travel from the component rather than restating it.
 */
const ENTRY_TRAVEL = (() => {
  const from = NODE_SRC.match(/initial=\{\{ opacity: 0, attrY: node\.y \+ radius \+ (\d+) \}\}/);
  const to = NODE_SRC.match(/animate=\{\{ opacity: 1, attrY: node\.y \+ radius \+ (\d+) \}\}/);
  if (!from || !to)
    throw new Error("tree-node.tsx no longer states its caption travel as literals");
  return Number(from[1]) - Number(to[1]);
})();

type Box = { who: string; x0: number; x1: number; y0: number; y1: number; text: string };

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** Every caption a node draws, as a box, read off its own markup. */
function labelBoxes(node: TreeNode, advance: number): Box[] {
  const html = renderToStaticMarkup(createElement(TreeNodeCircle, { node, index: 0 }));
  const boxes: Box[] = [];
  // Only the first caption animates its baseline; the rest are opacity alone,
  // so only the first needs the travel taken off. Asserted, not assumed.
  expect(NODE_CODE.split("attrY").length - 1).toBe(2);
  let first = true;
  for (const m of html.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const tag = m[1];
    const text = m[2];
    const x = Number(attr(tag, "x"));
    const y = Number(attr(tag, "y")) - (first ? ENTRY_TRAVEL : 0);
    first = false;
    const size = Number(attr(tag, "font-size"));
    const spacing = Number((attr(tag, "letter-spacing") ?? "0em").replace("em", ""));
    // A transform here would mean the caption is not where its `y` says it
    // is, which is its own defect and asserted in membraneBandRenders.test.ts.
    expect(tag).not.toMatch(/transform:\s*translate/);
    const width = text.length * size * (advance + spacing);
    boxes.push({
      who: `${node.id}:${text}`,
      text,
      x0: x - width / 2,
      x1: x + width / 2,
      y0: y - size * 0.75,
      y1: y + size * 0.25,
    });
  }
  return boxes;
}

/** Every mark a band paints, in page coordinates, read off its own markup. */
function bandInk(branch: TreeBranch): Array<{ x: number; y: number }> {
  const membrane = membraneInto(branch.toRepo ?? "", branch.fromRepo ?? "");
  const html = renderToStaticMarkup(
    createElement(
      "svg",
      null,
      createElement(MembraneBand, {
        branch,
        membrane,
        index: 0,
        selected: false,
        onSelect: () => {},
      }),
    ),
  );
  const { cx, cy, tx, ty, nx, ny } = placeMembrane(branch);
  const toPage = (lx: number, ly: number) => ({
    x: cx + lx * tx + ly * nx,
    y: cy + lx * ty + ly * ny,
  });

  const points: Array<{ x: number; y: number }> = [];
  for (const m of html.matchAll(/<line([^>]*)\/?>/g)) {
    const t = m[1];
    const x1 = Number(attr(t, "x1"));
    const y1 = Number(attr(t, "y1"));
    const x2 = Number(attr(t, "x2"));
    const y2 = Number(attr(t, "y2"));
    if ([x1, y1, x2, y2].some(Number.isNaN)) continue;
    for (let i = 0; i <= 40; i += 1) {
      const u = i / 40;
      points.push(toPage(x1 + (x2 - x1) * u, y1 + (y2 - y1) * u));
    }
  }
  // The pump badge sits in a nested translate; take its rim, which is what reaches.
  for (const m of html.matchAll(/<g transform="translate\(0 ([-\d.]+)\)">/g)) {
    const ly = Number(m[1]);
    for (let a = 0; a < 16; a += 1) {
      const th = (a / 16) * Math.PI * 2;
      points.push(toPage(5.4 * Math.cos(th), ly + 5.4 * Math.sin(th)));
    }
  }
  return points;
}

describe("a membrane band clears the captions around it", () => {
  const { nodes, branches } = layoutOfFleet();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  it("draws the fleet the lineage records", () => {
    expect(branches).toHaveLength(4);
    expect(nodes.map((n) => n.id).sort()).toEqual(
      ["__trunk__", "client-dashboard", "crm-independent", "npc-test", "preflight"].sort(),
    );
  });

  // 0.65 is the generous end: a wider advance makes every caption wider and
  // is therefore the hardest case for clearance.
  it.each([0.55, 0.6, 0.65])("puts no band ink inside a caption at %s em advance", (advance) => {
    const collisions: string[] = [];
    for (const branch of branches) {
      const ink = bandInk(branch);
      for (const id of [branch.fromId, branch.toId]) {
        const node = id ? byId.get(id) : undefined;
        if (!node) continue;
        for (const box of labelBoxes(node, advance)) {
          const hit = ink.find(
            (p) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1,
          );
          if (hit) {
            collisions.push(
              `${branch.fromId}->${branch.toId} ink at (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}) inside "${box.text}"`,
            );
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("says a status only once, which is most of why it clears", () => {
    const node = byId.get("client-dashboard")!;
    const status = labelBoxes(node, 0.6).find(
      (b) => /behind/i.test(b.text) && b.text.includes("·"),
    );
    expect(status).toBeDefined();
    // `behind · 12 behind` was the caption that reached both depth-2 bands.
    expect(status!.text.toLowerCase().match(/behind/g)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The lateral band, measured the same way
// ─────────────────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };

const nums = (text: string) =>
  [...text.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)].map((m) => Number(m[0]));

/** The lateral as the diagram draws it. Every reading of its ink below is taken from this markup. */
function drawLateral(lateral: TreeLateral, trunk: Pt | null): string {
  return renderToStaticMarkup(
    createElement(
      "svg",
      null,
      createElement(LateralBand, {
        boundary: lateral.boundary,
        a: lateral.a,
        b: lateral.b,
        toward: trunk,
        index: 0,
        selected: false,
        onSelect: () => {},
      }),
    ),
  );
}

/**
 * Every mark the lateral BAND paints, in page coordinates, read off its own
 * markup — the leaflets, the pore walls, the arrowheads, the plugs and the
 * whole of each ion's travel, not just where the opening frame puts it.
 */
function lateralBandInk(html: string, lateral: TreeLateral, trunk: Pt | null): Pt[] {
  // The band's placement, read off the markup it shipped rather than
  // recomputed: `translate(cx cy) rotate(angle)`, applied to a point in the
  // band's own frame.
  const placed = html.match(/transform="translate\(([-\d.e]+) ([-\d.e]+)\) rotate\(([-\d.e]+)\)"/);
  expect(placed).not.toBeNull();
  const [cx, cy, angle] = placed!.slice(1, 4).map(Number);
  const expected = placeLateral(lateral.a, lateral.b, trunk);
  expect([cx, cy, angle]).toEqual([expected.cx, expected.cy, expected.angle]);
  const cos = Math.cos((angle * Math.PI) / 180);
  const sin = Math.sin((angle * Math.PI) / 180);
  const toPage = (lx: number, ly: number) => ({
    x: cx + lx * cos - ly * sin,
    y: cy + lx * sin + ly * cos,
  });
  const band = html.slice(html.indexOf("translate("));
  expect(band.length).toBeGreaterThan(0);

  const local: Pt[] = [];
  const segment = (p: Pt, q: Pt) => {
    for (let i = 0; i <= 20; i += 1) {
      const u = i / 20;
      local.push({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
    }
  };
  for (const m of band.matchAll(/<line([^>]*)\/?>/g)) {
    const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) => Number(attr(m[1], k)));
    segment({ x: x1, y: y1 }, { x: x2, y: y2 });
  }
  for (const m of band.matchAll(/<path[^>]* d="([^"]*)"/g)) {
    const v = nums(m[1]);
    const points: Pt[] = [];
    for (let i = 0; i + 1 < v.length; i += 2) points.push({ x: v[i], y: v[i + 1] });
    for (let i = 1; i < points.length; i += 1) segment(points[i - 1], points[i]);
  }
  for (const m of band.matchAll(/<rect([^>]*)\/?>/g)) {
    if (attr(m[1], "fill") === "transparent") continue;
    const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(attr(m[1], k)));
    segment({ x, y }, { x: x + w, y });
    segment({ x: x + w, y }, { x: x + w, y: y + h });
    segment({ x: x + w, y: y + h }, { x, y: y + h });
    segment({ x, y: y + h }, { x, y });
  }
  for (const m of band.matchAll(/<circle([^>]*)\/?>/g)) {
    // The opening frame puts an ion at one end of its lane; it travels to the
    // mirror of that point. The whole lane is ink at some moment.
    const x = Number(attr(m[1], "cx"));
    const y = Number(attr(m[1], "cy"));
    const r = Number(attr(m[1], "r"));
    segment({ x: x - Math.sign(x) * r, y: y - r }, { x: -x + Math.sign(x) * r, y: y + r });
  }
  expect(local.length).toBeGreaterThan(100);
  return local.map((p) => toPage(p.x, p.y));
}

/** The markup the arch is drawn with — the arch, its arrowheads and its flow — before the band. */
function archMarkup(html: string): string {
  const at = html.indexOf("translate(");
  expect(at).toBeGreaterThan(-1);
  return html.slice(0, at);
}

/** Each arrowhead on the arch, read off its markup as the three points it is drawn through. */
function archArrowInk(html: string): Pt[] {
  const ink: Pt[] = [];
  let arrows = 0;
  for (const m of archMarkup(html).matchAll(/<path d="(M [^"]* L [^"]*)"/g)) {
    arrows += 1;
    const v = nums(m[1]);
    for (let i = 2; i + 1 < v.length; i += 2) {
      for (let k = 0; k <= 20; k += 1) {
        const u = k / 20;
        ink.push({ x: v[i - 2] + (v[i] - v[i - 2]) * u, y: v[i - 1] + (v[i + 1] - v[i - 1]) * u });
      }
    }
  }
  // One each way: a count of zero here would make every check below vacuous.
  expect(arrows).toBe(2);
  return ink;
}

/**
 * Where each particle on the arch is ever lit, in page coordinates: its own
 * `animateMotion` path, walked by distance — which is how `animateMotion`
 * walks it — over the stretch its fade leaves lit. Read off the markup, so a
 * particle drawn somewhere its timing did not mean is measured where it is
 * drawn.
 *
 * What is returned is the EDGE of the ink a lit particle sweeps: the path
 * offset by the particle's radius to either side, and a ring of that radius
 * at each end of the lit stretch. Every question below — is any ink inside a
 * caption, how near does it come to a node or a band — is answered at the
 * edge of the ink, never inside it, and sampling only the edge is what keeps
 * the two-hundred-layout sweep inside its time. A sample falls every half
 * unit of travel; no caption is that thin.
 */
function particleInk(html: string): Pt[] {
  const ink: Pt[] = [];
  const seen = new Set<string>();
  let particles = 0;
  for (const m of archMarkup(html).matchAll(/<circle([^>]*)>([\s\S]*?)<\/circle>/g)) {
    particles += 1;
    const r = Number(attr(m[1], "r"));
    const motion = m[2].match(/<animateMotion([^>]*)>/)?.[1] ?? "";
    const fade = m[2].match(/<animate\s([^>]*)>/)?.[1] ?? "";
    const path = attr(motion, "path");
    const times = attr(fade, "keyTimes")?.split(";").map(Number);
    const values = attr(fade, "values")?.split(";").map(Number);
    expect(path && times && values && r > 0).toBeTruthy();
    // Lit from the keyframe before the first non-zero value to the one after
    // the last: that is as far as the fade can reach either way.
    const first = values!.findIndex((v) => v > 0);
    const last = values!.length - 1 - [...values!].reverse().findIndex((v) => v > 0);
    let [from, to] = [times![first - 1], times![last + 1]];
    // Walked backwards, a share of the journey is measured from the path's far end.
    if (attr(motion, "keyPoints") === "1;0") [from, to] = [1 - to, 1 - from];
    const key = `${path}|${from}|${to}|${r}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const [p0, p1, p2, p3] = (() => {
      const v = nums(path!);
      expect(v).toHaveLength(8);
      return [0, 2, 4, 6].map((i) => ({ x: v[i], y: v[i + 1] }));
    })();
    const at = (t: number) => {
      const u = 1 - t;
      return {
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      };
    };
    const steps = 2000;
    const points = Array.from({ length: steps + 1 }, (_, i) => at(i / steps));
    const walked = [0];
    for (let i = 1; i <= steps; i += 1) walked.push(walked[i - 1] + dist(points[i - 1], points[i]));
    const length = walked[steps];
    const lit: number[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const share = walked[i] / length;
      if (share < from || share > to) continue;
      if (lit.length === 0 || walked[i] - walked[lit[lit.length - 1]] >= 0.5) lit.push(i);
    }
    expect(lit.length).toBeGreaterThan(1);
    const ring = (p: Pt) => {
      for (let k = 0; k < 8; k += 1) {
        const angle = (k * Math.PI) / 4;
        ink.push({ x: p.x + r * Math.cos(angle), y: p.y + r * Math.sin(angle) });
      }
    };
    ring(points[lit[0]]);
    ring(points[lit[lit.length - 1]]);
    for (const i of lit) {
      const before = points[Math.max(0, i - 1)];
      const after = points[Math.min(steps, i + 1)];
      const run = dist(before, after);
      const normal = { x: -(after.y - before.y) / run, y: (after.x - before.x) / run };
      ink.push(
        { x: points[i].x + normal.x * r, y: points[i].y + normal.y * r },
        { x: points[i].x - normal.x * r, y: points[i].y - normal.y * r },
      );
    }
  }
  // The flow is drawn on every arch this file lays out; if it were not, the
  // checks that read this would pass by measuring nothing.
  expect(particles).toBe(2 * LATERAL_FLOW.count);
  return ink;
}

/**
 * Everything the ARCH paints, in page coordinates: the curve, sampled off the
 * same four points it is drawn from; its arrowheads; and wherever a particle
 * travelling it is ever lit.
 */
function archInk(html: string, lateral: TreeLateral, trunk: Pt | null): Pt[] {
  const placement = placeLateral(lateral.a, lateral.b, trunk);
  const curve = Array.from({ length: 401 }, (_, i) =>
    lateralPointAt(lateral.a, lateral.b, placement, i / 400),
  );
  return [...curve, ...archArrowInk(html), ...particleInk(html)];
}

function nodeRadius(node: TreeNode): number {
  return node.id === "__trunk__" ? 18 : Math.max(8, 14 - node.depth * 2);
}

const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * The nearest distance from any of `from` to any of `to`, or Infinity past `reach`.
 *
 * Exact inside `reach`, which is the only range the assertion reads: `to` is
 * binned into cells `reach` wide, so a point nearer than `reach` is always in
 * one of the nine cells around the query. Comparing every pair instead is two
 * thousand points against five thousand, and the sweep below does it two
 * hundred times.
 */
function nearestWithin(from: readonly Pt[], to: readonly Pt[], reach: number): number {
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  const cells = new Map<string, Pt[]>();
  for (const q of to) {
    const k = key(Math.floor(q.x / reach), Math.floor(q.y / reach));
    const bucket = cells.get(k);
    if (bucket) bucket.push(q);
    else cells.set(k, [q]);
  }
  let nearest = Infinity;
  for (const p of from) {
    const cx = Math.floor(p.x / reach);
    const cy = Math.floor(p.y / reach);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const q of cells.get(key(cx + dx, cy + dy)) ?? []) {
          const d = dist(p, q);
          if (d < nearest) nearest = d;
        }
      }
    }
  }
  return nearest;
}

/** How close the lateral's ink may come to a vertical band's before the two read as one control. */
const VERTICAL_CLEARANCE = 6;

/**
 * What stands in the lateral band's way on one layout, as sentences. Empty is clear.
 *
 * `bowToward` is the point the arch bends toward — the trunk, as the diagram
 * draws it, unless a test is asking what the OTHER way would have hit.
 */
function lateralCollisions(
  layout: FleetLayout,
  advance: number,
  bowToward: (lateral: TreeLateral) => Pt | null = () => layout.trunk,
): string[] {
  const out: string[] = [];
  const captions = layout.nodes.flatMap((n) => labelBoxes(n, advance));
  const verticalInk = layout.branches.flatMap((b) => bandInk(b));
  const inside = (p: Pt, box: Box) =>
    p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1;

  for (const lateral of layout.laterals) {
    const toward = bowToward(lateral);
    const html = drawLateral(lateral, toward);
    const band = lateralBandInk(html, lateral, toward);
    const arch = archInk(html, lateral, toward);
    const ends = new Set([lateral.a.id, lateral.b.id]);
    const ink = [...band, ...arch];

    for (const box of captions) {
      const hit = ink.find((p) => inside(p, box));
      if (hit)
        out.push(`lateral ink at (${hit.x.toFixed(1)}, ${hit.y.toFixed(1)}) inside "${box.text}"`);
    }
    for (const node of layout.nodes) {
      // The arch runs INTO the two nodes it joins, under them, by design.
      const reach = nodeRadius(node) + 4;
      const bandHit = band.find((p) => dist(p, node) < reach);
      if (bandHit) out.push(`lateral band within ${reach} of ${node.id}`);
      if (ends.has(node.id)) continue;
      const archHit = arch.find((p) => dist(p, node) < reach);
      if (archHit) out.push(`lateral arch within ${reach} of ${node.id}`);
    }
    // A vertical band's ink and the lateral's must not touch: two controls
    // drawn into each other are one target nobody can aim at.
    const nearest = nearestWithin(ink, verticalInk, VERTICAL_CLEARANCE);
    if (nearest < VERTICAL_CLEARANCE) {
      out.push(`lateral ink ${nearest.toFixed(1)} from a vertical membrane`);
    }
  }
  return out;
}

/**
 * How far the layout jitters a node, across and down — read off the layout
 * rather than restated, the way `ENTRY_TRAVEL` is read off the node.
 */
const JITTER = (() => {
  const src = readFileSync("src/components/yggdrasil/use-tree-layout.ts", "utf8");
  const x = src.match(/const jitterX = \(hash - 0\.5\) \* (\d+);/);
  const y = src.match(/const jitterY = \(hashStr\(clone\.id \+ "y"\) - 0\.5\) \* (\d+);/);
  if (!x || !y) throw new Error("use-tree-layout.ts no longer states its jitter as literals");
  return { x: Number(x[1]), y: Number(y[1]) };
})();

/** A deterministic stream of v4-shaped ids, so a failure names ids that can be drawn again. */
function uuids(seed: number): () => string {
  // mulberry32 — small, seeded, and ample for spreading a hash.
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0).toString(16).padStart(8, "0");
  };
  return () => {
    const h = next() + next() + next() + next();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

/** The recorded fleet with its two parents re-identified, which moves every jittered node. */
function refleet(parentA: string, parentB: string): Clone[] {
  const rename = new Map([
    ["client-dashboard", parentA],
    ["crm-independent", parentB],
  ]);
  return FLEET.map((c) => {
    const row = c as unknown as { id: string; parent_clone_id: string | null };
    return {
      ...c,
      id: rename.get(row.id) ?? row.id,
      parent_clone_id: row.parent_clone_id
        ? (rename.get(row.parent_clone_id) ?? row.parent_clone_id)
        : null,
    } as Clone;
  });
}

/**
 * Pairs of parent ids standing for the sixteen corners of the space the two
 * parents move in together, found once and shared.
 *
 * A parent's position is a hash of its id, so a corner is REACHED BY SEARCHING
 * IDS rather than chosen. Each side gets two thousand candidates shaped like
 * the ids production writes, each placed by the layout itself; for each corner
 * of a parent's jitter box the nearest candidate stands for it, and every
 * pairing of one side's corner with the other's is returned.
 *
 * UUID-shaped rather than `corner-${i}`: ids that differ only in a trailing
 * counter hash into a narrower band than the jitter allows, and the first
 * version of this reached 94% of the range and called it the corners. The
 * span is asserted rather than trusted for the same reason.
 */
const jitterCorners = (() => {
  let found: Array<[string, string]> | null = null;
  return (): Array<[string, string]> => {
    if (found) return found;
    const seen = { a: [] as Array<Pt & { id: string }>, b: [] as Array<Pt & { id: string }> };
    const nextId = uuids(0x5eed);
    for (let i = 0; i < 2000; i += 1) {
      const pair = { a: nextId(), b: nextId() };
      const { laterals } = layoutOf(refleet(pair.a, pair.b));
      seen.a.push({ id: pair.a, x: laterals[0].a.x, y: laterals[0].a.y });
      seen.b.push({ id: pair.b, x: laterals[0].b.x, y: laterals[0].b.y });
    }

    const cornersOf = (points: Array<Pt & { id: string }>) => {
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const box = {
        x0: Math.min(...xs),
        x1: Math.max(...xs),
        y0: Math.min(...ys),
        y1: Math.max(...ys),
      };
      // The candidates must span the jitter the layout states, or the
      // "corners" below are corners of something smaller.
      expect(box.x1 - box.x0).toBeGreaterThan(0.95 * JITTER.x);
      expect(box.y1 - box.y0).toBeGreaterThan(0.95 * JITTER.y);
      return [box.x0, box.x1].flatMap((cx) =>
        [box.y0, box.y1].map((cy) => {
          const nearest = points.reduce((best, p) =>
            Math.hypot(p.x - cx, p.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? p : best,
          );
          // Near enough to its corner to stand for it: a tenth of the range each way.
          expect(Math.abs(nearest.x - cx)).toBeLessThan(0.1 * JITTER.x);
          expect(Math.abs(nearest.y - cy)).toBeLessThan(0.1 * JITTER.y);
          return nearest.id;
        }),
      );
    };

    const corners = { a: cornersOf(seen.a), b: cornersOf(seen.b) };
    found = corners.a.flatMap((a) => corners.b.map((b): [string, string] => [a, b]));
    expect(found).toHaveLength(16);
    return found;
  };
})();

describe("the lateral band clears everything around it", () => {
  it("is drawn between the two parents the lateral registry names, and nowhere else", () => {
    const { laterals, nodes } = layoutOfFleet();
    expect(laterals).toHaveLength(1);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(laterals[0].a.id)?.githubRepo).toBe("npc-client-dashboard");
    expect(byId.get(laterals[0].b.id)?.githubRepo).toBe("npc-crm-independent-6505dc");
  });

  it("is not drawn when either parent is filtered out of the view", () => {
    // Half a boundary would read as a boundary with one side.
    expect(
      layoutOf(FLEET.filter((c) => (c as unknown as { id: string }).id !== "crm-independent"))
        .laterals,
    ).toEqual([]);
    expect(
      layoutOf(FLEET.filter((c) => (c as unknown as { id: string }).id !== "client-dashboard"))
        .laterals,
    ).toEqual([]);
  });

  it.each([0.55, 0.6, 0.65])(
    "puts no lateral ink on a caption, a node or a vertical band at %s em",
    (advance) => {
      expect(lateralCollisions(layoutOfFleet(), advance)).toEqual([]);
    },
  );

  it.each([900, 1100, 1400, 1920])("stays clear at a %i-wide canvas", (width) => {
    expect(lateralCollisions(layoutOf(FLEET, width, Math.max(600, width * 0.65)), 0.65)).toEqual(
      [],
    );
  });

  it("draws no lit particle and no arrowhead under either parent", () => {
    // The arch runs into its two nodes by design, and the node is drawn over
    // it — which is why the checks below let the ARCH reach its own two ends.
    // What travels it may not: a lit particle or an arrowhead there would
    // show through the glow as a mark on the node. `clear` is sized against
    // the node's drawing, so the drawing is read rather than restated: the
    // radius rule `nodeRadius` mirrors, and the glow drawn round it.
    expect(NODE_CODE).toContain("const radius = isTrunk ? 18 : Math.max(8, 14 - node.depth * 2);");
    const glow = NODE_CODE.match(
      /r=\{radius \+ (\d+)\}\s+fill=\{isTrunk \? "[^"]*" : colors\.glow\}/,
    );
    expect(glow).not.toBeNull();
    const halo = Number(glow![1]);

    const layouts = [layoutOfFleet(), ...jitterCorners().map(([a, b]) => layoutOf(refleet(a, b)))];
    for (const layout of layouts) {
      const byId = new Map(layout.nodes.map((n) => [n.id, n]));
      for (const lateral of layout.laterals) {
        const html = drawLateral(lateral, layout.trunk);
        const marks = [...particleInk(html), ...archArrowInk(html)];
        for (const end of [lateral.a, lateral.b]) {
          const node = byId.get(end.id)!;
          const nearest = Math.min(...marks.map((p) => dist(p, node)));
          expect(nearest).toBeGreaterThan(nodeRadius(node) + halo);
        }
      }
    }
  });

  it("stays clear under the fleet's real clone ids", () => {
    // Position is jittered by a hash of the id, so the fixture's ids and the
    // production rows draw the parents in different places.
    const real = refleet(
      "37b3e65a-716e-4141-9cb6-2e13583dbdd9",
      "e97f18ab-a3e3-4350-a0c9-d3f8584d6243",
    );
    expect(lateralCollisions(layoutOf(real), 0.65)).toEqual([]);
  });

  it("stays clear at every corner the jitter can put the two parents in", () => {
    const failures: string[] = [];
    for (const [a, b] of jitterCorners()) {
      const found = lateralCollisions(layoutOf(refleet(a, b)), 0.65);
      if (found.length > 0) failures.push(`${a} / ${b}: ${found[0]}`);
    }
    expect(failures).toEqual([]);
  });

  it("bows toward the trunk because the other way runs through a parent's name", () => {
    // The direction is a RULE only if the other one fails, and that is asked
    // of the drawing rather than argued in `lateralBand.pure.ts`: the same
    // arch at the same corners, bent away from the trunk instead. It must hit
    // something — a parent's own caption hangs where it would pass. If this
    // ever stops failing, the header's reason for the direction is stale.
    const hits: string[] = [];
    for (const [a, b] of jitterCorners()) {
      const layout = layoutOf(refleet(a, b));
      const away = (lateral: TreeLateral): Pt | null => {
        const trunk = layout.trunk;
        if (!trunk) return null;
        const mid = { x: (lateral.a.x + lateral.b.x) / 2, y: (lateral.a.y + lateral.b.y) / 2 };
        return { x: 2 * mid.x - trunk.x, y: 2 * mid.y - trunk.y };
      };
      hits.push(...lateralCollisions(layout, 0.55, away));
    }
    expect(hits.some((h) => /inside "npc-(client-dashboard|crm-independent-6505dc)"/.test(h))).toBe(
      true,
    );
  });

  it("stays clear across the interior the jitter can put the parents in", () => {
    // The corners are where a limit is reached; the interior is where two
    // limits are reached half-way at once. One failure names the pair so it
    // can be drawn and looked at.
    const failures: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const pair = [`parent-a-${i}`, `parent-b-${(i * 7919) % 1000}`] as const;
      const found = lateralCollisions(layoutOf(refleet(pair[0], pair[1])), 0.65);
      if (found.length > 0) failures.push(`${pair.join(" / ")}: ${found[0]}`);
    }
    expect(failures).toEqual([]);
  });
});
