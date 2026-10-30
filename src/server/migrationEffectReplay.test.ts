import { describe, expect, it } from "vitest";
import {
  APPLY_REFUSAL_MARKER,
  DRY_RUN_MARKER,
  EFFECT_REPLAYS_PATH,
  admitBody,
  admitEntry,
  applyStatement,
  buildEffectReport,
  decideEffectNotice,
  describeEffectNotice,
  describeReplays,
  describeReport,
  dryRunStatement,
  effectExposures,
  exposuresTold,
  normaliseInstant,
  notReplayed,
  outcomeAfterApply,
  outcomeOfProbe,
  readApplyFailure,
  readDryRun,
  readEffectReplayManifest,
  replaySettled,
  reportComplete,
  settledEarlier,
  type CorpusFacts,
  type EffectReplayEntry,
  type ReplayOutcome,
} from "./migrationEffectReplay.pure";

/**
 * The manifest as the prime publishes it on 30 Oct 2026, trimmed to three of
 * its seven entries (`supabase/migrations/MIGRATION_EFFECT_REPLAYS.json`).
 */
const REAL = {
  $schema_note: "Migrations whose effect a clone built later never receives …",
  schema_version: 1,
  replays: [
    {
      file: "20270204090000_revoke_public_key_reach_on_open_policy_tables.sql",
      kind: "privilege",
      decided: "2026-10-28",
      reason:
        "The owner approved these statements for the clones on 28 Oct 2026, when the publishable key could read client_address_history.",
    },
    {
      file: "20270205100000_restate_named_storage_object_policies.sql",
      kind: "policy",
      decided: "2026-10-28",
      reason: "D9, approved by the owner on 28 Oct 2026: the ten storage.objects policies.",
    },
    {
      file: "20270210090000_revoke_browser_reach_on_integration_configs.sql",
      kind: "privilege",
      decided: "2026-10-29",
      reason:
        "Key audit S3, 29 Oct 2026: both browser roles held every privilege on integration_configs.",
    },
  ],
};

const manifest = (over: Partial<typeof REAL> | Record<string, unknown>) =>
  JSON.stringify({ ...REAL, ...over });

describe("readEffectReplayManifest", () => {
  it("reads the prime's manifest: every entry, its file and kind, in file order", () => {
    const r = readEffectReplayManifest(JSON.stringify(REAL));
    expect(r.state).toBe("read");
    expect(r.entries.map((e) => [e.file.slice(0, 14), e.kind])).toEqual([
      ["20270204090000", "privilege"],
      ["20270205100000", "policy"],
      ["20270210090000", "privilege"],
    ]);
    expect(r.refused).toEqual([]);
  });

  it("carries no version of its own: the version is the name's prefix", () => {
    const r = readEffectReplayManifest(JSON.stringify(REAL));
    expect(r.entries[0]).not.toHaveProperty("version");
  });

  it("says absent when the tree carries no manifest, and that is not an empty read", () => {
    const r = readEffectReplayManifest(null);
    expect(r.state).toBe("absent");
  });

  it("refuses the whole document on anything it cannot read as one", () => {
    expect(readEffectReplayManifest("{not json").state).toBe("unreadable");
    expect(readEffectReplayManifest("[]").state).toBe("unreadable");
    expect(readEffectReplayManifest(manifest({ replays: {} })).state).toBe("unreadable");
    const v2 = readEffectReplayManifest(manifest({ schema_version: 2 }));
    expect(v2.state).toBe("unreadable");
    expect(v2.state === "unreadable" && v2.why).toContain("schema_version 2");
    expect(v2.entries).toEqual([]);
  });

  it("refuses a malformed entry by name and still reads the rest", () => {
    const bad = (e: Record<string, unknown>) =>
      readEffectReplayManifest(manifest({ replays: [REAL.replays[0], e] }));
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...REAL.replays[2], kind: "seed" }, "kind"],
      [{ ...REAL.replays[2], decided: "29 Oct 2026" }, "decided"],
      [{ ...REAL.replays[2], reason: "  " }, "reason"],
      [{ ...REAL.replays[2], approved: "owner" }, '"approved"'],
      [{ ...REAL.replays[2], file: "revoke.sql" }, "migration file"],
    ];
    for (const [entry, word] of cases) {
      const r = bad(entry);
      expect(r.state, word).toBe("read");
      expect(
        r.entries.map((e) => e.file),
        word,
      ).toEqual([REAL.replays[0].file]);
      expect(r.refused, word).toHaveLength(1);
      expect(r.refused[0].why, word).toContain(word);
    }
    const notObject = readEffectReplayManifest(manifest({ replays: ["x", REAL.replays[0]] }));
    expect(notObject.refused[0]).toEqual({
      index: 0,
      file: null,
      why: "replays[0] is not an object",
    });
  });

  it("refuses a file listed twice, and attributes order as the prime's gate does", () => {
    const twice = readEffectReplayManifest(
      manifest({ replays: [REAL.replays[0], REAL.replays[0]] }),
    );
    expect(twice.entries).toHaveLength(1);
    expect(twice.refused[0].why).toContain("listed twice");

    // C, A, B: only A sorts before the entry above it.
    const [a, , c] = REAL.replays;
    const b = { ...REAL.replays[1] };
    const r = readEffectReplayManifest(manifest({ replays: [c, a, b] }));
    expect(r.refused.map((x) => x.file)).toEqual([a.file]);
    // What remains still runs in file order.
    expect(r.entries.map((e) => e.file)).toEqual([b.file, c.file]);
  });

  it("names the path once", () => {
    expect(EFFECT_REPLAYS_PATH).toBe("supabase/migrations/MIGRATION_EFFECT_REPLAYS.json");
  });
});

