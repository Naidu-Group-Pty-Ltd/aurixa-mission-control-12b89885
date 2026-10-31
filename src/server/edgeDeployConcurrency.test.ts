/**
 * Edge functions deploy several at a time, never more than the bound, and the
 * budget is honoured the way it always was.
 *
 * The deploys used to run one after another — about seven a minute against the
 * prime's ~435 functions, so roughly an hour of every clone's build. The
 * Management API is a stub of `fetch` whose answers are held until the test
 * releases them, so how many requests are open at once is observed rather
 * than inferred.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./compressedEdgeBundle.server", () => ({ compressedBundleFor: vi.fn() }));

import {
  EDGE_DEPLOY_CONCURRENCY,
  deployEdgeFunctions,
  edgeDeployConcurrency,
} from "./backend-provisioning.server";
import { BudgetPause } from "./provisioningBudget";

const REF = "abcdefghijklmnopqrst";
const originalFetch = globalThis.fetch;
const originalToken = process.env.SB_MGMT_API_TOKEN;

let open = 0;
let peak = 0;
let started: string[] = [];
let pending: Array<() => void> = [];
/** Slugs whose deploy the API refuses. */
let refuse = new Set<string>();

const slugOf = (url: string) => new URL(url).searchParams.get("slug") ?? "?";

beforeEach(() => {
  process.env.SB_MGMT_API_TOKEN = "test-token";
  open = 0;
  peak = 0;
  started = [];
  pending = [];
  refuse = new Set();
  globalThis.fetch = ((url: unknown) => {
    const slug = slugOf(String(url));
    started.push(slug);
    open += 1;
    peak = Math.max(peak, open);
    return new Promise<Response>((resolve) => {
      pending.push(() => {
        open -= 1;
        resolve(
          refuse.has(slug)
            ? new Response("bad bundle", { status: 400 })
            : new Response(JSON.stringify({ id: `id-${slug}`, version: 1 }), { status: 200 }),
        );
      });
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.SB_MGMT_API_TOKEN;
  else process.env.SB_MGMT_API_TOKEN = originalToken;
});

const fn = (slug: string) => ({
  slug,
  entrypointPath: `${slug}/index.ts`,
  importMapPath: null,
  verifyJwt: true,
  files: [{ path: `${slug}/index.ts`, contentBase64: Buffer.from("x").toString("base64") }],
});

/** Answer every open request, in the order they were sent, until the run settles. */
async function drive<T>(run: Promise<T>): Promise<T> {
  let settled = false;
  // Both outcomes observed here, so a rejection is never unhandled while the
  // loop is still answering requests; the caller asserts on `run` itself.
  run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await new Promise((r) => setTimeout(r, 0));
    const next = pending.shift();
    if (next) next();
  }
  return run;
}

describe("edgeDeployConcurrency", () => {
  it("defaults to the bound, and takes an operator's override within 1–8", () => {
    expect(edgeDeployConcurrency({})).toBe(EDGE_DEPLOY_CONCURRENCY);
    expect(edgeDeployConcurrency({ EDGE_DEPLOY_CONCURRENCY: "1" })).toBe(1);
    expect(edgeDeployConcurrency({ EDGE_DEPLOY_CONCURRENCY: "6" })).toBe(6);
    expect(edgeDeployConcurrency({ EDGE_DEPLOY_CONCURRENCY: "50" })).toBe(8);
    expect(edgeDeployConcurrency({ EDGE_DEPLOY_CONCURRENCY: "0" })).toBe(EDGE_DEPLOY_CONCURRENCY);
    expect(edgeDeployConcurrency({ EDGE_DEPLOY_CONCURRENCY: "lots" })).toBe(
      EDGE_DEPLOY_CONCURRENCY,
    );
  });
});

describe("deployEdgeFunctions", () => {
  it("runs several deploys at once and never more than the bound", async () => {
    const slugs = Array.from({ length: 10 }, (_, i) => `fn-${i}`);
    const results = await drive(
      deployEdgeFunctions(REF, slugs.map(fn), undefined, null, { concurrency: 3 }),
    );
    expect(peak).toBe(3);
    expect(started).toEqual(slugs);
    // In INPUT order, whatever order they finished in.
    expect(results.map((r) => r.slug)).toEqual(slugs);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results[0]).toMatchObject({ functionId: "id-fn-0", functionVersion: 1 });
  });

  it("serial when the bound is one", async () => {
    await drive(
      deployEdgeFunctions(REF, ["a", "b", "c"].map(fn), undefined, null, { concurrency: 1 }),
    );
    expect(peak).toBe(1);
  });

  it("one refused deploy is recorded and the rest still land", async () => {
    refuse = new Set(["fn-1"]);
    const results = await drive(
      deployEdgeFunctions(REF, ["fn-0", "fn-1", "fn-2"].map(fn), undefined, null, {
        concurrency: 2,
      }),
    );
    expect(results.map((r) => [r.slug, r.success])).toEqual([
      ["fn-0", true],
      ["fn-1", false],
      ["fn-2", true],
    ]);
    expect(results[1].error).toMatch(/Deploy failed for fn-1: 400/);
  });

  it("past the deadline it starts nothing new, waits for what it started, then pauses", async () => {
    // Already past: the first deploy still starts (a claimed job must move),
    // and nothing after it does.
    const run = deployEdgeFunctions(REF, ["a", "b", "c"].map(fn), undefined, Date.now() - 1, {
      concurrency: 3,
    });
    await expect(drive(run)).rejects.toBeInstanceOf(BudgetPause);
    expect(started).toEqual(["a"]);
    // The started deploy was answered before the pause was thrown.
    expect(open).toBe(0);
    await expect(
      drive(
        deployEdgeFunctions(REF, ["a", "b"].map(fn), undefined, Date.now() - 1, { concurrency: 2 }),
      ),
    ).rejects.toThrow(/deployed 1\/2 edge functions this pass/);
  });

  it("reports progress for each deploy it starts", async () => {
    const lines: string[] = [];
    await drive(
      deployEdgeFunctions(
        REF,
        ["a", "b"].map(fn),
        async (_s, d) => {
          lines.push(d);
        },
        null,
        { concurrency: 2 },
      ),
    );
    expect(lines).toEqual(["Deploying edge function 1/2: a", "Deploying edge function 2/2: b"]);
  });
});
