/**
 * A membrane's channels and standing organs, as both membrane panels print them.
 *
 * The vertical membrane's panel and the lateral boundary's print the same
 * things — a channel's species, its state, where it has an opinion and why;
 * the organs already running at the boundary — and two copies of that markup
 * are two copies that drift: the day one learns to print a glob and the other
 * does not, an operator reads two different rules for one channel. So each is
 * drawn once, here.
 *
 * The words come from `membraneVocabulary.ts`, which answers the two rules
 * this list lives by: a state is never carried by colour alone, and database
 * vocabulary never reaches the operator.
 */

import { CircleDot, Ban, CircleDashed, Waypoints } from "lucide-react";
import type { IonChannel, StandingOrgan } from "@/lib/cascade/membrane/membrane.pure";
import { CHANNEL_INK, CHANNEL_WORD, REASON_LABEL, SPECIES_LABEL } from "./membraneVocabulary";

function channelIcon(state: IonChannel["state"]) {
  if (state === "open") return CircleDot;
  if (state === "closed") return Ban;
  return CircleDashed;
}

/**
 * A channel's state as its icon, in its ink. Decorative: it is never drawn
 * without `ChannelStateWord` beside it, which says the state in a word.
 */
export function ChannelStateIcon({ state }: { state: IonChannel["state"] }) {
  const Icon = channelIcon(state);
  return (
    <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: CHANNEL_INK[state] }} aria-hidden />
  );
}

/**
 * A channel's state as the word the list prints beside it, in its ink.
 * Exported so that anything else naming a state — the lateral band's key —
 * names it in these words and this ink, rather than a copy of them.
 */
export function ChannelStateWord({
  state,
  className = "",
}: {
  state: IonChannel["state"];
  className?: string;
}) {
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-wider ${className}`.trim()}
      style={{ color: CHANNEL_INK[state] }}
    >
      {CHANNEL_WORD[state]}
    </span>
  );
}

export function MembraneChannelList({ channels }: { channels: readonly IonChannel[] }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {channels.map((channel) => (
        <div
          key={`${channel.species}:${channel.within}`}
          className="border border-border/40 bg-muted/20 p-3"
        >
          <div className="flex items-center gap-2">
            <ChannelStateIcon state={channel.state} />
            <span className="text-xs font-medium">{SPECIES_LABEL[channel.species]}</span>
            <ChannelStateWord state={channel.state} className="ml-auto shrink-0" />
          </div>
          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
            within {channel.within}
            {channel.state === "open" ? null : <> · {REASON_LABEL[channel.reason]}</>}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{channel.note}</p>
        </div>
      ))}
    </div>
  );
}

/** The organs that run at a boundary besides its channels — the filters and pumps it already had. */
export function MembraneStandingList({ standing }: { standing: readonly StandingOrgan[] }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {standing.map((organ) => (
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
  );
}
