import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getPrimeHealth, type PrimeHealth } from "./prime-health.server";

export type {
  PrimeHealth,
  PrimeRepoRef,
  PrimeHeadCommit,
  PrimeCommitReading,
  CloneDelivery,
  DeliveryReading,
} from "./prime-health.server";

/**
 * The reading's own vocabulary, re-exported for the page.
 *
 * A route may not import `src/server/**` for VALUES — TanStack Start's
 * import-protection refuses it, correctly, because a route is bundled for the
 * browser. Types are erased before that boundary exists, so they travel; this
 * is the one door they come through, rather than the page reaching into the
 * pure module and looking like it could call it.
 */
export type {
  CheckOutcome,
  HeadCheckReading,
  PrimeGate,
  PrimePosture,
  PrimeSafety,
  PullRequestCi,
  PullRequestReading,
  SafetyTone,
  WorkflowSummary,
} from "./primeHealth.pure";

/**
 * The prime repository's own health, read live.
 *
 * Deliberately NOT cached. `/health` caches because it probes every clone and
 * the first visit costs N uptime pings; this is six GitHub calls against one
 * repository, and the question it answers — "is prime green right now, and is
 * that commit travelling?" — is worthless a snapshot old. An operator opens
 * this page precisely at the moment they need today's answer.
 *
 * It is `context.supabase` rather than the admin client, so `prime_config`,
 * `cascade_events` and `cascade_results` are all read under the caller's own
 * RLS. A page that shows a fleet-wide reading must not be a way to read rows
 * the operator could not read directly.
 */
export const fetchPrimeHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PrimeHealth> => {
    return getPrimeHealth(context.supabase);
  });
