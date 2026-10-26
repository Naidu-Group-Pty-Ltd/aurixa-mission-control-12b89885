import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const allowance = vi.hoisted(() => ({
  readGitHubRemaining: vi.fn(async (): Promise<number | null> => null),
}));
vi.mock("./githubAllowance.server", () => allowance);
import { writeZip } from "@/lib/agreements/zipWriter.pure";
import {
  compressedBundleFor,
  forgetBundleReads,
  type BundleOctokit,
} from "./compressedEdgeBundle.server";
import { gitBlobId, sha256Hex, type DeployableFunction } from "./compressedEdgeBundle.pure";

const PRIME = { owner: "naidu", repo: "prime", branch: "main" };
const NOW = Date.parse("2026-10-26T10:00:00Z");

const SOURCES: Record<string, string> = {
  "big-fn/index.ts": 'import "../_shared/a.ts";',
  "_shared/a.ts": "export const a = 1;",
};
const fn = (sources = SOURCES): DeployableFunction => ({
  slug: "big-fn",
  entrypointPath: "big-fn/index.ts",
  importMapPath: null,
  files: Object.entries(sources).map(([path, t]) => ({
    path,
    contentBase64: Buffer.from(t).toString("base64"),
  })),
});

async function artifactOf(sources: Record<string, string>, body = "bundle", slug = "big-fn") {
  const ezbr = Buffer.concat([Buffer.from("EZBR"), Buffer.from(body)]);
  const manifest = {
    schema: 1,
    slug,
    commit: "c0ffee",
    built_by: { cli: "2.121.0" },
    upload: {
      entrypoint_path: `file:///home/runner/work/p/p/supabase/functions/${slug}/index.ts`,
      import_map_path: null,
      ezbr_sha256: sha256Hex(ezbr),
      bytes: ezbr.length,
    },
    files: Object.fromEntries(
      Object.entries(sources).map(([p, t]) => [
        `supabase/functions/${p}`,
        gitBlobId(Buffer.from(t)),
      ]),
    ),
  };
  return writeZip([
    { name: `${slug}.ezbr`, data: new Uint8Array(ezbr) },
    {
      name: `${slug}.manifest.json`,
      data: new TextEncoder().encode(JSON.stringify(manifest)),
      compress: true,
    },
  ]);
}

type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  title?: string;
  event?: string;
  head_branch?: string;
  zip?: Uint8Array;
};

