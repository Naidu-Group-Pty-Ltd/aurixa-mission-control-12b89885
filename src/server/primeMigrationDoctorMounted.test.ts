/**
 * The diagnosis has a caller, a renderer, a door — and exactly one button.
 *
 * ## The class this exists to close, for the third time here
 *
 * Three builder-portal components and twenty-eight stylesheet rules merged and
 * never rendered; `buildPrimeLedgerReconciliation` documented in three places
 * and reached from nowhere. An unused export typechecks, lints and builds, and
 * a panel nobody mounts renders no error. Every assertion below is pinned on
 * the DATA FLOW rather than on a mention, because a call whose result is
 * thrown away satisfies a mention just as well.
 *
 * ## And one class that is this feature's alone
 *
 * This is the first surface in this console that can change the prime's
 * production database. So the assertions go further than "it is drawn": the
 * button must be gated on the SERVER'S field and on nothing the page can
 * spell for itself, the reading module must not be able to write, and the
 * writing module must ask before it acts. Each of those is invisible in any
 * render and each would pass every other gate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";

/**
 * Source with comments removed.
 *
 * A module whose header explains at length why it does NOT write contains
 * every word for writing. Judging prose as code is how a contract test comes
 * to be satisfied — or broken — by a sentence.
 */
const code = (p: string) => stripComments(readFileSync(p, "utf8"));

const PURE = "src/server/primeMigrationDiagnosis.pure.ts";
const SERVER = "src/server/primeMigrationDiagnosis.server.ts";
const DISPATCH = "src/server/primeMigrationDispatch.server.ts";
const FN = "src/server/prime-migration-fix.functions.ts";
const PAGE = "src/routes/prime.tsx";

