/**
 * YggdrasilTree — the main SVG canvas that renders the entire
 * world tree visualization with all its layers.
 * Supports pan & zoom, single-select, and multi-select with range selection.
 */

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Clone } from "@/lib/queries";
import { useTreeLayout, type TreeNode } from "./use-tree-layout";
import { TreeBranchPath } from "./tree-branch";
import { TreeNodeCircle } from "./tree-node";
import { AmbientParticles } from "./ambient-particles";
import { RunicInscription } from "./runic-inscription";
import { YGGDRASIL_FILTER_DEFS } from "./tree-filters";
import { YggdrasilNodePanel } from "./node-detail-panel";
import { SubtreeStatsPanel } from "./subtree-stats-panel";
import { MultiSelectComparisonPanel } from "./multi-select-comparison";
import { MembraneBand } from "./membrane-band";
import { MembraneDetailPanel } from "./membrane-detail-panel";
import { resolveMembrane } from "@/lib/cascade/membrane/fleetMembranes.pure";
import type { Membrane } from "@/lib/cascade/membrane/membrane.pure";

interface Props {
  clones: Clone[];
  primeName?: string;
  highlightId?: string | null;
  zoom: number;
  pan: { x: number; y: number };
  onPanChange: (pan: { x: number; y: number }) => void;
  onLayoutReady?: (nodes: TreeNode[], dims: { width: number; height: number }) => void;
  onNodeSelect?: (node: TreeNode | null) => void;
  selectedNodeId?: string | null;
  multiSelectedIds?: string[];
  onMultiSelectChange?: (ids: string[]) => void;
}

/**
 * Given two nodes that share a parent, return all sibling IDs between them (inclusive).
 */
function getSiblingRange(a: TreeNode, b: TreeNode, allNodes: TreeNode[]): string[] {
  if (a.parentId !== b.parentId || !a.parentId) return [a.id, b.id];
  const parent = allNodes.find((n) => n.id === a.parentId);
  if (!parent) return [a.id, b.id];
  const siblings = parent.children;
  const idxA = siblings.findIndex((s) => s.id === a.id);
  const idxB = siblings.findIndex((s) => s.id === b.id);
  if (idxA === -1 || idxB === -1) return [a.id, b.id];
  const lo = Math.min(idxA, idxB);
  const hi = Math.max(idxA, idxB);
  return siblings.slice(lo, hi + 1).map((s) => s.id);
}

