/**
 * Library entries are approved at publication, by an admin, at a recorded
 * commit (docs/DELIVERY_SYSTEM_PLAN.md, D19), held at the source.
 *
 * ## Why at the source
 *
 * The rule holds only if EVERY path that writes an entry, or its approval,
 * comes through `libraryApproval.server.ts`. The unit tests can prove that
 * module right while a third button writes `module_library` beside it, which
 * is how this started: two publication paths, each writing its own entries,
 * neither approving one or recording a commit. So the writers are DERIVED from
 * the source, comments stripped, rather than listed: a new insert into
 * `module_library` fails here the day it is added.
 *
 * And the commit is used, not just stored (a field with no call site is not
 * shipped): detection writes it, publication reads it, a delivery's summary
 * and the pin check report it, and the Library tab shows it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMIT_COLUMNS_MIGRATION } from "./libraryApproval.pure";
import { stripComments } from "./sourceComments.pure";

/** Every production module under `src/`, as code (comments removed, strings kept). */
function productionSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "testing") walk(p);
      } else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith("types.ts")) {
        out.set(p, stripComments(readFileSync(p, "utf8")));
      }
    }
  };
  walk("src");
  return out;
}

const SOURCES = productionSources();
const PUBLISHER = "src/server/libraryApproval.server.ts";

function source(file: string): string {
  const src = SOURCES.get(file);
  if (src === undefined) throw new Error(`${file} is not in the scanned sources`);
  return src;
}

