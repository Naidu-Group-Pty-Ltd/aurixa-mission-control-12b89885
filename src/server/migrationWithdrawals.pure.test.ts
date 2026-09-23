import { describe, it, expect } from "vitest";
import {
  WITHDRAWALS_PATH,
  partitionWithdrawn,
  readWithdrawalManifest,
  unreadableWithdrawals,
  withdrawalNotes,
  withdrawnButRecorded,
  withdrawnVersionMessage,
} from "./migrationWithdrawals.pure";

/**
 * The three entries the prime's manifest carried when this was written
 * (23 Sep 2026), with the live file that shares the first one's version.
 */
const PORTFOLIO = "20260724000000_prevent_duplicate_portfolio_publications.sql";
const PORTFOLIO_SIBLING = "20260724000000_live_sibling_that_shares_the_version.sql";
const AML = "20260728120000_aml_verification_checks.sql";
const CASCADE = "20260901000700_partner_portal_agreement_cascade.sql";

const manifest = (withdrawn: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema_version: 1, withdrawn, ...extra });

const meta = (name: string) => ({ id: name.slice(0, 14), name });

describe("readWithdrawalManifest", () => {
  it("reads every listed file when the manifest is whole", () => {
    const r = readWithdrawalManifest(
      manifest([
        { file: PORTFOLIO, reason: "blocked by duplicate rows" },
        { file: AML, reason: "withdrawn at the owner's direction" },
        { file: CASCADE, reason: "blocked by existing rows" },
      ]),
    );
    expect(r.state).toBe("read");
    expect([...r.files].sort()).toEqual([PORTFOLIO, AML, CASCADE].sort());
  });

  it("treats a tree without a manifest as withdrawing nothing", () => {
    const r = readWithdrawalManifest(null);
    expect(r.state).toBe("absent");
    expect(r.files.size).toBe(0);
  });

  it("reads an empty list as a manifest that withdraws nothing", () => {
    const r = readWithdrawalManifest(manifest([]));
    expect(r.state).toBe("read");
    expect(r.files.size).toBe(0);
  });

  /*
    Every malformed shape withdraws NOTHING. Acting on a partial reading could
    stop a clone receiving a file the prime ran, which is a divergence nobody
    would see; withdrawing nothing costs at most the hole this module closes.
  */
  it.each([
    ["not JSON", "{ withdrawn: ["],
    ["an array", JSON.stringify([{ file: AML }])],
    ["null", "null"],
    [
      "an unknown schema version",
      JSON.stringify({ schema_version: 2, withdrawn: [{ file: AML }] }),
    ],
    ["no schema version", JSON.stringify({ withdrawn: [{ file: AML }] })],
    ["no withdrawn array", JSON.stringify({ schema_version: 1 })],
    ["a withdrawn object", JSON.stringify({ schema_version: 1, withdrawn: { file: AML } })],
  ])("is unreadable, and withdraws nothing, when the manifest is %s", (_label, text) => {
    const r = readWithdrawalManifest(text);
    expect(r.state).toBe("unreadable");
    expect(r.files.size).toBe(0);
    expect(r.state === "unreadable" && r.why).toMatch(/MIGRATION_WITHDRAWN\.json/);
  });

  it.each([
    ["a path rather than a file name", `supabase/migrations/${AML}`],
    ["a bare version", "20260728120000"],
    ["a file with no .sql", "20260728120000_aml_verification_checks"],
    ["a thirteen-digit version", "2026072812000_aml.sql"],
    ["a number", 20260728120000],
    ["nothing", undefined],
  ])("refuses the whole manifest when one entry names %s", (_label, file) => {
    const r = readWithdrawalManifest(manifest([{ file: AML }, { file }]));
    expect(r.state).toBe("unreadable");
    // The good entry is NOT acted on: a manifest is read whole or not at all.
    expect(r.files.has(AML)).toBe(false);
    expect(r.state === "unreadable" && r.why).toMatch(/withdrawn\[1\]/);
  });

  it("refuses a null entry rather than throwing", () => {
    const r = readWithdrawalManifest(manifest([null]));
    expect(r.state).toBe("unreadable");
  });

  it("ignores the fields it does not need, so the prime's own gate can grow them", () => {
    const r = readWithdrawalManifest(
      manifest([{ file: AML, reason: "x", decided_by: "owner", effect_probe: "select 1" }], {
        $schema_note: "prose",
      }),
    );
    expect(r.state).toBe("read");
    expect(r.files.has(AML)).toBe(true);
  });
});

describe("unreadableWithdrawals", () => {
  it("excludes nothing and keeps the reason", () => {
    const r = unreadableWithdrawals("could not be fetched");
    expect(r).toEqual({ state: "unreadable", files: new Set(), why: "could not be fetched" });
  });
});

