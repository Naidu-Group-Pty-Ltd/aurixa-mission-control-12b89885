/**
 * Propose a repair to one of the prime's migrations, as a pull request on the
 * prime.
 *
 * `primeMigrationRemedy.pure.ts` decides WHAT to change and proves the change
 * moves the reading. This decides whether it may be proposed at all, and
 * carries it. It is a third module beside the diagnosis (which reads) and the
 * dispatch (which runs), and the split is the one those two already make: the
 * thing that READS is asserted read-only by source position, and every act
 * lives in a file of its own so a later edit cannot quietly turn a reading
 * into a write.
 *
 * ## It changes the FILE, and the run stays the ordinary run
 *
 * There is a shorter route that this deliberately does not take: patch the
 * body in memory and send THAT to the database. It would work, once, and it
 * would manufacture precisely the fault `scripts/check-applied-digests.mjs`
 * exists to detect — a version in `schema_migrations` whose content is not
 * what the repository holds. That check measured two of fifty-five settled
 * rows already drifted with nothing reporting it. So the patched text goes to
 * the repository, through a pull request, and `apply-migration.yml` later runs
 * the file the repository holds, exactly as it does today.
 *
 * A pull request rather than a push, for the rule `autoMergeGate.pure.ts`
 * states about the fleet and which is no weaker here: nothing writes to a
 * default branch except through a pull request whose checks somebody has
 * actually read. The prime's own CI is what reads them.
 *
 * ## A migration the prime has already RUN is refused
 *
 * This is the refusal worth reading twice. The whole point of the repair is to
 * make a second run safe — so the instinct is that an applied migration is
 * exactly what wants repairing. It is the opposite. Once a version is in
 * `schema_migrations` the file will never be dispatched again (the diagnosis
 * answers `already_applied` and the dispatch refuses on it), so the repair
 * buys nothing; and changing the file makes the repository disagree with the
 * ledger, which is the one thing the digest check forbids in as many words.
 *
 * What the repair is FOR is the withheld set — the migrations the prime has
 * not run, which are the ones a clone is sitting behind, which are the ones
 * `/prime-migrations` lists. The prime's ledger under-reports by roughly two
 * orders of magnitude, so plenty of those have effectively run without being
 * recorded; those are unrecorded, the digest check cannot see them either, and
 * they are precisely the population that needs to survive a re-run.
 *
 * ## Planning is free of the trial run, on purpose
 *
 * `diagnosePrimeMigration` spends a rolled-back trial run against the prime's
 * production database, and a repair does not turn on its answer: a file that
 * would fail for a missing prerequisite is still worth making re-runnable, and
 * a file that would succeed is not thereby safe to run twice. So this reads
 * three things — the corpus listing (cached), this file's body, and the
 * ledger — and stops. That makes the plan cheap enough to draw on a page
 * beside the diagnosis rather than behind a second minute of waiting.
 *
 * ## The proposal is re-planned at the moment of the act
 *
 * The browser sends a version and nothing else. `openPrimeMigrationRepair`
 * re-reads the body from the prime's current head and re-plans from it, and
 * the patch it commits is the one it just composed — never one the page sent
 * back. Between an operator reading a plan and clicking, the file may have
 * been edited, the version may have been applied, or the repair may have
 * landed already; each of those makes the earlier plan a statement about a
 * repository that has moved.
 *
 * ## One branch per version, and an operator's "no" is not overridden
 *
 * The branch is `mission-control/migration-repair/<version>`, which is a
 * function of the version alone. A second click finds the open pull request
 * and returns it rather than opening a second one — the cascade engine paid
 * for the other behaviour with eight pull requests carrying the same
 * fifty-seven files. And a branch that exists with NO open pull request means
 * somebody closed one: that is a decision, this refuses rather than
 * re-proposing, and it says which branch to delete to start again.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";
import { writeAuditLog } from "./audit.server";
import {
  openPrimeMigrationCorpus,
  resolvePrimeBackendRef,
  resolvePrimeSource,
} from "./prime-backend.server";
import { runSqlOnProject } from "./backend-provisioning.server";
import { OversizedMigrationError } from "./oversizedMigration.pure";
import { findVersionCollisions } from "./primeMigrationDiagnosis.pure";
import { planMigrationRepair, mayPropose, type RemedyPlan } from "./primeMigrationRemedy.pure";
/*
  The same words the page draws, rather than the enum values beside them. A
  reviewer on GitHub is an operator too, and `materialized_view` is not a
  phrase. One table, read from both ends — `database vocabulary never reaches
  the operator` does not stop at this product's own pages.
*/
import { REFUSAL_WORDS, REPAIR_WORDS, RERUN_WORDS } from "@/lib/migrationRepairLabels";

