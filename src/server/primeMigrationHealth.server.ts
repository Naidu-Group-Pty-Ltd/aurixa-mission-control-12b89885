/**
 * The whole withheld set at once, read without asking the prime's database
 * about any of it.
 *
 * `primeMigrationDiagnosis.server.ts` answers about ONE migration and spends
 * two Management API statements and a rolled-back trial run doing it. That is
 * the right price for the file an operator has chosen. It is the wrong price
 * for the list they choose from: this prime withholds enough migrations that
 * diagnosing each to draw a table would be hundreds of round trips against a
 * production project, and the page would take minutes to paint.
 *
 * So this reads three things and stops:
 *
 *   1. the corpus listing   — one GitHub tree, already cached 60s in-process
 *   2. the prime's ledger   — one statement, through the SAME assessment the
 *                             ledger card prints, so the two cannot disagree
 *   3. up to `SURVEY_LIMIT` bodies — blobs, fetched a few at a time
 *
 * ## Why it reuses the ledger assessment rather than deriving its own
 *
 * `buildPrimeLedgerAssessment` already answers "which migrations is the prime
 * holding back", and it is what the ledger card on `/prime` renders. A second
 * computation of that question would eventually disagree with the first, and
 * the disagreement would be invisible — both numbers are plausible and neither
 * names its source. The tree read is cached, so reusing it costs nothing.
 *
 * ## Bounded, three ways
 *
 * The **set** is bounded by `PrimeLedgerReading.withheld`, which is capped at
 * `WITHHELD_ROWS` newest-first while `withheldCount` stays exact — so a page
 * that surveys twenty-five of three hundred says so rather than implying the
 * corpus is small. The **concurrency** is bounded at `BODY_CONCURRENCY`,
 * because a burst of twenty-five blob requests is what a rate limiter
 * notices. And each **body** is bounded by the corpus ceiling, which refuses
 * before the round trip wherever the listing carried a size.
 *
 * ## Read-only, structurally
 *
 * Nothing here writes and nothing here runs SQL against the prime beyond the
 * one `select version from schema_migrations` the ledger assessment already
 * makes. There is no `runSqlOnProject` in this file at all — the survey is a
 * statement about bytes, and the act that a diagnosis unlocks lives in its own
 * module so the thing that READS cannot become the thing that WRITES by a
 * later edit.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  MAX_MIGRATION_BYTES,
  openPrimeMigrationCorpus,
  resolvePrimeSource,
} from "./prime-backend.server";
import { withdrawalNotes } from "./migrationWithdrawals.pure";
import { OversizedMigrationError } from "./oversizedMigration.pure";
import { buildPrimeLedgerAssessment, type PrimeLedgerRepoRef } from "./primeMigrationLedger.server";
import type { PrimeLedgerReading, WithheldRow } from "./primeMigrationLedger.pure";
import {
  corpusFacts,
  surveyMigration,
  type CorpusFacts,
  type MigrationSurvey,
  type SurveyInput,
} from "./primeMigrationDiagnosis.pure";

type Db = SupabaseClient<Database>;

/**
 * How many withheld migrations get their bodies read on one pass.
 *
 * Equal to the ledger reading's own `WITHHELD_ROWS` by construction — that is
 * the list this surveys, so a different number here would either leave rows
 * un-surveyed on the page that carries them or fetch bodies for rows nothing
 * draws.
 */
export const SURVEY_LIMIT = 25;

/** How many blobs are in flight at once. */
export const BODY_CONCURRENCY = 4;

