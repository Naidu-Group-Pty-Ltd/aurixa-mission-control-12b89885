import { describe, expect, it } from "vitest";
import type { HeldPathEvidence } from "./heldEvidence.pure";
import {
  EDGE_FUNCTION_FILE,
  MAX_STRANDED_PROBES,
  decideStrandedRefresh,
  describeStrandedFunctions,
  strandedFilesToProbe,
  strandedFunctionFiles,
  strandedRefreshPaths,
  strandedSuffixFor,
  type StrandedFunctionFile,
  type StrandedVerdict,
} from "./strandedFunctions.pure";

/**
 * The shape measured on `npc-crm-independent-6505dc` at prime@cdff4f2: a
 * render handler no installed module names, held by the clone at a version
 * prime shipped weeks earlier, beside the shared layer that crosses every pass.
 */
const HANDLER = "supabase/functions/render-report-qa-pdf/index.ts";
const CLONE_BLOB = "c".repeat(40);
const OLDER_BLOB = "1".repeat(40);
const PRIME_BLOB = "p".repeat(40);

const file = (over: Partial<StrandedFunctionFile> = {}): StrandedFunctionFile => ({
  path: HANDLER,
  cloneSha: CLONE_BLOB,
  primeSha: PRIME_BLOB,
  ...over,
});

const primeVersions = (versions: string[], versionsExhaustive = true): HeldPathEvidence => ({
  kind: "prime_versions",
  versions,
  versionsExhaustive,
});

describe("EDGE_FUNCTION_FILE — a file inside one function's own directory", () => {
  it("matches a handler and the files beside it", () => {
    expect(EDGE_FUNCTION_FILE.test(HANDLER)).toBe(true);
    expect(EDGE_FUNCTION_FILE.test("supabase/functions/aml-cases/lib/rules.ts")).toBe(true);
  });

  it("never matches the shared layer, which crosses on every clone already", () => {
    expect(EDGE_FUNCTION_FILE.test("supabase/functions/_shared/reportDesign/css.pure.ts")).toBe(
      false,
    );
    expect(EDGE_FUNCTION_FILE.test("supabase/functions/_lib/x.ts")).toBe(false);
  });

  it("never matches a file at the functions root, which belongs to no function", () => {
    expect(EDGE_FUNCTION_FILE.test("supabase/functions/import_map.json")).toBe(false);
    expect(EDGE_FUNCTION_FILE.test("supabase/functions-registry/SECURITY_REGISTRY.json")).toBe(
      false,
    );
  });
});

describe("strandedFunctionFiles — what the clone holds, out of scope and behind", () => {
  const prime = new Map([
    [HANDLER, PRIME_BLOB],
    ["supabase/functions/in-scope/index.ts", "p2"],
    ["supabase/functions/current/index.ts", "same"],
    ["supabase/functions/new-on-prime/index.ts", "p3"],
    ["supabase/functions/_shared/x.ts", "p4"],
  ]);
  const clone = new Map([
    [HANDLER, CLONE_BLOB],
    ["supabase/functions/in-scope/index.ts", "c2"],
    ["supabase/functions/current/index.ts", "same"],
    ["supabase/functions/clone-only/index.ts", "c5"],
    ["supabase/functions/_shared/x.ts", "c4"],
  ]);

  it("returns exactly the out-of-scope function files whose blob differs", () => {
    const got = strandedFunctionFiles({
      prime,
      clone,
      inScope: new Set(["supabase/functions/in-scope/index.ts", "supabase/functions/_shared/x.ts"]),
    });
    expect(got).toEqual([{ path: HANDLER, cloneSha: CLONE_BLOB, primeSha: PRIME_BLOB }]);
  });

  it("never names a function the clone lacks — adding one is an installation, not a refresh", () => {
    const got = strandedFunctionFiles({ prime, clone, inScope: new Set() });
    expect(got.map((f) => f.path)).not.toContain("supabase/functions/new-on-prime/index.ts");
  });

  it("never names a file prime lacks — that is the deletion question, asked elsewhere", () => {
    const got = strandedFunctionFiles({ prime, clone, inScope: new Set() });
    expect(got.map((f) => f.path)).not.toContain("supabase/functions/clone-only/index.ts");
  });

  it("sorts by path, so a pass asks the same questions in the same order", () => {
    const got = strandedFunctionFiles({
      prime: new Map([
        ["supabase/functions/b/index.ts", "1"],
        ["supabase/functions/a/index.ts", "1"],
      ]),
      clone: new Map([
        ["supabase/functions/b/index.ts", "2"],
        ["supabase/functions/a/index.ts", "2"],
      ]),
      inScope: new Set(),
    });
    expect(got.map((f) => f.path)).toEqual([
      "supabase/functions/a/index.ts",
      "supabase/functions/b/index.ts",
    ]);
  });
});

