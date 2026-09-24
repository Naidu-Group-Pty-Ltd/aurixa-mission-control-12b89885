/**
 * The membrane between the two parents, drawn on an arch of its own.
 *
 * The same bilayer the vertical bands draw, with the same rule that the
 * drawing IS the data — and two differences, both because this boundary is
 * crossed both ways.
 *
 * **What crosses flows.** Parent-level work moves along the arch in both
 * directions, one lane each way, and passes the membrane through the open
 * passage at its centre. The passage and the flow are there on every lateral
 * boundary because every lateral boundary is crossed both ways and a file no
 * channel names is admitted on every membrane; `lateralBand.pure.ts` sets out
 * why. Each direction also carries an arrowhead on the arch, because the flow
 * moves and a screenshot does not, and a reader who asked for less motion
 * gets none of it.
 *
 * **Each pore carries two lanes.** A lane is what may ENTER the parent it
 * runs toward: the membrane `boundary.toward[that side]` declares. Where a
 * lane is open an ion crosses it and leaves by an arrowhead on the side it
 * enters; where it is closed the lane is plugged solid; where it is gated the
 * plug is drawn in outline.
 *
 * Colour never carries a state alone. The plug is a SHAPE, present or
 * absent, solid or dashed, and the arrowhead says which way a lane runs
 * without the animation — for a reader who cannot separate the fleet's amber
 * from its red, and for a still screenshot.
 *
 * The arch is dashed and inked like a leaflet rather than in a branch's hue,
 * because it is not a line of descent and must not read as one.
 */

