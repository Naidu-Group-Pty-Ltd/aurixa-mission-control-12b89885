/**
 * A clone stamped from the prime holds what the prime holds, under the
 * prime's versions.
 *
 * ## The hole this closes
 *
 * A clone built by introspection gets its ledger from
 * `stampMigrationLedgerFromPrime`: every version the PRIME's ledger records,
 * with no body (`statements = '{}'`). The fleet lane then asks that ledger for
 * each corpus file by the FILE's version. For a file the prime recorded under
 * the version in its name, that works. For one Lovable applied, it cannot: the
 * prime's ledger carries the moment Lovable applied it, not the version in the
 * filename, which is why `scopeCorpusToPrime` clears 606 of this corpus's
 * files by their BODY rather than their version (`migrationBodyIdentity.pure.ts`).
 *
 * The scope knew those files were run on the prime; the clone side was never
 * told under which version. So every one of them read as missing on a stamped
 * clone and was sent again, and the first that is not idempotent blocked the
 * clone. Measured 30 Oct 2026 on `tutorial-demo-orrimere-c158c7`, provisioned
 * the evening before: its ledger is the prime's, version for version (1,166
 * rows, plus the one file the lane applied), every row without a body, and the
 * lane read **594** runnable versions as owed. The first that failed was
 * `20250912170521_208618a7….sql` — `relation "investment_reports" already
 * exists` — whose bytes the prime records as `20250912050519`, twelve hours
 * and two seconds away, and which the demo's ledger records too.
 *
 * ## The rule
 *
 * **A corpus file whose bytes the prime's ledger holds at version P is held by
 * every clone whose ledger records P.** A stamp copies P only because the
 * prime's schema, which the clone was built from, already held those bytes. It
 * is the same trust a version match has always been given — the lane skips a
 * stamped version without asking what ran under it — carried through the one
 * identity the prime itself proves: the bytes.
 *
 * With it, the demo is owed **3** versions, the three the prime ran after the
 * demo was built.
 *
 * ## The one version that does not translate
 *
 * A clone's P need not be a stamp. A clone that RAN a corpus file whose own
 * version is P records P too, and that file's bytes may not be these. So P
 * translates only when every corpus file at P is the SAME executable bytes —
 * a body read and matched, never assumed. Measured on the same corpus: seven
 * hand-named files hold the bytes of a Lovable file at the prime's version
 * (`20260812010000_market_updates_archive_indefinite_retention.sql` is
 * `20260802094456_3cf01085….sql`, recorded on the prime three times), and in
 * every case the file at P is byte-identical, so all seven translate. A file
 * at P whose body was not read, or reads different, stops it — the version
 * test alone decides, exactly as before.
 *
 * ## Why not read the clone's own bodies
 *
 * There are none to read. A stamp writes `ARRAY[]::text[]`, so every row on a
 * stamped clone digests to the empty body, which is never evidence
 * (`EMPTY_BODY_SHA256`). The prime's ledger is where the bytes are.
 *
 * ## Failure falls one way
 *
 * Holdings come from the corpus digest pass and the prime's ledger read, both
 * best-effort. Anything unread leaves a file without holdings, and a file
 * without holdings is decided by its version, which is the behaviour before
 * this module existed. Nothing here can make a version owed that was not, and
 * nothing unread can make one held.
 */

import { EMPTY_BODY_SHA256 } from "./migrationBodyIdentity.pure";

/** Corpus file NAME → the prime ledger versions holding that file's bytes. */
export type PrimeHoldings = ReadonlyMap<string, readonly string[]>;

/**
 * Which prime ledger versions hold each corpus file's bytes.
 *
 * Asked only of files whose own version the prime does not record: a file the
 * prime records by version needs no translation, and a stamped clone records
 * that version itself.
 *
 * @param files Every corpus file, with the digests of its body forms
 *   (`bodyDigests` in `primeBodyDigests.server.ts`). `undefined` or empty is a
 *   body that was not read, and such a file neither gains holdings nor lets
 *   another file translate through its version.
 * @param primeLedger The prime's ledger rows, with each body's digest by
 *   `LEDGER_BODY_DIGEST_SQL`; null for a row the read could not digest.
 */
export function primeHoldingsOf(input: {
  files: readonly { id: string; name: string; digests: readonly string[] | undefined }[];
  primeLedger: readonly { version: string; bodyDigest: string | null }[];
}): Map<string, string[]> {
  const recorded = new Set(input.primeLedger.map((r) => r.version));
  const versionsByDigest = new Map<string, string[]>();
  for (const row of input.primeLedger) {
    if (!row.bodyDigest || row.bodyDigest === EMPTY_BODY_SHA256) continue;
    const at = versionsByDigest.get(row.bodyDigest);
    if (at) at.push(row.version);
    else versionsByDigest.set(row.bodyDigest, [row.version]);
  }
  const filesAt = new Map<string, (typeof input.files)[number][]>();
  for (const f of input.files) {
    const at = filesAt.get(f.id);
    if (at) at.push(f);
    else filesAt.set(f.id, [f]);
  }

  const out = new Map<string, string[]>();
  for (const f of input.files) {
    if (recorded.has(f.id)) continue;
    const own = new Set((f.digests ?? []).filter((d) => d !== EMPTY_BODY_SHA256));
    if (own.size === 0) continue;
    const versions = new Set<string>();
    for (const d of own) for (const v of versionsByDigest.get(d) ?? []) versions.add(v);
    const translating = [...versions].filter((v) =>
      // Every corpus file AT that version must be these bytes, read and matched:
      // a clone that ran one of them records the same version.
      (filesAt.get(v) ?? []).every((g) => (g.digests ?? []).some((d) => own.has(d))),
    );
    if (translating.length > 0) out.set(f.name, translating.sort());
  }
  return out;
}

/**
 * The corpus versions a clone holds through the prime's record of their bytes,
 * beyond the versions its own ledger records.
 *
 * A version is held when EVERY file at it is: one file whose bytes the clone
 * cannot be shown to hold leaves the whole version owed, the rule
 * `sharedVersionDelivery.pure.ts` applies to sending it.
 */
export function versionsHeldThroughPrime(input: {
  corpus: readonly { id: string; name: string }[];
  holdings: PrimeHoldings | undefined;
  cloneApplied: ReadonlySet<string>;
}): string[] {
  const holdings = input.holdings;
  if (!holdings || holdings.size === 0) return [];
  const namesAt = new Map<string, string[]>();
  for (const f of input.corpus) {
    const at = namesAt.get(f.id);
    if (at) at.push(f.name);
    else namesAt.set(f.id, [f.name]);
  }
  const held: string[] = [];
  for (const [version, names] of namesAt) {
    if (input.cloneApplied.has(version)) continue;
    const every = names.every((n) =>
      (holdings.get(n) ?? []).some((v) => input.cloneApplied.has(v)),
    );
    if (every) held.push(version);
  }
  return held.sort();
}

/** The clone's recorded versions, with those it holds through the prime. */
export function withVersionsHeldThroughPrime(
  cloneApplied: ReadonlySet<string>,
  corpus: readonly { id: string; name: string }[],
  holdings: PrimeHoldings | undefined,
): Set<string> {
  return new Set([
    ...cloneApplied,
    ...versionsHeldThroughPrime({ corpus, holdings, cloneApplied }),
  ]);
}
