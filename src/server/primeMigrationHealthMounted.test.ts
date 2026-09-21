/**
 * The migration survey has a reader, a door, a page and a way in.
 *
 * ## The class this exists to close
 *
 * `primeLedgerPanelsMounted.test.ts` opens with the price this repository has
 * already paid for it: three builder-portal components and twenty-eight
 * stylesheet rules, merged, deployed and rendered by nothing. Nothing in the
 * ordinary gate can see one — an unused export typechecks, lints and builds,
 * and a page nobody links to renders no error.
 *
 * Everything added here is exactly that shape: a judgement, a gatherer, a
 * door, a route and a nav entry. Each one passes every other gate while
 * reaching nobody.
 *
 * ## Why it is a SOURCE contract
 *
 * The fault is an ABSENCE, and a test that exercises a reading cannot see
 * that nothing reaches it. So every assertion below is pinned on the DATA
 * FLOW — a call whose result is thrown away satisfies a mention just as well,
 * which is precisely the failure being caught.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";

/**
 * Source with comments removed.
 *
 * Every module here EXPLAINS what it does not do, so its prose contains the
 * words for doing it. Judging prose as code is how a contract test comes to
 * be satisfied — or broken — by a sentence.
 */
const code = (p: string) => stripComments(readFileSync(p, "utf8"));

const PURE = "src/server/primeMigrationDiagnosis.pure.ts";
const SERVER = "src/server/primeMigrationHealth.server.ts";
const FN = "src/server/prime-migration-health.functions.ts";
const PAGE = "src/routes/prime-migrations.tsx";
const DOCTOR = "src/routes/prime.tsx";
const NAV = "src/lib/nav.ts";

