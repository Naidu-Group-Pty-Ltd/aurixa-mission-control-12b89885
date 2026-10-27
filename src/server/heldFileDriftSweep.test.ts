/**
 * The sweep reads the held files that can be behind, all of them, and never
 * calls a clone it did not finish reading clean.
 *
 * ## What this is here to make impossible
 *
 * The sweep read the first 24 held source files in path order and stopped. On
 * 27 Oct 2026 `npc-crm-independent-6505dc` held 114, most of them the line's own
 * files the prime has never held, so every hour it read the same 24, never
 * reached 25 of the 39 that can drift, and reported the clone `clean`.
 *
 * Driven through `sweepHeldFileDrift` against doubles of GitHub's tree, GraphQL
 * and blob endpoints and of the tables it reads, so what is asserted is what
 * the sweep would have reported and recorded.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({
  audit: [] as Array<{ action: string; metadata: Record<string, unknown> }>,
  notified: [] as Array<{ title: string; body: string }>,
}));

vi.mock("./audit.server", () => ({
  writeAuditLog: async (row: { action: string; metadata: Record<string, unknown> }) => {
    recorded.audit.push(row);
  },
  notifyOperators: async (n: { title: string; body: string }) => {
    recorded.notified.push(n);
  },
}));

const github = vi.hoisted(() => ({
  repos: new Map<string, Record<string, string>>(),
  unreadable: new Set<string>(),
}));

const blobSha = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");

vi.mock("./github-app.server", async (original) => {
  const actual = await original<typeof import("./github-app.server")>();
  const blobsOf = (repo: string) => {
    const out = new Map<string, string>();
    for (const text of Object.values(github.repos.get(repo) ?? {})) out.set(blobSha(text), text);
    return out;
  };
  const octokit = {
    repos: {
      // The contents API, which the sweep no longer reads through. Answered so
      // a read the sweep makes there is a read, not a fault of this double.
      getContent: async ({ repo, path }: { repo: string; path: string }) => {
        const text = github.repos.get(repo)?.[path];
        if (github.unreadable.has(repo))
          throw Object.assign(new Error("Server Error"), { status: 502 });
        if (text === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        return {
          data: {
            type: "file",
            sha: blobSha(text),
            size: Buffer.byteLength(text),
            content: Buffer.from(text).toString("base64"),
            encoding: "base64",
          },
        };
      },
      getBranch: async ({ repo }: { repo: string }) => ({
        data: { commit: { sha: `head-${repo}`, commit: { tree: { sha: `tree-${repo}` } } } },
      }),
    },
    git: {
      getTree: async ({ repo }: { repo: string }) => ({
        data: {
          truncated: false,
          tree: Object.entries(github.repos.get(repo) ?? {}).map(([path, text]) => ({
            path,
            type: "blob",
            mode: "100644",
            sha: blobSha(text),
            size: Buffer.byteLength(text),
          })),
        },
      }),
      getBlob: async ({ repo, file_sha }: { repo: string; file_sha: string }) => {
        const text = blobsOf(repo).get(file_sha);
        if (github.unreadable.has(repo) || text === undefined) {
          throw Object.assign(new Error("Server Error"), { status: 502 });
        }
        return { data: { content: Buffer.from(text).toString("base64"), encoding: "base64" } };
      },
    },
    graphql: async (query: string, vars: { repo: string }) => {
      if (github.unreadable.has(vars.repo)) throw new Error("Something went wrong");
      const blobs = blobsOf(vars.repo);
      const repository: Record<string, unknown> = {};
      for (const [, alias, oid] of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
        const text = blobs.get(oid);
        repository[alias] =
          text === undefined ? null : { text, isBinary: false, isTruncated: false };
      }
      return { repository };
    },
  };
  return { ...actual, getAppOctokit: () => octokit };
});

import { MAX_HELD_PATHS, sweepHeldFileDrift } from "./heldFileDriftSweep.server";

const PRIME = "npc-property-dashbord";
const CRM = "npc-crm-independent-6505dc";

/** The tables the sweep reads, answering as PostgREST does for these shapes. */
function db(opts: { exclusions: Array<{ pattern: string; reason: string }> }) {
  const query = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
    return q;
  };
  return {
    from(table: string) {
      if (table === "prime_config") {
        return query([{ github_owner: "o", github_repo: PRIME, default_branch: "main" }]);
      }
      if (table === "clones") {
        return query([
          {
            id: "crm",
            name: "NPC CRM Independent",
            github_owner: "o",
            github_repo: CRM,
            default_branch: "main",
            sync_scope: "modules",
            crm_mode: "independent",
          },
        ]);
      }
      if (table === "clone_sync_exclusions") return query(opts.exclusions);
      if (table === "audit_log") return query([]);
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}

const HELD = [{ pattern: "src/held/**", reason: "manual_reconcile" }];

/** A held page importing one thing on the clone, and that and one more on the prime. */
const PAGE_CLONE = `import { a } from "../lib/wiring";\nexport const page = a;\n`;
const PAGE_PRIME = `import { a, b } from "../lib/wiring";\nexport const page = [a, b];\n`;
const WIRING = `export const a = 1;\nexport const b = 2;\n`;

beforeEach(() => {
  recorded.audit.length = 0;
  recorded.notified.length = 0;
  github.repos.clear();
  github.unreadable.clear();
});

describe("the held files that can be behind are read, however many sort before them", () => {
  it("finds a gap in the one held file the prime has, behind thirty the prime never held", async () => {
    // The CRM line's shape: its own held files, which the prime has never
    // held, sort ahead of the page that is actually behind.
    const lineOwn: Record<string, string> = {};
    for (let i = 0; i < 30; i++)
      lineOwn[`src/held/a${String(i).padStart(2, "0")}.ts`] = `// ${i}\n`;
    github.repos.set(PRIME, {
      "src/held/zPage.tsx": PAGE_PRIME,
      "src/held/same.ts": "export const same = 1;\n",
      "src/lib/wiring.ts": WIRING,
    });
    github.repos.set(CRM, {
      ...lineOwn,
      "src/held/zPage.tsx": PAGE_CLONE,
      "src/held/same.ts": "export const same = 1;\n",
      "src/lib/wiring.ts": WIRING,
    });

    const report = await sweepHeldFileDrift(db({ exclusions: HELD }));
    expect(report.failed).toBe(0);
    expect(report.detail).toEqual([
      expect.objectContaining({ outcome: "drifted", announced: true, capped: false }),
    ]);
    expect(recorded.notified).toHaveLength(1);
    expect(recorded.notified[0].body).toContain("src/held/zPage.tsx");
    expect(recorded.notified[0].body).toContain("b");
    // Only the one file that can be behind was read: not the line's own, not
    // the copy identical to the prime's.
    expect(recorded.audit[0].metadata.held_paths).toEqual(["src/held/zPage.tsx"]);
  });

  it("calls a clone clean only where no held file differs from a copy the prime holds", async () => {
    github.repos.set(PRIME, { "src/held/same.ts": "export const same = 1;\n" });
    github.repos.set(CRM, {
      "src/held/same.ts": "export const same = 1;\n",
      "src/held/own.ts": "export const own = 1;\n",
    });
    const report = await sweepHeldFileDrift(db({ exclusions: HELD }));
    expect(report.detail).toEqual([{ clone: "NPC CRM Independent", outcome: "clean" }]);
    expect(recorded.audit).toEqual([]);
  });
});

describe("a sweep that did not read everything says so", () => {
  it("is partial past the ceiling, and records no clearance", async () => {
    const prime: Record<string, string> = {};
    const clone: Record<string, string> = {};
    for (let i = 0; i <= MAX_HELD_PATHS; i++) {
      const path = `src/held/p${String(i).padStart(3, "0")}.ts`;
      prime[path] = `export const p${i} = "prime";\n`;
      clone[path] = `export const p${i} = "clone";\n`;
    }
    github.repos.set(PRIME, prime);
    github.repos.set(CRM, clone);

    const report = await sweepHeldFileDrift(db({ exclusions: HELD }));
    expect(report.capped).toBe(1);
    expect(report.detail).toEqual([
      expect.objectContaining({ outcome: "partial", read: MAX_HELD_PATHS, of: MAX_HELD_PATHS + 1 }),
    ]);
    // A clearance is a statement about the whole clone, and this read part of it.
    expect(recorded.audit).toEqual([]);
  });

  it("fails a clone whose held files could not be read, rather than calling it clean", async () => {
    github.repos.set(PRIME, { "src/held/zPage.tsx": PAGE_PRIME, "src/lib/wiring.ts": WIRING });
    github.repos.set(CRM, { "src/held/zPage.tsx": PAGE_CLONE, "src/lib/wiring.ts": WIRING });
    github.unreadable.add(CRM);
    const report = await sweepHeldFileDrift(db({ exclusions: HELD }));
    expect(report.failed).toBe(1);
    expect(report.detail).toEqual([expect.objectContaining({ outcome: "failed" })]);
    expect(recorded.audit).toEqual([]);
  });
});
