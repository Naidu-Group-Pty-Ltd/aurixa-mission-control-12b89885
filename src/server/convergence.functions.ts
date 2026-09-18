/**
 * What the sync card shows, read through the server.
 *
 * ## Why a server function and not a browser read
 *
 * Every other card on the clone page reads its table straight from the
 * browser, and for most of them that is fine. It is not fine here, for the
 * reason this repository has now paid for three times over — on
 * `feature_flags`, on `useAmlV3Flags` and on the partner Passport: **RLS
 * FILTERS rather than erroring**, so a refused read returns `[]` with HTTP 200
 * and is indistinguishable from a table with nothing in it.
 *
 * That distinction is the whole substance of this card. "No observation yet"
 * and "we could not read the observations" are different sentences, and the
 * second one must never be drawn as the first — still less as `converged`. A
 * server read hands back an `error` object, so the two stay apart.
 *
 * ## It reads the pointer too, and returns what it compared
 *
 * The card is handed a `clone` row by its page, and comparing against that
 * prop would let the comparison and the drawing disagree by a refresh. So the
 * ledger position is read HERE, used for the comparison, and returned — the
 * card draws the numbers the comparison actually used.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  readConvergenceForCard,
  type ConvergenceCardReading,
  type LedgerPosition,
  type ObservationRow,
} from "@/server/cascade/convergenceReading.pure";
import type { ConvergenceState } from "@/server/cascade/convergence.pure";
import {
  BLOCKAGE_POLICY,
  type BlockageClass,
  type BlockageOwner,
} from "@/server/cascade/blockageTaxonomy.pure";

/** How many open blockages the card will draw before it stops listing them. */
export const CARD_BLOCKAGE_LIMIT = 6;

export type CardBlockage = {
  id: string;
  cls: BlockageClass;
  owner: BlockageOwner;
  /** The taxonomy's own operator prose. Never the class name. */
  what: string;
  detail: string;
  firstSeenAt: string;
  selfHeals: boolean;
};

export type CloneConvergenceView = {
  reading: ConvergenceCardReading;
  ledger: LedgerPosition;
  /**
   * Open blockages for this clone, or `null` when the ledger could not be
   * read — which is not the same as none, and is not drawn as none.
   */
  blockages: CardBlockage[] | null;
};

export const readCloneConvergence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneId: string }) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<CloneConvergenceView> => {
    const { supabase } = context;

    const [observation, clone, blockages] = await Promise.all([
      supabase
        .from("clone_convergence_observations")
        .select(
          "observed_at, state, owed_count, owed_sample, held_count, oversize_held, compared_count, deletion_candidates, unchanged_since, last_converged_at, slo_minutes, why",
        )
        .eq("clone_id", data.cloneId)
        .order("observed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("clones")
        .select("sync_status, commits_behind")
        .eq("id", data.cloneId)
        .maybeSingle(),
      supabase
        .from("clone_sync_blockages")
        .select("id, class, owner, detail, first_seen_at, self_heals")
        .eq("clone_id", data.cloneId)
        .is("cleared_at", null)
        .order("first_seen_at", { ascending: true })
        .limit(CARD_BLOCKAGE_LIMIT),
    ]);

    const ledger: LedgerPosition = {
      syncStatus: clone.data?.sync_status ?? null,
      commitsBehind: clone.data?.commits_behind ?? null,
    };

    if (observation.error) {
      return {
        reading: { kind: "unavailable", why: observation.error.message },
        ledger,
        blockages: null,
      };
    }

    const row = observation.data;
    const parsed: ObservationRow | null = row
      ? {
          observedAt: row.observed_at,
          state: row.state as ConvergenceState,
          owedCount: row.owed_count,
          heldCount: row.held_count,
          oversizeHeld: row.oversize_held,
          comparedCount: row.compared_count,
          deletionCandidates: row.deletion_candidates,
          owedSample: row.owed_sample ?? [],
          unchangedSince: row.unchanged_since,
          lastConvergedAt: row.last_converged_at,
          sloMinutes: row.slo_minutes,
          why: row.why,
        }
      : null;

    return {
      reading: readConvergenceForCard({ now: new Date(), observation: parsed, ledger }),
      ledger,
      // A failed blockage read is `null` and never `[]`: "nothing is blocking
      // this clone" is a claim, and a read that did not happen cannot make it.
      blockages: blockages.error
        ? null
        : (blockages.data ?? []).map((b) => {
            const cls = b.class as BlockageClass;
            return {
              id: b.id,
              cls,
              owner: b.owner as BlockageOwner,
              what: BLOCKAGE_POLICY[cls]?.what ?? b.detail,
              detail: b.detail,
              firstSeenAt: b.first_seen_at,
              selfHeals: b.self_heals,
            };
          }),
    };
  });
