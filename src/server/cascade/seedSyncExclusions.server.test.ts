import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { seedSyncExclusions } from "./seedSyncExclusions.server";
import { DEFAULT_MIRROR_EXCLUSIONS, assertMirrorPolicy } from "./syncExclusions.pure";

type Row = { clone_id: string; pattern: string; reason: string; note: string | null };

const state = {
  rows: [] as Row[],
  upsertError: null as { message: string } | null,
  lastOptions: null as Record<string, unknown> | null,
};

/** Minimal supabase-js double covering exactly the chain this module uses. */
function fakeSupabase() {
  const from = (table: string) => {
    if (table !== "clone_sync_exclusions") throw new Error(`unexpected table ${table}`);
    return {
      upsert: (rows: Row[], options: Record<string, unknown>) => {
        state.lastOptions = options;
        return {
          select: async () => {
            if (state.upsertError) return { data: null, error: state.upsertError };
            // The table's own unique constraint, emulated. `ignoreDuplicates`
            // means an existing (clone_id, pattern) is left exactly as it is.
            const fresh = rows.filter(
              (r) =>
                !state.rows.some((e) => e.clone_id === r.clone_id && e.pattern === r.pattern),
            );
            state.rows.push(...fresh);
            return { data: fresh.map((r) => ({ pattern: r.pattern })), error: null };
          },
        };
      },
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any;
}

beforeEach(() => {
  state.rows = [];
  state.upsertError = null;
  state.lastOptions = null;
});

describe("seeding a clone's sync exclusion policy", () => {
  it("writes the whole default policy, and the result satisfies assertMirrorPolicy", () => {
    // The point of seeding at all: a clone can be moved to `mirror` afterwards
    // without a hand-written repair. Asserted against the real guard rather
    // than against a row count, because the guard is what actually decides.
    return seedSyncExclusions(fakeSupabase(), "clone-1").then((res) => {
      expect(res.ok).toBe(true);
      expect(res.inserted).toBe(DEFAULT_MIRROR_EXCLUSIONS.length);
      expect(res.offered).toBe(DEFAULT_MIRROR_EXCLUSIONS.length);
      expect(() =>
        assertMirrorPolicy(
          "clone-1",
          state.rows.map((r) => ({
            pattern: r.pattern,
            reason: r.reason as "protected" | "manual_reconcile",
            note: r.note,
          })),
        ),
      ).not.toThrow();
    });
  });

  it("carries every pattern, its reason and its note across unchanged", async () => {
    await seedSyncExclusions(fakeSupabase(), "clone-1");
    for (const e of DEFAULT_MIRROR_EXCLUSIONS) {
      const row = state.rows.find((r) => r.pattern === e.pattern);
      expect(row, `${e.pattern} was not seeded`).toBeDefined();
      expect(row!.reason).toBe(e.reason);
      // The note is what tells the next operator why a path is held. Dropping
      // it would leave a table of patterns with no argument attached to any of
      // them, which is the shape of a policy nobody maintains.
      expect(row!.note).toBe(e.note ?? null);
    }
  });

  it("is idempotent, and never rewrites a row an operator has edited", async () => {
    // The list is "a starting policy, not a constant". A second run — a retry,
    // an idempotent re-provision — must add what is missing and touch nothing
    // that is there, so `ignoreDuplicates` rather than a merge.
    const db = fakeSupabase();
    await seedSyncExclusions(db, "clone-1");
    state.rows[0].note = "edited by an operator";

    const again = await seedSyncExclusions(db, "clone-1");
    expect(again.ok).toBe(true);
    expect(again.inserted).toBe(0);
    expect(state.rows[0].note).toBe("edited by an operator");
    expect(state.lastOptions).toMatchObject({ ignoreDuplicates: true });
  });

  it("seeds each clone separately", async () => {
    const db = fakeSupabase();
    await seedSyncExclusions(db, "clone-1");
    const second = await seedSyncExclusions(db, "clone-2");
    expect(second.inserted).toBe(DEFAULT_MIRROR_EXCLUSIONS.length);
    expect(state.rows.filter((r) => r.clone_id === "clone-2")).toHaveLength(
      DEFAULT_MIRROR_EXCLUSIONS.length,
    );
  });

  it("reports a failure rather than throwing, because it must not fail provisioning", async () => {
    state.upsertError = { message: "permission denied for table clone_sync_exclusions" };
    const res = await seedSyncExclusions(fakeSupabase(), "clone-1");
    expect(res.ok).toBe(false);
    expect(res.inserted).toBe(0);
    expect(res.error).toContain("permission denied");
  });
});

describe("provisioning asks for it", () => {
  it("seeds before the provision cascade that writes into the new repository", () => {
    // A policy that arrives after the first cascade protects nothing that
    // cascade did. Pinned by position in the source, because both are steps in
    // one long function and no unit test of either can see their order.
    const src = readFileSync("src/server/clone-provisioning.server.ts", "utf8");
    const seed = src.indexOf("seedSyncExclusions(supabase");
    const cascade = src.indexOf("clone_provision_modules");
    expect(seed, "provisioning does not seed the policy").toBeGreaterThan(-1);
    expect(cascade, "the provision cascade moved or was renamed").toBeGreaterThan(-1);
    expect(seed).toBeLessThan(cascade);
  });

  it("does not make a seeding failure fatal to a clone that already exists", () => {
    // The clone's repository is forked and its modules are about to install by
    // this point. Refusing all of that to report a gap that was the status quo
    // five minutes earlier is the worse outcome, so the failure is recorded.
    const src = readFileSync("src/server/clone-provisioning.server.ts", "utf8");
    const seed = src.indexOf("const seeded = await seedSyncExclusions(");
    const after = src.slice(seed, seed + 900);
    expect(after).toContain("clone.sync_exclusions_seed_failed");
    expect(after).not.toContain("return { ok: false");
  });
});
