// The Codex secrets, kept where they belong: Prime's repository gets the
// model keys, no clone's holds any, nothing is ever written to a clone, and
// a clone row that names Prime's repository is never cleaned.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prime: null as null | {
    github_owner: string | null;
    github_repo: string | null;
    github_app_installation_id: string | null;
  },
  primeError: null as null | { message: string },
  clones: [] as Array<{
    id: string;
    name: string;
    github_owner: string | null;
    github_repo: string | null;
  }>,
  clonesError: null as null | { message: string },
  /** What each repository holds, by owner/repo; absent means the list fails. */
  held: new Map<string, string[] | "throw">(),
  syncs: [] as Array<{
    owner: string;
    repo: string;
    secrets: Record<string, unknown>;
    remove?: readonly string[];
  }>,
  failRepo: null as string | null,
  history: [] as Array<Record<string, unknown>>,
  keys: { OPENAI_API_KEY: "k1", ANTHROPIC_API_KEY: "k2" } as Record<string, string | undefined>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const clonesQuery = (filter: string[] | null) => {
    const run = () => ({
      data: filter ? h.clones.filter((c) => filter.includes(c.id)) : h.clones,
      error: h.clonesError,
    });
    const q = {
      order: () => q,
      in: (_col: string, ids: string[]) => clonesQuery(ids),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return q;
  };
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "prime_config") {
          return {
            select: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: h.prime, error: h.primeError }),
              }),
            }),
          };
        }
        if (table === "clones") return { select: () => clonesQuery(null) };
        if (table === "github_secret_syncs") {
          return {
            insert: async (row: Record<string, unknown>) => {
              h.history.push(row);
              return { error: null };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
});

vi.mock("@/server/clone-installation.server", () => ({
  loadCloneInstallationIds: async () => new Map<string, string>(),
}));

vi.mock("@/server/github-secrets.server", async () => {
  const actual = await vi.importActual<typeof import("@/server/github-secrets.server")>(
    "@/server/github-secrets.server",
  );
  return {
    CLONE_CODEX_REPO_SECRETS: actual.CLONE_CODEX_REPO_SECRETS,
    RETIRED_CODEX_REPO_SECRETS: actual.RETIRED_CODEX_REPO_SECRETS,
    buildCodexRepoSecrets: async () => h.keys,
    listRepoSecretNames: async ({ owner, repo }: { owner: string; repo: string }) => {
      const held = h.held.get(`${owner}/${repo}`);
      if (held === "throw") throw new Error("socket hang up");
      return held ?? null;
    },
    syncRepoSecrets: async (input: {
      owner: string;
      repo: string;
      secrets: Record<string, string | undefined>;
      remove?: readonly string[];
    }) => {
      h.syncs.push(input);
      if (`${input.owner}/${input.repo}` === h.failRepo) {
        return {
          ok: false,
          written: [],
          removed: [],
          skipped: [],
          failed: [
            { name: "OPENAI_API_KEY", error: "403: the installation is missing a permission" },
          ],
          nothingConfigured: true,
        };
      }
      const written = Object.entries(input.secrets)
        .filter(([, v]) => !!v)
        .map(([k]) => k);
      return {
        ok: true,
        written,
        removed: [...(input.remove ?? [])],
        skipped: [],
        failed: [],
        nothingConfigured: written.length === 0,
      };
    },
  };
});

import {
  reconcileCodexRepoSecrets,
  removeCodexSecretsFromClones,
  syncPrimeCodexSecrets,
} from "./codex-repo-secrets.server";
import {
  CLONE_CODEX_REPO_SECRETS,
  RETIRED_CODEX_REPO_SECRETS,
} from "@/server/github-secrets.server";

const clone = (id: string, repo: string | null) => ({
  id,
  name: `Clone ${id}`,
  github_owner: repo ? "acme" : null,
  github_repo: repo,
});

beforeEach(() => {
  h.prime = { github_owner: "acme", github_repo: "prime", github_app_installation_id: null };
  h.primeError = null;
  h.clones = [clone("c1", "one"), clone("c2", "two"), clone("c3", null)];
  h.clonesError = null;
  h.held = new Map();
  h.syncs = [];
  h.failRepo = null;
  h.history = [];
  h.keys = { OPENAI_API_KEY: "k1", ANTHROPIC_API_KEY: "k2" };
});

describe("syncPrimeCodexSecrets", () => {
  it("writes Mission Control's keys to Prime and removes the masters", async () => {
    const r = await syncPrimeCodexSecrets({ triggerSource: "manual", triggeredBy: "u1" });
    expect(r).toMatchObject({ ok: true, target: "acme/prime" });
    expect(h.syncs).toEqual([
      {
        owner: "acme",
        repo: "prime",
        installationId: null,
        secrets: h.keys,
        remove: RETIRED_CODEX_REPO_SECRETS,
      },
    ]);
    expect(h.history).toEqual([
      expect.objectContaining({
        target_kind: "prime",
        clone_id: null,
        written: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        trigger_source: "manual",
        triggered_by: "u1",
      }),
    ]);
  });

  it("says so, and touches nothing, when Prime has no repository", async () => {
    h.prime = { github_owner: null, github_repo: null, github_app_installation_id: null };
    const r = await syncPrimeCodexSecrets({ triggerSource: "nightly" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not configured/) });
    expect(h.syncs).toEqual([]);
    expect(h.history).toEqual([]);
  });
});

