/**
 * Run ONE of the prime's migrations, through the prime's own workflow.
 *
 * This is the only module in the feature that changes anything, and it is
 * separate from `primeMigrationDiagnosis.server.ts` for that reason alone: the
 * thing that READS can then be asserted read-only by source position, and no
 * later edit can quietly make it the thing that writes.
 *
 * ## It does not apply anything itself
 *
 * It dispatches `apply-migration.yml` on the prime repository, which is the
 * workflow that already exists there for exactly this act and which holds the
 * credential to do it. Mission Control does not carry the prime's database URL
 * and must not: `apply-migration.yml`'s own header records why the narrow
 * route wins — a Supabase personal access token "carries the whole account …
 * including ones created after the token was issued", and a database URL
 * reaches one database and can be rotated for one deployment. The act belongs
 * where the credential is.
 *
 * What this adds is the judgement in front of it. That workflow's header says
 * the quiet part out loud — *"Deciding **which** file is a human judgement
 * made before dispatch, not a thing this workflow infers"* — and until now
 * that judgement was made by a person reading SQL in a browser tab. The
 * diagnosis is that judgement, made from evidence, and this is the button it
 * earns.
 *
 * ## The verdict is re-taken HERE, and never accepted from the caller
 *
 * The page sends a version and nothing else. This re-runs the whole diagnosis
 * — including the rolled-back trial run — and refuses unless that fresh
 * reading is `dispatchable`. Two reasons, and the second is the one that
 * matters:
 *
 *   - A reading an operator looked at five minutes ago is a reading about a
 *     schema that has since moved. The evidence an act rests on is taken at
 *     the moment of the act.
 *   - A request field asserting the server's own conclusion is the pattern
 *     IPV 1.1.0 was written to forbid. `dispatchable` arrives at the browser;
 *     it never travels back.
 *
 * ## One at a time, because paying twice is one click away
 *
 * The workflow declares `concurrency: apply-migration, cancel-in-progress:
 * false`, so a second dispatch does not race a first — it QUEUES behind it and
 * then runs. For an idempotent file that is harmless; for one of the 36 in this
 * corpus carrying an unguarded `INSERT`, it duplicates rows.
 *
 * The gap is real but narrow: once a run lands, the version is in
 * `schema_migrations` and the next diagnosis answers `already_applied`. It is
 * open only for the minute or so the workflow takes — which is exactly the
 * minute an operator is most likely to click again, having seen nothing
 * happen. The activation gate paid for this once already: "paying twice was
 * one click away, because the only guard is Mission Control's `paid_at` and
 * the Stripe webhook writes it after the redirect."
 *
 * So this asks GitHub whether a run is already in flight, and refuses while
 * one is. One extra call on the actor path, and the behaviour it produces —
 * wait for the current apply before starting another — is what you would want
 * against a production database regardless.
 *
 * ## One file, named, and never a set
 *
 * There is no "apply all". The prime's ledger under-reports by roughly two
 * orders of magnitude — 133 migrations called pending on 2026-08-13 where all
 * but one family already existed — so a loop over "everything pending" would
 * replay data mutations that are not no-ops. `apply-migration.yml` refuses to
 * infer its own target for that reason; so does this.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "@/server/github-app.server";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";
import { writeAuditLog } from "./audit.server";
import { diagnosePrimeMigration } from "./primeMigrationDiagnosis.server";
import type { MigrationDiagnosis } from "./primeMigrationDiagnosis.pure";

type Db = SupabaseClient<Database>;

/** The workflow that already exists on the prime for this act. */
export const APPLY_WORKFLOW_FILE = "apply-migration.yml";

export type DispatchResult =
  | {
      ok: true;
      /** Where the run will appear. `workflow_dispatch` returns no run id. */
      runsUrl: string;
      file: string;
      version: string;
      diagnosis: MigrationDiagnosis;
    }
  | { ok: false; error: string; diagnosis: MigrationDiagnosis | null };

/**
 * Diagnose, and dispatch only on the one verdict that permits it.
 *
 * @param actorUserId Recorded on the audit row. The act is a person's.
 */
