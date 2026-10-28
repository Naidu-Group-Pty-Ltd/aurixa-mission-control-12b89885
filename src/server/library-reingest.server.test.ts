/**
 * The library reset (D19), asserted on what the double HOLDS afterwards and
 * the order its writes landed in. The risk in a reset is the gap between its
 * wipe and its restore: a reset that dies there, or fails a write there, must
 * leave a record of what to restore, and a reset must never run beside
 * another reset or a detection, which would wipe what they are writing.
 *
 * Detection is replaced by one that writes what a run writes (a completed run
 * at a commit, and its modules naming it), so the reset's own steps run on the
 * double as written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATEMENT_TIMEOUT,
  createLibraryFakeDb,
  type LibraryFakeDb,
  type Row,
} from "./testing/libraryFakes";

const detection = vi.hoisted(() => ({
  slugs: ["aml", "clients"] as string[],
  fail: null as string | null,
}));

vi.mock("./module-detection.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./module-detection.server")>();
  return {
    ...actual,
    runDetection: vi.fn(
      async (args: {
        supabase: {
          from: (t: string) => {
            insert: (r: unknown) => PromiseLike<{ error: { message: string } | null }>;
          };
        };
      }) => {
        const runId = "0a3c9817-0000-4000-8000-0000000000f1";
        // A run that could not write what it found says so, as runDetection's own writes do.
        const write = async (table: string, row: unknown) => {
          const { error } = await args.supabase.from(table).insert(row);
          if (error) throw new Error(`${table}: ${error.message}`);
        };
        if (detection.fail) {
          return {
            ok: false,
            runId,
            proposed: 0,
            inserted: 0,
            updated: 0,
            orphanAlerts: 0,
            error: detection.fail,
          };
        }
        await write("module_detection_runs", {
          status: "completed",
          strategy: "feature-first",
          commit_sha: "122b761274a9c5ef98207b16b5e02a5d7cfeb37e",
        });
        for (const slug of detection.slugs) {
          await write("modules", {
            name: slug,
            slug,
            status: "proposed",
            layer: "fullstack",
            file_globs: [`src/components/${slug}/**`],
            resolved_files: [`src/routes/${slug}.tsx`],
            detection_run_id: runId,
            backend_manifest: { detection_run_id: runId },
          });
        }
        return {
          ok: true,
          runId,
          proposed: detection.slugs.length,
          inserted: detection.slugs.length,
          updated: 0,
          orphanAlerts: 0,
        };
      },
    ),
  };
});

import {
  catalogueCompetitor,
  readResetState,
  resetAndReingestLibrary,
  RESET_CONFIRMATION,
} from "./library-reingest.server";
import { RUNNING_RUN_WINDOW_MS } from "./module-detection.server";

const ADMIN = "a1a1a1a1-0000-4000-8000-0000000000aa";
const CLONE_A = "c0000000-0000-4000-8000-00000000000a";
const CLONE_B = "c0000000-0000-4000-8000-00000000000b";
const OLD_RUN = "31a7e000-0000-4000-8000-000000000002";
const AML = "m0000000-0000-4000-8000-000000000001";
const CLIENTS = "m0000000-0000-4000-8000-000000000002";
const BOTH = { [CLONE_A]: ["aml", "clients"], [CLONE_B]: ["aml"] };

let db: LibraryFakeDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the double is the slice of the builder these modules use
const client = () => db as any;

const moduleRow = (id: string, slug: string): Row => ({
  id,
  slug,
  name: slug,
  status: "approved",
  layer: "fullstack",
  file_globs: [`src/components/${slug}/**`],
  detection_run_id: OLD_RUN,
  backend_manifest: {},
});

function seed(extra: Partial<Record<string, Row[]>> = {}) {
  db = createLibraryFakeDb({
    user_roles: [{ id: "r1", user_id: ADMIN, role: "admin" }],
    module_detection_runs: [
      { id: OLD_RUN, status: "completed", commit_sha: null, started_at: "2026-07-31T23:13:41Z" },
    ],
    modules: [moduleRow(AML, "aml"), moduleRow(CLIENTS, "clients")],
    clone_modules: [
      { id: "i1", clone_id: CLONE_A, module_id: AML },
      { id: "i2", clone_id: CLONE_A, module_id: CLIENTS },
      { id: "i3", clone_id: CLONE_B, module_id: AML },
    ],
    ...extra,
  });
}

beforeEach(() => {
  detection.slugs = ["aml", "clients"];
  detection.fail = null;
  seed();
});

const reset = (options: { dryRun?: boolean } = {}) =>
  resetAndReingestLibrary({
    supabase: client(),
    userId: ADMIN,
    options: { confirmation: RESET_CONFIRMATION, ...options },
  });

/** Each clone's installed slugs, as the double holds them now. */
function installs(): Record<string, string[]> {
  const slugOf = new Map(db.tables.modules.map((m) => [m.id, m.slug as string]));
  const out: Record<string, string[]> = {};
  for (const i of db.tables.clone_modules) {
    const slug = slugOf.get(i.module_id as string);
    if (slug) (out[i.clone_id as string] ??= []).push(slug);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

const resetRows = () => db.tables.audit_log.filter((r) => r.action === "module_library.reset");
const completions = () =>
  db.tables.audit_log.filter((r) => r.action === "module_library.reingest_complete");
const deletes = () => db.writes.filter((w) => w.op === "delete");
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** A reset's record as `snapshotForAudit` writes it, for two clones. */
const snapshotOfBoth = {
  installs: [
    { clone_id: CLONE_A, slugs: ["aml", "clients"] },
    { clone_id: CLONE_B, slugs: ["aml"] },
  ],
  pins: [],
};
const resetRow = (id: string, createdAt: string): Row => ({
  id,
  action: "module_library.reset",
  created_at: createdAt,
  metadata: { modules_removed: 2, snapshot: snapshotOfBoth },
});

/** Runs `then` once, just after this reset's own row lands: what another did in that gap. */
function afterResetRecorded(then: () => void) {
  const from = db.from;
  db.from = (table: string) => {
    const builder = from(table);
    if (table !== "audit_log") return builder;
    const insert = builder.insert;
    builder.insert = (values: Row) => {
      const next = insert(values);
      if (values.action === "module_library.reset") {
        const single = next.single;
        next.single = async () => {
          const answer = await single();
          then();
          return answer;
        };
      }
      return next;
    };
    return builder;
  };
}

describe("a reset records what it will restore before it wipes anything", () => {
  it("writes the snapshot ahead of the first delete, and closes it owing nothing", async () => {
    const report = await reset();

    expect(report.ok).toBe(true);
    const recorded = db.writes.findIndex(
      (w) => w.table === "audit_log" && w.rows[0]?.action === "module_library.reset",
    );
    const firstDelete = db.writes.findIndex((w) => w.op === "delete");
    expect(recorded).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(recorded);
    expect(resetRows()[0].metadata).toMatchObject({
      clone_installs_snapshotted: 3,
      snapshot: snapshotOfBoth,
    });
    expect(installs()).toEqual(BOTH);
    expect(completions()).toHaveLength(1);
    expect(completions()[0].metadata).toMatchObject({
      reset_audit_id: resetRows()[0].id,
      unrestored: { installs: [], pins: [] },
    });
  });

  it("wipes nothing when the record cannot be written", async () => {
    db.failures.set("audit_log.insert", STATEMENT_TIMEOUT);

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/could not be recorded .*so nothing was wiped/);
    expect(deletes()).toEqual([]);
    expect(db.tables.modules).toHaveLength(2);
    expect(installs()).toEqual(BOTH);
  });

  it("refuses when the installs cannot be read, rather than snapshotting none", async () => {
    db.failures.set("clone_modules.select", STATEMENT_TIMEOUT);

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(
      /could not be read \(clone_modules: canceling statement.*Nothing was wiped/,
    );
    expect(deletes()).toEqual([]);
    expect(resetRows()).toEqual([]);
  });

  it("snapshots every install, past the thousand a page holds", async () => {
    const many: Row[] = [];
    for (let c = 0; c < 600; c++) {
      const clone = `c0000000-0000-4000-8000-${String(c).padStart(12, "0")}`;
      many.push({ id: `a${String(c).padStart(5, "0")}`, clone_id: clone, module_id: AML });
      many.push({ id: `b${String(c).padStart(5, "0")}`, clone_id: clone, module_id: CLIENTS });
    }
    seed({ clone_modules: many });

    const report = await reset();

    expect(report.before.cloneInstalls).toBe(1200);
    expect(report.restored.cloneInstalls).toBe(1200);
    expect(db.tables.clone_modules).toHaveLength(1200);
  });
});

describe("what a reset leaves owed, the next one restores", () => {
  const diedAt = "2026-09-01T10:00:00.000Z";

  it("restores what a reset that died recorded, which its wipe took from every clone", async () => {
    // What the death left: the wipe ran, and the restore and the completion never did.
    seed({ audit_log: [resetRow("au1", diedAt)], modules: [], clone_modules: [] });

    const report = await reset();

    expect(report.ok).toBe(true);
    expect(report.warnings.join(" ")).toContain(`The reset of ${diedAt} never finished`);
    expect(installs()).toEqual(BOTH);
    expect(resetRows()[1].metadata).toMatchObject({ restores_owed_from: diedAt });
  });

  it("does not restore a reset that finished", async () => {
    // Clone B has since lost `clients`, which the finished reset recorded. Its
    // completion is 31 Jul 2026's kind, naming no reset.
    const stale = resetRow("au1", diedAt);
    (stale.metadata as { snapshot: typeof snapshotOfBoth }).snapshot = {
      installs: [
        { clone_id: CLONE_A, slugs: ["aml", "clients"] },
        { clone_id: CLONE_B, slugs: ["aml", "clients"] },
      ],
      pins: [],
    };
    const finished: Row = {
      id: "au2",
      action: "module_library.reingest_complete",
      created_at: "2026-09-01T10:05:00.000Z",
      metadata: {},
    };
    seed({ audit_log: [stale, finished] });

    const report = await reset();

    expect(report.ok).toBe(true);
    expect(report.warnings.join(" ")).not.toContain("never finished");
    expect(installs()[CLONE_B]).toEqual(["aml"]);
  });

  it("does not take a completion that names another reset as this one's", async () => {
    const other: Row = {
      id: "au9",
      action: "module_library.reingest_complete",
      created_at: "2026-09-01T10:05:00.000Z",
      metadata: { reset_audit_id: "au8", unrestored: { installs: [], pins: [] } },
    };
    seed({ audit_log: [resetRow("au1", diedAt), other], modules: [], clone_modules: [] });

    const report = await reset();

    expect(report.warnings.join(" ")).toContain(`The reset of ${diedAt} never finished`);
    expect(installs()).toEqual(BOTH);
  });

  it("restores at once what a detection that failed after the wipe left owed", async () => {
    detection.fail = "3 source file(s) the import trace reaches could not be read";
    const first = await reset();
    expect(first.ok).toBe(false);
    expect(first.error).toContain("Detection failed after wipe");
    expect(db.tables.clone_modules).toEqual([]);
    expect(completions()[0].metadata).toMatchObject({
      reset_audit_id: resetRows()[0].id,
      unrestored: snapshotOfBoth,
      stopped_because: expect.stringContaining("Detection failed after wipe"),
    });

    // The first said it stopped, so the second does not wait for it.
    detection.fail = null;
    const second = await reset();

    expect(second.ok).toBe(true);
    expect(second.warnings.join(" ")).toContain("could not restore everything it recorded");
    expect(installs()).toEqual(BOTH);
  });

  it("owes a restore write that failed, and the next reset restores it at once", async () => {
    db.failures.set("clone_modules.upsert", STATEMENT_TIMEOUT);
    const first = await reset();

    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/could not be written back\. They are recorded as owed/);
    expect(db.tables.clone_modules).toEqual([]);
    expect(completions()[0].metadata).toMatchObject({
      unrestored: { installs: snapshotOfBoth.installs },
      stopped_because: "a restore write failed",
    });

    db.failures.delete("clone_modules.upsert");
    const second = await reset();

    expect(second.ok).toBe(true);
    expect(installs()).toEqual(BOTH);
  });

  it("holds off while a reset with no completion may still be running, then restores it", async () => {
    seed({ audit_log: [resetRow("au1", minutesAgo(1))], modules: [], clone_modules: [] });

    const tooSoon = await reset();
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.error).toMatch(
      /^The reset of .* has not recorded its completion and may still be running\. If it died, reset again after .*Nothing was wiped\.$/,
    );
    expect(resetRows()).toHaveLength(1);

    // Past the window, it died, and its record is what the clones had.
    resetRows()[0].created_at = minutesAgo(RUNNING_RUN_WINDOW_MS / 60_000 + 1);
    const later = await reset();

    expect(later.ok).toBe(true);
    expect(installs()).toEqual(BOTH);
  });

  it("says so in a dry run while a reset may still be running", async () => {
    seed({ audit_log: [resetRow("au1", minutesAgo(1))] });

    const report = await reset({ dryRun: true });

    expect(report.warnings.join(" ")).toMatch(
      /A real run would be refused: The reset of .* has not recorded its completion/,
    );
    expect(deletes()).toEqual([]);
  });

  it("refuses when the resets on record cannot be read, rather than taking none as owed", async () => {
    seed({ audit_log: [resetRow("au1", diedAt)] });
    db.failures.set("audit_log.select", STATEMENT_TIMEOUT);

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/the resets on record are unreadable/);
    expect(deletes()).toEqual([]);
  });

  it("reads a reset row that predates snapshots as nothing owed", async () => {
    // 31 Jul 2026's reset recorded counts, never a snapshot.
    seed({
      audit_log: [
        {
          id: "au3",
          action: "module_library.reset",
          created_at: "2026-07-31T23:13:40Z",
          metadata: { modules_removed: 98 },
        },
      ],
    });

    const read = await readResetState(client());

    expect(read).toEqual({ ok: true, state: { running: [], owed: null } });
  });
});

