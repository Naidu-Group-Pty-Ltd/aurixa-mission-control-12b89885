/**
 * Undoing a revocation must stay an operator's act.
 *
 * Revoking a clone's sending key with `deleteDomain: false` — what the Revoke
 * button sends — deletes the key at Resend and leaves the domain verified.
 * That row is byte-for-byte an identity that has finished DNS and is waiting
 * to be minted, and both automated callers of `provision` mode read it that
 * way: `email-identity-drain` re-minted within five minutes, and the
 * deployment drain's credential arming would do it again on the next
 * redeploy. A deliberate stop was undone by a scheduled job, silently.
 *
 * `revoked_at` and the `canMintKey` refusal are the fix, and `resume: true` is
 * the one thing that clears it. So the property worth asserting is an ABSENCE:
 * that no automated caller passes it. A behavioural test cannot see this —
 * every one of these call sites still works correctly with `resume` added, it
 * just quietly stops revocation meaning anything.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** Every `advanceEmailIdentity(...)` call in a source file, with its options. */
function advanceCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("advanceEmailIdentity(", from);
    if (at === -1) break;
    // Far enough to cover the options object at every existing call site.
    calls.push(source.slice(at, at + 400));
    from = at + 1;
  }
  return calls;
}

describe("only an operator may resume a revoked email identity", () => {
  it("the scheduled email-identity drain never asks to resume", () => {
    const calls = advanceCalls(read("server", "email-identity.server.ts")).filter((c) =>
      c.includes("rowFacts.clone_id"),
    );
    expect(calls, "the sweep must still advance identities").toHaveLength(1);
    expect(calls[0]).not.toContain("resume");
  });

  it("the deployment drain's credential arming never asks to resume", () => {
    const calls = advanceCalls(read("..", "src", "routes", "hooks.deployment-drain.tsx"));
    expect(calls, "provisioning must still start an identity").not.toHaveLength(0);
    for (const call of calls) expect(call).not.toContain("resume");
  });

  it("exactly one server function passes it, and it is the Resume action", () => {
    const source = read("..", "src", "lib", "email-identity.functions.ts");
    const passing = advanceCalls(source).filter((c) => c.includes("resume: true"));
    expect(passing).toHaveLength(1);
    // It must be reached from the resume export, not from Provision or Re-check.
    const resumeAt = source.indexOf("export const resumeCloneEmailIdentity");
    const nextExport = source.indexOf("export const", resumeAt + 10);
    expect(resumeAt).toBeGreaterThan(-1);
    expect(source.slice(resumeAt, nextExport)).toContain("resume: true");
  });

  it("the mint gate itself refuses a revoked identity", () => {
    // Named here as well as exercised in the unit tests: the guard has to be
    // in `canMintKey` rather than in either drain, because there are three
    // callers of provision mode and two of them are automated.
    expect(read("server", "cloneEmailIdentity.pure.ts")).toMatch(
      /export function canMintKey[\s\S]{0,900}row\.revoked_at/,
    );
  });

  it("revoking stamps the intent", () => {
    const source = read("server", "email-identity.server.ts");
    const revoke = source.slice(source.indexOf("export async function revokeEmailIdentity"));
    expect(revoke.slice(0, 2000)).toContain("revoked_at:");
  });
});
