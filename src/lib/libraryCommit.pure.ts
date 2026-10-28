/**
 * The prime commit a library entry was approved at, as it is checked and shown.
 *
 * A library entry is approved when an admin publishes it, and it records the
 * commit its module's files were detected at (`module_library.source_commit_sha`,
 * copied from `module_detection_runs.commit_sha`; docs/DELIVERY_SYSTEM_PLAN.md,
 * D19). The server refuses an entry without one and the pages show the one it
 * has, so both read the rule here: one spelling of what a commit is, and one of
 * how it is written down, rather than a regex on each side.
 */

/** GitHub's commit SHA: 40 lowercase hexadecimal characters, as its API answers it. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Whether `value` is a full commit SHA, the only thing an entry may record as its commit. */
export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA.test(value);
}

/** The first seven characters, as `git log --oneline` and every page here abbreviate a SHA. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}

/** `prime@abc1234` for a recorded commit, and null for anything that is not one. */
export function primeCommitLabel(sha: string | null | undefined): string | null {
  return isCommitSha(sha) ? `prime@${shortCommit(sha)}` : null;
}
