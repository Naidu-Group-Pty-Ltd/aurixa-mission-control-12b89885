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
import { TreeNodeCircle } from "./tree-node";
import { placeMembrane } from "./membraneGeometry.pure";
import { useTreeLayout, type TreeBranch, type TreeNode } from "./use-tree-layout";
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

/** `useTreeLayout` is a hook, so it is read through a render rather than called. */
function layoutOfFleet(): { nodes: TreeNode[]; branches: TreeBranch[] } {
  // Collected through an array rather than a `let`: assigning to a captured
  // binding inside a component leaves TypeScript narrowing it to `never` at
  // the read below, and the suite passes while `tsc` does not.
  const caught: Array<{ nodes: TreeNode[]; branches: TreeBranch[] }> = [];
  function Probe() {
    const l = useTreeLayout(FLEET, 1400, 900);
    caught.push({ nodes: l.nodes, branches: l.branches });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const captured = caught[0];
  if (!captured) throw new Error("useTreeLayout drew nothing for the recorded fleet");
  return captured;
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
  if (!from || !to) throw new Error("tree-node.tsx no longer states its caption travel as literals");
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
      createElement(MembraneBand, { branch, membrane, index: 0, selected: false, onSelect: () => {} }),
    ),
  );
  const { cx, cy, tx, ty, nx, ny } = placeMembrane(branch);
  const toPage = (lx: number, ly: number) => ({ x: cx + lx * tx + ly * nx, y: cy + lx * ty + ly * ny });

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
          const hit = ink.find((p) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1);
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
    const status = labelBoxes(node, 0.6).find((b) => /behind/i.test(b.text) && b.text.includes("·"));
    expect(status).toBeDefined();
    // `behind · 12 behind` was the caption that reached both depth-2 bands.
    expect(status!.text.toLowerCase().match(/behind/g)).toHaveLength(1);
  });
});