const entry = (file: string, kind: "privilege" | "policy" = "privilege"): EffectReplayEntry => ({
  file,
  kind,
  decided: "2026-10-28",
  reason: "approved",
});

const FILE = "20270210090000_revoke_browser_reach_on_integration_configs.sql";
const facts = (over: Partial<CorpusFacts> = {}): CorpusFacts => ({
  versionOf: new Map([[FILE, "20270210090000"]]),
  withdrawn: new Set(),
  withdrawalState: "read",
  commit: "18685b30892c2f5fcfd1f59ad754a5430fb08145",
  ...over,
});

describe("admitEntry", () => {
  it("takes the version from the corpus", () => {
    expect(admitEntry(entry(FILE), facts())).toEqual({ ok: true, version: "20270210090000" });
  });

  it("never replays a withdrawn file, and replays nothing when withdrawals cannot be read", () => {
    const w = admitEntry(entry(FILE), facts({ withdrawn: new Set([FILE]) }));
    expect(!w.ok && w.outcome.status).toBe("refused");
    expect(!w.ok && w.outcome.why).toContain("MIGRATION_WITHDRAWN.json");
    const u = admitEntry(entry(FILE), facts({ withdrawalState: "unreadable" }));
    expect(!u.ok && u.outcome.status).toBe("refused");
    expect(!u.ok && u.outcome.transient).toBe(true);
  });

  it("refuses a rollback script and a file the tree does not carry", () => {
    const rb = "20250124120001_rollback_client_data_rls_policies.sql";
    const r = admitEntry(entry(rb), facts({ versionOf: new Map([[rb, "20250124120001"]]) }));
    expect(!r.ok && r.outcome.why).toContain("rollback");
    const gone = admitEntry(entry("20270299090000_nothing.sql"), facts());
    expect(!gone.ok && gone.outcome.why).toContain("not in the prime's tree at 18685b3");
  });
});

const PROBE =
  "select 1 where not exists (select 1 from pg_class c cross join lateral unnest(c.relacl) i where c.oid = to_regclass('public.integration_configs') and i::text ~ '^(anon|authenticated)=')";
/** The prime's 20270210090000, comments trimmed. */
const BODY = `-- @effect: ${PROBE}
--
-- Key audit S3.
do $revoke$
begin
  if to_regclass('public.integration_configs') is null then
    return;
  end if;
  revoke all on table public.integration_configs from anon, authenticated;
end
$revoke$;
`;

