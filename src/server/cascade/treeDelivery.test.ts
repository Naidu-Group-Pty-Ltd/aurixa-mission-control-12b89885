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
import { stripComments } from "@/server/sourceComments.pure";
import {
  TREE_CHUNK_MAX_CONTENT_BYTES,
  TREE_CHUNK_MAX_ENTRIES,
  canonicalDeliveryOrder,
  chunkTreeEntries,
  deliveryModeFor,
  differsFromPrime,
  executableBitDiffers,
  isSymbolicLink,
  toGitTreeParam,
  withDeliveryModes,
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

describe("canonicalDeliveryOrder", () => {
  it("sorts by path, compared as code units rather than by locale", () => {
    const entries = [
      text("src/b.ts", "b"),
      text("src/B.ts", "B"),
      blob("mobile/api.json", "a".repeat(40)),
      text("src/a.ts", "a"),
      text(".github/x.yml", "x"),
    ];
    expect(canonicalDeliveryOrder(entries).map((e) => e.path)).toEqual([
      ".github/x.yml",
      "mobile/api.json",
      "src/B.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("is stable, so two entries for one path keep the order they were written in", () => {
    const first = text("src/a.ts", "first");
    const second = text("src/a.ts", "second");
    const ordered = canonicalDeliveryOrder([text("src/z.ts", "z"), first, second]);
    expect(ordered.slice(0, 2)).toEqual([first, second]);
  });

  it("leaves the delivery it was handed as it was", () => {
    const entries = [text("b.ts", "b"), text("a.ts", "a")];
    canonicalDeliveryOrder(entries);
    expect(entries.map((e) => e.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("puts a removed file before anything written beneath its path", () => {
    const ordered = canonicalDeliveryOrder([text("docs/x/y.md", "y"), blob("docs/x", null)]);
    expect(ordered.map((e) => e.path)).toEqual(["docs/x", "docs/x/y.md"]);
  });

  it("cuts the same chunks from any order of the same delivery", () => {
    const entries = Array.from({ length: 301 }, (_, i) =>
      text(`src/f${String(i).padStart(3, "0")}.ts`, "x"),
    );
    const reversed = [...entries].reverse();
    expect(chunkTreeEntries(canonicalDeliveryOrder(reversed))).toEqual(
      chunkTreeEntries(canonicalDeliveryOrder(entries)),
    );
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
    // Since F25 the chain is `writeTreeChain` (treeChain.pure.ts), which layers
    // each chunk over the previous call's tree and is held to that, and to
    // ending where one uninterrupted chain ends, in treeChain.test.ts. The
    // engine supplies the chunks and the call.
    const at = engine.indexOf("const chunks = chunkTreeEntries(\n    canonicalDeliveryOrder(");
    expect(at).toBeGreaterThan(-1);
    const chain = engine.slice(at, at + 1_200);
    expect(chain).toContain("baseTreeSha: cloneCommit.tree.sha,");
    expect(chain).toContain("base_tree: baseTree,");
    expect(chain).toContain("tree: chunk.map(toGitTreeParam),");
    expect(chain).toContain(").data.sha,");
    expect(engine).toContain("const newTree = { sha: chain.sha };");
  });

  it("a deletion is still marked by sha === null wherever the proposal narrates it", () => {
    // Inline entries carry no `sha` at all, so `t.sha === null` stays a
    // deletion test and an inline write is never narrated as a removal.
    expect(engine).toContain('`- ${t.sha === null ? "DELETE " : ""}${t.path}`');
  });
});

describe("a delivery writes the prime's own mode", () => {
  // Measured 27 Oct 2026: cascades took the executable bit off two scripts on
  // `npc-crm-independent-6505dc` (27 and 28 Sep), and the three mirrors each
  // held 16 of the prime's executable scripts as plain files until a hand sync.
  const prime = new Map([
    ["scripts/run.sh", "100755"],
    ["src/a.ts", "100644"],
    ["docs/link", "120000"],
  ]);
  const clone = new Map([
    ["scripts/run.sh", "100644"],
    ["scripts/clone-own.sh", "100755"],
    ["src/a.ts", "100644"],
  ]);

  it("is the prime's where the prime gives one, executable included", () => {
    expect(deliveryModeFor("scripts/run.sh", prime, clone)).toBe("100755");
    expect(deliveryModeFor("src/a.ts", prime, clone)).toBe("100644");
    // An executable on the clone the prime holds as a plain file is the prime's to decide.
    expect(deliveryModeFor("src/a.ts", prime, new Map([["src/a.ts", "100755"]]))).toBe("100644");
  });

  it("keeps the clone's executable bit where the prime gives no mode, and is plain otherwise", () => {
    // A composed file at a path the prime does not hold, or a listing not read.
    expect(deliveryModeFor("scripts/clone-own.sh", prime, clone)).toBe("100755");
    expect(deliveryModeFor("scripts/clone-own.sh", null, clone)).toBe("100755");
    expect(deliveryModeFor("supabase/config.toml", prime, clone)).toBe("100644");
    expect(deliveryModeFor("anything", null, null)).toBe("100644");
    // A link is never written as one; the engine holds it before this is asked.
    expect(deliveryModeFor("docs/link", prime, null)).toBe("100644");
  });

  it("is applied to every written entry in one place, and leaves a deletion as it was", () => {
    const entries: DeliveryTreeEntry[] = [
      text("scripts/run.sh", "#!/bin/sh\n"),
      blob("src/a.ts", "s1"),
      blob("gone.sh", null),
    ];
    const out = withDeliveryModes(entries, prime, clone);
    expect(out.map((e) => [e.path, e.mode])).toEqual([
      ["scripts/run.sh", "100755"],
      ["src/a.ts", "100644"],
      ["gone.sh", "100644"],
    ]);
    expect(out[2]).toBe(entries[2]);
    expect(toGitTreeParam(out[0])).toEqual({
      path: "scripts/run.sh",
      mode: "100755",
      type: "blob",
      content: "#!/bin/sh\n",
    });
    // The input is not changed under the caller.
    expect(entries[0].mode).toBe("100644");
  });

  it("tells a changed blob or a changed executable bit from a file that is the prime's", () => {
    const p = {
      entries: new Map([
        ["run.sh", "S1"],
        ["a.ts", "A1"],
      ]),
      modes: prime,
    };
    const sameBits = {
      entries: new Map([
        ["run.sh", "S1"],
        ["a.ts", "A1"],
      ]),
      modes: new Map([
        ["run.sh", "100755"],
        ["a.ts", "100644"],
      ]),
    };
    expect(
      differsFromPrime("run.sh", { ...p, modes: new Map([["run.sh", "100755"]]) }, sameBits),
    ).toBe(false);
    // The same bytes without the bit: a prime commit that only made it executable.
    expect(
      differsFromPrime(
        "run.sh",
        { ...p, modes: new Map([["run.sh", "100755"]]) },
        { ...sameBits, modes: new Map([["run.sh", "100644"]]) },
      ),
    ).toBe(true);
    expect(differsFromPrime("a.ts", p, { ...sameBits, entries: new Map([["a.ts", "A2"]]) })).toBe(
      true,
    );
    // A mode either listing does not give is not a difference.
    expect(executableBitDiffers("run.sh", null, new Map([["run.sh", "100644"]]))).toBe(false);
    expect(executableBitDiffers("run.sh", new Map([["run.sh", "100755"]]), new Map())).toBe(false);
    expect(executableBitDiffers("docs/link", prime, new Map([["docs/link", "100644"]]))).toBe(
      false,
    );
  });

  it("names a symbolic link on the prime", () => {
    expect(isSymbolicLink("docs/link", prime)).toBe(true);
    expect(isSymbolicLink("scripts/run.sh", prime)).toBe(false);
    expect(isSymbolicLink("docs/link", null)).toBe(false);
  });
});

describe("the engine asks the mode rule wherever it asks whether a file differs", () => {
  const code = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("cuts its tree chain from the delivery at the prime's modes", () => {
    expect(code).toContain(
      "canonicalDeliveryOrder(withDeliveryModes(treeEntries, primeModeByPath, cloneModeByPath)),",
    );
    // The chain is the only place the delivery is written from.
    expect(code.match(/chunkTreeEntries\(/g)).toHaveLength(1);
  });

  it("forms both scopes' candidates with the mode as well as the blob", () => {
    expect(code.match(/differsFromPrime\(path, primeTree, cloneTree\)/g)).toHaveLength(2);
    expect(code).not.toContain(
      "if (cloneTree.entries.get(path) !== sha) candidatePaths.push(path);",
    );
  });

  it("does not skip a file whose bytes match while its executable bit does not", () => {
    const at = code.indexOf("if (\n        cloneShaByPath.get(path) === primeFile.sha &&");
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 200)).toContain(
      "!executableBitDiffers(path, primeModeByPath, cloneModeByPath)",
    );
    expect(code).not.toContain("if (cloneShaByPath.get(path) === primeFile.sha) return null;");
  });

  it("holds a symbolic link before it reads it", () => {
    const prepare = code.slice(code.indexOf("const prepareOne = async (path: string)"));
    const hold = prepare.indexOf("if (isSymbolicLink(path, primeModeByPath)) {");
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(prepare.indexOf("filesRead += 1;"));
  });
});
