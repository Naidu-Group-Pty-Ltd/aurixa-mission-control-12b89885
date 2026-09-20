/**
 * The fleet, as a tree that actually grew.
 *
 * The previous drawing was a flow diagram wearing tree vocabulary: uniform
 * bezier lines, every child hanging off its parent's TIP, and a node count you
 * had to read off a stat card because the picture carried none of it. This
 * module turns the recorded lineage into geometry where the SHAPE is the data.
 *
 * Three botanical rules do that work, and each one is load-bearing rather than
 * decorative.
 *
 * ## 1. Da Vinci's rule — why the tree grows rather than merely gains sticks
 *
 * Leonardo observed that a limb's cross-section equals the sum of the limbs it
 * carries, which is the "pipe model" a century of forestry has measured since:
 * every branch is a bundle of pipes feeding the leaves above it, so area is
 * conserved at a fork and `radius ∝ subtreeSize^(1/Δ)`.
 *
 * Δ is 2 in Leonardo's exact statement and 2.0–2.5 when measured on real
 * species; `BRANCHING_EXPONENT` sits at 2.3. A larger Δ makes the trunk
 * relatively thinner for the same fleet.
 *
 * This is the rule that answers "the tree should grow as more clones are
 * created". It is not an animation — a fleet of forty has a visibly heavier
 * trunk than a fleet of three because the trunk is carrying forty, and that
 * stays true at every fork. A bough with six clones under it is thick; a leaf
 * clone is a twig. The fleet's shape is legible without reading a single label.
 *
 * ## 2. Branches leave along the parent, and the biggest child keeps going
 *
 * The defect that made the old picture read as a diagram: every child attached
 * at its parent's endpoint, so each level exploded outward from one point like
 * a firework. Real branches emerge ALONG a limb, spread over its upper length.
 *
 * And they are not equals. The strongest shoot continues the parent's own
 * direction near its tip — apical dominance — while weaker ones peel off lower
 * at wider angles. Here the "strongest" is the child with the largest subtree,
 * which means the trunk line visibly follows the fleet's main lineage and the
 * side branches read as side branches.
 *
 * ## 3. Phyllotaxis — siblings at the golden angle
 *
 * Successive branches sit 137.507° apart around the parent axis. It is what
 * real shoots do, it is deterministic, and no two siblings in a run of any
 * length land on top of each other. Seeded jitter from the clone's own id keeps
 * two structurally identical fleets from being visually identical.
 *
 * ## Determinism is a requirement, not a nicety
 *
 * Every number here is derived from the clone list — ids, lineage, status — and
 * nothing is sampled from `Math.random`. The same fleet must draw the same tree
 * on every render, or the picture is a lava lamp: an operator cannot say "that
 * branch moved" and mean anything by it. `seeded()` is the only source of
 * variation and it is a hash of the clone's own id.
 *
 * ## It reads the recorded lineage, never its own
 *
 * `buildHierarchy` is imported rather than reimplemented, so the tree drawn
 * here and the tree the cascade follows cannot disagree. That is the same rule
 * `lineageDepth` answers to, and it is why `parent_clone_id` exists at all.
 */

import type { Clone } from "@/lib/queries";
import { buildHierarchy } from "./use-tree-layout";

export type Vec3 = readonly [number, number, number];

export interface SakuraBranch {
  /** Clone id, or `__trunk__` for the prime. */
  id: string;
  parentId: string | null;
  /** 0 for the trunk; a clone's depth in the recorded lineage. */
  depth: number;
  /** Sampled centreline, base first. A tube is swept along it. */
  curve: Vec3[];
  /** Radius at the base and the tip, from the pipe model. */
  radiusStart: number;
  radiusEnd: number;
  /** Total clones carried by this branch, including itself. */
  subtreeSize: number;
  /** Parents strictly before children, so nothing grows off thin air. */
  growthOrder: number;
  syncStatus: string;
  name: string;
  /** True for the shoot that continues its parent's line. */
  isLeader: boolean;
}

export interface SakuraBlossom {
  /** The branch this cluster sits on — also the clone it stands for. */
  branchId: string;
  position: Vec3;
  /** 0 bare, 1 fully open. A statement about the clone's status. */
  openness: number;
  /** Radians of roll, so a cluster is not a row of identical quads. */
  roll: number;
  scale: number;
  syncStatus: string;
}

