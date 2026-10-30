import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "@/server/sourceComments.pure";
import { BLOCKED_ON_BACKEND, rearmAfterBackendRequeue } from "./deploymentRearm.pure";

describe("which deployment a backend retry re-arms", () => {
  it("re-arms one that failed waiting on the backend, from the start when it has no project", () => {
    /* The demo's: failed at 20:58 on 29 Oct, `blocked_dependency`, no project. */
    expect(
      rearmAfterBackendRequeue({
        status: "failed",
        error_message: BLOCKED_ON_BACKEND,
        project_id: null,
      })?.status,
    ).toBe("pending");
  });

  it("resumes at syncing_env when it already has a project, as an operator's retry does", () => {
    expect(
      rearmAfterBackendRequeue({
        status: "failed",
        error_message: BLOCKED_ON_BACKEND,
        project_id: "prj_1",
      })?.status,
    ).toBe("syncing_env");
  });

  it("leaves every other deployment alone", () => {
    for (const row of [
      { status: "failed", error_message: "stuck", project_id: null },
      { status: "failed", error_message: "Vercel refused the build", project_id: "prj_1" },
      { status: "failed", error_message: null, project_id: null },
      { status: "live", error_message: null, project_id: "prj_1" },
      { status: "pending", error_message: BLOCKED_ON_BACKEND, project_id: null },
    ]) {
      expect(rearmAfterBackendRequeue(row), JSON.stringify(row)).toBeNull();
    }
  });
});

/* The I/O, against a client double that records what it was asked to write. */
const db = vi.hoisted(() => {
  const state = {
    row: null as null | Record<string, unknown>,
    readError: null as null | { message: string },
    writeError: null as null | { message: string },
    updatedRows: [{ clone_id: "c1" }] as unknown[],
    updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  };
  const from = (_table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: state.row, error: state.readError }),
      }),
    }),
    update: (patch: Record<string, unknown>) => {
      const filters: Array<[string, unknown]> = [];
      const chain = {
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        select: async () => {
          state.updates.push({ patch, filters });
          return { data: state.writeError ? null : state.updatedRows, error: state.writeError };
        },
      };
      return chain;
    },
  });
  return { state, client: { from } };
});
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db.client }));

describe("rearmDeploymentBlockedOnBackend", () => {
  beforeEach(() => {
    db.state.row = null;
    db.state.readError = null;
    db.state.writeError = null;
    db.state.updatedRows = [{ clone_id: "c1" }];
    db.state.updates = [];
  });

  it("re-arms the demo's deployment, restarting its clock and fenced on what it judged", async () => {
    const { rearmDeploymentBlockedOnBackend } = await import("./deploymentRearm.server");
    db.state.row = { status: "failed", error_message: BLOCKED_ON_BACKEND, project_id: null };
    const before = Date.now();
    expect(await rearmDeploymentBlockedOnBackend("c1")).toEqual({
      rearmed: true,
      status: "pending",
    });
    const [{ patch, filters }] = db.state.updates;
    expect(patch).toMatchObject({ status: "pending", error_message: null, attempts: 0 });
    expect(Date.parse(String(patch.status_since))).toBeGreaterThanOrEqual(before - 1);
    expect(filters).toEqual([
      ["clone_id", "c1"],
      ["status", "failed"],
      ["error_message", BLOCKED_ON_BACKEND],
    ]);
  });

  it("writes nothing for a deployment that failed for its own reasons", async () => {
    const { rearmDeploymentBlockedOnBackend } = await import("./deploymentRearm.server");
    db.state.row = { status: "failed", error_message: "stuck", project_id: null };
    expect((await rearmDeploymentBlockedOnBackend("c1")).rearmed).toBe(false);
    expect(db.state.updates).toEqual([]);
  });

  it("says so, and never throws, when the row could not be read or changed underneath it", async () => {
    const { rearmDeploymentBlockedOnBackend } = await import("./deploymentRearm.server");
    db.state.readError = { message: "timeout" };
    expect(await rearmDeploymentBlockedOnBackend("c1")).toEqual({
      rearmed: false,
      why: "its deployment could not be read: timeout",
    });
    db.state.readError = null;
    db.state.row = { status: "failed", error_message: BLOCKED_ON_BACKEND, project_id: null };
    db.state.updatedRows = [];
    expect(await rearmDeploymentBlockedOnBackend("c1")).toEqual({
      rearmed: false,
      why: "its deployment changed before it could be re-armed",
    });
  });
});

describe("every path that queues a backend again re-arms its deployment", () => {
  const engine = stripComments(readFileSync("src/server/backend-provisioning.server.ts", "utf8"));
  const runner = stripComments(readFileSync("src/lib/backend-provisioning.functions.ts", "utf8"));
  const deployFns = stripComments(
    readFileSync("src/server/deployment-provisioning.functions.ts", "utf8"),
  );

  it("the shared enqueue, after its write lands", () => {
    const fn = engine.slice(
      engine.indexOf("export async function enqueueCloneBackendProvisioning"),
    );
    const write = fn.indexOf("if (upsertErr) return { ok: false, error: upsertErr.message };");
    const rearm = fn.indexOf("await rearmDeploymentBlockedOnBackend(input.cloneId)");
    expect(write).toBeGreaterThan(-1);
    expect(rearm).toBeGreaterThan(write);
  });

  it("the clone page's retry, which writes its own queue row", () => {
    const fn = runner.slice(runner.indexOf("export const retryBackendProvisioning"));
    const write = fn.indexOf("if (upsertErr) return { ok: false, error: upsertErr.message };");
    const rearm = fn.indexOf("await rearmDeploymentBlockedOnBackend(data.cloneId)");
    expect(write).toBeGreaterThan(-1);
    expect(rearm).toBeGreaterThan(write);
  });

  it("an operator's deployment retry restarts the clock it moves", () => {
    const fn = deployFns.slice(deployFns.indexOf("export const retryCloneDeployment"));
    const body = fn.slice(0, fn.indexOf("export const", 10));
    expect(body).toMatch(/status_since:\s*new Date\(\)\.toISOString\(\)/);
  });
});
