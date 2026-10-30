/**
 * The migration-effect stage, driven through fakes of what it talks to: the
 * Management API (`runSqlOnProject`), the prime's repository, the resolver
 * that names a clone's project, and Mission Control's own `audit_log` and
 * `clone_backends`.
 *
 * The fake clone answers the statements the real builders produce, read the
 * way the real readers read them: a probe statement raises its answers, a dry
 * run raises the probe's answer after the file "ran", an apply commits. So
 * every assertion about what was sent is about the statements production
 * sends, in the order it sends them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.hoisted(() => ({ runSqlOnProject: vi.fn() }));
vi.mock("./backend-provisioning.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend-provisioning.server")>()),
  runSqlOnProject: sql.runSqlOnProject,
}));

const prime = vi.hoisted(() => ({
  openPrimeMigrationCorpus: vi.fn(),
  fetchEffectReplayManifest: vi.fn(),
  resolvePrimeSource: vi.fn(async () => ({ owner: "o", repo: "prime", branch: "main" })),
}));
vi.mock("./prime-backend.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prime-backend.server")>()),
  ...prime,
}));

const digests = vi.hoisted(() => ({ digestPrimeBodies: vi.fn() }));
vi.mock("./primeBodyDigests.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./primeBodyDigests.server")>()),
  ...digests,
}));

const target = vi.hoisted(() => ({ resolveCloneSecretTarget: vi.fn() }));
vi.mock("./cloneAllowedOrigins.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cloneAllowedOrigins.server")>()),
  ...target,
}));

const audit = vi.hoisted(() => ({
  writeAuditLog: vi.fn(async (_e: Record<string, unknown>) => true),
  notifyOperators: vi.fn(async () => true),
}));
vi.mock("./audit.server", () => audit);

vi.mock("./github-app.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-app.server")>()),
  getAppOctokit: () => ({}),
}));

const {
  runEffectReplayStage,
  reconcileCloneEffectReplays,
  effectSweepIsNoteworthy,
  EFFECT_REPORT_NEEDS_MS,
} = await import("./migrationEffectReplay.server");
const { readEffectReplayManifest, EFFECT_REPLAY_AUDIT_ACTION } =
  await import("./migrationEffectReplay.pure");
const { MAX_DIGEST_BYTES } = await import("./primeBodyDigests.server");

const SHA = "18685b30892c2f5fcfd1f59ad754a5430fb08145";
const ORRIMERE = {
  cloneId: "11111111-1111-4111-8111-111111111111",
  cloneName: "Tutorial Demo (Orrimere)",
  projectRef: "orrimereorrimereorri",
};
const STAMP = "2026-10-29T22:11:49.645Z";

type Behaviour = "works" | "ineffective" | "raises" | "lock";
type File = { name: string; key: string; kind: "privilege" | "policy"; behaviour: Behaviour };

const probeOf = (key: string) => `select 1 from fx where k = '${key}'`;
const bodyOf = (f: { key: string }) =>
  `-- @effect: ${probeOf(f.key)}\ndo $revoke$ begin perform 1; end $revoke$; -- body:${f.key}\n`;

const A: File = {
  name: "20270204090000_revoke_a.sql",
  key: "a",
  kind: "privilege",
  behaviour: "works",
};
const B: File = {
  name: "20270205100000_policy_b.sql",
  key: "b",
  kind: "policy",
  behaviour: "works",
};
const C: File = {
  name: "20270210090000_revoke_c.sql",
  key: "c",
  kind: "privilege",
  behaviour: "works",
};
/** A template refresh decision: reported, never replayed. */
const REFRESH = {
  name: "20261209010000_refresh_active_masters_from_library_v18.sql",
  key: "refresh",
};

let inEffect: Set<string>;
let raising: Set<string>;
let sent: string[];
let onApply: (key: string) => void;

const wire = (m: string) =>
  new Error(
    `SQL execution failed on ${ORRIMERE.projectRef}: 400 — {"message":"Failed to run sql query: ERROR:  ${m}\\nCONTEXT:  PL/pgSQL function inline_code_block line 9 at RAISE"}`,
  );

