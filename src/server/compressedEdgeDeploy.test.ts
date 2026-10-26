/**
 * Which route `deployEdgeFunction` takes: the raw source, or the prime's
 * compressed bundle of it (`compressedEdgeBundle.pure.ts`). The Management
 * API is a stub of `fetch`; GitHub is a mock of the lookup, whose own rules
 * are `compressedEdgeBundle.server.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => ({ compressedBundleFor: vi.fn() }));
vi.mock("./compressedEdgeBundle.server", () => lookup);

import { deployEdgeFunction, deployEdgeFunctions } from "./backend-provisioning.server";
import { RAW_DEPLOY_CEILING_BYTES, sha256Hex } from "./compressedEdgeBundle.pure";

const PRIME = { owner: "naidu", repo: "prime", branch: "main" };
const REF = "abcdefghijklmnopqrst";

type Call = { method: string; url: string; contentType: string | null; body: unknown };
let calls: Call[] = [];
let answers: Array<{ status: number; body: unknown }> = [];
const originalFetch = globalThis.fetch;
const originalToken = process.env.SB_MGMT_API_TOKEN;

beforeEach(() => {
  process.env.SB_MGMT_API_TOKEN = "test-token";
  calls = [];
  answers = [];
  lookup.compressedBundleFor.mockReset();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      contentType: headers.get("content-type"),
      body: init?.body,
    });
    const a = answers.shift() ?? { status: 200, body: { id: "f-1", version: 3 } };
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), {
      status: a.status,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.SB_MGMT_API_TOKEN;
  else process.env.SB_MGMT_API_TOKEN = originalToken;
});

const bundleOf = (bytes: number, slug = "big-fn") => ({
  slug,
  entrypointPath: `${slug}/index.ts`,
  importMapPath: null,
  verifyJwt: true,
  files: [{ path: `${slug}/index.ts`, contentBase64: Buffer.alloc(bytes, 97).toString("base64") }],
});

const ezbr = new Uint8Array(Buffer.from("EZBRcompressed"));
const ready = {
  state: "ready" as const,
  runUrl: "https://github.com/naidu/prime/actions/runs/9",
  ezbr,
  manifest: {
    schema: 1,
    slug: "big-fn",
    commit: "c0ffee",
    upload: {
      entrypoint_path: "file:///home/runner/work/p/p/supabase/functions/big-fn/index.ts",
      import_map_path: null,
      ezbr_sha256: sha256Hex(ezbr),
      bytes: ezbr.length,
    },
    files: { "supabase/functions/big-fn/index.ts": "0".repeat(40) },
  },
};

describe("a bundle the raw route takes", () => {
  it("is posted as source, and GitHub is never asked", async () => {
    const r = await deployEdgeFunction(REF, bundleOf(1000), { compressed: { source: PRIME } });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      `https://api.supabase.com/v1/projects/${REF}/functions/deploy?slug=big-fn`,
    );
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect(r.deployed).toEqual({ id: "f-1", version: 3 });
    expect(lookup.compressedBundleFor).not.toHaveBeenCalled();
  });

  it("takes the compressed bundle when the raw route refuses it for its size", async () => {
    answers = [
      {
        status: 400,
        body: { message: "Function big-fn exceeds the maximum deployment size (5 MB)" },
      },
    ];
    lookup.compressedBundleFor.mockResolvedValue(ready);
    const r = await deployEdgeFunction(REF, bundleOf(1000), { compressed: { source: PRIME } });
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH"]);
    expect(calls[1].contentType).toBe("application/vnd.denoland.eszip");
    expect(r.deployed).toEqual({ id: "f-1", version: 3 });
  });

  it("fails as before on any other refusal", async () => {
    answers = [{ status: 500, body: { message: "boot error" } }];
    await expect(
      deployEdgeFunction(REF, bundleOf(1000), { compressed: { source: PRIME } }),
    ).rejects.toThrow(/Deploy failed for big-fn: 500/);
    expect(lookup.compressedBundleFor).not.toHaveBeenCalled();
  });

  it("fails as before where no compressed route was given (a clone's own functions)", async () => {
    answers = [{ status: 413, body: { message: "request entity too large" } }];
    await expect(deployEdgeFunction(REF, bundleOf(RAW_DEPLOY_CEILING_BYTES + 1))).rejects.toThrow(
      /413/,
    );
    expect(calls).toHaveLength(1);
    expect(lookup.compressedBundleFor).not.toHaveBeenCalled();
  });
});

describe("a bundle too large for the raw route", () => {
  it("is never posted as source, and goes up as the CLI uploads it", async () => {
    lookup.compressedBundleFor.mockResolvedValue(ready);
    const r = await deployEdgeFunction(REF, bundleOf(RAW_DEPLOY_CEILING_BYTES + 1), {
      compressed: { source: PRIME },
    });
    expect(lookup.compressedBundleFor).toHaveBeenCalledWith(
      expect.objectContaining({ source: PRIME, fn: expect.objectContaining({ slug: "big-fn" }) }),
    );
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(calls[0].method).toBe("PATCH");
    expect(url.pathname).toBe(`/v1/projects/${REF}/functions/big-fn`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      verify_jwt: "true",
      entrypoint_path: ready.manifest.upload.entrypoint_path,
      ezbr_sha256: ready.manifest.upload.ezbr_sha256,
    });
    expect(calls[0].contentType).toBe("application/vnd.denoland.eszip");
    expect(new Uint8Array(await (calls[0].body as Blob).arrayBuffer())).toEqual(ezbr);
    expect(r).toEqual({
      verifyJwt: true,
      overrideReason: null,
      deployed: { id: "f-1", version: 3 },
    });
  });

  it("creates the function where the project does not hold it", async () => {
    answers = [{ status: 404, body: { message: "Function not found" } }];
    lookup.compressedBundleFor.mockResolvedValue(ready);
    await deployEdgeFunction(REF, bundleOf(RAW_DEPLOY_CEILING_BYTES + 1), {
      compressed: { source: PRIME },
    });
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    const url = new URL(calls[1].url);
    expect(url.pathname).toBe(`/v1/projects/${REF}/functions`);
    expect(url.searchParams.get("slug")).toBe("big-fn");
    expect(url.searchParams.get("name")).toBe("big-fn");
  });

  it("sends this deployment's flag, not the one the bundle was built with", async () => {
    // `deployedVerifyJwt` forces a webhook slug anonymous on a clone.
    const webhook = {
      ...bundleOf(RAW_DEPLOY_CEILING_BYTES + 1, "stripe-webhook"),
      verifyJwt: true,
    };
    lookup.compressedBundleFor.mockResolvedValue({
      ...ready,
      manifest: { ...ready.manifest, slug: "stripe-webhook" },
    });
    const r = await deployEdgeFunction(REF, webhook, { compressed: { source: PRIME } });
    expect(r.verifyJwt).toBe(false);
    expect(r.overrideReason).toMatch(/anonymous-webhook pattern/);
    expect(new URL(calls[0].url).searchParams.get("verify_jwt")).toBe("false");
  });

  it("fails saying what it is waiting for, where there is no bundle yet", async () => {
    lookup.compressedBundleFor.mockResolvedValue({
      state: "awaiting",
      why: "a build is running (https://x/runs/4)",
    });
    const results = await deployEdgeFunctions(
      REF,
      [bundleOf(RAW_DEPLOY_CEILING_BYTES + 1)],
      undefined,
      undefined,
      {
        compressed: { source: PRIME },
      },
    );
    expect(calls).toEqual([]);
    expect(results).toEqual([
      {
        slug: "big-fn",
        success: false,
        error: `Deploy failed for big-fn: too large to deploy as source (${RAW_DEPLOY_CEILING_BYTES + 1} bytes of source), and awaiting its compressed bundle: a build is running (https://x/runs/4)`,
      },
    ]);
  });

  it("fails saying no bundle can stand in, where none may", async () => {
    lookup.compressedBundleFor.mockResolvedValue({
      state: "refused",
      why: "imports did not close",
    });
    await expect(
      deployEdgeFunction(REF, bundleOf(RAW_DEPLOY_CEILING_BYTES + 1), {
        compressed: { source: PRIME },
      }),
    ).rejects.toThrow(
      "Deploy failed for big-fn: too large to deploy as source (4000001 bytes of source), and no compressed bundle can stand in for it: imports did not close",
    );
    expect(calls).toEqual([]);
  });

  it("says which bundle the API refused", async () => {
    answers = [{ status: 400, body: "invalid eszip" }];
    lookup.compressedBundleFor.mockResolvedValue(ready);
    await expect(
      deployEdgeFunction(REF, bundleOf(RAW_DEPLOY_CEILING_BYTES + 1), {
        compressed: { source: PRIME },
      }),
    ).rejects.toThrow(
      "Deploy failed for big-fn: 400 — invalid eszip (compressed bundle from https://github.com/naidu/prime/actions/runs/9)",
    );
  });
});