export async function dispatchPrimeMigration(
  supabase: Db,
  version: string,
  actorUserId: string | null,
): Promise<DispatchResult> {
  let report: Awaited<ReturnType<typeof diagnosePrimeMigration>>;
  try {
    report = await diagnosePrimeMigration(supabase, version);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The migration could not be read.",
      diagnosis: null,
    };
  }

  const { diagnosis, repo } = report;

  if (!diagnosis.dispatchable) {
    /*
      The refusal quotes the diagnosis rather than restating it. Two sentences
      about one verdict is how a screen comes to warn about something the
      server does not, and this is the refusal an operator reads at the moment
      they expected the act to happen.
    */
    return {
      ok: false,
      error: `Refused: ${diagnosis.headline}`,
      diagnosis,
    };
  }

  if (!repo) {
    return { ok: false, error: "The prime repository is not configured.", diagnosis };
  }

  const octokit = getAppOctokit();

  const inFlight = await runInFlight(octokit, repo.owner, repo.repo);
  if (inFlight.busy) {
    return {
      ok: false,
      error:
        `${APPLY_WORKFLOW_FILE} is already ${inFlight.status} on ${repo.owner}/${repo.repo}. ` +
        `It applies one migration at a time, and a second dispatch would queue behind this one ` +
        `rather than replace it. Nothing was applied — wait for that run to finish and read this again.`,
      diagnosis,
    };
  }

  try {
    await withRetry(
      () =>
        octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: repo.owner,
          repo: repo.repo,
          workflow_id: APPLY_WORKFLOW_FILE,
          ref: repo.branch,
          inputs: {
            file: diagnosis.path,
            // The workflow's own default, restated rather than omitted: an
            // applied migration the ledger does not record is a hole, and a
            // hole is the thing this whole surface exists to close.
            record_version: "true",
          },
        }),
      { attempts: 3, shouldRetry: isTransientHttpError },
    );
  } catch (err) {
    return {
      ok: false,
      error: describeDispatchError(err, repo.owner, repo.repo, repo.branch),
      diagnosis,
    };
  }

  /*
    Recorded after the dispatch succeeded, and never before it.

    An audit row written first would name an act that may not have happened —
    and this is the register an operator reads to answer "who ran that?". The
    trial run's own result travels with it, because the answer to "why did we
    think this was safe?" is evidence and not a verdict word.
  */
  await writeAuditLog({
    action: "prime.migration.dispatch",
    entityType: "prime_migration",
    entityId: diagnosis.id,
    actorUserId,
    metadata: {
      file: diagnosis.path,
      name: diagnosis.name,
      repo: `${repo.owner}/${repo.repo}`,
      ref: repo.branch,
      workflow: APPLY_WORKFLOW_FILE,
      verdict: diagnosis.verdict,
      dryRunMs: diagnosis.dryRun.ran && diagnosis.dryRun.ok ? diagnosis.dryRun.ms : null,
      destructiveStatements: diagnosis.destructiveCount,
      dataRewriteStatements: diagnosis.dataRewriteCount,
      statements: diagnosis.statementCount,
      headSha: report.headSha,
      primeRef: report.primeRef,
    },
  });

  return {
    ok: true,
    runsUrl: `https://github.com/${repo.owner}/${repo.repo}/actions/workflows/${APPLY_WORKFLOW_FILE}`,
    file: diagnosis.path,
    version: diagnosis.id,
    diagnosis,
  };
}

/** Statuses that mean a run has not finished. */
const RUNNING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/**
 * Is a run of the apply workflow already going?
 *
 * Answers `busy: false` when it CANNOT TELL, deliberately. A refusal built on
 * a failed read would make a GitHub hiccup indistinguishable from a run in
 * flight, and would block the act this page exists to offer on the strength of
 * a question nobody answered. The workflow's own `concurrency` group is the
 * real serialiser; this is the disclosure in front of it, and the conservative
 * side of a disclosure is to say nothing rather than to invent a reason.
 */
async function runInFlight(
  octokit: ReturnType<typeof getAppOctokit>,
  owner: string,
  repo: string,
): Promise<{ busy: boolean; status: string }> {
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
      { owner, repo, workflow_id: APPLY_WORKFLOW_FILE, per_page: 5 },
    );
    const runs = (res as { data?: { workflow_runs?: Array<{ status?: string | null }> } })?.data
      ?.workflow_runs;
    const live = (runs ?? []).find((r) => RUNNING.has(r.status ?? ""));
    return live
      ? { busy: true, status: (live.status ?? "running").replace("_", " ") }
      : { busy: false, status: "" };
  } catch {
    return { busy: false, status: "" };
  }
}

/**
 * GitHub answers a missing workflow file, a missing branch and a missing
 * permission all with "Not Found". Say which one it probably is.
 *
 * The same three cases `describeRemediationDispatchError` separates, and
 * deliberately not shared with it: that one names a remediation workflow and
 * its own callback secret, and a shared helper would have to be told which
 * story to tell — which is two functions wearing one name.
 */
function describeDispatchError(err: unknown, owner: string, repo: string, ref: string): string {
  const status = (err as { status?: number })?.status;
  const message =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  const target = `${owner}/${repo}`;

  if (status === 404) {
    return (
      `GitHub returned 404 dispatching ${APPLY_WORKFLOW_FILE} on ${target}@${ref}. ` +
      `Check that .github/workflows/${APPLY_WORKFLOW_FILE} exists on "${ref}", and that the ` +
      `Aurixa GitHub App is installed on ${target} with Actions: read & write. Nothing was applied.`
    );
  }
  if (status === 403) {
    return (
      `GitHub returned 403 dispatching ${APPLY_WORKFLOW_FILE} on ${target}. The App installation ` +
      `is missing Actions: read & write. Nothing was applied. Detail: ${message}`
    );
  }
  if (status === 422) {
    return (
      `GitHub rejected the dispatch inputs for ${APPLY_WORKFLOW_FILE} on ${target}@${ref}: ${message}. ` +
      `The workflow on the prime is probably a revision whose workflow_dispatch inputs no longer ` +
      `match — compare its "file" and "record_version" inputs. Nothing was applied.`
    );
  }
  return `Dispatch failed for ${target}@${ref}${status ? ` [${status}]` : ""}: ${message}. Nothing was applied.`;
}
