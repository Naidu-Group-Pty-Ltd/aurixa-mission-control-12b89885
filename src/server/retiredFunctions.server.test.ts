/**
 * Reading the prime's retired functions for one pass: one commit, the budget
 * first, and a named refusal for every way it cannot read.
 *
 * The doubles answer as GitHub does. A directory read through the contents API
 * is an array of entries. A file read through `getFileContent` is a `RepoFile`,
 * or null for a 404. Octokit rejects with an error carrying `status`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const gh = vi.hoisted(() => ({
  remaining: 5000 as number | null,
  prime: { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" } as {
    owner: string;
    repo: string;
    branch: string;
  } | null,
  primeSourceError: null as Error | null,
  /** Each repository's `supabase/` paths, by `owner/repo#branch`. */
  trees: {} as Record<string, { paths: string[]; commitSha: string } | null>,
  /** What the contents API answers for `.github/workflows`, or the error it throws. */
  listing: null as unknown,
  listingError: null as (Error & { status?: number }) | null,
  /** Each file's text by path; absent reads as a 404. */
  files: {} as Record<string, string>,
  fileErrors: {} as Record<string, Error>,
  octokitError: null as Error | null,
  calls: [] as string[],
}));

vi.mock("./githubAllowance.server", () => ({
  readGitHubRemaining: async () => gh.remaining,
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

vi.mock("./prime-backend.server", () => ({
  resolvePrimeSource: async () => {
    if (gh.primeSourceError) throw gh.primeSourceError;
    return gh.prime;
  },
  fetchSupabaseTreePaths: async (
    _o: unknown,
    ref: { owner: string; repo: string; branch: string },
  ) => {
    gh.calls.push(`tree ${ref.owner}/${ref.repo}#${ref.branch}`);
    return gh.trees[`${ref.owner}/${ref.repo}#${ref.branch}`] ?? null;
  },
}));

vi.mock("./github-app.server", () => ({
  getAppOctokit: () => {
    if (gh.octokitError) throw gh.octokitError;
    return {
      repos: {
        getContent: async (args: { path: string; ref: string }) => {
          gh.calls.push(`list ${args.path}@${args.ref}`);
          if (gh.listingError) throw gh.listingError;
          return { data: gh.listing };
        },
      },
    };
  },
  getFileContent: async (
    _o: unknown,
    ref: { owner: string; repo: string; branch: string },
    path: string,
  ) => {
    gh.calls.push(`read ${path}@${ref.branch}`);
    if (gh.fileErrors[path]) throw gh.fileErrors[path];
    const text = gh.files[path];
    if (text === undefined) return null;
    const base64 = Buffer.from(text, "utf8").toString("base64");
    return { sha: "blob", content: text, base64, binary: false, bytes: text.length };
  },
}));

import { openRetiredFunctionRegister } from "./retiredFunctions.server";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/retired-functions/${name}.yml.txt`, import.meta.url), "utf8");

const HEAD = "d72032e1a4f9c3b2e8d7f6a5b4c3d2e1f0a9b8c7";
const RETIRED_PATH = ".github/workflows/decommission-retired-functions.yml";
const BUILDER_PATH = ".github/workflows/decommission-builder-portal-functions.yml";

const entry = (path: string, type = "file") => ({
  type,
  path,
  name: path.split("/").pop(),
  sha: "x",
});

beforeEach(() => {
  gh.remaining = 5000;
  gh.prime = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };
  gh.primeSourceError = null;
  gh.trees = {
    "Naidu-Group-Pty-Ltd/npc-property-dashbord#main": {
      paths: [
        "supabase/config.toml",
        "supabase/functions/builder-stock-marketplace/index.ts",
        "supabase/functions/listings-cache/index.ts",
      ],
      commitSha: HEAD,
    },
    "Naidu-Group-Pty-Ltd/npc-client-dashboard#main": {
      paths: ["supabase/functions/listings-cache/index.ts"],
      commitSha: "c".repeat(40),
    },
  };
  gh.listing = [
    entry(".github/workflows/ci.yml"),
    entry(BUILDER_PATH),
    entry(RETIRED_PATH),
    entry(".github/workflows/decommission-notes", "dir"),
  ];
  gh.listingError = null;
  gh.files = {
    [RETIRED_PATH]: fixture("decommission-retired-functions"),
    [BUILDER_PATH]: fixture("decommission-builder-portal-functions"),
  };
  gh.fileErrors = {};
  gh.octokitError = null;
  gh.calls = [];
});

describe("openRetiredFunctionRegister", () => {
  it("reads both lists and the tree at the one commit the tree was read at", async () => {
    const opening = await openRetiredFunctionRegister();
    expect(opening.ok).toBe(true);
    if (!opening.ok) return;
    expect(opening.register.readAt).toBe("Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1a4f9");
    expect(opening.register.retiredBy.size).toBe(34);
    expect(opening.register.retiredBy.get("street-view")).toBe(RETIRED_PATH);
    expect(opening.register.primeCarries.has("builder-stock-marketplace")).toBe(true);
    expect(opening.register.unreadable).toEqual([]);
    // Pinned: the branch is read once, by the tree, and everything after names its commit.
    expect(gh.calls).toEqual([
      "tree Naidu-Group-Pty-Ltd/npc-property-dashbord#main",
      `list .github/workflows@${HEAD}`,
      `read ${BUILDER_PATH}@${HEAD}`,
      `read ${RETIRED_PATH}@${HEAD}`,
    ]);
  });

  it("reads a clone's own tree on request, and names one it could not read", async () => {
    const opening = await openRetiredFunctionRegister();
    if (!opening.ok) throw new Error("expected a register");
    const own = await opening.cloneCarries({
      owner: "Naidu-Group-Pty-Ltd",
      repo: "npc-client-dashboard",
      branch: "main",
    });
    expect(own).toEqual({ carries: new Set(["listings-cache"]) });
    expect(
      await opening.cloneCarries({ owner: "Naidu-Group-Pty-Ltd", repo: "gone", branch: "main" }),
    ).toEqual({ refused: "Naidu-Group-Pty-Ltd/gone@main could not be read" });
  });

  it("asks the budget first, and spends nothing when it says to wait", async () => {
    gh.remaining = 900;
    const opening = await openRetiredFunctionRegister();
    expect(opening).toEqual({
      ok: false,
      postponed: true,
      why: "900 call(s) left in the installation's window, below the scan floor of 1500",
    });
    expect(gh.calls).toEqual([]);
  });

  it("goes on when the allowance cannot be read, as every lane does", async () => {
    gh.remaining = null;
    expect((await openRetiredFunctionRegister()).ok).toBe(true);
  });

  it("names a prime that is not configured, or not readable, as a refusal", async () => {
    gh.prime = null;
    expect(await openRetiredFunctionRegister()).toEqual({
      ok: false,
      postponed: false,
      why: "the prime's repository is not configured",
    });
    gh.prime = { owner: "o", repo: "r", branch: "main" };
    gh.primeSourceError = new Error("Could not read prime_config: timeout");
    expect(await openRetiredFunctionRegister()).toEqual({
      ok: false,
      postponed: false,
      why: "the retired functions could not be read: Could not read prime_config: timeout",
    });
  });

  it("refuses rather than read a tree it does not have", async () => {
    gh.trees = {};
    expect(await openRetiredFunctionRegister()).toEqual({
      ok: false,
      postponed: false,
      why: "the prime's supabase/ tree could not be read from Naidu-Group-Pty-Ltd/npc-property-dashbord@main",
    });
    expect(gh.calls.filter((c) => c.startsWith("list") || c.startsWith("read"))).toEqual([]);
  });

  it("refuses a workflows directory it could not list, or that is not a directory", async () => {
    gh.listingError = Object.assign(new Error("Server Error"), { status: 502 });
    expect(await openRetiredFunctionRegister()).toEqual({
      ok: false,
      postponed: false,
      why: "the prime's workflows could not be listed at Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1a4f9: Server Error",
    });
    gh.listingError = null;
    gh.listing = { type: "file", path: ".github/workflows" };
    expect(await openRetiredFunctionRegister()).toEqual({
      ok: false,
      postponed: false,
      why: "the prime's .github/workflows at Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1a4f9 is not a directory",
    });
  });

  it("names a workflow it could not read and still reads the others", async () => {
    delete gh.files[RETIRED_PATH];
    gh.fileErrors[BUILDER_PATH] = new Error("socket hang up");
    gh.listing = [entry(BUILDER_PATH), entry(RETIRED_PATH)];
    const opening = await openRetiredFunctionRegister();
    if (!opening.ok) throw new Error("expected a register");
    expect(opening.register.retiredBy.size).toBe(0);
    expect(opening.register.unreadable).toEqual([
      {
        path: BUILDER_PATH,
        why: "it could not be read at Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1a4f9: socket hang up",
      },
      {
        path: RETIRED_PATH,
        why: "it could not be read at Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1a4f9",
      },
    ]);
  });

  it("never throws, even when the installation cannot be reached at all", async () => {
    gh.octokitError = new Error("Missing required env var: GITHUB_APP_ID");
    expect(await openRetiredFunctionRegister()).toEqual({
      ok: false,
      postponed: false,
      why: "the retired functions could not be read: Missing required env var: GITHUB_APP_ID",
    });
  });
});
