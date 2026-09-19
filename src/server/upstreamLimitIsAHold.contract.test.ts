/**
 * A quota refusal is a HOLD, not a failed migration.
 *
 * Measured 19 Sep 2026. `NPC Client Dashboard`, `NPC Test` and `Preflight
 * Property Group` were all moved to `failed` between 02:14 and 03:34, each
 * with `status_detail` reading `Migration failed at
 * 20261124000000_builder_portal_decommission…` and `error_message` reading
 * `API rate limit exceeded for installation ID 157200201`. Three clones left
 * the fleet, every one of them named after a migration it had never been
 * sent, because the App installation's hourly window was spent.
 *
 * The mechanism, exactly: the prime's migration bodies are fetched from
 * GitHub inside the replay loop. A quota refusal there is not an
 * `OversizedMigrationError`, so the inner catch rethrew it into the generic
 * failure path, where it became `{ success: false }` — and both consumers
 * read `!success && !heldOversize` as "the clone rejected something".
 *
 * `runQueuedBackendProvisioning` already classified this correctly for the
 * provisioning lane and held the row out of `failed`. The fleet-migration
 * lane calls the replay DIRECTLY and never reaches that catch, which is why
 * the rule now lives where the result is MADE rather than in one caller's
 * error handler — the same argument the oversize hold answered to, one cause
 * later.
 *
 * These pin the split. They are deliberately source-level, like
 * `seedStreaming.contract.test.ts`: what is being asserted is the SHAPE of a
 * branch inside a loop that needs a live Management API and a live GitHub
 * installation to execute.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isUpstreamRateLimit } from "./provisioningBudget";

const replay = readFileSync("src/server/backend-provisioning.server.ts", "utf8");
const fleet = readFileSync("src/server/fleet-migration.server.ts", "utf8");
const button = readFileSync("src/server/migration-sync.functions.ts", "utf8");

function sliceFrom(src: string, anchor: string, length = 6_000): string {
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  return src.slice(at, at + length);
}

describe("the classifier recognises what production actually said", () => {
  it("matches the message three clones were failed under", () => {
    // Verbatim from `clone_backends.error_message`, 19 Sep 2026. A classifier
    // that does not match THIS string is decorative.
    const real = new Error("API rate limit exceeded for installation ID 157200201");
    expect(isUpstreamRateLimit(real)).toBe(true);
  });

  it("matches a 429 whatever it says, and GitHub's secondary-limit wording", () => {
    expect(isUpstreamRateLimit({ status: 429 })).toBe(true);
    expect(isUpstreamRateLimit(new Error("You have exceeded a secondary rate limit"))).toBe(true);
  });

  it("does not match an ordinary migration failure", () => {
    // The cost of a false positive here is the opposite defect: a clone that
    // really did reject a migration would be left in the fleet reporting a
    // wait that never ends.
    expect(isUpstreamRateLimit(new Error('relation "foo" does not exist'))).toBe(false);
    expect(isUpstreamRateLimit(new Error("syntax error at or near GRANT"))).toBe(false);
    // "rate" and "limit" as ordinary words, with no refusal in the sentence.
    expect(isUpstreamRateLimit(new Error("could not set the rate limit column"))).toBe(false);
  });
});

describe("the replay holds a body a quota refused", () => {
  const loop = sliceFrom(replay, "sql = m.sql ?? (loadSql", 3_000);

  it("asks about the quota BEFORE the oversize rethrow", () => {
    // Order is the whole fix. The rethrow on the next line is what sent a
    // quota refusal to the generic failure path, so anything that must not go
    // there has to be caught above it.
    const quotaAt = loop.indexOf("isUpstreamRateLimit(e)");
    const rethrowAt = loop.indexOf("if (!(e instanceof OversizedMigrationError)) throw e;");
    expect(quotaAt, "the quota check is missing").toBeGreaterThan(-1);
    expect(rethrowAt).toBeGreaterThan(-1);
    expect(quotaAt).toBeLessThan(rethrowAt);
  });

  it("records it as a hold and halts, rather than throwing", () => {
    const branch = loop.slice(
      loop.indexOf("isUpstreamRateLimit(e)"),
      loop.indexOf("if (!(e instanceof OversizedMigrationError))"),
    );
    expect(branch).toContain("heldUpstreamLimited: true");
    expect(branch).toContain("success: false");
    // Halting is required — later versions would run against a schema missing
    // this one's effect — but it must halt WITHOUT throwing.
    expect(branch).toContain("break;");
    expect(branch).not.toContain("throw ");
  });

  it("keeps the flag distinct from the oversize hold", () => {
    // Two holds, two causes, two remedies: one is waited out, the other is
    // carried by the chunking lane. A single flag would send an operator to
    // the wrong one.
    expect(replay).toContain("heldUpstreamLimited?: boolean;");
    expect(replay).toContain("heldOversize?: boolean;");
  });
});

describe("neither consumer reads a quota refusal as a rejection", () => {
  for (const [name, src] of [
    ["the fleet sync", fleet],
    ["the admin button", button],
  ] as const) {
    it(`${name} excludes it from failures`, () => {
      // The exact expression that ejected three clones. `!success &&
      // !heldOversize` was true for a quota refusal.
      const at = src.indexOf("const failures = results.filter(");
      expect(at, "failure partition not found").toBeGreaterThan(-1);
      const expr = src.slice(at, src.indexOf(";", at));
      expect(expr).toContain("!r.heldUpstreamLimited");
    });

    it(`${name} names it as a wait rather than a failure`, () => {
      expect(src).toContain("upstream API rate limit refused it");
      // The sentence an operator reads must not send them looking for what
      // the clone rejected, because nothing was sent to it.
      expect(src).toContain("the clone is unchanged and still in the");
    });
  }

  it("the fleet sync does not count a refused pass as up to date", () => {
    // `upToDate` means "already level with the prime". A pass that could not
    // fetch what it meant to send has established nothing of the kind, and
    // counting it there reported a fleet held up by an exhausted window as a
    // fleet in perfect health.
    const at = fleet.indexOf("out.upToDate++");
    expect(at).toBeGreaterThan(-1);
    const guard = fleet.slice(fleet.lastIndexOf("if (", at), at);
    expect(guard).toContain("limited.length === 0");
  });

  it("the fleet sync reports which clones were refused, and for which body", () => {
    // Silence is the failure mode this whole module exists to end: a run that
    // carried nothing must say so, per clone, or it is indistinguishable from
    // a run with nothing to carry.
    expect(fleet).toContain("out.rateLimited.push({ cloneId, cloneName, migration: l.name })");
    expect(fleet).toContain("rate_limited: out.rateLimited.map(");
  });
});
