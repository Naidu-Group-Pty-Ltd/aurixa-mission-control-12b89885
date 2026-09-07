/**
 * `last_synced_sha` is a PRIME revision. Everything here asserts that one
 * sentence, because it is not enforced by a type — the column is a string, a
 * clone's HEAD sha is a string, and storing the wrong one produces no error
 * anywhere. It produces a base the prime answers 404 to, on every read, for
 * ever.
 *
 * What that cost: `clone-provisioning.server.ts` read the branch off the CLONE
 * repository. A clone is made with `createUsingTemplate`, which starts a fresh
 * history, so `preflight-property-group@main` (8fefecf) exists in no other
 * repository — the prime answers `No commit found for SHA`. Where the read
 * succeeded the baseline was unusable; where the fresh repo had not propagated
 * yet it fell to the catch and stored null, and `runDriftRefresh` then
 * substituted the clone's HEAD itself and reached the same 404. Every road led
 * to the same place: the comparison threw, the catch wrote `failed`, and
 * `failed` is the one reading the sweep will never lift. Two clones sat in it
 * for a week, looking like a broken cascade, while the cascade was opening
 * their pull requests on schedule with no errors at all.
 *
 * These are structural properties of the source rather than behaviours of a
 * double, for the reason `backendSync.contract.test.ts` gives: a double that
 * agrees with the code teaches nothing about the server.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** A comment quoting code is not code — these tests judge the code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const provisioning = stripComments(read("src/server/clone-provisioning.server.ts"));
const drift = stripComments(read("src/server/drift-refresh.server.ts"));
const planner = read("src/server/backendSync.server.ts");

describe("the baseline a clone is provisioned with is the prime's revision", () => {
  it("reads the branch from the prime repository, never from the new clone", () => {
    const call = provisioning.slice(
      provisioning.indexOf("lastSyncedSha = br.commit.sha") - 400,
      provisioning.indexOf("lastSyncedSha = br.commit.sha"),
    );
    expect(call).toContain("owner: prime.github_owner");
    expect(call).toContain("repo: prime.github_repo");
    expect(call).not.toContain("owner: githubOwner");
    expect(call).not.toContain("repo: githubRepo");
  });

  it("claims in_sync only where a baseline was actually recorded", () => {
    // `in_sync` asserts the clone holds a known prime revision. With no
    // baseline the distance is unmeasurable, not zero.
    expect(provisioning).toContain('sync_status: lastSyncedSha ? "in_sync" : "unknown"');
  });

  it("records no baseline rather than a wrong one when the prime cannot be read", () => {
    expect(provisioning).toContain("lastSyncedSha = null");
  });
});

describe("the drift sweep never invents a baseline", () => {
  it("does not read a branch from the clone repository", () => {
    // The fallback that produced the whole defect. `c` is the clone row in
    // this module, so asking GitHub for `c.github_repo`'s branch is asking the
    // wrong repository for the base of a comparison run against the prime.
    expect(drift).not.toContain("repo: c.github_repo");
  });

  it("still reads the prime's own HEAD, which is the other side of the compare", () => {
    expect(drift).toContain("owner: prime.github_owner");
    expect(drift).toContain("repo: prime.github_repo");
  });

  it("reads unknown — not failed — for a clone with no recorded revision", () => {
    const branch = drift.slice(
      drift.indexOf("const baseSha = c.last_synced_sha"),
      drift.indexOf("compareCommitsWithBasehead"),
    );
    expect(branch).toContain('sync_status: "unknown"');
    expect(branch).not.toContain('sync_status: "failed"');
  });

  it("a measurement that threw is unknown, and never overwrites a cascade's failed", () => {
    // A rate limit, a network blip or an unresolvable base is a fact about
    // this pass. `failed` is an outcome the cascade records, and only a
    // cascade may clear it — so an existing one is carried through untouched.
    expect(drift).toContain(
      'const status: SyncStatus = c.sync_status === "failed" ? "failed" : "unknown";',
    );
  });
});

describe("the contract is stated where the other consumer reads it", () => {
  it("the backend planner still declares the two revisions are the prime's", () => {
    expect(planner).toContain("`fromSha`/`toSha` are PRIME revisions");
  });

  it("and still refuses rather than guesses when it cannot compare them", () => {
    expect(planner).toContain('return "compare_failed"');
  });
});
