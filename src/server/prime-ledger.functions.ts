/**
 * The prime's SQL position, and one clone held against it.
 *
 * Two server functions rather than one, because they answer at different
 * costs and must fail apart:
 *
 *   - `fetchPrimeMigrationLedger` reads the prime's repository and the prime's
 *     own ledger. It spends GitHub, so it yields at the scan floor.
 *   - `fetchCloneComparison` reads Mission Control's own fleet tables for a
 *     chosen clone. It is the page's interactive half and must stay
 *     responsive; when the budget has refused the ledger, the comparison still
 *     answers on code and blockages and says the migration half is unknown.
 *
 * ## Why both are admin-gated
 *
 * Both resolve `prime_config` and one of them runs SQL against the prime's
 * project over the Management API. That is the same privilege
 * `readPrimeLedgerReconciliation` is gated on, and for the same reason: the
 * Management token is not a per-caller credential, so authorisation has to
 * happen here rather than being left to the database.
 *
 * ## Two clients, deliberately
 *
 * `prime_config` is read through the ADMIN client. RLS FILTERS rather than
 * erroring, so a policy that declined that read would return no row — and
 * "the prime is not configured" is exactly what this page would then print
 * about a prime that is. That trap has been paid for three times in the
 * product repo (`useAmlV3Flags`, `useBuilderStockMarketplaceFlag`, the partner
 * surface) and once here; the rule from it is read through the server, not the
 * table.
 *
 * The fleet tables are read through the CALLER'S client, so a page that shows
 * a fleet-wide reading cannot become a way to read rows the operator could not
 * read directly. Authorisation happened in the middleware; visibility is still
 * the database's.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane, flushGithubUsage } from "@/server/githubUsageMeter";
import {
  buildPrimeLedgerAssessment,
  readPrimeMigrationLedgerReport,
  type PrimeMigrationLedgerReport,
} from "./primeMigrationLedger.server";
import { frontierIsEstablished } from "./primeMigrationLedger.pure";
import {
  comparePrimeAgainstClone,
  type CloneComparisonResult,
} from "./primeCloneComparison.server";

/**
 * The reading's vocabulary, as types, through one door.
 *
 * A route is bundled for the browser, so `src/server/**` is denied to it for
 * VALUES. Types are erased before that boundary exists, so they travel — but
 * only through a module the page is already allowed to name. Every judgement
 * below is made on the server and arrives in the payload; the page re-derives
 * none of them.
 *
 * This list is exactly what the page names and nothing more. A door held open
 * for types nobody walks through is the same dead export the rest of this
 * repository is ratcheted against — it simply typechecks, which is why it
 * survives.
 */
export type { PrimeLedgerReading, WithheldRow } from "./primeMigrationLedger.pure";
export type {
  CloneComparison,
  ComparedBlocker,
  ComparisonVerdict,
} from "./primeCloneComparison.pure";

export type PrimeMigrationLedgerResult =
  | ({ ok: true } & PrimeMigrationLedgerReport)
  | { ok: false; error: string };

/**
 * The prime's repository against the prime's own ledger.
 *
 * Yields at the SCAN floor. `githubBudget.pure.ts` states the asymmetry in as
 * many words — a measurement postponed costs a stale number, while an apply
 * postponed costs a clone sitting a migration behind the prime — and this is a
 * measurement however urgently somebody is looking at it.
 */
export const fetchPrimeMigrationLedger = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<PrimeMigrationLedgerResult> => {
    // Named before anything is spent, so these calls are attributed to this
    // reading rather than to whichever lane ran last in this isolate.
    beginGithubLane("prime-migration-ledger");

    const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return {
        ok: false,
        error: `Not read — ${spend.why}. The prime's SQL position is unchanged; try again once the window resets.`,
      };
    }

    try {
      const report = await readPrimeMigrationLedgerReport(supabaseAdmin);
      return { ok: true, ...report };
    } catch (e) {
      // A reading that threw is reported as one that did not happen. It writes
      // nothing and has nothing downstream to poison, so the honest answer is
      // the reason and no numbers.
      return {
        ok: false,
        error: e instanceof Error ? e.message : "The prime's migration ledger could not be read.",
      };
    } finally {
      await flushGithubUsage();
    }
  });

/**
 * The fleet roster, and — when one is chosen — that clone held against the
 * prime.
 *
 * `cloneId` is nullable on purpose: with nothing selected this is the
 * selector's own data, which must arrive whether or not the prime can be read
 * at all. A page whose clone list depends on the prime being reachable has no
 * list in exactly the state an operator opened it to investigate.
 */
export const fetchCloneComparison = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { cloneId: string | null }) =>
    z.object({ cloneId: z.string().uuid().nullable() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<CloneComparisonResult> => {
    /*
      THE PRIME'S SIDE IS RESOLVED HERE, AND ONLY WHERE IT IS NEEDED.

      With no clone selected there is nothing to compare, so the roster is read
      and not a single GitHub call is made. That matters more than it looks:
      the selector is what an operator lands on, and buying a tree walk to draw
      a drop-down would spend the window before anybody had asked a question.
    */
    let primeHeadSha: string | null = null;
    let frontier: string | null = null;
    let runnableVersions: string[] | null = null;

    if (data.cloneId) {
      beginGithubLane("prime-clone-comparison");
      const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
      if (spend.proceed) {
        try {
          const assessed = await buildPrimeLedgerAssessment(supabaseAdmin);
          primeHeadSha = assessed.headSha;
          if (frontierIsEstablished(assessed.assessment.reading)) {
            frontier = assessed.assessment.reading.frontier;
            runnableVersions = assessed.assessment.runnableVersions;
          }
        } catch {
          /*
            Left null on purpose, and NOT re-thrown.

            The code position and the open blockages are Mission Control's own
            rows; they are still true when the prime cannot be reached. Each
            standing renders its own `unknown` sentence rather than a clean
            verdict built on a question nobody asked.
          */
        } finally {
          await flushGithubUsage();
        }
      }
    }

    return comparePrimeAgainstClone(context.supabase, {
      cloneId: data.cloneId,
      primeHeadSha,
      frontier,
      runnableVersions,
    });
  });