describe("the diagnosis reaches a page", () => {
  it("the server module hands every layer to the judgement, including the failed ones", () => {
    const s = code(SERVER);
    expect(s).toMatch(/diagnosis: diagnoseMigration\(\{/);
    for (const layer of [
      "collidingNames,",
      "alreadyApplied,",
      "blockedBy,",
      "body,",
      "catalogue,",
    ]) {
      expect(s, layer).toContain(layer);
    }
    expect(s).toMatch(/dryRun: dry,/);
  });

  it("the server function calls the reader and returns its report", () => {
    const fn = code(FN);
    expect(fn).toMatch(/const report = await diagnosePrimeMigration\(/);
    expect(fn).toMatch(/return \{ ok: true, \.\.\.report \}/);
  });

  it("the page binds the server function, passes the chosen version, and draws it", () => {
    const page = code(PAGE);
    expect(page).toMatch(/useServerFn\(fetchMigrationDiagnosis\)/);
    expect(page).toMatch(/diagnoseFn\(\{ data: \{ version:/);
    expect(page).toContain("<MigrationDoctor />");
    expect(page).toMatch(/<DiagnosisBody report=\{report\}/);
  });

  it("the statements are drawn, not merely counted", () => {
    // A count an operator cannot act on is the report this feature replaces.
    const page = code(PAGE);
    expect(page).toMatch(/d\.hazards\.map\(/);
    expect(page).toContain("<HazardRow");
  });

  it("a ledger read that FAILED is not a prime with nothing held back", () => {
    /*
      `withheld` is `[]` in flight, `[]` on an error and `[]` on a level prime,
      and only the third is "nothing is held back". This repository has paid
      for that conflation more than once — most recently where `uploads.length`
      made a headline statement about a builder with six stock lists.

      Planted back (`withheld.length === 0 && !ledger.isPending`) this fails.
    */
    const page = code(PAGE);
    expect(page).toMatch(/const ledgerRead = ledger\.data\?\.ok === true/);
    expect(page).toMatch(/ledgerRead && withheld\.length === 0/);
    expect(page).toMatch(/ledgerWhy \?/);
  });

  it("the fleet-wide collision survey is drawn too", () => {
    const page = code(PAGE);
    expect(page).toMatch(/report\.collisions\.length > 0/);
    expect(page).toContain("<CollisionNotice");
  });
});

describe("the button is the server's decision, drawn", () => {
  it("is gated on `dispatchable` and mounted by nothing else", () => {
    const page = code(PAGE);
    expect(page).toMatch(/\{d\.dispatchable && <ApplyControl/);
    // Exactly one mount. A second one behind a different condition is how the
    // gate comes to have a way round it.
    expect([...page.matchAll(/<ApplyControl/g)]).toHaveLength(1);
  });

  it("the page never decides for itself which verdict may run", () => {
    /*
      `VERDICT_TONE` and `VERDICT_WORDS` are exhaustive maps keyed by the
      union, which is how a new verdict fails to compile rather than falling
      through to a default. What is forbidden is a COMPARISON — that is a
      second copy of `DISPATCHABLE_VERDICTS` living in JSX, where no test
      reaches it, and it would go on answering after the union grew.

      Planted back (`d.verdict === "ready" && <ApplyControl …>`) this fails.
    */
    const page = code(PAGE);
    expect(page).not.toMatch(/verdict\s*===/);
    expect(page).not.toMatch(/verdict\s*!==/);
  });

  it("the act is bound and invoked, and reports where the run will be", () => {
    const page = code(PAGE);
    expect(page).toMatch(/useServerFn\(applyPrimeMigration\)/);
    expect(page).toMatch(/await applyFn\(\{ data: \{ version: diagnosis\.id \} \}\)/);
    expect(page).toContain("r.runsUrl");
  });

  it("it asks first, and the confirmation restates what the diagnosis found", () => {
    const page = code(PAGE);
    expect(page).toMatch(/setConfirming\(true\)/);
    // The SAME sentence, not a second one: two statements of what is owed is
    // how one screen warns about something the other does not.
    expect(page).toMatch(/diagnosis\.remedy \? ` \$\{diagnosis\.remedy\}` : ""/);
  });
});

describe("the reading cannot write, and the writing asks first", () => {
  const WRITERS = /\.(insert|update|upsert|delete|rpc)\s*\(/;

  it("the judgement and the gathering only read", () => {
    expect(WRITERS.test(code(PURE))).toBe(false);
    expect(WRITERS.test(code(SERVER))).toBe(false);
    // And it never dispatches anything: the act lives in its own module so a
    // later edit cannot make the reader the writer.
    expect(code(SERVER)).not.toContain("dispatches");
    expect(code(SERVER)).not.toContain("writeAuditLog");
  });

  it("the trial run is composed only after the scan has cleared the body", () => {
    /*
      The one rule the whole feature rests on. A body carrying `COMMIT;` would
      end the wrapping transaction and make everything before it permanent, so
      the guard must come BEFORE the send rather than beside it.

      Asserted behaviourally as well, in `primeMigrationDiagnosis.server.test.ts`,
      which captures every statement the module sends. This is the source-order
      half: the two together say the guard exists and that it runs first.
    */
    const s = code(SERVER);
    const guard = s.indexOf("isSafeToDryRun(hazardsIn(scanSqlStatements(body.sql)))");
    const send = s.indexOf("dry = await dryRun(primeRef, body.sql)");
    expect(guard).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(guard);
  });

  it("the wrapper cannot be written without its rollback", () => {
    const s = code(SERVER);
    expect(s).toMatch(/"begin;",/);
    expect(s).toMatch(/"rollback;",/);
    expect(s).toContain("set local lock_timeout");
    expect(s).toContain("set local statement_timeout");
  });

  it("the dispatch diagnoses BEFORE it acts, and records AFTER", () => {
    const d = code(DISPATCH);
    const diagnose = d.indexOf("await diagnosePrimeMigration(");
    const refuse = d.indexOf("if (!diagnosis.dispatchable)");
    const inFlight = d.indexOf("await runInFlight(");
    const request = d.indexOf('octokit.request("POST');
    const audit = d.indexOf("await writeAuditLog({");
    expect(diagnose).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(diagnose);
    // Asked before the act and after the verdict: a probe run on a migration
    // that may not be dispatched would spend the window for nothing.
    expect(inFlight).toBeGreaterThan(refuse);
    expect(request).toBeGreaterThan(inFlight);
    // An audit row written first would name an act that may not have happened.
    expect(audit).toBeGreaterThan(request);
  });

  it("the dispatch takes a version and never a verdict", () => {
    // A request field asserting the server's own conclusion is the pattern
    // IPV 1.1.0 forbids. `dispatchable` travels OUT and never back.
    const fn = code(FN);
    expect(fn).toMatch(/inputValidator\(\(d: \{ version: string \}\)/);
    expect(fn).not.toMatch(/dispatchable/);
  });
});

describe("every lane is named, budgeted and flushed", () => {
  it("the measurements yield at the scan floor and the acts at the actor floor", () => {
    /*
      Not the same floor, and the difference is the point:
      `githubBudget.pure.ts` says a measurement postponed costs a stale number
      while an apply postponed costs a clone sitting a migration behind the
      prime. A diagnosis that refused at `ACTOR_FLOOR` would spend the window
      that the apply it precedes needs.
    */
    const fn = code(FN);
    expect(fn).toContain('beginGithubLane("prime-migration-diagnosis")');
    expect(fn).toContain('beginGithubLane("prime-migration-apply")');
    expect(fn).toMatch(/decideSpend\(\{ role: "scan"/);
    expect(fn).toMatch(/decideSpend\(\{ role: "actor"/);
  });

  it("each handler opens a lane of its own and flushes it, however many there are", () => {
    /*
      DERIVED rather than frozen at two. This door gained a repair plan and a
      repair proposal after the count was written, and a hand-written number
      is a gate that fails on the day somebody does the right thing — `a
      hand-list cannot see the call it does not mention`, in its other form.
      What matters is the property: one lane, one budget and one flush per
      handler, so a usage figure can never be attributed to the lane before.
    */
    const fn = code(FN);
    const handlers = [...fn.matchAll(/createServerFn\(/g)].length;
    expect(handlers).toBeGreaterThanOrEqual(4);
    expect([...fn.matchAll(/beginGithubLane\("/g)]).toHaveLength(handlers);
    expect([...fn.matchAll(/decideSpend\(\{ role: "/g)]).toHaveLength(handlers);
    expect([...fn.matchAll(/await flushGithubUsage\(\)/g)]).toHaveLength(handlers);
    // And every lane is its own name, so two never share a meter.
    const lanes = [...fn.matchAll(/beginGithubLane\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it("a refused act says nothing was applied", () => {
    expect(code(FN)).toMatch(/Not dispatched — \$\{spend\.why\}\. Nothing was applied\./);
  });
});
