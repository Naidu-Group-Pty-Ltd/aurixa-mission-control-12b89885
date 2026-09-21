/**
 * TreeNodeCircle — a glowing node representing a clone/fork on the tree.
 * Includes tooltip on hover showing clone details.
 * Supports multi-select via Shift/Ctrl-click.
 */

import { motion } from "framer-motion";
import { useState } from "react";
import type { TreeNode } from "./use-tree-layout";

interface Props {
  node: TreeNode;
  index: number;
  highlighted?: boolean;
  selected?: boolean;
  multiSelected?: boolean;
  onSelect?: (node: TreeNode, event: React.MouseEvent) => void;
}

const STATUS_COLORS: Record<string, { fill: string; glow: string }> = {
  in_sync: { fill: "oklch(0.78 0.18 150)", glow: "oklch(0.85 0.22 150)" },
  behind: { fill: "oklch(0.82 0.17 80)", glow: "oklch(0.88 0.20 80)" },
  failed: { fill: "oklch(0.66 0.24 25)", glow: "oklch(0.75 0.28 25)" },
  unknown: { fill: "oklch(0.60 0.10 250)", glow: "oklch(0.70 0.14 250)" },
};

export function TreeNodeCircle({
  node,
  index,
  highlighted,
  selected,
  multiSelected,
  onSelect,
}: Props) {
  const [hovered, setHovered] = useState(false);

  const isTrunk = node.id === "__trunk__";
  const radius = isTrunk ? 18 : Math.max(8, 14 - node.depth * 2);
  const colors = STATUS_COLORS[node.syncStatus] ?? STATUS_COLORS.unknown;
  const isActive = hovered || highlighted || selected || multiSelected;

  const delay = 0.5 + index * 0.06;

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => onSelect?.(node, e)}
      style={{ cursor: isTrunk ? "default" : "pointer" }}
    >
      {/* The node's own target, stated rather than inherited from whatever
          happens to be painted. The labels below are captions and decline
          pointer events, so the circle has to carry the click by itself. */}
      <circle cx={node.x} cy={node.y} r={radius + 10} fill="transparent" />

      {/* Pulse ring for trunk */}
      {isTrunk && (
        <motion.circle
          cx={node.x}
          cy={node.y}
          r={28}
          fill="none"
          stroke="oklch(0.78 0.16 200)"
          strokeWidth={1.5}
          initial={{ r: 18, opacity: 0.6 }}
          animate={{ r: 32, opacity: 0 }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
        />
      )}

      {/* Highlight pulse ring for search */}
      {highlighted && !isTrunk && (
        <motion.circle
          cx={node.x}
          cy={node.y}
          r={radius + 12}
          fill="none"
          stroke="oklch(0.85 0.20 200)"
          strokeWidth={2}
          initial={{ r: radius, opacity: 0.8 }}
          animate={{ r: radius + 20, opacity: 0 }}
          transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
        />
      )}

      {/* Multi-select ring indicator */}
      {multiSelected && !isTrunk && (
        <motion.circle
          cx={node.x}
          cy={node.y}
          r={radius + 5}
          fill="none"
          stroke="oklch(0.80 0.18 260)"
          strokeWidth={2}
          strokeDasharray="4 3"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.8 }}
          transition={{ duration: 0.3 }}
        />
      )}

      {/* Outer glow */}
      <motion.circle
        cx={node.x}
        cy={node.y}
        r={radius + 6}
        fill={isTrunk ? "oklch(0.78 0.16 200)" : colors.glow}
        opacity={0}
        filter={isTrunk ? "url(#trunk-glow)" : "url(#node-glow)"}
        initial={{ opacity: 0, scale: 0 }}
        animate={{ opacity: isActive ? 0.5 : 0.25, scale: 1 }}
        transition={{ delay, duration: 0.8 }}
      />

      {/* Main circle */}
      <motion.circle
        cx={node.x}
        cy={node.y}
        r={radius}
        fill={isTrunk ? "oklch(0.78 0.16 200)" : colors.fill}
        stroke={isTrunk ? "oklch(0.85 0.18 195)" : colors.glow}
        strokeWidth={isActive ? 2.5 : 1.5}
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{
          delay,
          duration: 0.5,
          type: "spring",
          stiffness: 200,
          damping: 15,
        }}
      />

      {/* Inner dot for trunk */}
      {isTrunk && (
        <motion.circle
          cx={node.x}
          cy={node.y}
          r={5}
          fill="oklch(0.14 0.03 250)"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: delay + 0.3, duration: 0.3 }}
        />
      )}

      {/* Label */}
      <motion.text
        x={node.x}
        y={node.y + radius + 16}
        textAnchor="middle"
        fill="oklch(0.85 0.01 240)"
        fontSize={isTrunk ? 13 : 10}
        fontFamily="var(--font-mono)"
        fontWeight={isTrunk ? 700 : 500}
        letterSpacing={isTrunk ? "0.15em" : "0.05em"}
        /**
         * `attrY`, not `y`. On an SVG element framer-motion treats `y` as a
         * TRANSFORM key, so `animate={{ y }}` emits
         * `style="transform:translateY(...)"` — which ADDS to the `y`
         * attribute above rather than replacing it. Measured on the rendered
         * markup for a depth-1 node: `y="448"` beside
         * `transform:translateY(456px)`, putting the name 456 units below the
         * node it names, nearly four levels down the tree. `attrY` is the key
         * that writes the attribute, which is what a baseline is.
         *
         * This is the same trap `membrane-band.tsx` documents from the other
         * side: there an animated `scale` displaced a `transform` PROP; here
         * an animated `y` displaces a `y` ATTRIBUTE. Both come from motion
         * routing a name through the transform pipeline.
         */
        initial={{ opacity: 0, attrY: node.y + radius + 24 }}
        animate={{ opacity: 1, attrY: node.y + radius + 16 }}
        transition={{ delay: delay + 0.2, duration: 0.5 }}
        style={{ pointerEvents: "none" }}
      >
        {isTrunk ? "YGGDRASIL" : node.name}
      </motion.text>

      {/* Status label below name */}
      {!isTrunk && (
        <motion.text
          x={node.x}
          y={node.y + radius + 28}
          textAnchor="middle"
          fill={colors.fill}
          fontSize={8}
          fontFamily="var(--font-mono)"
          fontWeight={400}
          letterSpacing="0.1em"
          /**
           * A label is a caption, never a target. These two sit inside the
           * node's own `<g onClick>`, and a status line runs wide enough to
           * cross the membrane band drawn at the branch midpoint below —
           * measured, it covers both depth-2 bands' click targets on the
           * fleet's own layout, and on one of them its last glyph lands on
           * the painted leaflet. Nodes paint after bands, so without this the
           * caption silently takes the band's clicks. The hit circle above
           * keeps the NODE reachable, so nothing is lost by it.
           */
          style={{ textTransform: "uppercase", pointerEvents: "none" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.7 }}
          transition={{ delay: delay + 0.4, duration: 0.5 }}
        >
          {node.syncStatus.replace("_", " ")}
          {node.commitsBehind > 0
            ? /**
               * `behind · 12 behind` said it twice, and the second one is what
               * made this line wide enough to reach the membrane bands on the
               * branches below it — measured on the fleet's own layout, the
               * pump badge of one and a painted leaflet of another. Where the
               * status IS "behind" the word is already on the line, so the
               * count carries its own unit; anywhere else it still needs one.
               */
              node.syncStatus === "behind"
              ? ` · ${node.commitsBehind}`
              : ` · ${node.commitsBehind} behind`
            : ""}
        </motion.text>
      )}

      {/* Hover tooltip panel */}
      {hovered && !isTrunk && (
        <motion.foreignObject
          x={node.x - 120}
          y={node.y - radius - 75}
          width={240}
          height={65}
          initial={{ opacity: 0, y: node.y - radius - 65 }}
          animate={{ opacity: 1, y: node.y - radius - 75 }}
          transition={{ duration: 0.15 }}
          style={{ pointerEvents: "none" }}
        >
          <div
            style={{
              background: "oklch(0.22 0.025 250)",
              border: "1px solid oklch(1 0 0 / 0.12)",
              borderRadius: 8,
              padding: "8px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "oklch(0.90 0.01 240)",
              backdropFilter: "blur(12px)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2 }}>
              {node.githubOwner}/{node.githubRepo}
            </div>
            <div style={{ opacity: 0.6 }}>
              {node.tags.length > 0 ? node.tags.map((t) => `#${t}`).join(" ") : "no tags"}
            </div>
          </div>
        </motion.foreignObject>
      )}
    </g>
  );
}
