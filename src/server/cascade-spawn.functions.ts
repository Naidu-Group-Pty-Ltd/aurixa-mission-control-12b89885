/**
 * The two ways a person starts a cascade by hand.
 *
 * `fireCascade` is `/cascades`: a mode, a scope and the selection under it.
 * `spawnCascade` is a delivery to named clones: "Retry as" and "Roll back" on
 * the cascade detail page, and "Cascade now" on a clone's own page.
 *
 * Both create and arm the event, and neither runs the engine. The page runs
 * it with `runCascade`, as it always has, so a person is shown the queued
 * event (with a link to it) before a pass that can take most of a minute. If
 * that run never starts or dies part way, the drain claims the event.
 *
 * `requireOperator`, because the write policy on `cascade_events` is
 * `is_operator`: the people who could fire a cascade from the browser before
 * this can fire one now, and nobody else. `requireAdmin` would have quietly
 * taken the ability away from operators.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { Constants } from "@/integrations/supabase/types";
import { requireOperator } from "@/integrations/supabase/role-middleware";
import { CASCADE_SCOPES } from "@/lib/cascadeTargets.pure";
import { fireOperatorCascade, spawnOperatorCascade } from "./cascade/operatorCascade.server";

const mode = z.enum(Constants.public.Enums.cascade_mode);
const id = z.string().uuid();

const fireInput = z.object({
  mode,
  scope: z.enum(CASCADE_SCOPES),
  tags: z.array(z.string().max(200)).max(200).default([]),
  cloneIds: z.array(id).max(1000).default([]),
  /** The number of clones the confirmation named. */
  confirmedCount: z.number().int().min(0),
});

// No `.min(1)` on the clone list: an empty one is refused by the planner in a
// sentence a person can read, not by a schema error.
const spawnInput = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("retry"), mode, of: id, cloneId: id }),
  z.object({ intent: z.literal("rollback"), mode, of: id, cloneIds: z.array(id).max(1000) }),
  z.object({ intent: z.literal("redeliver"), mode, cloneId: id }),
]);

type FireCascadeInput = z.input<typeof fireInput>;
type SpawnCascadeInput = z.input<typeof spawnInput>;

export const fireCascade = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((d: FireCascadeInput) => fireInput.parse(d))
  .handler(async ({ data, context }) =>
    fireOperatorCascade(context.supabase, { userId: context.userId, ...data }),
  );

export const spawnCascade = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((d: SpawnCascadeInput) => spawnInput.parse(d))
  .handler(async ({ data, context }) =>
    spawnOperatorCascade(context.supabase, { userId: context.userId, request: data }),
  );