function fakeClone(files: File[]) {
  const all = [...files.map((f) => f.key), REFRESH.key];
  sql.runSqlOnProject.mockImplementation(async (_ref: string, text: string) => {
    sent.push(text);
    if (text.startsWith("do $mc_effect_probes")) {
      const asked = all
        .map((key) => ({ key, at: text.indexOf(probeOf(key)) }))
        .filter((p) => p.at >= 0)
        .sort((x, y) => x.at - y.at);
      const answers = asked.map((p, i) =>
        raising.has(p.key) ? `${i}=error:42P01` : `${i}=${inEffect.has(p.key)}`,
      );
      throw wire(`P0001: EFFECT PROBES (rolled back): ${answers.join(" ")}`);
    }
    const f = files.find((x) => text.includes(`-- body:${x.key}`));
    if (!f) throw new Error(`unexpected statement: ${text.slice(0, 80)}`);
    if (text.startsWith("do $mc_effect_dry_run")) {
      if (f.behaviour === "raises") throw wire('42704: role \\"anon\\" does not exist');
      if (f.behaviour === "lock") throw wire("55P03: canceling statement due to lock timeout");
      throw wire(`P0001: DRY RUN (rolled back): probe=${f.behaviour === "works"}`);
    }
    if (text.startsWith("do $mc_effect_apply")) {
      if (f.behaviour !== "works") throw wire("P0001: APPLY REFUSED (rolled back): probe=false");
      inEffect.add(f.key);
      onApply(f.key);
      return [];
    }
    throw new Error(`unexpected statement: ${text.slice(0, 80)}`);
  });
}

function fakePrime(
  files: File[],
  opts: {
    manifest?: string | null | "unfetched";
    withdrawn?: string[];
    /** Corpus paths the body reader did not read, and their sizes. */
    unread?: Array<{ name: string; size: number }>;
    /** Corpus paths past the number the body reader asks for at all. */
    notAsked?: Array<{ name: string; size: number }>;
  } = {},
) {
  const corpusFiles = [
    ...files.map((f) => ({ name: f.name, size: 900 })),
    { name: REFRESH.name, size: 900 },
    ...(opts.unread ?? []),
    ...(opts.notAsked ?? []),
  ].map((f) => ({
    id: f.name.slice(0, 14),
    name: f.name,
    path: `supabase/migrations/${f.name}`,
    sha: `blob-${f.name}`,
    size: f.size,
  }));
  const bodies = new Map<string, string>([
    ...files.map((f): [string, string] => [f.name, bodyOf(f)]),
    [REFRESH.name, bodyOf(REFRESH)],
  ]);
  prime.openPrimeMigrationCorpus.mockImplementation(async () => ({
    sourceSha: SHA,
    files: corpusFiles.filter((f) => !(opts.withdrawn ?? []).includes(f.name)),
    metas: [],
    withdrawal: {
      state: "read",
      excluded: (opts.withdrawn ?? []).map((name) => ({ id: name.slice(0, 14), name, path: name })),
      unmatched: [],
    },
    loadSql: async ({ name }: { name: string }) => {
      const b = bodies.get(name);
      if (!b) throw new Error(`no body for ${name}`);
      return b;
    },
  }));
  const manifestText =
    opts.manifest === undefined
      ? JSON.stringify({
          schema_version: 1,
          replays: files.map((f) => ({
            file: f.name,
            kind: f.kind,
            decided: "2026-10-28",
            reason: "approved by the owner",
          })),
        })
      : opts.manifest;
  prime.fetchEffectReplayManifest.mockImplementation(async () => ({
    commitSha: SHA,
    reading:
      manifestText === "unfetched"
        ? { state: "unfetched", entries: [], refused: [], why: "GitHub would not serve it (503)" }
        : readEffectReplayManifest(manifestText),
  }));
  const unread = new Set(
    [...(opts.unread ?? []), ...(opts.notAsked ?? [])].map((u) => `supabase/migrations/${u.name}`),
  );
  const notAsked = new Set((opts.notAsked ?? []).map((u) => `supabase/migrations/${u.name}`));
  digests.digestPrimeBodies.mockImplementation(async () => ({
    // Every path was asked for; the ones it could not read carry no probe entry.
    byPath: new Map(
      corpusFiles
        .filter((f) => !notAsked.has(f.path))
        .map((f) => [f.path, unread.has(f.path) ? [] : ["digest"]]),
    ),
    probesByPath: new Map(
      corpusFiles
        .filter((f) => !unread.has(f.path))
        .map((f) => [
          f.path,
          (bodies.get(f.name) &&
            probeOf(
              f.name === REFRESH.name ? REFRESH.key : files.find((x) => x.name === f.name)!.key,
            )) ??
            null,
        ]),
    ),
  }));
}

