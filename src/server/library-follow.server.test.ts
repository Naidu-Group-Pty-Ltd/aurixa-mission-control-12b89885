/**
 * The library follows the prime (D19, the owner's decision of 29 Oct 2026),
 * asserted on what the double HOLDS afterwards.
 *
 * `followPrimeHead` runs whole: the head is read, and the catalogue detected,
 * by the real `readPrimeHead` and `runDetection` against a small prime served
 * by a GitHub that answers as GitHub does (GraphQL serves a blob's text by
 * id), and the real `catalogueCompetitor` decides who else is working.
 *
 * The follow changes no clone: on 29 Oct 2026 every clone metered on `free`
 * while Mission Control recorded its sold plan, so a reconcile from here
 * would have rewritten all four recorded plans (`libraryFollow.pure.ts`).
 * Every suite seeds clones and their installs, and the follow must leave both
 * exactly as they were.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitBlobSha } from "./cascade/gitBlobSha.pure";
import {
  STATEMENT_TIMEOUT,
  createLibraryFakeDb,
  type LibraryFakeDb,
  type Row,
} from "./testing/libraryFakes";

const COMMIT_1 = "122b761274a9c5ef98207b16b5e02a5d7cfeb37e";
const COMMIT_2 = "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e";
const COMMIT_3 = "3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";
const TREE = "7e57000000000000000000000000000000000001";

/** A small prime: three routes, the platform core, and two edge functions. */
const PRIME: Record<string, string> = {
  "src/routes/index.tsx":
    'import { Hero } from "@/components/home/Hero";\nexport default function Index() {\n  return Hero;\n}\n',
  "src/routes/clients.tsx":
    'import { ClientList } from "@/components/clients/ClientList";\nexport default ClientList;\n',
  "src/routes/reports.tsx":
    'import { ReportList } from "@/components/reports/ReportList";\nexport default ReportList;\n',
  "src/components/home/Hero.tsx":
    'import { format } from "@/lib/format";\nexport const Hero = format("hi");\n',
  "src/components/clients/ClientList.tsx":
    'import { format } from "@/lib/format";\nimport { supabase } from "@/integrations/supabase/client";\nexport const ClientList = () => supabase.from("clients").select(format("*"));\n',
  "src/components/reports/ReportList.tsx":
    'import { supabase } from "@/integrations/supabase/client";\nexport const ReportList = () => supabase.functions.invoke("render-report");\n',
  "src/lib/format.ts": "export const format = (s: string) => s;\n",
  "src/integrations/supabase/client.ts": "export const supabase = {} as never;\n",
  "supabase/functions/send-email/index.ts":
    'const key = Deno.env.get("RESEND_API_KEY");\nexport default key;\n',
  "supabase/functions/render-report/index.ts": 'export default Deno.env.get("RENDER_KEY");\n',
  "supabase/migrations/20260101000000_init.sql":
    "create table public.clients (id uuid primary key);\n",
  "supabase/config.toml": "[functions.send-email]\nverify_jwt = false\n",
};

/** The slugs a detection finds in `PRIME`. */
const FOUND = ["backend-send", "clients", "index", "platform-core", "reports"];

const REPORTS = [
  "src/routes/reports.tsx",
  "src/components/reports/ReportList.tsx",
  "supabase/functions/render-report/index.ts",
];

const prime = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  commit: "",
  /** The branch read fails, as GitHub's 502 does. */
  branchFails: false,
  octokit: null as unknown,
}));

vi.mock("./github-app.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.server")>()),
  getAppOctokit: () => prime.octokit,
}));

import {
  FOLLOW_DEPS,
  catalogueSettledAt,
  followPrimeHead,
  type FollowDeps,
} from "./library-follow.server";
import { DEFAULT_CONFIG, RUNNING_RUN_WINDOW_MS, runDetection } from "./module-detection.server";
import { FOLLOW_ATTEMPTS, FOLLOW_AUDIT_ACTION } from "./libraryFollow.pure";