export type PrimeCorpusHealth = {
  /** The prime repo the listing came from, or null when it is not configured. */
  repo: PrimeLedgerRepoRef | null;
  /** The commit the listing was taken at. */
  headSha: string | null;
  /** The ledger card's own reading, not a second derivation of it. */
  ledger: PrimeLedgerReading;
  /** What the tree listing alone already says. Null when it could not be read. */
  facts: CorpusFacts | null;
  /** The withheld migrations this pass read, newest first. */
  surveys: MigrationSurvey[];
  /**
   * How many migrations are withheld in total, which is very often more than
   * `surveys.length`. Null when the comparison could not be made at all — and
   * never zero, because a failed read is not an empty set.
   */
  withheldCount: number | null;
  /**
   * What could not be read, in the operator's words.
   *
   * A partial pass says so. A page that drew twenty-five clean rows over a
   * corpus listing that failed would be making a statement about a repository
   * nobody opened.
   */
  notes: string[];
  readAt: string;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run `work` over `items`, at most `limit` at a time, in input order. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Everything a migration health page draws, in one read.
 *
 * Throws only where there is nothing at all to report. Every other failure
 * becomes a note beside a partial answer, because a page that says which read
 * failed is worth more than an error boundary.
 */
export async function readPrimeCorpusHealth(supabase: Db): Promise<PrimeCorpusHealth> {
  const readAt = new Date().toISOString();
  const notes: string[] = [];

  // The ledger half first: it is the authority for what is withheld, and it
  // opens (and caches) the very tree listing the corpus half reads below.
  const assessed = await buildPrimeLedgerAssessment(supabase);
  const ledger = assessed.assessment.reading;
  const runnableVersions = assessed.assessment.runnableVersions;
  const runnable = runnableVersions === null ? null : new Set(runnableVersions);

  let source: PrimeLedgerRepoRef | null = null;
  try {
    source = await resolvePrimeSource(supabase);
  } catch (e) {
    notes.push(`The prime repository could not be resolved: ${msg(e)}`);
  }
  if (!source) {
    if (notes.length === 0) {
      notes.push(
        "No prime repository is configured (prime_config.github_owner / github_repo), so no migration file could be read.",
      );
    }
    return {
      repo: null,
      headSha: null,
      ledger,
      facts: null,
      surveys: [],
      withheldCount: ledger.withheldCount,
      notes,
      readAt,
    };
  }

  let facts: CorpusFacts | null = null;
  let surveys: MigrationSurvey[] = [];
  let headSha: string | null = null;
  try {
    const corpus = await openPrimeMigrationCorpus(getAppOctokit(), source);
    headSha = corpus.sourceSha;
    // Said on the page every time it is true, because an unreadable manifest
    // is the one state in which a withdrawn file quietly becomes a hole again.
    notes.push(...withdrawalNotes(corpus.withdrawal));
    facts = corpusFacts(corpus.metas, corpus.sizeOf, MAX_MIGRATION_BYTES);

    const byId = new Map<string, Array<{ id: string; name: string; path: string }>>();
    for (const m of corpus.metas) {
      const seen = byId.get(m.id);
      if (seen) seen.push(m);
      else byId.set(m.id, [m]);
    }

    /*
      What sits in front of each withheld file.

      The same walk `diagnosePrimeMigration` makes: corpus versions before this
      one that the prime has not run. `runnable` is the prime's ledger
      intersected with the repo, and for a corpus member those two questions
      have the same answer — a file the repo carries is in `runnable` exactly
      when the ledger records it.

      Null when the comparison could not be made, so `blockedByCount` reads as
      unknown rather than as none.
    */
    const blockedBefore = (id: string): string[] | null => {
      if (!runnable) return null;
      const out: string[] = [];
      for (const m of corpus.metas) {
        if (m.id === id) break;
        if (!runnable.has(m.id)) out.push(m.id);
      }
      return out;
    };

    const wanted = ledger.withheld.slice(0, SURVEY_LIMIT);
    surveys = await pooled(
      wanted,
      BODY_CONCURRENCY,
      async (row: WithheldRow): Promise<MigrationSurvey> => {
        const here = byId.get(row.id) ?? [];
        const here0 = here[0];
        const meta = here0 ?? {
          id: row.id,
          name: row.name,
          path: `supabase/migrations/${row.name}`,
        };
        let body: SurveyInput["body"];
        try {
          const sql = await corpus.loadSql(meta.id);
          body = { read: true, sql, bytes: Buffer.byteLength(sql, "utf8") };
        } catch (e) {
          body =
            e instanceof OversizedMigrationError
              ? { read: false, oversized: true, why: msg(e) }
              : { read: false, oversized: false, why: msg(e) };
        }
        return surveyMigration({
          meta,
          collidingNames: here.slice(1).map((m) => m.name),
          // The prime's ledger says it is withheld, so it has not run it.
          // Asking the same question twice here would let the two answers
          // differ.
          alreadyApplied: false,
          blockedBy: blockedBefore(meta.id),
          body,
        });
      },
    );
  } catch (e) {
    notes.push(`The prime's migration files could not be listed: ${msg(e)}`);
  }

  if (ledger.withheldCount === null) {
    notes.push(
      "What the prime has already run could not be established, so nothing here says which migrations are outstanding.",
    );
  } else if (ledger.withheldCount > surveys.length) {
    notes.push(
      `${ledger.withheldCount} migrations are withheld; the ${surveys.length} newest were read here.`,
    );
  }

  return {
    repo: source,
    headSha,
    ledger,
    facts,
    surveys,
    withheldCount: ledger.withheldCount,
    notes,
    readAt,
  };
}
