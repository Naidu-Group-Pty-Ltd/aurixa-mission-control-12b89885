/**
 * Diagnose one of the prime's migrations, and — on one verdict only — run it.
 *
 * A separate door from `prime-ledger.functions.ts` on purpose. That one holds
 * two READINGS and is asserted read-only by source position; this one holds an
 * ACT. Putting the act behind the same door would make that assertion a thing
 * somebody has to remember rather than a thing the file shape guarantees.
 *
 * ## Two budgets, because they are two different kinds of spend
 *
 * The diagnosis yields at the SCAN floor: it is a measurement, and
 * `githubBudget.pure.ts` states the asymmetry in as many words — a measurement
 * postponed costs a stale number. The dispatch yields at the ACTOR floor, far
 * below it, because an apply postponed costs a clone sitting a migration
 * behind the prime, which is the sentence that floor was written for.
 *
 * ## What the browser may say, and what it may not
 *
 * It may name a version. It may not say what that version's verdict is. The
 * dispatch re-runs the whole diagnosis server-side and refuses unless the
 * FRESH reading permits it — see `primeMigrationDispatch.server.ts` for why
 * that is not merely belt-and-braces.
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
export type { PrimeMigrationDiagnosisReport } from "./primeMigrationDiagnosis.server";
export type { DispatchResult } from "./primeMigrationDispatch.server";

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
