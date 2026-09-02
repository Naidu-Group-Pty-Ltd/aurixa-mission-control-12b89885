/**
 * What Mission Control may write on a clone's repository, and the one thing
 * this must never do: report a permission it could not read as one it does
 * not hold.
 */
import { describe, expect, it } from "vitest";
import {
  assessRepoWriteCapabilities,
  explainMissingDeployerVariable,
} from "./githubAppCapability.pure";

describe("reading an installation's permissions", () => {
  it("counts write and admin as permitted", () => {
    expect(assessRepoWriteCapabilities({ actions_variables: "write" }).variables.state).toBe(
      "granted",
    );
    expect(assessRepoWriteCapabilities({ actions_variables: "admin" }).variables.state).toBe(
      "granted",
    );
    expect(assessRepoWriteCapabilities({ secrets: "write" }).secrets.state).toBe("granted");
  });

  it("counts read-only as missing, and says which level it holds", () => {
    const c = assessRepoWriteCapabilities({ actions_variables: "read" }).variables;
    expect(c.state).toBe("missing");
    expect(c.detail).toContain('holds "read"');
  });

  it("counts an absent permission as missing", () => {
    const c = assessRepoWriteCapabilities({ contents: "write" }).variables;
    expect(c.state).toBe("missing");
    expect(c.detail).toContain("not granted at all");
  });

  it("NEVER reports a permission it could not read as one we do not hold", () => {
    /*
      A failed read is not a denial. Reporting "the App lacks Variables:
      write" from a lost signal sends an administrator to change a setting
      that was never wrong — the mistake `useAmlAccess` already made once,
      collapsing a failed read into the server's own "no".
    */
    for (const absent of [null, undefined]) {
      const c = assessRepoWriteCapabilities(absent);
      expect(c.variables.state).toBe("unknown");
      expect(c.secrets.state).toBe("unknown");
      expect(c.variables.detail).not.toMatch(/cannot write|not granted/);
    }
  });

  it("judges variables and secrets separately", () => {
    // They are distinct GitHub App permissions; an App may hold either
    // without the other, and collapsing them hides which one to grant.
    const c = assessRepoWriteCapabilities({ actions_variables: "write" });
    expect(c.variables.state).toBe("granted");
    expect(c.secrets.state).toBe("missing");
  });

  it("names the permission exactly as GitHub does, so the remedy is findable", () => {
    const c = assessRepoWriteCapabilities({});
    expect(c.variables.permission).toBe("actions_variables");
    expect(c.secrets.permission).toBe("secrets");
    expect(c.variables.detail).toContain("Read and write");
  });

  it("says an App cannot widen its own permissions", () => {
    // The whole point of the message: this is not something the platform can
    // repair for you, and pretending otherwise wastes the operator's time.
    expect(assessRepoWriteCapabilities({}).variables.detail).toMatch(/cannot widen its own/);
  });
});

describe("explaining a missing BACKEND_DEPLOYED_BY", () => {
  const granted = assessRepoWriteCapabilities({ actions_variables: "write", secrets: "write" });
  const missing = assessRepoWriteCapabilities({ actions_variables: "read" });
  const unknown = assessRepoWriteCapabilities(null);

  it("says nothing at all when the variable is set", () => {
    for (const capabilities of [granted, missing, unknown]) {
      expect(explainMissingDeployerVariable({ variableSet: true, capabilities })).toBeNull();
    }
  });

  it("leads with the permission when that is what blocks it", () => {
    const msg = explainMissingDeployerVariable({ variableSet: false, capabilities: missing });
    expect(msg).toContain("variables");
    expect(msg).toContain("Read and write");
  });

  it("quotes GitHub's own refusal when there is one", () => {
    const msg = explainMissingDeployerVariable({
      variableSet: false,
      capabilities: granted,
      lastWriteError: "Resource not accessible by integration",
    });
    expect(msg).toContain("Resource not accessible by integration");
  });

  it("prefers the permission over a stale error", () => {
    // A refusal explains the symptom; the permission explains the cause, and
    // the cause is what an administrator acts on.
    const msg = explainMissingDeployerVariable({
      variableSet: false,
      capabilities: missing,
      lastWriteError: "Resource not accessible by integration",
    });
    expect(msg).toContain("Read and write");
  });

  it("admits it does not know rather than blaming a permission", () => {
    const msg = explainMissingDeployerVariable({ variableSet: false, capabilities: unknown });
    expect(msg).toMatch(/unknown/);
    expect(msg).not.toMatch(/cannot write/);
  });

  it("says the declaration should simply work when nothing blocks it", () => {
    const msg = explainMissingDeployerVariable({ variableSet: false, capabilities: granted });
    expect(msg).toMatch(/should succeed/);
  });
});