/** GitHub, as far as this module asks it anything. */
function github(runs: Run[], opts: { dispatchStatus?: number } = {}) {
  const calls: string[] = [];
  const dispatches: Array<Record<string, unknown>> = [];
  const octokit: BundleOctokit = {
    request: async (route, params = {}) => {
      calls.push(route);
      if (route === "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs") {
        expect(params).toMatchObject({
          workflow_id: "edge-function-bundles.yml",
          branch: "main",
          event: "workflow_dispatch",
        });
        return {
          data: {
            workflow_runs: runs.map((r) => ({
              id: r.id,
              status: r.status,
              conclusion: r.conclusion,
              created_at: r.created_at,
              html_url: `https://github.com/naidu/prime/actions/runs/${r.id}`,
              display_title: r.title ?? "Edge function bundles: big-fn",
              event: r.event ?? "workflow_dispatch",
              head_branch: r.head_branch ?? "main",
            })),
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts") {
        const run = runs.find((r) => r.id === params.run_id);
        return {
          data: {
            artifacts: run?.zip
              ? [{ id: run.id * 10, name: "edge-function-bundles", expired: false }]
              : [],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}") {
        const run = runs.find((r) => r.id * 10 === params.artifact_id)!;
        const zip = run.zip!;
        return { data: zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
      }
      if (route === "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches") {
        if (opts.dispatchStatus)
          throw Object.assign(new Error("Not Found"), { status: opts.dispatchStatus });
        dispatches.push(params);
        return { data: null };
      }
      throw new Error(`unexpected ${route}`);
    },
  };
  return { octokit, calls, dispatches };
}

const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const originalFetch = globalThis.fetch;
beforeEach(() => {
  forgetBundleReads();
  allowance.readGitHubRemaining.mockResolvedValue(null);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("compressedBundleFor", () => {
  it("hands over the newest bundle built from these bytes, and asks for nothing", async () => {
    const gh = github([
      {
        id: 2,
        status: "completed",
        conclusion: "success",
        created_at: ago(30),
        zip: await artifactOf(SOURCES),
      },
    ]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state).toBe("ready");
    expect(r.state === "ready" && r.runUrl).toBe("https://github.com/naidu/prime/actions/runs/2");
    expect(r.state === "ready" && new TextDecoder().decode(r.ezbr)).toBe("EZBRbundle");
    expect(gh.dispatches).toEqual([]);
  });

  it("looks past a newer build of other source to an older one of this source", async () => {
    const changed = { ...SOURCES, "_shared/a.ts": "export const a = 2;" };
    const gh = github([
      {
        id: 3,
        status: "completed",
        conclusion: "success",
        created_at: ago(5),
        zip: await artifactOf(changed, "newer"),
      },
      {
        id: 2,
        status: "completed",
        conclusion: "success",
        created_at: ago(90),
        zip: await artifactOf(SOURCES, "older"),
      },
    ]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state === "ready" && new TextDecoder().decode(r.ezbr)).toBe("EZBRolder");
  });

  it("asks the prime to build one when every bundle is out of date", async () => {
    const changed = { ...SOURCES, "_shared/a.ts": "export const a = 2;" };
    const gh = github([
      {
        id: 2,
        status: "completed",
        conclusion: "success",
        created_at: ago(90),
        zip: await artifactOf(changed),
      },
    ]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r).toEqual({
      state: "awaiting",
      why:
        "the newest build is out of date: supabase/functions/_shared/a.ts has changed since the bundle was built; " +
        "asked naidu/prime to build it (edge-function-bundles.yml on main)",
    });
    expect(gh.dispatches).toEqual([
      {
        owner: "naidu",
        repo: "prime",
        workflow_id: "edge-function-bundles.yml",
        ref: "main",
        inputs: { functions: "big-fn" },
      },
    ]);
  });

  it("asks for a build when there has never been one", async () => {
    const gh = github([]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state === "awaiting" && r.why).toMatch(
      /^no build of it was found; asked naidu\/prime/,
    );
    expect(gh.dispatches).toHaveLength(1);
  });

  it("waits on a build already running rather than asking again", async () => {
    const gh = github([{ id: 4, status: "in_progress", conclusion: null, created_at: ago(2) }]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state === "awaiting" && r.why).toBe(
      "no build of it was found; a build is running (https://github.com/naidu/prime/actions/runs/4)",
    );
    expect(gh.dispatches).toEqual([]);
  });

  it("reads only dispatches on the prime's branch", async () => {
    const gh = github([
      {
        id: 5,
        status: "completed",
        conclusion: "success",
        created_at: ago(1),
        event: "pull_request",
        zip: await artifactOf(SOURCES),
      },
      {
        id: 6,
        status: "completed",
        conclusion: "success",
        created_at: ago(1),
        head_branch: "claude/x",
        zip: await artifactOf(SOURCES),
      },
    ]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state).toBe("awaiting");
    expect(gh.calls).not.toContain("GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts");
  });

  it("does not look further back past a bundle that is not what it says", async () => {
    const forged = await artifactOf(SOURCES);
    // Same archive shape, different bundle bytes than the manifest describes.
    const bad = await (async () => {
      const zip = await artifactOf(SOURCES, "bundle");
      const text = Buffer.from(zip).toString("latin1").replace("EZBRbundle", "EZBRbundlE");
      return new Uint8Array(Buffer.from(text, "latin1"));
    })();
    const gh = github([
      { id: 8, status: "completed", conclusion: "success", created_at: ago(1), zip: bad },
      { id: 7, status: "completed", conclusion: "success", created_at: ago(90), zip: forged },
    ]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state).toBe("awaiting");
    expect(r.state === "awaiting" && r.why).toMatch(
      /^the newest build was refused: the bundle is not the one its manifest describes/,
    );
  });

  it("says why it could not ask, rather than claiming it did", async () => {
    const gh = github([], { dispatchStatus: 404 });
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state === "awaiting" && r.why).toMatch(
      /answered 404: \.github\/workflows\/edge-function-bundles\.yml is not on main/,
    );
  });

  it("lists the runs once a pass, however many functions ask", async () => {
    const gh = github([
      {
        id: 2,
        status: "completed",
        conclusion: "success",
        created_at: ago(30),
        zip: await artifactOf(SOURCES),
      },
    ]);
    await compressedBundleFor({ octokit: gh.octokit, prime: PRIME, fn: fn(), nowMs: NOW });
    await compressedBundleFor({ octokit: gh.octokit, prime: PRIME, fn: fn(), nowMs: NOW + 1000 });
    expect(gh.calls.filter((c) => c.endsWith("/runs"))).toHaveLength(1);
    expect(gh.calls.filter((c) => c.includes("{archive_format}"))).toHaveLength(1);
  });

  it("follows GitHub's redirect to the archive without the App's credentials", async () => {
    const zip = await artifactOf(SOURCES);
    const gh = github([
      { id: 2, status: "completed", conclusion: "success", created_at: ago(30), zip },
    ]);
    const asked: Array<{ url: string; init: RequestInit | undefined }> = [];
    const request = gh.octokit.request;
    const octokit: BundleOctokit = {
      request: async (route, params) => {
        if (route.includes("{archive_format}")) {
          expect(params).toMatchObject({ request: { redirect: "manual" } });
          return { data: "", headers: { location: "https://blob.example/artifact.zip?sig=x" } };
        }
        return request(route, params);
      },
    };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      asked.push({ url: String(url), init });
      return new Response(new Blob([zip as BlobPart]));
    }) as typeof fetch;
    const r = await compressedBundleFor({ octokit, prime: PRIME, fn: fn(), nowMs: NOW });
    expect(r.state).toBe("ready");
    expect(asked).toEqual([{ url: "https://blob.example/artifact.zip?sig=x", init: undefined }]);
  });

  it("asks GitHub nothing while the installation's window is nearly spent", async () => {
    allowance.readGitHubRemaining.mockResolvedValue(10);
    const gh = github([
      {
        id: 2,
        status: "completed",
        conclusion: "success",
        created_at: ago(30),
        zip: await artifactOf(SOURCES),
      },
    ]);
    const r = await compressedBundleFor({
      octokit: gh.octokit,
      prime: PRIME,
      fn: fn(),
      nowMs: NOW,
    });
    expect(r.state).toBe("awaiting");
    expect(r.state === "awaiting" && r.why).toMatch(
      /^GitHub was not asked: 10 call\(s\) left in the installation's window/,
    );
    expect(gh.calls).toEqual([]);
  });

  it("never reads a failed GitHub call as no bundle", async () => {
    const octokit: BundleOctokit = {
      request: async () => {
        throw Object.assign(new Error("Bad credentials"), { status: 401 });
      },
    };
    await expect(
      compressedBundleFor({ octokit, prime: PRIME, fn: fn(), nowMs: NOW }),
    ).rejects.toThrow("Bad credentials");
  });
});
