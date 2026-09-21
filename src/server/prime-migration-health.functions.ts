/**
 * The whole withheld set, for the page that lists it.
 *
 * A third door beside `prime-ledger.functions.ts` and
 * `prime-migration-fix.functions.ts`, and the split is the same one they
 * already make: that one holds READINGS about the prime's position, the other
 * holds the ACT, and this one holds a reading that costs BODIES. Keeping it
 * apart means each can be refused on its own — a budget that will not buy
 * twenty-five blobs can still buy the counts the ledger card draws — and it
 * means the read-only assertion over each file stays a property of its shape
 * rather than something somebody has to remember.
 *
 * ## One lane, at the scan floor
 *
 * This is a measurement, and `githubBudget.pure.ts` states the asymmetry: a
 * measurement postponed costs a stale number, while an act postponed costs a
 * clone sitting a migration behind the prime. So it yields where every other
 * reading yields, and when it is refused it says the reading did not happen
 * rather than drawing an empty corpus.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane, flushGithubUsage } from "@/server/githubUsageMeter";
import { readPrimeCorpusHealth, type PrimeCorpusHealth } from "./primeMigrationHealth.server";

/**
 * The vocabulary the page names, as types, through this one door.
 *
 * A route is bundled for the browser, so `src/server/**` is denied to it for
 * VALUES; types are erased before that boundary exists. Nothing here is a door
 * held open for a type nobody walks through — every name below is drawn.
 */
export type {
  CorpusFacts,
  Idempotency,
  IdempotencyReading,
  MigrationSurvey,
  OversizeFile,
  SurveyStanding,
  VersionCollision,
} from "./primeMigrationDiagnosis.pure";
export type { PrimeCorpusHealth } from "./primeMigrationHealth.server";

export type PrimeCorpusHealthResult =
  | ({ ok: true } & PrimeCorpusHealth)
  | { ok: false; error: string };

export const fetchPrimeCorpusHealth = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<PrimeCorpusHealthResult> => {
    beginGithubLane("prime-corpus-health");

    const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
    if (!spend.proceed) {
      return {
        ok: false,
        error: `Not read — ${spend.why}. Nothing about the prime's migrations has changed; try again once the window resets.`,
      };
    }

    try {
      const health = await readPrimeCorpusHealth(supabaseAdmin);
      return { ok: true, ...health };
    } catch (e) {
      // A read that threw is reported as one that did not happen. Drawing a
      // corpus of zero files over a failed listing would be the mistake this
      // whole surface is written against.
      return {
        ok: false,
        error: e instanceof Error ? e.message : "The prime's migration corpus could not be read.",
      };
    } finally {
      await flushGithubUsage();
    }
  });
