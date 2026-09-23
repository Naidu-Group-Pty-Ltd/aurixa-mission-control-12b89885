/**
 * Gather everything one of the prime's migrations can be judged on.
 *
 * The judgement is `primeMigrationDiagnosis.pure.ts`. This file fetches, in
 * five independent layers, and hands each one to that module whole — including
 * the ones that failed, because a layer that could not answer must reach the
 * verdict as a named absence rather than as a silence indistinguishable from
 * a clean result.
 *
 *   1. the corpus listing          (GitHub tree, cached 60s in-process)
 *   2. the prime's ledger          (one statement, Management API)
 *   3. this file's body            (one blob, cached by commit)
 *   4. the prime's live catalogue  (one statement, Management API)
 *   5. a rolled-back trial run     (one statement, Management API)
 *
 * ## The trial run, and the three things that bound it
 *
 * It is `BEGIN; SET LOCAL lock_timeout; SET LOCAL statement_timeout; <body>;
 * ROLLBACK;` sent as one request. Every part of that is load-bearing:
 *
 *   - **`ROLLBACK`** is why this can be done against a production database at
 *     all. Nothing it writes survives the request.
 *   - **`lock_timeout`** is why it cannot block the prime's own traffic. A
 *     trial run that waits on a lock held by a live transaction would queue
 *     every reader behind it — a diagnostic taking the database down.
 *   - **`statement_timeout`** bounds the whole thing inside one HTTP request.
 *
 * And it is REFUSED, by `isSafeToDryRun`, for any body carrying transaction
 * control: a `COMMIT;` inside the body would end the wrapping transaction and
 * make everything before it permanent. That gate is in the pure module, is
 * asked before this ever composes a statement, and is the single rule the
 * whole feature rests on.
 *
 * Both timeouts are `SET LOCAL`, so they are scoped to the transaction and
 * cannot outlive the rollback onto the pooled connection the next caller gets.
 *
 * ## What "failed" means here, twice over
 *
 * A trial run that hits one of OUR two timeouts is reported as a run that did
 * not answer — `DRY_RUN_INCONCLUSIVE_STATES` in the pure module — and never as
 * a migration that would fail. `a timeout is not evidence of absence`, on the
 * one screen that offers to run something.
 *
 * ## Read-only
 *
 * Nothing here writes, to the prime or to Mission Control. The rollback is
 * what makes that true of the database, and there is no `insert`, `update` or
 * `rpc` anywhere in the file — asserted by source position, the same way the
 * ledger reading and the blockage ledger are. The act this diagnosis unlocks
 * lives in its own module, so the thing that READS can never become the thing
 * that WRITES by a later edit.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  openPrimeMigrationCorpus,
  resolvePrimeBackendRef,
  resolvePrimeSource,
} from "./prime-backend.server";
import { withdrawnVersionMessage } from "./migrationWithdrawals.pure";
import { runSqlOnProject } from "./backend-provisioning.server";
import { OversizedMigrationError } from "./oversizedMigration.pure";
import { reconcileMigration } from "./primeLedgerReconciliation.pure";
import {
  diagnoseMigration,
  findVersionCollisions,
  hazardsIn,
  isRollbackScript,
  isSafeToDryRun,
  readSqlFailure,
  scanSqlStatements,
  type DiagnosisInput,
  type DryRunOutcome,
  type MigrationDiagnosis,
  type VersionCollision,
} from "./primeMigrationDiagnosis.pure";

type Db = SupabaseClient<Database>;

/** How long a trial run may wait for a lock before giving up. */
export const DRY_RUN_LOCK_TIMEOUT = "3s";

/** How long any one statement in a trial run may take. */
export const DRY_RUN_STATEMENT_TIMEOUT = "15s";

/**
 * The largest body this will send to the Management API in one request.
 *
 * Above it the answer would be about the TRANSPORT rather than about the
 * migration — `apply-migration.yml` exists partly because a ~19 MB INSERT is
 * "too large for one Management API request", and a request-size refusal read
 * back as `would_fail` would be this module blaming a file for our own
 * plumbing.
 *
 * One megabyte, and the number is measured rather than picked. The prime's
 * chunker targets ~1.1 MB per statement as what the API demonstrably takes, so
 * a whole-request bound just under that is known-safe. And it costs almost
 * nothing: over the prime's 1,002 files, 986 are under 256 KB (p50 is 2.1 KB,
 * p90 is 11 KB), 13 are past `MAX_MIGRATION_BYTES` and never get a body at
 * all, and **exactly one** file sits between this ceiling and that one — a
 * 3.76 MB template-library seed, which is the very shape the chunking route
 * was built for.
 */
export const DRY_RUN_MAX_BYTES = 1024 * 1024;

