/**
 * The prime's ledger gap, as evidence an operator can read.
 *
 * ## Why this file exists
 *
 * `buildPrimeLedgerReconciliation` has been the answer to the fleet's largest
 * standing question since it was written, and it had ZERO CALL SITES. Its own
 * module header states what it computes; `blockageTaxonomy.pure.ts` names it
 * in the comment that defines `prime_ledger_hole` — "the one function that
 * computes object-level evidence for exactly this" — and `MIGRATION_PIPELINE.md`
 * documents its three verdicts. Nothing anywhere called it.
 *
 * This repository has paid for that class twice already: three builder-portal
 * components and twenty-eight stylesheet rules, merged, deployed and never
 * rendered. An unused export typechecks, lints and builds.
 *
 * ## What it answers, and why the answer matters here
 *
 * `scopeCorpusToPrime` withholds from every clone any migration the prime's
 * own ledger does not record. That rule is right — it is what stopped two
 * `rollback_*` scripts undoing an RLS fix on a tenant. But "absent from the
 * ledger" conflates two states with opposite remedies:
 *
 *   - the prime never ran it     → a person dispatches it on the prime
 *   - the prime ran it untracked → the ledger is wrong, not the schema
 *
 * Only the second is recoverable here, and only the object-level reading tells
 * them apart. Until this had a caller, an operator looking at a held clone had
 * the count and no way to ask which kind of hole they were looking at.
 *
 * ## Three things this deliberately does NOT do
 *
 * **It never writes.** Not the prime's ledger, not a clone's, not an audit
 * row, not a blockage. The verdicts are evidence and never permission, which
 * the pure module says three times and `readOnlyReport.contract.test.ts`
 * asserts rather than trusts.
 *
 * **It never runs on page load.** The report is up to `limit` GitHub blob
 * fetches against an installation shared with every other lane; drawing it on
 * mount would put that on every visit to the fleet page. It is a press.
 *
 * **It yields at the SCAN floor, not the actor floor.** This is a
 * measurement, and `githubBudget.pure.ts` states the asymmetry in as many
 * words: "a measurement postponed costs a stale number, while an apply
 * postponed costs a clone sitting a migration behind the prime." An operator
 * pressing a button does not change what the spend is for.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import type { ReconciliationReport } from "@/server/primeLedgerReconciliation.server";

/**
 * How many ledger-absent versions one press reads bodies for.
 *
 * Newest first, because the recent gap is what holds clones today and a body
 * is a GitHub round trip. Measured on the prime's corpus 20 Sep 2026: 118
 * migrations sit after `20260831060152`, so this covers the whole window an
 * operator is actually triaging with room over.
 */
export const RECONCILIATION_BODY_CAP = 120;

export type PrimeLedgerReconciliationResult =
  | ({ ok: true } & Omit<Extract<ReconciliationReport, { ok: true }>, "ok">)
  | { ok: false; error: string };

export const readPrimeLedgerReconciliation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<PrimeLedgerReconciliationResult> => {
    // Named before anything is spent, so these calls are attributed to this
    // report rather than to whichever lane ran last in this isolate.
    beginGithubLane("prime-ledger-reconciliation");

    const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return {
        ok: false,
        error: `Not measured — ${spend.why}. The reading is unchanged; press again once the window resets.`,
      };
    }

    /*
      ON THE SERVICE ROLE, FOR THE REASON `fleetMigrationSync` GIVES AND ONE
      MORE THAT IS SPECIFIC TO THIS READ.

      `requireAdmin` is built on `requireSupabaseAuth`, whose client is the
      publishable key carrying the user's JWT. `resolvePrimeSource` returns
      `null` when it finds no `prime_config` row — and RLS FILTERS rather than
      erroring, so a policy that declined this read would be indistinguishable
      from a deployment whose prime is not configured. The report would say
      "The prime repo source is not configured." about a prime that is.

      That is the trap `useAmlV3Flags`, `useBuilderStockMarketplaceFlag` and
      the partner surface each paid for in the product repo, and the rule from
      it is the same one: read through the server, not the table.

      Authorisation is unchanged and happened above, in `requireAdmin`.
    */
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildPrimeLedgerReconciliation } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/primeLedgerReconciliation.server"
    );

    try {
      const report = await buildPrimeLedgerReconciliation(supabaseAdmin, {
        limit: RECONCILIATION_BODY_CAP,
      });
      return report;
    } catch (e) {
      // A measurement that threw is reported as one that did not happen. It
      // has no ledger to leave a mark in and nothing downstream to poison —
      // the whole point of a read-only report — so the honest answer is the
      // reason and no numbers.
      return {
        ok: false,
        error: e instanceof Error ? e.message : "The reconciliation could not be computed.",
      };
    }
  });
