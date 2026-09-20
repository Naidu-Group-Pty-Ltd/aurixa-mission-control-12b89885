/**
 * The canopy view: the fleet as a tree, with the panels the diagram already has.
 *
 * This owns two things the scene deliberately does not.
 *
 * **What happens when WebGL cannot start.** A blank rectangle that reports
 * nothing is the shape of a broken page, so a context that will not open is
 * announced here and the caller is told to offer the diagram instead — the
 * same rule the rest of this console answers to, where a reading that failed
 * is a distinct answer from a reading of nothing.
 *
 * **What a selected clone means.** The scene hands back a clone id from a
 * raycast; everything after that — the detail panel, the subtree stats — is the
 * page's existing machinery, reached through the same props the SVG uses. A
 * clone picked in the canopy and a clone picked in the diagram are the same
 * selection, because they go through the same callback.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Clone } from "@/lib/queries";
import { buildSakuraTree } from "./sakuraGeometry.pure";
import { SakuraScene } from "./sakura-scene";
import { YggdrasilNodePanel } from "./node-detail-panel";
import type { TreeNode } from "./use-tree-layout";

interface Props {
  clones: Clone[];
  primeName?: string;
  highlightId?: string | null;
  selectedNodeId?: string | null;
  onNodeSelect?: (node: TreeNode | null) => void;
  /** Told when WebGL cannot start, so the toolbar can say so and fall back. */
  onUnavailable?: (reason: string) => void;
}

export function YggdrasilCanopy({
  clones,
  primeName,
  highlightId,
  selectedNodeId,
  onNodeSelect,
  onUnavailable,
}: Props) {
  const tree = useMemo(() => buildSakuraTree(clones, primeName), [clones, primeName]);

  /**
   * The clones as `TreeNode`s, once.
   *
   * The panels were written against the SVG layout's node type and read a
   * lineage out of the whole set, so handing them a node built ad hoc would
   * give a breadcrumb of one. Depth comes from the canopy's own branches, and
   * the coordinates are zero on purpose: an (x, y) from a 3D pick is a point
   * in the wrong space, and a panel that reads one would be reading a number
   * that means nothing here.
   */
  const nodes: TreeNode[] = useMemo(() => {
    const depthOf = new Map(tree.branches.map((b) => [b.id, b.depth]));
    return clones.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      tags: c.tags ?? [],
      syncStatus: c.sync_status,
      githubRepo: c.github_repo,
      githubOwner: c.github_owner,
      commitsBehind: c.commits_behind,
      depth: depthOf.get(c.id) ?? 1,
      x: 0,
      y: 0,
      parentId: c.parent_clone_id ?? null,
      children: [],
      hue: 0,
      angle: 0,
    }));
  }, [clones, tree]);
  const [reason, setReason] = useState<string | null>(null);
  const notified = useRef(false);

  useEffect(() => {
    if (reason && !notified.current) {
      notified.current = true;
      onUnavailable?.(reason);
    }
  }, [reason, onUnavailable]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  if (reason) {
    return (
      <div className="flex h-[560px] items-center justify-center border border-border/40 p-6">
        <div className="max-w-sm text-center">
          <p className="font-mono text-xs text-muted-foreground">
            The canopy needs WebGL, which this browser did not start.
          </p>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">{reason}</p>
          <p className="mt-3 font-mono text-[10px] text-muted-foreground/70">
            The diagram shows the same fleet and needs none.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative border border-border/40">
      <SakuraScene
        tree={tree}
        highlightId={highlightId}
        selectedId={selectedNodeId}
        onSelect={(cloneId) => {
          onNodeSelect?.(nodes.find((n) => n.id === cloneId) ?? null);
        }}
        onUnavailable={setReason}
      />

      {/* A legend, because the canopy encodes three things in its FORM and an
          operator has no way to learn them from the picture alone. */}
      <div className="pointer-events-none absolute left-3 top-3 space-y-1 font-mono text-[10px] text-muted-foreground/80">
        <div>{clones.length} clones · trunk carries the fleet</div>
        <div>thicker limb = more clones beneath it</div>
        <div>bare branch = sync failed · buds = behind</div>
      </div>

      {selectedNode && (
        <div className="absolute right-3 top-3 w-72">
          <YggdrasilNodePanel
            node={selectedNode}
            allNodes={nodes}
            onClose={() => onNodeSelect?.(null)}
          />
        </div>
      )}
    </div>
  );
}
