import { describe, expect, it } from "vitest";
import { planBlockageReconcile, type OpenBlockageRow } from "./blockageReconcile.pure";
import type { DetectedBlockage } from "./blockageTaxonomy.pure";

const detected = (fingerprint: string, detail = `detail of ${fingerprint}`): DetectedBlockage => ({
  cls: "ci_red",
  owner: "prime_author",
  selfHeals: false,
  fingerprint,
  detail,
  since: "2026-09-27T01:00:00.000Z",
});
const row = (id: string, fingerprint: string): OpenBlockageRow => ({ id, fingerprint });

describe("planBlockageReconcile", () => {
  it("refreshes what still holds, opens what is new, clears what nothing detected", () => {
    const plan = planBlockageReconcile(
      [row("a", "ci_red:A"), row("b", "ci_red:B")],
      [detected("ci_red:A"), detected("ci_red:C")],
    );
    expect(plan.refresh.map((r) => [r.id, r.detected.fingerprint])).toEqual([["a", "ci_red:A"]]);
    expect(plan.open.map((d) => d.fingerprint)).toEqual(["ci_red:C"]);
    expect(plan.clear).toEqual(["b"]);
  });

  it("an empty pass against an empty set does nothing", () => {
    expect(planBlockageReconcile([], [])).toEqual({ refresh: [], open: [], clear: [] });
  });

  /*
    The defect this module exists to close. The open set is read as a map on
    the fingerprint, so a second open row with one identity was never
    refreshed and never cleared by any pass — open for ever.
  */
  it("keeps the first open row of a duplicated identity and clears the rest", () => {
    const plan = planBlockageReconcile(
      [row("old", "ci_red:A"), row("dup1", "ci_red:A"), row("dup2", "ci_red:A")],
      [detected("ci_red:A")],
    );
    expect(plan.refresh.map((r) => r.id)).toEqual(["old"]);
    expect(plan.open).toEqual([]);
    expect(plan.clear.sort()).toEqual(["dup1", "dup2"]);
  });

  it("clears every copy of a duplicated identity once nothing detects it", () => {
    const plan = planBlockageReconcile([row("x1", "ci_red:A"), row("x2", "ci_red:A")], []);
    expect(plan.refresh).toEqual([]);
    expect(plan.clear.sort()).toEqual(["x1", "x2"]);
  });

  it("a repeated detection opens one row, not two", () => {
    const plan = planBlockageReconcile([], [detected("ci_red:A", "first"), detected("ci_red:A", "second")]);
    expect(plan.open.map((d) => d.detail)).toEqual(["first"]);
  });

  it("a repeated detection refreshes the kept row once", () => {
    const plan = planBlockageReconcile(
      [row("a", "ci_red:A")],
      [detected("ci_red:A", "first"), detected("ci_red:A", "second")],
    );
    expect(plan.refresh).toEqual([{ id: "a", detected: detected("ci_red:A", "first") }]);
    expect(plan.clear).toEqual([]);
  });

  it("every open row lands in exactly one of refresh or clear", () => {
    const open = [row("1", "A"), row("2", "B"), row("3", "A"), row("4", "C"), row("5", "B")];
    const plan = planBlockageReconcile(open, [detected("A"), detected("D")]);
    const touched = [...plan.refresh.map((r) => r.id), ...plan.clear].sort();
    expect(touched).toEqual(["1", "2", "3", "4", "5"]);
    expect(new Set(touched).size).toBe(touched.length);
  });
});
