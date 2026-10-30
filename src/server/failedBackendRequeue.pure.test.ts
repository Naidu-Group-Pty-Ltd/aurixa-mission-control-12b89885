import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";
import { chooseFailedRequeue } from "./failedBackendRequeue.pure";

describe("a failed backend is re-queued the way that replaces no held password", () => {
  it("provisions with a minted password when no project exists yet", () => {
    expect(chooseFailedRequeue({ projectRef: null, adminPresence: null }).kind).toBe("provision");
  });

  it("provisions with a minted password when the project holds no admin account", () => {
    expect(chooseFailedRequeue({ projectRef: "ref", adminPresence: "absent" }).kind).toBe(
      "provision",
    );
  });

  it("repairs, seeding nobody, when the admin account exists", () => {
    /* 29–30 Oct 2026: the demo's seed had run twice with the password its
       owner holds. A minted re-queue would have written over it. */
    const choice = chooseFailedRequeue({ projectRef: "ref", adminPresence: "present" });
    expect(choice.kind).toBe("repair");
    expect(choice.why).toMatch(/account is left alone/);
  });

  it("refuses when the account could not be read: unknown is neither present nor absent", () => {
    const choice = chooseFailedRequeue({ projectRef: "ref", adminPresence: "unknown" });
    expect(choice.kind).toBe("refuse");
    expect(choice.why).toMatch(/clone page/);
    expect(chooseFailedRequeue({ projectRef: "ref", adminPresence: null }).kind).toBe("refuse");
  });
});

describe("both levers read the account before they mint", () => {
  const hook = stripComments(
    readFileSync("src/routes/hooks.backend-provisioning-retry.tsx", "utf8"),
  );
  const bulk = stripComments(readFileSync("src/server/operator-ux.functions.ts", "utf8"));
  const engine = stripComments(readFileSync("src/server/backend-provisioning.server.ts", "utf8"));

  it("the retry hook mints only for a provision, and repairs a backend whose admin exists", () => {
    const choose = hook.indexOf("chooseFailedRequeue(");
    const read = hook.indexOf("readAdminAccountPresence(");
    const enqueue = hook.indexOf("enqueueCloneBackendProvisioning(admin");
    expect(read).toBeGreaterThan(-1);
    expect(choose).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(choose);
    expect(hook).toMatch(/adminPassword: repair \? null : generateSecurePassword\(\)/);
    expect(hook).toMatch(/repairOfFailed: repair/);
    expect(hook).toMatch(/if \(choice\.kind === "refuse"\)/);
  });

  it("the dashboard's bulk reprovision does the same for every failed row", () => {
    const fn = bulk.slice(bulk.indexOf("export const bulkReprovisionBackends"));
    const choose = fn.indexOf("chooseFailedRequeue(");
    const enqueue = fn.indexOf("enqueueCloneBackendProvisioning(supabase");
    expect(fn).toContain("readAdminAccountPresence(");
    expect(choose).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(choose);
    expect(fn).toMatch(
      /adminPassword: repair \|\| repairOfFailed \? null : generateSecurePassword\(\)/,
    );
  });

  it("the enqueue repairs a failed backend only when the caller says it read the account", () => {
    const fn = engine.slice(
      engine.indexOf("export async function enqueueCloneBackendProvisioning"),
    );
    expect(fn).toMatch(
      /existing\.status === "ready" \|\|\s*\(existing\.status === "failed" && input\.repairOfFailed === true\)/,
    );
  });

  it("the presence read never answers absent for a project it could not ask", () => {
    const fn = engine.slice(engine.indexOf("export async function readAdminAccountPresence"));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    expect(body).toMatch(/catch \(e\) \{[\s\S]*return "unknown";/);
    expect(body).not.toMatch(/catch[^}]*return "absent"/);
  });
});
