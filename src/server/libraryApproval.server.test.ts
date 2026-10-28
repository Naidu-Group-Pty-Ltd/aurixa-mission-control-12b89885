/**
 * Publishing and approving library entries (D19), asserted on what the double
 * HOLDS afterwards rather than on the answer alone: the risk in an approval
 * path is a refusal that still wrote, or an entry approved without the commit
 * it should record.
 *
 * Both publication paths are driven: `publishModulesToLibrary`, which the
 * Modules tab's Publish calls, and `publishAllToLibrary`, the re-ingest's.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  STATEMENT_TIMEOUT,
  createLibraryFakeDb,
  type LibraryFakeDb,
  type Row,
} from "./testing/libraryFakes";
import {
  decideLibraryEntries,
  decideLibraryEntry,
  publishModulesToLibrary,
  readModuleLibrary,
} from "./libraryApproval.server";
import { publishAllToLibrary } from "./library-reingest.server";

const ADMIN = "a1a1a1a1-0000-4000-8000-0000000000aa";
const OPERATOR = "b2b2b2b2-0000-4000-8000-0000000000bb";
const COMMIT = "4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";
const NEW_RUN = "0a3c9817-0000-4000-8000-000000000001";
const OLD_RUN = "31a7e000-0000-4000-8000-000000000002";
const AML = "m0000000-0000-4000-8000-000000000001";
const CRM = "m0000000-0000-4000-8000-000000000002";

let db: LibraryFakeDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder these modules use
const client = () => db as any;

function moduleRow(
  id: string,
  slug: string,
  name: string,
  runId: string,
  status = "proposed",
): Row {
  return {
    id,
    slug,
    name,
    status,
    description: `${name} module`,
    routes: [`/${slug}`],
    route_entry_file: `src/routes/${slug}.tsx`,
    resolved_files: [`src/routes/${slug}.tsx`],
    file_globs: [`src/components/${slug}/**`],
    backend_file_globs: [`supabase/functions/${slug}-api/**`],
    detection_run_id: runId,
    layer: "fullstack",
    cohesion_score: 0.8,
    coupling_score: 0.2,
    ai_confidence: 1,
    ai_reasoning: "Feature-first detection",
    shared_by_modules: [],
    edge_functions: [`${slug}-api`],
    database_tables: [],
    required_secrets: [],
    required_migrations: [],
    storage_buckets: [],
    cron_jobs: [],
  };
}

function seed(extra: Partial<Record<string, Row[]>> = {}) {
  db = createLibraryFakeDb({
    user_roles: [
      { id: "r1", user_id: ADMIN, role: "admin" },
      { id: "r2", user_id: OPERATOR, role: "operator" },
    ],
    profiles: [{ id: "p1", user_id: ADMIN, display_name: "Sanjay Naidu" }],
    module_detection_runs: [
      { id: NEW_RUN, commit_sha: COMMIT, created_at: "2026-10-28T09:00:00Z", status: "completed" },
      { id: OLD_RUN, commit_sha: null, created_at: "2026-07-31T22:24:01Z", status: "completed" },
    ],
    modules: [
      moduleRow(AML, "aml", "AML Command Centre", NEW_RUN),
      moduleRow(CRM, "crm", "CRM Pipeline", OLD_RUN, "approved"),
    ],
    ...extra,
  });
}

beforeEach(() => seed());

const library = () => db.tables.module_library;
const libraryWrites = () => db.writes.filter((w) => w.table === "module_library");

describe("publishing is approving, by an admin", () => {
  it("refuses an operator who is not an admin, and writes nothing", async () => {
    const answer = await publishModulesToLibrary(client(), {
      userId: OPERATOR,
      moduleIds: [AML],
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe(
      "Admin role required to publish library entries, which approves them",
    );
    expect(db.writes).toEqual([]);
  });

  it("refuses when the role could not be read, and says it could not", async () => {
    db.failures.set("rpc.has_role", STATEMENT_TIMEOUT);
    const answer = await publishModulesToLibrary(client(), { userId: ADMIN, moduleIds: [AML] });
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/^Could not check whether you may publish library entries/);
    expect(answer.error).toContain("canceling statement due to statement timeout");
    expect(db.writes).toEqual([]);
  });

  it("writes the entry approved, by its publisher, at its run's commit, in the one insert", async () => {
    const answer = await publishModulesToLibrary(client(), {
      userId: ADMIN,
      moduleIds: [AML],
      tagsFor: () => ["core"],
    });
    expect(answer).toMatchObject({ ok: true, published: 1, refused: [], warnings: [] });

    const inserts = libraryWrites().filter((w) => w.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].rows[0]).toMatchObject({
      slug: "aml",
      version: 1,
      approval_status: "approved",
      approved_by: ADMIN,
      published_by: ADMIN,
      source_commit_sha: COMMIT,
      source_detection_run_id: NEW_RUN,
      source_module_id: AML,
      is_latest: true,
      tags: ["core"],
    });
    expect(inserts[0].rows[0].approved_at).toBe(inserts[0].rows[0].published_at);
    // Approved in the insert itself: no later write sets the approval.
    expect(libraryWrites().filter((w) => w.op === "update")).toEqual([
      expect.objectContaining({ rows: [] }),
    ]);
    expect(answer.entries).toEqual([
      expect.objectContaining({ slug: "aml", version: 1, source_commit_sha: COMMIT }),
    ]);
  });

  it("refuses, by name, a module whose detection run recorded no commit, and publishes the rest", async () => {
    const answer = await publishModulesToLibrary(client(), {
      userId: ADMIN,
      moduleIds: [AML, CRM],
    });
    expect(answer.ok).toBe(true);
    expect(answer.published).toBe(1);
    expect(answer.refused).toEqual([
      {
        moduleId: CRM,
        slug: "crm",
        reason: expect.stringContaining(
          "CRM Pipeline (crm): its files were detected by run 31a7e000 on 31 Jul 2026, which recorded no commit",
        ),
      },
    ]);
    expect(library().map((e) => e.slug)).toEqual(["aml"]);
    expect(library().every((e) => e.source_commit_sha === COMMIT)).toBe(true);
  });

  it("publishes nothing, and says so, when every module is refused", async () => {
    const answer = await publishModulesToLibrary(client(), { userId: ADMIN, moduleIds: [CRM] });
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(
      /^Nothing was published: 1 module\(s\) refused\. CRM Pipeline \(crm\)/,
    );
    expect(library()).toEqual([]);
  });

  it("treats a failed read of the detection runs as an error, never as no commit", async () => {
    db.failures.set("module_detection_runs.select", STATEMENT_TIMEOUT);
    const answer = await publishModulesToLibrary(client(), {
      userId: ADMIN,
      moduleIds: [AML, CRM],
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(
      /^Could not read the detection runs these modules were detected by/,
    );
    expect(answer.refused).toEqual([]);
    expect(libraryWrites()).toEqual([]);
  });

  it("refuses on a database without the commit columns, naming the migration", async () => {
    db = createLibraryFakeDb(
      {
        user_roles: [{ id: "r1", user_id: ADMIN, role: "admin" }],
        module_detection_runs: [{ id: NEW_RUN, created_at: "2026-10-28T09:00:00Z" }],
        modules: [moduleRow(AML, "aml", "AML Command Centre", NEW_RUN)],
      },
      { schema: "before" },
    );
    const answer = await publishModulesToLibrary(client(), { userId: ADMIN, moduleIds: [AML] });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("column module_detection_runs.commit_sha does not exist");
    expect(answer.error).toContain(
      "migration 20261028120000_library_entries_record_their_commit has not been applied",
    );
    expect(db.writes).toEqual([]);
  });

  it("numbers the entry after the slug's last version, and supersedes it only once written", async () => {
    seed({
      module_library: [
        {
          id: "old-entry",
          slug: "aml",
          name: "AML Command Centre",
          entry_file: "src/routes/aml.tsx",
          version: 1,
          is_latest: true,
          approval_status: "pending",
          source_commit_sha: null,
        },
      ],
    });
    const answer = await publishModulesToLibrary(client(), { userId: ADMIN, moduleIds: [AML] });
    expect(answer.ok).toBe(true);
    const byVersion = Object.fromEntries(library().map((e) => [e.version, e]));
    expect(byVersion[2]).toMatchObject({ is_latest: true, approval_status: "approved" });
    // The pending entry is superseded, not approved and not deleted.
    expect(byVersion[1]).toMatchObject({
      id: "old-entry",
      is_latest: false,
      approval_status: "pending",
      source_commit_sha: null,
    });
    expect(libraryWrites().map((w) => w.op)).toEqual(["insert", "update"]);
  });

  it("refuses a module whose versions could not be read, rather than numbering it v1", async () => {
    db.failures.set("module_library.select", STATEMENT_TIMEOUT);
    const answer = await publishModulesToLibrary(client(), { userId: ADMIN, moduleIds: [AML] });
    expect(answer.ok).toBe(false);
    expect(answer.refused[0].reason).toMatch(/could not read its published versions/);
    expect(libraryWrites()).toEqual([]);
  });

  it("keeps the audit row and sends one approval notice naming the commit", async () => {
    await publishModulesToLibrary(client(), { userId: ADMIN, moduleIds: [AML, CRM] });
    const audit = db.tables.audit_log;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "module.publish_to_library",
      entity_type: "module_library",
      actor_user_id: ADMIN,
    });
    const metadata = audit[0].metadata as Record<string, unknown>;
    expect(metadata.published).toEqual([
      expect.objectContaining({ slug: "aml", version: 1, source_commit_sha: COMMIT }),
    ]);
    expect(metadata.refused).toEqual([expect.objectContaining({ slug: "crm" })]);

    expect(db.tables.notifications).toEqual([
      expect.objectContaining({
        kind: "library_entry_approved",
        severity: "success",
        title: "Library approved · AML Command Centre v1",
        body: "Approved at prime@4f1c2d3. Now available for pinning to clones.",
        url: "/modules",
      }),
    ]);
  });
});

describe("the re-ingest's publication", () => {
  it("refuses an operator who is not an admin", async () => {
    const answer = await publishAllToLibrary(client(), OPERATOR);
    expect(answer.count).toBe(0);
    expect(answer.errors).toEqual([
      "Admin role required to publish library entries, which approves them",
    ]);
    expect(library()).toEqual([]);
  });

  it("approves each approved module's entry at its commit, and names the one without", async () => {
    seed({
      modules: [
        moduleRow(AML, "aml", "AML Command Centre", NEW_RUN, "approved"),
        moduleRow(CRM, "crm", "CRM Pipeline", OLD_RUN, "approved"),
      ],
    });
    const answer = await publishAllToLibrary(client(), ADMIN);
    expect(answer.count).toBe(1);
    expect(answer.errors).toEqual([expect.stringContaining("CRM Pipeline (crm)")]);
    expect(library()).toEqual([
      expect.objectContaining({
        slug: "aml",
        version: 1,
        approval_status: "approved",
        approved_by: ADMIN,
        source_commit_sha: COMMIT,
        tags: ["fullstack"],
      }),
    ]);
  });
});

describe("approving an entry already published", () => {
  const entry = (id: string, commit: string | null, status = "pending"): Row => ({
    id,
    slug: id,
    name: `Entry ${id}`,
    entry_file: `src/routes/${id}.tsx`,
    version: 1,
    approval_status: status,
    source_commit_sha: commit,
  });

  it("refuses an entry that records no commit, and writes nothing", async () => {
    seed({ module_library: [entry("legacy", null)] });
    const answer = await decideLibraryEntry(client(), {
      userId: ADMIN,
      entryId: "legacy",
      status: "approved",
    });
    expect(answer).toEqual({
      ok: false,
      error: expect.stringMatching(/^Entry legacy v1 records no commit, so it cannot be approved/),
    });
    expect(library()[0].approval_status).toBe("pending");
    expect(db.writes).toEqual([]);
  });

  it("approves one that records its commit, and says so in the bell with the commit", async () => {
    seed({ module_library: [entry("fresh", COMMIT, "rejected")] });
    const answer = await decideLibraryEntry(client(), {
      userId: ADMIN,
      entryId: "fresh",
      status: "approved",
    });
    expect(answer).toEqual({ ok: true });
    expect(library()[0]).toMatchObject({ approval_status: "approved", approved_by: ADMIN });
    expect(db.tables.notifications[0]).toMatchObject({
      kind: "library_entry_approved",
      body: "Approved at prime@4f1c2d3. Now available for pinning to clones.",
    });
  });

  it("still lets an entry without a commit be rejected", async () => {
    seed({ module_library: [entry("legacy", null)] });
    const answer = await decideLibraryEntry(client(), {
      userId: ADMIN,
      entryId: "legacy",
      status: "rejected",
      reason: "Superseded by the 28 Oct detection",
    });
    expect(answer).toEqual({ ok: true });
    expect(library()[0]).toMatchObject({
      approval_status: "rejected",
      rejection_reason: "Superseded by the 28 Oct detection",
    });
  });

  it("refuses a bulk approval naming each entry without a commit, and approves none", async () => {
    seed({ module_library: [entry("fresh", COMMIT), entry("legacy", null)] });
    const answer = await decideLibraryEntries(client(), {
      userId: ADMIN,
      ids: ["fresh", "legacy"],
      status: "approved",
    });
    expect(answer.ok).toBe(false);
    expect(!answer.ok && answer.error).toMatch(
      /^Nothing was approved: 1 of the 2 entries cannot be/,
    );
    expect(!answer.ok && answer.error).toContain("Entry legacy v1 records no commit");
    expect(library().map((e) => e.approval_status)).toEqual(["pending", "pending"]);
  });

  it("refuses an operator who is not an admin", async () => {
    seed({ module_library: [entry("fresh", COMMIT)] });
    const answer = await decideLibraryEntry(client(), {
      userId: OPERATOR,
      entryId: "fresh",
      status: "approved",
    });
    expect(answer).toEqual({ ok: false, error: "Admin role required to approve library entries" });
    expect(db.writes).toEqual([]);
  });
});

describe("reading the library", () => {
  it("returns every entry, past the 200 the panel used to stop at", async () => {
    const entries = Array.from({ length: 1234 }, (_, i) => ({
      id: `e${String(i).padStart(4, "0")}`,
      slug: `module-${String(i % 617).padStart(3, "0")}`,
      name: `Module ${String(i % 617).padStart(3, "0")}`,
      entry_file: "src/routes/x.tsx",
      version: i < 617 ? 1 : 2,
      approval_status: i < 617 ? "pending" : "approved",
      approved_by: i < 617 ? null : ADMIN,
      source_commit_sha: i < 617 ? null : COMMIT,
    }));
    seed({ module_library: entries });
    const read = await readModuleLibrary(client(), { latestOnly: false });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries).toHaveLength(1234);
    // Name, then the newest version first, as the panel groups them.
    expect(read.entries.slice(0, 2).map((e) => [e.name, e.version])).toEqual([
      ["Module 000", 2],
      ["Module 000", 1],
    ]);
    expect(read.approvers).toEqual({ [ADMIN]: "Sanjay Naidu" });
    expect(read.approversError).toBeNull();
  });

  it("says when the approvers' names could not be read, and still returns the entries", async () => {
    seed({
      module_library: [
        {
          id: "e1",
          slug: "aml",
          name: "AML",
          entry_file: "src/routes/aml.tsx",
          approval_status: "approved",
          approved_by: ADMIN,
          source_commit_sha: COMMIT,
        },
      ],
    });
    db.failures.set("profiles.select", STATEMENT_TIMEOUT);
    const read = await readModuleLibrary(client(), { latestOnly: false });
    expect(read).toMatchObject({
      ok: true,
      approvers: {},
      approversError: "canceling statement due to statement timeout",
    });
    expect(read.entries).toHaveLength(1);
  });
});