describe("admitBody", () => {
  it("admits the prime's file and hands back its probe", () => {
    expect(admitBody(entry(FILE), "20270210090000", BODY, { maxBytes: 1 << 20 })).toEqual({
      ok: true,
      probe: PROBE,
    });
  });

  it("says the probe is unreadable when the file declares none, or one that writes", () => {
    const none = admitBody(entry(FILE), "v", "revoke all on t from anon;", { maxBytes: 1 << 20 });
    expect(!none.ok && none.outcome.status).toBe("probe_unreadable");
    const writes = admitBody(entry(FILE), "v", "-- @effect: select 1; delete from t\nselect 1;", {
      maxBytes: 1 << 20,
    });
    expect(!writes.ok && writes.outcome.status).toBe("probe_unreadable");
  });

  it("refuses a body that manages its own transaction, and one too large to send", () => {
    const tx = admitBody(
      entry(FILE),
      "v",
      `-- @effect: ${PROBE}\nbegin;\nrevoke all on t from anon;\ncommit;\n`,
      {
        maxBytes: 1 << 20,
      },
    );
    expect(!tx.ok && tx.outcome.status).toBe("refused");
    expect(!tx.ok && tx.outcome.why).toContain("transaction");
    const big = admitBody(entry(FILE), "v", BODY, { maxBytes: 100 });
    expect(!big.ok && big.outcome.status).toBe("refused");
  });
});

describe("the dry run and the apply", () => {
  const dry = dryRunStatement(BODY, PROBE, { lockTimeout: "3s" });
  const apply = applyStatement(BODY, PROBE, { lockTimeout: "3s" });

  it("is ONE statement: the file under its own tag, then the probe, then the answer raised", () => {
    expect(dry.startsWith("do $mc_effect_dry_run$")).toBe(true);
    expect(dry.trimEnd().endsWith("$mc_effect_dry_run$;")).toBe(true);
    const body = dry.indexOf(`execute $mc_effect_body$\n${BODY}\n$mc_effect_body$;`);
    const readOnly = dry.indexOf("set_config('transaction_read_only', 'on', true)");
    const probe = dry.indexOf(`$mc_effect_probe$${PROBE}$mc_effect_probe$`);
    const raise = dry.indexOf(`raise exception '${DRY_RUN_MARKER} probe=%', effect::text;`);
    expect(body).toBeGreaterThan(-1);
    expect(readOnly).toBeGreaterThan(body);
    expect(probe).toBeGreaterThan(readOnly);
    expect(raise).toBeGreaterThan(probe);
  });

  it("waits for a lock no longer than it is told to", () => {
    expect(dry).toContain("set_config('lock_timeout', '3s', true)");
    expect(apply).toContain("set_config('lock_timeout', '3s', true)");
  });

  it("applies the same execution, and refuses to commit when the probe still returns no row", () => {
    expect(apply).toContain(`execute $mc_effect_body$\n${BODY}\n$mc_effect_body$;`);
    expect(apply).toMatch(
      new RegExp(
        `if not effect then\\s+raise exception '${APPLY_REFUSAL_MARKER.replace(/[()]/g, "\\$&")} probe=%'`,
      ),
    );
    expect(apply).not.toContain(DRY_RUN_MARKER);
  });

  it("never touches the migration ledger", () => {
    for (const s of [dry, apply]) {
      expect(s).not.toMatch(/schema_migrations|migration_provenance/);
    }
  });

  it("keeps every tag out of what it quotes", () => {
    const sly = `${BODY}\n-- $mc_effect_body$ $mc_effect_dry_run$`;
    const s = dryRunStatement(sly, PROBE, { lockTimeout: "3s" });
    expect(s).toContain("execute $mc_effect_body_1$");
    expect(s.startsWith("do $mc_effect_dry_run_1$")).toBe(true);
  });

  it("refuses a probe the guard refuses", () => {
    expect(() => dryRunStatement(BODY, "select 1; drop table t", { lockTimeout: "3s" })).toThrow();
    expect(() => applyStatement(BODY, "delete from t", { lockTimeout: "3s" })).toThrow();
  });
});

describe("reading what the dry run and the apply threw", () => {
  const wire = (m: string) =>
    `SQL execution failed on testtesttesttesttest: 400 — {"message":"Failed to run sql query: ERROR:  ${m}\\nCONTEXT:  PL/pgSQL function inline_code_block line 9 at RAISE"}`;

  it("reads the probe's answer out of the rolled-back dry run", () => {
    expect(readDryRun(wire(`P0001: ${DRY_RUN_MARKER} probe=true`))).toEqual({
      ran: true,
      effect: true,
    });
    expect(readDryRun(wire(`P0001: ${DRY_RUN_MARKER} probe=false`))).toEqual({
      ran: true,
      effect: false,
    });
  });

  it("reads anything else as a dry run that did not finish, with its code", () => {
    const r = readDryRun(wire('42704: role \\"anon\\" does not exist'));
    expect(r.ran).toBe(false);
    expect(!r.ran && r.sqlstate).toBe("42704");
    expect(readDryRun("SQL execution failed on x: 503 — upstream timeout")).toMatchObject({
      ran: false,
      sqlstate: null,
    });
  });

  it("tells an apply the probe refused from one the database refused", () => {
    expect(
      readApplyFailure(wire(`P0001: ${APPLY_REFUSAL_MARKER} probe=false`)).refusedByProbe,
    ).toBe(true);
    const lock = readApplyFailure(wire("55P03: canceling statement due to lock timeout"));
    expect(lock).toMatchObject({ refusedByProbe: false, sqlstate: "55P03" });
  });
});