import { memo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { LateralBoundary } from "@/lib/cascade/membrane/lateralMembranes.pure";
import {
  LATERAL_ARROW_AT,
  LATERAL_FLOW,
  LATERAL_LANE_OFFSET,
  LATERAL_PASSAGE_WALL_HALF,
  LATERAL_PLUG,
  LATERAL_WALL_HALF,
  lateralArcLength,
  lateralArchArrow,
  lateralFlowTiming,
  lateralLanePath,
  lateralLaneY,
  lateralLayout,
  lateralPores,
  laneCounts,
  placeLateral,
  type LaneState,
  type LateralInto,
  type Point,
} from "./lateralBand.pure";

/** The scene's own palette, in the register `membrane-band.tsx` uses. */
const INK = {
  arch: "oklch(0.72 0.05 240)",
  leaflet: "oklch(0.72 0.05 240)",
  open: "oklch(0.78 0.18 150)",
  closed: "oklch(0.66 0.24 25)",
  gated: "oklch(0.82 0.17 80)",
  undeclared: "oklch(0.72 0.05 240)",
  ion: "oklch(0.88 0.12 150)",
  select: "oklch(0.78 0.16 200)",
  /**
   * Parent-level work, in the arch's own hue lifted toward white: brighter
   * than the leaflet it passes, and never the open lane's green, which says
   * a CHANNEL opened a species rather than that no channel is in the way.
   */
  flow: "oklch(0.9 0.04 230)",
} as const;

const LEAFLET_GAP = 3.4;
/** How far an ion travels either side of the bilayer. */
const ION_REACH = 7;
/** Both sides a boundary is crossed into, in the order the lane runs its passes. */
const DIRECTIONS: readonly LateralInto[] = ["b", "a"];

export interface LateralBandProps {
  boundary: LateralBoundary;
  /** The node drawn for `boundary.sides[0]`. */
  a: Point;
  /** The node drawn for `boundary.sides[1]`. */
  b: Point;
  /** The trunk, which the arch bows toward. */
  toward: Point | null;
  index: number;
  selected: boolean;
  onSelect: (boundary: LateralBoundary) => void;
}

/** A lane's arrowhead, beyond the bilayer on the side the lane enters. */
function LaneArrow({ y, dir, tone }: { y: number; dir: 1 | -1; tone: string }) {
  const tip = dir * LATERAL_ARROW_AT;
  const back = dir * (LATERAL_ARROW_AT - 1.6);
  return (
    <path
      d={`M ${back} ${y - 1.3} L ${tip} ${y} L ${back} ${y + 1.3}`}
      fill="none"
      stroke={tone}
      strokeWidth={0.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/**
 * One lane of one pore. `dir` is the way the lane runs along the band's own x
 * axis — toward whichever parent it enters, which `placement.bSign` settles
 * once the band has been turned upright.
 */
function Lane({
  y,
  dir,
  state,
  delay,
}: {
  y: number;
  dir: 1 | -1;
  state: LaneState;
  delay: number;
}) {
  if (state === "closed" || state === "gated") {
    const tone = state === "closed" ? INK.closed : INK.gated;
    const s = LATERAL_PLUG;
    return (
      /* A plug. Shape, not colour — solid where refused, outlined where a person decides. */
      <rect
        x={-s / 2}
        y={y - s / 2}
        width={s}
        height={s}
        rx={0.8}
        fill={state === "closed" ? tone : "none"}
        stroke={tone}
        strokeWidth={1}
        strokeDasharray={state === "gated" ? "1.2 1" : undefined}
      />
    );
  }

  // Open, or undeclared — both cross. An undeclared lane is drawn in the
  // leaflet's ink with a hollow ion: nothing refuses it, and nothing says so.
  const tone = state === "open" ? INK.open : INK.undeclared;
  return (
    <g>
      <LaneArrow y={y} dir={dir} tone={tone} />
      <motion.circle
        r={1.2}
        fill={state === "open" ? INK.ion : "none"}
        stroke={state === "open" ? undefined : tone}
        strokeWidth={state === "open" ? undefined : 0.7}
        initial={{ cx: -dir * ION_REACH, cy: y, opacity: 0 }}
        animate={{ cx: [-dir * ION_REACH, dir * ION_REACH], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, delay, ease: "linear" }}
      />
    </g>
  );
}

/** The walls of a mouth `half` wide at `y`, in the leaflet's ink: what crosses carries the state. */
function Walls({ y, half }: { y: number; half: number }) {
  return (
    <>
      <path
        d={`M ${-LEAFLET_GAP} ${y - half} L ${-LEAFLET_GAP - 1.6} ${y} L ${-LEAFLET_GAP} ${y + half}`}
        fill="none"
        stroke={INK.leaflet}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      <path
        d={`M ${LEAFLET_GAP} ${y - half} L ${LEAFLET_GAP + 1.6} ${y} L ${LEAFLET_GAP} ${y + half}`}
        fill="none"
        stroke={INK.leaflet}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
    </>
  );
}

function LateralBandImpl({ boundary, a, b, toward, index, selected, onSelect }: LateralBandProps) {
  // SMIL answers to no stylesheet, so a reader who asked for less motion is
  // asked here. Null — the server, a test — draws the flow.
  const reduceMotion = useReducedMotion();
  const placement = placeLateral(a, b, toward);
  const pores = lateralPores(boundary);
  const { slots, top, bottom, runs } = lateralLayout(pores.length);
  const flow = reduceMotion ? null : lateralFlowTiming(lateralArcLength(a, b, placement));
  const [nameA, nameB] = boundary.sides;
  const intoA = laneCounts(pores, "intoA");
  const intoB = laneCounts(pores, "intoB");
  const towardB = placement.bSign;
  const towardA: 1 | -1 = towardB === 1 ? -1 : 1;
  const appear = { delay: 1.1 + index * 0.08, duration: 0.6 };

  const describe = (name: string, c: { closed: number; gated: number; undeclared: number }) =>
    `into ${name}: ${c.closed} closed, ${c.gated} held for a person` +
    (c.undeclared > 0 ? `, ${c.undeclared} no rule speaks for` : "");

  return (
    <g>
      {/* The arch and what travels it. A caption, never a target: the band is
          the control, and a path the width of the diagram taking clicks would
          swallow the pan. Nothing inside turns pointer events back on. */}
      <motion.g
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={appear}
        style={{ pointerEvents: "none" }}
      >
        <path
          d={placement.d}
          fill="none"
          stroke={INK.arch}
          strokeWidth={1.4}
          strokeDasharray="5 4"
          strokeLinecap="round"
          opacity={0.75}
        />
        {DIRECTIONS.map((into) => (
          <path
            key={into}
            d={lateralArchArrow(a, b, placement, into).d}
            fill="none"
            stroke={INK.flow}
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {flow
          ? DIRECTIONS.flatMap((into) => {
              const path = lateralLanePath(a, b, placement, into);
              const dur = `${flow.dur}s`;
              return flow.begins[into].map((begin) => (
                <circle key={`${into}${begin}`} r={LATERAL_FLOW.r} fill={INK.flow} opacity={0}>
                  <animateMotion
                    path={path}
                    dur={dur}
                    begin={`${begin}s`}
                    repeatCount="indefinite"
                    keyPoints={into === "b" ? "0;1" : "1;0"}
                    keyTimes="0;1"
                    calcMode="linear"
                  />
                  <animate
                    attributeName="opacity"
                    values={flow.values.join(";")}
                    keyTimes={flow.keyTimes.join(";")}
                    dur={dur}
                    begin={`${begin}s`}
                    repeatCount="indefinite"
                  />
                </circle>
              ));
            })
          : null}
      </motion.g>

      {/**
       * PLACEMENT AND ANIMATION ON SEPARATE ELEMENTS, for the reason
       * `membrane-band.tsx` records: an animated `scale` on a motion element
       * arrives as an inline `style` transform and silently discards a
       * `transform` prop beside it. The plain `<g>` places the band; the
       * motion element inside animates it.
       */}
      <g transform={`translate(${placement.cx} ${placement.cy}) rotate(${placement.angle})`}>
        <motion.g
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={appear}
          style={{ cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(boundary);
          }}
          onKeyDown={(e) => {
            // A `<g>` with `role="button"` gets none of a real button's
            // behaviour; without this it is a control a keyboard can reach
            // and cannot operate.
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            onSelect(boundary);
          }}
          role="button"
          tabIndex={0}
          aria-label={`${boundary.label}: parent-level work crosses both ways; ${describe(nameB, intoB)}; ${describe(nameA, intoA)}`}
        >
          {/* A generous target: the bilayer itself is under seven units wide. */}
          <rect
            x={-LATERAL_ARROW_AT - 5}
            y={top - 6}
            width={(LATERAL_ARROW_AT + 5) * 2}
            height={bottom - top + 12}
            fill="transparent"
          />

          {selected ? (
            <rect
              x={-LATERAL_ARROW_AT - 2.5}
              y={top - 4}
              width={(LATERAL_ARROW_AT + 2.5) * 2}
              height={bottom - top + 8}
              rx={LATERAL_ARROW_AT + 2.5}
              fill="oklch(0.78 0.16 200 / 0.10)"
              stroke="oklch(0.78 0.16 200 / 0.55)"
              strokeWidth={1}
            />
          ) : null}

          {/* The two leaflets, broken at each pore and at the passage. */}
          {[-LEAFLET_GAP, LEAFLET_GAP].map((side) => (
            <g key={side}>
              {runs.map(([from, to]) => (
                <line
                  key={`${side}:${from}`}
                  x1={side}
                  y1={from}
                  x2={side}
                  y2={to}
                  stroke={INK.leaflet}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  opacity={0.85}
                />
              ))}
            </g>
          ))}

          {/* The passage, on the arch: open both ways. Its traffic is the
              arch's own flow, so it carries arrowheads and no ions of its own. */}
          <g>
            <Walls y={0} half={LATERAL_PASSAGE_WALL_HALF} />
            <LaneArrow y={lateralLaneY("b", LATERAL_LANE_OFFSET)} dir={towardB} tone={INK.flow} />
            <LaneArrow y={lateralLaneY("a", LATERAL_LANE_OFFSET)} dir={towardA} tone={INK.flow} />
          </g>

          {pores.map((pore, i) => {
            const y = slots[i];
            return (
              <g key={pore.species}>
                <Walls y={y} half={LATERAL_WALL_HALF} />
                <Lane
                  y={y + lateralLaneY("b", LATERAL_LANE_OFFSET)}
                  dir={towardB}
                  state={pore.intoB}
                  delay={1.4 + index * 0.1 + i * 0.3}
                />
                <Lane
                  y={y + lateralLaneY("a", LATERAL_LANE_OFFSET)}
                  dir={towardA}
                  state={pore.intoA}
                  delay={2.5 + index * 0.1 + i * 0.3}
                />
              </g>
            );
          })}
        </motion.g>
      </g>
    </g>
  );
}

export const LateralBand = memo(LateralBandImpl);
