/**
 * Read both halves of the prime's SQL position: the migrations in its
 * repository, and the migrations its own database records as run.
 *
 * The judgement is `primeMigrationLedger.pure.ts`. This file does nothing but
 * fetch, and it is written so that each half fails on its own — a GitHub
 * refusal and a Management API refusal produce different sentences and neither
 * produces a number about the other.
 *
 * ## What it costs
 *
 * `openPrimeMigrationCorpus` is one `repos.getBranch` plus one recursive
 * `git.getTree`, and the tree is held for sixty seconds in-process, so a
 * comparison opened straight after the ledger loads pays for neither. No
 * migration BODY is read here at all — this asks which files exist and which
 * versions are recorded, never what the SQL says. That is the difference
 * between this and `buildPrimeLedgerReconciliation`, which reads up to 120
 * bodies and is a press for exactly that reason.
 *
 * The ledger half is one statement against the prime's project over the
 * Management API, and spends no GitHub budget at all.
 *
 * ## Read-only, structurally
 *
 * Nothing here writes. Not the prime's ledger, not a clone's, not a blockage
 * row. The remedy this reading names is always an act on the prime performed
 * by a person, and a console that could perform it from a page about health
 * would be a gate nobody asked for.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  openPrimeMigrationCorpus,
  resolvePrimeBackendRef,
  resolvePrimeSource,
} from "./prime-backend.server";
import { runSqlOnProject } from "./backend-provisioning.server";
import {
  assessPrimeMigrationLedger,
  type LedgerHalf,
  type PrimeLedgerRow,
  type PrimeLedgerAssessment,
  type PrimeLedgerReading,
} from "./primeMigrationLedger.pure";
import { LEDGER_BODY_DIGEST_SQL } from "./migrationBodyIdentity.pure";
import { digestPrimeBodies } from "./primeBodyDigests.server";
import type { PrimeMigrationCorpus } from "./prime-backend.server";
import type { CorpusMeta } from "./fleetCorpusScope.pure";

type Db = SupabaseClient<Database>;

export type PrimeLedgerRepoRef = { owner: string; repo: string; branch: string };

/** Everything the assessment needed, plus what it was taken against. */
export type PrimeLedgerAssessed = {
  assessment: PrimeLedgerAssessment;
  /** The prime repo the corpus came from, or null when it is not configured. */
  repo: PrimeLedgerRepoRef | null;
  /** The prime backend project the ledger came from, or null when unresolved. */
  primeRef: string | null;
  /**
   * The commit the corpus listing was taken at — the prime's head.
   *
   * It rides this result rather than being read again, and rather than being
   * accepted from a caller. The clone comparison needs prime's head to say
   * whether a clone is carrying it, and a head supplied by the browser is a
   * request field asserting the very thing the server is being asked to
   * decide. IPV 1.1.0 records what that pattern cost the last time it was
   * permitted; here it is simply unavailable.
   */
  headSha: string | null;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The corpus half: which migration files sit on the prime's default branch.
 *
 * An unconfigured prime is a `read: false` with the setting named rather than
 * a throw, because the other half may still answer and an operator is better
 * served by "the repo is not configured, and the backend holds 890 rows" than
 * by one sentence about neither.
 */
async function readCorpusHalf(supabase: Db): Promise<{
  half: LedgerHalf<CorpusMeta>;
  repo: PrimeLedgerRepoRef | null;
  headSha: string | null;
  /** Kept so the digest pass can read bodies without listing the tree twice. */
  corpus: PrimeMigrationCorpus | null;
}> {
  let source: PrimeLedgerRepoRef | null = null;
  try {
    source = await resolvePrimeSource(supabase);
  } catch (e) {
    return { half: { read: false, why: msg(e) }, repo: null, headSha: null, corpus: null };
  }
  if (!source) {
    return {
      half: {
        read: false,
        why: "no prime repository is configured (prime_config.github_owner / github_repo)",
      },
      repo: null,
      headSha: null,
      corpus: null,
    };
  }
  try {
    const corpus = await openPrimeMigrationCorpus(getAppOctokit(), source);
    // `metas` is readonly and ordered by filename, which is version order.
    return {
      half: { read: true, entries: corpus.metas.map((m) => ({ id: m.id, name: m.name })) },
      repo: source,
      headSha: corpus.sourceSha,
      corpus,
    };
  } catch (e) {
    return { half: { read: false, why: msg(e) }, repo: source, headSha: null, corpus: null };
  }
}

/**
 * The ledger half: what the prime's own database records as run, and what it
 * actually ran.
 *
 * Both in ONE read, because they are one fact about one table. Reading them
 * separately would make a half that could be half-read, which is the shape
 * `LedgerHalf` exists to forbid.
 */
async function readLedgerHalf(
  supabase: Db,
): Promise<{ half: LedgerHalf<PrimeLedgerRow>; primeRef: string | null }> {
  let primeRef: string;
  try {
    primeRef = await resolvePrimeBackendRef(supabase);
  } catch (e) {
    return { half: { read: false, why: msg(e) }, primeRef: null };
  }
  try {
    const rows = (await runSqlOnProject(
      primeRef,
      `select version, ${LEDGER_BODY_DIGEST_SQL} as body_digest from supabase_migrations.schema_migrations`,
    )) as Array<{ version?: unknown; body_digest?: unknown }>;
    const entries: PrimeLedgerRow[] = (Array.isArray(rows) ? rows : [])
      .filter((r): r is { version: string; body_digest?: unknown } => typeof r?.version === "string")
      .map((r) => ({
        version: r.version,
        bodyDigest: typeof r.body_digest === "string" ? r.body_digest : null,
      }));
    return { half: { read: true, entries }, primeRef };
  } catch (e) {
    return { half: { read: false, why: msg(e) }, primeRef };
  }
}

/**
 * Both halves, assessed.
 *
 * Exported so the clone comparison measures against the SAME frontier the page
 * prints rather than deriving a second one. Two computations of "what may a
 * clone be sent" is how the two come to disagree, and the disagreement would
 * be invisible: both numbers are plausible and neither names its source.
 */
export async function buildPrimeLedgerAssessment(supabase: Db): Promise<PrimeLedgerAssessed> {
  // Both halves at once: they touch different services and neither needs the
  // other's answer.
  const [corpus, ledger] = await Promise.all([readCorpusHalf(supabase), readLedgerHalf(supabase)]);

  /*
    The bodies, third and last, because this is the one step that needs BOTH
    halves: it is asked only about files whose version the ledger does not
    already record, so a reconciled prime costs nothing here and this one
    costs ~800 small blobs in about ten batched requests, once per commit.

    Outside the two halves deliberately. A body read that fails leaves both
    halves exactly as they were and the reading falls back to the version
    match, which is what this page showed before bodies were read at all.
  */
  const withBodies = await attachBodyDigests(corpus, ledger);

  return {
    assessment: assessPrimeMigrationLedger({ corpus: withBodies, ledger: ledger.half }),
    repo: corpus.repo,
    primeRef: ledger.primeRef,
    headSha: corpus.headSha,
  };
}

/**
 * The corpus half, with a body digest on every file the ledger's VERSIONS do
 * not already account for.
 *
 * Returns the half untouched whenever it cannot improve on it: an unread half,
 * an unread ledger, no corpus handle, or a digest pass that threw. Each of
 * those leaves `bodyDigests` absent, which `scopeCorpusToPrime` reads as
 * "nobody asked" and scopes exactly as it did before.
 */
async function attachBodyDigests(
  corpus: { half: LedgerHalf<CorpusMeta>; repo: PrimeLedgerRepoRef | null; corpus: PrimeMigrationCorpus | null },
  ledger: { half: LedgerHalf<PrimeLedgerRow> },
): Promise<LedgerHalf<CorpusMeta>> {
  if (!corpus.half.read || !ledger.half.read || !corpus.corpus || !corpus.repo) return corpus.half;
  const applied = new Set(ledger.half.entries.map((r) => r.version));
  const files = corpus.corpus.files.filter((f) => !applied.has(f.id));
  if (files.length === 0) return corpus.half;

  let byPath: Map<string, string[]>;
  try {
    byPath = (
      await digestPrimeBodies(
        corpus.corpus,
        files.map((f) => f.path),
        getAppOctokit(),
        corpus.repo,
      )
    ).byPath;
  } catch {
    return corpus.half;
  }

  // Rebuilt from `files` rather than zipped against `half.entries`: both come
  // from the same listing in the same order, and relying on that silently is
  // how a reader comes to attach one file's digest to another's name.
  return {
    read: true,
    entries: corpus.corpus.files.map((f) => {
      const d = byPath.get(f.path);
      return d === undefined
        ? { id: f.id, name: f.name }
        : { id: f.id, name: f.name, bodyDigests: d };
    }),
  };
}

export type PrimeMigrationLedgerReport = {
  reading: PrimeLedgerReading;
  repo: PrimeLedgerRepoRef | null;
  primeRef: string | null;
  readAt: string;
};

/**
 * The page's reading. `runnableVersions` is deliberately dropped here: it is
 * ~900 strings, the page draws counts, and a payload carrying the authority
 * the comparison runs on would invite a client to supply it.
 */
export async function readPrimeMigrationLedgerReport(
  supabase: Db,
): Promise<PrimeMigrationLedgerReport> {
  const { assessment, repo, primeRef } = await buildPrimeLedgerAssessment(supabase);
  return { reading: assessment.reading, repo, primeRef, readAt: new Date().toISOString() };
}
