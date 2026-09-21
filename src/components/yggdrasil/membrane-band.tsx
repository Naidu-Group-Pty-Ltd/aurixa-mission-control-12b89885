/**
 * The membrane drawn across a cascade branch.
 *
 * A bilayer — two leaflets — with a pore for each channel the boundary
 * declares. The drawing is the data: an open pore is a gap with ions moving
 * through it, a closed one is plugged, a gated one is plugged in outline
 * because the answer depends on the delivery rather than on the species.
 *
 * Colour alone never carries the state. The plug is a SHAPE, present or
 * absent, so a closed channel survives greyscale and a reader who cannot
 * separate the fleet's amber from its red.
 */

import { memo } from "react";
import { motion } from "framer-motion";
import type { Membrane } from "@/lib/cascade/membrane/membrane.pure";
import {
  BAND_HALF_SPAN,
  leafletRuns,
  placeMembrane,
  slotOffsets,
  type BranchEnds,
} from "./membraneGeometry.pure";

/** The scene's own palette, in the register `tree-node.tsx` established. */
const INK = {
  leaflet: "oklch(0.72 0.05 240)",
  open: "oklch(0.78 0.18 150)",
  closed: "oklch(0.66 0.24 25)",
  gated: "oklch(0.82 0.17 80)",
  pump: "oklch(0.78 0.16 200)",
  ion: "oklch(0.88 0.12 150)",
} as const;

const LEAFLET_GAP = 3.4;
const SLOT_SPACING = 12;

export interface MembraneBandProps {
  branch: BranchEnds;
  membrane: Membrane;
  index: number;
  selected: boolean;
  onSelect: (membrane: Membrane) => void;
}

function MembraneBandImpl({ branch, membrane, index, selected, onSelect }: MembraneBandProps) {
  const { cx, cy, angle } = placeMembrane(branch);
  const channels = membrane.channels;
  const pumps = membrane.standing.filter((o) => o.kind === "pump").length;
  const slots = slotOffsets(channels.length, SLOT_SPACING);
  const appear = { delay: 0.9 + index * 0.08, duration: 0.5 };

  return (
    /**
     * PLACEMENT AND ANIMATION ON SEPARATE ELEMENTS, and this is not tidiness.
     *
     * `buildSVGAttrs` in motion-dom does `state.attrs = state.style` for any
     * non-`<svg>` SVG element, then lifts `attrs.transform` back into
     * `style.transform`. An animated `scale` therefore arrives as an INLINE
     * `style="transform:scale(0.6)"`, and an inline declaration beats a
     * presentation attribute in every conforming engine — so a `transform`
     * prop on the same element is silently discarded and the group draws at
     * the origin, unrotated. Verified against the installed 12.40.0: the
     * settled state is `transform: none`, because `buildTransform` returns
     * the literal "none" when every transform value is default.
     *
     * A plain `<g>` carries the placement; the motion element inside carries
     * only what it animates. `membraneIsDrawn.contract.test.ts` asserts the
     * two never share an element again.
     */
    <g transform={`translate(${cx} ${cy}) rotate(${angle})`}>
      <motion.g
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={appear}
        style={{ cursor: "pointer" }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(membrane);
        }}
        onKeyDown={(e) => {
          // `role="button"` and `tabIndex` announce this as a control and put
          // it in the tab order; without a key handler it is a control a
          // keyboard can reach and cannot operate, which is worse than one it
          // cannot reach at all. An SVG `<g>` gets none of a real `<button>`'s
          // behaviour for free.
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          onSelect(membrane);
        }}
        role="button"
        tabIndex={0}
        aria-label={`${membrane.label}: ${channels.length} channel(s), ${pumps} pump(s)`}
      >
        {/* A generous invisible target: the band itself is 7 units tall. */}
        <rect
          x={-12}
          y={-BAND_HALF_SPAN - 6}
          width={24}
          height={(BAND_HALF_SPAN + 6) * 2}
          fill="transparent"
        />

        {selected ? (
          <rect
            x={-9}
            y={-BAND_HALF_SPAN - 4}
            width={18}
            height={(BAND_HALF_SPAN + 4) * 2}
            rx={9}
            fill="oklch(0.78 0.16 200 / 0.10)"
            stroke="oklch(0.78 0.16 200 / 0.55)"
            strokeWidth={1}
          />
        ) : null}

        {/* The two leaflets, broken at each pore. */}
        {[-LEAFLET_GAP, LEAFLET_GAP].map((side) => (
          <g key={side}>
            {leafletRuns(slots).map(([a, b]) => (
              <line
                key={`${side}:${a}`}
                x1={side}
                y1={a}
                x2={side}
                y2={b}
                stroke={INK.leaflet}
                strokeWidth={1.6}
                strokeLinecap="round"
                opacity={0.85}
              />
            ))}
          </g>
        ))}

        {channels.map((channel, i) => {
          const y = slots[i];
          const tone =
            channel.state === "closed"
              ? INK.closed
              : channel.state === "gated"
                ? INK.gated
                : INK.open;
          return (
            <g key={`${channel.species}:${channel.state}`}>
              {/* The pore's own walls. */}
              <path
                d={`M ${-LEAFLET_GAP} ${y - 4} L ${-LEAFLET_GAP - 1.6} ${y} L ${-LEAFLET_GAP} ${y + 4}`}
                fill="none"
                stroke={tone}
                strokeWidth={1.4}
                strokeLinecap="round"
              />
              <path
                d={`M ${LEAFLET_GAP} ${y - 4} L ${LEAFLET_GAP + 1.6} ${y} L ${LEAFLET_GAP} ${y + 4}`}
                fill="none"
                stroke={tone}
                strokeWidth={1.4}
                strokeLinecap="round"
              />

              {channel.state === "open" ? (
                <motion.circle
                  r={1.5}
                  fill={INK.ion}
                  initial={{ cx: -7, cy: y, opacity: 0 }}
                  animate={{ cx: [-7, 7], opacity: [0, 1, 1, 0] }}
                  transition={{
                    duration: 1.8,
                    repeat: Infinity,
                    delay: 1.2 + index * 0.1 + i * 0.35,
                    ease: "linear",
                  }}
                />
              ) : (
                /* A plug. Shape, not colour — it survives greyscale. */
                <rect
                  x={-2.6}
                  y={y - 2.6}
                  width={5.2}
                  height={5.2}
                  rx={1.2}
                  fill={channel.state === "closed" ? tone : "none"}
                  stroke={tone}
                  strokeWidth={1.3}
                  strokeDasharray={channel.state === "gated" ? "1.6 1.4" : undefined}
                />
              )}
            </g>
          );
        })}

        {/* The pumps that already run at this boundary, as one count. */}
        {pumps > 0 ? (
          <g transform={`translate(0 ${BAND_HALF_SPAN - 1})`}>
            <circle r={5.4} fill="oklch(0.16 0.03 250)" stroke={INK.pump} strokeWidth={1.1} />
            <text
              y={2.6}
              textAnchor="middle"
              fontSize={6.4}
              fontFamily="var(--font-mono)"
              fill={INK.pump}
              transform={`rotate(${-angle})`}
            >
              {pumps}
            </text>
          </g>
        ) : null}
      </motion.g>
    </g>
  );
}

export const MembraneBand = memo(MembraneBandImpl);