export interface SakuraTree {
  branches: SakuraBranch[];
  blossoms: SakuraBlossom[];
  /** Highest point reached, for framing the camera. */
  height: number;
  /** Widest horizontal reach, for framing the camera. */
  spread: number;
  /** Fraction of the fleet in sync, 0..1. Drives the season. */
  vitality: number;
  trunkRadius: number;
}

/** Leonardo's exponent. 2 is his exact claim; measured species run 2.0–2.5. */
export const BRANCHING_EXPONENT = 2.3;

/** 137.507…° — the angle successive shoots sit at around a stem. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** A leaf clone's twig radius, in world units. Everything scales off this. */
const TWIG_RADIUS = 0.075;

/** The trunk's own length before any clone hangs off it. */
const TRUNK_LENGTH = 3.4;

/** Each generation is this fraction of its parent's length. */
const LENGTH_DECAY = 0.74;

/** How far a non-leader shoot leaves its parent's axis, at depth 1. */
const SPREAD_BASE = 1.02; // ~58°

/** Spread narrows with depth: twigs run closer to their parent's line. */
const SPREAD_DECAY = 0.76;

/** The leader's own deviation — small, which is what makes it read as leader. */
const LEADER_SPREAD = 0.16;

/** Lowest point on a parent where a child may attach, as a fraction. */
const ATTACH_MIN = 0.42;

/** How strongly branches curl back toward the light. */
const PHOTOTROPISM = 0.34;

/** Samples per branch centreline. Enough for a visibly bent tube. */
const CURVE_SAMPLES = 7;

/** Deterministic [0,1) from any string — the only source of variation here. */
function seeded(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * An orthonormal pair perpendicular to `d`.
 *
 * The reference vector is chosen AWAY from `d` rather than fixed, because a
 * branch pointing straight up crossed with +Y is the zero vector — which is
 * every trunk, the one case that must not degenerate.
 */
function basis(d: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(d, ref));
  return [u, norm(cross(d, u))];
}

/**
 * How open a blossom is, from what the clone's status says.
 *
 * Not a gradient on a single axis: `failed` is bare rather than "slightly less
 * pink", because a clone whose sync failed is a different statement from one
 * that is merely behind, and collapsing them onto one scale is how a red state
 * comes to read as an amber one.
 */
export function opennessFor(syncStatus: string): number {
  switch (syncStatus) {
    case "in_sync":
      return 1;
    case "behind":
      return 0.45;
    case "failed":
      return 0;
    default:
      return 0.2;
  }
}

/**
 * Blossoms on a branch: a healthy limb carrying more clones flowers harder.
 *
 * The count is deliberately high. The first pass drew three to six clusters a
 * branch and rendered as a bare winter tree — correct structure, wrong species.
 * A cherry in flower is dense enough that the wood is mostly hidden, and the
 * whole point of choosing sakura is that a healthy fleet should look like one.
 */
function blossomCount(subtreeSize: number, openness: number): number {
  if (openness <= 0) return 0;
  return Math.max(16, Math.round((26 + Math.sqrt(subtreeSize) * 11) * openness));
}

/**
 * A point at fraction `t` along a sampled centreline.
 *
 * Interpolated rather than snapped to the nearest sample, which is not a
 * refinement: with seven samples, twelve siblings rounded to six distinct
 * heights and attached three-and-four to a point — reintroducing, one level
 * down, the very clustering that attaching along the parent exists to remove.
 */
