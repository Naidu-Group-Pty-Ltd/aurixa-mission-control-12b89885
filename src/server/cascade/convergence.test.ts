import { describe, expect, it } from "vitest";
import {
  FALLING_BEHIND_WINDOWS,
  fingerprintPaths,
  judgeConvergence,
  measureConvergence,
  owedSample,
  type PriorObservation,
} from "./convergence.pure";
import {
  CASCADE_MAX_FILE_BYTES,
  DEFAULT_MIRROR_EXCLUSIONS,
  type SyncExclusion,
} from "./syncExclusions.pure";

const tree = (entries: Record<string, string>) => new Map(Object.entries(entries));
const NONE: SyncExclusion[] = [];
const AT = (iso: string) => new Date(iso);

describe("measureConvergence", () => {
  it("reports converged when every compared blob matches", () => {
    const m = measureConvergence({
      prime: tree({ "src/a.ts": "aaa", "src/b.ts": "bbb" }),
      clone: tree({ "src/a.ts": "aaa", "src/b.ts": "bbb" }),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
    });
    expect(m).toMatchObject({ kind: "measured", owed: [], fingerprint: null, compared: 2 });
  });

  it("owes a path whose blob differs, and one the clone does not hold", () => {
    const m = measureConvergence({
      prime: tree({ "src/a.ts": "aaa", "src/new.ts": "nnn" }),
      clone: tree({ "src/a.ts": "OLD" }),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
    });
    expect(m.kind === "measured" && m.owed).toEqual(["src/a.ts", "src/new.ts"]);
  });

  /*
    The rule that keeps this reading believable. A held file that has drifted is
    real and is `held-file-drift`'s job; counting it here would leave every
    clone permanently non-convergent on files this platform is forbidden to
    write, which is the fastest way to teach somebody to ignore this reading.
  */
  it("never owes a held path — protected or manual_reconcile", () => {
    const exclusions: SyncExclusion[] = [
      { pattern: "src/integrations/supabase/env.ts", reason: "protected" },
      { pattern: "src/App.tsx", reason: "manual_reconcile" },
    ];
    const m = measureConvergence({
      prime: tree({
        "src/integrations/supabase/env.ts": "PRIME",
        "src/App.tsx": "PRIME",
        "src/ok.ts": "PRIME",
      }),
      clone: tree({
        "src/integrations/supabase/env.ts": "CLONE",
        "src/App.tsx": "CLONE",
        "src/ok.ts": "CLONE",
      }),
      exclusions,
      primeTruncated: false,
      cloneTruncated: false,
    });
    expect(m.kind === "measured" && m.owed).toEqual(["src/ok.ts"]);
    expect(m.kind === "measured" && m.held).toBe(2);
  });

  it("uses the real mirror policy without owing the clone's identity file", () => {
    const m = measureConvergence({
      prime: tree({ "src/integrations/supabase/env.ts": "PRIME_PROJECT" }),
      clone: tree({ "src/integrations/supabase/env.ts": "CLONE_PROJECT" }),
      exclusions: DEFAULT_MIRROR_EXCLUSIONS,
      primeTruncated: false,
      cloneTruncated: false,
    });
    expect(m.kind === "measured" && m.owed).toEqual([]);
  });

  /*
    A deletion verdict belongs to prime's own history and to one implementation
    of it. Counting a candidate is honest; calling it divergence would be a
    second opinion on the most destructive decision in the engine.
  */
  it("counts a clone-only path as a candidate and never as owed", () => {
    const m = measureConvergence({
      prime: tree({ "src/a.ts": "aaa" }),
      clone: tree({ "src/a.ts": "aaa", "clone-only/spec.md": "zzz" }),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
    });
    expect(m).toMatchObject({ kind: "measured", owed: [], deletionCandidates: 1 });
  });

  /*
    Found by running this module against the two live trees before it had ever
    run in production. `owed` was 2, and both were ~41.7 MB template-library
    seeds against an 8 MB ceiling — held by the engine on every pass, for ever,
    and correctly. Reported as owed they would have escalated as `stalled`
    permanently on a fleet behaving exactly as designed.
  */
  it("never owes a path the cascade refuses on size", () => {
    const m = measureConvergence({
      prime: tree({ "supabase/migrations/huge_seed.sql": "PRIME", "src/a.ts": "PRIME" }),
      clone: tree({ "src/a.ts": "CLONE" }),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
      primeSizes: new Map([
        ["supabase/migrations/huge_seed.sql", 41_671_969],
        ["src/a.ts", 400],
      ]),
    });
    expect(m.kind === "measured" && m.owed).toEqual(["src/a.ts"]);
    expect(m.kind === "measured" && m.oversizeHeld).toBe(1);
  });

  it("a file exactly at the ceiling is still deliverable", () => {
    const m = measureConvergence({
      prime: tree({ "big.sql": "PRIME" }),
      clone: tree({}),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
      primeSizes: new Map([["big.sql", CASCADE_MAX_FILE_BYTES]]),
    });
    expect(m.kind === "measured" && m.owed).toEqual(["big.sql"]);
    expect(m.kind === "measured" && m.oversizeHeld).toBe(0);
  });

  /*
    Inventing a refusal from missing data would hide a real gap. Reporting one
    is recoverable; concealing one is the failure this reading exists to stop.
  */
  it("treats an absent size as deliverable rather than as a refusal", () => {
    const m = measureConvergence({
      prime: tree({ "mystery.bin": "PRIME" }),
      clone: tree({}),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
      primeSizes: new Map(),
    });
    expect(m.kind === "measured" && m.owed).toEqual(["mystery.bin"]);
  });

  it("refuses the whole reading on a truncated tree, either side", () => {
    for (const [p, c] of [
      [true, false],
      [false, true],
    ] as const) {
      const m = measureConvergence({
        prime: tree({ "src/a.ts": "aaa" }),
        clone: tree({ "src/a.ts": "aaa" }),
        exclusions: NONE,
        primeTruncated: p,
        cloneTruncated: c,
      });
      expect(m.kind).toBe("unmeasurable");
    }
  });

  it("narrows to a module clone's own section and ignores everything outside it", () => {
    const m = measureConvergence({
      prime: tree({ "src/mod/a.ts": "PRIME", "src/other/b.ts": "PRIME" }),
      clone: tree({ "src/mod/a.ts": "CLONE", "src/other/b.ts": "CLONE" }),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
      scopedTo: new Set(["src/mod/a.ts"]),
    });
    expect(m.kind === "measured" && m.owed).toEqual(["src/mod/a.ts"]);
    expect(m.kind === "measured" && m.compared).toBe(1);
  });
});

