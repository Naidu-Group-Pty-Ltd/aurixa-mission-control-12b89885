import { describe, it, expect, vi, beforeEach } from "vitest";

const batched = vi.fn();
vi.mock("./prime-backend.server", () => ({
  fetchBlobTextsBatched: (...a: unknown[]) => batched(...a),
  decodeBase64Utf8: (b64: string) => Buffer.from(b64, "base64").toString("utf8"),
}));

import {
  digestPrimeBodies,
  bodyDigests,
  sha256Hex,
  MAX_DIGEST_BYTES,
} from "./primeBodyDigests.server";
import { migrationBodyForms } from "./migrationBodyIdentity.pure";
import type { PrimeMigrationCorpus } from "./prime-backend.server";

const octokit = {} as never;
const ref = { owner: "o", repo: "r" } as never;

/** A corpus reference, as the version these fixtures key their files by. */
const idOf = (ref: string | { id: string }) => (typeof ref === "string" ? ref : ref.id);

/** A corpus whose bodies GitHub will serve, at a given commit. */
function corpusOf(
  sourceSha: string,
  files: Record<string, { sql: string; size?: number | null }>,
): PrimeMigrationCorpus {
  return {
    metas: Object.keys(files).map((id) => ({ id, name: `${id}_m.sql`, path: id })),
    files: Object.entries(files).map(([id, f]) => ({
      id,
      name: `${id}_m.sql`,
      path: id,
      sha: `blob-${id}`,
      size: f.size === undefined ? Buffer.byteLength(f.sql, "utf8") : f.size,
    })),
    sourceSha,
    withdrawal: { state: "absent", excluded: [], unmatched: [] },
    bodyIdentity: (ref) => (files[idOf(ref)] ? `blob-${idOf(ref)}` : null),
    sizeOf: (ref) => {
      const f = files[idOf(ref)];
      if (!f) return null;
      return f.size === undefined ? Buffer.byteLength(f.sql, "utf8") : f.size;
    },
    loadSql: async (ref) => files[idOf(ref)].sql,
    openSqlStream: async () => {
      throw new Error("not used");
    },
  };
}

const serves = (files: Record<string, { sql: string }>) =>
  batched.mockImplementation(
    async (_o: unknown, _r: unknown, entries: Array<{ rel: string }>) =>
      new Map(entries.map((e) => [e.rel, Buffer.from(files[e.rel].sql, "utf8").toString("base64")])),
  );

beforeEach(() => {
  // Braces deliberately: a concise arrow would return `mockReset()`'s value,
  // which is the mock, and vitest calls a function returned from `beforeEach`
  // as that test's teardown — invoking the mock with no arguments.
  batched.mockReset();
});

