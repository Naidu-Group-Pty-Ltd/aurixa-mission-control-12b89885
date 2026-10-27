import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { countClones } from "@/lib/cascadeTargets.pure";
import { describeCascadeOutcome } from "@/lib/cascadeRunOutcome";
import { runCascade } from "@/server/cascade-engine.functions";
import type { spawnCascade } from "@/server/cascade-spawn.functions";

/** What `fireCascade` and `spawnCascade` answer. One definition, read off the server. */
export type LaunchAnswer = Awaited<ReturnType<typeof spawnCascade>>;

export type LaunchOptions = {
  /**
   * When to open the new cascade's page: `always` once it is queued and run
   * (or waiting for approval), `when-waiting` only when it waits for a second
   * operator, and never when omitted. Every toast links to it regardless.
   */
  navigate?: "always" | "when-waiting";
  /** Called once the event exists, before the engine runs. */
  onCreated?: (eventId: string) => void;
};

/**
 * One flow for every cascade a person starts by hand.
 *
 * The server creates and arms the event (`cascade-spawn.functions.ts`). This
 * is what the page does with the answer, written once so `/cascades`, the
 * cascade detail page and the clone page cannot drift apart in what they tell
 * a person:
 *
 * - refused: the server's sentence, linked to the delivery already in flight
 *   when that is the reason;
 * - waiting for a second operator: said so and linked, and nothing is run;
 * - otherwise: queued (linked), the engine run inline as these pages always
 *   ran it, and its outcome (linked).
 *
 * Resolves to the new event's id, or null when nothing was created.
 */
export function useLaunchCascade() {
  const navigate = useNavigate();
  const runCascadeFn = useServerFn(runCascade);

  return useCallback(
    async (
      create: () => Promise<LaunchAnswer>,
      opts: LaunchOptions = {},
    ): Promise<string | null> => {
      const open = (eventId: string) =>
        void navigate({ to: "/cascades/$eventId", params: { eventId } });
      const view = (eventId: string) => ({ label: "View", onClick: () => open(eventId) });

      let answer: LaunchAnswer;
      try {
        answer = await create();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not start the cascade");
        return null;
      }
      if (!answer.ok) {
        toast.error(
          answer.error,
          answer.liveEventId ? { action: view(answer.liveEventId) } : undefined,
        );
        return null;
      }

      const { eventId } = answer;
      opts.onCreated?.(eventId);

      if (answer.awaitingApproval) {
        toast.warning(
          `Waiting for approval: a second operator must approve before this reaches ${countClones(answer.cloneCount)}.`,
          { description: answer.reason ?? undefined, action: view(eventId) },
        );
        if (opts.navigate) open(eventId);
        return eventId;
      }

      toast.info(`Queued ${countClones(answer.cloneCount)} — executing…`, {
        action: view(eventId),
      });
      try {
        const res = await runCascadeFn({ data: { cascadeEventId: eventId } });
        const outcome = describeCascadeOutcome(res);
        toast[outcome.level](outcome.message, { action: view(eventId) });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Engine failed", { action: view(eventId) });
      }
      if (opts.navigate === "always") open(eventId);
      return eventId;
    },
    [navigate, runCascadeFn],
  );
}
