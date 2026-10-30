import { describe, expect, it } from "vitest";
import {
  PROBES_PER_STATEMENT,
  PROBE_BATCH_MARKER,
  assertLockTimeout,
  dollarTag,
  effectProbeIn,
  probeBatchStatement,
  probeIsReadOnly,
  readProbeBatch,
} from "./migrationEffectProbe.pure";

/**
 * A probe is read and refused exactly as the prime reads and refuses it
 * (`effectProbeIn` in `scripts/build-migration-object-index.mjs`,
 * `probeIsReadOnly` in `scripts/ops/migrationDrift.pure.mjs`), so the drift
 * report and a clone's build can never disagree about a file's probe.
 */

/** The first line of the prime's 20270210090000, verbatim (30 Oct 2026). */
const INTEGRATION_CONFIGS =
  "select 1 where not exists (select 1 from pg_class c cross join lateral unnest(c.relacl) i where c.oid = to_regclass('public.integration_configs') and i::text ~ '^(anon|authenticated)=')";

/** The probe of the prime's 20270205100000, verbatim. */
const STORAGE_POLICIES =
  "select 1 where to_regclass('storage.objects') is null or (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('service_role_select_agency_agreements', 'service_role_insert_agency_agreements', 'service_role_update_agency_agreements', 'service_role_delete_agency_agreements', 'service_role_select_marketing_reports', 'service_role_insert_marketing_reports', 'service_role_update_marketing_reports', 'service_role_delete_marketing_reports', 'listing_images_objects_service_role_only', 'partner_agreements_service')) = 10";

describe("effectProbeIn — the prime's rule", () => {
  it("reads the probe a file opens with, trimmed", () => {
    const src = `-- @effect: ${INTEGRATION_CONFIGS}   \n--\n-- prose\ndo $revoke$ begin end $revoke$;\n`;
    expect(effectProbeIn(src)).toBe(INTEGRATION_CONFIGS);
  });

  it("finds it on a later line too, because the prime's extractor does", () => {
    // 20261213000000_market_building_approvals.sql declares its probe on line 3.
    const src =
      "-- Market building approvals\n--\n-- @effect: select 1 from public.t\ncreate table t ();";
    expect(effectProbeIn(src)).toBe("select 1 from public.t");
  });

  it("takes the first when a file names two, and ignores case in the marker", () => {
    expect(effectProbeIn("-- @EFFECT: select 1\n-- @effect: select 2")).toBe("select 1");
  });

  it("answers null for a file with none, and for nothing at all", () => {
    expect(effectProbeIn("create table t ();")).toBeNull();
    expect(effectProbeIn("select 1 -- @effect: not at a line start")).toBeNull();
    expect(effectProbeIn(null)).toBeNull();
    expect(effectProbeIn(undefined)).toBeNull();
  });
});

describe("probeIsReadOnly — the prime's rule", () => {
  it("admits the prime's own probes", () => {
    expect(probeIsReadOnly(INTEGRATION_CONFIGS)).toBe(true);
    expect(probeIsReadOnly(STORAGE_POLICIES)).toBe(true);
    expect(
      probeIsReadOnly("SELECT 1 FROM public.template_library_entries WHERE version = 18"),
    ).toBe(true);
  });

  it("refuses a second statement, anything but a SELECT, and an empty probe", () => {
    expect(probeIsReadOnly("select 1; select 2")).toBe(false);
    expect(probeIsReadOnly("with x as (select 1) select * from x")).toBe(false);
    expect(probeIsReadOnly("")).toBe(false);
    expect(probeIsReadOnly("   ")).toBe(false);
    expect(probeIsReadOnly(null)).toBe(false);
  });

  it("refuses every word that changes something, as a word", () => {
    for (const w of [
      "insert",
      "update",
      "delete",
      "drop",
      "alter",
      "create",
      "truncate",
      "grant",
      "revoke",
      "copy",
      "do",
      "call",
    ]) {
      expect(probeIsReadOnly(`select 1 where exists (select ${w})`), w).toBe(false);
      expect(probeIsReadOnly(`select 1 where exists (select ${w.toUpperCase()})`), w).toBe(false);
    }
  });

  it("does not mistake a name that contains one for the word", () => {
    // `document_records`, `updated_at`, `notification_deliveries` sit in the
    // prime's 20270205090000 probe and in ordinary columns.
    expect(probeIsReadOnly("select 1 from document_records where updated_at is not null")).toBe(
      true,
    );
    expect(probeIsReadOnly("select 1 from notification_deliveries, call_tags")).toBe(true);
  });
});

describe("dollarTag", () => {
  it("is the plain tag unless a text holds it, then the first numbered one none holds", () => {
    expect(dollarTag("effect_body", ["revoke all"])).toBe("$mc_effect_body$");
    expect(dollarTag("effect_body", ["x $mc_effect_body$ y"])).toBe("$mc_effect_body_1$");
    expect(dollarTag("effect_body", ["$mc_effect_body$", "$mc_effect_body_1$"])).toBe(
      "$mc_effect_body_2$",
    );
  });

  it("refuses a label that is not an identifier", () => {
    expect(() => dollarTag("Body$", [])).toThrow();
    expect(() => dollarTag("1x", [])).toThrow();
  });
});

