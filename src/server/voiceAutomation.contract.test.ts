import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";
import { CLONE_API_SCOPES, DEFAULT_SCOPES } from "@/lib/clone-api-scopes";

/*
 * Source-level assertions about the voice-automation broker. Each pins a rule
 * the design rests on and that no unit test of a pure function can see: what
 * the route authenticates with, that a CFG record's secret never travels past
 * the read, and that the Make token never leaves Mission Control.
 */
const code = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
const route = code("../routes/api.public.voice-automation.$operation.ts");
const client = code("./make-client.server.ts");
const server = code("./voice-automation.server.ts");
const drain = code("../routes/hooks.voice-automation-drain.tsx");

describe("the tenant's door", () => {
  it("authenticates with the clone's own key and the automation scope", () => {
    expect(route).toContain('request.headers.get("x-clone-api-key")');
    expect(route).toContain('"automation:configure"');
    expect(route).toContain("resolveCloneApiKey");
  });

  it("serves only clones on the CRM-independent line", () => {
    expect(route).toContain('clone?.crm_mode !== "independent"');
  });

  it("takes the clone from the key, never from the request", () => {
    expect(route).not.toMatch(/body\.cloneId|searchParams\.get\(["']cloneId/);
    expect(route).toContain("auth.cloneId");
  });

  it("records the tenant as a tenant, whatever the body says", () => {
    expect(route).toContain('kind: "tenant" as const');
  });

  it("marks its own refusals", () => {
    expect(route).toContain("x-mission-control-refusal");
  });
});

describe("the Make credential", () => {
  it("is read in one module only", () => {
    expect(client).toContain("process.env.MAKE_API_TOKEN");
    expect(server).not.toContain("process.env.MAKE_API_TOKEN");
    expect(route).not.toContain("process.env.MAKE_API_TOKEN");
  });

  it("is never written to a clone or logged", () => {
    expect(client).not.toMatch(/console\.(log|error|warn)/);
    expect(server).not.toMatch(/setCloneSecretValues|syncCloneSecrets/);
  });
});

describe("the CFG record's secret", () => {
  it("is projected away at the read", () => {
    expect(client).toContain("return projectManagedCfg(hit.data)");
  });

  it("is never named by the orchestrator, the route or the drain", () => {
    for (const src of [server, route, drain]) expect(src).not.toContain("adapter_secret");
  });

  it("the patch response is discarded", () => {
    const patch = client.slice(
      client.indexOf("export async function patchCfg"),
      client.indexOf("// ----", client.indexOf("export async function patchCfg")),
    );
    expect(patch).not.toMatch(/return\s+\(?await makeFetch/);
  });
});

describe("the scope", () => {
  it("is in the catalogue and on by default, so live link keys are widened onto it", () => {
    expect(CLONE_API_SCOPES.find((s) => s.value === "automation:configure")).toBeDefined();
    expect(DEFAULT_SCOPES).toContain("automation:configure");
  });
});

describe("the drain", () => {
  it("requires the cron secret", () => {
    expect(drain).toContain("verifyCronAuth(request)");
  });
});