type Db = SupabaseClient<Database>;

/** Where a repair lands. A function of the version and nothing else. */
export function repairBranchName(version: string): string {
  return `mission-control/migration-repair/${version}`;
}

export type RepairTarget = {
  version: string;
  /** The file's path in the prime repository. */
  path: string;
  name: string;
  repo: { owner: string; repo: string; branch: string };
  /** The commit the corpus listing was taken at. */
  headSha: string;
};

/**
 * The plan as the browser is allowed to see it.
 *
 * `patched` is removed rather than merely unused. It is the whole file — up
 * to the corpus ceiling — so sending it would put a megabyte on a page that
 * cannot do anything with it; and once it is in the browser it is one edit
 * away from being sent back, which is the request field asserting the
 * server's own conclusion that IPV 1.1.0 was written to forbid, on a path
 * that ends in a commit. What changes is on the rows; what the file becomes
 * is the pull request's diff.
 */
export type RemedyPlanView = Omit<RemedyPlan, "patched">;

export type RepairPlanReport = {
  target: RepairTarget;
  plan: RemedyPlanView;
  /**
   * Whether the act below may be offered. Decided HERE, never in the browser.
   *
   * The page draws its button on this one field, the way the diagnosis panel
   * draws Apply on `dispatchable` — so an outcome this module gains tomorrow
   * cannot acquire a button by being spelled optimistically.
   */
  proposable: boolean;
  /**
   * Why this may not be proposed, whatever the plan says. Null when it may.
   *
   * Separate from the plan's own outcome because they answer different
   * questions: the plan says whether a sound edit EXISTS, this says whether
   * the repository is in a state where proposing it is right.
   */
  blocked: string | null;
  readAt: string;
};

export type RepairPlanResult =
  | ({ ok: true } & RepairPlanReport)
  | { ok: false; error: string; report: RepairPlanReport | null };

export type RepairProposalResult =
  | {
      ok: true;
      /** `opened` is new; `already_open` changed nothing. */
      state: "opened" | "already_open";
      url: string;
      number: number;
      branch: string;
      report: RepairPlanReport;
    }
  | { ok: false; error: string; report: RepairPlanReport | null };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const rowsOf = (raw: unknown): unknown[] =>
  Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { rows?: unknown[] })?.rows)
      ? ((raw as { rows: unknown[] }).rows ?? [])
      : [];

/**
 * Read the three things a repair turns on, and plan from them.
 *
 * Exported for the server function and used again by the act, so the plan an
 * operator reads and the patch that is committed come from one function rather
 * than two that agree today.
 */