describe("assertLockTimeout", () => {
  it("passes a Postgres duration and refuses anything else", () => {
    expect(assertLockTimeout("3s")).toBe("3s");
    expect(assertLockTimeout("500ms")).toBe("500ms");
    expect(() => assertLockTimeout("3s'; drop table x; --")).toThrow();
  });
});

describe("probeBatchStatement", () => {
  const stmt = probeBatchStatement([INTEGRATION_CONFIGS, STORAGE_POLICIES], { lockTimeout: "3s" });

  it("is one DO block that goes read-only before anything else", () => {
    expect(stmt.startsWith("do $mc_effect_probes$")).toBe(true);
    expect(stmt.trimEnd().endsWith("$mc_effect_probes$;")).toBe(true);
    const readOnly = stmt.indexOf("set_config('transaction_read_only', 'on', true)");
    expect(readOnly).toBeGreaterThan(-1);
    expect(readOnly).toBeLessThan(stmt.indexOf("execute"));
    expect(stmt).toContain("set_config('lock_timeout', '3s', true)");
  });

  it("evaluates each probe as exists(), in its own block, under its own tag", () => {
    expect(stmt).toContain(`$mc_effect_probe_0$${INTEGRATION_CONFIGS}$mc_effect_probe_0$`);
    expect(stmt).toContain(`$mc_effect_probe_1$${STORAGE_POLICIES}$mc_effect_probe_1$`);
    expect(stmt).toContain("'select exists(' || chr(10) ||");
    expect(stmt.match(/exception when others then/g)).toHaveLength(2);
    expect(stmt).toContain("'0=error:' || sqlstate");
    expect(stmt).toContain("'1=error:' || sqlstate");
  });

  it("always ends by raising the answers, so nothing it does can commit", () => {
    const raise = stmt.lastIndexOf(`raise exception '${PROBE_BATCH_MARKER} %'`);
    expect(raise).toBeGreaterThan(stmt.lastIndexOf("end;"));
  });

  it("never sends a probe the guard refuses, and never an empty or oversized batch", () => {
    expect(() => probeBatchStatement(["select 1; delete from t"], { lockTimeout: "3s" })).toThrow();
    expect(() => probeBatchStatement([], { lockTimeout: "3s" })).toThrow();
    expect(() =>
      probeBatchStatement(
        Array.from({ length: PROBES_PER_STATEMENT + 1 }, () => "select 1"),
        {
          lockTimeout: "3s",
        },
      ),
    ).toThrow();
  });

  it("keeps a tag out of the probe it quotes", () => {
    const sly = "select 1 where '$mc_effect_probe_0$' <> ''";
    const s = probeBatchStatement([sly], { lockTimeout: "3s" });
    expect(s).toContain(`$mc_effect_probe_0_1$${sly}$mc_effect_probe_0_1$`);
  });
});

describe("readProbeBatch", () => {
  /** The shape `runSqlOnProject` throws: the Management API's JSON body appended. */
  const wire = (answers: string) =>
    `SQL execution failed on testtesttesttesttest: 400 — {"message":"Failed to run sql query: ERROR:  P0001: ${PROBE_BATCH_MARKER} ${answers}\\nCONTEXT:  PL/pgSQL function inline_code_block line 26 at RAISE"}`;

  it("reads each answer, an effect or the SQLSTATE a probe raised", () => {
    expect(readProbeBatch(wire("0=true 1=error:42P01 2=false"), 3)).toEqual([
      { kind: "effect", present: true },
      { kind: "error", sqlstate: "42P01" },
      { kind: "effect", present: false },
    ]);
  });

  it("stops at the JSON-escaped newline, so CONTEXT cannot be read as an answer", () => {
    const raw = `${wire("0=true")} 1=false`;
    expect(readProbeBatch(raw, 2)[1].kind).toBe("unread");
  });

  it("reads psql's plain form as well", () => {
    expect(readProbeBatch(`ERROR:  ${PROBE_BATCH_MARKER} 0=false\nCONTEXT: x`, 1)).toEqual([
      { kind: "effect", present: false },
    ]);
  });

  it("calls a missing answer unread, never false", () => {
    const out = readProbeBatch(wire("0=true"), 2);
    expect(out[0]).toEqual({ kind: "effect", present: true });
    expect(out[1].kind).toBe("unread");
  });

  it("calls every probe unread when the statement never reached its end", () => {
    const out = readProbeBatch(
      "SQL execution failed on testtesttesttesttest: 503 — upstream timeout",
      2,
    );
    expect(out.map((a) => a.kind)).toEqual(["unread", "unread"]);
    expect(out[0].kind === "unread" && out[0].why).toContain("upstream timeout");
  });

  it("takes an index's first answer", () => {
    expect(readProbeBatch(wire("0=true 0=false"), 1)).toEqual([{ kind: "effect", present: true }]);
  });
});
