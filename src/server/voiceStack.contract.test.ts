import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";

/*
 * Source-level assertions about clone voice stacks. Each pins a rule the
 * design rests on that no unit test of a pure function can see: that the stack
 * follows the clone's CRM line through a conversion, that custody starts where
 * the email identity does, that Aurixa's own Vapi key only ever READS, and that
 * nothing the browser is handed carries a ciphertext.
 */
const code = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
const server = code("./voice-stack.server.ts");
const custody = code("./clone-vapi-custody.server.ts");
const conversion = code("./crmConversion.server.ts");
const deploymentDrain = code("../routes/hooks.deployment-drain.tsx");
const drain = code("../routes/hooks.voice-stack-drain.tsx");
const fns = code("../lib/voice-stack.functions.ts");

const body = (src: string, start: string) => {
  const at = src.indexOf(start);
  expect(at, `${start} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", at + start.length);
  return src.slice(at, next === -1 ? undefined : next);
};

describe("the stack follows the CRM line", () => {
  it("a finished conversion parks the line left and opens the line joined", () => {
    const finalise = body(conversion, "export async function finaliseConversion");
    expect(finalise).toContain("onCrmLineChanged({ cloneId: clone.id, fromMode, toMode })");
    expect(finalise).toMatch(/voiceStack,/);
  });

  it("the drain parks a stack whose clone has left its line, whatever missed the conversion", () => {
    const tick = body(server, "export async function tickStack");
    expect(tick).toMatch(/g\.mode !== mode && !stack\.parked_at/);
    expect(tick).toContain("parkVoiceStack(");
  });

  it("parking switches scenarios off and deletes nothing", () => {
    const park = body(server, "export async function parkVoiceStack");
    expect(park).toContain("stopScenario(");
    expect(park).not.toMatch(/delete(Scenario|Hook|DataStore)|api\.delete|\.delete\(/);
  });

  it("a line head is never built from itself", () => {
    const sweep = body(server, "export async function sweepVoiceStacks");
    expect(sweep).toContain("heads[c.crm_mode] === c.id");
  });
});

describe("custody starts with the email identity", () => {
  it("the deployment drain starts it, best-effort", () => {
    expect(deploymentDrain).toContain("startVapiCustodyIfDue(row.clone_id)");
    expect(deploymentDrain).toContain("vapiCustody: vapiCustodyNote");
  });

  it("the voice-stack drain requires the cron secret and carries custody and stacks", () => {
    expect(drain).toContain("verifyCronAuth(request)");
    expect(drain).toContain("sweepVoiceStacks()");
    expect(body(server, "export async function sweepVoiceStacks")).toContain("sweepVapiCustody()");
  });
});

describe("Aurixa's own Vapi key", () => {
  it("is read only to read templates, through a reader that has no write", () => {
    const reader = server.slice(
      server.indexOf("function aurixaReader"),
      server.indexOf("async function tenantApi"),
    );
    expect(reader).toContain("return { get: (p: string) => api.get(p) }");
    expect(reader).not.toMatch(/\.(post|patch|delete)\(/);
  });

  it("is refused as a tenant's key", () => {
    const tenant = server.slice(
      server.indexOf("async function tenantApi"),
      server.indexOf("const ledgerId"),
    );
    expect(tenant).toContain("aurixa === ctx.cloneKey");
    expect(custody).toContain("aurixaKey");
  });

  it("every Vapi write goes through the tenant's client", () => {
    // Structural, not a list of forms: EVERY `.post(` / `.patch(` in the module
    // must be called on the identifier `api`, and every `api` must be bound
    // from `tenantApi(ctx)` (or typed as its result). A cast, a parenthesised
    // await or a second name for the reader all fail here, because a regex
    // for the bad forms only ever catches the forms somebody thought of.
    const writes = [...server.matchAll(/(\S{1,40})\.(post|patch)\(/g)];
    expect(writes.length).toBeGreaterThan(0);
    for (const m of writes) expect(m[1], `write through "${m[1]}"`).toMatch(/(^|[^\w.])api$/);
    for (const m of server.matchAll(/\bconst api = ([^;]+);/g)) {
      const inReader =
        server.indexOf(m[0]) > server.indexOf("function aurixaReader") &&
        server.indexOf(m[0]) < server.indexOf("async function tenantApi");
      if (inReader) continue; // the reader's own client, which exposes `get` alone
      expect(m[1]).toBe("await tenantApi(ctx)");
    }
    expect(server).toMatch(/api: Awaited<ReturnType<typeof tenantApi>>/);
  });
});

describe("nothing the browser is handed carries a ciphertext", () => {
  it("the custody view selects no encrypted column", () => {
    const columns = custody.slice(
      custody.indexOf("const COLUMNS ="),
      custody.indexOf("type CustodyDbRow"),
    );
    expect(columns).not.toMatch(/_enc\b/);
  });

  it("the stack view selects no encrypted column", () => {
    const columns = server.slice(
      server.indexOf("const STACK_COLUMNS ="),
      server.indexOf("async function readStacks"),
    );
    expect(columns).not.toMatch(/_enc\b/);
  });

  it("the stack view projects the GoHighLevel row to a fingerprint", () => {
    const view = body(server, "export async function getVoiceStackView");
    expect(view).toContain("fingerprint: ghl.key_fingerprint");
    expect(view).not.toMatch(/api_key_enc|secret_enc\s*[,}]/);
  });

  it("the server functions name no encrypted column and are admin-only", () => {
    expect(fns).not.toMatch(/_enc\b/);
    const handlers = fns.match(/createServerFn\(/g)?.length ?? 0;
    const guarded = fns.match(/\.middleware\(\[requireAdmin\]\)/g)?.length ?? 0;
    expect(handlers).toBeGreaterThan(0);
    expect(guarded).toBe(handlers);
  });

  it("the one password reveal is audited with the admin who asked", () => {
    expect(fns).toContain("revealVapiLogin(data.cloneId, context.userId)");
    expect(body(custody, "export async function revealVapiLogin")).toContain("writeAuditLog(");
  });
});

describe("the dependent line", () => {
  it("cannot be built without a verified GoHighLevel key", () => {
    expect(server).toContain("judgeStackProvision(");
    const pure = code("./voiceStackTemplate.pure.ts");
    expect(pure).toContain('"ghl_credentials_missing"');
    expect(pure).toContain('"ghl_credentials_unverified"');
  });

  it("binds a GoHighLevel connection only to the location the key was verified against", () => {
    expect(server).toContain("grantMatchesLocation(");
  });
});
