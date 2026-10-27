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
  readBuildOf,
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
  // Measured on npc-client-dashboard 27 Oct 2026: built at 4300, then one
  // secret write moved the version to 4301 without rebuilding.
  entrypoint_path:
    "file:///tmp/user_fn_plisdzywzleljorrphxv_e052082d-c9a1-48f3-810f-503d4dc0e8eb_4300/source/abs-data-service/index.ts",
  ...over,
});

describe("readProjectFunctionCopies", () => {
  it("reads a measured row whole", () => {
    expect(readProjectFunctionCopies([row()]).get("abs-data-service")).toEqual({
      updatedMs: 1791788008778,
      id: "e052082d-c9a1-48f3-810f-503d4dc0e8eb",
      version: 4301,
      build: 4300,
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

describe("readBuildOf — the deploy that built the running code", () => {
  const ID = "e052082d-c9a1-48f3-810f-503d4dc0e8eb";
  const raw = (n: string | number, id = ID, slug = "abs-data-service") =>
    `file:///tmp/user_fn_plisdzywzleljorrphxv_${id}_${n}/source/${slug}/index.ts`;

  it("reads the build counter a raw deploy names", () => {
    expect(readBuildOf(raw(4307), ID)).toBe(4307);
    expect(readBuildOf(raw(0), ID)).toBe(0);
  });

  it("reads nothing from a path naming a different function", () => {
    expect(readBuildOf(raw(4307, "7097799b-9698-4c59-983b-ab5782494cf5"), ID)).toBeNull();
  });

  it("reads nothing where the id sits anywhere but the build directory", () => {
    expect(
      readBuildOf(`file:///tmp/user_fn_ref/source/_${ID}_4307/source/index.ts`, ID),
    ).toBeNull();
    expect(readBuildOf(`file:///tmp/other_${ID}_4307/source/x/index.ts`, ID)).toBeNull();
  });

  it("reads nothing from a compressed bundle, whose path is the builder's checkout", () => {
    // Measured: both oversize functions, deployed as eszip bundles.
    expect(
      readBuildOf(
        "file:///home/runner/work/npc-property-dashbord/npc-property-dashbord/supabase/functions/ai-dashboard-agent/index.ts",
        ID,
      ),
    ).toBeNull();
  });

  it("reads nothing it cannot be sure of", () => {
    for (const path of [
      undefined,
      null,
      42,
      "",
      raw("", ID),
      raw("12a", ID),
      raw("-1", ID),
      `file:///tmp/user_fn_ref_${ID}_4307/elsewhere/x/index.ts`,
      raw("99999999999999999999", ID),
    ]) {
      expect(readBuildOf(path, ID)).toBeNull();
    }
    // No id, no build: a row that cannot name its function proves nothing.
    expect(readBuildOf(raw(4307), null)).toBeNull();
  });

  it("is null on a listed row whose path is absent, which leaves the version rule alone", () => {
    const copies = readProjectFunctionCopies([row({ entrypoint_path: undefined })]);
    expect(copies.get("abs-data-service")?.build).toBeNull();
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
