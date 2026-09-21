/**
 * THE BAND IS ASKED WHERE IT ACTUALLY DRAWS.
 *
 * Every other guard in this directory reads source. That is the right tool
 * for "is this mounted" and the wrong one for "does the browser honour it",
 * and the difference cost this component its entire placement: framer-motion
 * moves a `transform` attribute into `style.transform` on any non-`<svg>` SVG
 * element and then overwrites it with whatever transform it is animating, so
 * `<motion.g transform="translate(…)" animate={{ scale: 1 }}>` renders at the
 * ORIGIN. It typechecked, it linted, it built, and the source read exactly as
 * intended.
 *
 * So this one renders the real component through the real library and reads
 * the markup. No JSX and no DOM: `createElement` and `renderToStaticMarkup`
 * are enough, which is what lets it live beside the unit tests under
 * vitest's `node` environment.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MembraneBand } from "./membrane-band";
import { placeMembrane, type BranchEnds } from "./membraneGeometry.pure";
import { PRIME_REPO, resolveMembrane } from "@/lib/cascade/membrane/fleetMembranes.pure";

const BRANCH: BranchEnds = { from: { x: 640, y: 80 }, to: { x: 840, y: 200 } };
const MEMBRANE = resolveMembrane(PRIME_REPO, "npc-crm-independent-6505dc");

function draw(selected = false): string {
  return renderToStaticMarkup(
    createElement(
      "svg",
      null,
      createElement(MembraneBand, {
        branch: BRANCH,
        membrane: MEMBRANE,
        index: 0,
        selected,
        onSelect: () => {},
      }),
    ),
  );
}

describe("where the band actually lands", () => {
  it("carries its own placement into the markup", () => {
    // NOT the assertion that catches the defect, and that is worth knowing:
    // with the transform back on the motion element this still passes. Both
    // ship — the attribute AND an inline `style` that overrides it — so
    // presence proves nothing on its own. The two below are what settle it.
    const { cx, cy, angle } = placeMembrane(BRANCH);
    expect(cx).toBe(740);
    expect(cy).toBe(140);
    expect(draw()).toContain(`transform="translate(${cx} ${cy}) rotate(${angle})"`);
  });

  it("never lets an animated transform sit on the element that is placed", () => {
    // The defect, stated as the defect. An inline `style` declaration beats a
    // presentation attribute, so the two on one element means the placement
    // loses — silently, and identically at every zoom.
    const html = draw();
    const placed = html.slice(html.indexOf("translate("));
    const openTag = placed.slice(0, placed.indexOf(">"));
    expect(openTag).not.toContain("style=");
    expect(openTag).not.toContain("transform:scale");
  });

  it("puts the animation on a DIFFERENT element from the placement", () => {
    const html = draw();
    const placedAt = html.indexOf("translate(");
    const scaledAt = html.indexOf("transform:scale");
    expect(placedAt).toBeGreaterThan(-1);
    expect(scaledAt).toBeGreaterThan(-1);
    // Both present, and the scaled one opens after the placed tag closes.
    const placedTagEnd = html.indexOf(">", placedAt);
    expect(scaledAt).toBeGreaterThan(placedTagEnd);
  });

  it("draws one pore per channel this membrane declares", () => {
    const html = draw();
    // The CRM-independent edge: one closed channel (a filled plug) and one
    // gated (a dashed one). Counted as drawn rects rather than trusted.
    expect(MEMBRANE.channels).toHaveLength(2);
    expect(html).toContain("stroke-dasharray");
    const plugs = [...html.matchAll(/<rect[^>]*rx="1\.2"/g)];
    expect(plugs).toHaveLength(2);
  });

  it("names itself for a screen reader, with the counts it draws", () => {
    const pumps = MEMBRANE.standing.filter((o) => o.kind === "pump").length;
    expect(draw()).toContain(
      `aria-label="${MEMBRANE.label}: ${MEMBRANE.channels.length} channel(s), ${pumps} pump(s)"`,
    );
  });

  it("draws a selection ring only when selected", () => {
    expect(draw(false)).not.toContain("oklch(0.78 0.16 200 / 0.10)");
    expect(draw(true)).toContain("oklch(0.78 0.16 200 / 0.10)");
  });
});