function fakeGithub() {
  const shaOf = (path: string) => gitBlobSha(prime.files[path]);
  const pathOf = (sha: string) => Object.keys(prime.files).find((p) => shaOf(p) === sha);
  return {
    repos: {
      getBranch: async () => {
        if (prime.branchFails) throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        return { data: { commit: { sha: prime.commit, commit: { tree: { sha: TREE } } } } };
      },
    },
    git: {
      getTree: async () => ({
        data: {
          sha: TREE,
          truncated: false,
          tree: Object.entries(prime.files).map(([path, text]) => ({
            path,
            type: "blob",
            mode: "100644",
            sha: shaOf(path),
            size: Buffer.byteLength(text, "utf8"),
          })),
        },
      }),
      getBlob: async () => {
        throw new Error("the follow's detection read a blob by the blobs API");
      },
    },
    graphql: async (query: string) => {
      const repository: Record<string, unknown> = {};
      for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
        const path = pathOf(m[2]);
        repository[m[1]] = path
          ? { text: prime.files[path], isBinary: false, isTruncated: false }
          : null;
      }
      return { repository };
    },
  };
}

const ADMIN = "a1a1a1a1-0000-4000-8000-0000000000aa";
const OLD_RUN = "31a7e000-0000-4000-8000-000000000002";
const CLONE_A = "c0000000-0000-4000-8000-00000000000a";
const CLONE_B = "c0000000-0000-4000-8000-00000000000b";

/** A module as July's detection left it, approved by a person, at no commit. */
const oldModule = (slug: string, over: Row = {}): Row => ({
  id: `m-${slug}`,
  slug,
  name: `${slug} (named by a person)`,
  description: `What ${slug} is, as a person wrote it`,
  status: "approved",
  layer: "fullstack",
  file_globs: [`src/old/${slug}/**`],
  resolved_files: [`src/old/${slug}.tsx`],
  detection_run_id: OLD_RUN,
  approved_by: ADMIN,
  approved_at: "2026-07-31T23:30:00Z",
  archived_by_follow_run_id: null,
  backend_manifest: { detection_run_id: OLD_RUN },
  ...over,
});

/** Its library entry, as every entry before the follow was: pending, at no commit. */
const pendingEntry = (slug: string): Row => ({
  id: `e-${slug}`,
  slug,
  name: slug,
  entry_file: `src/old/${slug}.tsx`,
  file_paths: [`src/old/${slug}.tsx`],
  version: 1,
  approval_status: "pending",
  is_latest: true,
  source_detection_run_id: OLD_RUN,
});

const cloneRow = (id: string): Row => ({
  id,
  name: id.slice(-4),
  slug: `clone-${id.slice(-4)}`,
  github_owner: "Naidu-Group-Pty-Ltd",
  github_repo: `clone-${id.slice(-4)}`,
  provisioning_method: "fork",
});

let db: LibraryFakeDb;
let detections: number;

let deps: FollowDeps;

function seed(extra: Partial<Record<string, Row[]>> = {}) {
  db = createLibraryFakeDb({
    prime_config: [
      {
        id: "p",
        github_owner: "Naidu-Group-Pty-Ltd",
        github_repo: "npc-property-dashbord",
        default_branch: "main",
      },
    ],
    clones: [
      { ...cloneRow(CLONE_A), entitled_plan_slug: "scale", entitled_module_slugs: ["clients"] },
      { ...cloneRow(CLONE_B), entitled_plan_slug: "launch", entitled_module_slugs: [] },
    ],
    module_detection_runs: [
      { id: OLD_RUN, status: "completed", commit_sha: null, started_at: "2026-07-31T23:13:41Z" },
    ],
    ...extra,
  } as Parameters<typeof createLibraryFakeDb>[0]);
}