describe("the survey reaches a page", () => {
  it("the gatherer calls the judgement and keeps what it returns", () => {
    const server = code(SERVER);
    expect(server).toMatch(/surveys = await pooled\(/);
    expect(server).toMatch(/return surveyMigration\(\{/);
    expect(server).toMatch(/facts = corpusFacts\(corpus\.metas, corpus\.sizeOf,/);
    // And it reuses the ledger's assessment rather than deriving a second
    // answer to the same question.
    expect(server).toMatch(/await buildPrimeLedgerAssessment\(/);
  });

  it("the door calls the gatherer and returns its report", () => {
    const fn = code(FN);
    expect(fn).toMatch(/const health = await readPrimeCorpusHealth\(/);
    expect(fn).toMatch(/return \{ ok: true, \.\.\.health \}/);
  });

  it("the page binds the door, runs it, and draws the answer", () => {
    const page = code(PAGE);
    // Bound AND invoked: an import alone is the defect.
    expect(page).toMatch(/useServerFn\(fetchPrimeCorpusHealth\)/);
    expect(page).toMatch(/queryFn: \(\) => fetchFn\(\)/);
    expect(page).toContain("<HealthBody health={health} />");
  });

  it("every surveyed migration is drawn, not merely counted", () => {
    const page = code(PAGE);
    expect(page).toMatch(/surveys\.map\(\(s\) => <SurveyRow /);
    // The two readings a row exists to carry.
    expect(page).toContain("STANDING_WORDS[survey.standing]");
    expect(page).toContain("RERUN_WORDS[rerun.reading]");
  });

  it("the corpus-wide facts are drawn too", () => {
    const page = code(PAGE);
    expect(page).toContain("<CorpusNotices facts={facts} />");
    expect(page).toMatch(/facts\.collisions\.slice\(/);
    expect(page).toMatch(/facts\.oversize\.slice\(/);
    expect(page).toMatch(/facts\.rollbackScripts\.slice\(/);
  });

  it("the page has a door into it and the list has a door out", () => {
    // A page nothing links to is the same defect as a component nothing
    // mounts, one level up.
    expect(code(NAV)).toContain('to: "/prime-migrations"');
    // And the list hands a chosen file to the surface that can actually try
    // it, which is the only place a trial run happens.
    expect(code(PAGE)).toMatch(/search=\{\{ migration: survey\.id \}\}/);
    const doctor = code(DOCTOR);
    expect(doctor).toMatch(/const handedOver = Route\.useSearch\(\)\.migration/);
    expect(doctor).toMatch(/useState\(handedOver \?\? ""\)/);
  });
});

describe("the survey spends nothing it should not", () => {
  it("never runs SQL against the prime", () => {
    /*
      The whole point of the survey is that it reads bytes. A round trip per
      file would be hundreds of statements against a production project to
      draw a table — and the ledger assessment it reuses already makes the one
      statement this needs.
    */
    expect(code(SERVER)).not.toContain("runSqlOnProject");
    expect(code(FN)).not.toContain("runSqlOnProject");
  });

  it("writes nothing", () => {
    // Read-only by source position, the same way the ledger and the blockage
    // ledger are asserted. A page about health that could stamp the prime's
    // ledger would be a gate nobody asked for.
    const WRITERS = /\.(insert|update|upsert|delete|rpc)\s*\(/;
    expect(WRITERS.test(code(SERVER))).toBe(false);
    expect(WRITERS.test(code(FN))).toBe(false);
    expect(WRITERS.test(code(PURE))).toBe(false);
  });

  it("bounds the set it reads and the requests it makes at once", () => {
    const server = code(SERVER);
    expect(server).toMatch(/ledger\.withheld\.slice\(0, SURVEY_LIMIT\)/);
    expect(server).toMatch(/pooled\(\s*wanted,\s*BODY_CONCURRENCY,/);
  });

  it("opens a lane, asks the budget, and flushes what it spent", () => {
    /*
      `everyGithubLaneYields` derives its list, so a new lane is caught the day
      it is added. This states the same rule locally because the pairing is
      easy to half-do: a lane that is named but never flushed attributes its
      spend and never records it.
    */
    const fn = code(FN);
    expect(fn).toContain('beginGithubLane("prime-corpus-health")');
    expect(fn).toMatch(/decideSpend\(\{ role: "scan"/);
    expect(fn).toMatch(/await flushGithubUsage\(\)/);
  });
});

describe("a list may not promise what a trial run did not", () => {
  it("draws no standing green, including the healthy one", () => {
    /*
      `needs_a_trial_run` is what a perfectly fine file reads here, and it is
      amber on purpose: nothing has tried it. A green row on a page that never
      opened a database would be a promise nobody made — the inverse of the
      dead "Approve the gate" button whose lesson `/prime`'s own header
      records.
    */
    const page = code(PAGE);
    const table = page.slice(
      page.indexOf("const STANDING_TONE"),
      page.indexOf("const RERUN_WORDS"),
    );
    expect(table).toContain("needs_a_trial_run:");
    expect(table).not.toMatch(/needs_a_trial_run: "ok"/);
  });

  it("translates every standing and reading, so no column name reaches an operator", () => {
    /*
      `database vocabulary never reaches the operator`. Both maps are
      exhaustive `Record`s of their union, so a member added tomorrow fails
      the typecheck rather than rendering as `must_not_run` — but a word can
      still be translated INTO an identifier, which the compiler cannot see.
    */
    /*
      `RERUN_WORDS` moved to `src/lib/migrationRepairLabels.ts` when the repair
      surface started drawing the same chip on `/prime`: two tables of the same
      words is how two pages come to disagree about one migration. It is looked
      for in both places rather than in one, so this keeps checking the words
      wherever they end up living.
    */
    const page = code(PAGE);
    const labels = code("src/lib/migrationRepairLabels.ts");
    for (const map of ["STANDING_WORDS", "RERUN_WORDS"]) {
      const src = page.includes(`const ${map}`) ? page : labels;
      const start = src.indexOf(`const ${map}`);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf("};", start));
      const rendered = [...body.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(rendered.length).toBeGreaterThan(3);
      expect(rendered.filter((w) => /^[a-z]+(_[a-z]+)+$/.test(w))).toEqual([]);
    }
  });
});