describe("a reset never runs beside another reset or a detection", () => {
  const runningSince = (msAgo: number): Row => ({
    id: "9e9e9e9e-0000-4000-8000-000000000009",
    status: "running",
    started_at: new Date(Date.now() - msAgo).toISOString(),
  });

  it("refuses while a run is running, and wipes nothing", async () => {
    seed({ module_detection_runs: [runningSince(5 * 60_000)] });

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(
      /Detection run 9e9e9e9e has been running since .* Nothing was wiped\./,
    );
    expect(deletes()).toEqual([]);
    expect(resetRows()).toEqual([]);
  });

  it("says so in a dry run, which deletes nothing either way", async () => {
    seed({ module_detection_runs: [runningSince(5 * 60_000)] });

    const report = await reset({ dryRun: true });

    expect(report.warnings.join(" ")).toMatch(
      /A real run would be refused: Detection run 9e9e9e9e/,
    );
    expect(deletes()).toEqual([]);
  });

  it("goes ahead past a run that died still saying running", async () => {
    seed({ module_detection_runs: [runningSince(RUNNING_RUN_WINDOW_MS + 60_000)] });

    const report = await reset();

    expect(report.ok).toBe(true);
  });

  it("refuses when the runs cannot be read, rather than taking none as running", async () => {
    // Only the question "is one running?" fails; the reset's other reads answer.
    const from = db.from;
    db.from = (table: string) => {
      const builder = from(table);
      if (table !== "module_detection_runs") return builder;
      const eq = builder.eq;
      builder.eq = (column: string, value: unknown) => {
        const next = eq(column, value);
        if (column === "status" && value === "running") {
          next.then = (resolve: (r: unknown) => unknown) =>
            Promise.resolve({ data: null, error: STATEMENT_TIMEOUT }).then(resolve);
        }
        return next;
      };
      return builder;
    };

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(
      /detection runs unreadable.*it is not known whether a detection is running/,
    );
    expect(deletes()).toEqual([]);
  });

  it("stops before the wipe when another reset recorded itself beside it", async () => {
    // Both looked before either had written its row, and both went on to record.
    afterResetRecorded(() => {
      db.tables.audit_log.push(resetRow("rival", new Date().toISOString()));
    });

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(
      /^The reset of .* has not recorded its completion and may still be running\..* This reset stopped before wiping anything\.$/,
    );
    expect(deletes()).toEqual([]);
    expect(installs()).toEqual(BOTH);
    const own = resetRows().find((r) => r.id !== "rival")!;
    expect(completions()).toHaveLength(1);
    expect(completions()[0].metadata).toMatchObject({
      reset_audit_id: own.id,
      unrestored: { installs: [], pins: [] },
      stopped_because: expect.stringContaining("may still be running"),
    });
  });

  it("stops before the wipe when a detection started beside it", async () => {
    afterResetRecorded(() => {
      db.tables.module_detection_runs.push(runningSince(0));
    });

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(
      /^Detection run 9e9e9e9e has been running since .* This reset stopped before wiping anything\.$/,
    );
    expect(deletes()).toEqual([]);
    expect(installs()).toEqual(BOTH);
  });
});

describe("who else is working on the catalogue, for a detection that has started", () => {
  const OWN_RUN = "0a0a0a0a-0000-4000-8000-00000000000a";
  const run = (id: string): Row => ({
    id,
    status: "running",
    started_at: new Date().toISOString(),
  });

  it("is nobody when only its own run is running", async () => {
    seed({ module_detection_runs: [run(OWN_RUN)] });

    expect(await catalogueCompetitor(client(), { runId: OWN_RUN })).toBeNull();
  });

  it("is another run started beside it", async () => {
    seed({ module_detection_runs: [run(OWN_RUN), run("9e9e9e9e-0000-4000-8000-000000000009")] });

    expect(await catalogueCompetitor(client(), { runId: OWN_RUN })).toMatch(
      /^Detection run 9e9e9e9e has been running since .*so a detection now would write the same modules/,
    );
  });

  it("is a reset that may still be running", async () => {
    seed({ module_detection_runs: [run(OWN_RUN)], audit_log: [resetRow("au1", minutesAgo(2))] });

    expect(await catalogueCompetitor(client(), { runId: OWN_RUN })).toMatch(
      /has not recorded its completion and may still be running/,
    );
  });
});
