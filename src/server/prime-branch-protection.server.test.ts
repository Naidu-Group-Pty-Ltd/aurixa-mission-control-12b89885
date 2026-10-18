// Keeping Prime's default branch protected through Mission Control's App, run
// against a fake GitHub: what it asks for, what it writes, and every way it
// refuses — no Lovable App, a renamed CI job, no permission.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { route: string; params: Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rulesets: [] as Array<Record<string, unknown>>,
  ci: "jobs:\n  verify:\n    name: Typecheck · Lint · Build\n  lovable-install:\n    name: Lovable install (bun.lockb)\n" as
    | string
    | null,
  botLogin: "lovable-dev[bot]" as string | null,
  writeStatus: 0,
  autoMerge: false,
}));

const fail = (status: number, message = "nope") =>
  Object.assign(new Error(message), { status, response: { data: { message } } });

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        limit: () => ({
          maybeSingle: async () => ({
            data: {
              github_owner: "acme",
              github_repo: "prime",
              default_branch: "main",
              github_app_installation_id: "1",
            },
            error: null,
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/server/github-app.server", () => {
  const request = async (route: string, params: Record<string, unknown> = {}) => {
    h.calls.push({ route, params });
    if (route === "GET /user/{account_id}") {
      if (!h.botLogin) throw fail(404);
      return { data: { id: params.account_id, login: h.botLogin, type: "Bot" } };
    }
    if (route === "GET /apps/{app_slug}") return { data: { id: 777, slug: params.app_slug } };
    if (route === "GET /repos/{owner}/{repo}/rulesets") {
      return { data: h.rulesets.map(({ id, name }) => ({ id, name, source_type: "Repository" })) };
    }
    if (route === "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}") {
      return { data: h.rulesets.find((r) => r.id === params.ruleset_id) };
    }
    if (route.startsWith("POST ") || route.startsWith("PUT ")) {
      if (h.writeStatus) throw fail(h.writeStatus, "Resource not accessible by integration");
      return { data: { id: 55 } };
    }
    throw new Error(`unexpected ${route}`);
  };
  return {
    getAppOctokit: () => ({
      request,
      repos: {
        get: async () => ({
          data: {
            default_branch: "main",
            owner: { type: "Organization" },
            allow_auto_merge: h.autoMerge,
          },
        }),
        getContent: async () => {
          if (h.ci === null) throw fail(404);
          return { data: { type: "file", content: Buffer.from(h.ci).toString("base64") } };
        },
        update: async (params: Record<string, unknown>) => {
          h.calls.push({ route: "PATCH /repos/{owner}/{repo}", params });
          return { data: {} };
        },
      },
    }),
  };
});

import { ensurePrimeBranchProtection } from "./prime-branch-protection.server";
import { PRIME_RULESET_NAME, desiredPrimeRuleset } from "./primeBranchProtection.pure";

const writes = () => h.calls.filter((c) => /^(POST|PUT|PATCH) /.test(c.route)).map((c) => c.route);

beforeEach(() => {
  h.calls = [];
  h.rulesets = [];
  h.ci =
    "jobs:\n  verify:\n    name: Typecheck · Lint · Build\n  lovable-install:\n    name: Lovable install (bun.lockb)\n";
  h.botLogin = "lovable-dev[bot]";
  h.writeStatus = 0;
  h.autoMerge = false;
});

describe("ensurePrimeBranchProtection", () => {
  it("creates the ruleset with Lovable's App, found from its bot account", async () => {
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r).toMatchObject({ ok: true, status: "created", rulesetId: 55 });
    expect(r.lovableApp).toEqual({ id: 777, slug: "lovable-dev" });
    // The account id, then the App named by that account's login.
    expect(h.calls.find((c) => c.route === "GET /user/{account_id}")?.params.account_id).toBe(
      159125892,
    );
    const create = h.calls.find((c) => c.route === "POST /repos/{owner}/{repo}/rulesets");
    expect(create?.params).toMatchObject({
      owner: "acme",
      repo: "prime",
      name: PRIME_RULESET_NAME,
    });
    expect(create?.params.bypass_actors).toContainEqual({
      actor_id: 777,
      actor_type: "Integration",
      bypass_mode: "always",
    });
    // And auto-merge, so the digest refresh can land with nobody there.
    expect(h.calls.find((c) => c.route === "PATCH /repos/{owner}/{repo}")?.params).toMatchObject({
      allow_auto_merge: true,
    });
    expect(r.autoMerge).toBe("turned_on");
  });

  it("only reports what it would do when asked to look", async () => {
    const r = await ensurePrimeBranchProtection({ apply: false });
    expect(r).toMatchObject({ ok: false, status: "would_create" });
    expect(r.detail).toMatch(/no protection/);
    expect(writes()).toEqual([]);
  });

  it("is quiet when the ruleset says everything", async () => {
    h.rulesets = [
      { ...desiredPrimeRuleset({ lovableAppId: 777, ownerIsOrganization: true }), id: 9 },
    ];
    h.autoMerge = true;
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r).toMatchObject({ ok: true, status: "protected", rulesetId: 9 });
    expect(writes()).toEqual([]);
  });

  it("refuses to protect main without Lovable on the list", async () => {
    h.botLogin = null;
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r).toMatchObject({ ok: false, status: "blocked" });
    expect(r.detail).toMatch(/stop Lovable publishing/);
    expect(writes()).toEqual([]);
  });

  it("refuses a bot account that is not an App's", async () => {
    h.botLogin = "somebody";
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r.status).toBe("blocked");
    expect(h.calls.some((c) => c.route === "GET /apps/{app_slug}")).toBe(false);
  });

  it("refuses to require a check ci.yml no longer has", async () => {
    h.ci = "jobs:\n  verify:\n    name: Typecheck · Lint · Build\n";
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r).toMatchObject({ ok: false, status: "blocked" });
    expect(r.detail).toMatch(/no job named “Lovable install \(bun\.lockb\)”/);
    expect(writes()).toEqual([]);
  });

  it("says which permission it lacks when GitHub refuses the write", async () => {
    h.writeStatus = 403;
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r).toMatchObject({ ok: false, status: "needs_permission" });
    expect(r.fix).toMatch(/Administration: Read and write/);
  });

  it("leaves a ruleset a person switched off", async () => {
    h.rulesets = [
      {
        ...desiredPrimeRuleset({ lovableAppId: 777, ownerIsOrganization: true }),
        id: 9,
        enforcement: "disabled",
      },
    ];
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r).toMatchObject({ ok: false, status: "switched_off" });
    expect(writes()).toEqual([]);
  });

  it("puts back what drifted, through an update of the same ruleset", async () => {
    const held = desiredPrimeRuleset({ lovableAppId: 777, ownerIsOrganization: true });
    held.rules = held.rules?.filter((r) => r.type !== "pull_request");
    h.rulesets = [{ ...held, id: 9 }];
    h.autoMerge = true;
    const r = await ensurePrimeBranchProtection({ apply: true });
    expect(r).toMatchObject({ ok: true, status: "updated", rulesetId: 9 });
    expect(r.shortfall).toEqual(["it lacks the pull request rule"]);
    const put = h.calls.find((c) => c.route === "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}");
    expect(put?.params.ruleset_id).toBe(9);
    expect((put?.params.rules as Array<{ type: string }>).map((x) => x.type)).toContain(
      "pull_request",
    );
  });
});