export async function planPrimeMigrationRepair(
  supabase: Db,
  version: string,
): Promise<{ report: RepairPlanReport; patched: string | null }> {
  const source = await resolvePrimeSource(supabase);
  if (!source) {
    throw new Error(
      "No prime repository is configured (prime_config.github_owner / github_repo), so there is no migration to repair.",
    );
  }

  const corpus = await openPrimeMigrationCorpus(getAppOctokit(), source);
  const here = corpus.metas.filter((m) => m.id === version);
  if (here.length === 0) {
    throw new Error(`No migration with version ${version} is on ${source.owner}/${source.repo}.`);
  }

  const target: RepairTarget = {
    version,
    path: here[0].path,
    name: here[0].name,
    repo: source,
    headSha: corpus.sourceSha,
  };

  const readAt = new Date().toISOString();
  const report = (
    plan: RemedyPlan,
    blocked: string | null,
  ): { report: RepairPlanReport; patched: string | null } => {
    const { patched, ...view } = plan;
    return {
      report: {
        target,
        plan: view,
        proposable: blocked === null && mayPropose(plan.outcome) && patched !== null,
        blocked,
        readAt,
      },
      patched,
    };
  };

  /*
    A collision is refused before anything is read, because a repair has to
    name ONE file and a collision means the version does not. The diagnosis
    refuses on the same ground and for the same reason: the remedy is a
    rename, which is a person's decision about which file is the real one.
  */
  const collision = findVersionCollisions(corpus.metas).find((c) => c.version === version);
  if (collision) {
    return report(
      planMigrationRepair(null),
      `Two files on the prime carry version ${version} — ${collision.names.join(" and ")}. ` +
        `A repair has to name one file, and the remedy for a collision is to renumber one of ` +
        `them, which is a decision about which is the real migration. Nothing was proposed.`,
    );
  }

  // The body. Oversize is its own answer rather than a failure: the file is
  // fine and this console simply will not hold it.
  let sql: string | null = null;
  let bodyWhy: string | null = null;
  try {
    sql = await corpus.loadSql(version);
  } catch (e) {
    bodyWhy =
      e instanceof OversizedMigrationError
        ? `${msg(e)} A repair edits the file, so there is nothing this can do without reading it.`
        : `The file could not be read from ${source.owner}/${source.repo}: ${msg(e)}`;
  }

  const plan = planMigrationRepair(sql);
  if (bodyWhy) return report(plan, bodyWhy);

  /*
    The ledger, asked LAST and only where there is something to propose.

    It costs a statement against the prime's production project, and a file
    that needs no repair does not need the question answered. Where the read
    fails the repair is blocked rather than allowed: this is the one refusal
    that protects the repository from disagreeing with the database, and `a
    read that FAILED is not a row that is ABSENT`.
  */
  if (!mayPropose(plan.outcome)) return report(plan, null);

  let primeRef: string | null = null;
  try {
    primeRef = await resolvePrimeBackendRef(supabase);
  } catch (e) {
    return report(
      plan,
      `The prime's backend project could not be resolved (${msg(e)}), so this cannot check ` +
        `whether the prime has already run this migration — and a migration that has already ` +
        `run must not change in the repository. Nothing was proposed.`,
    );
  }

  try {
    const raw = await runSqlOnProject(
      primeRef,
      "select version from supabase_migrations.schema_migrations",
    );
    const versions = rowsOf(raw)
      .map((r) => (r as { version?: unknown })?.version)
      .filter((v): v is string => typeof v === "string");
    if (versions.length === 0) {
      return report(
        plan,
        `The prime (${primeRef}) reports no applied migrations at all, so nothing here can say ` +
          `whether it has already run this one. Nothing was proposed.`,
      );
    }
    if (versions.includes(version)) {
      return report(
        plan,
        `The prime has already run ${version}. A migration that has already run must not change ` +
          `in the repository — editing it now would make the file disagree with the row in ` +
          `\`schema_migrations\`, which is the drift \`check-applied-digests.mjs\` exists to ` +
          `catch. It will not be dispatched again either way, so the repair buys nothing.`,
      );
    }
  } catch (e) {
    return report(
      plan,
      `The prime's migration ledger could not be read (${msg(e)}), so this cannot check whether ` +
        `the prime has already run this migration. Nothing was proposed.`,
    );
  }

  return report(plan, null);
}

/**
 * Plan it again, and open the pull request.
 *
 * @param actorUserId Recorded on the audit row. The act is a person's.
 */