describe("what each answer means for the file", () => {
  const base = { file: FILE, version: "20270210090000", kind: "privilege" as const };

  it("runs nothing where the effect is there, dry-runs where it is not", () => {
    expect(outcomeOfProbe(base, { kind: "effect", present: true })).toEqual({
      ...base,
      status: "already_in_effect",
    });
    expect(outcomeOfProbe(base, { kind: "effect", present: false })).toBe("dry_run");
  });

  it("calls a probe that raised unreadable, and one nobody heard from unreadable and retried", () => {
    const raised = outcomeOfProbe(base, { kind: "error", sqlstate: "42P01" });
    expect(raised).toMatchObject({ status: "probe_unreadable", sqlstate: "42P01" });
    expect(raised !== "dry_run" && raised.transient).toBeFalsy();
    const unheard = outcomeOfProbe(base, { kind: "unread", why: "503" });
    expect(unheard).toMatchObject({ status: "probe_unreadable", transient: true });
  });

  it("calls a file replayed only when the read after it says so", () => {
    expect(outcomeAfterApply(base, { kind: "effect", present: true })).toEqual({
      ...base,
      status: "replayed",
      applied: true,
    });
    expect(outcomeAfterApply(base, { kind: "effect", present: false })).toMatchObject({
      status: "apply_failed",
      applied: true,
    });
    expect(outcomeAfterApply(base, { kind: "unread", why: "x" })).toMatchObject({
      status: "probe_unreadable",
      applied: true,
      transient: true,
    });
  });
});

describe("replaySettled — when the stage is no longer owed", () => {
  const read = readEffectReplayManifest(JSON.stringify(REAL));
  const o = (status: ReplayOutcome["status"], transient = false): ReplayOutcome => ({
    file: FILE,
    version: "20270210090000",
    kind: "privilege",
    status,
    ...(transient ? { transient: true } : {}),
  });

  it("settles on verdicts, failures included", () => {
    expect(
      replaySettled({
        manifest: read,
        outcomes: [o("replayed"), o("dry_run_failed"), o("refused")],
        stopped: false,
      }),
    ).toBe(true);
    expect(
      replaySettled({ manifest: readEffectReplayManifest(null), outcomes: [], stopped: false }),
    ).toBe(true);
    expect(
      replaySettled({ manifest: readEffectReplayManifest("{"), outcomes: [], stopped: false }),
    ).toBe(true);
  });

  it("does not settle on a reading it could not take, nor on a pass the budget stopped", () => {
    expect(
      replaySettled({ manifest: read, outcomes: [o("probe_unreadable", true)], stopped: false }),
    ).toBe(false);
    expect(replaySettled({ manifest: read, outcomes: [o("not_reached")], stopped: true })).toBe(
      false,
    );
    expect(
      replaySettled({
        manifest: { state: "unfetched", entries: [], refused: [], why: "503" },
        outcomes: [],
        stopped: false,
      }),
    ).toBe(false);
  });
});

