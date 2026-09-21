/**
 * Everything one of the prime's migrations can have DONE to it.
 *
 * Four operations over one version: diagnose it, run it, plan a repair for it,
 * and propose that repair. A separate door from `prime-ledger.functions.ts` on
 * purpose. That one holds READINGS and is asserted read-only by source
 * position; this one holds the ACTS. Putting an act behind the same door would
 * make that assertion a thing somebody has to remember rather than a thing the
 * file shape guarantees.
 *
 * The two plans here — the diagnosis and the repair plan — are readings, and
 * they sit beside their acts rather than with the other readings because each
 * exists only as the thing its act is decided from. A page that can plan a
 * repair and not open it is a page with a dead button.
 *
 * ## Two budgets, because they are two different kinds of spend
 *
 * The diagnosis and the repair plan yield at the SCAN floor: they are
 * measurements, and `githubBudget.pure.ts` states the asymmetry in as many
 * words — a measurement postponed costs a stale number. The dispatch and the
 * proposal yield at the ACTOR floor, far below it, because an apply postponed
 * costs a clone sitting a migration behind the prime, which is the sentence
 * that floor was written for.
 *
 * ## What the browser may say, and what it may not
 *
 * It may name a version. It may not say what that version's verdict is, and it
 * may not send back a patched body. Both acts re-read and re-decide
 * server-side and refuse unless the FRESH reading permits it — see
 * `primeMigrationDispatch.server.ts` and `primeMigrationRemedy.server.ts` for
 * why that is not merely belt-and-braces. A patch that travelled through the
 * browser would be a request field asserting the server's own conclusion, on
 * a path that ends in a commit.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane, flushGithubUsage } from "@/server/githubUsageMeter";
import {
  diagnosePrimeMigration,
  type PrimeMigrationDiagnosisReport,
} from "./primeMigrationDiagnosis.server";
import { dispatchPrimeMigration, type DispatchResult } from "./primeMigrationDispatch.server";
import {
  openPrimeMigrationRepair,
  planPrimeMigrationRepair,
  type RepairPlanReport,
  type RepairPlanResult,
  type RepairProposalResult,
} from "./primeMigrationRemedy.server";

/**
 * The diagnosis vocabulary, as types, through one door.
 *
 * A route is bundled for the browser, so `src/server/**` is denied to it for
 * VALUES; types are erased before that boundary exists. This list is exactly
 * what the page names — a door held open for types nobody walks through is the
 * dead export this repository is ratcheted against, and it typechecks, which
 * is why it survives.
 */
export type {
  DiagnosisVerdict,
  DryRunOutcome,
  Hazard,
  HazardKind,
  MigrationDiagnosis,
  VersionCollision,
} from "./primeMigrationDiagnosis.pure";
export type {
  Repair,
  RepairKind,
  RepairRefusal,
  RefusalKind,
  RemedyOutcome,
  RemedyPlan,
} from "./primeMigrationRemedy.pure";
export type { PrimeMigrationDiagnosisReport } from "./primeMigrationDiagnosis.server";
export type { DispatchResult } from "./primeMigrationDispatch.server";
export type {
  RepairPlanReport,
  RepairPlanResult,
  RepairProposalResult,
  RepairTarget,
} from "./primeMigrationRemedy.server";

/** 14 digits, the only shape a migration version is ever written in. */
const version = z.string().regex(/^\d{14}$/, "a migration version is fourteen digits");

export type MigrationDiagnosisResult =
  | ({ ok: true } & PrimeMigrationDiagnosisReport)
  | { ok: false; error: string };

export const fetchMigrationDiagnosis = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { version: string }) => z.object({ version }).parse(d))
  .handler(async ({ data }): Promise<MigrationDiagnosisResult> => {
    beginGithubLane("prime-migration-diagnosis");

    const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return {
        ok: false,
        error: `Not read — ${spend.why}. Nothing about this migration has changed; try again once the window resets.`,
      };
    }

    try {
      const report = await diagnosePrimeMigration(supabaseAdmin, data.version);
      return { ok: true, ...report };
    } catch (e) {
      // A diagnosis that threw is reported as one that did not happen. It
      // writes nothing and rolls back everything it sent, so the honest
      // answer is the reason and no verdict at all.
      return {
        ok: false,
        error: e instanceof Error ? e.message : "This migration could not be diagnosed.",
      };
    } finally {
      await flushGithubUsage();
    }
  });

/**
 * Run it, through the prime's own workflow.
 *
 * `supabaseAdmin` for the diagnosis — `prime_config` is read under it because
 * RLS FILTERS rather than erroring, and a declined read would print "the prime
 * is not configured" about a prime that is. `context.userId` is the person,
 * and it reaches the audit row rather than a verdict.
 */
export const applyPrimeMigration = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { version: string }) => z.object({ version }).parse(d))
  .handler(async ({ data, context }): Promise<DispatchResult> => {
    beginGithubLane("prime-migration-apply");

    const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return {
        ok: false,
        error: `Not dispatched — ${spend.why}. Nothing was applied.`,
        diagnosis: null,
      };
    }

    try {
      return await dispatchPrimeMigration(supabaseAdmin, data.version, context.userId ?? null);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "The dispatch failed. Nothing was applied.",
        diagnosis: null,
      };
    } finally {
      await flushGithubUsage();
    }
  });

/**
 * What a mechanical repair to this migration would change. Writes nothing.
 *
 * Read-only in the strongest sense available: the patched text it composes
 * never leaves the server as something that can be sent back. The page draws
 * the rows and the summary; the act below composes its own patch from a fresh
 * read.
 */
export const fetchMigrationRepairPlan = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { version: string }) => z.object({ version }).parse(d))
  .handler(async ({ data }): Promise<RepairPlanResult> => {
    beginGithubLane("prime-migration-repair-plan");

    const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return {
        ok: false,
        error: `Not read — ${spend.why}. Nothing about this migration has changed; try again once the window resets.`,
        report: null,
      };
    }

    try {
      // The patched text is dropped HERE and never reaches the response type,
      // so there is no shape in which it could travel to the browser.
      const { report }: { report: RepairPlanReport } = await planPrimeMigrationRepair(
        supabaseAdmin,
        data.version,
      );
      return { ok: true, ...report };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "No repair could be planned for this migration.",
        report: null,
      };
    } finally {
      await flushGithubUsage();
    }
  });

/**
 * Open the repair as a pull request on the prime.
 *
 * `context.userId` is the person, and it reaches the audit row rather than the
 * commit: the commit is the GitHub App's, which is what every other write this
 * product makes to a repository already is.
 */
export const proposePrimeMigrationRepair = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { version: string }) => z.object({ version }).parse(d))
  .handler(async ({ data, context }): Promise<RepairProposalResult> => {
    beginGithubLane("prime-migration-repair");

    const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return {
        ok: false,
        error: `Not proposed — ${spend.why}. Nothing was changed.`,
        report: null,
      };
    }

    try {
      return await openPrimeMigrationRepair(supabaseAdmin, data.version, context.userId ?? null);
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof Error ? e.message : "The repair could not be proposed. Nothing was changed.",
        report: null,
      };
    } finally {
      await flushGithubUsage();
    }
  });