/** The catalogue read, reused verbatim from the reconciliation report. */
const LIVE_OBJECTS_SQL = `
select 'table:'||n.nspname||'.'||c.relname o from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p')
union all select 'view:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('v','m')
union all select 'index:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='i'
union all select 'sequence:'||n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S'
union all select 'function:'||n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
union all select 'type:'||n.nspname||'.'||t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace`;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const rowsOf = (raw: unknown): unknown[] =>
  Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { rows?: unknown[] })?.rows)
      ? (raw as { rows: unknown[] }).rows
      : Array.isArray((raw as { result?: unknown[] })?.result)
        ? (raw as { result: unknown[] }).result
        : [];

/**
 * Wrap a body so that running it leaves nothing behind.
 *
 * Exported for the contract test, which asserts the shape rather than trusting
 * this comment: a wrapper missing its ROLLBACK is the one defect here that
 * would be silent, correct-looking and catastrophic.
 *
 * The separator is computed rather than assumed. A body whose last statement
 * carries no trailing semicolon would otherwise run straight into `rollback`
 * and the transaction would never end.
 */
export function wrapForDryRun(sql: string): string {
  const body = sql.replace(/\s+$/, "");
  return [
    "begin;",
    `set local lock_timeout = '${DRY_RUN_LOCK_TIMEOUT}';`,
    `set local statement_timeout = '${DRY_RUN_STATEMENT_TIMEOUT}';`,
    body.endsWith(";") ? body : `${body};`,
    "rollback;",
  ].join("\n");
}

/**
 * Send one body to the prime inside a transaction that is always rolled back.
 *
 * Never called without `isSafeToDryRun` having cleared the body first — the
 * caller below asks, and the test asserts the order by source position,
 * because the two being the wrong way round is not visible in any output.
 */
async function dryRun(primeRef: string, sql: string): Promise<DryRunOutcome> {
  const startedAt = Date.now();
  try {
    await runSqlOnProject(primeRef, wrapForDryRun(sql));
    return { ran: true, ok: true, ms: Date.now() - startedAt };
  } catch (e) {
    const { sqlstate, message } = readSqlFailure(msg(e));
    return { ran: true, ok: false, sqlstate, message, ms: Date.now() - startedAt };
  }
}

export type DiagnosisRepoRef = { owner: string; repo: string; branch: string };

export type PrimeMigrationDiagnosisReport = {
  diagnosis: MigrationDiagnosis;
  repo: DiagnosisRepoRef | null;
  primeRef: string | null;
  headSha: string | null;
  /**
   * Every version the corpus carries twice, surveyed over the whole tree.
   *
   * It rides this report because it is the fleet-wide fact a per-file
   * diagnosis cannot show: a collision is a hole that running something
   * cannot close, and on this prime there are 32 of them.
   */
  collisions: VersionCollision[];
  readAt: string;
};

/**
 * Everything known about one of the prime's migrations.
 *
 * Throws only where there is nothing to report at all — no prime repository,
 * no such version. Every other failure becomes a named absence inside the
 * diagnosis, because a diagnosis that says which layer could not answer is
 * worth more than an error page.
 */
