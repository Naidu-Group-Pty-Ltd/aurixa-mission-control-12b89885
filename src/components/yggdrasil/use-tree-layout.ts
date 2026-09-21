/**
 * useTreeLayout — converts a flat list of clones into a hierarchical
 * tree structure with computed (x, y) positions for SVG rendering.
 *
 * The tree grows DOWNWARD (roots into the earth), with the prime repo
 * as the trunk at the top and clones branching below.
 */

import { useMemo } from "react";
import type { Clone } from "@/lib/queries";

import { PRIME_REPO } from "@/lib/cascade/membrane/fleetMembranes.pure";

export interface TreeNode {
  id: string;
  name: string;
  slug: string;
  tags: string[];
  syncStatus: string;
  githubRepo: string;
  githubOwner: string;
  commitsBehind: number;
  depth: number;
  x: number;
  y: number;
  parentId: string | null;
  children: TreeNode[];
  /** Deterministic hue derived from clone id */
  hue: number;
  /** Branch angle in radians */
  angle: number;
}

export interface TreeBranch {
  from: { x: number; y: number };
  to: { x: number; y: number };
  depth: number;
  hue: number;
  thickness: number;
  /**
   * Which two deployments this branch joins.
   *
   * A branch used to be pure geometry, which is all a line needs to be drawn
   * and not enough for anything to be drawn ON it. The membrane that sits at
   * a cascade boundary belongs to the EDGE, so the edge has to know which one
   * it is. `fromRepo` is the trunk's repository where the parent is prime.
   */
  fromId: string | null;
  toId: string;
  fromRepo: string;
  toRepo: string;
}

export interface TreeLayout {
  nodes: TreeNode[];
  branches: TreeBranch[];
  width: number;
  height: number;
  trunkNode: TreeNode | null;
}

/** Deterministic hash from string → number [0, 1) */
function hashStr(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h % 10000) / 10000;
}

/**
 * Read the recorded tree off `clones.parent_clone_id`.
 *
 * This used to GUESS: clones sharing a first tag became a group, the oldest of
 * that group became its root, and everyone else became that root's child. Three
 * things were wrong with it and all three are why the column exists.
 *
 *  - The shape moved on its own. Adding a clone to a tag group re-parented it
 *    onto whichever member happened to be oldest, and nothing recorded either
 *    the old shape or the new one.
 *  - `tags` is a cascade TARGETING field (`scope: 'tagged'` picks clones by
 *    tag), so reshaping the picture silently changed which clones a tagged
 *    cascade hit. One field, two authorities.
 *  - A group root's children were the whole rest of the group, so the deepest
 *    shape expressible was two levels. A grandchild had nowhere to go.
 *
 * `parent_clone_id` is NULL for a clone that cascades from prime, which is
 * every clone until somebody records otherwise — so an unclassified fleet
 * draws exactly as a flat fan off the trunk rather than as a guess.
 *
 * Two properties this has to hold, both of them about what the operator sees:
 *
 *  - **A filtered-out parent must not take its children with it.** The status
 *    filter runs BEFORE layout, so a visible clone whose parent is not in the
 *    visible set attaches to the trunk. Filtering to "behind" must never blank
 *    a clone that IS behind because its in-sync parent was filtered away.
 *  - **A cycle must not hang the render.** The database refuses one
 *    (`trg_clones_parent_acyclic`), but a render must not depend on the
 *    database having been right: a row reached twice is treated as a root, so
 *    the worst a bad row can do is draw in the wrong place.
 */
export function buildHierarchy(clones: Clone[]): Map<string, string[]> {
  const present = new Set(clones.map((c) => c.id));

  // Stable order, so the tree does not reshuffle between renders. The query
  // orders by created_at DESC; siblings read oldest-first, left to right.
  const ordered = [...clones].sort((a, b) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });

  const childMap = new Map<string, string[]>();
  const rootChildren: string[] = [];

  const parentOf = new Map<string, string>();
  for (const c of ordered) {
    const parentId = c.parent_clone_id;
    // A parent nobody can see is no parent here — the child stands on the trunk
    // rather than vanishing with it.
    if (parentId && parentId !== c.id && present.has(parentId)) {
      parentOf.set(c.id, parentId);
    }
  }

  /** Walk to the trunk, bounded. False when `id` sits on a cycle. */
  const reachesRoot = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id);
    while (cursor) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
    return true;
  };

  for (const c of ordered) {
    const parentId = parentOf.get(c.id);
    if (parentId && reachesRoot(c.id)) {
      const siblings = childMap.get(parentId) ?? [];
      siblings.push(c.id);
      childMap.set(parentId, siblings);
    } else {
      rootChildren.push(c.id);
    }
  }

  childMap.set("__root__", rootChildren);
  return childMap;
}

/**
 * How many levels of CLONES the recorded tree has.
 *
 * The trunk is not a level. A fleet of five clones that all cascade from
 * prime is one level deep, not two — the prime is where they come from, not
 * somewhere in their lineage — so the series reads 0 for no clones, 1 for a
 * flat fan and 2 for the fleet as recorded on 20 Sep 2026.
 *
 * `TreeStats` used to print `new Set(clones.map((c) => c.tags?.[0])).size`
 * under the label "lineage depth" — the same `tags[0]` inference
 * `buildHierarchy` was written to replace, left behind in the one place that
 * puts a NUMBER on it. On the fleet as recorded on 20 Sep 2026 it read 1
 * (every clone carries the same first tag or none) for a tree that is three
 * levels deep, and it would have moved when somebody edited a tag.
 *
 * Derived from the same `buildHierarchy` the picture is drawn from, so the
 * number beside the tree and the tree cannot disagree.
 *
 * A fleet with no clones is 0 rather than 1: there is no tree, and reporting
 * a level says a fleet exists.
 */
