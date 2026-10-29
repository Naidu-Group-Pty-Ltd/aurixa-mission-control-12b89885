/**
 * The library follow's decisions (D19, the owner's decision of 29 Oct 2026):
 * when it detects, when it waits, when it stops for a person, what settling a
 * run writes, and whether a module's entry changed.
 */
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_FLOOR,
  FOLLOW_ATTEMPTS,
  FOLLOW_HELD,
  catalogueChanged,
  emptyFollowReport,
  entryChange,
  followAuditMetadata,
  holdBeforeWriting,
  holdReason,
  isFollowRun,
  nextFollowStep,
  planSettle,
  stoppedNotice,
  type FollowModule,
  type FollowRun,
  type LatestEntry,
} from "./libraryFollow.pure";
import { libraryEntryInsert, type PublishableModule } from "./libraryApproval.pure";

const HEAD = "122b761274a9c5ef98207b16b5e02a5d7cfeb37e";
const OLDER = "fefeb02d00000000000000000000000000000000";
const NOW = Date.parse("2026-10-29T12:00:00Z");
const WINDOW = 30 * 60_000;

const FOLLOW = { follow: true, strategy: "feature-first" };
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

let ids = 0;
const run = (over: Partial<FollowRun> = {}): FollowRun => ({
  id: `run-${++ids}`,
  status: "completed",
  commit_sha: HEAD,
  parameters: FOLLOW,
  started_at: minutesAgo(5),
  ...over,
});

const step = (runs: FollowRun[]) =>
  nextFollowStep({ headSha: HEAD, runs, now: NOW, windowMs: WINDOW });

describe("which run is the follow's", () => {
  it("is one whose configuration says follow", () => {
    expect(isFollowRun({ parameters: { follow: true } })).toBe(true);
    expect(isFollowRun({ parameters: { follow: false } })).toBe(false);
    expect(isFollowRun({ parameters: { strategy: "feature-first" } })).toBe(false);
    expect(isFollowRun({ parameters: null })).toBe(false);
    expect(isFollowRun({ parameters: [true] })).toBe(false);
  });
});

describe("what the follow does at the prime's head", () => {
  it("nothing, where it settled the catalogue at the head", () => {
    const settled = run();
    expect(step([settled])).toEqual({ kind: "up_to_date", run: settled });
  });

  it("waits for the head to move where it held at it", () => {
    const held = run({ status: FOLLOW_HELD });
    expect(step([held])).toEqual({ kind: "held", run: held });
  });

  it("detects where it settled an older commit, as its first try at the head", () => {
    expect(step([run({ commit_sha: OLDER })])).toEqual({ kind: "detect", stale: [], attempt: 1 });
  });

  it("detects where it never ran, and a detection a person ran is not the follow's", () => {
    const persons = run({ parameters: { strategy: "feature-first" } });
    expect(step([])).toEqual({ kind: "detect", stale: [], attempt: 1 });
    expect(step([persons])).toEqual({ kind: "detect", stale: [], attempt: 1 });
  });

  it("tries a commit again after a failure, counting the tries", () => {
    const runs = [run({ status: "failed" }), run({ status: "failed" }), run({ commit_sha: OLDER })];
    expect(step(runs)).toEqual({ kind: "detect", stale: [], attempt: 3 });
  });

  it("waits for the head to move after the last try failed", () => {
    const failed = [
      run({ status: "failed" }),
      run({ status: "failed" }),
      run({ status: "failed" }),
    ];
    expect(failed).toHaveLength(FOLLOW_ATTEMPTS);
    expect(step([...failed, run({ commit_sha: OLDER })])).toEqual({
      kind: "exhausted",
      failed,
      stale: [],
    });
  });

  it("counts no failure at another commit, nor one before it last settled", () => {
    const runs = [
      run({ status: "failed", commit_sha: OLDER }),
      run({ status: "failed", commit_sha: null }),
      run({ commit_sha: OLDER }),
      run({ status: "failed" }),
      run({ status: "failed" }),
      run({ status: "failed" }),
    ];
    expect(step(runs)).toEqual({ kind: "detect", stale: [], attempt: 1 });
  });

  it("closes a run that died still saying running, and counts it as a try", () => {
    const died = run({ status: "running", started_at: minutesAgo(31) });
    expect(step([died, run({ commit_sha: OLDER })])).toEqual({
      kind: "detect",
      stale: [died],
      attempt: 2,
    });
  });

  it("leaves a run that may still be running to the competitor check", () => {
    const running = run({ status: "running", started_at: minutesAgo(5) });
    expect(step([running])).toEqual({ kind: "detect", stale: [], attempt: 1 });
  });

  it("is exhausted when the run that died was the last try", () => {
    const died = run({ status: "running", started_at: minutesAgo(45) });
    const failed = [run({ status: "failed" }), run({ status: "failed" })];
    expect(step([died, ...failed])).toEqual({
      kind: "exhausted",
      failed: [died, ...failed],
      stale: [died],
    });
  });
});

