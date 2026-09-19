import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/*
  LINE COMMENTS ONLY.

  A naive block-comment strip deletes real code from any source carrying `/*`
  inside a line comment — measured at 13,438 characters on
  `cascade-engine.server.ts`, where a module glob (`src/integrations/**`) sits
  in one. Line comments cannot swallow code, and they are the thing worth
  removing: a commented-out call must not satisfy an assertion about a call.
*/
const source = readFileSync(new URL("./clone-provisioning.server.ts", import.meta.url), "utf8");
const bare = source.replace(/\/\/[^\n]*/g, " ");

/**
 * An idempotent retry must start what the first attempt did not.
 *
 * `provisionCloneCore` short-circuits on a matching idempotency key and used
 * to return the moment it found a clone row. A request terminated after that
 * insert and before the side effects ran therefore left the backend
 * un-enqueued — with the operator's admin password gone, because it exists
 * only in the request — the subdomain unreserved and the sending identity
 * unstarted, while the retry reported a successful idempotent provision.
 *
 * Raised by an automated review on this branch before it merged, and the
 * provisioning work on this same branch is what widened it: the subdomain and
 * email-identity steps MOVED into this function, so the window between the
 * insert and them got longer.
 */
describe("an idempotent retry reconciles the side effects it asked for", () => {
  it("both paths call one function, so they cannot ask for different things", () => {
    const calls = [...bare.matchAll(/startRequestedSideEffects\(/g)];
    // The definition, the first-submit call, and the retry call.
    expect(calls.length, "expected a definition and two call sites").toBe(3);
  });

  it("the short-circuit starts them BEFORE it returns", () => {
    const shortCircuit = bare.indexOf("if (existing) {");
    expect(shortCircuit).toBeGreaterThan(-1);
    const window = bare.slice(shortCircuit, shortCircuit + 1400);
    const startAt = window.indexOf("await startRequestedSideEffects(");
    // Anchored on the returned object's own field rather than on the words
    // `idempotent: true`, which the explanation above that return also
    // contains — the first draft of this assertion matched the PROSE and
    // reported the call as coming after the return.
    const returnAt = window.indexOf("cloneId: existing.id");
    expect(startAt, "the retry must start the side effects").toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(startAt);
  });

  it("it reconciles against the EXISTING clone, not a fresh one", () => {
    const shortCircuit = bare.indexOf("if (existing) {");
    const window = bare.slice(shortCircuit, shortCircuit + 1400);
    expect(window).toMatch(
      /startRequestedSideEffects\(\s*supabase,\s*userId,\s*existing,\s*data\s*\)/,
    );
  });

  it("the extracted block still carries all three steps", () => {
    // Removing a step from the shared function would silently remove it from
    // BOTH paths, which is a worse version of the defect being fixed.
    const at = bare.indexOf("async function startRequestedSideEffects");
    expect(at).toBeGreaterThan(-1);
    const fn = bare.slice(at);
    // The CALL, not the name. The first draft asserted the bare names and a
    // planted `await NOTHING(...)` passed, because the function's own doc
    // comment names all three — block comments are not stripped here (they
    // cannot be, safely), so prose satisfied an assertion about code.
    expect(fn, "subdomain").toMatch(/await provisionCloneSubdomain\(/);
    expect(fn, "sending identity").toMatch(/await advanceEmailIdentity\(/);
    expect(fn, "backend").toMatch(/await enqueueCloneBackendProvisioning\(/);
  });

  it("the reservation travels back, because the deployment attaches that name", () => {
    expect(bare).toMatch(/subdomain:\s*reservedSubdomain,\s*fqdn:\s*reservedFqdn/);
    expect(bare).toMatch(
      /const \{ subdomain: reservedSubdomain, fqdn: reservedFqdn \}\s*=\s*await startRequestedSideEffects\(/,
    );
  });
});