/** The body of `export const <name> = …` up to the next top-level export. */
function exported(file: string, name: string): string {
  const src = source(file);
  const start = src.indexOf(`export const ${name} =`);
  if (start === -1) throw new Error(`${name} is not exported from ${file}`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

type Write = { file: string; op: string; payload: string };

/** Every chained write on `module_library`: `.from("module_library")` then its first operation. */
function libraryWrites(): Write[] {
  const writes: Write[] = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(
      /\.from\("module_library"\)\s*\.(insert|upsert|update|delete)\(([\s\S]{0,300})/g,
    )) {
      writes.push({ file, op: m[1], payload: m[2] });
    }
  }
  return writes;
}

describe("who writes a library entry", () => {
  it("one module inserts entries, and nothing else does", () => {
    const inserts = libraryWrites().filter((w) => w.op === "insert" || w.op === "upsert");
    expect(inserts.length).toBeGreaterThan(0);
    expect([...new Set(inserts.map((w) => w.file))]).toEqual([PUBLISHER]);
  });

  it("no other module writes an entry's approval or its commit", () => {
    const elsewhere = libraryWrites().filter((w) => w.op === "update" && w.file !== PUBLISHER);
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const w of elsewhere) {
      // An update elsewhere names its columns in a literal, and none of them is these.
      expect(w.payload.trimStart().startsWith("{"), `${w.file}: ${w.payload.slice(0, 60)}`).toBe(
        true,
      );
      const literal = w.payload.slice(0, w.payload.indexOf("}") + 1);
      expect(literal, w.file).not.toMatch(/approval_status|approved_by|source_commit_sha/);
    }
  });

  it("the Modules tab's Publish and the re-ingest both publish through it", () => {
    expect(exported("src/server/ai-detect-modules.functions.ts", "publishToLibrary")).toContain(
      "publishModulesToLibrary(context.supabase, {",
    );
    const reingest = source("src/server/library-reingest.server.ts");
    const all = reingest.slice(reingest.indexOf("export async function publishAllToLibrary("));
    expect(all).toContain("publishModulesToLibrary(supabase, {");
    expect(all).toContain('moduleIds: "approved"');
  });

  it("every approval decision is the shared one, which needs the commit", () => {
    expect(exported("src/server/library-admin.functions.ts", "setLibraryApprovalStatus")).toContain(
      "decideLibraryEntry(context.supabase, {",
    );
    expect(exported("src/server/bulk-ops.functions.ts", "bulkSetLibraryApproval")).toContain(
      "decideLibraryEntries(context.supabase, {",
    );
    const publisher = source(PUBLISHER);
    expect(publisher.match(/judgeApproval\(/g)?.length).toBe(2);
    // Both writes are held to a recorded commit when they approve.
    expect(publisher.match(/await whereCommitRecordedIf\(/g)?.length).toBe(2);
    expect(publisher).toContain(
      'return approving ? query.not("source_commit_sha", "is", null) : query;',
    );
  });

  it("the re-ingest asks for an admin, and for the commit columns, before it wipes", () => {
    const reingest = source("src/server/library-reingest.server.ts");
    const wipe = reingest.search(/from\("clone_library_pins"\)\.delete/);
    expect(wipe).toBeGreaterThan(-1);
    expect(reingest.indexOf("await requireLibraryAdmin(")).toBeGreaterThan(-1);
    expect(reingest.indexOf("await requireLibraryAdmin(")).toBeLessThan(wipe);
    expect(reingest.indexOf("await probeCommitColumns(supabase)")).toBeGreaterThan(-1);
    expect(reingest.indexOf("await probeCommitColumns(supabase)")).toBeLessThan(wipe);
  });
});

describe("a pin rests on an approved entry's commit", () => {
  it("is set only where the shared judge allows it", () => {
    for (const name of ["setCloneLibraryPin", "bulkApplyClonePins"]) {
      const body = exported("src/server/library-admin.functions.ts", name);
      expect(body, name).toContain("judgePinnable(");
      expect(body, name).toContain("source_commit_sha");
    }
  });

  it("is checked by one module, for the page and the pass alike", () => {
    expect(exported("src/server/library-admin.functions.ts", "validateClonePins")).toContain(
      "validateClonePinsServer(context.supabase, data.cloneIds)",
    );
    expect(source("src/server/cascade-engine.server.ts")).toContain(
      "await validateClonePinsServer(supabase, cloneIds)",
    );
    expect(source("src/server/library-validation.server.ts")).toContain("judgeClonePins(");
  });

  it("is named with its commit in a delivery's summary", () => {
    const installed = source("src/server/cascade/installedGlobs.server.ts");
    expect(installed).toContain('.select("id, file_paths, source_commit_sha")');
    expect(installed).toContain(
      "honored.push(pinLabel({ slug, version: pin.version, commitSha: pin.commitSha }));",
    );
  });
});

describe("detection records the commit it read", () => {
  const detection = source("src/server/module-detection.server.ts");

  it("takes the commit from the branch it reads the tree of", () => {
    const fetch = detection.slice(
      detection.indexOf("async function fetchRepoTree("),
      detection.indexOf("const ROOT_DOT_NOISE"),
    );
    expect(fetch).toContain("const commitSha = branch.commit.sha;");
    expect(fetch).toContain("return { files, treeHash, shaByPath, sizeByPath, commitSha };");
  });

  it("records it on the run, or fails the run, before a module is written", () => {
    const run = detection.slice(detection.indexOf("export async function runDetection("));
    const record = run.indexOf(".update({ commit_sha: commitSha })");
    expect(record).toBeGreaterThan(-1);
    expect(run.slice(record, record + 400)).toMatch(/if \(commitErr\) \{\s*throw new Error\(/);
    expect(record).toBeLessThan(run.indexOf('.from("modules")'));
  });

  it("reads every file at that commit, not at the branch", () => {
    const run = detection.slice(detection.indexOf("export async function runDetection("));
    const pinned = run.indexOf("const ref: RepoRef = { ...branchRef, branch: commitSha };");
    expect(pinned).toBeGreaterThan(-1);
    // The first read is the trace's prefetch, and it reads at the pinned ref.
    const firstRead = run.indexOf("await prefetchTraceSources({");
    expect(firstRead).toBeGreaterThan(-1);
    expect(pinned).toBeLessThan(firstRead);
    expect(run.slice(firstRead, firstRead + 120)).toMatch(/\bref,/);
  });
});

describe("the Library tab shows each entry's commit and approver", () => {
  const page = source("src/routes/modules.tsx");

  it("on every entry, and on every detection run", () => {
    expect(page).toContain(
      "const commit = primeCommitLabel(e.source_commit_sha as string | null);",
    );
    expect(page).toContain("approved by {approver}");
    expect(page).toContain("no commit recorded");
    expect(page).toContain("primeCommitLabel(r.commit_sha as string | null)");
  });

  it("and offers Approve only on an entry that records its commit", () => {
    const approve = page.indexOf('onClick={() => decide(e.id as string, "approved")}');
    expect(approve).toBeGreaterThan(-1);
    expect(page.slice(approve - 200, approve)).toContain("{commit ? (");
  });
});

describe("the migration the refusals name", () => {
  const file = `supabase/migrations/${COMMIT_COLUMNS_MIGRATION}.sql`;

  it("exists, so a refusal that names it points at something", () => {
    expect(existsSync(file)).toBe(true);
  });

  it("adds both columns, nullable and re-runnable, and writes no row", () => {
    const sql = readFileSync(file, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).toMatch(
      /ALTER TABLE public\.module_detection_runs\s+ADD COLUMN IF NOT EXISTS commit_sha text;/,
    );
    expect(sql).toMatch(
      /ALTER TABLE public\.module_library\s+ADD COLUMN IF NOT EXISTS source_commit_sha text;/,
    );
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
  });

  it("holds every writer to the rule: an approved entry records a commit, and a run a commit or nothing", () => {
    // Row-level security lets an operator write both tables directly, so the
    // rule is the database's as well as this code's. A CHECK whose expression
    // is NULL passes, so the entry's must not be able to come out NULL.
    const sql = readFileSync(file, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).toMatch(
      /ADD CONSTRAINT module_library_approved_at_a_commit\s+CHECK \(approval_status <> 'approved' OR coalesce\(source_commit_sha ~ '\^\[0-9a-f\]\{40\}\$', false\)\);/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT module_detection_runs_commit_sha_is_a_commit\s+CHECK \(commit_sha IS NULL OR commit_sha ~ '\^\[0-9a-f\]\{40\}\$'\);/,
    );
    // Re-runnable: each is added only where it is absent.
    expect(sql.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/g)?.length).toBe(2);
  });
});