beforeEach(() => {
  process.env.LOVABLE_API_KEY ??= "test";
  prime.files = { ...PRIME };
  prime.commit = COMMIT_1;
  prime.branchFails = false;
  prime.octokit = fakeGithub();
  detections = 0;
  deps = {
    ...FOLLOW_DEPS,
    detect: async (args) => {
      detections++;
      return FOLLOW_DEPS.detect(args);
    },
  };
  seed();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder the follow uses
const follow = () => followPrimeHead(db as any, deps);

const moduleOf = (slug: string) => db.tables.modules.find((m) => m.slug === slug);
const entriesOf = (slug: string) =>
  db.tables.module_library
    .filter((e) => e.slug === slug)
    .sort((a, b) => (a.version as number) - (b.version as number));
const followRuns = () =>
  db.tables.module_detection_runs.filter(
    (r) => (r.parameters as { follow?: boolean } | null)?.follow === true,
  );
const audits = () => db.tables.audit_log.filter((a) => a.action === FOLLOW_AUDIT_ACTION);
const heldNotices = () => db.tables.notifications.filter((n) => n.kind === "library_follow_held");

describe("the first follow settles July's catalogue at the prime's head", () => {
  beforeEach(() => {
    seed({
      modules: [oldModule("clients"), oldModule("index"), oldModule("gone")],
      module_library: [pendingEntry("clients"), pendingEntry("index"), pendingEntry("gone")],
    });
  });

  it("approves what it found by policy, archives what it did not, and records the commit", async () => {
    const report = await follow();

    expect(report.outcome).toBe("settled");
    expect(report.headSha).toBe(COMMIT_1);
    expect(report.commitSha).toBe(COMMIT_1);
    expect(report.approved).toEqual(["backend-send", "platform-core", "reports"]);
    expect(report.archived).toEqual(["gone"]);
    expect(report.warnings).toEqual([]);

    const [run] = followRuns();
    expect(run.status).toBe("completed");
    expect(run.commit_sha).toBe(COMMIT_1);
    expect(run.completed_at).not.toBeNull();
    expect(run.initiated_by).toBeNull();

    for (const slug of FOUND) {
      const m = moduleOf(slug);
      expect(m?.status, slug).toBe("approved");
      expect(m?.detection_run_id, slug).toBe(run.id);
    }
    // The ones that were new are approved with no approver: the owner's policy.
    expect(moduleOf("reports")?.approved_by).toBeNull();
    expect(moduleOf("gone")).toMatchObject({
      status: "archived",
      archived_by_follow_run_id: run.id,
    });
  });

  it("rewrites an approved module's files from the run, and keeps what a person named it", async () => {
    await follow();

    expect(moduleOf("clients")).toMatchObject({
      name: "clients (named by a person)",
      description: "What clients is, as a person wrote it",
      resolved_files: ["src/components/clients/ClientList.tsx", "src/routes/clients.tsx"],
    });
  });

  it("publishes every module it found, approved at the commit, by nobody, and supersedes July's entries", async () => {
    const report = await follow();
    const [run] = followRuns();

    expect(report.published).toEqual([
      { slug: "backend-send", version: 1, change: "new" },
      { slug: "clients", version: 2, change: "unapproved" },
      { slug: "index", version: 2, change: "unapproved" },
      { slug: "platform-core", version: 1, change: "new" },
      { slug: "reports", version: 1, change: "new" },
    ]);
    for (const slug of FOUND) {
      const latest = entriesOf(slug).filter((e) => e.is_latest);
      expect(latest, slug).toHaveLength(1);
      expect(latest[0], slug).toMatchObject({
        approval_status: "approved",
        approved_by: null,
        published_by: null,
        source_commit_sha: COMMIT_1,
        source_detection_run_id: run.id,
      });
    }
    expect(entriesOf("clients")[0]).toMatchObject({ version: 1, is_latest: false });
    // An archived module's entries are left as they were.
    expect(entriesOf("gone")).toEqual([expect.objectContaining({ version: 1, is_latest: true })]);
    expect(db.tables.notifications.map((n) => n.kind)).toEqual(["library_entry_approved"]);
  });

  it("changes no clone, though the catalogue gained and lost modules", async () => {
    seed({
      modules: [oldModule("clients"), oldModule("index"), oldModule("gone")],
      clone_modules: [
        { id: "i1", clone_id: CLONE_A, module_id: "m-clients" },
        { id: "i2", clone_id: CLONE_A, module_id: "m-gone" },
      ],
    });
    const clonesBefore = structuredClone(db.tables.clones);
    const installsBefore = structuredClone(db.tables.clone_modules);

    const report = await follow();

    expect(report.outcome).toBe("settled");
    expect(report.archived).toEqual(["gone"]);
    expect(db.writes.filter((w) => w.table === "clones" || w.table === "clone_modules")).toEqual(
      [],
    );
    expect(db.tables.clones).toEqual(clonesBefore);
    expect(db.tables.clone_modules).toEqual(installsBefore);
  });

  it("records what it did on one audit row", async () => {
    const report = await follow();

    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      entity_type: "module_detection_run",
      entity_id: report.runId,
      actor_user_id: null,
    });
    expect(audits()[0].metadata).toMatchObject({
      outcome: "settled",
      commit_sha: COMMIT_1,
      attempt: 1,
      approved: ["backend-send", "platform-core", "reports"],
      archived: ["gone"],
    });
  });

  it("does nothing at all at the next tick, while the head has not moved", async () => {
    await follow();
    const writes = db.writes.length;

    const report = await follow();

    expect(report.outcome).toBe("up_to_date");
    expect(report.runId).toBe(followRuns()[0].id);
    expect(db.writes.length).toBe(writes);
    expect(detections).toBe(1);
  });
});

