/**
 * Proving a clone can reach Anthropic.
 *
 * The rules worth pinning here are about what the reading MEANS, not about the
 * transport. Two of them are the kind that a change would break silently: a
 * failure that cleared `verified_at` would destroy the only evidence of when
 * the chain last held, and a probe that wrote its own token anywhere would
 * hand inference a credential obtained for a different purpose.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./anthropicSelftest.server.ts", import.meta.url), "utf8");
const fn = readFileSync(new URL("../lib/anthropic-attribution.functions.ts", import.meta.url), "utf8");
const card = readFileSync(new URL("../components/clone-anthropic-card.tsx", import.meta.url), "utf8");

describe("the column this exists to write", () => {
  /*
   * `clone_anthropic_identity` was created with `verified_at` and only
   * `last_error` had a writer. A column declared by a migration and written by
   * nothing is a fault this codebase has already paid for — the Passport
   * portal's organisation cross-reference columns were exactly that, and the
   * machinery in front of them looked healthy while serving nobody.
   */
  it("writes verified_at", () => {
    expect(src).toContain("verified_at");
    expect(src).toMatch(/verified_at:\s*reach\.probedAt/);
  });

  /*
   * The rule. `verified_at` is the last time this was PROVED, which stays
   * true whatever is broken now; `last_error` carries the present problem.
   * Clearing the stamp on a failure would make a clone that worked yesterday
   * indistinguishable from one that has never worked at all.
   */
  it("never clears the stamp on a failure", () => {
    // Scoped to the writer rather than to the file: a type declaration and a
    // column list both spell the name, and a guard that cannot tell those from
    // an assignment is one somebody silences the first time it cries wolf.
    const writer = /async function recordReach[\s\S]*?\n}\n/.exec(src)?.[0] ?? "";
    expect(writer, "recordReach not found").not.toBe("");
    const assignments = writer.match(/verified_at:\s*[^,;\n]+/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toContain("reach.probedAt");
    // Guarded by the pass, so a failure cannot reach it at all.
    expect(writer).toMatch(/reach\.ok \? \{ verified_at/);
    expect(writer).not.toMatch(/verified_at:\s*null/);
  });

  it("records the fault rather than discarding it", () => {
    expect(src).toContain("last_error");
  });

  /*
   * A write that failed must not turn a successful probe into an error. The
   * operator asked whether the clone can reach Anthropic and is owed that
   * answer whether or not the ledger took it.
   */
  it("cannot fail the probe by failing to record it", () => {
    expect(src).toMatch(/console\.warn\(\s*"\[anthropic-selftest\]/);
    expect(src).not.toMatch(/throw new Error\([^)]*record/i);
  });
});

describe("the probe asks, and asks THERE", () => {
  it("goes through the signed webhook the link already provides", () => {
    expect(src).toContain('"x-mc-signature"');
    expect(src).toContain('"anthropic.selftest"');
    // Only the endpoint row's URL — never a slug this module composes, which
    // is what would let it reach any other function on the clone.
    expect(src).toContain("await fetch(endpoint.url, {");
    expect(src).not.toMatch(/functions\/v1\/[a-z-]+/);
  });

  it("sends a fresh idempotency key every time", () => {
    // A stable key would be a request to be told the LAST answer, which is
    // not the question a probe asks.
    expect(src).toContain('"x-mc-idempotency-key": randomUUID()');
  });

  it("keeps the reasons a probe could not be run apart from a bad reading", () => {
    // "No Mission Control link", "its backend predates the probe" and "the
    // vendor refused the credential" send somebody to three different places.
    for (const reason of ["no_link", "no_probe_in_answer", "unreachable", "unknown_clone"]) {
      expect(src, reason).toContain(`"${reason}"`);
    }
  });

  it("never reports a failed READ as an absent clone", () => {
    expect(src).toContain('reason: "unreadable"');
  });

  it("treats an unreadable candidate list as unreadable, not as empty", () => {
    expect(src).toMatch(/throw new Error\(`Could not list Anthropic identities/);
  });
});

describe("nothing here carries a credential", () => {
  /*
   * The reading travels from the clone, through this module, into an audit row
   * and onto an operator's screen. Anything in it is effectively published, so
   * the type it is parsed into must have no field that could hold a secret.
   */
  it("parses a reading with no value field in it", () => {
    expect(src).toContain("credentialKind");
    expect(src).not.toMatch(/\bcredential\s*[:?]/);
    expect(src).not.toContain("access_token:");
  });

  it("logs the shape of the answer rather than the answer", () => {
    const block = /clone_anthropic\.selftest[\s\S]*?\}\);/.exec(fn)?.[0] ?? "";
    expect(block).toContain("route");
    expect(block).not.toContain("why");
    expect(block).not.toMatch(/reach\.credential/);
  });
});

describe("the card says what is PROVED, not what is configured", () => {
  /*
   * Every readiness reading on three tenants was green while none had ever
   * completed a verification. The same trap is open here: five environment
   * names can be set, a workspace can exist, a rule can exist, and the clone
   * can still be unable to obtain a credential.
   */
  it("has a step for reachability that is separate from configuration", () => {
    expect(card).toContain("Proved reachable");
    expect(card).toContain("verified_at");
  });

  it("keeps a failed read apart from an absent identity", () => {
    // Collapsing them offers "provision a workspace" for a clone that may
    // already have one, which is how a tenant's spend gets split in two.
    expect(card).toContain("could not be read");
  });

  it("names the end that refused, and the remedy for that end", () => {
    // Both ends answer with similar text and send an operator to opposite
    // places — the lesson the verification broker already paid for.
    for (const end of ["mission_control", "anthropic", "workspace", "unconfigured"]) {
      expect(card, end).toContain(end);
    }
  });

  it("says the probe is free, because an operator will press it repeatedly", () => {
    expect(card).toMatch(/costs nothing|not a billable/i);
  });
});
