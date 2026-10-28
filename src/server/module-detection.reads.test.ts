/**
 * How a detection run reads the prime (D19): by batch, by the blob ids the
 * tree listing gave, never a file too large to hold, and never a missing file
 * read as empty.
 *
 * `runDetection` runs whole, on the library double, against a small prime
 * served by a GitHub that answers as GitHub does: GraphQL serves a blob's text
 * by id, the blobs API serves it base64, and the contents API is not how
 * detection reads at all. A file the listing names as too large is never
 * served: asking for it fails the test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobSha } from "./cascade/gitBlobSha.pure";
import { STATEMENT_TIMEOUT, createLibraryFakeDb, type LibraryFakeDb } from "./testing/libraryFakes";

const COMMIT = "122b761274a9c5ef98207b16b5e02a5d7cfeb37e";
const TREE = "7e57000000000000000000000000000000000001";

const FILES: Record<string, string> = {
  "src/routes/index.tsx":
    'import { Hero } from "@/components/home/Hero";\nexport default function Index() {\n  return Hero;\n}\n',
  "src/routes/clients.tsx":
    'import { ClientList } from "@/components/clients/ClientList";\nexport default ClientList;\n',
  "src/components/home/Hero.tsx":
    'import { format } from "@/lib/format";\nimport type { Database } from "@/integrations/supabase/types";\nexport const Hero = format("hi");\nexport type D = Database;\n',
  "src/components/clients/ClientList.tsx":
    'import { format } from "@/lib/format";\nimport { supabase } from "@/integrations/supabase/client";\nexport const ClientList = () => supabase.from("clients").select(format("*"));\n',
  "src/lib/format.ts": "export const format = (s: string) => s;\n",
  "src/integrations/supabase/client.ts": "export const supabase = {} as never;\n",
  "supabase/functions/send-email/index.ts":
    'const key = Deno.env.get("RESEND_API_KEY");\nexport default key;\n',
  "supabase/migrations/20260101000000_init.sql":
    "create table public.clients (id uuid primary key);\n",
  "supabase/config.toml": "[functions.send-email]\nverify_jwt = false\n",
};

/** Listed with their sizes and never served: what no read may hold. */
const TOO_LARGE: Record<string, { sha: string; size: number }> = {
  // 1.3 MB, as on the prime: more than the contents API ever served the trace.
  "src/integrations/supabase/types.ts": {
    sha: "7a1e000000000000000000000000000000000001",
    size: 1_314_292,
  },
  // A template seed, as on the prime: more than an isolate can hold.
  "supabase/migrations/20270130090000_seed_template_library_v29.sql": {
    sha: "5eed000000000000000000000000000000000029",
    size: 43_447_138,
  },
};

const SEED = "supabase/migrations/20270130090000_seed_template_library_v29.sql";
const TYPES = "src/integrations/supabase/types.ts";

type Asked = { graphql: string[]; blobs: string[]; contents: string[] };

const github = vi.hoisted(() => ({
  /** Paths GraphQL answers with null, as it does for an id it will not serve. */
  unanswered: new Set<string>(),
  /** Paths the blobs API answers 502 for. */
  failing: new Set<string>(),
  asked: { graphql: [], blobs: [], contents: [] } as Asked,
  octokit: null as unknown,
}));

vi.mock("./github-app.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.server")>()),
  getAppOctokit: () => github.octokit,
}));

import { findRunningDetection, runDetection, DEFAULT_CONFIG } from "./module-detection.server";

const shaOf = (path: string) => TOO_LARGE[path]?.sha ?? gitBlobSha(FILES[path]);
const pathOf = (sha: string) =>
  Object.keys(FILES).find((p) => shaOf(p) === sha) ??
  Object.keys(TOO_LARGE).find((p) => TOO_LARGE[p].sha === sha);

const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status, name: "HttpError" });

function fakeGithub() {
  const asked = github.asked;
  return {
    repos: {
      getBranch: async () => ({
        data: { commit: { sha: COMMIT, commit: { tree: { sha: TREE } } } },
      }),
      getContent: async ({ path }: { path: string }) => {
        asked.contents.push(path);
        throw httpError(500, "detection asked the contents API");
      },
    },
    git: {
      getTree: async () => ({
        data: {
          sha: TREE,
          truncated: false,
          tree: [
            ...Object.entries(FILES).map(([path, text]) => ({
              path,
              type: "blob",
              mode: "100644",
              sha: shaOf(path),
              size: Buffer.byteLength(text, "utf8"),
            })),
            ...Object.entries(TOO_LARGE).map(([path, { sha, size }]) => ({
              path,
              type: "blob",
              mode: "100644",
              sha,
              size,
            })),
          ],
        },
      }),
      getBlob: async ({ file_sha }: { file_sha: string }) => {
        const path = pathOf(file_sha) ?? file_sha;
        asked.blobs.push(path);
        if (path in TOO_LARGE) throw new Error(`read ${path}, which is too large to hold`);
        if (github.failing.has(path)) throw httpError(502, "Bad Gateway");
        const text = FILES[path];
        return {
          data: {
            sha: file_sha,
            size: Buffer.byteLength(text, "utf8"),
            content: Buffer.from(text, "utf8").toString("base64"),
            encoding: "base64",
          },
        };
      },
    },
    graphql: async (query: string) => {
      const repository: Record<string, unknown> = {};
      for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
        const path = pathOf(m[2]) ?? m[2];
        asked.graphql.push(path);
        if (path in TOO_LARGE)
          throw new Error(`asked GraphQL for ${path}, which is too large to hold`);
        repository[m[1]] = github.unanswered.has(path)
          ? null
          : { text: FILES[path], isBinary: false, isTruncated: false };
      }
      return { repository };
    },
  };
}