export async function diagnosePrimeMigration(
  supabase: Db,
  version: string,
): Promise<PrimeMigrationDiagnosisReport> {
  const readAt = new Date().toISOString();

  const source = await resolvePrimeSource(supabase);
  if (!source) {
    throw new Error(
      "No prime repository is configured (prime_config.github_owner / github_repo), so there is no migration to read.",
    );
  }

  const corpus = await openPrimeMigrationCorpus(getAppOctokit(), source);
  const collisions = findVersionCollisions(corpus.metas);
  const here = corpus.metas.filter((m) => m.id === version);
  if (here.length === 0) {
    // A withdrawn file is not missing: it is on the prime, deliberately, and
    // "no such migration" would send an operator looking for a file that is
    // exactly where it should be.
    const withdrawn = corpus.withdrawal.excluded.filter((m) => m.id === version);
    if (withdrawn.length > 0) throw new Error(withdrawnVersionMessage(version, withdrawn));
    throw new Error(`No migration with version ${version} is on ${source.owner}/${source.repo}.`);
  }
  // On a collision the FIRST file in corpus order is diagnosed and the rest
  // are named, because a collision's verdict is about the pair rather than
  // about either file and the remedy is a rename either way.
  const meta = { id: here[0].id, name: here[0].name, path: here[0].path };
  const collidingNames = here.slice(1).map((m) => m.name);

  let primeRef: string | null = null;
  let primeRefError: string | null = null;
  try {
    primeRef = await resolvePrimeBackendRef(supabase);
  } catch (e) {
    primeRefError = msg(e);
  }

  /*
    The prime's ledger, and this file's position in front of it.

    `blockedBy` is every corpus version BEFORE this one that the prime has not
    run. That is deliberately not `partitionByDependency`: that function
    answers "what may be SENT to a clone", which needs a clone's own ledger and
    a scope, and bending it to this question would make one function answer two.
    This one is a walk of the corpus up to the target, which is the definition.
  */
  let applied: Set<string> | null = null;
  let ledgerError: string | null = null;
  if (primeRef) {
    try {
      const raw = await runSqlOnProject(
        primeRef,
        "select version from supabase_migrations.schema_migrations",
      );
      const versions = rowsOf(raw)
        .map((r) => (r as { version?: unknown })?.version)
        .filter((v): v is string => typeof v === "string");
      // An EMPTY ledger is refused for the reason `assertPrimeLedgerUsable`
      // gives: with no authority for what the prime has run, every file in the
      // tree would read as a hole and this one as blocked behind hundreds.
      if (versions.length === 0) {
        ledgerError = `The prime (${primeRef}) reports no applied migrations, so nothing here can say what it has already run.`;
      } else {
        applied = new Set(versions);
      }
    } catch (e) {
      ledgerError = msg(e);
    }
  }

  const alreadyApplied = applied?.has(version) ?? false;
  let blockedBy: string[] | null = null;
  if (applied) {
    blockedBy = [];
    for (const m of corpus.metas) {
      if (m.id === version) break;
      if (!applied.has(m.id)) blockedBy.push(m.id);
    }
  }

  // The body. Oversize is its own answer, not a failure: the file is fine and
  // this console simply will not hold it.
  let body: DiagnosisInput["body"];
  try {
    const sql = await corpus.loadSql(meta.id);
    body = { read: true, sql, bytes: Buffer.byteLength(sql, "utf8") };
  } catch (e) {
    body =
      e instanceof OversizedMigrationError
        ? { read: false, oversized: true, why: msg(e) }
        : { read: false, oversized: false, why: msg(e) };
  }

  // The prime's catalogue, asked only where there is SQL to ask about.
  let catalogue: DiagnosisInput["catalogue"] = null;
  if (body.read && primeRef) {
    try {
      const live = await runSqlOnProject(primeRef, LIVE_OBJECTS_SQL);
      const present = new Set(
        rowsOf(live)
          .map((r) => (r as { o?: unknown })?.o)
          .filter((v): v is string => typeof v === "string"),
      );
      const evidence = reconcileMigration(meta, body.sql, present);
      catalogue = {
        read: true,
        verdict: evidence.verdict,
        missing: evidence.missing.map((m) => `${m.kind} ${m.qualified}`),
      };
    } catch (e) {
      catalogue = { read: false, why: msg(e) };
    }
  }

  /*
    The trial run — last, and only when every reason not to make one has been
    ruled out.

    The order below is the safety property. `isSafeToDryRun` is asked BEFORE a
    statement is composed, so a body carrying `COMMIT;` never reaches
    `runSqlOnProject` at all; and a version the prime has already run is not
    re-sent even inside a transaction, because the useful answer there is
    "nothing is owed" rather than a duplicate-object error.
  */
  let dry: DryRunOutcome;
  if (isRollbackScript(meta.name)) {
    /*
      An undo is never sent, not even inside a transaction that rolls back.

      It would be safe — nothing survives the ROLLBACK — and it would still be
      wrong. The corpus holds two `rollback_*` scripts whose stated purpose is
      to reverse a security fix, `fleetCorpusScope.pure.ts` was written around
      keeping them away from a database, and a console that sends one anyway
      has made an exception nobody reading the code would expect.
    */
    dry = { ran: false, why: "It is an undo, and undos are not sent from here." };
  } else if (collidingNames.length > 0) {
    // The ledger can record only one of them, so nothing a trial run could
    // find would change the answer. The repair is a rename.
    dry = { ran: false, why: "More than one file carries this version." };
  } else if (!body.read) {
    dry = { ran: false, why: "Its body was not read here." };
  } else if (!primeRef) {
    dry = {
      ran: false,
      why: primeRefError ?? "The prime's own Supabase project is not configured.",
    };
  } else if (ledgerError) {
    dry = { ran: false, why: ledgerError };
  } else if (alreadyApplied) {
    dry = { ran: false, why: "The prime has already run it." };
  } else if (blockedBy && blockedBy.length > 0) {
    dry = {
      ran: false,
      why: "An earlier migration the prime has not run sits in front of it, so a trial run here would fail for that reason rather than this one.",
    };
  } else if (body.bytes > DRY_RUN_MAX_BYTES) {
    dry = {
      ran: false,
      why: `Its body is ${Math.round(body.bytes / 1024)} KB, larger than this console will send in one request — the answer would be about the transport rather than about the migration.`,
    };
  } else if (!isSafeToDryRun(hazardsIn(scanSqlStatements(body.sql)))) {
    dry = { ran: false, why: "Its own statements make a rolled-back trial run unsafe." };
  } else {
    dry = await dryRun(primeRef, body.sql);
  }

  return {
    diagnosis: diagnoseMigration({
      meta,
      collidingNames,
      alreadyApplied,
      blockedBy,
      body,
      dryRun: dry,
      catalogue,
    }),
    repo: source,
    primeRef,
    headSha: corpus.sourceSha,
    collisions,
    readAt,
  };
}
