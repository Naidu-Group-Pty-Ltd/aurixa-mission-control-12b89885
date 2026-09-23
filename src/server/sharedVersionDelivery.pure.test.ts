import { describe, it, expect } from "vitest";
import {
  SHARED_VERSION_SEPARATOR,
  joinSharedVersionSql,
  missingMembers,
  sharedVersionHoldMessage,
  sharedVersionNote,
  versionUnits,
  wholeRunnableVersions,
} from "./sharedVersionDelivery.pure";

/** Two real pairs from the prime's tree, 23 Sep 2026. */
const A1 = { id: "20260725110000", name: "20260725110000_secure_agent_subscription_approval.sql" };
const A2 = { id: "20260725110000", name: "20260725110000_sign_email_sync_cron_invocations.sql" };
const B1 = { id: "20260729030000", name: "20260729030000_optional_biometric_consent.sql" };
const B2 = { id: "20260729030000", name: "20260729030000_secure_bulk_generation_resume_cron.sql" };
const SOLO = { id: "20260801000000", name: "20260801000000_one_file.sql" };

describe("versionUnits", () => {
  it("keeps a version's files together, in order", () => {
    const units = versionUnits([A1, A2, SOLO, B1, B2]);
    expect(units.map((u) => u.version)).toEqual([A1.id, SOLO.id, B1.id]);
    expect(units[0].members).toEqual([A1, A2]);
    expect(units[1].members).toEqual([SOLO]);
  });

  it("does not split a version whose files arrive apart", () => {
    // Recording a version after half of it is the defect; a unit that could be
    // split in two by an unexpected order would reintroduce it.
    const units = versionUnits([A1, SOLO, A2]);
    expect(units.map((u) => u.members.map((m) => m.name))).toEqual([
      [A1.name, A2.name],
      [SOLO.name],
    ]);
  });

  it("is empty for no files", () => {
    expect(versionUnits([])).toEqual([]);
  });
});

describe("wholeRunnableVersions", () => {
  const corpus = [A1, A2, SOLO, B1, B2];

  it("clears a version only when every file at it was cleared", () => {
    const { runnableIds, split } = wholeRunnableVersions(corpus, [A1, A2, SOLO, B1]);
    expect([...runnableIds].sort()).toEqual([A1.id, SOLO.id].sort());
    expect(split).toEqual([{ version: B1.id, cleared: [B1.name], withheld: [B2.name] }]);
  });

  it("never clears a file because its sibling was", () => {
    // `runnable.map((m) => m.id)` cleared B2 here, which the prime never ran.
    const { runnableIds } = wholeRunnableVersions(corpus, [B1]);
    expect(runnableIds.has(B1.id)).toBe(false);
  });

  it("says nothing about a version none of whose files were cleared", () => {
    const { runnableIds, split } = wholeRunnableVersions(corpus, [SOLO]);
    expect([...runnableIds]).toEqual([SOLO.id]);
    expect(split).toEqual([]);
  });

  it("matches files by name, so a cleared name the corpus lacks clears nothing", () => {
    const { runnableIds } = wholeRunnableVersions(corpus, [
      { id: A1.id, name: "20260725110000_not_in_the_tree.sql" },
    ]);
    expect(runnableIds.size).toBe(0);
  });
});

describe("joinSharedVersionSql", () => {
  it("sends a single file byte-for-byte", () => {
    const body = "create table t (id int)"; // no terminator, no trailing newline
    expect(joinSharedVersionSql([body])).toBe(body);
  });

  it("terminates each file and closes a trailing line comment before the next", () => {
    const joined = joinSharedVersionSql(["select 1 -- first", "select 2;"]);
    expect(joined).toBe(`select 1 -- first${SHARED_VERSION_SEPARATOR}select 2;`);
    // The `--` comment ends at the newline, so the separator's semicolon is
    // live SQL rather than part of the comment.
    expect(joined.split("\n")[1]).toBe(";");
  });

  it("keeps every file's body, in order", () => {
    const joined = joinSharedVersionSql(["a;", "b;", "c;"]);
    expect(joined.indexOf("a;")).toBeLessThan(joined.indexOf("b;"));
    expect(joined.indexOf("b;")).toBeLessThan(joined.indexOf("c;"));
  });

  it("refuses to build a request out of nothing", () => {
    expect(() => joinSharedVersionSql([])).toThrow(/nothing to send/);
  });
});

describe("sharedVersionNote", () => {
  it("names every file that ran, in order", () => {
    expect(sharedVersionNote([A1, A2])).toBe(`${A1.name} + ${A2.name}`);
  });

  it("is the file name alone for a version carried by one file", () => {
    expect(sharedVersionNote([SOLO])).toBe(SOLO.name);
  });
});

describe("missingMembers", () => {
  it("names the corpus files at the version that the replay was not handed", () => {
    expect(missingMembers({ version: B1.id, members: [B1] }, [A1, A2, B1, B2])).toEqual([B2.name]);
  });

  it("is empty when the whole version is present", () => {
    expect(missingMembers({ version: A1.id, members: [A1, A2] }, [A1, A2, B1])).toEqual([]);
  });
});

describe("sharedVersionHoldMessage", () => {
  it("says what was not sent, why, and that the remedy is on the prime", () => {
    const text = sharedVersionHoldMessage({
      reason: "incomplete",
      version: B1.id,
      sending: [B1.name],
      missing: [B2.name],
    });
    expect(text).toContain(`Version ${B1.id} is carried by 2 files`);
    expect(text).toContain(B2.name);
    expect(text).toMatch(/Nothing at this version was sent/);
    expect(text).toMatch(/give each file a version of its own/);
  });

  it("names the file too large to travel with its siblings", () => {
    const text = sharedVersionHoldMessage({
      reason: "too_large",
      version: "20261112000000",
      file: "20261112000000_seed_template_library_v12_guarded_verdict_line.sql",
      files: [
        "20261112000000_client_deals_agent_fee_receipt.sql",
        "20261112000000_seed_template_library_v12_guarded_verdict_line.sql",
      ],
    });
    expect(text).toMatch(/seed_template_library_v12_guarded_verdict_line\.sql is too large/);
    expect(text).toMatch(/Nothing at this version was sent/);
  });
});