/** Mission Control's own tables: the stage's audit rows, and the clone list. */
function fakeSupabase(
  opts: {
    records?: Array<Record<string, unknown>>;
    backends?: Array<Record<string, unknown>>;
  } = {},
) {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const result = () => {
      if (table === "audit_log")
        return { data: (opts.records ?? []).map((m) => ({ metadata: m })), error: null };
      if (table === "clone_backends") {
        const rows = (opts.backends ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
        return { data: rows, error: null };
      }
      return { data: [], error: null };
    };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "not", "order", "limit"]) q[m] = () => q;
    q.eq = (c: string, v: unknown) => {
      filters.push([c, v]);
      return q;
    };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return q;
  };
  return { from } as never;
}

const stageInput = (over: Partial<Parameters<typeof runEffectReplayStage>[1]> = {}) => ({
  cloneId: ORRIMERE.cloneId,
  projectRef: ORRIMERE.projectRef,
  stampedAt: STAMP,
  expectedSha: SHA,
  deadlineAt: null,
  ...over,
});

const kinds = () =>
  sent.map((s) =>
    s.startsWith("do $mc_effect_probes")
      ? "probes"
      : s.startsWith("do $mc_effect_dry_run")
        ? `dry:${/-- body:(\w+)/.exec(s)?.[1]}`
        : `apply:${/-- body:(\w+)/.exec(s)?.[1]}`,
  );

beforeEach(() => {
  inEffect = new Set();
  raising = new Set();
  sent = [];
  onApply = () => {};
  vi.clearAllMocks();
  target.resolveCloneSecretTarget.mockResolvedValue({ ...ORRIMERE });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the provisioning stage on a new clone", () => {
  it("replays each approved file whose probe returns no row, after a dry run, and only those", async () => {
    fakeClone([A, B, C]);
    fakePrime([A, B, C]);
    inEffect.add("b");
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());

    expect(kinds()).toEqual(["probes", "dry:a", "apply:a", "dry:c", "apply:c", "probes", "probes"]);
    expect(r.run?.outcomes.map((o) => [o.file.slice(0, 14), o.status])).toEqual([
      ["20270204090000", "replayed"],
      ["20270205100000", "already_in_effect"],
      ["20270210090000", "replayed"],
    ]);
    expect(r).toMatchObject({ ran: true, settled: true, stoppedAtDeadline: false });
    expect(r.line).toContain("2 replayed, 1 already in effect");
  });

  it("never touches the migration ledger", async () => {
    fakeClone([A, C]);
    fakePrime([A, C]);
    await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s).not.toMatch(/schema_migrations|migration_provenance/);
  });

  it("records the run under the stage's action, keyed to the project and the stamp", async () => {
    fakeClone([A]);
    fakePrime([A]);
    await runEffectReplayStage(
      fakeSupabase(),
      stageInput({ stampedAt: "2026-10-29 22:11:49.645+00" }),
    );
    expect(audit.writeAuditLog).toHaveBeenCalledTimes(1);
    const row = audit.writeAuditLog.mock.calls[0][0] as {
      action: string;
      entityId: string;
      metadata: Record<string, unknown>;
    };
    expect(row.action).toBe(EFFECT_REPLAY_AUDIT_ACTION);
    expect(row.entityId).toBe(ORRIMERE.cloneId);
    expect(row.metadata).toMatchObject({
      source: "provisioning",
      project_ref: ORRIMERE.projectRef,
      stamped_at: STAMP,
      prime_sha: SHA,
      settled: true,
    });
  });

  it("reports every other probe that returns no row, and repairs none of them", async () => {
    fakeClone([A]);
    fakePrime([A], {
      unread: [{ name: "20261209000000_seed_template_library_v18.sql", size: 41_765_254 }],
    });
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(r.run?.report).toMatchObject({
      taken: true,
      probes: 2,
      satisfied: 1,
      failing: [REFRESH.name],
      bodiesNotRead: {
        pastCeiling: 1,
        beyondFileLimit: 0,
        failed: 0,
        ceilingBytes: MAX_DIGEST_BYTES,
      },
    });
    expect(kinds().filter((k) => k.startsWith("apply"))).toEqual(["apply:a"]);
    expect(r.settled).toBe(true);
  });

  it("does not run a file for real when its dry run shows no effect, or raised", async () => {
    const ineffective = { ...A, behaviour: "ineffective" as const };
    const raises = { ...B, behaviour: "raises" as const };
    fakeClone([ineffective, raises, C]);
    fakePrime([ineffective, raises, C]);
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(kinds()).toEqual(["probes", "dry:a", "dry:b", "dry:c", "apply:c", "probes", "probes"]);
    const byFile = new Map(r.run?.outcomes.map((o) => [o.file, o]));
    expect(byFile.get(A.name)).toMatchObject({ status: "dry_run_failed" });
    expect(byFile.get(B.name)).toMatchObject({ status: "dry_run_failed", sqlstate: "42704" });
    expect(byFile.get(C.name)).toMatchObject({ status: "replayed" });
    // Both are verdicts about the file on this clone, so the stage settles.
    expect(r.settled).toBe(true);
  });

  it("leaves the stage owed when a dry run hit a limit this run set", async () => {
    const locked = { ...A, behaviour: "lock" as const };
    fakeClone([locked]);
    fakePrime([locked]);
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(r.run?.outcomes[0]).toMatchObject({
      status: "dry_run_failed",
      sqlstate: "55P03",
      transient: true,
    });
    expect(r.settled).toBe(false);
  });

  it("never dry-runs a file whose probe could not be read", async () => {
    fakeClone([A]);
    fakePrime([A]);
    raising.add("a");
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(kinds()).toEqual(["probes", "probes"]);
    expect(r.run?.outcomes[0]).toMatchObject({ status: "probe_unreadable", sqlstate: "42P01" });
  });
});

