/**
 * MEMBRANE DETAIL — what a boundary lets through, and what runs there already.
 *
 * The panel is the membrane's own record read back: the rationale it carries,
 * the channels it declares with each state's reason and note, and the standing
 * organs that were filtering this boundary before any of this was drawn.
 *
 * Two rules it answers to.
 *
 * A state is never carried by colour alone. Each channel prints the WORD
 * ("Open" / "Closed" / "Gated") beside its dot, because the fleet's amber and
 * its red are one hue apart in dark mode and a reader who cannot separate them
 * would otherwise be told nothing.
 *
 * And database vocabulary never reaches the operator — the same rule
 * `partnerRoster.pure.ts` answers to in the clones. `ExclusionReason` spells
 * `manual_reconcile`; this panel prints "Held for a person to reconcile".
 */

import { motion } from "framer-motion";
import { X, ArrowRight, CircleDot, Ban, CircleDashed, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { IonChannel, Membrane } from "@/lib/cascade/membrane/membrane.pure";
import type { IonSpeciesName } from "@/lib/cascade/membrane/ionSpecies.pure";

interface Props {
  membrane: Membrane;
  onClose: () => void;
}

const CHANNEL_INK: Record<IonChannel["state"], string> = {
  open: "oklch(0.78 0.18 150)",
  closed: "oklch(0.66 0.24 25)",
  gated: "oklch(0.82 0.17 80)",
};

const CHANNEL_WORD: Record<IonChannel["state"], string> = {
  open: "Open",
  closed: "Closed",
  gated: "Gated",
};

/**
 * What each species is, in the operator's words rather than the engine's.
 *
 * Exhaustive BY TYPE rather than by a fallback: `Record<IonSpeciesName, …>`
 * means a species added without a label fails the typecheck, where
 * `Record<string, …>` with a `?? channel.species` would quietly print
 * `routed_crm_name` at somebody. The clones hold the same rule under a test
 * that refuses any underscore-cased identifier in a rendered field.
 */
const SPECIES_LABEL: Record<IonSpeciesName, string> = {
  routed_crm_name: "Routed CRM function name",
  security_baseline: "Security inventory baseline",
  function_declaration: "Edge function declaration",
  spec: "Test specification",
  backend_ref: "Backend project reference",
};

/** `ExclusionReason` never reaches the page as written. Exhaustive for the same reason. */
const REASON_LABEL: Record<IonChannel["reason"], string> = {
  protected: "Never crosses",
  manual_reconcile: "Held for a person to reconcile",
  oversize: "Too large to carry",
};

function channelIcon(state: IonChannel["state"]) {
  if (state === "open") return CircleDot;
  if (state === "closed") return Ban;
  return CircleDashed;
}

export function MembraneDetailPanel({ membrane, onClose }: Props) {
  const channels = membrane.channels;
  const pumps = membrane.standing.filter((o) => o.kind === "pump");
  const standingChannels = membrane.standing.filter((o) => o.kind === "channel");

  return (
    <motion.div
      className="absolute bottom-4 left-4 z-40 max-h-[calc(100%-2rem)] w-96 overflow-y-auto border border-border/60 bg-background/95 p-5 shadow-2xl backdrop-blur-xl"
      initial={{ opacity: 0, x: -40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -40, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Membrane
          </p>
          <h3 className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-xs">
            <span className="text-foreground">{membrane.from}</span>
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="text-foreground">{membrane.to}</span>
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Close membrane detail"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{membrane.rationale}</p>

      <div className="mt-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Ion channels · {channels.length}
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {channels.map((channel) => {
            const Icon = channelIcon(channel.state);
            const ink = CHANNEL_INK[channel.state];
            return (
              <div
                key={`${channel.species}:${channel.within}`}
                className="border border-border/40 bg-muted/20 p-3"
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: ink }} />
                  <span className="text-xs font-medium">{SPECIES_LABEL[channel.species]}</span>
                  <span
                    className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider"
                    style={{ color: ink }}
                  >
                    {CHANNEL_WORD[channel.state]}
                  </span>
                </div>
                <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                  within {channel.within}
                  {channel.state === "open" ? null : <> · {REASON_LABEL[channel.reason]}</>}
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {channel.note}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Already running here · {pumps.length} pump{pumps.length === 1 ? "" : "s"} ·{" "}
          {standingChannels.length} filter{standingChannels.length === 1 ? "" : "s"}
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          {membrane.standing.map((organ) => (
            <div key={organ.name} className="flex items-start gap-2">
              <Waypoints
                className="mt-0.5 h-3 w-3 shrink-0"
                style={{
                  color: organ.kind === "pump" ? "oklch(0.78 0.16 200)" : "oklch(0.72 0.05 240)",
                }}
              />
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-foreground">
                  {organ.name}
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    {organ.kind === "pump" ? "pump" : "channel"}
                  </span>
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{organ.does}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
