import { describe, expect, it } from "vitest";
import { samplePlan } from "./fixtures/samplePlan.pure";
import { compilePackage } from "./package.pure";
import {
  executeDeploy,
  keepUnmanagedInlineTools,
  resolvePlaceholders,
  type DeployInput,
  type LedgerEntry,
  type VapiApi,
} from "./vapiDeploy.pure";

/** An in-memory VAPI org that behaves like the real one where it matters. */
function fakeVapi(opts: { fileStatuses?: string[] } = {}) {
  const objects = new Map<string, Record<string, any>>();
  const writes: string[] = [];
  let n = 0;
  const statuses = [...(opts.fileStatuses ?? ["processing", "done"])];
  const api: VapiApi = {
    async get(path) {
      if (path.startsWith("/file/")) {
        const f = objects.get(path);
        if (!f) return null;
        if (f.status !== "done" && f.status !== "failed") f.status = statuses.shift() ?? f.status;
        return { ...f };
      }
      return objects.has(path) ? structuredClone(objects.get(path)!) : null;
    },
    async post(path, body) {
      const id = `${path.slice(1)}_${++n}`;
      writes.push(`POST ${path}`);
      objects.set(`${path}/${id}`, { ...(body as object), id });
      return { id };
    },
    async patch(path, body) {
      writes.push(`PATCH ${path}`);
      const prev = objects.get(path) ?? {};
      // PATCH_WHOLE_MODEL: `model` is replaced, not merged.
      objects.set(path, { ...prev, ...(body as object) });
      return { id: prev.id };
    },
    async uploadTextFile(fileName, mimetype) {
      const id = `file_${++n}`;
      writes.push(`UPLOAD ${fileName} ${mimetype}`);
      objects.set(`/file/${id}`, { id, status: "processing" });
      return { id, status: "processing" };
    },
  };
  return { api, objects, writes };
}

const SECRETS = {
  tenantWebhookUrl: "https://mc.example/api/public/voice/t/key123456789abcdef/webhook",
  tenantWebhookSecret: "tenant-secret-value-123",
  callLogUrl: "https://clone.example/functions/v1/vapi-call-webhook",
  callLogSecret: "call-log-secret-123456",
  makeTransferUrl: "https://hook.example/abc",
};

async function deploy(api: VapiApi, ledger: LedgerEntry[], over: Partial<DeployInput> = {}) {
  const pkg = await compilePackage(samplePlan());
  const saved: LedgerEntry[] = [...ledger];
  const out = await executeDeploy({
    pkg,
    ledger,
    api,
    secrets: SECRETS,
    mode: "apply",
    onLedger: async (e) => {
      const i = saved.findIndex((x) => x.kind === e.kind && x.key === e.key);
      if (i >= 0) saved[i] = e;
      else saved.push(e);
    },
    sleep: async () => {},
    now: () => 0,
    deadline: 1,
    ...over,
  });
  return { out, saved, pkg };
}