describe("when the prime moves", () => {
  beforeEach(async () => {
    await follow();
  });

  it("publishes nothing where nothing a clone receives changed", async () => {
    prime.commit = COMMIT_2;

    const report = await follow();

    expect(report.outcome).toBe("settled");
    expect(report.commitSha).toBe(COMMIT_2);
    expect(report.published).toEqual([]);
    expect(report.unchanged).toBe(FOUND.length);
    expect(report.approved).toEqual([]);
    expect(report.archived).toEqual([]);
    expect(followRuns().map((r) => r.status)).toEqual(["completed", "completed"]);
    // Every module names the run at the new head, so the next change publishes from it.
    const latestRun = followRuns().find((r) => r.commit_sha === COMMIT_2);
    for (const slug of FOUND) expect(moduleOf(slug)?.detection_run_id, slug).toBe(latestRun?.id);
  });

  it("publishes the one module whose files changed", async () => {
    prime.commit = COMMIT_2;
    prime.files["src/components/clients/ClientRow.tsx"] = "export const ClientRow = () => null;\n";
    prime.files["src/components/clients/ClientList.tsx"] =
      'import { ClientRow } from "./ClientRow";\n' + PRIME["src/components/clients/ClientList.tsx"];

    const report = await follow();

    expect(report.published).toEqual([{ slug: "clients", version: 2, change: "changed" }]);
    expect(report.unchanged).toBe(FOUND.length - 1);
    const latest = entriesOf("clients").find((e) => e.is_latest);
    expect(latest).toMatchObject({ version: 2, source_commit_sha: COMMIT_2 });
    expect(entriesOf("clients")[0]).toMatchObject({ version: 1, is_latest: false });
    expect(latest?.file_paths).toContain("src/components/clients/ClientRow.tsx");
  });

  it("archives a route the prime dropped, and brings it back when it returns", async () => {
    prime.commit = COMMIT_2;
    for (const path of REPORTS) delete prime.files[path];

    const dropped = await follow();

    expect(dropped.archived).toEqual(["reports"]);
    const droppedAt = followRuns().find((r) => r.commit_sha === COMMIT_2);
    expect(moduleOf("reports")).toMatchObject({
      status: "archived",
      archived_by_follow_run_id: droppedAt?.id,
    });

    prime.commit = COMMIT_3;
    prime.files = { ...PRIME };

    const returned = await follow();

    expect(returned.revived).toEqual(["reports"]);
    expect(moduleOf("reports")).toMatchObject({
      status: "approved",
      archived_by_follow_run_id: null,
    });
    // Its entry from the first follow says what it says now, and stays its latest.
    expect(returned.published).toEqual([]);
    expect(entriesOf("reports")).toEqual([
      expect.objectContaining({ version: 1, is_latest: true, source_commit_sha: COMMIT_1 }),
    ]);
    expect(db.writes.filter((w) => w.table === "clones" || w.table === "clone_modules")).toEqual(
      [],
    );
  });
});

