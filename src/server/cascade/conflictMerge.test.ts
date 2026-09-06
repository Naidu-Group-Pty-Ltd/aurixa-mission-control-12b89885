import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_COMMIT_PREFIX } from "./proposalRepair.pure";
import {
  MAX_RESOLUTIONS,
  planResolutionMerge,
  resolutionCommitMessage,
  type PrFile,
  type TreeEntry,
} from "./conflictMerge.pure";

const blob = (path: string, sha = `sha-${path}`, mode = "100644"): TreeEntry => ({
  path,
  mode,
  type: "blob",
  sha,
});
const file = (filename: string, status = "modified", previous_filename?: string): PrFile => ({
  filename,
  status,
  previous_filename: previous_filename ?? null,
});
const tree = (entries: TreeEntry[], truncated = false) => ({ truncated, entries });

describe("planResolutionMerge — the proposal's side stands", () => {
  it("restates every path the pull request touches, from the head's own tree", () => {
    const plan = planResolutionMerge({
      prFiles: [file("src/a.ts"), file("src/b.ts", "added")],
      headTree: tree([blob("src/a.ts"), blob("src/b.ts"), blob("src/untouched.ts")]),
      baseTree: tree([blob("src/a.ts", "base-version"), blob("src/only-in-base.ts")]),
    });
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.entries).toEqual([
      { path: "src/a.ts", mode: "100644", type: "blob", sha: "sha-src/a.ts" },
      { path: "src/b.ts", mode: "100644", type: "blob", sha: "sha-src/b.ts" },
    ]);
    expect(plan.restated).toBe(2);
  });

  it("touches nothing the pull request does not name — the base keeps the rest by construction", () => {
    const plan = planResolutionMerge({
      prFiles: [file("src/a.ts")],
      headTree: tree([blob("src/a.ts"), blob("src/drive-by.ts")]),
      baseTree: tree([blob("src/a.ts"), blob("src/drive-by.ts", "base-newer")]),
    });
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.entries.map((e) => e.path)).toEqual(["src/a.ts"]);
  });

  it("deletes a removed path only where the base still has it", () => {
    const plan = planResolutionMerge({
      prFiles: [file("gone-from-base-too.ts", "removed"), file("still-in-base.ts", "removed")],
      headTree: tree([]),
      baseTree: tree([blob("still-in-base.ts")]),
    });
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.entries).toEqual([
      { path: "still-in-base.ts", mode: "100644", type: "blob", sha: null },
    ]);
    expect(plan.deleted).toBe(1);
  });

  it("carries a rename as a delete of the old path and the head's content at the new one", () => {
    const plan = planResolutionMerge({
      prFiles: [file("src/new.ts", "renamed", "src/old.ts")],
      headTree: tree([blob("src/new.ts")]),
      baseTree: tree([blob("src/old.ts")]),
    });
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.entries).toEqual([
      { path: "src/new.ts", mode: "100644", type: "blob", sha: "sha-src/new.ts" },
      { path: "src/old.ts", mode: "100644", type: "blob", sha: null },
    ]);
  });

  it("keeps the head's executable and symlink modes", () => {
    const plan = planResolutionMerge({
      prFiles: [file("run.sh"), file("link")],
      headTree: tree([blob("run.sh", "s1", "100755"), blob("link", "s2", "120000")]),
      baseTree: tree([]),
    });
    if (!plan.ok) throw new Error(plan.refusal);
    expect(plan.entries.map((e) => e.mode).sort()).toEqual(["100755", "120000"]);
  });

  it("refuses a truncated head tree rather than dropping the paths past the cut", () => {
    const plan = planResolutionMerge({
      prFiles: [file("a.ts")],
      headTree: tree([blob("a.ts")], true),
      baseTree: tree([]),
    });
    expect(plan).toMatchObject({ ok: false, reason: "head_tree_truncated" });
  });

  it("refuses a truncated base tree — deletions cannot be told from absences", () => {
    const plan = planResolutionMerge({
      prFiles: [file("a.ts")],
      headTree: tree([blob("a.ts")]),
      baseTree: tree([], true),
    });
    expect(plan).toMatchObject({ ok: false, reason: "base_tree_truncated" });
  });

  it("refuses a file list past GitHub's own cap — it may be a sample", () => {
    const many = Array.from({ length: 3001 }, (_, i) => file(`f${i}.ts`));
    const plan = planResolutionMerge({
      prFiles: many,
      headTree: tree(many.map((f) => blob(f.filename))),
      baseTree: tree([]),
    });
    expect(plan).toMatchObject({ ok: false, reason: "too_many_files" });
  });

  it("refuses a submodule rather than restating it as a file", () => {
    const plan = planResolutionMerge({
      prFiles: [file("vendored")],
      headTree: tree([{ path: "vendored", mode: "160000", type: "commit", sha: "s" }]),
      baseTree: tree([]),
    });
    expect(plan).toMatchObject({ ok: false, reason: "not_a_blob" });
  });

  it("refuses an inconsistent snapshot — a listed file the head tree lacks", () => {
    const plan = planResolutionMerge({
      prFiles: [file("a.ts")],
      headTree: tree([]),
      baseTree: tree([]),
    });
    expect(plan).toMatchObject({ ok: false, reason: "missing_in_head" });
  });
});

describe("the resolution commit", () => {
  it("never wears the engine's statement prefix — isEngineOnlyBranch must not read it as pristine", () => {
    const message = resolutionCommitMessage({
      prNumber: 98,
      baseShort: "abc1234",
      restated: 375,
      deleted: 2,
    });
    expect(message.startsWith(ENGINE_COMMIT_PREFIX)).toBe(false);
    expect(message).toContain("#98");
    expect(message).toContain("375");
  });

  it("bounds the loop", () => {
    expect(MAX_RESOLUTIONS).toBeGreaterThanOrEqual(2);
    expect(MAX_RESOLUTIONS).toBeLessThanOrEqual(10);
  });
});

describe("the rules the resolution path may never break", () => {
  const server = readFileSync(
    join(process.cwd(), "src/server/cascadeConflictMerge.server.ts"),
    "utf8",
  );
  const drain = readFileSync(join(process.cwd(), "src/server/cascadeMergeDrain.server.ts"), "utf8");

  it("never force-pushes — the resolution is a fast-forward merge commit", () => {
    expect(server).toContain("force: false");
    expect(server).not.toContain("force: true");
  });

  it("parents the merge commit head-first, so the ref update appends history", () => {
    expect(server).toContain("parents: [headSha, baseSha]");
  });

  it("writes only to branches the engine names", () => {
    expect(server).toContain('"aurixa/cascade-"');
  });

  it("is the fall-through, never the first answer: regeneration is consulted first", () => {
    const repairAt = drain.indexOf("repairConflictedProposal(");
    const resolveAt = drain.indexOf("resolveConflictedProposal(");
    expect(repairAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(repairAt);
  });

  it("never closes a pull request to make a conflict disappear", () => {
    expect(server).not.toContain('state: "closed"');
  });

  it("counts an attempt before the push, so a crash still counts", () => {
    const audit = server.indexOf("writeAuditLog");
    const push = server.indexOf("updateRef");
    expect(audit).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(audit);
  });
});
