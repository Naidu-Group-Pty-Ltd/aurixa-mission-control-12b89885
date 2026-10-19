/**
 * Mission Control's own GitHub repository — which is NOT Prime.
 *
 * Prime (`prime_config`) is the product every clone is cut from:
 * `npc-property-dashbord`. Mission Control is the control plane that runs it,
 * from a repository of its own. Two things act on Mission Control's repository
 * and must never touch Prime's:
 *
 * - the digest manifest of Mission Control's own migration queue
 *   (`applied-digests-proposal.server.ts`), and
 * - the ruleset on Mission Control's `main`
 *   (`mission-control-branch-protection.server.ts`).
 *
 * On 19 Oct 2026 both read `prime_config`, and the first digest refresh opened
 * a pull request on Prime carrying Mission Control's manifest. Hence one place
 * that says which repository is meant, and a refusal when it would be Prime's.
 *
 * `MISSION_CONTROL_GITHUB_REPO` (owner/repo) moves it without a deploy.
 */

export const MISSION_CONTROL_REPO_DEFAULT = "Naidu-Group-Pty-Ltd/aurixa-mission-control-12b89885";

export type RepoName = { owner: string; repo: string; fullName: string };

const REPO_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

export function parseRepoName(value: unknown): RepoName | null {
  if (typeof value !== "string") return null;
  const m = REPO_NAME.exec(value.trim());
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1], repo: m[2], fullName: `${m[1]}/${m[2]}` };
}

/** Mission Control's repository: the override when it is a valid name, otherwise the default. */
export function missionControlRepo(
  override: string | undefined = process.env.MISSION_CONTROL_GITHUB_REPO,
): RepoName {
  return parseRepoName(override) ?? (parseRepoName(MISSION_CONTROL_REPO_DEFAULT) as RepoName);
}

/** True when `repo` is Prime's — where nothing meant for Mission Control's repository may go. */
export function isPrimeRepo(
  repo: RepoName,
  prime: { github_owner?: string | null; github_repo?: string | null } | null | undefined,
): boolean {
  if (!prime?.github_owner || !prime?.github_repo) return false;
  return repo.fullName.toLowerCase() === `${prime.github_owner}/${prime.github_repo}`.toLowerCase();
}