describe("executeDeploy", () => {
  it("creates tools, uploads the KB as text/plain, creates assistants and the squad, and verifies them", async () => {
    const { api, objects, writes } = fakeVapi();
    const { out, saved } = await deploy(api, []);
    expect(out.status).toBe("succeeded");
    expect(writes.filter((w) => w.startsWith("UPLOAD"))).toEqual(["UPLOAD harbourside-dental-knowledge-base.txt text/plain"]);
    expect(saved.filter((e) => e.kind === "assistant")).toHaveLength(3);
    expect(saved.some((e) => e.kind === "squad")).toBe(true);
    // No Studio placeholder survives into VAPI ({{firstName}} and friends are
    // VAPI's own call variables and must survive), and the secret is where it belongs.
    const dump = JSON.stringify([...objects.values()]);
    expect(dump).not.toMatch(/\{\{(tool|assistant|kb|config|secret):/);
    expect(dump).toContain("{{firstName}}");
    expect(dump).toContain("tenant-secret-value-123");
    if (out.status === "succeeded") {
      for (const row of out.verification) expect(Object.values(row.checks).every(Boolean)).toBe(true);
    }
  });

  it("a second run writes nothing at all", async () => {
    const { api, writes } = fakeVapi();
    const { saved } = await deploy(api, []);
    const before = writes.length;
    const again = await deploy(api, saved);
    expect(again.out.status).toBe("succeeded");
    expect(writes.length).toBe(before);
  });

  it("a rotated secret re-writes the tools that carry it", async () => {
    const { api, writes } = fakeVapi();
    const { saved } = await deploy(api, []);
    const before = writes.length;
    await deploy(api, saved, { secrets: { ...SECRETS, tenantWebhookSecret: "rotated-secret-456789" } });
    expect(writes.slice(before).some((w) => w.startsWith("PATCH /tool/"))).toBe(true);
  });

  it("stops when VAPI cannot parse the knowledge base, before any assistant points at it", async () => {
    const { api, writes } = fakeVapi({ fileStatuses: ["failed"] });
    const { out } = await deploy(api, []);
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.error).toMatch(/could not parse/);
    expect(writes.some((w) => w === "POST /assistant")).toBe(false);
  });

  it("hands back to the next tick while the file is still parsing, and never uploads twice", async () => {
    const { api, writes } = fakeVapi({ fileStatuses: ["processing", "processing", "done"] });
    let t = 0;
    const first = await deploy(api, [], { now: () => t, deadline: 1, sleep: async () => void t++ });
    expect(first.out.status).toBe("continue");
    const second = await deploy(api, first.saved, { now: () => 0, deadline: 1 });
    expect(writes.filter((w) => w.startsWith("UPLOAD"))).toHaveLength(1);
    expect(second.out.status).toBe("succeeded");
  });

  it("dry run reads and writes nothing", async () => {
    const { api, writes } = fakeVapi();
    const { out, saved } = await deploy(api, [], { mode: "dry_run" });
    expect(out.status).toBe("succeeded");
    expect(writes).toEqual([]);
    expect(saved).toEqual([]);
    expect(out.steps.every((s) => s.status === "planned")).toBe(true);
  });

  it("an assistant changed by hand in VAPI is caught by the read-back", async () => {
    const { api, objects } = fakeVapi();
    const { saved } = await deploy(api, []);
    const id = saved.find((e) => e.kind === "assistant" && e.key === "front_desk")!.vapiId;
    const live = objects.get(`/assistant/${id}`)!;
    live.model.messages[0].content = "tampered";
    // Same payload hash, so the step is skipped - but verification still reads it.
    const again = await deploy(api, saved);
    expect(again.out.status).toBe("failed");
    if (again.out.status === "failed") expect(again.out.error).toMatch(/front_desk \(system_prompt\)/);
  });

  it("recreates something deleted in VAPI rather than patching a ghost", async () => {
    const { api, objects, writes } = fakeVapi();
    const { saved } = await deploy(api, []);
    const tool = saved.find((e) => e.kind === "tool")!;
    objects.delete(`/tool/${tool.vapiId}`);
    const before = writes.length;
    await deploy(api, saved);
    expect(writes.slice(before)).toContain("POST /tool");
  });

  it("refuses a transfer tool with no Make hook rather than writing an empty URL", async () => {
    const { api } = fakeVapi();
    const { out } = await deploy(api, [], { secrets: { ...SECRETS, makeTransferUrl: null } });
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.error).toMatch(/make_transfer_url/);
  });
});

describe("helpers", () => {
  it("keeps an inline tool somebody added by hand, and replaces the Studio's own", () => {
    const remote = {
      model: { tools: [{ type: "query", function: { name: "acme_knowledge" } }, { type: "function", function: { name: "custom_thing" } }] },
    };
    const next = { model: { tools: [{ type: "query", function: { name: "acme_knowledge" }, v: 2 }] } };
    const merged = keepUnmanagedInlineTools(remote, next, "acme_knowledge");
    expect(merged.model.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["acme_knowledge", "custom_thing"]);
  });

  it("an unresolvable placeholder is an error, never an empty string", () => {
    expect(() => resolvePlaceholders({ a: "{{secret:nope}}" }, () => null)).toThrow(/nothing to put/);
    expect(resolvePlaceholders(["x {{tool:end_call}} y"], () => "t1")).toEqual(["x t1 y"]);
  });
});