describe("settledEarlier — owed once per stamp of a project", () => {
  const STAMP = "2026-10-29T22:11:49.645Z";
  const rec = (m: Record<string, unknown>) => ({ metadata: m });
  const settled = rec({ project_ref: "orrimereorrimereorri", stamped_at: STAMP, settled: true });

  it("is settled by a settled record for the same project and the same stamp", () => {
    expect(
      settledEarlier([settled], { projectRef: "orrimereorrimereorri", stampedAt: STAMP }),
    ).toBe(true);
  });

  it("compares the stamp as an instant, because the row and the pass spell it differently", () => {
    expect(
      settledEarlier([settled], {
        projectRef: "orrimereorrimereorri",
        stampedAt: "2026-10-29 22:11:49.645+00",
      }),
    ).toBe(true);
    expect(normaliseInstant("2026-10-29T22:11:49.645+00:00")).toBe(STAMP);
  });

  it("is owed again for a new stamp, a new project, an unsettled record or no stamp", () => {
    const at = { projectRef: "orrimereorrimereorri", stampedAt: STAMP };
    expect(settledEarlier([settled], { ...at, stampedAt: "2026-10-30T01:00:00.000Z" })).toBe(false);
    expect(settledEarlier([settled], { ...at, projectRef: "newprojectnewproject" })).toBe(false);
    expect(settledEarlier([rec({ ...settled.metadata, settled: false })], at)).toBe(false);
    expect(settledEarlier([settled], { ...at, stampedAt: null })).toBe(false);
    // The route's records carry no stamp and never settle a build.
    expect(
      settledEarlier([rec({ project_ref: at.projectRef, stamped_at: null, settled: true })], at),
    ).toBe(false);
  });
});

describe("the report of every other probe", () => {
  const report = buildEffectReport({
    commit: "18685b30892c2f5fcfd1f59ad754a5430fb08145",
    probes: [
      { file: "20261209010000_refresh_active_masters_from_library_v18.sql", probe: "select 1" },
      { file: "20270204090000_revoke.sql", probe: "select 1" },
      { file: "20270206090000_restate.sql", probe: "select 1" },
      { file: "20270211090000_usage.sql", probe: "select 1" },
    ],
    answers: [
      { kind: "effect", present: false },
      { kind: "effect", present: true },
      { kind: "error", sqlstate: "42P01" },
      { kind: "unread", why: "x" },
    ],
    refused: ["20270101000000_writes.sql"],
    bodiesNotRead: { pastCeiling: 28, beyondFileLimit: 0, failed: 0, ceilingBytes: 256 * 1024 },
  });

  it("counts every probe once, by what it answered", () => {
    expect(report).toMatchObject({
      taken: true,
      probes: 5,
      satisfied: 1,
      failing: ["20261209010000_refresh_active_masters_from_library_v18.sql"],
      errored: [{ file: "20270206090000_restate.sql", sqlstate: "42P01" }],
      refused: ["20270101000000_writes.sql"],
      unanswered: ["20270211090000_usage.sql"],
    });
  });

  it("is complete only when nothing went unanswered and no body that should read failed to", () => {
    expect(reportComplete(report)).toBe(false);
    expect(reportComplete({ ...report, unanswered: [] } as typeof report)).toBe(true);
    expect(
      reportComplete({
        ...report,
        unanswered: [],
        bodiesNotRead: { pastCeiling: 28, beyondFileLimit: 0, failed: 1, ceilingBytes: 1 },
      } as typeof report),
    ).toBe(false);
    expect(reportComplete({ taken: false, why: "no time", transient: true })).toBe(false);
  });

  it("says the counts, names the failing files, and says it repairs nothing", () => {
    const line = describeReport(report);
    expect(line).toContain("1 of 5 declared probes return a row");
    expect(line).toContain("1 do not (20261209010000)");
    expect(line).toContain("28 past the 256 KB read ceiling");
    expect(line).toContain("never repaired");
  });
});

describe("describeReplays", () => {
  const commit = "18685b30892c2f5fcfd1f59ad754a5430fb08145";

  it("never reads an absent or unusable manifest as an empty one", () => {
    expect(describeReplays({ commit, manifest: { state: "absent" }, outcomes: [] })).toContain(
      "publishes no supabase/migrations/MIGRATION_EFFECT_REPLAYS.json at 18685b3",
    );
    expect(
      describeReplays({
        commit,
        manifest: { state: "unreadable", why: "schema_version 2" },
        outcomes: [],
      }),
    ).toContain("could not be used (schema_version 2), so nothing was replayed");
  });

  it("counts each outcome and says why the failures failed", () => {
    const line = describeReplays({
      commit,
      manifest: { state: "read" },
      outcomes: [
        { file: FILE, version: "20270210090000", kind: "privilege", status: "replayed" },
        {
          file: "20270205100000_x.sql",
          version: "20270205100000",
          kind: "policy",
          status: "dry_run_failed",
          why: "it refers to a table that does not exist here",
        },
      ],
    });
    expect(line).toContain("2 approved files at 18685b3");
    expect(line).toContain("1 replayed");
    expect(line).toContain(
      "1 dry run failed (20270205100000: it refers to a table that does not exist here)",
    );
  });
});