describe("what a person decided stands", () => {
  it("leaves a module a person archived archived, and one a person rejected rejected, and names both", async () => {
    seed({
      modules: [
        oldModule("clients"),
        oldModule("reports", { status: "archived" }),
        oldModule("index", { status: "rejected", approved_by: null }),
      ],
    });

    const report = await follow();

    expect(report.outcome).toBe("settled");
    expect(report.keptOut).toEqual(["index", "reports"]);
    expect(report.archived).toEqual([]);
    expect(moduleOf("reports")).toMatchObject({
      status: "archived",
      archived_by_follow_run_id: null,
      detection_run_id: OLD_RUN,
    });
    expect(moduleOf("index")?.status).toBe("rejected");
    expect(entriesOf("reports")).toEqual([]);
    expect(entriesOf("index")).toEqual([]);
    expect(report.published.map((p) => p.slug)).toEqual([
      "backend-send",
      "clients",
      "platform-core",
    ]);
  });
});

describe("the follow stops for a person rather than archive the catalogue", () => {
  const many = Array.from({ length: 12 }, (_, i) => oldModule(`old-${String(i).padStart(2, "0")}`));

  beforeEach(() => seed({ modules: many }));

  it("holds before the run writes a module, and tells the operators", async () => {
    const before = db.tables.modules.map((m) => ({ ...m }));

    const report = await follow();

    expect(report.outcome).toBe("held");
    expect(report.stoppedBecause).toMatch(/would archive 12 of the 12 live modules/);
    expect(db.writes.filter((w) => w.table === "modules")).toEqual([]);
    expect(db.tables.modules).toEqual(before);
    expect(db.tables.module_library).toEqual([]);
    const [run] = followRuns();
    expect(run.status).toBe("held");
    expect(run.error_message).toMatch(/would archive 12 of the 12/);
    expect(heldNotices()).toHaveLength(1);
    expect(heldNotices()[0].title).toBe("Library follow held at prime@122b761");
    expect(audits().map((a) => (a.metadata as { outcome: string }).outcome)).toEqual(["held"]);
  });

  it("does not try that commit again, and follows when the prime moves", async () => {
    await follow();

    const again = await follow();
    expect(again.outcome).toBe("held");
    expect(detections).toBe(1);
    expect(heldNotices()).toHaveLength(1);

    prime.commit = COMMIT_2;
    const moved = await follow();
    expect(moved.outcome).toBe("held");
    expect(detections).toBe(2);
  });
});

describe("a follow that fails is tried again, three times at one commit", () => {
  beforeEach(() => {
    // The run's own writes land, and the settle's first write does not.
    deps.detect = async (args) => {
      detections++;
      db.failures.delete("modules.update");
      const result = await FOLLOW_DEPS.detect(args);
      db.failures.set("modules.update", STATEMENT_TIMEOUT);
      return result;
    };
  });

  it("closes the run failed, names why, and publishes nothing", async () => {
    const report = await follow();

    expect(report.outcome).toBe("failed");
    expect(report.attempt).toBe(1);
    expect(report.stoppedBecause).toMatch(
      /could not be approved: .*canceling statement due to statement timeout/,
    );
    expect(followRuns()[0]).toMatchObject({ status: "failed", commit_sha: COMMIT_1 });
    expect(db.tables.module_library).toEqual([]);
    expect(heldNotices()).toEqual([]);
    expect(audits().map((a) => (a.metadata as { outcome: string }).outcome)).toEqual(["failed"]);
  });

  it("tells the operators at the last try, then waits for the prime to move", async () => {
    for (let i = 1; i <= FOLLOW_ATTEMPTS; i++) {
      const report = await follow();
      expect(report.attempt, `try ${i}`).toBe(i);
      expect(heldNotices(), `try ${i}`).toHaveLength(i === FOLLOW_ATTEMPTS ? 1 : 0);
    }
    expect(heldNotices()[0].title).toBe("Library follow failed at prime@122b761");

    const waiting = await follow();
    expect(waiting.outcome).toBe("exhausted");
    expect(detections).toBe(FOLLOW_ATTEMPTS);
    expect(audits()).toHaveLength(FOLLOW_ATTEMPTS);
    expect(heldNotices()).toHaveLength(1);

    db.failures.clear();
    deps.detect = FOLLOW_DEPS.detect;
    prime.commit = COMMIT_2;
    expect((await follow()).outcome).toBe("settled");
  });

  it("fails, and is tried again, where the prime has no route at all", async () => {
    deps.detect = FOLLOW_DEPS.detect;
    prime.files = Object.fromEntries(
      Object.entries(PRIME).filter(([path]) => !path.startsWith("src/routes/")),
    );

    const report = await follow();

    expect(report.outcome).toBe("failed");
    expect(report.stoppedBecause).toMatch(/No route file was found .* at 122b761274a9/);
    expect(report.commitSha).toBe(COMMIT_1);
    expect(db.tables.modules).toEqual([]);
  });
});