let db: LibraryFakeDb;

beforeEach(() => {
  process.env.LOVABLE_API_KEY ??= "test";
  github.unanswered = new Set();
  github.failing = new Set();
  github.asked = { graphql: [], blobs: [], contents: [] };
  github.octokit = fakeGithub();
  db = createLibraryFakeDb({
    prime_config: [
      {
        id: "p",
        github_owner: "Naidu-Group-Pty-Ltd",
        github_repo: "npc-property-dashbord",
        default_branch: "main",
      },
    ],
  });
});

const detect = () =>
  runDetection({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder detection uses
    supabase: db as any,
    userId: "a1a1a1a1-0000-4000-8000-0000000000aa",
    config: { ...DEFAULT_CONFIG, deltaMode: false },
  });

const run = () => db.tables.module_detection_runs[0];

describe("a detection run reads the prime by batch", () => {
  it("asks for every file it needs once, by id, and never through the contents API", async () => {
    const result = await detect();

    expect(result.ok).toBe(true);
    expect(github.asked.contents).toEqual([]);
    expect([...github.asked.graphql].sort()).toEqual(Object.keys(FILES).sort());
    expect(github.asked.blobs).toEqual([]);
    expect(run().status).toBe("completed");
    expect(run().commit_sha).toBe(COMMIT);
    expect(db.tables.modules.length).toBeGreaterThan(0);
  });

  it("never asks for a file too large to hold, and names each one in the run", async () => {
    const result = await detect();

    expect(result.ok).toBe(true);
    expect(github.asked.graphql).not.toContain(SEED);
    expect(github.asked.blobs).not.toContain(SEED);
    expect(github.asked.graphql).not.toContain(TYPES);
    expect(github.asked.blobs).not.toContain(TYPES);
    const summary = run().backend_summary as {
      blob_reads: { too_large_to_hold: string[] };
      trace_too_large_to_hold: string[];
    };
    expect(summary.blob_reads.too_large_to_hold).toEqual([SEED]);
    expect(summary.trace_too_large_to_hold).toEqual([TYPES]);
  });

  it("reads a file GraphQL left unanswered from the blobs API, by the same id", async () => {
    github.unanswered.add("src/lib/format.ts");

    const result = await detect();

    expect(result.ok).toBe(true);
    expect(github.asked.blobs).toEqual(["src/lib/format.ts"]);
  });

  it("remembers what it read: the blob cache holds each backend file's analysis", async () => {
    await detect();

    const cached = db.tables.repo_blob_analysis.map((r) => r.path).sort();
    expect(cached).toEqual([
      "supabase/functions/send-email/index.ts",
      "supabase/migrations/20260101000000_init.sql",
    ]);
  });
});

describe("a run that could not read a file it needed writes no module", () => {
  it("fails on a source file the trace reaches, naming it", async () => {
    github.unanswered.add("src/lib/format.ts");
    github.failing.add("src/lib/format.ts");

    const result = await detect();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "1 source file(s) the import trace reaches could not be read (src/lib/format.ts), " +
        "so this run wrote no module. Run detection again.",
    );
    expect(db.tables.modules).toEqual([]);
    expect(run().status).toBe("failed");
    expect(run().error_message).toBe(result.error);
  });

  it("fails on a migration, naming it, rather than reading it as declaring nothing", async () => {
    github.unanswered.add("supabase/migrations/20260101000000_init.sql");
    github.failing.add("supabase/migrations/20260101000000_init.sql");

    const result = await detect();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(
      /^1 backend file\(s\) could not be read \(supabase\/migrations\/20260101000000_init\.sql\)/,
    );
    expect(db.tables.modules).toEqual([]);
  });

  it("fails on config.toml, rather than reading every function as verify_jwt true", async () => {
    github.unanswered.add("supabase/config.toml");
    github.failing.add("supabase/config.toml");

    const result = await detect();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be read \(supabase\/config\.toml\)/);
    expect(db.tables.modules).toEqual([]);
  });
});

describe("which run is running", () => {
  const now = Date.parse("2026-10-28T22:00:00Z");
  const runRow = (id: string, status: string, started: string) => ({
    id,
    status,
    started_at: started,
  });

  it("is one started inside the window that has not finished", async () => {
    db = createLibraryFakeDb({
      module_detection_runs: [
        runRow("r-done", "completed", "2026-10-28T21:55:00.000Z"),
        runRow("r-live", "running", "2026-10-28T21:50:00.000Z"),
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double
    const found = await findRunningDetection(db as any, now);

    expect(found).toEqual({
      ok: true,
      running: { id: "r-live", started_at: "2026-10-28T21:50:00.000Z" },
    });
  });

  it("is none where the only run saying running started before the window", async () => {
    db = createLibraryFakeDb({
      module_detection_runs: [runRow("r-dead", "running", "2026-10-28T20:00:00.000Z")],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double
    const found = await findRunningDetection(db as any, now);

    expect(found).toEqual({ ok: true, running: null });
  });

  it("is an error, never none, when the runs cannot be read", async () => {
    db.failures.set("module_detection_runs.select", STATEMENT_TIMEOUT);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double
    const found = await findRunningDetection(db as any, now);

    expect(found).toEqual({
      ok: false,
      error: "detection runs unreadable: canceling statement due to statement timeout",
    });
  });
});