function pointAt(curve: Vec3[], t: number): Vec3 {
  const clamped = Math.min(1, Math.max(0, t));
  const span = (curve.length - 1) * clamped;
  const i = Math.min(curve.length - 2, Math.floor(span));
  const f = span - i;
  const a = curve[i];
  const b = curve[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

interface Frame {
  id: string;
  /**
   * The key this branch's children are filed under in `buildHierarchy`.
   *
   * Identical to `id` for a clone. It is NOT for the trunk: the prime is not a
   * row, so `buildHierarchy` files the clones that cascade from it under
   * `__root__` while the branch drawn for it is called `__trunk__`. Conflating
   * the two is how the first build of this module drew a bare pole — the
   * lookup found no children and reported a one-branch tree for a fleet of
   * forty, with every other number still looking plausible.
   */
  childKey: string;
  parentId: string | null;
  depth: number;
  origin: Vec3;
  direction: Vec3;
  length: number;
}

/**
 * Build the tree.
 *
 * `primeName` names the trunk. `clones` is the visible set — already filtered
 * by the page, which is deliberate: a filtered-out parent does not take its
 * children with it, because `buildHierarchy` attaches an orphan to the trunk.
 */
export function buildSakuraTree(clones: Clone[], primeName = "PRIME"): SakuraTree {
  const childMap = buildHierarchy(clones);
  const byId = new Map(clones.map((c) => [c.id, c]));

  // ── Pass 1: how much each branch carries. The pipe model needs this before
  //    any radius can be known, so it runs bottom-up over the whole tree first.
  const subtreeSize = new Map<string, number>();
  const measure = (id: string, seen: Set<string>): number => {
    if (subtreeSize.has(id)) return subtreeSize.get(id) as number;
    let total = id === "__root__" ? 0 : 1;
    for (const child of childMap.get(id) ?? []) {
      // The render's own cycle rule, asked again rather than assumed.
      if (seen.has(child)) continue;
      seen.add(child);
      total += measure(child, seen);
    }
    subtreeSize.set(id, total);
    return total;
  };
  const fleetSize = measure("__root__", new Set(["__root__"]));

  /** Da Vinci's rule. A branch carrying n clones is √ⁿ thicker than a twig. */
  const radiusFor = (n: number) => TWIG_RADIUS * Math.pow(Math.max(1, n), 1 / BRANCHING_EXPONENT);

  const branches: SakuraBranch[] = [];
  const blossoms: SakuraBlossom[] = [];
  let maxY = 0;
  let maxR = 0;
  let order = 0;

  /**
   * Emit one branch and recurse into its children.
   *
   * The curve bends toward +Y as it rises, so a limb arcs rather than running
   * straight — the difference between a tree and a diagram of one.
   */
  const grow = (frame: Frame, seen: Set<string>) => {
    const carried = subtreeSize.get(frame.childKey) ?? 1;
    const children = (childMap.get(frame.childKey) ?? []).filter((c) => !seen.has(c));

    const rStart = radiusFor(carried);
    // The tip is sized by what CONTINUES past it, so a fork visibly steps down.
    const leaderCarry = children.length
      ? Math.max(...children.map((c) => subtreeSize.get(c) ?? 1))
      : 1;
    const rEnd = Math.max(TWIG_RADIUS * 0.6, radiusFor(leaderCarry) * 0.92);

    const jitter = seeded(frame.id);
    const curve: Vec3[] = [];
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      const t = i / (CURVE_SAMPLES - 1);
      const along = scale(frame.direction, frame.length * t);
      // Quadratic curl toward the light, plus a seeded lean so no two limbs
      // of the same generation bend identically.
      const curl = PHOTOTROPISM * frame.length * t * t * (1 - Math.abs(frame.direction[1]));
      const lean = (jitter - 0.5) * 0.22 * frame.length * t * t;
      const p = add(frame.origin, along);
      curve.push([p[0] + lean, p[1] + curl, p[2] - lean * 0.6]);
      maxY = Math.max(maxY, p[1] + curl);
      maxR = Math.max(maxR, Math.hypot(p[0] + lean, p[2] - lean * 0.6));
    }

    const clone = byId.get(frame.id);
    const status = clone?.sync_status ?? "in_sync";
    const isTrunk = frame.id === "__trunk__";

    branches.push({
      id: frame.id,
      parentId: frame.parentId,
      depth: frame.depth,
      curve,
      radiusStart: rStart,
      radiusEnd: rEnd,
      subtreeSize: carried,
      growthOrder: order++,
      syncStatus: isTrunk ? "in_sync" : status,
      name: isTrunk ? primeName : (clone?.name ?? frame.id),
      isLeader: false,
    });

    // ── Blossoms. The trunk does not flower: the prime is not a clone, and
    //    giving it a cluster would put a status on something that has none.
    if (!isTrunk) {
      const openness = opennessFor(status);
      const n = blossomCount(carried, openness);
      const tip = curve[curve.length - 1];
      const before = curve[curve.length - 2] ?? frame.origin;
      const dir = norm([tip[0] - before[0], tip[1] - before[1], tip[2] - before[2]]);
      const [u, v] = basis(dir);
      for (let i = 0; i < n; i++) {
        const s = seeded(`${frame.id}:b${i}`);
        const a = i * GOLDEN_ANGLE + s * 0.7;
        // Clustered toward the tip, which is where a real shoot flowers.
        const along = 0.46 + 0.54 * ((i * 0.618) % 1);
        const spread = rStart * 1.4 + 0.08 + s * 0.46 * (0.55 + ((i * 0.37) % 1));
        const base = pointAt(curve, along);
        const off = add(scale(u, Math.cos(a) * spread), scale(v, Math.sin(a) * spread));
        blossoms.push({
          branchId: frame.id,
          position: add(base, off),
          openness,
          roll: a,
          scale: 0.15 + s * 0.11,
          syncStatus: status,
        });
      }
    }

    if (children.length === 0) return;

    // ── Apical dominance. The largest subtree continues the parent's line near
    //    the tip; the rest peel off lower and wider. Sorted descending so the
    //    leader is index 0 and the arrangement is stable across renders.
    const ranked = [...children].sort((a, b) => {
      const d = (subtreeSize.get(b) ?? 1) - (subtreeSize.get(a) ?? 1);
      return d !== 0 ? d : a.localeCompare(b);
    });

    const [tanU, tanV] = basis(frame.direction);
    const spreadAt = SPREAD_BASE * Math.pow(SPREAD_DECAY, frame.depth);

    ranked.forEach((childId, i) => {
      seen.add(childId);
      const leader = i === 0;
      const s = seeded(`${childId}:attach`);

      // Where along the parent this shoot leaves. The leader sits at the tip;
      // siblings spread down the parent's upper length rather than sharing one
      // point — the difference between a tree and a firework.
      const t = leader
        ? 1
        : ATTACH_MIN +
          (1 - ATTACH_MIN) *
            (ranked.length > 1 ? (i - 1) / Math.max(1, ranked.length - 1) : 0.5) *
            0.92 +
          s * 0.06;
      const origin = pointAt(curve, t);

      const az = i * GOLDEN_ANGLE + seeded(childId) * 0.9;
      const tilt = leader ? LEADER_SPREAD : spreadAt * (0.82 + s * 0.36);
      const off = add(scale(tanU, Math.cos(az)), scale(tanV, Math.sin(az)));
      let dir = norm(add(scale(frame.direction, Math.cos(tilt)), scale(off, Math.sin(tilt))));
      // Nothing grows downward: a branch that would dive is lifted back to
      // level. Real limbs droop under load, but a clone below the root reads
      // as a mistake rather than as a bough.
      if (dir[1] < -0.12) dir = norm([dir[0], -0.12, dir[2]]);

      const childCarry = subtreeSize.get(childId) ?? 1;
      // A bough carrying more needs more room to carry it.
      const len =
        TRUNK_LENGTH *
        Math.pow(LENGTH_DECAY, frame.depth + 1) *
        (0.78 + 0.34 * Math.min(1, Math.sqrt(childCarry / Math.max(1, carried))));

      const at = branches.length;
      grow(
        {
          id: childId,
          childKey: childId,
          parentId: frame.id,
          depth: frame.depth + 1,
          origin,
          direction: dir,
          length: len,
        },
        seen,
      );
      if (leader && branches[at]) branches[at].isLeader = true;
    });
  };

  grow(
    {
      id: "__trunk__",
      childKey: "__root__",
      parentId: null,
      depth: 0,
      origin: [0, 0, 0],
      direction: [0, 1, 0],
      length: TRUNK_LENGTH * (0.85 + 0.35 * Math.min(1, fleetSize / 12)),
    },
    new Set(["__trunk__"]),
  );

  const inSync = clones.filter((c) => c.sync_status === "in_sync").length;

  return {
    branches,
    blossoms,
    height: maxY,
    spread: maxR,
    vitality: clones.length === 0 ? 1 : inSync / clones.length,
    trunkRadius: radiusFor(Math.max(1, fleetSize)),
  };
}
