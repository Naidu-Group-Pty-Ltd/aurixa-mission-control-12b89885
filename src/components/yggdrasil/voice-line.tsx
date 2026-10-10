// The voice line of one deployment, for the node panel.
//
// A clone's voice stack follows its CRM line: a GoHighLevel clone is built from
// the dependent line's head, a native clone from the independent line's head,
// and converting a clone parks the stack it leaves and opens the one it joins.
// That makes the voice line a fact about the clone's position in the tree,
// which is why it is drawn here as well as on the clone's own page.
//
// Read-only. The build, the custody steps and the GoHighLevel credentials are
// on the clone page's card; two places that can act on one stack is how the two
// come to disagree.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Mic } from "lucide-react";
import { getVoiceLineage } from "@/lib/voice-stack.functions";
import {
  describeVoiceLine,
  isVoiceStackStatus,
  VOICE_STACK_STATUS_COPY,
} from "@/lib/voiceStack.pure";

const TONE_CLASS = {
  neutral: "text-muted-foreground",
  busy: "text-primary",
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
} as const;

export function VoiceLine({ cloneId }: { cloneId: string }) {
  const read = useServerFn(getVoiceLineage);
  // One fleet-wide read shared by every node the operator opens, refreshed on
  // the drain's own cadence rather than per click.
  const q = useQuery({
    queryKey: ["voice-lineage"],
    queryFn: () => read(),
    staleTime: 60_000,
  });

  if (q.isLoading) {
    return <p className="font-mono text-[11px] text-muted-foreground">Reading the voice line…</p>;
  }
  // A failed read is said as one, never drawn as "not provisioned".
  if (q.isError) {
    return <p className="font-mono text-[11px] text-warning">The voice line could not be read.</p>;
  }
  const entry = q.data?.find((e) => e.cloneId === cloneId);
  if (!entry) {
    return (
      <p className="font-mono text-[11px] text-muted-foreground">
        This deployment is not in the voice register.
      </p>
    );
  }
  const tone =
    entry.role === "stack" && isVoiceStackStatus(entry.status)
      ? TONE_CLASS[VOICE_STACK_STATUS_COPY[entry.status].tone]
      : TONE_CLASS.neutral;
  return (
    <div className="flex flex-col gap-0.5">
      <p className={`flex items-center gap-1.5 font-mono text-[11px] ${tone}`}>
        <Mic className="h-3 w-3 shrink-0" />
        {describeVoiceLine(entry)}
      </p>
      {entry.parkedLines.length > 0 ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          Parked from a previous line:{" "}
          {entry.parkedLines.map((m) => (m === "dependent" ? "GoHighLevel" : "native")).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
