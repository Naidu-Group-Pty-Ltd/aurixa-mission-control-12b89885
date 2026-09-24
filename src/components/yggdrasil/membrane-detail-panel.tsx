/**
 * MEMBRANE DETAIL — what a boundary lets through, and what runs there already.
 *
 * The panel is the membrane's own record read back: the rationale it carries,
 * the channels it declares with each state's reason and note, and the standing
 * organs that were filtering this boundary before any of this was drawn.
 *
 * Its channels and organs are drawn by `membrane-lists.tsx`, which the
 * lateral boundary's panel draws its own with, in `membraneVocabulary.ts`'s
 * words: a state is never carried by colour alone, and database vocabulary
 * never reaches the operator. The reasons are recorded there.
 */

import { motion } from "framer-motion";
import { X, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Membrane } from "@/lib/cascade/membrane/membrane.pure";
import { MembraneChannelList, MembraneStandingList } from "./membrane-lists";

interface Props {
  membrane: Membrane;
  onClose: () => void;
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
      // The diagram behind this panel pans on a pointer-down anywhere inside
      // it, and captures the pointer to do so — so a drag on this panel's
      // scrollbar, or across its text, would move the tree instead. The panel
      // is not the canvas.
      onPointerDown={(e) => e.stopPropagation()}
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
        <MembraneChannelList channels={channels} />
      </div>

      <div className="mt-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Already running here · {pumps.length} pump{pumps.length === 1 ? "" : "s"} ·{" "}
          {standingChannels.length} filter{standingChannels.length === 1 ? "" : "s"}
        </p>
        <MembraneStandingList standing={membrane.standing} />
      </div>
    </motion.div>
  );
}