export function YggdrasilTree({
  clones,
  primeName,
  highlightId,
  zoom,
  pan,
  onPanChange,
  onLayoutReady,
  onNodeSelect,
  selectedNodeId,
  multiSelectedIds = [],
  onMultiSelectChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1000, height: 700 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Track the anchor node for Shift range selection
  const shiftAnchorRef = useRef<string | null>(null);

  // Which membrane the operator has opened. Keyed by the EDGE rather than by
  // the branch index, so a re-layout (a resize, a clone arriving) cannot move
  // the selection onto a different boundary while the panel stays open.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const multiSelectedSet = new Set(multiSelectedIds);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const obs = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      const height = Math.max(600, width * 0.65);
      setDimensions({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const layout = useTreeLayout(clones, dimensions.width, dimensions.height);

  const selectedNode = selectedNodeId
    ? (layout.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  const multiSelectedNodes = layout.nodes.filter((n) => multiSelectedSet.has(n.id));

  useEffect(() => {
    onLayoutReady?.(layout.nodes, dimensions);
  }, [layout.nodes, dimensions, onLayoutReady]);

  const handleNodeSelect = useCallback(
    (n: TreeNode, event: React.MouseEvent) => {
      const isTrunk = n.id === "__trunk__";
      if (isTrunk) {
        onNodeSelect?.(null);
        onMultiSelectChange?.([]);
        shiftAnchorRef.current = null;
        return;
      }

      if (event.shiftKey) {
        // Range selection: select all siblings between anchor and this node
        const anchor = shiftAnchorRef.current;
        if (anchor) {
          const anchorNode = layout.nodes.find((nd) => nd.id === anchor);
          if (anchorNode) {
            const rangeIds = getSiblingRange(anchorNode, n, layout.nodes);
            // Merge with existing selection (union)
            const merged = new Set(multiSelectedIds);
            for (const id of rangeIds) merged.add(id);
            onMultiSelectChange?.([...merged]);
            return;
          }
        }
        // No anchor yet — start multi-select with this node as anchor
        shiftAnchorRef.current = n.id;
        const merged = new Set(multiSelectedIds);
        if (merged.has(n.id)) {
          merged.delete(n.id);
        } else {
          merged.add(n.id);
        }
        onMultiSelectChange?.([...merged]);
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        // Toggle single node in multi-select
        shiftAnchorRef.current = n.id;
        const merged = new Set(multiSelectedIds);
        if (merged.has(n.id)) {
          merged.delete(n.id);
        } else {
          merged.add(n.id);
        }
        onMultiSelectChange?.([...merged]);
        return;
      }

      // Normal click — single select, clear multi-select
      shiftAnchorRef.current = null;
      onMultiSelectChange?.([]);
      onNodeSelect?.(n);
    },
    [onNodeSelect, onMultiSelectChange, multiSelectedIds, layout.nodes],
  );

  const handleRemoveFromMultiSelect = useCallback(
    (id: string) => {
      onMultiSelectChange?.(multiSelectedIds.filter((x) => x !== id));
    },
    [onMultiSelectChange, multiSelectedIds],
  );

  const handleCloseComparison = useCallback(() => {
    onMultiSelectChange?.([]);
    shiftAnchorRef.current = null;
  }, [onMultiSelectChange]);

  // Pan handlers
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button, a, foreignObject")) return;
      setDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pan],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      onPanChange({
        x: dragStart.current.panX + (e.clientX - dragStart.current.x),
        y: dragStart.current.panY + (e.clientY - dragStart.current.y),
      });
    },
    [dragging, onPanChange],
  );
  const onPointerUp = useCallback(() => setDragging(false), []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
  }, []);

  // One membrane per branch, resolved from the two repositories the branch
  // joins. `resolveMembrane` never refuses an edge it has not measured, so a
  // clone provisioned tomorrow still draws a band with the standing organs on
  // it rather than drawing nothing.
  const membranes = useMemo(
    () =>
      layout.branches.map((branch) => ({
        branch,
        edge: `${branch.fromRepo}->${branch.toRepo}`,
        membrane: resolveMembrane(branch.fromRepo, branch.toRepo),
      })),
    [layout.branches],
  );

  const selectedMembrane = selectedEdge
    ? (membranes.find((m) => m.edge === selectedEdge)?.membrane ?? null)
    : null;

  const handleMembraneSelect = useCallback((membrane: Membrane) => {
    setSelectedEdge((current) => {
      const edge = `${membrane.from}->${membrane.to}`;
      return current === edge ? null : edge;
    });
  }, []);

  const showSinglePanel = selectedNode && multiSelectedIds.length === 0;
  const showComparisonPanel = multiSelectedNodes.length >= 2;

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden border border-border/40 bg-background"
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
      tabIndex={0}
    >
      {/* Atmospheric background gradient */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 60% 40% at 50% 15%, oklch(0.78 0.16 200 / 0.06), transparent),
            radial-gradient(ellipse 80% 50% at 50% 80%, oklch(0.10 0.02 270 / 0.5), transparent),
            linear-gradient(180deg, oklch(0.16 0.018 250) 0%, oklch(0.10 0.015 260) 100%)
          `,
        }}
      />

      <svg
        width={dimensions.width}
        height={dimensions.height}
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        className="relative z-10"
        style={{ display: "block" }}
        dangerouslySetInnerHTML={{ __html: YGGDRASIL_FILTER_DEFS }}
      />

      <svg
        width={dimensions.width}
        height={dimensions.height}
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        className="absolute inset-0 z-20"
        style={{ display: "block" }}
      >
        <g
          transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}
          style={{
            transformOrigin: `${dimensions.width / 2}px ${dimensions.height / 2}px`,
            transition: dragging ? "none" : "transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          <AmbientParticles
            width={dimensions.width}
            height={dimensions.height}
            count={clones.length > 0 ? 30 + clones.length * 3 : 20}
          />

          <motion.rect
            x={0}
            y={dimensions.height * 0.6}
            width={dimensions.width}
            height={dimensions.height * 0.4}
            fill="url(#ground-gradient)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 2 }}
          />

          {layout.trunkNode && (
            <>
              <RunicInscription x={layout.trunkNode.x - 30} y={layout.trunkNode.y + 30} count={4} />
              <RunicInscription x={layout.trunkNode.x + 30} y={layout.trunkNode.y + 40} count={3} />
            </>
          )}

          {layout.trunkNode && (
            <motion.line
              x1={layout.trunkNode.x}
              y1={0}
              x2={layout.trunkNode.x}
              y2={layout.trunkNode.y}
              stroke="oklch(0.60 0.12 200)"
              strokeWidth={5}
              strokeLinecap="round"
              filter="url(#branch-glow)"
              initial={{ y2: 0 }}
              animate={{ y2: layout.trunkNode.y }}
              transition={{ duration: 0.8, ease: "easeOut" }}
            />
          )}

          {layout.branches.map((branch, i) => (
            <TreeBranchPath key={i} branch={branch} index={i} />
          ))}

          {/* The membranes sit ON the branches, so they are drawn after them
              and before the nodes — a node is the destination, and a band
              painted over one would hide the thing it filters for. */}
          {membranes.map(({ branch, edge, membrane }, i) => (
            <MembraneBand
              key={edge}
              branch={branch}
              membrane={membrane}
              index={i}
              selected={selectedEdge === edge}
              onSelect={handleMembraneSelect}
            />
          ))}

          {layout.nodes.map((node, i) => (
            <TreeNodeCircle
              key={node.id}
              node={node}
              index={i}
              highlighted={highlightId === node.id}
              selected={selectedNodeId === node.id}
              multiSelected={multiSelectedSet.has(node.id)}
              onSelect={handleNodeSelect}
            />
          ))}

          <motion.text
            x={dimensions.width / 2}
            y={30}
            textAnchor="middle"
            fill="oklch(0.78 0.16 200)"
            fontSize={10}
            fontFamily="var(--font-mono)"
            fontWeight={400}
            letterSpacing="0.3em"
            filter="url(#rune-glow)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            transition={{ delay: 1.5, duration: 1.5 }}
          >
            {primeName ? `— ${primeName.toUpperCase()} —` : "— THE WORLD TREE —"}
          </motion.text>
        </g>
      </svg>

      {clones.length === 0 && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center">
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 2, duration: 0.8 }}
          >
            <p className="font-mono text-lg text-muted-foreground">
              The tree awaits its first roots.
            </p>
            <p className="mt-2 font-mono text-xs text-muted-foreground/60">
              Add clones to watch Yggdrasil grow.
            </p>
          </motion.div>
        </div>
      )}

      <AnimatePresence>
        {showSinglePanel && selectedNode.children.length > 0 && (
          <SubtreeStatsPanel node={selectedNode} zoom={zoom} pan={pan} dimensions={dimensions} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSinglePanel && (
          <YggdrasilNodePanel
            node={selectedNode}
            allNodes={layout.nodes}
            onClose={() => onNodeSelect?.(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selectedMembrane && (
          <MembraneDetailPanel membrane={selectedMembrane} onClose={() => setSelectedEdge(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showComparisonPanel && (
          <MultiSelectComparisonPanel
            nodes={multiSelectedNodes}
            onClose={handleCloseComparison}
            onRemoveNode={handleRemoveFromMultiSelect}
          />
        )}
      </AnimatePresence>

      {multiSelectedIds.length === 1 && (
        <div className="absolute bottom-4 right-4 z-30 border border-border/40 /80 px-3 py-2 backdrop-blur-lg">
          <p className="font-mono text-[10px] text-muted-foreground">
            Shift+click another node to select range · Ctrl+click to add individually
          </p>
        </div>
      )}
    </div>
  );
}