describe("digestPrimeBodies", () => {
  it("digests every form of a body, so any rung can answer", async () => {
    const files = { a: { sql: "-- h\nSELECT 1;\n" } };
    serves(files);
    const out = await digestPrimeBodies(corpusOf("sha-1", files), ["a"], octokit, ref);
    expect(out.byPath.get("a")).toEqual(migrationBodyForms(files.a.sql).map(sha256Hex));
    expect(out.fetched).toBe(1);
    expect(out.unread).toEqual([]);
  });

  /**
   * The ceiling is the whole reason this pass is affordable. Measured on the
   * prime: the corpus is 536 MB, 531 MB of it is 14 seed generations, and all
   * 16 files over 256 KB are already cleared by their version — so the ceiling
   * withholds nothing today and bounds the pass for ever.
   */
  it("never reads a body past the ceiling, and says so rather than guessing", async () => {
    const files = { big: { sql: "x", size: MAX_DIGEST_BYTES + 1 } };
    serves({ big: { sql: "x" } });
    const out = await digestPrimeBodies(corpusOf("sha-1", files), ["big"], octokit, ref);
    expect(batched).not.toHaveBeenCalled();
    expect(out.byPath.get("big")).toEqual([]);
    expect(out.unread).toEqual(["big"]);
  });

  it("treats an UNKNOWN size as too large, not as small", async () => {
    const files = { u: { sql: "SELECT 1;", size: null } };
    serves(files);
    const out = await digestPrimeBodies(corpusOf("sha-1", files), ["u"], octokit, ref);
    expect(batched).not.toHaveBeenCalled();
    expect(out.unread).toEqual(["u"]);
  });

  /**
   * A GitHub outage degrades the fleet sync to exactly the behaviour it had
   * before bodies were read — the version match alone — and never to a wider
   * corpus or a thrown pass.
   */
  it("answers 'not read' when GitHub will not serve, and does not throw", async () => {
    const files = { a: { sql: "SELECT 1;" } };
    batched.mockRejectedValue(new Error("502 bad gateway"));
    // Its own commit: the cache is keyed on one, and an earlier test in this
    // file already digested `a` at sha-1.
    const out = await digestPrimeBodies(corpusOf("sha-outage", files), ["a"], octokit, ref);
    expect(out.byPath.get("a")).toEqual([]);
    expect(out.unread).toEqual(["a"]);
  });

  it("does not cache a failure, so a blip costs one tick and not every tick", async () => {
    const files = { a: { sql: "SELECT 1;" } };
    batched.mockRejectedValueOnce(new Error("502"));
    const corpus = corpusOf("sha-blip", files);
    expect((await digestPrimeBodies(corpus, ["a"], octokit, ref)).unread).toEqual(["a"]);
    serves(files);
    expect((await digestPrimeBodies(corpus, ["a"], octokit, ref)).unread).toEqual([]);
  });

  it("reuses what it digested at the same commit, so a level fleet pays nothing", async () => {
    const files = { a: { sql: "SELECT 1;" }, b: { sql: "SELECT 2;" } };
    serves(files);
    const corpus = corpusOf("sha-warm", files);
    const first = await digestPrimeBodies(corpus, ["a", "b"], octokit, ref);
    expect(first.fetched).toBe(2);
    const second = await digestPrimeBodies(corpus, ["a", "b"], octokit, ref);
    expect(second.fetched).toBe(0);
    expect(second.byPath.get("a")).toEqual(first.byPath.get("a"));
  });

  it("asks again when the prime's head moves, because the bytes may have", async () => {
    const before = { a: { sql: "SELECT 1;" } };
    serves(before);
    expect((await digestPrimeBodies(corpusOf("sha-old", before), ["a"], octokit, ref)).fetched).toBe(
      1,
    );
    const after = { a: { sql: "SELECT 2;" } };
    serves(after);
    const out = await digestPrimeBodies(corpusOf("sha-new", after), ["a"], octokit, ref);
    expect(out.fetched).toBe(1);
    expect(out.byPath.get("a")).toEqual(bodyDigests("SELECT 2;"));
  });

  /**
   * Ids collide in this corpus — 77 files share a version with another — so a
   * caller can hand the same path twice and a naive pass would put one blob in
   * the batch twice and count it twice.
   */
  it("asks for a body once however many times it is named", async () => {
    const files = { a: { sql: "SELECT 1;" } };
    serves(files);
    const out = await digestPrimeBodies(corpusOf("sha-dupe", files), ["a", "a"], octokit, ref);
    const asked = batched.mock.calls[0][2] as Array<{ rel: string }>;
    expect(asked.map((e) => e.rel)).toEqual(["a"]);
    expect(out.fetched).toBe(1);
  });

  it("carries an id the corpus does not hold as unread rather than throwing", async () => {
    const files = { a: { sql: "SELECT 1;" } };
    serves(files);
    const out = await digestPrimeBodies(corpusOf("sha-1", files), ["ghost"], octokit, ref);
    expect(out.unread).toEqual(["ghost"]);
    expect(batched).not.toHaveBeenCalled();
  });
});
