/**
 * The mobile gateway, pinned where it is easy to undo by tidying.
 *
 * Structural properties — where a step sits, which verbs a route answers,
 * what a page may import — asserted against the source rather than against a
 * Supabase double, for the reason `backendSync.contract.test.ts` records: a
 * double can agree with the code while only the server disagrees.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../sourceComments.pure";

const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

const provisioning = read("src/server/backend-provisioning.server.ts");
const caller = read("src/lib/backend-provisioning.functions.ts");
const birth = read("src/server/mobile/cloneMobileGateway.server.ts");
const hook = read("src/routes/hooks.mobile-gateway-reconcile.tsx");
const gateway = read("src/server/mobile/gateway.server.ts");

describe("birth wires the gateway; the sweep converges through the same code", () => {
  it("step 5h runs after the Mission Control link and after the secrets batch", () => {
    const link = provisioning.indexOf("input.linkMissionControl(projectRef)");
    const secrets = provisioning.indexOf("await syncCloneSecrets(");
    const mobile = provisioning.indexOf("input.linkMobileGateway(projectRef)");
    expect(link).toBeGreaterThan(0);
    expect(secrets).toBeGreaterThan(link);
    expect(mobile).toBeGreaterThan(secrets);
  });

  it("the provisioning caller supplies the linker, so no clone is born without it", () => {
    expect(caller).toMatch(/linkMobileGateway:\s*async/);
    expect(caller).toMatch(/ensureCloneMobileGateway|repairCloneMobileGateway/);
  });

  it("the reconcile sweep reaches every clone through the birth function", () => {
    expect(hook).toContain("verifyCronAuth(request)");
    expect(hook).toContain("reconcileCloneMobileGateways(");
    const sweep = birth.slice(birth.indexOf("export async function reconcileCloneMobileGateways"));
    expect(sweep).toContain("repairCloneMobileGateway(");
    const repair = birth.slice(birth.indexOf("export async function repairCloneMobileGateway"));
    expect(repair).toContain("ensureCloneMobileGateway(");
  });

  it("a candidate list that could not be read is never treated as empty", () => {
    const sweep = birth.slice(birth.indexOf("export async function reconcileCloneMobileGateways"));
    expect(sweep).toMatch(/if \(error\) throw/);
  });
});

describe("no GET spends an activation ticket", () => {
  for (const route of [
    "src/routes/api.public.mobile.claim.ts",
    "src/routes/api.public.mobile.magic-link.ts",
    "src/routes/api.public.mobile.download-request.ts",
  ]) {
    it(`${route} answers POST and nothing else`, () => {
      const src = read(route);
      expect(src).toMatch(/\bPOST:/);
      expect(src).not.toMatch(/\bGET:/);
      expect(src).not.toMatch(/\bHEAD:/);
    });
  }

  it("the preview page reads the grant and never posts the ticket on load", () => {
    const page = read("src/routes/a.$grantRef.tsx");
    // The only POSTs the page makes are behind a person's click.
    expect(page).not.toMatch(/useEffect\([^)]*\/api\/public\/mobile\/claim/s);
  });
});

describe("filters are never composed as strings", () => {
  const dir = join(process.cwd(), "src/server/mobile");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) {
    it(`${f} has no .or() filter`, () => {
      expect(read(`src/server/mobile/${f}`)).not.toMatch(/\.or\(/);
    });
  }
});

describe("the magic-link answer does not depend on who the email is", () => {
  const start = gateway.indexOf("export async function requestMagicLink");
  const fn = gateway.slice(start, gateway.indexOf("\n}\n", start) + 2);

  it("every path past validation and the rate limit returns the uniform answer", () => {
    const after = fn.slice(fn.indexOf("try {"));
    const returns = after.match(/return [^;]+;/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const r of returns) expect(r).toBe("return uniform;");
  });

  it("a failed issue is logged, never returned", () => {
    expect(fn).toMatch(/if \(!issued\.ok\) console\.warn/);
  });
});

describe("the public gateway pages never reach server code", () => {
  for (const page of ["src/routes/a.$grantRef.tsx", "src/routes/access.tsx"]) {
    it(`${page} imports nothing from @/server`, () => {
      expect(read(page)).not.toMatch(/from ["']@\/server\//);
    });
  }
});
