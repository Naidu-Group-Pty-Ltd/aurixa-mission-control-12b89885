/**
 * The headers every direct call to `api.github.com` must carry.
 *
 * ## Why this is a helper and not a constant
 *
 * GitHub refuses a request with no `User-Agent`, and it refuses it with a 403
 * — the same status it uses for a permission failure and for a secondary rate
 * limit. Octokit sets one for you, so every call through `getAppOctokit` has
 * always been fine. A RAW `fetch` does not, and there is nothing to notice:
 * the request compiles, runs, and comes back forbidden.
 *
 * Measured 19 Sep 2026. `fetchBlobTextStream` — the one path that can carry a
 * migration too large to hold in memory — had `Authorization`, `Accept` and
 * `X-GitHub-Api-Version` and no `User-Agent`, so it had **never once
 * succeeded**. The 40 MB template-library seed was unreachable on every clone
 * from the day that function was written, and the error it produced said only
 * `Streaming blob b92e5e8 failed: HTTP 403`. Three clones were taken out of
 * the fleet under the name of a migration none of them had been sent, and two
 * separate rounds of work went into deciding whether the 403 was a quota
 * before anyone could read what GitHub actually said:
 *
 *   > Request forbidden by administrative rules. Please make sure your request
 *   > has a User-Agent header.
 *
 * The neighbouring raw fetch in `github-preflight.functions.ts` had it right
 * all along, in all three of its call sites. One module got it and one did
 * not, which is the argument for this file: the headers are assembled in ONE
 * place, so the next raw fetch cannot be written without them.
 *
 * @see githubRawFetch.contract.test.ts, which derives the call sites from
 *      source rather than trusting this to be remembered.
 */

/**
 * GitHub asks that this identify the application, and uses it when it needs to
 * contact an integrator about a misbehaving client. A literal at each call site
 * is how three of them come to disagree.
 */
export const GITHUB_USER_AGENT = "aurixa-mission-control";

/** The API version every call in this codebase is written against. */
export const GITHUB_API_VERSION = "2022-11-28";

/**
 * Headers for a direct call to the GitHub REST API.
 *
 * `token` is either an installation token or an App JWT — both are sent as
 * `Bearer`, and this deliberately does not care which, because the header set
 * is the same and a helper that asked would only be a second thing to get
 * wrong.
 *
 * `accept` overrides the default for the endpoints that need a media type of
 * their own (the blob endpoint asks for `…raw+json` so the bytes arrive as a
 * stream rather than base64 inside a JSON document).
 */
export function githubApiHeaders(
  token: string,
  overrides?: { accept?: string },
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: overrides?.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    // The one that was missing. Never optional, and never a literal at a call
    // site — see this module's header for what its absence cost.
    "User-Agent": GITHUB_USER_AGENT,
  };
}
