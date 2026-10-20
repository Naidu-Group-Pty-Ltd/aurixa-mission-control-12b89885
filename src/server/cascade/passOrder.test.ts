import { describe, expect, it } from "vitest";
import { orderByLineage } from "./cloneCascadeSource.pure";
import { leastRecentlyTouchedFirst } from "./passOrder.pure";

type Row = { id: string; updated_at?: string | null };
const at = (r: Row) => r.updated_at;

describe("leastRecentlyTouchedFirst", () => {
  it("offers the row touched least recently first", () => {
    /* Measured 11–12 Oct 2026: the CRM row paused on every pass of four
       consecutive events and was offered first on the next tick each time,
       so the client-dashboard line's three clones were never reached. */
    const rows: Row[] = [
      { id: "crm", updated_at: "2026-10-12T03:05:00Z" }, // the last pass paused here
      { id: "cd", updated_at: "2026-10-11T22:00:00Z" },
      { id: "preflight", updated_at: "2026-10-11T22:00:01Z" },
    ];
    expect(leastRecentlyTouchedFirst(rows, at).map((r) => r.id)).toEqual([
      "cd",
      "preflight",
      "crm",
    ]);
  });

  it("is a round robin over successive ticks: every clone gets a turn before any gets a second", () => {
    let rows: Row[] = [
      { id: "a", updated_at: "2026-10-12T00:00:00Z" },
      { id: "b", updated_at: "2026-10-12T00:00:00Z" },
      { id: "c", updated_at: "2026-10-12T00:00:00Z" },
    ];
    const served: string[] = [];
    for (let tick = 1; tick <= 6; tick++) {
      const first = leastRecentlyTouchedFirst(rows, at)[0];
      served.push(first.id);
      // The pass pauses on the first row it offers — a write bumps updated_at.
      const now = `2026-10-12T00:0${tick}:00Z`;
      rows = rows.map((r) => (r.id === first.id ? { ...r, updated_at: now } : r));
    }
    expect(served).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("puts a row with no readable time first — it has waited longest", () => {
    const rows: Row[] = [
      { id: "touched", updated_at: "2026-10-12T00:00:00Z" },
      { id: "never", updated_at: null },
      { id: "garbled", updated_at: "not a date" },
    ];
    expect(leastRecentlyTouchedFirst(rows, at).map((r) => r.id)).toEqual([
      "never",
      "garbled",
      "touched",
    ]);
  });

  it("keeps the input order on a tie, and does not mutate its input", () => {
    const rows: Row[] = [
      { id: "x", updated_at: "2026-10-12T00:00:00Z" },
      { id: "y", updated_at: "2026-10-12T00:00:00Z" },
    ];
    const copy = rows.slice();
    expect(leastRecentlyTouchedFirst(rows, at).map((r) => r.id)).toEqual(["x", "y"]);
    expect(rows).toEqual(copy);
  });

  it("runs BEFORE lineage, which still puts a parent ahead of its children", () => {
    type Clone = Row & { parent_clone_id: string | null };
    const rows: Clone[] = [
      { id: "child", parent_clone_id: "cd", updated_at: "2026-10-11T00:00:00Z" },
      { id: "cd", parent_clone_id: null, updated_at: "2026-10-12T05:00:00Z" },
      { id: "crm", parent_clone_id: null, updated_at: "2026-10-12T06:00:00Z" },
    ];
    const ordered = orderByLineage(leastRecentlyTouchedFirst<Clone>(rows, at));
    // The child waited longest but its parent is in the pass, so it follows
    // the parent — immediately, never behind a root it does not depend on.
    // This pinned ["cd", "crm", "child"] until 20 Oct 2026, which is the order
    // that kept NPC Test and Preflight behind the CRM line's pass (F21).
    expect(ordered.map((r) => r.id)).toEqual(["cd", "child", "crm"]);
  });

  it("keeps the CRM line behind the line it does not feed, tick after tick", () => {
    /* The F21 cycle: the CRM line's pass dies inside every tick that reaches
       it, and its row is touched when the pass starts. The client-dashboard
       line gets its turn — parent and both children — on the tick after. */
    type Clone = Row & { parent_clone_id: string | null };
    let rows: Clone[] = [
      { id: "crm", parent_clone_id: null, updated_at: "2026-10-20T04:00:00Z" },
      { id: "cd", parent_clone_id: null, updated_at: "2026-10-20T04:01:00Z" },
      { id: "npc-test", parent_clone_id: "cd", updated_at: "2026-10-20T04:02:00Z" },
      { id: "preflight", parent_clone_id: "cd", updated_at: "2026-10-20T04:03:00Z" },
    ];
    const served: string[][] = [];
    for (let tick = 0; tick < 3 && rows.length > 0; tick += 1) {
      const order = orderByLineage(leastRecentlyTouchedFirst<Clone>(rows, at)).map((r) => r.id);
      // Every clone before the CRM line finishes; the CRM line's pass dies.
      const reached = order.slice(0, order.indexOf("crm") + 1);
      served.push(reached);
      const now = `2026-10-20T05:0${tick}:00Z`;
      rows = rows
        .filter((r) => r.id === "crm" || !reached.includes(r.id))
        .map((r) => (r.id === "crm" ? { ...r, updated_at: now } : r));
    }
    expect(served[0]).toEqual(["crm"]);
    expect(served[1]).toEqual(["cd", "npc-test", "preflight", "crm"]);
  });
});