describe("the follow never runs beside another detection or a reset", () => {
  it("waits while a person's detection is running, and leaves no run behind", async () => {
    seed({
      module_detection_runs: [
        {
          id: "r-person",
          status: "running",
          parameters: { strategy: "feature-first" },
          initiated_by: ADMIN,
          started_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    const report = await follow();

    expect(report.outcome).toBe("skipped");
    expect(report.stoppedBecause).toMatch(/Detection run r-person has been running/);
    expect(db.tables.module_detection_runs).toHaveLength(1);
    expect(detections).toBe(0);
    expect(audits()).toEqual([]);
  });

  it("closes its own run that died still saying running, and detects afresh", async () => {
    seed({
      module_detection_runs: [
        {
          id: "r-died",
          status: "running",
          commit_sha: COMMIT_1,
          parameters: { follow: true },
          started_at: new Date(Date.now() - RUNNING_RUN_WINDOW_MS - 60_000).toISOString(),
        },
      ],
    });

    const report = await follow();

    expect(report.closedStale).toEqual(["r-died"]);
    expect(db.tables.module_detection_runs.find((r) => r.id === "r-died")).toMatchObject({
      status: "failed",
      error_message: expect.stringMatching(/ended before it settled/),
    });
    expect(report.outcome).toBe("settled");
    expect(report.attempt).toBe(2);
  });
});

describe("what the follow could not read, it says", () => {
  it("records a head it could not read, and detects nothing", async () => {
    prime.branchFails = true;

    const report = await follow();

    expect(report.outcome).toBe("failed");
    expect(report.stoppedBecause).toBe("The prime's head could not be read: Bad Gateway");
    expect(detections).toBe(0);
    expect(audits()).toHaveLength(1);
  });

  it("records detection runs it could not read, rather than taking none as the follow's", async () => {
    db.failures.set("module_detection_runs.select", STATEMENT_TIMEOUT);

    const report = await follow();

    expect(report.outcome).toBe("failed");
    expect(report.stoppedBecause).toMatch(/detection runs could not be read/);
    expect(detections).toBe(0);
  });
});

describe("which commit the catalogue is settled at, for provisioning", () => {
  it("is the follow's last settled run", async () => {
    await follow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double
    expect(await catalogueSettledAt(db as any)).toEqual({
      runId: followRuns()[0].id,
      commitSha: COMMIT_1,
    });
  });

  it("is nobody's where no follow has settled it, nor where the runs cannot be read", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double
    expect(await catalogueSettledAt(db as any)).toBeNull();
    await follow();
    db.failures.set("module_detection_runs.select", STATEMENT_TIMEOUT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double
    expect(await catalogueSettledAt(db as any)).toBeNull();
  });
});

describe("the follow's detection, beside a person's", () => {
  const detectOnce = (follow: boolean) =>
    runDetection({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double
      supabase: db as any,
      userId: follow ? null : ADMIN,
      config: { ...DEFAULT_CONFIG, deltaMode: false, follow },
    });

  beforeEach(() => seed({ modules: [oldModule("clients")] }));

  it("leaves the run running for the follow to settle, and says what it found at which commit", async () => {
    const result = await detectOnce(true);

    expect(result).toMatchObject({ ok: true, commitSha: COMMIT_1 });
    expect([...(result.detectedSlugs ?? [])].sort()).toEqual(FOUND);
    expect(followRuns()[0]).toMatchObject({ status: "running", completed_at: null });
  });

  it("a person's leaves an approved module's files as they were, and completes", async () => {
    const result = await detectOnce(false);

    expect(result.ok).toBe(true);
    expect(moduleOf("clients")).toMatchObject({
      resolved_files: ["src/old/clients.tsx"],
      detection_run_id: OLD_RUN,
    });
    expect(db.tables.module_detection_runs.find((r) => r.id === result.runId)?.status).toBe(
      "completed",
    );
  });

  it("stops at a module write that did not land, rather than settle what it did not write", async () => {
    db.failures.set("modules.update", STATEMENT_TIMEOUT);

    const result = await detectOnce(true);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "The module clients was not written: canceling statement due to statement timeout",
    );
    expect(result.commitSha).toBe(COMMIT_1);
    expect(db.tables.module_detection_runs.find((r) => r.id === result.runId)?.status).toBe(
      "failed",
    );
  });

  it("stops at a module it could not read, rather than write a second one of its slug", async () => {
    db.failures.set("modules.select", STATEMENT_TIMEOUT);

    const result = await detectOnce(true);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be read: canceling statement due to statement timeout/);
    expect(db.tables.modules.map((m) => m.slug)).toEqual(["clients"]);
  });
});

describe("the follow keeps the diagnostics of the catalogue it settles, and of nothing older", () => {
  const PERSON_RUN = "31a7e000-0000-4000-8000-000000000003";
  const DIED_RUN = "31a7e000-0000-4000-8000-000000000004";
  const diagnostics = (runId: string, n = 2) => ({
    module_backend_artifacts: Array.from({ length: n }, (_, i) => ({
      id: `a-${runId.slice(-4)}-${i}`,
      detection_run_id: runId,
      module_id: "m-clients",
      module_slug: "clients",
      artifact_kind: "table",
      identifier: `t${i}`,
    })),
    module_import_edges: Array.from({ length: n }, (_, i) => ({
      id: `e-${runId.slice(-4)}-${i}`,
      detection_run_id: runId,
      source_file: `src/a${i}.ts`,
      target_file: `src/b${i}.ts`,
    })),
    module_drift_alerts: Array.from({ length: n }, (_, i) => ({
      id: `d-${runId.slice(-4)}-${i}`,
      detection_run_id: runId,
      alert_type: "orphan_file",
    })),
  });
  const rowsOf = (runId: unknown) =>
    (["module_backend_artifacts", "module_import_edges", "module_drift_alerts"] as const).reduce(
      (n, t) => n + db.tables[t].filter((r) => r.detection_run_id === runId).length,
      0,
    );

  beforeEach(() => {
    const july = diagnostics(OLD_RUN);
    const person = diagnostics(PERSON_RUN);
    const died = diagnostics(DIED_RUN);
    seed({
      modules: [oldModule("clients")],
      module_detection_runs: [
        { id: OLD_RUN, status: "completed", commit_sha: null, started_at: "2026-07-31T23:13:41Z" },
        {
          id: PERSON_RUN,
          status: "failed",
          parameters: { strategy: "feature-first" },
          started_at: "2026-08-02T10:00:00Z",
        },
        // A person's run that died still saying running, past the window.
        {
          id: DIED_RUN,
          status: "running",
          parameters: { strategy: "feature-first" },
          started_at: "2026-08-03T10:00:00Z",
        },
      ],
      module_backend_artifacts: [
        ...july.module_backend_artifacts,
        ...person.module_backend_artifacts,
        ...died.module_backend_artifacts,
      ],
      module_import_edges: [
        ...july.module_import_edges,
        ...person.module_import_edges,
        ...died.module_import_edges,
      ],
      module_drift_alerts: [
        ...july.module_drift_alerts,
        ...person.module_drift_alerts,
        ...died.module_drift_alerts,
      ],
    });
  });

  it("prunes every earlier finished run's diagnostics once it settles, and keeps its own", async () => {
    const report = await follow();
    const [run] = followRuns();

    expect(report.outcome).toBe("settled");
    expect([...report.pruned].sort()).toEqual([OLD_RUN, PERSON_RUN].sort());
    expect(rowsOf(OLD_RUN)).toBe(0);
    expect(rowsOf(PERSON_RUN)).toBe(0);
    expect(rowsOf(run.id)).toBeGreaterThan(0);
    // A run still saying running keeps every row, and every run keeps its own row.
    expect(rowsOf(DIED_RUN)).toBe(6);
    expect(db.tables.module_detection_runs.map((r) => r.id)).toEqual(
      expect.arrayContaining([OLD_RUN, PERSON_RUN, DIED_RUN, run.id]),
    );
    expect((audits()[0].metadata as { pruned: string[] }).pruned.sort()).toEqual(
      [OLD_RUN, PERSON_RUN].sort(),
    );
  });

  it("keeps the settled catalogue's diagnostics when it holds", async () => {
    seed({
      modules: Array.from({ length: 12 }, (_, i) => oldModule(`old-${i}`)),
      module_detection_runs: [
        { id: OLD_RUN, status: "completed", commit_sha: null, started_at: "2026-07-31T23:13:41Z" },
        {
          id: PERSON_RUN,
          status: "failed",
          parameters: { strategy: "feature-first" },
          started_at: "2026-08-02T10:00:00Z",
        },
      ],
      ...(() => {
        const july = diagnostics(OLD_RUN);
        const person = diagnostics(PERSON_RUN);
        return {
          module_backend_artifacts: [
            ...july.module_backend_artifacts,
            ...person.module_backend_artifacts,
          ],
          module_import_edges: [...july.module_import_edges, ...person.module_import_edges],
          module_drift_alerts: [...july.module_drift_alerts, ...person.module_drift_alerts],
        };
      })(),
    });

    const report = await follow();

    expect(report.outcome).toBe("held");
    expect(report.pruned).toEqual([PERSON_RUN]);
    expect(rowsOf(OLD_RUN)).toBe(6);
    expect(rowsOf(PERSON_RUN)).toBe(0);
  });

  it("says so, and settles anyway, where a prune's delete fails", async () => {
    deps.detect = async (args) => {
      detections++;
      const result = await FOLLOW_DEPS.detect(args);
      db.failures.set("module_drift_alerts.delete", STATEMENT_TIMEOUT);
      return result;
    };

    const report = await follow();

    expect(report.outcome).toBe("settled");
    expect(report.warnings).toEqual([
      "Earlier runs' module_drift_alerts were not all pruned: canceling statement due to statement timeout",
    ]);
  });
});

describe("a module that changed while the follow settled is not approved under its run", () => {
  it("leaves a module a person archived mid-settle archived, and fails the run", async () => {
    const from = db.from.bind(db);
    let flipped = false;
    db.from = (table: string) => {
      const builder = from(table);
      if (table !== "modules") return builder;
      const update = builder.update;
      builder.update = (values: Row) => {
        if (values.status === "approved" && !flipped) {
          flipped = true;
          const reports = db.tables.modules.find((m) => m.slug === "reports");
          if (reports)
            Object.assign(reports, { status: "archived", archived_by_follow_run_id: null });
        }
        return update(values);
      };
      return builder;
    };

    const report = await follow();

    expect(report.outcome).toBe("failed");
    expect(report.stoppedBecause).toMatch(
      /because they changed while the follow settled: reports$/,
    );
    expect(moduleOf("reports")).toMatchObject({
      status: "archived",
      archived_by_follow_run_id: null,
    });
    expect(db.tables.module_library).toEqual([]);
  });
});
