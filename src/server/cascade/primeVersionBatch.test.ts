import { describe, expect, it } from "vitest";
import { MAX_VERSION_WALK } from "./deletionPropagation.pure";
import {
  planVersionBatches,
  readVersionAnswers,
  VERSION_BATCH_LOOKUPS,
  versionBatchQuery,
  type VersionAsk,
} from "./primeVersionBatch.pure";

/** A syntactically valid object id. */
const id = (n: number) => n.toString(16).padStart(40, "0");

const walkOf = (path: string, n: number, from = 1): VersionAsk => ({
  path,
  commits: Array.from({ length: n }, (_, i) => id(from + i)),
});

const regular = (oid: string, mode = 0o100644) => ({ file: { oid, mode, type: "blob" } });

describe("planVersionBatches", () => {
  it("asks each path once and never splits a walk across two requests", () => {
    const perBatch = VERSION_BATCH_LOOKUPS / MAX_VERSION_WALK;
    const asks = Array.from({ length: perBatch + 1 }, (_, i) =>
      walkOf(`.github/workflows/w${i}.yml`, MAX_VERSION_WALK, i * 100 + 1),
    );
    const batches = planVersionBatches([...asks, asks[0]]);
    expect(batches.map((b) => b.length)).toEqual([perBatch, 1]);
    expect(batches.flat()).toEqual(asks);
    for (const batch of batches) {
      expect(batch.reduce((n, a) => n + a.commits.length, 0)).toBeLessThanOrEqual(
        VERSION_BATCH_LOOKUPS,
      );
    }
  });

  it("packs short walks together up to the lookup bound", () => {
    const asks = Array.from({ length: VERSION_BATCH_LOOKUPS + 1 }, (_, i) =>
      walkOf(`f${i}`, 1, i + 1),
    );
    expect(planVersionBatches(asks).map((b) => b.length)).toEqual([VERSION_BATCH_LOOKUPS, 1]);
  });

  it("leaves out a walk it cannot ask exactly, for its revisions to be read one by one", () => {
    const ok = walkOf("ok", 2);
    const refused: VersionAsk[] = [
      { path: "empty", commits: [] },
      { path: "short-id", commits: [id(1), "abc123"] },
      { path: "upper", commits: [id(1).replace(/0/g, "A")] },
      { path: "inject", commits: [`${"0".repeat(38)}"}`] },
      walkOf("too-long", VERSION_BATCH_LOOKUPS + 1),
    ];
    expect(planVersionBatches([...refused, ok])).toEqual([[ok]]);
  });
});

describe("versionBatchQuery", () => {
  it("asks every commit of every walk, each path a variable and never written in", () => {
    const a = walkOf("src/a.ts", 2, 1);
    const b = walkOf('weird "path" $x.ts', 1, 7);
    const { query, paths } = versionBatchQuery([a, b]);
    expect(query).toMatch(
      /^query\(\$owner: String!, \$repo: String!, \$p0: String!, \$p1: String!\) \{ repository\(owner: \$owner, name: \$repo\)/,
    );
    expect(query).toContain(
      `p0c0: object(oid: "${id(1)}") { ... on Commit { file(path: $p0) { oid mode type } } }`,
    );
    expect(query).toContain(
      `p0c1: object(oid: "${id(2)}") { ... on Commit { file(path: $p0) { oid mode type } } }`,
    );
    expect(query).toContain(
      `p1c0: object(oid: "${id(7)}") { ... on Commit { file(path: $p1) { oid mode type } } }`,
    );
    expect(paths).toEqual({ p0: "src/a.ts", p1: 'weird "path" $x.ts' });
    expect(query).not.toContain("src/a.ts");
    expect(query).not.toContain("weird");
  });

  it("refuses to write anything but a commit id into a query", () => {
    expect(() => versionBatchQuery([{ path: "x", commits: ['deadbeef") { x }'] }])).toThrow(
      /Not a commit id/,
    );
  });
});

describe("readVersionAnswers", () => {
  const ask = walkOf("src/cfg.ts", 3);

  it("takes a regular file's id, executable or not, in the walk's own order", () => {
    const got = readVersionAnswers(
      [ask],
      { p0c0: regular(id(0xa)), p0c1: regular(id(0xb), 0o100755), p0c2: regular(id(0xa)) },
      true,
    );
    expect(got.get("src/cfg.ts")).toEqual([id(0xa), id(0xb), id(0xa)]);
  });

  it("reads 'nothing at this path' from a clean response as the walk always did: no blob there", () => {
    // The removing commit, most often: the contents API's 404 there.
    const got = readVersionAnswers([ask], { p0c0: { file: null }, p0c1: regular(id(0xb)) }, true);
    expect(got.get("src/cfg.ts")).toEqual([null, id(0xb), undefined]);
  });

  it("does not take 'nothing here' from a response that carried errors", () => {
    // A field nulled beside an error says nothing about the path. A real id
    // in the same response is still an id.
    const got = readVersionAnswers([ask], { p0c0: { file: null }, p0c1: regular(id(0xb)) }, false);
    expect(got.get("src/cfg.ts")).toEqual([undefined, id(0xb), undefined]);
  });

  it("leaves a link, a submodule and a directory to the per-revision read", () => {
    // The contents API answers a link with the file it names, a submodule
    // with the commit it pins and a directory with a listing, so the id of
    // the entry itself is not what the walk has always compared.
    const got = readVersionAnswers(
      [ask],
      {
        p0c0: { file: { oid: id(1), mode: 0o120000, type: "blob" } },
        p0c1: { file: { oid: id(2), mode: 0o160000, type: "commit" } },
        p0c2: { file: { oid: id(3), mode: 0o040000, type: "tree" } },
      },
      true,
    );
    expect(got.get("src/cfg.ts")).toEqual([undefined, undefined, undefined]);
  });

  it("treats anything it cannot vouch for as unanswered", () => {
    for (const node of [
      undefined,
      null,
      {},
      { file: "x" },
      { file: { oid: id(1), mode: "100644", type: "blob" } },
      { file: { oid: id(1), type: "blob" } },
      { file: { oid: "not-an-id", mode: 0o100644, type: "blob" } },
      { file: { oid: id(1).toUpperCase().replace(/0/g, "F"), mode: 0o100644, type: "blob" } },
    ]) {
      const got = readVersionAnswers([walkOf("p", 1)], { p0c0: node }, true);
      expect(got.get("p")).toEqual([undefined]);
    }
  });

  it("answers nothing from a response with no repository", () => {
    for (const repository of [null, undefined, "x", 3]) {
      expect(readVersionAnswers([ask], repository, true).get("src/cfg.ts")).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
  });

  it("matches answers to walks by position, never by what they contain", () => {
    const two = [walkOf("a", 1, 1), walkOf("b", 1, 2)];
    const got = readVersionAnswers(two, { p0c0: regular(id(0xb)), p1c0: regular(id(0xa)) }, true);
    expect(got.get("a")).toEqual([id(0xb)]);
    expect(got.get("b")).toEqual([id(0xa)]);
  });
});