describe("fingerprintPaths", () => {
  it("is stable for the same set and differs for a different one", () => {
    expect(fingerprintPaths(["a", "b"])).toBe(fingerprintPaths(["a", "b"]));
    expect(fingerprintPaths(["a", "b"])).not.toBe(fingerprintPaths(["a", "c"]));
  });

  it("carries the count, so a collision cannot confuse two sets of different size", () => {
    expect(fingerprintPaths(["a"]).startsWith("1:")).toBe(true);
    expect(fingerprintPaths(["a", "b", "c"]).startsWith("3:")).toBe(true);
  });

  /* Path separators must not be swallowed: a/b and ab are different files. */
  it("distinguishes sets that concatenate identically", () => {
    expect(fingerprintPaths(["ab", "c"])).not.toBe(fingerprintPaths(["a", "bc"]));
  });
});

describe("judgeConvergence", () => {
  const measured = (owed: string[]) =>
    measureConvergence({
      prime: tree(Object.fromEntries(owed.map((p) => [p, "PRIME"]))),
      clone: tree(Object.fromEntries(owed.map((p) => [p, "CLONE"]))),
      exclusions: NONE,
      primeTruncated: false,
      cloneTruncated: false,
    });

  it("converged resets both clocks and never escalates", () => {
    const r = judgeConvergence({
      now: AT("2026-09-18T10:00:00Z"),
      measurement: measured([]),
      prior: {
        state: "stalled",
        fingerprint: "9:deadbeef",
        unchangedSince: "2026-09-18T01:00:00Z",
        lastConvergedAt: "2026-09-17T00:00:00Z",
      },
      sloMinutes: 90,
    });
    expect(r.state).toBe("converged");
    expect(r.unchangedSince).toBeNull();
    expect(r.lastConvergedAt).toBe("2026-09-18T10:00:00.000Z");
    expect(r.escalates).toBe(false);
  });

  /*
    The 1,253 false alarms all fired here. Every one of them was inside the
    delivery window on a clone that converged minutes later.
  */
  it("is silent inside the delivery window", () => {
    const r = judgeConvergence({
      now: AT("2026-09-18T09:00:00Z"),
      measurement: measured(["src/a.ts"]),
      prior: {
        state: "delivering",
        fingerprint: fingerprintPaths(["src/a.ts"]),
        unchangedSince: "2026-09-18T08:45:00Z",
        lastConvergedAt: "2026-09-18T08:44:00Z",
      },
      sloMinutes: 90,
    });
    expect(r.state).toBe("delivering");
    expect(r.escalates).toBe(false);
  });

  it("stalls when the same set outlives one delivery window", () => {
    const r = judgeConvergence({
      now: AT("2026-09-18T10:20:00Z"),
      measurement: measured(["src/a.ts"]),
      prior: {
        state: "delivering",
        fingerprint: fingerprintPaths(["src/a.ts"]),
        unchangedSince: "2026-09-18T08:45:00Z",
        lastConvergedAt: "2026-09-18T08:44:00Z",
      },
      sloMinutes: 90,
    });
    expect(r.state).toBe("stalled");
    expect(r.escalates).toBe(true);
    expect(r.why).toContain("2026-09-18T08:45:00Z");
  });

  it("restarts the unchanged clock when the owed set moves", () => {
    const r = judgeConvergence({
      now: AT("2026-09-18T10:20:00Z"),
      measurement: measured(["src/b.ts"]),
      prior: {
        state: "delivering",
        fingerprint: fingerprintPaths(["src/a.ts"]),
        unchangedSince: "2026-09-18T08:45:00Z",
        lastConvergedAt: "2026-09-18T08:44:00Z",
      },
      sloMinutes: 90,
    });
    expect(r.state).toBe("delivering");
    expect(r.unchangedSince).toBe("2026-09-18T10:20:00.000Z");
    /* Movement restarts THAT clock and must never restart the other one. */
    expect(r.lastConvergedAt).toBe("2026-09-18T08:44:00Z");
  });

  /*
    The September freeze. Prime moved 118 commits over two days while the fleet
    received nothing: the owed set changed on every pass, so "has it moved?"
    answered yes continuously about a fleet that was frozen. Movement is
    evidence of delivery only if it reaches zero.
  */
  it("falls behind when the set keeps moving but never reaches zero", () => {
    const slo = 90;
    const r = judgeConvergence({
      now: AT("2026-09-16T12:00:00Z"),
      measurement: measured(["src/x.ts"]),
      prior: {
        state: "delivering",
        // a different set every pass — the freeze's own signature
        fingerprint: fingerprintPaths(["src/w.ts"]),
        unchangedSince: "2026-09-16T11:55:00Z",
        lastConvergedAt: "2026-09-14T12:00:00Z",
      },
      sloMinutes: slo,
    });
    expect(r.state).toBe("falling_behind");
    expect(r.escalates).toBe(true);
    expect(r.why).toContain("2026-09-14T12:00:00Z");
  });

  it("falling_behind overrules the appearance of movement inside the window", () => {
    /* Just past the boundary, with a fingerprint that moved this very pass. */
    const slo = 60;
    const lastConverged = AT("2026-09-18T00:00:00Z");
    const now = new Date(lastConverged.getTime() + slo * 60_000 * FALLING_BEHIND_WINDOWS + 1000);
    const r = judgeConvergence({
      now,
      measurement: measured(["src/x.ts"]),
      prior: {
        state: "delivering",
        fingerprint: fingerprintPaths(["src/entirely-different.ts"]),
        unchangedSince: now.toISOString(),
        lastConvergedAt: lastConverged.toISOString(),
      },
      sloMinutes: slo,
    });
    expect(r.state).toBe("falling_behind");
  });

  it("a clone that has never converged is not yet falling behind", () => {
    const r = judgeConvergence({
      now: AT("2026-09-18T10:00:00Z"),
      measurement: measured(["src/a.ts"]),
      prior: null,
      sloMinutes: 90,
    });
    /* First sight of a brand-new clone: nothing to compare against yet. */
    expect(r.state).toBe("delivering");
    expect(r.lastConvergedAt).toBeNull();
    expect(r.escalates).toBe(false);
  });

  /*
    A read that FAILED is not a row that is ABSENT — this repository's most
    repeated rule. `unknown` must never read as converged, and must never
    launder a stall by resetting its clock.
  */
  it("unknown keeps the prior clocks and never reports converged", () => {
    const prior: PriorObservation = {
      state: "stalled",
      fingerprint: "9:deadbeef",
      unchangedSince: "2026-09-18T01:00:00Z",
      lastConvergedAt: "2026-09-17T00:00:00Z",
    };
    const r = judgeConvergence({
      now: AT("2026-09-18T10:00:00Z"),
      measurement: { kind: "unmeasurable", why: "Tree listing truncated" },
      prior,
      sloMinutes: 90,
    });
    expect(r.state).toBe("unknown");
    expect(r.unchangedSince).toBe(prior.unchangedSince);
    expect(r.lastConvergedAt).toBe(prior.lastConvergedAt);
    expect(r.escalates).toBe(false);
  });

  it("only stalled and falling_behind ever escalate", () => {
    const states = new Map<string, boolean>();
    for (const [label, r] of [
      [
        "converged",
        judgeConvergence({
          now: AT("2026-09-18T10:00:00Z"),
          measurement: measured([]),
          prior: null,
          sloMinutes: 90,
        }),
      ],
      [
        "delivering",
        judgeConvergence({
          now: AT("2026-09-18T10:00:00Z"),
          measurement: measured(["a"]),
          prior: null,
          sloMinutes: 90,
        }),
      ],
      [
        "unknown",
        judgeConvergence({
          now: AT("2026-09-18T10:00:00Z"),
          measurement: { kind: "unmeasurable", why: "x" },
          prior: null,
          sloMinutes: 90,
        }),
      ],
    ] as const) {
      states.set(label, r.escalates);
    }
    expect([...states.values()]).toEqual([false, false, false]);
  });
});

describe("owedSample", () => {
  it("is a bounded sample and the count beside it is the true number", () => {
    const owed = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
    expect(owedSample(owed)).toHaveLength(12);
    expect(owed).toHaveLength(40);
  });
});
