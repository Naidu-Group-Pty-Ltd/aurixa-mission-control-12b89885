/**
 * The SQL ledger and the clone comparison have callers, renderers and a door.
 *
 * ## The class this exists to close
 *
 * This repository has paid for it three times: three builder-portal components
 * and twenty-eight stylesheet rules merged and never rendered, and
 * `buildPrimeLedgerReconciliation` — documented in three places, named in the
 * comment that defines `prime_ledger_hole`, reached from nowhere. Nothing in
 * the ordinary gate can see it. An unused export typechecks, lints and builds,
 * and a panel nobody mounts renders no error.
 *
 * Both readings added here are exactly that shape of risk: pure judgement, a
 * server function, a panel. Each one would pass every other gate while drawing
 * on no page at all.
 *
 * ## Why it is a SOURCE contract
 *
 * The fault is an ABSENCE, and a test that exercises a reading cannot see that
 * nothing reaches it. So every assertion is pinned on the DATA FLOW — a call
 * whose result is thrown away satisfies a mention just as well, which is
 * precisely the failure being caught.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(p, "utf8");

/**
 * Source with comments removed.
 *
 * A module whose header explains why it does NOT do something contains the
 * words for doing it. Judging prose as though it were code is how a contract
 * test comes to be satisfied — or broken — by a sentence.
 */
const code = (p: string) => stripComments(read(p));

const LEDGER_PURE = "src/server/primeMigrationLedger.pure.ts";
const LEDGER_SERVER = "src/server/primeMigrationLedger.server.ts";
const COMPARE_PURE = "src/server/primeCloneComparison.pure.ts";
const COMPARE_SERVER = "src/server/primeCloneComparison.server.ts";
const FN = "src/server/prime-ledger.functions.ts";
const PAGE = "src/routes/prime.tsx";

describe("the SQL ledger reaches a page", () => {
  it("the server module calls the judgement and keeps what it returns", () => {
    const server = code(LEDGER_SERVER);
    expect(server).toContain("assessPrimeMigrationLedger");
    expect(server).toMatch(/assessment: assessPrimeMigrationLedger\(\{/);
    expect(server).toMatch(/return \{ reading: assessment\.reading/);
  });

  it("the server function calls the reader and returns its report", () => {
    const fn = code(FN);
    expect(fn).toMatch(/const report = await readPrimeMigrationLedgerReport\(/);
    expect(fn).toMatch(/return \{ ok: true, \.\.\.report \}/);
  });

  it("the page binds the server function, runs it, and draws the answer", () => {
    const page = code(PAGE);
    // Bound AND invoked: an import alone is the defect.
    expect(page).toMatch(/useServerFn\(fetchPrimeMigrationLedger\)/);
    expect(page).toMatch(/queryFn: \(\) => fetchFn\(\)/);
    // And mounted, by the component that renders the reading.
    expect(page).toContain("<PrimeSqlLedger />");
    expect(page).toMatch(/<LedgerBody reading=\{reading\}/);
  });

  it("the held-back list is drawn, not merely counted", () => {
    // The count alone is the report an operator cannot act on. The names are
    // what they take to the prime.
    const page = code(PAGE);
    expect(page).toMatch(/reading\.withheld\.map\(/);
    expect(page).toContain("<WithheldMigrationRow");
  });
});

describe("the clone comparison reaches a page", () => {
  it("the server module builds the comparison from all three readings", () => {
    const server = code(COMPARE_SERVER);
    expect(server).toMatch(/const comparison = buildCloneComparison\(\{/);
    expect(server).toContain("readCodeStanding(");
    expect(server).toContain("readMigrationStanding(");
    expect(server).toContain("compareBlockers(");
    expect(server).toMatch(/comparison,/);
  });

  it("the server function hands the prime's side in and returns the comparison", () => {
    const fn = code(FN);
    expect(fn).toMatch(/return comparePrimeAgainstClone\(context\.supabase, \{/);
    expect(fn).toContain("primeHeadSha,");
    expect(fn).toContain("frontier,");
    expect(fn).toContain("runnableVersions,");
  });

  it("the page binds the server function, passes the chosen clone, and draws it", () => {
    const page = code(PAGE);
    expect(page).toMatch(/useServerFn\(fetchCloneComparison\)/);
    // The chosen clone reaches the server function. Asserted as the data flow
    // rather than as one spelling of the variable holding it.
    expect(page).toMatch(/fetchFn\(\{ data: \{ cloneId:/);
    expect(page).toContain("<ClonesHeldAgainstPrime />");
    expect(page).toMatch(/<ComparisonBody view=\{view\}/);
  });

  it("both sides of the split are drawn, so neither can be quietly dropped", () => {
    const page = code(PAGE);
    expect(page).toMatch(/b\.side === "prime"/);
    expect(page).toMatch(/b\.side === "clone"/);
    expect(page).toContain("<BlockerGroup");
  });
});

describe("neither reading writes anything", () => {
  /*
    Read-only by source position, the same way `blockageLedger.contract.test.ts`
    asserts that the ledger writes one table. A page about health that could
    stamp the prime's ledger would be a gate nobody asked for, and the remedy
    both modules name is deliberately an act a person performs elsewhere.
  */
  const WRITERS = /\.(insert|update|upsert|delete|rpc)\s*\(/;

  it("the ledger reader only reads", () => {
    expect(WRITERS.test(code(LEDGER_SERVER))).toBe(false);
    expect(WRITERS.test(code(LEDGER_PURE))).toBe(false);
  });

  it("the comparison only reads", () => {
    expect(WRITERS.test(code(COMPARE_SERVER))).toBe(false);
    expect(WRITERS.test(code(COMPARE_PURE))).toBe(false);
  });

  it("the server functions only read", () => {
    expect(WRITERS.test(code(FN))).toBe(false);
  });
});

describe("both lanes are named and both yield", () => {
  /*
    `everyGithubLaneYields` derives its list, so a new lane is caught the day
    it is added. These two assertions are the same rule stated locally, and
    they are here because the pairing is easy to half-do: a lane that is named
    but never flushed attributes its spend and never records it.
  */
  it("each GitHub-spending handler opens a lane and asks the budget", () => {
    const fn = code(FN);
    expect(fn).toContain('beginGithubLane("prime-migration-ledger")');
    expect(fn).toContain('beginGithubLane("prime-clone-comparison")');
    expect([...fn.matchAll(/decideSpend\(\{ role: "scan"/g)]).toHaveLength(2);
    expect([...fn.matchAll(/await flushGithubUsage\(\)/g)]).toHaveLength(2);
  });

  it("the selector costs no GitHub call at all", () => {
    // An operator lands on the drop-down before asking a question. Buying a
    // tree walk to draw it would spend the window on nobody's behalf.
    const fn = code(FN);
    expect(fn).toMatch(/if \(data\.cloneId\) \{\s*beginGithubLane\("prime-clone-comparison"\)/);
  });
});