describe("telling a person what an approved fix did not do", () => {
  const outcome = (
    file: string,
    status: ReplayOutcome["status"],
    extra: Partial<ReplayOutcome> = {},
  ): ReplayOutcome => ({ file, version: file.slice(0, 14), kind: "privilege", status, ...extra });
  const read = { state: "read" as const };

  it("names every listed file that ended any way but in effect or replayed", () => {
    const exposures = effectExposures({
      dryRun: false,
      manifest: read,
      outcomes: [
        outcome("20270204090000_a.sql", "already_in_effect"),
        outcome("20270205100000_b.sql", "replayed", { applied: true }),
        outcome("20270206000000_c.sql", "refused", { why: "withdrawn" }),
        outcome("20270207000000_d.sql", "dry_run_failed", { why: "no role", sqlstate: "42704" }),
        outcome("20270208000000_e.sql", "apply_failed", { why: "probe false" }),
        outcome("20270209000000_f.sql", "probe_unreadable", { why: "no answer", transient: true }),
        outcome("20270210000000_g.sql", "not_reached"),
      ],
    });
    expect(exposures.map((e) => [e.file.slice(15), e.status, e.transient ?? false])).toEqual([
      ["c.sql", "refused", false],
      ["d.sql", "dry_run_failed", false],
      ["e.sql", "apply_failed", false],
      ["f.sql", "probe_unreadable", true],
      ["g.sql", "not_reached", true],
    ]);
  });

  it("names the manifest where no file could be reached, and nothing for a dry run", () => {
    expect(
      effectExposures({
        dryRun: false,
        manifest: { state: "unfetched", why: "503" },
        outcomes: [],
      }),
    ).toEqual([
      { file: EFFECT_REPLAYS_PATH, status: "manifest_unfetched", why: "503", transient: true },
    ]);
    expect(
      effectExposures({
        dryRun: false,
        manifest: { state: "unreadable", why: "schema_version 2" },
        outcomes: [],
      }),
    ).toEqual([
      { file: EFFECT_REPLAYS_PATH, status: "manifest_unreadable", why: "schema_version 2" },
    ]);
    // An absent manifest approves nothing, so nothing is owed.
    expect(effectExposures({ dryRun: false, manifest: { state: "absent" }, outcomes: [] })).toEqual(
      [],
    );
    expect(
      effectExposures({
        dryRun: true,
        manifest: read,
        outcomes: [outcome("20270207000000_d.sql", "dry_run_failed")],
      }),
    ).toEqual([]);
    expect(notReplayed("the prime could not be read")).toEqual({
      file: EFFECT_REPLAYS_PATH,
      status: "not_replayed",
      why: "the prime could not be read",
      transient: true,
    });
  });

  it("reads what was told for this project and stamp only, the stamp compared as an instant", () => {
    const records = [
      {
        metadata: {
          project_ref: "p1",
          stamped_at: "2026-10-29 22:11:49.645+00",
          exposures: ["a.sql|refused"],
        },
      },
      {
        metadata: {
          project_ref: "p1",
          stamped_at: "2026-10-30T00:00:00.000Z",
          exposures: ["b.sql|refused"],
        },
      },
      {
        metadata: {
          project_ref: "p2",
          stamped_at: "2026-10-29T22:11:49.645Z",
          exposures: ["c.sql|refused"],
        },
      },
      { metadata: { project_ref: "p1", stamped_at: null, exposures: ["d.sql|refused"] } },
      { metadata: null },
    ];
    expect([
      ...exposuresTold(records, { projectRef: "p1", stampedAt: "2026-10-29T22:11:49.645Z" }),
    ]).toEqual(["a.sql|refused"]);
    // A clone never stamped is told once too, under no stamp.
    expect([...exposuresTold(records, { projectRef: "p1", stampedAt: null })]).toEqual([
      "d.sql|refused",
    ]);
  });

  it("tells what was not told before, loudest where a person must change something", () => {
    const verdict = { file: "a.sql", status: "apply_failed" as const };
    const reading = { file: "b.sql", status: "not_reached" as const, transient: true };
    expect(decideEffectNotice({ exposures: [], told: new Set() })).toEqual({
      notify: false,
      reason: "nothing_exposed",
    });
    expect(
      decideEffectNotice({ exposures: [verdict], told: new Set(["a.sql|apply_failed"]) }),
    ).toEqual({ notify: false, reason: "told_before" });
    expect(decideEffectNotice({ exposures: [reading], told: new Set() })).toMatchObject({
      notify: true,
      severity: "warning",
    });
    expect(
      decideEffectNotice({ exposures: [verdict, reading], told: new Set(["a.sql|apply_failed"]) }),
    ).toMatchObject({ notify: true, severity: "error", fresh: [reading] });
    // The same file ending another way is told: a budget stop the resumed pass turned into a failure.
    expect(
      decideEffectNotice({
        exposures: [{ ...verdict, status: "dry_run_failed" }],
        told: new Set(["a.sql|not_reached"]),
      }),
    ).toMatchObject({ notify: true });
    // A record that could not be read is not one that says "told".
    expect(decideEffectNotice({ exposures: [verdict], told: null })).toMatchObject({
      notify: true,
      fresh: [verdict],
    });
  });

  it("says each file, how it ended and why, marks what is new, and caps the list", () => {
    const exposures = Array.from({ length: 14 }, (_, i) => ({
      file: `2027020${String(i).padStart(7, "0")}_f${i}.sql`,
      status: "apply_failed" as const,
      why: `reason ${i}`,
    }));
    const text = describeEffectNotice({
      cloneName: "Orrimere",
      projectRef: "orrimereorrimereorri",
      stampedAt: "2026-10-29 22:11:49.645+00",
      commit: "18685b30892c2f5fcfd1f59ad754a5430fb08145",
      exposures,
      fresh: exposures.slice(0, 1),
    });
    expect(text.title).toBe(
      "Orrimere: 14 approved privilege or policy fixes not confirmed in effect",
    );
    expect(text.body).toContain(`${EFFECT_REPLAYS_PATH} at 18685b3 approves these files`);
    expect(text.body).toContain("ledger stamped 2026-10-29T22:11:49.645Z");
    expect(text.body).toContain(`- ${exposures[0].file}: apply failed — reason 0 (new)`);
    expect(text.body).toContain(`- ${exposures[1].file}: apply failed — reason 1\n`);
    expect(text.body).not.toContain(exposures[12].file);
    expect(text.body).toContain("- and 2 more");
    expect(text.body).toContain("/hooks/clone-effect-replay");

    const all = describeEffectNotice({
      cloneName: "Orrimere",
      projectRef: "orrimereorrimereorri",
      stampedAt: null,
      commit: null,
      exposures: exposures.slice(0, 1),
      fresh: exposures.slice(0, 1),
    });
    // Nothing is marked new when everything is.
    expect(all.body).not.toContain("(new)");
    expect(all.body).toContain("ledger not stamped");
    expect(all.title).toBe("Orrimere: 1 approved privilege or policy fix not confirmed in effect");
  });

  it("says the build resumes a budget stop only when it does", () => {
    const stopped = [
      { file: "20270210090000_c.sql", status: "not_reached" as const, transient: true },
    ];
    const base = {
      cloneName: null,
      projectRef: "p",
      stampedAt: null,
      commit: null,
      exposures: stopped,
      fresh: stopped,
    };
    const resumed = describeEffectNotice({ ...base, resumes: true });
    expect(resumed.title).toBe(
      "A clone: 1 approved privilege or policy fix not confirmed in effect",
    );
    expect(resumed.body).toContain("not reached before the budget ran out");
    expect(resumed.body).toContain("The build's next pass resumes what this one did not reach");
    expect(describeEffectNotice(base).body).not.toContain("next pass resumes");
  });

  it("titles a run that reached no file as one that replayed nothing", () => {
    const text = describeEffectNotice({
      cloneName: null,
      projectRef: "p",
      stampedAt: null,
      commit: "18685b30892c2f5fcfd1f59ad754a5430fb08145",
      exposures: [notReplayed("the prime could not be read (503)")],
      fresh: [notReplayed("the prime could not be read (503)")],
    });
    expect(text.title).toBe("A clone: the approved privilege and policy fixes were not replayed");
    expect(text.body).toContain("not replayed: the prime could not be read (503)");
    expect(text.body).toContain("may lack every privilege and policy fix the owner approved");
  });
});