describe("removeCodexSecretsFromClones", () => {
  it("deletes only the Codex secrets each clone holds, and writes nothing", async () => {
    h.held.set("acme/one", [
      "OPENAI_API_KEY",
      "CODEX_SECURITY_WEBHOOK_SECRET",
      "SUPABASE_ACCESS_TOKEN",
    ]);
    h.held.set("acme/two", ["SUPABASE_ACCESS_TOKEN"]);
    const r = await removeCodexSecretsFromClones({
      triggerSource: "fleet-rotation",
      recordClean: true,
    });
    expect(r.ok).toBe(true);
    // c3 has no repository; c2 holds nothing to remove, so costs no delete.
    expect(h.syncs).toEqual([
      {
        owner: "acme",
        repo: "one",
        installationId: null,
        secrets: {},
        remove: ["OPENAI_API_KEY", "CODEX_SECURITY_WEBHOOK_SECRET"],
      },
    ]);
    expect(r.results.map((c) => [c.target, c.removed])).toEqual([
      ["acme/one", ["OPENAI_API_KEY", "CODEX_SECURITY_WEBHOOK_SECRET"]],
      ["acme/two", []],
    ]);
    for (const s of h.syncs) expect(s.secrets).toEqual({});
  });

  it("records a clean clone only when asked to", async () => {
    h.held.set("acme/one", []);
    h.held.set("acme/two", ["ANTHROPIC_API_KEY"]);
    await removeCodexSecretsFromClones({ triggerSource: "nightly", recordClean: false });
    expect(h.history.map((row) => [row.repo, row.trigger_source])).toEqual([["two", "nightly"]]);

    h.history = [];
    await removeCodexSecretsFromClones({ triggerSource: "provisioning", recordClean: true });
    expect(h.history.map((row) => row.repo).sort()).toEqual(["one", "two"]);
  });

  it("deletes every Codex name blind when the repository cannot be listed", async () => {
    // acme/one: no entry, so the list answers null; acme/two: a full page.
    h.held.set(
      "acme/two",
      Array.from({ length: 100 }, (_, i) => `S${i}`),
    );
    await removeCodexSecretsFromClones({ triggerSource: "manual", recordClean: true });
    expect(h.syncs.map((s) => [s.repo, s.remove])).toEqual([
      ["one", [...CLONE_CODEX_REPO_SECRETS]],
      ["two", [...CLONE_CODEX_REPO_SECRETS]],
    ]);
  });

  it("never cleans a clone row that names Prime's repository", async () => {
    h.clones = [clone("c1", "one"), { ...clone("cp", "Prime"), name: "Mislabelled" }];
    h.held.set("acme/one", ["OPENAI_API_KEY"]);
    h.held.set("acme/Prime", ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    const r = await removeCodexSecretsFromClones({ triggerSource: "nightly", recordClean: false });
    expect(r.skippedPrime).toEqual(["Mislabelled"]);
    expect(h.syncs.map((s) => s.repo)).toEqual(["one"]);
  });

  it("carries on past a clone that fails, and says which", async () => {
    h.held.set("acme/one", "throw");
    h.held.set("acme/two", ["OPENAI_API_KEY"]);
    const r = await removeCodexSecretsFromClones({ triggerSource: "manual", recordClean: true });
    expect(r.ok).toBe(false);
    expect(r.results).toEqual([
      expect.objectContaining({ target: "acme/one", ok: false, error: "socket hang up" }),
      expect.objectContaining({ target: "acme/two", ok: true, removed: ["OPENAI_API_KEY"] }),
    ]);
  });

  it("records a failed removal even on the nightly pass", async () => {
    h.held.set("acme/one", ["OPENAI_API_KEY"]);
    h.held.set("acme/two", []);
    h.failRepo = "acme/one";
    const r = await removeCodexSecretsFromClones({ triggerSource: "nightly", recordClean: false });
    expect(r.ok).toBe(false);
    expect(h.history).toEqual([expect.objectContaining({ repo: "one", ok: false })]);
  });

  it("narrows to the clones named", async () => {
    h.held.set("acme/two", ["OPENAI_API_KEY"]);
    const r = await removeCodexSecretsFromClones({
      cloneIds: ["c2"],
      triggerSource: "provisioning",
      recordClean: true,
    });
    expect(r.results.map((c) => c.cloneId)).toEqual(["c2"]);
  });

  it("says so when the clones cannot be listed", async () => {
    h.clonesError = { message: "permission denied" };
    const r = await removeCodexSecretsFromClones({ triggerSource: "nightly", recordClean: false });
    expect(r).toMatchObject({ ok: false, error: "Could not list clones: permission denied" });
    expect(h.syncs).toEqual([]);
  });
});

describe("reconcileCodexRepoSecrets", () => {
  it("syncs Prime, then cleans the clones, and is ok only when both are", async () => {
    h.held.set("acme/one", ["OPENAI_API_KEY"]);
    h.held.set("acme/two", []);
    const r = await reconcileCodexRepoSecrets({
      triggerSource: "mission-control",
      recordClean: true,
    });
    expect(r.ok).toBe(true);
    expect(h.syncs.map((s) => s.repo)).toEqual(["prime", "one"]);
    // Prime first; the clones run side by side, so their rows land in either order.
    expect(h.history[0]).toMatchObject({ target_kind: "prime", trigger_source: "mission-control" });
    expect(
      h.history
        .slice(1)
        .map((row) => [row.target_kind, row.repo, row.trigger_source])
        .sort(),
    ).toEqual([
      ["clone", "one", "mission-control"],
      ["clone", "two", "mission-control"],
    ]);

    h.failRepo = "acme/prime";
    expect(
      (await reconcileCodexRepoSecrets({ triggerSource: "nightly", recordClean: false })).ok,
    ).toBe(false);
  });
});