describe("partitionWithdrawn", () => {
  const corpus = [meta(PORTFOLIO_SIBLING), meta(PORTFOLIO), meta(AML), meta(CASCADE)];

  it("takes out exactly the listed files, by name", () => {
    const reading = readWithdrawalManifest(manifest([{ file: PORTFOLIO }, { file: AML }]));
    const { kept, withdrawn, unmatched } = partitionWithdrawn(corpus, reading);
    expect(withdrawn.map((m) => m.name)).toEqual([PORTFOLIO, AML]);
    expect(kept.map((m) => m.name)).toEqual([PORTFOLIO_SIBLING, CASCADE]);
    expect(unmatched).toEqual([]);
  });

  it("never withdraws a live file because it shares a withdrawn file's version", () => {
    const reading = readWithdrawalManifest(manifest([{ file: PORTFOLIO }]));
    const { kept } = partitionWithdrawn(corpus, reading);
    expect(kept.map((m) => m.name)).toContain(PORTFOLIO_SIBLING);
    // The version survives on the live file, so `byId` resolves to it.
    expect(new Map(kept.map((m) => [m.id, m.name])).get("20260724000000")).toBe(PORTFOLIO_SIBLING);
  });

  it("names a listed file the tree does not carry rather than ignoring it", () => {
    const reading = readWithdrawalManifest(
      manifest([{ file: AML }, { file: "20990101000000_not_in_the_tree.sql" }]),
    );
    const { withdrawn, unmatched } = partitionWithdrawn(corpus, reading);
    expect(withdrawn.map((m) => m.name)).toEqual([AML]);
    expect(unmatched).toEqual(["20990101000000_not_in_the_tree.sql"]);
  });

  it.each([
    ["absent", readWithdrawalManifest(null)],
    ["unreadable", readWithdrawalManifest("not json")],
  ])("keeps every file when the manifest is %s", (_label, reading) => {
    const { kept, withdrawn, unmatched } = partitionWithdrawn(corpus, reading);
    expect(kept).toEqual(corpus);
    expect(withdrawn).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  it("preserves corpus order in what it keeps", () => {
    const reading = readWithdrawalManifest(manifest([{ file: AML }]));
    const { kept } = partitionWithdrawn(corpus, reading);
    expect(kept.map((m) => m.name)).toEqual([PORTFOLIO_SIBLING, PORTFOLIO, CASCADE]);
  });
});

describe("withdrawnButRecorded", () => {
  it("names a withdrawn version the prime's ledger records", () => {
    const withdrawn = [meta(AML), meta(CASCADE)];
    const out = withdrawnButRecorded(withdrawn, new Set(), new Set(["20260728120000"]));
    expect(out.map((m) => m.name)).toEqual([AML]);
  });

  it("stays silent where a kept file shares the version, because the row can be the kept file's", () => {
    const withdrawn = [meta(PORTFOLIO)];
    const out = withdrawnButRecorded(
      withdrawn,
      new Set(["20260724000000"]),
      new Set(["20260724000000"]),
    );
    expect(out).toEqual([]);
  });

  it("says nothing when the prime has not recorded it, which is the declared state", () => {
    expect(withdrawnButRecorded([meta(AML)], new Set(), new Set())).toEqual([]);
  });
});

describe("withdrawalNotes", () => {
  it("says nothing when there is no manifest and nothing was excluded", () => {
    expect(withdrawalNotes({ state: "absent", excluded: [], unmatched: [] })).toEqual([]);
  });

  it("always says when the manifest is unreadable, because that is when a withdrawal becomes a hole", () => {
    const notes = withdrawalNotes({
      state: "unreadable",
      why: "MIGRATION_WITHDRAWN.json is not valid JSON",
      excluded: [],
      unmatched: [],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/could not be used/);
    expect(notes[0]).toMatch(/not valid JSON/);
    expect(notes[0]).toMatch(/owed by every clone again/);
  });

  it("names every excluded file", () => {
    const [note] = withdrawalNotes({
      state: "read",
      excluded: [meta(PORTFOLIO), meta(AML)],
      unmatched: [],
    });
    expect(note).toMatch(/^2 migration files are declared withdrawn/);
    expect(note).toContain(PORTFOLIO);
    expect(note).toContain(AML);
  });

  it("names a declaration nothing enforces", () => {
    const notes = withdrawalNotes({
      state: "read",
      excluded: [],
      unmatched: ["20990101000000_gone.sql"],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/does not carry/);
    expect(notes[0]).toContain("20990101000000_gone.sql");
  });
});

describe("withdrawnVersionMessage", () => {
  it("names the file, the manifest and how to reverse it", () => {
    const text = withdrawnVersionMessage("20260728120000", [meta(AML)]);
    expect(text).toContain(AML);
    expect(text).toContain(WITHDRAWALS_PATH);
    expect(text).toMatch(/is declared withdrawn/);
    expect(text).toMatch(/does not send, dry-run, repair or count version 20260728120000/);
    expect(text).toMatch(/remove its entry on the prime/);
  });

  it("agrees in number with two files", () => {
    const text = withdrawnVersionMessage("20260724000000", [meta(PORTFOLIO), meta(PORTFOLIO)]);
    expect(text).toMatch(/are declared withdrawn/);
    expect(text).toMatch(/their effect/);
  });
});
