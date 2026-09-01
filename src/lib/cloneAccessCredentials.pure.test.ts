import { describe, expect, it } from "vitest";
import {
  canIssue,
  issueConfirmation,
  readCloneAccessState,
  type CloneAccessInputs,
} from "./cloneAccessCredentials.pure";

const inputs = (over: Partial<CloneAccessInputs> = {}): CloneAccessInputs => ({
  projectRef: "abcdefghijklmnopqrst",
  adminEmail: "admin@example.com",
  backendStatus: "ready",
  lastIssuedAt: null,
  lastIssuedBy: null,
  ...over,
});

describe("readCloneAccessState", () => {
  it("is ready for a provisioned clone that records an administrator", () => {
    const s = readCloneAccessState(inputs());
    expect(s.kind).toBe("ready");
    expect(canIssue(s)).toBe(true);
  });

  it("refuses when there is no project to write an operator into", () => {
    const s = readCloneAccessState(inputs({ projectRef: null }));
    expect(s.kind).toBe("no_backend");
    expect(canIssue(s)).toBe(false);
  });

  it("refuses when nothing records which account to issue against", () => {
    // The npc-client-dashboard row carried a null admin_email for its whole
    // life, which is exactly the case that must not silently create a second
    // administrator under a guessed address.
    for (const email of [null, "", "   "]) {
      const s = readCloneAccessState(inputs({ adminEmail: email }));
      expect(s.kind).toBe("no_admin_email");
      expect(canIssue(s)).toBe(false);
    }
  });

  it("issues against an unfinished backend, because the admin exists long before the last stage", () => {
    // A clone stuck at `failed` is precisely the one an auditor needs to get
    // into. Only a missing project genuinely has nowhere to write.
    const s = readCloneAccessState(inputs({ backendStatus: "failed" }));
    expect(s.kind).toBe("ready");
  });

  it("lower-cases and trims the address it will issue against", () => {
    const s = readCloneAccessState(inputs({ adminEmail: "  Admin@Example.COM " }));
    expect(s.kind === "ready" && s.adminEmail).toBe("admin@example.com");
  });

  it("knows it is a rotation once anything has been issued before", () => {
    const first = readCloneAccessState(inputs());
    const again = readCloneAccessState(inputs({ lastIssuedAt: "2026-09-01T00:00:00Z" }));
    expect(first.kind === "ready" && first.rotates).toBe(false);
    expect(again.kind === "ready" && again.rotates).toBe(true);
  });
});

describe("issueConfirmation — the operator is told before the click", () => {
  it("always says it is shown once and never stored", () => {
    const said = issueConfirmation(readCloneAccessState(inputs()))!;
    expect(said).toMatch(/shown to you once/i);
    expect(said).toMatch(/not stored/i);
  });

  it("names the lockout when somebody already holds a credential", () => {
    // The load-bearing half: the same act that gets you in locks out whoever
    // had it, and a handoff is exactly when that costs most.
    const said = issueConfirmation(
      readCloneAccessState(inputs({ lastIssuedAt: "2026-09-01T00:00:00Z" })),
    )!;
    expect(said).toMatch(/REPLACES/);
    expect(said).toMatch(/locked out/i);
    expect(said).toMatch(/client/i);
  });

  it("does not warn about a lockout on a first issue", () => {
    const said = issueConfirmation(readCloneAccessState(inputs()))!;
    expect(said).not.toMatch(/locked out/i);
  });

  it("offers no confirmation where the act is not offered", () => {
    expect(issueConfirmation(readCloneAccessState(inputs({ projectRef: null })))).toBeNull();
    expect(issueConfirmation(readCloneAccessState(inputs({ adminEmail: null })))).toBeNull();
  });

  it("never describes itself as revealing or recalling a stored password", () => {
    // There is nothing to reveal, and a panel that said so would be describing
    // a read while performing a write.
    for (const i of [inputs(), inputs({ lastIssuedAt: "2026-09-01T00:00:00Z" })]) {
      const said = issueConfirmation(readCloneAccessState(i))!;
      expect(said).not.toMatch(/reveal|retrieve|recover|existing password/i);
    }
  });
});
