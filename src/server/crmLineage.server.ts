/**
 * The reads and the one GitHub write behind a clone's CRM line.
 *
 * `crmLineage.pure.ts` decides; this module only gathers what it decides on,
 * binding every error so that a failed read reaches the judge as `readFailed`
 * rather than as an empty answer. That distinction is the whole contract: an
 * unreadable `prime_config` must refuse the provision, and an unchecked error
 * here would present it as "no parent recorded" and send the operator to the
 * wrong remedy.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { CRM_MODES, CRM_PARENT_COLUMN, type CrmMode } from "@/lib/crmMode.pure";
import { judgeCrmParent, type CrmParentJudgement, type CrmParentRow } from "./crmLineage.pure";

type Supabase = SupabaseClient<Database>;

const PARENT_COLUMNS =
  "id, name, github_owner, github_repo, github_url, default_branch, last_synced_sha, crm_mode, sync_scope, parent_clone_id";

/** Both lines' parents, read once. */
export async function readCrmLineageRoots(
  supabase: Supabase,
): Promise<Record<CrmMode, CrmParentJudgement>> {
  const { data: cfg, error: cfgErr } = await supabase
    .from("prime_config")
    .select("crm_dependent_parent_clone_id, crm_independent_parent_clone_id")
    .limit(1)
    .maybeSingle();

  if (cfgErr) {
    return {
      dependent: judgeCrmParent({
        mode: "dependent",
        parentId: null,
        parent: null,
        readFailed: true,
        readError: cfgErr.message,
      }),
      independent: judgeCrmParent({
        mode: "independent",
        parentId: null,
        parent: null,
        readFailed: true,
        readError: cfgErr.message,
      }),
    };
  }

  const ids = {
    dependent: (cfg?.[CRM_PARENT_COLUMN.dependent] as string | null | undefined) ?? null,
    independent: (cfg?.[CRM_PARENT_COLUMN.independent] as string | null | undefined) ?? null,
  } satisfies Record<CrmMode, string | null>;

  const wanted = [...new Set(CRM_MODES.map((m) => ids[m]).filter((v): v is string => Boolean(v)))];
  let rows: CrmParentRow[] = [];
  let rowsError: string | null = null;
  if (wanted.length > 0) {
    const { data, error } = await supabase.from("clones").select(PARENT_COLUMNS).in("id", wanted);
    if (error) rowsError = error.message;
    else rows = (data ?? []) as CrmParentRow[];
  }

  const judge = (mode: CrmMode): CrmParentJudgement =>
    judgeCrmParent({
      mode,
      parentId: ids[mode],
      parent: rows.find((r) => r.id === ids[mode]) ?? null,
      readFailed: Boolean(ids[mode]) && rowsError !== null,
      readError: rowsError,
    });

  return { dependent: judge("dependent"), independent: judge("independent") };
}

/** One line's parent, judged. */
export async function readCrmParent(
  supabase: Supabase,
  mode: CrmMode,
): Promise<CrmParentJudgement> {
  const roots = await readCrmLineageRoots(supabase);
  return roots[mode];
}

/** Anything with the two repository calls this needs — an Octokit, or a fake. */
export interface TemplateFlagClient {
  repos: {
    get(args: { owner: string; repo: string }): Promise<{ data: { is_template?: boolean } }>;
    update(args: { owner: string; repo: string; is_template: boolean }): Promise<unknown>;
  };
}

export type EnsureTemplateResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * Make `owner/repo` a template repository, so `createUsingTemplate` can copy it.
 *
 * The template path is the only path for same-organisation provisioning:
 * GitHub will not fork a repository into the organisation that owns it. And
 * `createUsingTemplate` answers a source without the template FLAG with 404 —
 * "Not Found" is how that endpoint reports it, not 403 — so the flag is set
 * here rather than discovered by the creation failing.
 *
 * The flag is repository metadata the App holds admin for (the agreement path
 * sets it on the prime the same way). It grants nothing: it lets a repository
 * be used as a starting point, which anyone who can read it could do by
 * copying it. Idempotent — a repository already flagged costs one read.
 */
export async function ensureTemplateRepository(
  octokit: TemplateFlagClient,
  ref: { owner: string; repo: string },
): Promise<EnsureTemplateResult> {
  let isTemplate: boolean;
  try {
    const { data } = await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
    isTemplate = data.is_template === true;
  } catch (e) {
    return {
      ok: false,
      reason:
        `Could not read ${ref.owner}/${ref.repo} to check it can be copied from ` +
        `(${e instanceof Error ? e.message : String(e)}).`,
    };
  }
  if (isTemplate) return { ok: true, changed: false };

  try {
    await octokit.repos.update({ owner: ref.owner, repo: ref.repo, is_template: true });
    return { ok: true, changed: true };
  } catch (e) {
    return {
      ok: false,
      reason:
        `${ref.owner}/${ref.repo} is not marked as a template repository and the GitHub App could ` +
        `not set it (${e instanceof Error ? e.message : String(e)}). Fix by hand: ` +
        `${ref.owner}/${ref.repo} → Settings → tick "Template repository", then provision again.`,
    };
  }
}
