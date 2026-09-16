/**
 * What is left of the App installation's hourly window, asked for free.
 *
 * `GET /rate_limit` does not count against any limit, so this is the one
 * read that is always affordable. `null` means the allowance could not be
 * read — callers treat that as "proceed as before" (`decideSpend` fails
 * open), never as zero: a policy trippable by its own telemetry is a second
 * outage. See cascade/githubBudget.pure.ts for who yields at which floor.
 */
import { getAppOctokit } from "./github-app.server";

export async function readGitHubRemaining(): Promise<number | null> {
  try {
    const octokit = getAppOctokit();
    const { data } = await octokit.rateLimit.get();
    const remaining = data?.resources?.core?.remaining ?? data?.rate?.remaining;
    return typeof remaining === "number" ? remaining : null;
  } catch (e) {
    console.warn(
      "[github-allowance] could not read the rate limit:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}