export async function openPrimeMigrationRepair(
  supabase: Db,
  version: string,
  actorUserId: string | null,
): Promise<RepairProposalResult> {
  let report: RepairPlanReport;
  let patched: string | null;
  try {
    const planned = await planPrimeMigrationRepair(supabase, version);
    report = planned.report;
    patched = planned.patched;
  } catch (e) {
    return { ok: false, error: msg(e), report: null };
  }

  if (report.blocked) return { ok: false, error: report.blocked, report };

  const { plan, target } = report;
  if (!report.proposable || patched === null) {
    return {
      ok: false,
      error: `Nothing was proposed: ${plan.summary}`,
      report,
    };
  }

  const octokit = getAppOctokit();
  const { owner, repo, branch } = target.repo;
  const head = repairBranchName(version);

  // Does a proposal already stand?
  try {
    const existing = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: `${owner}:${head}`,
      state: "open",
      per_page: 1,
    });
    const open = existing.data?.[0];
    if (open) {
      return {
        ok: true,
        state: "already_open",
        url: open.html_url,
        number: open.number,
        branch: head,
        report,
      };
    }
  } catch (e) {
    return { ok: false, error: `Could not check for an open repair: ${msg(e)}`, report };
  }

  // A branch with no open pull request is somebody's closed proposal.
  try {
    await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/${head}`,
    });
    return {
      ok: false,
      error:
        `\`${head}\` already exists on ${owner}/${repo} with no open pull request, which means a ` +
        `repair for this migration was proposed and closed. Re-opening it would overrule that. ` +
        `Delete the branch to propose again. Nothing was changed.`,
      report,
    };
  } catch (e) {
    if ((e as { status?: number })?.status !== 404) {
      return {
        ok: false,
        error: `Could not read \`${head}\` on ${owner}/${repo}: ${msg(e)}`,
        report,
      };
    }
  }

  /*
    The commit the branch points at, and separately the TREE that commit
    carries. `createTree` documents `base_tree` as a tree object, and every
    other writer in this repository resolves the commit first
    (`cascadeConflictMerge.server.ts`) — handing it a commit sha relies on the
    service resolving something it does not promise to, on the one call that
    decides which files the proposal carries. `parents` is the commit.
  */
  let baseSha: string;
  let baseTreeSha: string;
  try {
    const ref = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    baseSha = ref.data.object.sha;
    const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseSha });
    baseTreeSha = baseCommit.data.tree.sha;
  } catch (e) {
    return {
      ok: false,
      error: `Could not read ${owner}/${repo}@${branch}: ${msg(e)}. Nothing was changed.`,
      report,
    };
  }

  let prNumber: number;
  let prUrl: string;
  try {
    const blob = await withRetry(
      () =>
        octokit.git.createBlob({
          owner,
          repo,
          content: Buffer.from(patched, "utf8").toString("base64"),
          encoding: "base64",
        }),
      { attempts: 3, shouldRetry: isTransientHttpError },
    );
    const tree = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: [{ path: target.path, mode: "100644", type: "blob", sha: blob.data.sha }],
    });
    const commit = await octokit.git.createCommit({
      owner,
      repo,
      message: commitMessage(report),
      tree: tree.data.sha,
      parents: [baseSha],
    });
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${head}`,
      sha: commit.data.sha,
    });
    const pr = await octokit.pulls.create({
      owner,
      repo,
      title: `Make ${target.name} safe to run twice`,
      head,
      base: branch,
      body: repairProposalBody(report),
    });
    prNumber = pr.data.number;
    prUrl = pr.data.html_url;
  } catch (e) {
    return { ok: false, error: describeRepairError(e, owner, repo, branch), report };
  }

  /*
    Recorded after the pull request exists, and never before it. An audit row
    written first would name a proposal that may not have been made, and this
    is the register that answers "who changed that migration?".
  */
  await writeAuditLog({
    action: "prime.migration.repair",
    entityType: "prime_migration",
    entityId: version,
    actorUserId,
    metadata: {
      file: target.path,
      name: target.name,
      repo: `${owner}/${repo}`,
      base: branch,
      branch: head,
      pull_request: prNumber,
      outcome: plan.outcome,
      reading_before: plan.before,
      reading_after: plan.after,
      repairs: plan.repairCount,
      refusals: plan.refusalCount,
      headSha: target.headSha,
    },
  });

  return { ok: true, state: "opened", url: prUrl, number: prNumber, branch: head, report };
}

function commitMessage(report: RepairPlanReport): string {
  const { plan, target } = report;
  const kinds = plan.repairKinds.map((k) => REPAIR_WORDS[k]).join(", ");
  return (
    `Guard ${plan.repairCount} statement${plan.repairCount === 1 ? "" : "s"} in ${target.name}\n\n` +
    `Running this migration a second time would ${plan.before === "rewrites_data" ? "change data" : "stop at a statement that creates something already there"}. ` +
    `${plan.repairCount} statement${plan.repairCount === 1 ? "" : "s"} ${plan.repairCount === 1 ? "is" : "are"} guarded here (${kinds || "none"}), ` +
    `after which it reads ${plan.after === "rerunnable" ? "re-runnable" : plan.after.replace(/_/g, " ")}.\n` +
    (plan.refusalCount > 0
      ? `${plan.refusalCount} statement${plan.refusalCount === 1 ? "" : "s"} ${plan.refusalCount === 1 ? "was" : "were"} left alone — see the pull request.\n`
      : "")
  );
}

/** What a reviewer needs, and nothing a reviewer would have to take on trust. */
/**
 * The document a reviewer opens.
 *
 * Exported because it IS a document, and the rule this repository keeps paying
 * for is that what a page draws has to be read rather than inferred from the
 * source that composes it. Its first version filtered omitted lines and blank
 * ones with the same test, which in Markdown means no table renders, no
 * heading closes and the whole body arrives as one paragraph. That was found
 * by printing it, not by reading it.
 */
export function repairProposalBody(report: RepairPlanReport): string {
  const { plan, target } = report;
  const more = plan.repairCount - plan.repairs.length;
  const moreRefused = plan.refusalCount - plan.refusals.length;
  const reads = plan.after === "rerunnable" ? "re-runnable" : RERUN_WORDS[plan.after];

  /*
    `null` is the omission and `""` is a blank line. They were one value once,
    and the filter that dropped the omissions dropped every blank line with
    them — which in Markdown means no table renders, no heading closes and the
    whole body arrives as one paragraph. A reviewer reads this; it has to be a
    document.
  */
  const lines: Array<string | null> = [
    `Opened by **Aurixa Mission Control** from its migration health page.`,
    ``,
    `\`${target.path}\` is one of the migrations the prime has not run. Running it a second ` +
      `time — which is what happens whenever an apply stops part way and is dispatched again, ` +
      `since \`apply-migration.yml\` runs \`psql\` with no \`--single-transaction\` — would ` +
      (plan.before === "rewrites_data"
        ? `**change data rather than stop**.`
        : `**stop at a statement that creates something already there**.`),
    ``,
    `### What changed`,
    ``,
    `Every edit is an insertion. Nothing was deleted, reordered or reformatted, and the patched`,
    `file was re-read to confirm it parses to the statements it had plus the ones inserted here.`,
    ``,
    `| line | what | inserted | why |`,
    `| --- | --- | --- | --- |`,
    ...(plan.repairs.length > 0
      ? plan.repairs.map(
          (r) => `| ${r.line} | ${REPAIR_WORDS[r.kind]} | \`${r.inserted}\` | ${r.what} |`,
        )
      : [`| — | — | — | nothing |`]),
    ``,
    more > 0
      ? more === 1
        ? `_1 further repair is in the diff._`
        : `_${more} further repairs are in the diff._`
      : null,
    more > 0 ? `` : null,
    `After this the file reads **${reads}**` +
      (plan.after === "rerunnable"
        ? `: running it again changes nothing.`
        : `, so it is still not safe to run twice.`),
    ``,
    ...(plan.refusalCount > 0
      ? [
          `### What was deliberately left alone`,
          ``,
          ...plan.refusals.flatMap((r) => [
            `**Line ${r.line} — ${REFUSAL_WORDS[r.kind]}.** ${r.why}`,
            ``,
            "```sql",
            r.excerpt,
            "```",
            ``,
          ]),
          moreRefused > 0
            ? moreRefused === 1
              ? `_1 further statement was left alone._`
              : `_${moreRefused} further statements were left alone._`
            : null,
          moreRefused > 0 ? `` : null,
        ]
      : []),
    `### What to check`,
    ``,
    `- The inserted guards name the same objects the statements below them create.`,
    plan.repairKinds.includes("constraint")
      ? `- A dropped constraint is re-added, which revalidates the table; a key another table ` +
        `references cannot be dropped at all, so a second run can still stop there.`
      : null,
    `- Nothing here has been run against a database. This is a change to the file, and the`,
    `  migration still has to be applied afterwards.`,
    ``,
    `Planned against \`${target.headSha.slice(0, 7)}\`.`,
  ];

  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * GitHub answers a missing branch, a missing repository and a missing
 * permission all with "Not Found". Say which one it probably is.
 *
 * Deliberately not shared with `describeDispatchError`: that one names a
 * workflow and the Actions permission, this one names branches and the
 * Contents/Pull requests permissions, and a shared helper would have to be
 * told which story to tell — which is two functions wearing one name.
 */
function describeRepairError(err: unknown, owner: string, repo: string, base: string): string {
  const status = (err as { status?: number })?.status;
  const message =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  const target = `${owner}/${repo}`;

  if (status === 404 || status === 403) {
    return (
      `GitHub returned ${status} proposing a repair on ${target}@${base}. The Aurixa GitHub App ` +
      `needs **Contents: read & write** and **Pull requests: read & write** on ${target} to open ` +
      `one. Nothing was changed. Detail: ${message}`
    );
  }
  if (status === 422) {
    return (
      `GitHub rejected the proposal on ${target}@${base}: ${message}. That usually means the ` +
      `branch already exists or the base branch name is wrong. Nothing was changed.`
    );
  }
  return `Could not open a repair on ${target}@${base}${status ? ` [${status}]` : ""}: ${message}. Nothing was changed.`;
}