describe("the stage resumes by asking the clone", () => {
  it("stops between files at the deadline, pauses, and the next pass finds what it replayed", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    fakeClone([A, C]);
    fakePrime([A, C]);
    // The first apply takes the pass past its deadline.
    onApply = () => {
      clock += 60_000;
    };
    const deadlineAt = clock + EFFECT_REPORT_NEEDS_MS + 1_000;

    const first = await runEffectReplayStage(fakeSupabase(), stageInput({ deadlineAt }));
    expect(kinds()).toEqual(["probes", "dry:a", "apply:a", "probes"]);
    expect(first).toMatchObject({ ran: true, stoppedAtDeadline: true, settled: false });
    expect(first.run?.outcomes.map((o) => o.status)).toEqual(["replayed", "not_reached"]);
    expect(first.run?.report).toMatchObject({ taken: false, transient: true });

    // The next pass: its own budget, and the record of the first, unsettled.
    const records = audit.writeAuditLog.mock.calls.map(
      (c) => (c[0] as { metadata: Record<string, unknown> }).metadata,
    );
    sent = [];
    onApply = () => {};
    const second = await runEffectReplayStage(
      fakeSupabase({ records }),
      stageInput({ deadlineAt: clock + 45_000 }),
    );
    expect(kinds()).toEqual(["probes", "dry:c", "apply:c", "probes", "probes"]);
    expect(second.run?.outcomes.map((o) => o.status)).toEqual(["already_in_effect", "replayed"]);
    expect(second).toMatchObject({ stoppedAtDeadline: false, settled: true });
  });

  it("takes the report on a later pass when this one has no room for it", async () => {
    const clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    fakeClone([A]);
    fakePrime([A]);
    const r = await runEffectReplayStage(
      fakeSupabase(),
      stageInput({ deadlineAt: clock + EFFECT_REPORT_NEEDS_MS - 1 }),
    );
    expect(digests.digestPrimeBodies).not.toHaveBeenCalled();
    expect(r.run?.outcomes[0].status).toBe("replayed");
    expect(r.run?.report).toMatchObject({ taken: false, transient: true });
    expect(r.settled).toBe(false);
  });

  it("asks nobody anything once a pass has settled this project's stamp", async () => {
    fakeClone([A]);
    fakePrime([A]);
    const records = [{ project_ref: ORRIMERE.projectRef, stamped_at: STAMP, settled: true }];
    const r = await runEffectReplayStage(fakeSupabase({ records }), stageInput());
    expect(r).toEqual({ ran: false, line: "", stoppedAtDeadline: false, settled: true });
    expect(sql.runSqlOnProject).not.toHaveBeenCalled();
    expect(prime.openPrimeMigrationCorpus).not.toHaveBeenCalled();
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it("pauses before reading anything when it is owed and the pass is already out of time", async () => {
    fakeClone([A]);
    fakePrime([A]);
    const r = await runEffectReplayStage(
      fakeSupabase(),
      stageInput({ deadlineAt: Date.now() - 1 }),
    );
    expect(r).toEqual({ ran: false, line: "", stoppedAtDeadline: true, settled: false });
    expect(sql.runSqlOnProject).not.toHaveBeenCalled();
    expect(target.resolveCloneSecretTarget).not.toHaveBeenCalled();
    expect(prime.openPrimeMigrationCorpus).not.toHaveBeenCalled();
  });

  it("does not pause for a stage a pass has already settled, however late it is", async () => {
    const records = [{ project_ref: ORRIMERE.projectRef, stamped_at: STAMP, settled: true }];
    const r = await runEffectReplayStage(
      fakeSupabase({ records }),
      stageInput({ deadlineAt: Date.now() - 1 }),
    );
    expect(r.stoppedAtDeadline).toBe(false);
  });

  it("is owed again for a new stamp of the project", async () => {
    fakeClone([A]);
    fakePrime([A]);
    inEffect.add("a");
    const records = [{ project_ref: ORRIMERE.projectRef, stamped_at: STAMP, settled: true }];
    const r = await runEffectReplayStage(
      fakeSupabase({ records }),
      stageInput({ stampedAt: "2026-10-30T03:00:00.000Z" }),
    );
    expect(r.ran).toBe(true);
    expect(r.run?.outcomes[0].status).toBe("already_in_effect");
  });
});

describe("what the stage refuses", () => {
  it("never acts on a project other than the one the pass is building", async () => {
    fakeClone([A]);
    fakePrime([A]);
    target.resolveCloneSecretTarget.mockResolvedValue({
      ...ORRIMERE,
      projectRef: "someoneelsesproject1",
    });
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(sql.runSqlOnProject).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ran: true, settled: false, stoppedAtDeadline: false });
    expect(r.line).toContain("not the orrimereorrimereorri this pass is building");
  });

  it("never acts on a clone the resolver refuses", async () => {
    fakeClone([A]);
    fakePrime([A]);
    target.resolveCloneSecretTarget.mockRejectedValue(new Error("names the prime"));
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(sql.runSqlOnProject).not.toHaveBeenCalled();
    expect(r.settled).toBe(false);
    expect(audit.writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it("reads nothing at a commit other than the one the pass was built from", async () => {
    fakeClone([A]);
    fakePrime([A]);
    const r = await runEffectReplayStage(
      fakeSupabase(),
      stageInput({ expectedSha: "0".repeat(40) }),
    );
    expect(sql.runSqlOnProject).not.toHaveBeenCalled();
    expect(r.line).toContain("not the 0000000 this pass was built from");
    expect(r.settled).toBe(false);
  });

  it("never replays a withdrawn file", async () => {
    fakeClone([A, C]);
    fakePrime([A, C], { withdrawn: [C.name] });
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(kinds().filter((k) => k.startsWith("dry"))).toEqual(["dry:a"]);
    expect(r.run?.outcomes.find((o) => o.file === C.name)).toMatchObject({ status: "refused" });
  });

  it("reports an absent manifest as absent, replays nothing, and still takes the report", async () => {
    fakeClone([A]);
    fakePrime([A], { manifest: null });
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(kinds()).toEqual(["probes"]);
    expect(r.run?.manifest.state).toBe("absent");
    expect(r.line).toContain("publishes no supabase/migrations/MIGRATION_EFFECT_REPLAYS.json");
    expect(r.settled).toBe(true);
  });

  it("asks again when the manifest would not fetch, and when its version is unknown it says so", async () => {
    fakeClone([A]);
    fakePrime([A], { manifest: "unfetched" });
    const unfetched = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(unfetched.settled).toBe(false);

    sent = [];
    fakePrime([A], { manifest: JSON.stringify({ schema_version: 2, replays: [] }) });
    const v2 = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(kinds()).toEqual(["probes"]);
    expect(v2.line).toContain(
      "could not be used (it declares schema_version 2; this reader knows 1)",
    );
  });

  it("counts a body past the number one pass reads apart, and does not ask again for it", async () => {
    fakeClone([A]);
    fakePrime([A], { notAsked: [{ name: "20271201090000_far_future.sql", size: 2_000 }] });
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(r.run?.report).toMatchObject({
      bodiesNotRead: { pastCeiling: 0, beyondFileLimit: 1, failed: 0 },
    });
    expect(r.settled).toBe(true);
    expect(r.line).toContain("1 past the number one pass reads");
  });

  it("asks again when a body under the read ceiling did not read for the report", async () => {
    fakeClone([A]);
    fakePrime([A], { unread: [{ name: "20270206090000_restate_rows.sql", size: 5_232 }] });
    const r = await runEffectReplayStage(fakeSupabase(), stageInput());
    expect(r.run?.report).toMatchObject({ bodiesNotRead: { pastCeiling: 0, failed: 1 } });
    expect(r.settled).toBe(false);
  });
});

describe("/hooks/clone-effect-replay against clones that exist", () => {
  const backends = [
    { clone_id: ORRIMERE.cloneId, status: "ready" },
    { clone_id: "22222222-2222-4222-8222-222222222222", status: "migrating" },
  ];

  it("dry-runs without committing anything, and writes no clone record", async () => {
    fakeClone([A, C]);
    fakePrime([A, C]);
    inEffect.add("c");
    const out = await reconcileCloneEffectReplays(fakeSupabase({ backends }), {
      deadlineAt: Date.now() + 45_000,
      dryRun: true,
    });
    expect(kinds()).toEqual(["probes", "dry:a", "probes"]);
    expect(out.runs[0].outcomes.map((o) => o.status)).toEqual([
      "would_replay",
      "already_in_effect",
    ]);
    expect(inEffect.has("a")).toBe(false);
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
    expect(effectSweepIsNoteworthy(out)).toBe(false);
  });

  it("reads nothing from the prime when no clone is a candidate", async () => {
    const out = await reconcileCloneEffectReplays(
      fakeSupabase({ backends: [{ clone_id: backends[1].clone_id, status: "migrating" }] }),
      { deadlineAt: Date.now() + 45_000 },
    );
    expect(out).toMatchObject({ considered: 0, commit: null, runs: [] });
    expect(prime.openPrimeMigrationCorpus).not.toHaveBeenCalled();
    expect(sql.runSqlOnProject).not.toHaveBeenCalled();
  });

  it("leaves a clone still being provisioned to its own stage", async () => {
    fakeClone([A]);
    fakePrime([A]);
    const out = await reconcileCloneEffectReplays(fakeSupabase({ backends }), {
      deadlineAt: Date.now() + 45_000,
    });
    expect(out.considered).toBe(1);
    expect(out.refused).toEqual([
      expect.objectContaining({
        cloneId: "22222222-2222-4222-8222-222222222222",
        reason: "not_ready",
      }),
    ]);
  });

  it("replays for real, records it against the clone, and limits itself to the clone asked for", async () => {
    fakeClone([A]);
    fakePrime([A]);
    const out = await reconcileCloneEffectReplays(fakeSupabase({ backends }), {
      deadlineAt: Date.now() + 45_000,
      cloneId: ORRIMERE.cloneId,
    });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].outcomes[0].status).toBe("replayed");
    expect(out.refused).toEqual([]);
    const row = audit.writeAuditLog.mock.calls[0][0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(row.action).toBe(EFFECT_REPLAY_AUDIT_ACTION);
    expect(row.metadata).toMatchObject({ source: "hook", stamped_at: null });
    expect(effectSweepIsNoteworthy(out)).toBe(true);
  });
});
