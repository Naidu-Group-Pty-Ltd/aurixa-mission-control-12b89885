/**
 * The User-Agent every GitHub request this fleet makes must carry.
 *
 * ## The one clone this was
 *
 * `npc-test-76b3b3` stopped advancing its schema on 16 September 2026 and
 * stayed stopped. Its `clone_backends.status_detail` carried the reason
 * verbatim, and the reason was not the one anybody read:
 *
 * > The prime's copy of `20261202000000_seed_template_library_v13_cash_flow_foots.sql`
 * > could not be read (HTTP 403): *Request forbidden by administrative rules.
 * > **Please make sure your request has a User-Agent header***
 * > (https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#user-agent-)
 *
 * That migration is 41,671,969 bytes, which is why it is the only file on the
 * fleet that takes the streaming path, and why the failure looked like a size
 * or a quota problem. It was neither. `fetchBlobTextStream` was the one place
 * in `src/server` that called `fetch` against `api.github.com` by hand instead
 * of going through Octokit — and Octokit sets a User-Agent on every request it
 * makes, which is exactly why every other GitHub lane in this system worked
 * and only this one did not. Measured at the time: the installation was around
 * 750 calls into a 5,000/hour window with every other lane flowing.
 *
 * So it was deterministic, not intermittent. Every blob that path has ever
 * been asked to stream was refused, on every attempt, for ever — a permanent
 * block that wore a rate limit's status code.
 *
 * ## The rule
 *
 * **Every request to GitHub names itself.** A raw `fetch` is admitted here
 * only with this header on it, and `githubUserAgent.contract.test.ts` reads
 * the server tree and fails on any `api.github.com` fetch without one — the
 * cheapest possible guard against a second hand-rolled call reintroducing a
 * refusal that no status code distinguishes from four other things.
 *
 * Client-safe: a string and nothing else.
 */

/**
 * Identifies this deployment to GitHub.
 *
 * GitHub asks for "the name of your application" and treats the header's
 * absence — not its contents — as the refusal, so the only thing that matters
 * here is that it is present, stable and attributable to us.
 */
export const GITHUB_USER_AGENT = "AurixaMissionControl/1.0 (+https://aurixasystems.com.au)";
