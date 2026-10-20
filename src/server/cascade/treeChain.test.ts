import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeTreePause,
  readTreeChain,
  resumableTreeChain,
  treeChainGrew,
  treeChainKey,
  writeTreeChain,
  type TreeChainProgress,
} from "./treeChain.pure";
import { chunkTreeEntries, type DeliveryTreeEntry } from "./treeDelivery.pure";
import { ledgerGrew, readProgress, type CascadeProgress } from "./passProgress.pure";

const BASE = "a".repeat(40);
const OTHER_BASE = "b".repeat(40);

function delivery(files: number, text = "export const x = 1;\n"): DeliveryTreeEntry[] {
  return Array.from({ length: files }, (_, i) => ({
    path: `src/file-${String(i).padStart(4, "0")}.ts`,
    mode: "100644" as const,
    type: "blob" as const,
    content: `${text}// ${i}\n`,
  }));
}

/** A fake GitHub: a tree's SHA is a function of its base and its chunk. */
function fakeTrees() {
  const made = new Map<string, number>();
  let calls = 0;
  const createTree = async (base: string, chunk: ReadonlyArray<DeliveryTreeEntry>) => {
    calls += 1;
    const sha = treeChainKey(base, [chunk]).slice(0, 40);
    made.set(sha, (made.get(sha) ?? 0) + 1);
    return sha;
  };
  return { createTree, made, calls: () => calls };
}

