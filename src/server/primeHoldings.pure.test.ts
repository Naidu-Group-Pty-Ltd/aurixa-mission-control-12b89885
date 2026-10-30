import { describe, expect, it } from "vitest";
import { EMPTY_BODY_SHA256 } from "./migrationBodyIdentity.pure";
import {
  primeHoldingsOf,
  versionsHeldThroughPrime,
  withVersionsHeldThroughPrime,
} from "./primeHoldings.pure";

/** The demo clone's first failure, 30 Oct 2026: these bytes are `20250912050519` on the prime. */
const FILE = {
  id: "20250912170521",
  name: "20250912170521_208618a7-d33a-4e4b-96c2-455f4efcf772.sql",
};
const PRIME_VERSION = "20250912050519";

/** A digest that is plainly a digest: 64 hex characters. */
const digest = (seed: string) => seed.repeat(64).slice(0, 64);
const A = digest("a");
const B = digest("b");
const C = digest("c");

describe("primeHoldingsOf — where the prime keeps each file's bytes", () => {
  it("names the prime version holding a file's bytes when the prime recorded it under another", () => {
    const holdings = primeHoldingsOf({
      // Any form may match: the ledger stores the body as it was sent.
      files: [{ ...FILE, digests: [A, B] }],
      primeLedger: [{ version: PRIME_VERSION, bodyDigest: B }],
    });
    expect(holdings.get(FILE.name)).toEqual([PRIME_VERSION]);
  });

  it("asks nothing of a file the prime records under its own version", () => {
    const holdings = primeHoldingsOf({
      files: [{ ...FILE, digests: [A] }],
      primeLedger: [
        { version: FILE.id, bodyDigest: C },
        { version: PRIME_VERSION, bodyDigest: A },
      ],
    });
    expect(holdings.size).toBe(0);
  });

  it("names every prime version holding the bytes, in order", () => {
    // `20260812010000_market_updates_archive_indefinite_retention.sql` is
    // recorded on the prime three times, measured 30 Oct 2026.
    const holdings = primeHoldingsOf({
      files: [{ ...FILE, digests: [A] }],
      primeLedger: [
        { version: "20260803105619", bodyDigest: A },
        { version: "20260802094456", bodyDigest: A },
        { version: "20260803104722", bodyDigest: A },
      ],
    });
    expect(holdings.get(FILE.name)).toEqual(["20260802094456", "20260803104722", "20260803105619"]);
  });

  it("never takes the empty body as evidence, on either side", () => {
    const holdings = primeHoldingsOf({
      files: [{ ...FILE, digests: [EMPTY_BODY_SHA256] }],
      primeLedger: [{ version: PRIME_VERSION, bodyDigest: EMPTY_BODY_SHA256 }],
    });
    expect(holdings.size).toBe(0);
  });

  it("gives an unread body nothing: it is decided by its version, as before", () => {
    for (const digests of [undefined, []]) {
      const holdings = primeHoldingsOf({
        files: [{ ...FILE, digests }],
        primeLedger: [
          { version: PRIME_VERSION, bodyDigest: A },
          { version: "x", bodyDigest: null },
        ],
      });
      expect(holdings.size).toBe(0);
    }
  });

  describe("a prime version a corpus file also carries", () => {
    // A clone that RAN the file at that version records it too, so the
    // version proves these bytes only if that file IS these bytes.
    const at = (digests: string[] | undefined) => ({
      id: PRIME_VERSION,
      name: `${PRIME_VERSION}_3cf01085-cbaa-460e-9117-c0ffee000000.sql`,
      digests,
    });
    const ledger = [{ version: PRIME_VERSION, bodyDigest: A }];

    it("translates when that file is the same bytes, read and matched", () => {
      const holdings = primeHoldingsOf({
        files: [{ ...FILE, digests: [A] }, at([C, A])],
        primeLedger: ledger,
      });
      expect(holdings.get(FILE.name)).toEqual([PRIME_VERSION]);
    });

    it("does not translate when that file is different bytes", () => {
      const holdings = primeHoldingsOf({
        files: [{ ...FILE, digests: [A] }, at([B])],
        primeLedger: ledger,
      });
      expect(holdings.has(FILE.name)).toBe(false);
    });

    it("does not translate when that file's body was not read", () => {
      for (const unread of [undefined, []]) {
        const holdings = primeHoldingsOf({
          files: [{ ...FILE, digests: [A] }, at(unread)],
          primeLedger: ledger,
        });
        expect(holdings.has(FILE.name)).toBe(false);
      }
    });
  });
});

describe("versionsHeldThroughPrime — what a clone holds under the prime's versions", () => {
  const corpus = [FILE, { id: "20270209090000", name: "20270209090000_new.sql" }];
  const holdings = new Map([[FILE.name, [PRIME_VERSION]]]);

  it("holds the file's version on a clone that records the prime's version", () => {
    expect(
      versionsHeldThroughPrime({ corpus, holdings, cloneApplied: new Set([PRIME_VERSION]) }),
    ).toEqual([FILE.id]);
  });

  it("holds nothing on a clone that does not record it", () => {
    expect(
      versionsHeldThroughPrime({ corpus, holdings, cloneApplied: new Set(["other"]) }),
    ).toEqual([]);
  });

  it("does not list a version the clone records itself", () => {
    expect(
      versionsHeldThroughPrime({
        corpus,
        holdings,
        cloneApplied: new Set([PRIME_VERSION, FILE.id]),
      }),
    ).toEqual([]);
  });

  it("holds a shared version only when every file at it is held", () => {
    const sibling = { id: FILE.id, name: `${FILE.id}_sibling.sql` };
    const shared = [FILE, sibling];
    const stamped = new Set([PRIME_VERSION]);
    expect(versionsHeldThroughPrime({ corpus: shared, holdings, cloneApplied: stamped })).toEqual(
      [],
    );
    const both = new Map([
      [FILE.name, [PRIME_VERSION]],
      [sibling.name, [PRIME_VERSION]],
    ]);
    expect(
      versionsHeldThroughPrime({ corpus: shared, holdings: both, cloneApplied: stamped }),
    ).toEqual([FILE.id]);
  });

  it("without holdings the clone's own versions decide, exactly as before", () => {
    const recorded = new Set([PRIME_VERSION]);
    expect(
      versionsHeldThroughPrime({ corpus, holdings: undefined, cloneApplied: recorded }),
    ).toEqual([]);
    const union = withVersionsHeldThroughPrime(recorded, corpus, undefined);
    expect([...union]).toEqual([PRIME_VERSION]);
    // A new set, never the caller's: the replay adds nothing to the ledger it read.
    expect(union).not.toBe(recorded);
  });

  it("the union carries the clone's versions and the ones held through the prime", () => {
    expect(
      [...withVersionsHeldThroughPrime(new Set([PRIME_VERSION]), corpus, holdings)].sort(),
    ).toEqual([PRIME_VERSION, FILE.id].sort());
  });
});
