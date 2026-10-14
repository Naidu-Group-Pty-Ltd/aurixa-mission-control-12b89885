import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { MAX_AGREEING_BASES } from "./variantMerge.pure";
import { mergeHeldVariant } from "./variantMergeRead.server";

/**
 * The reads behind a held variant's merge, against a fake GitHub that serves
 * one path at named refs and records every request. What is pinned is what
 * the pure verdict cannot see: how many bases a reconcile's names turn into,
 * and what is never asked for.
 */
const lines = (...xs: string[]) => xs.join("\n") + "\n";
/** Nine lines; changes two apart are separate hunks, adjacent ones are one. */
const nine = (over: Record<number, string> = {}) =>
  lines(...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((x, i) => over[i + 1] ?? x));
const PATH = "src/lib/agent.ts";
const X = "a".repeat(40);
const Y = "b".repeat(40);

function fakeGithub(args: {
  message: string;
  /** Short name (as the commit message writes it) → full SHA. */
  resolves: Record<string, string>;
  /** Ref (a full SHA, "clone-head" or "main") → the file's text there. */
  files: Record<string, string>;
}) {
  const calls: string[] = [];
  const octokit = {
    repos: {
      listCommits: async () => {
        calls.push("listCommits");
        return { data: [{ sha: "c2c2c2c2c2", commit: { message: args.message } }] };
      },
      getCommit: async ({ ref }: { ref: string }) => {
        calls.push(`getCommit ${ref}`);
        const sha = args.resolves[ref];
        if (!sha) throw Object.assign(new Error("No commit found"), { status: 422 });
        return { data: { sha } };
      },
      getContent: async ({ ref }: { ref: string }) => {
        calls.push(`getContent ${ref}`);
        const text = args.files[ref];
        if (text === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        const content = Buffer.from(text, "utf8").toString("base64");
        return {
          data: {
            type: "file",
            sha: `blob-${ref}`,
            content,
            encoding: "base64",
            size: text.length,
          },
        };
      },
    },
  } as unknown as Octokit;
  return { octokit, calls };
}

const merge = (octokit: Octokit, revisions?: Map<string, string>) =>
  mergeHeldVariant({
    octokit,
    cloneRef: { owner: "o", repo: "clone", branch: "clone-head" },
    primeRef: { owner: "o", repo: "prime", branch: "main" },
    path: PATH,
    maxBytes: 1_000_000,
    revisions,
  });

describe("a reconcile naming several prime revisions", () => {
  it("merges against each and writes when they agree", async () => {
    const { octokit, calls } = fakeGithub({
      message: "Land the cascades at prime@aaaaaaa and prime@bbbbbbb",
      resolves: { aaaaaaa: X, bbbbbbb: Y },
      files: {
        [X]: nine(),
        [Y]: nine({ 5: "5y" }),
        "clone-head": nine({ 2: "2o", 5: "5y" }),
        main: nine({ 5: "5y", 8: "8t" }),
      },
    });
    const v = await merge(octokit);
    expect(v).toMatchObject({ act: "write", text: nine({ 2: "2o", 5: "5y", 8: "8t" }), base: X });
    expect(calls.filter((c) => c.startsWith("getContent"))).toHaveLength(4);
  });

  it("holds when the merges disagree, and the hold is an answer, not a transient", async () => {
    const { octokit } = fakeGithub({
      message: "Land the cascades at prime@aaaaaaa and prime@bbbbbbb",
      resolves: { aaaaaaa: X, bbbbbbb: Y },
      files: {
        [X]: nine(),
        [Y]: nine({ 5: "5y" }),
        "clone-head": nine({ 2: "2o" }),
        main: nine({ 5: "5y" }),
      },
    });
    const v = await merge(octokit);
    expect(v.act).toBe("hold");
    if (v.act === "hold") {
      expect(v.why).toContain("different result");
      expect(v.transient).toBeUndefined();
    }
  });

  it("reads two names for one commit as one base", async () => {
    const { octokit, calls } = fakeGithub({
      message: "Land prime@aaaaaaa (prime@aaaaaaaaaaaa in full)",
      resolves: { aaaaaaa: X, aaaaaaaaaaaa: X },
      files: {
        [X]: nine(),
        "clone-head": nine({ 2: "2o" }),
        main: nine({ 8: "8t" }),
      },
    });
    const v = await merge(octokit);
    expect(v).toMatchObject({ act: "write", text: nine({ 2: "2o", 8: "8t" }), base: X });
    // Both names resolved, but the base read once.
    expect(calls.filter((c) => c === `getContent ${X}`)).toHaveLength(1);
  });

  it(`refuses more than ${MAX_AGREEING_BASES} names before spending a request on them`, async () => {
    const names = ["aaaaaaa", "bbbbbbb", "ccccccc", "ddddddd"].slice(0, MAX_AGREEING_BASES + 1);
    const { octokit, calls } = fakeGithub({
      message: `Land ${names.map((n) => `prime@${n}`).join(", ")}`,
      resolves: {},
      files: {},
    });
    const v = await merge(octokit);
    expect(v.act).toBe("hold");
    expect(calls).toEqual(["listCommits"]);
  });

  it("holds as transient when a name cannot be resolved for a reason a retry could change", async () => {
    const { octokit } = fakeGithub({
      message: "Land the cascades at prime@aaaaaaa and prime@bbbbbbb",
      resolves: { aaaaaaa: X, bbbbbbb: Y },
      files: {},
    });
    (octokit.repos as unknown as { getCommit: unknown }).getCommit = async () => {
      throw Object.assign(new Error("Server Error"), { status: 502 });
    };
    const v = await merge(octokit);
    expect(v).toMatchObject({ act: "hold", transient: true });
  });

  it("uses the pass's cache, and fills it, for every name", async () => {
    const { octokit, calls } = fakeGithub({
      message: "Land the cascades at prime@aaaaaaa and prime@bbbbbbb",
      resolves: { bbbbbbb: Y },
      files: {
        [X]: lines("a"),
        [Y]: lines("a"),
        "clone-head": lines("a"),
        main: lines("a"),
      },
    });
    const revisions = new Map([["aaaaaaa", X]]);
    const v = await merge(octokit, revisions);
    expect(v.act).toBe("current");
    expect(calls.filter((c) => c.startsWith("getCommit"))).toEqual(["getCommit bbbbbbb"]);
    expect(revisions.get("bbbbbbb")).toBe(Y);
  });
});
