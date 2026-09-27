/**
 * Send a function secret only where the project does not already hold it.
 *
 * ## What this fixes
 *
 * Writing a function secret is not free. Every POST to
 * `/v1/projects/{ref}/secrets` makes Supabase redeploy EVERY edge function on
 * the project — a new version of each, cold-started on its next request —
 * whether or not a single value changed. Mission Control's reconcile sweeps
 * re-assert what they own on every pass, by design (the value cannot be read
 * back, so the only way to be sure it is there was to send it again), and
 * nothing compared what was about to be sent with what was already stored.
 *
 * Measured 27 Sep 2026 from the projects' own edge logs. On NPC Test every
 * function's version advanced EIGHT times an hour: once at :00 and :30 (the
 * signing pair) and three times at :07–:08 and :37–:38 (owned secrets, the
 * Mission Control link, the derived config), while every value sent was the
 * one already stored. One cron-driven function stood at version 4,141 three
 * weeks after these sweeps began. The prime's functions advanced once an hour
 * at :52 — the `prime-secret-pairs` job, whose header already promised that
 * "a pass over a prime that already agrees writes nothing". Every redeploy
 * cold-starts every function, and a request that lands on the boundary is
 * refused: `migration-dispatcher`, called by pg_cron every 15 s, answered 503
 * in 10–222 ms, with no function version in the log line, four times in a day
 * — at 06:00:16, 09:00:11, 00:00:15 and 03:30:12, each within seconds of the
 * signing pair's write at :00:15 / :30:15.
 *
 * ## The rules
 *
 * **The value cannot be read back, but it can be recognised.** The list
 * endpoint returns, for each name, a digest of the stored value rather than
 * the value (the dashboard heads that column "Digest · SHA256"). A value whose
 * digest is the one stored IS the stored value, so sending it would change
 * nothing but every function's version number.
 *
 * **Only a proof skips a write.** The list could not be read, the name is not
 * in it, the stored digest matches no form computed here, or the same name
 * appears twice in one batch — each of those writes exactly what the caller
 * asked, which is what every write did before this. So the worst a wrong
 * assumption about the digest can do is leave that behaviour standing; it can
 * never leave a stale value in place.
 *
 * **Two digest forms are recognised**, because a match under either is proof
 * and a miss under both costs only the write: SHA-256 of the value, and
 * HMAC-SHA256 of the value keyed by the project ref — the form `supabase
 * config push` computes to compare the platform's other secret-bearing
 * settings (`secretDigestHex` in the CLI). Hex, compared without regard to
 * case.
 *
 * **A batch is sent whole or not at all.** The entries in one call were put
 * together to arrive together — a key and the address it is scoped to, a pair
 * of ids a vendor reads as one credential. When every entry is proven held,
 * nothing is sent. When any entry differs, the WHOLE batch goes, exactly as
 * asked, never the differing entries alone. Filtering would save nothing (one
 * request redeploys the project once, whatever it carries) and it would break
 * the pair under a second writer: between this read and this write another
 * caller can replace both halves, and a filtered request would then land one
 * half of this batch beside the other half of theirs. Sent whole, the last
 * writer's pair is the one that stands, which is what every write did before
 * this.
 *
 * Pure: no I/O. Hashing is computation, not a read.
 */

import { createHash, createHmac } from "node:crypto";

export type SecretEntry = { name: string; value: string };

/** Name → the digest the Management API reports for that name's stored value. */
export type StoredSecretDigests = ReadonlyMap<string, string>;

/**
 * Read the list endpoint's body into name → digest.
 *
 * Returns `null` for anything that is not the documented array, because "we
 * could not tell what is stored" must never read as "nothing is stored and
 * nothing matches" — the caller writes everything on `null`, which is the safe
 * direction either way, but a caller reporting what happened should be able to
 * say which it was. A row without a string name and a string digest is left
 * out (its name then counts as not stored, and is written). A name listed twice
 * with two different digests is ambiguous, so it is left out too.
 */
export function parseStoredSecretDigests(raw: unknown): Map<string, string> | null {
  if (!Array.isArray(raw)) return null;
  const digests = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const { name, value } = row as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof value !== "string") continue;
    const digest = value.trim().toLowerCase();
    if (digest.length === 0) continue;
    const held = digests.get(name);
    if (held !== undefined && held !== digest) ambiguous.add(name);
    digests.set(name, digest);
  }
  for (const name of ambiguous) digests.delete(name);
  return digests;
}

/** Every digest form a stored copy of `value` may be reported under, as lowercase hex. */
export function valueDigests(projectRef: string, value: string): readonly string[] {
  return [
    createHash("sha256").update(value, "utf8").digest("hex"),
    createHmac("sha256", projectRef).update(value, "utf8").digest("hex"),
  ];
}

export type SecretWritePlan = {
  /**
   * What to send: every entry, in the caller's order, or nothing at all. Empty
   * means the project already holds all of it.
   */
  write: SecretEntry[];
  /** Names left out because the project already holds exactly that value — all of them, or none. */
  unchanged: string[];
  /** Set when nothing was compared, and why. Everything asked for is then written. */
  uncompared: null | "list_unreadable" | "repeated_name";
};

/**
 * What one secrets write did, by name. Values and digests never appear here:
 * this is what callers log, count and put on timelines.
 */
export type SecretWriteResult =
  | { ok: true; written: string[]; unchanged: string[] }
  | { ok: false; error: string };

export function planSecretWrite(
  projectRef: string,
  entries: readonly SecretEntry[],
  stored: StoredSecretDigests | null,
): SecretWritePlan {
  if (stored === null) {
    return { write: [...entries], unchanged: [], uncompared: "list_unreadable" };
  }
  // Two entries for one name leave "which one the platform keeps" to it, so no
  // digest can prove what the batch would leave behind; it is sent as asked.
  const names = new Set(entries.map((e) => e.name));
  if (names.size !== entries.length) {
    return { write: [...entries], unchanged: [], uncompared: "repeated_name" };
  }

  const held = (entry: SecretEntry): boolean => {
    const digest = stored.get(entry.name);
    return digest !== undefined && valueDigests(projectRef, entry.value).includes(digest);
  };
  // All or nothing — see "A batch is sent whole" above.
  if (entries.every(held)) {
    return { write: [], unchanged: entries.map((e) => e.name), uncompared: null };
  }
  return { write: [...entries], unchanged: [], uncompared: null };
}
