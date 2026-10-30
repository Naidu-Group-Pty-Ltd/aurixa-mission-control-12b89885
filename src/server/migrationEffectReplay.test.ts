import { describe, expect, it } from "vitest";
import {
  APPLY_REFUSAL_MARKER,
  DRY_RUN_MARKER,
  EFFECT_REPLAYS_PATH,
  admitBody,
  admitEntry,
  applyStatement,
  buildEffectReport,
  describeReplays,
  describeReport,
  dryRunStatement,
  normaliseInstant,
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
