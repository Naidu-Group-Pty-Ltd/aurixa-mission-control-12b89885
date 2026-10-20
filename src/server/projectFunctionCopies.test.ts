/**
 * Reading what a clone's project says it holds.
 *
 * The rows below are shaped like the Management API's own answer, measured on
 * npc-client-dashboard 20 Oct 2026 (`GET /v1/projects/{ref}/functions`): every
 * row carries a uuid `id`, an integer `version`, epoch-millisecond
 * `created_at`/`updated_at` and `status: "ACTIVE"`.
 */
import { describe, expect, it } from "vitest";
import {
  freshnessOf,
  readDeployedCopy,
  readProjectFunctionCopies,
} from "./projectFunctionCopies.pure";

const row = (over: Record<string, unknown> = {}) => ({
  id: "e052082d-c9a1-48f3-810f-503d4dc0e8eb",
  slug: "abs-data-service",
  name: "abs-data-service",
  status: "ACTIVE",
  version: 4301,
  created_at: 1787158524578,
  updated_at: 1791788008778,
  verify_jwt: false,
  import_map: false,
  ...over,
});

describe("readProjectFunctionCopies", () => {
  it("reads a measured row whole", () => {
    expect(readProjectFunctionCopies([row()]).get("abs-data-service")).toEqual({
      updatedMs: 1791788008778,
      id: "e052082d-c9a1-48f3-810f-503d4dc0e8eb",
      version: 4301,
      active: true,
    });
  });

  it("answers no functions for anything that is not a list", () => {
    for (const raw of [null, undefined, {}, "[]", 42]) {
      expect(readProjectFunctionCopies(raw).size).toBe(0);
    }
  });

  it("keeps the timestamp rules the freshness reader always had", () => {
    const copies = readProjectFunctionCopies([
      row({ slug: "secs", updated_at: 1791788008 }),
      row({ slug: "iso", updated_at: "2026-10-12T06:53:28.778Z" }),
      row({ slug: "created-only", updated_at: undefined }),
      row({ slug: "unreadable", updated_at: "not a date", created_at: undefined }),
    ]);
    expect(copies.get("secs")?.updatedMs).toBe(1791788008000);
    expect(copies.get("iso")?.updatedMs).toBe(Date.parse("2026-10-12T06:53:28.778Z"));
    expect(copies.get("created-only")?.updatedMs).toBe(1787158524578);
    // Absent, not zero: "not known to be fresh", which redeploys.
    expect(copies.has("unreadable")).toBe(false);
  });

  it("falls back to the name, and leaves out a row with neither", () => {
    const copies = readProjectFunctionCopies([
      row({ slug: undefined, name: "named-only" }),
      row({ slug: undefined, name: undefined }),
    ]);
    expect([...copies.keys()]).toEqual(["named-only"]);
  });

  it("leaves an id or version it cannot read as null, which no ledger row matches", () => {
    const copies = readProjectFunctionCopies([
      row({ slug: "no-id", id: undefined }),
      row({ slug: "empty-id", id: "" }),
      row({ slug: "string-version", version: "4301" }),
      row({ slug: "fraction", version: 1.5 }),
      row({ slug: "negative", version: -1 }),
    ]);
    expect(copies.get("no-id")?.id).toBeNull();
    expect(copies.get("empty-id")?.id).toBeNull();
    expect(copies.get("string-version")?.version).toBeNull();
    expect(copies.get("fraction")?.version).toBeNull();
    expect(copies.get("negative")?.version).toBeNull();
  });

  it("marks a copy inactive on any reported status but ACTIVE", () => {
    const copies = readProjectFunctionCopies([
      row({ slug: "removed", status: "REMOVED" }),
      row({ slug: "throttled", status: "THROTTLED" }),
      row({ slug: "unstated", status: undefined }),
    ]);
    expect(copies.get("removed")?.active).toBe(false);
    expect(copies.get("throttled")?.active).toBe(false);
    // The timestamp was always read with no status at all; so is this.
    expect(copies.get("unstated")?.active).toBe(true);
  });
});

describe("freshnessOf", () => {
  it("is the timestamps the lane orders and skips by, from the same reading", () => {
    const copies = readProjectFunctionCopies([
      row({ slug: "a", updated_at: 2_000_000_000_000 }),
      row({ slug: "b", updated_at: 1_900_000_000_000 }),
    ]);
    expect([...freshnessOf(copies)]).toEqual([
      ["a", 2_000_000_000_000],
      ["b", 1_900_000_000_000],
    ]);
  });
});

describe("readDeployedCopy — which deploy a successful deploy call made", () => {
  it("reads the documented answer (`DeployFunctionResponse`: id and version, required)", () => {
    expect(readDeployedCopy(row())).toEqual({
      id: "e052082d-c9a1-48f3-810f-503d4dc0e8eb",
      version: 4301,
    });
  });

  it("answers nothing where either is missing or unreadable", () => {
    for (const raw of [
      null,
      "ok",
      {},
      row({ id: undefined }),
      row({ version: undefined }),
      row({ version: "4301" }),
      row({ id: "" }),
    ]) {
      expect(readDeployedCopy(raw)).toBeNull();
    }
  });
});
