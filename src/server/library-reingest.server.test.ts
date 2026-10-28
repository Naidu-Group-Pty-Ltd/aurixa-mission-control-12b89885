/**
 * The library reset (D19), asserted on what the double HOLDS afterwards and
 * the order its writes landed in. The risk in a reset is the gap between its
 * wipe and its restore: an invocation that dies there must leave a record of
 * what to restore, and a reset run beside a detection must not wipe what that
 * detection is writing.
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
          id: runId,
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
  readUnfinishedReset,
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
const deletes = () => db.writes.filter((w) => w.op === "delete");

describe("a reset records what it will restore before it wipes anything", () => {
  it("writes the snapshot into the reset's audit row, ahead of the first delete", async () => {
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
      snapshot: {
        installs: [
          { clone_id: CLONE_A, slugs: ["aml", "clients"] },
          { clone_id: CLONE_B, slugs: ["aml"] },
        ],
        pins: [],
      },
    });
    expect(installs()).toEqual({ [CLONE_A]: ["aml", "clients"], [CLONE_B]: ["aml"] });
    expect(db.tables.audit_log.map((r) => r.action)).toContain("module_library.reingest_complete");
  });

  it("wipes nothing when the record cannot be written", async () => {
    db.failures.set("audit_log.insert", STATEMENT_TIMEOUT);

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/could not be recorded .*so nothing was wiped/);
    expect(deletes()).toEqual([]);
    expect(db.tables.modules).toHaveLength(2);
    expect(installs()).toEqual({ [CLONE_A]: ["aml", "clients"], [CLONE_B]: ["aml"] });
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

describe("a reset after one that died restores what that one recorded", () => {
  const diedAt = "2026-09-01T10:00:00.000Z";
  const died: Row = {
    id: "au1",
    action: "module_library.reset",
    created_at: diedAt,
    metadata: {
      modules_removed: 2,
      snapshot: {
        installs: [
          { clone_id: CLONE_A, slugs: ["aml", "clients"] },
          { clone_id: CLONE_B, slugs: ["aml"] },
        ],
        pins: [],
      },
    },
  };

  it("restores the dead reset's installs, which its wipe took from every clone", async () => {
    // What the death left: the wipe ran and the restore never did.
    seed({ audit_log: [died], modules: [], clone_modules: [] });

    const report = await reset();

    expect(report.ok).toBe(true);
    expect(report.warnings.join(" ")).toContain(`The reset of ${diedAt} never finished`);
    expect(installs()).toEqual({ [CLONE_A]: ["aml", "clients"], [CLONE_B]: ["aml"] });
    expect(resetRows()[1].metadata).toMatchObject({ restores_unfinished_reset_of: diedAt });
  });

  it("does not restore a reset that finished", async () => {
    const finished: Row = {
      id: "au2",
      action: "module_library.reingest_complete",
      created_at: "2026-09-01T10:05:00.000Z",
      metadata: {},
    };
    // Clone B has since lost `clients`, which the finished reset recorded.
    const stale = structuredClone(died);
    (
      stale.metadata as { snapshot: { installs: Array<{ slugs: string[] }> } }
    ).snapshot.installs[1].slugs = ["aml", "clients"];
    seed({ audit_log: [stale, finished] });

    const report = await reset();

    expect(report.ok).toBe(true);
    expect(report.warnings.join(" ")).not.toContain("never finished");
    expect(installs()[CLONE_B]).toEqual(["aml"]);
  });

  it("refuses when the last reset cannot be read, rather than taking it as finished", async () => {
    seed({ audit_log: [died] });
    db.failures.set("audit_log.select", STATEMENT_TIMEOUT);

    const report = await reset();

    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/the last reset is unreadable/);
    expect(deletes()).toEqual([]);
  });

  it("restores on the reset after a detection that failed after the wipe", async () => {
    detection.fail = "3 source file(s) the import trace reaches could not be read";
    const first = await reset();
    expect(first.ok).toBe(false);
    expect(first.error).toContain("Detection failed after wipe");
    expect(db.tables.clone_modules).toEqual([]);

    // At once, the first may still be running as far as anyone can tell.
    detection.fail = null;
    const tooSoon = await reset();
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.error).toMatch(
      /^The reset of .* has not recorded its completion and may still be running\. If it died, reset again after .*Nothing was wiped\.$/,
    );
    expect(resetRows()).toHaveLength(1);

    // Past the window, it is dead, and its record is what the clones had.
    const firstRow = resetRows()[0];
    firstRow.created_at = new Date(Date.now() - RUNNING_RUN_WINDOW_MS - 60_000).toISOString();
    const second = await reset();

    expect(second.ok).toBe(true);
    expect(installs()).toEqual({ [CLONE_A]: ["aml", "clients"], [CLONE_B]: ["aml"] });
  });

  it("says so in a dry run while a reset may still be running", async () => {
    seed({
      audit_log: [{ ...died, created_at: new Date(Date.now() - 60_000).toISOString() }],
    });

    const report = await reset({ dryRun: true });

    expect(report.warnings.join(" ")).toMatch(
      /A real run would be refused: The reset of .* has not recorded its completion/,
    );
    expect(deletes()).toEqual([]);
  });

  it("reads a reset row that predates snapshots as nothing to restore", async () => {
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

    const read = await readUnfinishedReset(client());

    expect(read).toEqual({ ok: true, unfinished: null });
  });
});

describe("a reset never runs beside a detection", () => {
  const runningSince = (msAgo: number): Row => ({
    id: "9e9e9e9e-0000-4000-8000-000000000009",
    status: "running",
    started_at: new Date(Date.now() - msAgo).toISOString(),
  });

  it("refuses while a run is running, and wipes nothing", async () => {
    seed({
      module_detection_runs: [runningSince(5 * 60_000)],
    });

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
});