describe("strandedFilesToProbe — a bounded, resumable window", () => {
  const files = Array.from({ length: 5 }, (_, i) =>
    file({ path: `supabase/functions/f${i}/index.ts` }),
  );

  it("skips a file already settled by the ledger or an approval", () => {
    const got = strandedFilesToProbe({ files, settled: new Set([files[0].path, files[2].path]) });
    expect(got.map((f) => f.path)).toEqual([files[1].path, files[3].path, files[4].path]);
  });

  it("walks at most the ceiling", () => {
    expect(strandedFilesToProbe({ files, settled: new Set(), max: 2 })).toHaveLength(2);
    expect(MAX_STRANDED_PROBES).toBeGreaterThanOrEqual(14);
  });

  it("starts the window where the rotation says, and wraps", () => {
    const got = strandedFilesToProbe({ files, settled: new Set(), max: 3, rotation: 4 });
    expect(got.map((f) => f.path)).toEqual([files[4].path, files[0].path, files[1].path]);
  });

  it("asks nothing when everything is settled", () => {
    expect(strandedFilesToProbe({ files, settled: new Set(files.map((f) => f.path)) })).toEqual([]);
  });
});

describe("decideStrandedRefresh — the hold-release evidence, asked of an out-of-scope file", () => {
  it("refreshes a copy that is byte-identical to a version prime held", () => {
    const v = decideStrandedRefresh({
      file: file(),
      evidence: primeVersions([PRIME_BLOB, CLONE_BLOB, OLDER_BLOB]),
      approved: false,
    });
    expect(v).toMatchObject({ act: "refresh", basis: "unedited", path: HANDLER });
  });

  it("keeps a copy that matches no version prime held — that is the clone's own work", () => {
    const v = decideStrandedRefresh({
      file: file(),
      evidence: primeVersions([PRIME_BLOB, OLDER_BLOB]),
      approved: false,
    });
    expect(v).toMatchObject({ act: "keep", settled: true });
    expect(v.why).toMatch(/carries work done here/);
  });

  it("keeps a copy older than the walk reached, and says the walk stopped rather than guessing", () => {
    // `builder-stock-marketplace` on the independent: prime's version fifteen
    // commits back, beyond the ten the walk reads.
    const v = decideStrandedRefresh({
      file: file(),
      evidence: primeVersions(
        Array.from({ length: 10 }, (_, i) => String(i).repeat(40)),
        false,
      ),
      approved: false,
    });
    expect(v).toMatchObject({ act: "keep", settled: true });
    expect(v.why).toMatch(/did not reach the beginning/);
  });

  it("refreshes on a recorded operator approval whatever the evidence says", () => {
    const v = decideStrandedRefresh({
      file: file(),
      evidence: primeVersions([PRIME_BLOB]),
      approved: true,
    });
    expect(v).toMatchObject({ act: "refresh", basis: "approved" });
  });

  it("never refreshes on a walk that was not made or could not be read", () => {
    expect(decideStrandedRefresh({ file: file(), evidence: null, approved: false })).toMatchObject({
      act: "keep",
      settled: false,
    });
    expect(
      decideStrandedRefresh({
        file: file(),
        evidence: { kind: "unsettled", why: "503" },
        approved: false,
      }),
    ).toMatchObject({ act: "keep", settled: false });
  });

  it("never refreshes on a history that never touched the path", () => {
    expect(
      decideStrandedRefresh({ file: file(), evidence: { kind: "never_primes" }, approved: false }),
    ).toMatchObject({ act: "keep", settled: true });
  });
});

describe("reporting what a pass did", () => {
  const verdicts: StrandedVerdict[] = [
    { path: "supabase/functions/b/index.ts", act: "refresh", basis: "unedited", why: "unedited" },
    { path: "supabase/functions/a/index.ts", act: "refresh", basis: "approved", why: "approved" },
    { path: "supabase/functions/c/index.ts", act: "keep", settled: true, why: "edited here" },
    { path: "supabase/functions/d/index.ts", act: "keep", settled: false, why: "not walked" },
  ];

  it("lists refreshed paths sorted", () => {
    expect(strandedRefreshPaths(verdicts)).toEqual([
      "supabase/functions/a/index.ts",
      "supabase/functions/b/index.ts",
    ]);
  });

  it("names each refresh with its basis, each file kept as the clone's own, and counts the rest", () => {
    const body = describeStrandedFunctions(verdicts);
    expect(body).toContain("`supabase/functions/b/index.ts` — on evidence");
    expect(body).toContain("`supabase/functions/a/index.ts` — by a recorded operator approval");
    expect(body).toContain(
      "`supabase/functions/c/index.ts` — kept as this clone's own: edited here",
    );
    expect(body).toContain("1 more function file(s) behind prime were not settled this pass");
    expect(body).not.toContain("supabase/functions/d/index.ts");
  });

  it("says nothing when there was nothing stranded", () => {
    expect(describeStrandedFunctions([])).toBe("");
    expect(strandedSuffixFor([])).toBe("");
  });

  it("counts only refreshes in the summary", () => {
    expect(strandedSuffixFor(verdicts)).toBe(" · 2 Edge Function file(s) kept current");
  });
});