describe("what a chain is of", () => {
  const chunks = chunkTreeEntries(delivery(300));

  it("is the same key for the same base and the same chunks", () => {
    expect(treeChainKey(BASE, chunks)).toBe(treeChainKey(BASE, chunkTreeEntries(delivery(300))));
    expect(treeChainKey(BASE, chunks)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is a different key for a different base, entry, text or boundary", () => {
    const key = treeChainKey(BASE, chunks);
    expect(treeChainKey(OTHER_BASE, chunks)).not.toBe(key);
    const edited = delivery(300);
    edited[150] = { ...edited[150], content: "export const x = 2;\n" };
    expect(treeChainKey(BASE, chunkTreeEntries(edited))).not.toBe(key);
    const deleted = delivery(300);
    deleted[0] = { path: deleted[0].path, mode: "100644", type: "blob", sha: null };
    expect(treeChainKey(BASE, chunkTreeEntries(deleted))).not.toBe(key);
    expect(treeChainKey(BASE, chunkTreeEntries(delivery(300), 100))).not.toBe(key);
  });
});

describe("a kept chain is read strictly and resumed only by the same chain", () => {
  const kept: TreeChainProgress = { key: "c".repeat(64), done: 3, of: 10, sha: "d".repeat(40) };

  it("reads what it wrote and drops what it could not have written", () => {
    expect(readTreeChain(kept)).toEqual(kept);
    for (const bad of [
      null,
      [],
      { ...kept, key: "short" },
      { ...kept, sha: "not-a-sha" },
      { ...kept, done: 0 },
      { ...kept, done: 1.5 },
      { ...kept, of: 2 },
    ]) {
      expect(readTreeChain(bad)).toBeNull();
    }
  });

  it("resumes only the same key at the same length", () => {
    expect(resumableTreeChain(kept, kept.key, 10)).toEqual({ done: 3, sha: kept.sha });
    expect(resumableTreeChain(kept, "e".repeat(64), 10)).toBeNull();
    expect(resumableTreeChain(kept, kept.key, 11)).toBeNull();
    expect(resumableTreeChain(null, kept.key, 10)).toBeNull();
  });

  it("counts a chain that moved as progress kept, and one that stood still as none", () => {
    expect(treeChainGrew(undefined, kept)).toBe(true);
    expect(treeChainGrew(kept, { ...kept, done: 4 })).toBe(true);
    expect(treeChainGrew(kept, { ...kept, key: "f".repeat(64), done: 1 })).toBe(true);
    expect(treeChainGrew(kept, kept)).toBe(false);
    expect(treeChainGrew(kept, undefined)).toBe(false);
  });

  it("rides the pass ledger: kept by readProgress, dropped alone, and counted by ledgerGrew", () => {
    const record: CascadeProgress = {
      version: 1,
      source_sha: "1".repeat(40),
      prepared: { "a.png": { blob: "2".repeat(40), prime: "3".repeat(40) } },
      total: 5,
      tree_chain: kept,
    };
    const read = readProgress(JSON.parse(JSON.stringify(record)));
    expect(read?.tree_chain).toEqual(kept);
    const damaged = readProgress({ ...record, tree_chain: { ...kept, sha: "nope" } });
    expect(damaged?.tree_chain).toBeUndefined();
    expect(damaged?.prepared["a.png"]).toEqual(record.prepared["a.png"]);
    expect(ledgerGrew(read, { ...record, tree_chain: { ...kept, done: 5 } })).toBe(true);
    expect(ledgerGrew(read, record)).toBe(false);
  });

  it("says where the write stopped", () => {
    expect(describeTreePause({ done: 4, of: 10, files: 1109 })).toBe(
      "Paused at the invocation budget — tree written for 4 of 10 chunk(s) of 1109 file(s); the rest resume next tick",
    );
    expect(describeTreePause({ done: 10, of: 10, files: 1109 })).toBe(
      "Paused at the invocation budget — the tree for 1109 file(s) is written; the commit and pull request resume next tick",
    );
  });
});

describe("writing the chain", () => {
  /** A pass clock: `startMs` already spent before the tree, `chunkMs` per call. */
  function passClock(startMs: number, chunkMs: number, deadlineMs = 45_000) {
    let t = startMs;
    return {
      now: () => t,
      advance: () => {
        t += chunkMs;
      },
      isPastDeadline: (reserveMs: number) => t + reserveMs >= deadlineMs,
    };
  }

  it("is unchanged where the window allows it all", async () => {
    const chunks = chunkTreeEntries(delivery(250));
    const trees = fakeTrees();
    const out = await writeTreeChain({
      chunks,
      baseTreeSha: BASE,
      resumed: null,
      createTree: trees.createTree,
      isStaleObject: () => false,
    });
    expect(out.kind).toBe("written");
    expect(out.written).toBe(chunks.length);
    expect(trees.calls()).toBe(chunks.length);
  });

  it("delivers ~1,100 files across passes where one pass could never write them", async () => {
    // The 20 Oct 2026 trace of Preflight's refresh: ~28 s before the tree,
    // ~27 s in it, and the hook abandoned at 60 s.
    const chunks = chunkTreeEntries(delivery(1109));
    expect(chunks.length).toBe(10);
    const perChunkMs = Math.ceil(27_000 / chunks.length);
    const trees = fakeTrees();
    let kept: { done: number; sha: string } | null = null;
    let passes = 0;
    let finalSha: string | null = null;
    while (finalSha === null) {
      passes += 1;
      expect(passes).toBeLessThan(10);
      const clock = passClock(28_000, perChunkMs);
      const out = await writeTreeChain({
        chunks,
        baseTreeSha: BASE,
        resumed: kept,
        createTree: async (base, chunk) => {
          const sha = await trees.createTree(base, chunk);
          clock.advance();
          return sha;
        },
        isPastDeadline: clock.isPastDeadline,
        isStaleObject: () => false,
        now: clock.now,
      });
      expect(out.written).toBeGreaterThan(0);
      expect(clock.now()).toBeLessThan(60_000);
      if (out.kind === "paused") kept = { done: out.done, sha: out.sha };
      else finalSha = out.sha;
    }
    // The same tree a single uninterrupted chain writes.
    const single = await writeTreeChain({
      chunks,
      baseTreeSha: BASE,
      resumed: null,
      createTree: fakeTrees().createTree,
      isStaleObject: () => false,
    });
    expect(finalSha).toBe(single.sha);
    expect(passes).toBeGreaterThan(1);
  });

  it("writes this pass's first chunk even when the window is already spent", async () => {
    const chunks = chunkTreeEntries(delivery(400));
    const trees = fakeTrees();
    const out = await writeTreeChain({
      chunks,
      baseTreeSha: BASE,
      resumed: null,
      createTree: trees.createTree,
      isPastDeadline: () => true,
      isStaleObject: () => false,
    });
    expect(out).toMatchObject({ kind: "paused", done: 1, written: 1 });
  });

  it("goes straight to the commit from a finished chain, whatever the clock says", async () => {
    const chunks = chunkTreeEntries(delivery(240));
    const trees = fakeTrees();
    const out = await writeTreeChain({
      chunks,
      baseTreeSha: BASE,
      resumed: { done: chunks.length, sha: "9".repeat(40) },
      createTree: trees.createTree,
      isPastDeadline: () => true,
      isStaleObject: () => false,
    });
    expect(out).toEqual({ kind: "written", sha: "9".repeat(40), written: 0 });
    expect(trees.calls()).toBe(0);
  });

  it("starts again from the clone's tree when a kept chain was collected", async () => {
    const chunks = chunkTreeEntries(delivery(240));
    const trees = fakeTrees();
    const collected = "8".repeat(40);
    const out = await writeTreeChain({
      chunks,
      baseTreeSha: BASE,
      resumed: { done: 1, sha: collected },
      createTree: async (base, chunk) => {
        if (base === collected)
          throw Object.assign(new Error("tree sha not found"), { status: 422 });
        return trees.createTree(base, chunk);
      },
      isStaleObject: (e) => (e as { status?: number }).status === 422,
    });
    const fresh = await writeTreeChain({
      chunks,
      baseTreeSha: BASE,
      resumed: null,
      createTree: fakeTrees().createTree,
      isStaleObject: () => false,
    });
    expect(out).toEqual({ kind: "written", sha: fresh.sha, written: chunks.length });
  });

  it("leaves every other failure to the caller", async () => {
    const chunks = chunkTreeEntries(delivery(240));
    await expect(
      writeTreeChain({
        chunks,
        baseTreeSha: BASE,
        resumed: { done: 1, sha: "8".repeat(40) },
        createTree: async () => {
          throw Object.assign(new Error("API rate limit exceeded"), { status: 403 });
        },
        isStaleObject: (e) => (e as { status?: number }).status === 422,
      }),
    ).rejects.toThrow("API rate limit exceeded");
  });
});

describe("the wiring", () => {
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
  const at = engine.indexOf('markPhase("tree");');
  const block = engine.slice(at, engine.indexOf('markPhase("proposal");', at));

  it("writes the delivery through the chain, resuming only the same chain", () => {
    expect(at).toBeGreaterThan(-1);
    expect(block).toContain("const chainKey = treeChainKey(cloneCommit.tree.sha, chunks);");
    expect(block).toContain("await writeTreeChain({");
    expect(block).toContain(
      "resumableTreeChain(priorProgress?.tree_chain ?? null, chainKey, chunks.length)",
    );
    expect(block).toContain("isStaleObject: isStaleObjectError,");
    // The old ungated loop is gone.
    expect(block).not.toMatch(/for \(const chunk of chunkTreeEntries\(treeEntries\)\)/);
  });

  it("keeps a paused chain on the ledger and returns before any commit", () => {
    const pause = block.slice(block.indexOf('if (chain.kind === "paused")'));
    expect(pause).toContain("progress.tree_chain = { key: chainKey, done: chain.done");
    expect(pause.indexOf("await resume.onProgress(progress);")).toBeGreaterThan(-1);
    expect(pause).toContain('status: "queued",');
    expect(block).not.toContain("createCommit");
    expect(block).toContain("delete progress.tree_chain;");
    expect(block).toContain("const newTree = { sha: chain.sha };");
  });

  it("carries a kept chain into the pass's ledger before any stage can pause", () => {
    const ledger = engine.slice(engine.indexOf("const progress: CascadeProgress = {"));
    expect(ledger.slice(0, 1_200)).toContain(
      "...(priorProgress?.tree_chain ? { tree_chain: priorProgress.tree_chain } : {}),",
    );
  });
});
