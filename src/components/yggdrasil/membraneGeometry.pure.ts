/**
 * WHERE A MEMBRANE SITS ON A BRANCH.
 *
 * `TreeBranchPath` draws a cubic bezier whose control points are pulled
 * horizontally by 15% of the run and pinned to the vertical midpoint:
 *
 *   M from  C (from.x + k, midY), (to.x − k, midY), to      k = 0.15·dx
 *
 * That curve is symmetric about its own midpoint, and the symmetry is worth
 * stating rather than approximating: evaluate the cubic at t = 0.5 and the
 * control offsets cancel exactly, in x and in y, so the point is the CHORD
 * midpoint. A membrane drawn there needs no curve-length solver and cannot
 * drift off the line it belongs to.
 *
 * The tangent does not cancel, and using the chord's direction instead would
 * tilt the band visibly on the fleet's widest branches. It is derived rather
 * than eyeballed:
 *
 *   B′(0.5) = ¾(P1−P0) + 1½(P2−P1) + ¾(P3−P2)
 *           = ( 1.5·dx − 1.5·k , 0.75·dy )
 *           = ( 1.275·dx , 0.75·dy )                        with k = 0.15·dx
 *
 * Nothing here reads the DOM or a clock; it is arithmetic on two points, so
 * the band's placement can be asserted rather than looked at.
 */

export type BranchEnds = {
  from: { x: number; y: number };
  to: { x: number; y: number };
};

export type MembranePlacement = {
  /** The midpoint of the branch, where the band is centred. */
  cx: number;
  cy: number;
  /** Unit vector along the branch at that point. */
  tx: number;
  ty: number;
  /** Unit vector across it — the direction the bilayer runs. */
  nx: number;
  ny: number;
  /** Degrees, for an SVG `rotate(...)` that lines a group up with the band. */
  angle: number;
};

/** The control-point pull `TreeBranchPath` uses. Kept in one place. */
export const CONTROL_PULL = 0.42;

export function placeMembrane(branch: BranchEnds): MembranePlacement {
  const dx = branch.to.x - branch.from.x;
  const dy = branch.to.y - branch.from.y;

  const cx = (branch.from.x + branch.to.x) / 2;
  const cy = (branch.from.y + branch.to.y) / 2;

  // B′(0.5) for this family of curves. See the header.
  let tx = 1.5 * dx - 1.5 * (CONTROL_PULL * dx);
  let ty = 0.75 * dy;

  // A zero-length branch has no direction. Down is the tree's own default —
  // every branch descends — and it keeps the band drawable rather than
  // collapsing it to a point or dividing by zero.
  const len = Math.hypot(tx, ty);
  if (len === 0) {
    tx = 0;
    ty = 1;
  } else {
    tx /= len;
    ty /= len;
  }

  return {
    cx,
    cy,
    tx,
    ty,
    nx: -ty,
    ny: tx,
    angle: (Math.atan2(ty, tx) * 180) / Math.PI,
  };
}

/**
 * Evenly spaced offsets across the band, centred on zero.
 *
 * `count` of 1 sits in the middle rather than at an edge, which is what makes
 * a membrane with one channel read as a membrane rather than as a mark that
 * slipped.
 */
export function slotOffsets(count: number, spacing: number): number[] {
  if (count <= 0) return [];
  const first = -((count - 1) * spacing) / 2;
  return Array.from({ length: count }, (_, i) => first + i * spacing);
}

/** Half the band's height. The bilayer runs from `-BAND_HALF_SPAN` to `+BAND_HALF_SPAN`. */
export const BAND_HALF_SPAN = 21;

/** How far a pore's mouth reaches either side of its slot. */
export const PORE_HALF_HEIGHT = 5;

/**
 * The stretches of leaflet BETWEEN the pores.
 *
 * Drawn as runs rather than as one line with gaps painted over it, because a
 * gap painted in the background colour stops being a gap the moment anything
 * is drawn behind the band — and the branch itself is. It lives here rather
 * than in the component so it can be asserted without a renderer.
 */
export function leafletRuns(slots: readonly number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let cursor = -BAND_HALF_SPAN;
  for (const y of slots) {
    if (y - PORE_HALF_HEIGHT > cursor) runs.push([cursor, y - PORE_HALF_HEIGHT]);
    cursor = y + PORE_HALF_HEIGHT;
  }
  if (BAND_HALF_SPAN > cursor) runs.push([cursor, BAND_HALF_SPAN]);
  return runs;
}