export function lineageDepth(clones: Clone[]): number {
  if (clones.length === 0) return 0;
  const childMap = buildHierarchy(clones);
  const walk = (id: string, seen: Set<string>): number => {
    const children = childMap.get(id) ?? [];
    let deepest = 0;
    for (const child of children) {
      // The render's own cycle rule, asked again here rather than assumed:
      // a row reached twice contributes nothing instead of recursing forever.
      if (seen.has(child)) continue;
      seen.add(child);
      deepest = Math.max(deepest, walk(child, seen));
    }
    return deepest + 1;
  };
  // `walk` counts the node it is given, so the trunk's own level comes off.
  return walk("__root__", new Set(["__root__"])) - 1;
}

export function useTreeLayout(
  clones: Clone[],
  containerWidth: number,
  containerHeight: number,
): TreeLayout {
  return useMemo(() => {
    if (clones.length === 0) {
      return {
        nodes: [],
        branches: [],
        width: containerWidth,
        height: containerHeight,
        trunkNode: null,
      };
    }

    const childMap = buildHierarchy(clones);
    const cloneById = new Map(clones.map((c) => [c.id, c]));

    const allNodes: TreeNode[] = [];
    const allBranches: TreeBranch[] = [];

    const centerX = containerWidth / 2;
    const trunkTopY = 80;
    const levelSpacing = 120;
    const minBranchSpacing = 140;

    // Create trunk (prime repo) node
    const trunkNode: TreeNode = {
      id: "__trunk__",
      name: "PRIME",
      slug: "prime",
      tags: [],
      syncStatus: "in_sync",
      // The trunk IS the prime's repository, and the membrane on every root
      // edge is keyed on it. Left empty, every root edge resolves to the
      // default membrane and the fleet's real selectivity is invisible.
      githubRepo: PRIME_REPO,
      githubOwner: "",
      commitsBehind: 0,
      depth: 0,
      x: centerX,
      y: trunkTopY,
      parentId: null,
      children: [],
      hue: 200,
      angle: Math.PI / 2, // pointing down
    };
    allNodes.push(trunkNode);

    const rootChildren = childMap.get("__root__") ?? [];
    const totalRoots = rootChildren.length;

    // Spread root children across the width
    const spreadWidth = Math.min(containerWidth - 200, totalRoots * minBranchSpacing);
    const startX = centerX - spreadWidth / 2;

    function layoutNode(
      cloneId: string,
      depth: number,
      parentX: number,
      parentY: number,
      indexInSiblings: number,
      totalSiblings: number,
      parentNode: TreeNode,
    ) {
      const clone = cloneById.get(cloneId);
      if (!clone) return;

      const hash = hashStr(clone.id);
      const hue = (hash * 360) | 0;

      // Calculate position
      let x: number;
      if (depth === 1) {
        // First level: spread evenly
        x =
          totalSiblings === 1
            ? centerX
            : startX + (indexInSiblings / (totalSiblings - 1)) * spreadWidth;
      } else {
        // Deeper levels: offset from parent with some spread
        const offsetRange = Math.max(60, 160 / depth);
        const offset =
          totalSiblings === 1 ? 0 : (indexInSiblings / (totalSiblings - 1) - 0.5) * offsetRange * 2;
        x = parentX + offset;
      }

      // Add organic variation
      const jitterX = (hash - 0.5) * 30;
      const jitterY = (hashStr(clone.id + "y") - 0.5) * 20;
      x += jitterX;
      const y = parentY + levelSpacing + jitterY;

      const angle = Math.atan2(y - parentY, x - parentX);

      const node: TreeNode = {
        id: clone.id,
        name: clone.name,
        slug: clone.slug,
        tags: clone.tags ?? [],
        syncStatus: clone.sync_status,
        githubRepo: clone.github_repo,
        githubOwner: clone.github_owner,
        commitsBehind: clone.commits_behind,
        depth,
        x,
        y,
        parentId: parentNode.id,
        children: [],
        hue,
        angle,
      };

      parentNode.children.push(node);
      allNodes.push(node);

      // Branch from parent to this node
      const thickness = Math.max(1.5, 6 - depth * 1.5);
      allBranches.push({
        from: { x: parentX, y: parentY },
        to: { x, y },
        depth,
        hue,
        thickness,
        fromId: parentNode.id,
        toId: node.id,
        fromRepo: parentNode.githubRepo,
        toRepo: node.githubRepo,
      });

      // Layout children
      const children = childMap.get(cloneId) ?? [];
      children.forEach((childId, i) => {
        layoutNode(childId, depth + 1, x, y, i, children.length, node);
      });
    }

    rootChildren.forEach((id, i) => {
      layoutNode(id, 1, centerX, trunkTopY, i, totalRoots, trunkNode);
    });

    // Calculate actual bounds
    const maxY = allNodes.reduce((m, n) => Math.max(m, n.y), 0) + 100;
    const height = Math.max(containerHeight, maxY);

    return { nodes: allNodes, branches: allBranches, width: containerWidth, height, trunkNode };
  }, [clones, containerWidth, containerHeight]);
}