describe("when the follow stops for a person", () => {
  it("when the run found nothing", () => {
    expect(holdReason({ found: 0, live: 135, archive: [] })).toMatch(/found no module/);
  });

  it("archives up to the floor of a small catalogue without one", () => {
    const ten = Array.from({ length: ARCHIVE_FLOOR }, (_, i) => `m${i}`);
    expect(holdReason({ found: 5, live: 12, archive: ten })).toBeNull();
    expect(holdReason({ found: 5, live: 12, archive: [...ten, "m10"] })).toMatch(
      /would archive 11 of the 12 live modules, more than the 10/,
    );
  });

  it("archives up to a quarter of a large one, which the first follow's 14 of 135 is inside", () => {
    const archive = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(holdReason({ found: 143, live: 135, archive: archive(14) })).toBeNull();
    expect(holdReason({ found: 143, live: 135, archive: archive(34) })).toBeNull();
    expect(holdReason({ found: 100, live: 135, archive: archive(35) })).toMatch(
      /would archive 35 of the 135 live modules, more than the 34/,
    );
  });

  it("names the first ten it would archive, and counts the rest", () => {
    const archive = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, "0")}`);
    const why = holdReason({ found: 1, live: 40, archive }) ?? "";
    expect(why).toContain("m00, m01, m02, m03, m04, m05, m06, m07, m08, m09, and 30 more");
    expect(why).not.toContain("m10");
  });

  it("is asked before the run writes, from its slugs against the live catalogue", () => {
    const modules = [
      { slug: "aml", status: "approved" },
      { slug: "clients", status: "approved" },
      { slug: "gone", status: "archived" },
      { slug: "no", status: "rejected" },
    ];
    expect(holdBeforeWriting({ modules, detectedSlugs: ["aml", "clients", "new"] })).toBeNull();
    expect(holdBeforeWriting({ modules, detectedSlugs: [] })).toMatch(/found no module/);
    const many = Array.from({ length: 12 }, (_, i) => ({ slug: `m${i}`, status: "approved" }));
    expect(holdBeforeWriting({ modules: many, detectedSlugs: ["m0"] })).toMatch(
      /would archive 11 of the 12 live modules/,
    );
  });
});

const RUN = "run-follow";
const mod = (over: Partial<FollowModule> & { slug: string }): FollowModule => ({
  id: `id-${over.slug}`,
  name: over.slug,
  status: "approved",
  detection_run_id: RUN,
  archived_by_follow_run_id: null,
  ...over,
});

describe("settling the catalogue at a run", () => {
  const modules = [
    mod({ slug: "kept" }),
    mod({ slug: "added", status: "proposed" }),
    mod({ slug: "back", status: "archived", archived_by_follow_run_id: "run-earlier" }),
    mod({ slug: "gone", detection_run_id: "run-old" }),
    mod({ slug: "unproposed", status: "proposed", detection_run_id: "run-old" }),
    mod({ slug: "shelved", status: "archived", detection_run_id: "run-old" }),
    mod({ slug: "refused", status: "rejected" }),
    mod({ slug: "retired", status: "archived", detection_run_id: "run-old" }),
  ];
  const plan = planSettle({
    runId: RUN,
    modules,
    detectedSlugs: ["kept", "added", "back", "shelved", "refused"],
  });
  const slugs = (list: FollowModule[]) => list.map((m) => m.slug).sort();

  it("approves what the run proposed", () => {
    expect(slugs(plan.approve)).toEqual(["added"]);
  });

  it("brings back what the follow archived and the run found again", () => {
    expect(slugs(plan.revive)).toEqual(["back"]);
  });

  it("archives the live modules the run did not find, proposed or approved", () => {
    expect(slugs(plan.archive)).toEqual(["gone", "unproposed"]);
  });

  it("leaves what a person archived or rejected as they left it, and names what the run found of it", () => {
    expect(plan.keptOut).toEqual(["refused", "shelved"]);
    expect(slugs(plan.approve)).not.toContain("refused");
    expect(slugs(plan.revive)).not.toContain("shelved");
    expect(slugs(plan.archive)).not.toContain("retired");
  });

  it("publishes every module the run found that is approved once it settles", () => {
    expect(slugs(plan.publish)).toEqual(["added", "back", "kept"]);
  });

  it("holds where the run found nothing, whatever the slugs say", () => {
    const none = planSettle({
      runId: "run-other",
      modules,
      detectedSlugs: ["kept"],
    });
    expect(none.held).toMatch(/found no module/);
  });

  it("says whether the catalogue gained or lost a module", () => {
    expect(catalogueChanged(plan)).toBe(true);
    expect(catalogueChanged({ approve: [], revive: [], archive: [] })).toBe(false);
  });
});

const module = (over: Partial<PublishableModule> = {}): PublishableModule =>
  ({
    id: "id-aml",
    name: "AML",
    slug: "aml",
    status: "approved",
    description: "Screening",
    routes: ["/aml"],
    route_entry_file: "src/routes/aml.tsx",
    resolved_files: ["src/routes/aml.tsx", "src/components/aml/Panel.tsx"],
    file_globs: ["src/components/aml/**"],
    backend_file_globs: ["supabase/functions/aml-screen/**"],
    backend_manifest: { detection_run_id: RUN },
    detection_run_id: RUN,
    layer: "fullstack",
    cohesion_score: 0.8,
    coupling_score: 0.2,
    ai_confidence: 0.9,
    ai_reasoning: "traced",
    shared_by_modules: [],
    edge_functions: ["aml-screen"],
    database_tables: ["aml_cases"],
    required_secrets: ["DIDIT_KEY"],
    required_migrations: [],
    storage_buckets: [],
    cron_jobs: [],
    ...over,
  }) as PublishableModule;

const candidate = (m: PublishableModule) =>
  libraryEntryInsert(m, {
    version: 0,
    runId: RUN,
    commitSha: HEAD,
    publisherId: null,
    now: "2026-10-29T12:00:00Z",
    tags: ["fullstack"],
  });

/** The latest entry as the library holds it after publishing `m` at `sha`. */
const latestOf = (m: PublishableModule, sha: string | null = OLDER): LatestEntry => {
  const e = candidate(m);
  return {
    slug: e.slug,
    version: 3,
    approval_status: "approved",
    source_commit_sha: sha,
    name: e.name,
    description: e.description ?? null,
    route_path: e.route_path ?? null,
    entry_file: e.entry_file,
    file_paths: e.file_paths ?? null,
    metadata: e.metadata ?? null,
  };
};

describe("whether a module's entry changed", () => {
  it("is new where the slug was never published", () => {
    expect(entryChange(undefined, candidate(module()))).toBe("new");
  });

  it("is unapproved where its latest was not approved at a commit, as every entry before the follow", () => {
    const pending = { ...latestOf(module()), approval_status: "pending" };
    expect(entryChange(pending, candidate(module()))).toBe("unapproved");
    expect(entryChange(latestOf(module(), null), candidate(module()))).toBe("unapproved");
  });

  it("is unchanged where a clone would receive the same, at another commit", () => {
    expect(entryChange(latestOf(module()), candidate(module()))).toBe("unchanged");
  });

  it("is unchanged where only a score moved, or the files came back in another order", () => {
    const moved = module({
      cohesion_score: 0.4,
      ai_confidence: 0.1,
      ai_reasoning: "again",
      resolved_files: ["src/components/aml/Panel.tsx", "src/routes/aml.tsx"],
      edge_functions: ["aml-screen", "aml-screen"],
    });
    expect(entryChange(latestOf(module()), candidate(moved))).toBe("unchanged");
  });

  it("is changed where a file, the route, the name or the backend contract moved", () => {
    const latest = latestOf(module());
    for (const over of [
      { resolved_files: ["src/routes/aml.tsx"] },
      { routes: ["/compliance"] },
      { name: "AML/CTF" },
      { description: "Screening and reporting" },
      { route_entry_file: "src/routes/compliance.tsx" },
      { required_secrets: ["DIDIT_KEY", "AUSTRAC_KEY"] },
      { database_tables: [] },
      { layer: "backend" as const },
    ]) {
      expect(entryChange(latest, candidate(module(over))), JSON.stringify(over)).toBe("changed");
    }
  });
});

describe("what a follow reports", () => {
  it("records every list on the audit row, cut at 200", () => {
    const report = emptyFollowReport("settled");
    report.archived = Array.from({ length: 250 }, (_, i) => `m${i}`);
    report.attempt = 2;
    const metadata = followAuditMetadata(report) as Record<string, unknown>;
    expect((metadata.archived as string[]).length).toBe(200);
    expect(metadata.outcome).toBe("settled");
    expect(metadata.attempt).toBe(2);
    expect(metadata.stopped_because).toBeNull();
  });

  it("tells the operators where it held, and that nothing was written", () => {
    const report = {
      ...emptyFollowReport("held"),
      runId: RUN,
      commitSha: HEAD,
      stoppedBecause: "the run found no module, so nothing it found can stand for the catalogue",
    };
    const notice = stoppedNotice(report);
    expect(notice.kind).toBe("library_follow_held");
    expect(notice.title).toBe("Library follow held at prime@122b761");
    expect(notice.body).toContain("No module was approved, archived or published");
    expect(notice.body).toContain("the run found no module");
    expect(notice.metadata).toEqual({ run_id: RUN, commit_sha: HEAD, outcome: "held" });
  });

  it("tells the operators where its last try failed, and that it waits for the prime", () => {
    const report = {
      ...emptyFollowReport("failed"),
      runId: RUN,
      commitSha: HEAD,
      stoppedBecause: "The module aml was not written",
    };
    const notice = stoppedNotice(report);
    expect(notice.title).toBe("Library follow failed at prime@122b761");
    expect(notice.body).toContain(`failed to follow prime@122b761 ${FOLLOW_ATTEMPTS} times`);
    expect(notice.body).toContain("It tries again when the prime moves");
  });
});
