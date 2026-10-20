/**
 * When the deploy ledger may vouch for a clone's copy — and the many ways it
 * must decline to.
 *
 * Every doubt resolves to OWED. A redeploy costs one call; a bundle wrongly
 * believed current is a tenant running code nobody can see is stale.
 */
import { describe, expect, it } from "vitest";
import { isLedgeredCopy, ledgerCurrentSlugs, type LedgerEntry } from "./edgeBundleLedger.pure";
import type { ProjectFunctionCopy } from "./projectFunctionCopies.pure";

const T = Date.parse("2026-10-20T06:00:00.000Z");
const entry = (
  digest = "d1",
  functionId: string | null = "fn-1",
  functionVersion: number | null = 41,
): LedgerEntry => ({ digest, functionId, functionVersion });
const copy = (over: Partial<ProjectFunctionCopy> = {}): ProjectFunctionCopy => ({
  updatedMs: T,
  id: "fn-1",
  version: 41,
  active: true,
  ...over,
});

describe("isLedgeredCopy — is the clone's copy the very deploy this lane made?", () => {
  it("is, where the clone lists the same function at the same version", () => {
    expect(isLedgeredCopy(entry(), copy())).toBe(true);
  });

  it("is not, once anything has deployed the function since — however soon after", () => {
    // The clone's own CI deploying the same slug a minute after this lane: a
    // clock window would have taken that copy for this one. The version cannot.
    expect(isLedgeredCopy(entry(), copy({ version: 42, updatedMs: T + 60_000 }))).toBe(false);
  });

  it("is not, where the function was deleted and made again under a new id", () => {
    expect(isLedgeredCopy(entry(), copy({ id: "fn-2" }))).toBe(false);
  });

  it("is not, where the clone holds an EARLIER version than the one recorded", () => {
    // The deploy the ledger records is not what the clone serves.
    expect(isLedgeredCopy(entry(), copy({ version: 40 }))).toBe(false);
  });

  it("is not, where the clone does not list the function or it is not ACTIVE", () => {
    expect(isLedgeredCopy(entry(), undefined)).toBe(false);
    expect(isLedgeredCopy(entry(), copy({ active: false }))).toBe(false);
  });

  it("is not, where either side failed to say which deploy it was", () => {
    expect(isLedgeredCopy(entry("d1", null, 41), copy())).toBe(false);
    expect(isLedgeredCopy(entry("d1", "fn-1", null), copy())).toBe(false);
    expect(isLedgeredCopy(entry(), copy({ id: null }))).toBe(false);
    expect(isLedgeredCopy(entry(), copy({ version: null }))).toBe(false);
    // Two unknowns are not a match.
    expect(isLedgeredCopy(entry("d1", null, null), copy({ id: null, version: null }))).toBe(false);
  });

  it("does not consult the clock at all", () => {
    // A copy listed long after the deploy is still that deploy if nothing has
    // been written over it: a clone untouched for a month owes nothing new.
    expect(isLedgeredCopy(entry(), copy({ updatedMs: T + 30 * 86_400_000 }))).toBe(true);
  });
});

describe("ledgerCurrentSlugs — what this pass may skip on the ledger's word", () => {
  const ledger = new Map<string, LedgerEntry>([
    ["unchanged", entry("same", "u", 7)],
    ["changed", entry("old", "c", 7)],
    ["replaced", entry("same", "r", 7)],
    ["missing", entry("same", "m", 7)],
  ]);
  const digests = new Map([
    ["unchanged", "same"],
    ["changed", "new"],
    ["replaced", "same"],
    ["missing", "same"],
    ["never-deployed", "x"],
  ]);
  const copies = new Map<string, ProjectFunctionCopy>([
    ["unchanged", copy({ id: "u", version: 7 })],
    ["changed", copy({ id: "c", version: 7 })],
    ["replaced", copy({ id: "r", version: 8 })],
    ["never-deployed", copy({ id: "n", version: 1 })],
  ]);

  it("vouches only where the digest still matches AND the copy is still this lane's", () => {
    expect(ledgerCurrentSlugs({ ledger, digests, copies })).toEqual(["unchanged"]);
  });

  it("re-owes a bundle the prime changed, however recently it was deployed", () => {
    expect(ledgerCurrentSlugs({ ledger, digests, copies })).not.toContain("changed");
  });

  it("re-owes a copy written since by anything else, however unchanged its digest", () => {
    expect(ledgerCurrentSlugs({ ledger, digests, copies })).not.toContain("replaced");
  });

  it("re-owes a function the clone no longer lists", () => {
    expect(ledgerCurrentSlugs({ ledger, digests, copies })).not.toContain("missing");
  });

  it("vouches for nothing the prime's tree does not define", () => {
    // A row for a function the prime has since removed is nothing this lane
    // owes — and nothing it can vouch for either.
    const withGone = new Map([...ledger, ["removed-from-prime", entry("same", "g", 1)]]);
    const listed = new Map([...copies, ["removed-from-prime", copy({ id: "g", version: 1 })]]);
    expect(ledgerCurrentSlugs({ ledger: withGone, digests, copies: listed })).toEqual([
      "unchanged",
    ]);
  });

  it("vouches for nothing at all from an empty ledger, which is the first pass ever", () => {
    expect(ledgerCurrentSlugs({ ledger: new Map(), digests, copies })).toEqual([]);
  });

  it("vouches for nothing where the clone's list could not be read", () => {
    // The reader answers an empty map on any failure — no copy, no proof.
    expect(ledgerCurrentSlugs({ ledger, digests, copies: new Map() })).toEqual([]);
  });
});
