/**
 * One call carries a hundred files, or the window carries the fleet.
 *
 * Measured 16 Sep 2026, 12:24–13:25: per-file `createBlob` on a backfill
 * cascade (~830 text files) spent a third of the App installation's
 * 5,000/hour window PER CLONE — one window synced one clone, the second
 * was cut mid-push, the third never started, and the fleet read as stuck
 * while it sat "Deferred until…" for forty minutes an hour. Text now
 * travels inline in a chunked `createTree` chain; these pin the chunking
 * and the engine's wiring of it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TREE_CHUNK_MAX_CONTENT_BYTES,
  TREE_CHUNK_MAX_ENTRIES,
  chunkTreeEntries,
  toGitTreeParam,
  type DeliveryTreeEntry,
} from "./treeDelivery.pure";

const text = (path: string, content: string): DeliveryTreeEntry => ({
  path,
  mode: "100644",
  type: "blob",
  content,
});
const blob = (path: string, sha: string | null): DeliveryTreeEntry => ({
  path,
  mode: "100644",
  type: "blob",
  sha,
});

describe("chunkTreeEntries", () => {
  it("splits by entry count, preserving order and losing nothing", () => {
    const entries = Array.from({ length: 301 }, (_, i) => text(`src/f${i}.ts`, "x"));
    const chunks = chunkTreeEntries(entries, 120, TREE_CHUNK_MAX_CONTENT_BYTES);
    expect(chunks.map((c) => c.length)).toEqual([120, 120, 61]);
    expect(chunks.flat().map((e) => e.path)).toEqual(entries.map((e) => e.path));
  });

  it("splits by content bytes — a chunk's request body stays bounded", () => {
    const big = "y".repeat(900_000);
    const chunks = chunkTreeEntries(
      [text("a.ts", big), text("b.ts", big), text("c.ts", big)],
      120,
      2_000_000,
    );
    expect(chunks.map((c) => c.map((e) => e.path))).toEqual([["a.ts", "b.ts"], ["c.ts"]]);
  });

  it("an entry larger than the byte bound rides alone rather than being refused", () => {
    const chunks = chunkTreeEntries(
      [text("small.ts", "x"), text("huge.ts", "z".repeat(3_000_000)), text("tail.ts", "x")],
      120,
      2_000_000,
    );
    expect(chunks.map((c) => c.map((e) => e.path))).toEqual([
      ["small.ts"],
      ["huge.ts"],
      ["tail.ts"],
    ]);
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });

  it("sha and deletion entries cost no bytes — the whole deletion set fits few chunks", () => {
    const deletions = Array.from({ length: 119 }, (_, i) => blob(`gone/${i}.ts`, null));
    const chunks = chunkTreeEntries([...deletions, blob("bin/logo.png", "a".repeat(40))], 120, 10);
    expect(chunks).toHaveLength(1);
  });

  it("empty in, empty out — never an empty chunk", () => {
    expect(chunkTreeEntries([])).toEqual([]);
  });

  it("bytes are measured in UTF-8, not code units", () => {
    // Two 3-byte characters overflow a 5-byte bound even at length 2.
    const chunks = chunkTreeEntries([text("a.ts", "€"), text("b.ts", "€")], 120, 5);
    expect(chunks).toHaveLength(2);
  });
});

describe("toGitTreeParam", () => {
  it("never carries both sha and content, and a deletion stays sha: null", () => {
    expect(toGitTreeParam(text("a.ts", "hi"))).toEqual({
      path: "a.ts",
      mode: "100644",
      type: "blob",
      content: "hi",
    });
    expect(toGitTreeParam(blob("b.png", "s".repeat(40)))).toEqual({
      path: "b.png",
      mode: "100644",
      type: "blob",
      sha: "s".repeat(40),
    });
    expect(toGitTreeParam(blob("gone.ts", null))).toEqual({
      path: "gone.ts",
      mode: "100644",
      type: "blob",
      sha: null,
    });
  });

  it("the default bounds are what the engine ships with", () => {
    expect(TREE_CHUNK_MAX_ENTRIES).toBe(120);
    expect(TREE_CHUNK_MAX_CONTENT_BYTES).toBe(2_000_000);
  });
});

describe("the engine delivers text inline and chains the tree", () => {
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");

  it("a text file buys no blob — it returns inline content instead", () => {
    const at = engine.indexOf("if (!dryRun && !primeFile.binary) {");
    expect(at).toBeGreaterThan(-1);
    const end = engine.indexOf("const blobSha", at);
    expect(end).toBeGreaterThan(at);
    const branch = engine.slice(at, end);
    expect(branch).toContain("inline: primeFile.content,");
    expect(branch).not.toContain("createBlob");
  });

  it("only a real uploaded blob is ledgered — never a stand-in, never inline text", () => {
    /* Reuse (`resumableBlobs`) exists to save the per-file upload; inline
       text costs one call per ~hundred files, so ledgering it would grow
       the row for nothing. */
    expect(engine).toContain("if (resume && !dryRun) {");
  });

  it("the tree is a chunked chain over base_tree, ending in the sha the commit uses", () => {
    const at = engine.indexOf("let chainedTreeSha = cloneCommit.tree.sha;");
    expect(at).toBeGreaterThan(-1);
    const chain = engine.slice(at, at + 700);
    expect(chain).toContain("for (const chunk of chunkTreeEntries(treeEntries))");
    expect(chain).toContain("base_tree: chainedTreeSha,");
    expect(chain).toContain("tree: chunk.map(toGitTreeParam),");
    expect(chain).toContain("chainedTreeSha = chunkTree.sha;");
    expect(chain).toContain("const newTree = { sha: chainedTreeSha };");
  });

  it("a deletion is still marked by sha === null wherever the proposal narrates it", () => {
    // Inline entries carry no `sha` at all, so `t.sha === null` stays a
    // deletion test and an inline write is never narrated as a removal.
    expect(engine).toContain('`- ${t.sha === null ? "DELETE " : ""}${t.path}`');
  });
});
