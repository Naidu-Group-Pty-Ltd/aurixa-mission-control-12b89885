import { describe, expect, it } from "vitest";
import { rotate } from "./clonePrivilegeRepair.server";

describe("rotate", () => {
  it("starts the sweep at the offset and keeps every clone", () => {
    expect(rotate(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotate(["a", "b", "c"], 4)).toEqual(["b", "c", "a"]);
    expect(rotate(["a", "b", "c"], -1)).toEqual(["c", "a", "b"]);
    expect(rotate([], 3)).toEqual([]);
  });
});
