/**
 * The repair has a judgement, a gatherer, a door, a control and a way in.
 *
 * ## The class this exists to close
 *
 * `primeMigrationHealthMounted.test.ts` opens with the price this repository
 * has already paid: three builder-portal components and twenty-eight
 * stylesheet rules, merged, deployed and rendered by nothing. Everything added
 * for the repair is that shape — a pure module, a server module, two server
 * functions, a panel and a table of words. Each passes every other gate while
 * reaching nobody.
 *
 * ## Why these are SOURCE contracts
 *
 * Two reasons, and the second is the honest one.
 *
 * The first is the usual: the fault is an ABSENCE, and a test that exercises a
 * reading cannot see that nothing reaches it. So the assertions are pinned on
 * the DATA FLOW — a call whose result is thrown away satisfies a mention just
 * as well, which is precisely the failure being caught.
 *
 * The second is a gap named rather than papered over. `proveRepair` is
 * exercised directly in `primeMigrationRemedy.pure.test.ts`, and each of its
 * three checks fails a test when removed. What NO fixture reaches is the
 * planner IGNORING it: every repair family the planner writes is sound, so
 * there is no valid input whose patch fails the proof, and planting
 * `const failure = null` in the planner broke nothing. That branch is a
 * guarantee about a case this suite cannot manufacture, so it is pinned here
 * on the source instead — weaker than execution, and said out loud rather
 * than dressed up as the same thing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";
import { REFUSAL_KINDS, REMEDY_OUTCOMES, REPAIR_KINDS } from "./primeMigrationRemedy.pure";
import type { IdempotencyReading } from "./primeMigrationDiagnosis.pure";
import {
  REFUSAL_WORDS,
  REMEDY_TONE,
  REMEDY_WORDS,
  REPAIR_WORDS,
  RERUN_TONE,
  RERUN_WORDS,
} from "@/lib/migrationRepairLabels";

/**
 * Source with comments removed.
 *
 * Every module here EXPLAINS what it does not do, so its prose contains the
 * words for doing it. Judging prose as code is how a contract test comes to be
 * satisfied — or broken — by a sentence.
 */
const code = (p: string) => stripComments(readFileSync(p, "utf8"));

const PURE = "src/server/primeMigrationRemedy.pure.ts";
const SERVER = "src/server/primeMigrationRemedy.server.ts";
const FN = "src/server/prime-migration-fix.functions.ts";
const PAGE = "src/routes/prime.tsx";
const SURVEY = "src/routes/prime-migrations.tsx";
const LABELS = "src/lib/migrationRepairLabels.ts";
const DIAGNOSIS = "src/server/primeMigrationDiagnosis.pure.ts";

describe("the planner cannot disagree with the chip", () => {
  it("reads the diagnosis module's own walk rather than a second copy of it", () => {
    const pure = code(PURE);
    expect(pure).toMatch(
      /import\s*\{[\s\S]*idempotencyWalk[\s\S]*\}\s*from\s*"\.\/primeMigrationDiagnosis\.pure"/,
    );
    expect(pure).toMatch(/const\s*\{\s*flags\s*\}\s*=\s*idempotencyWalk\(statements\)/);
  });

  it("and the chip reads it too, so one walk decides both", () => {
    const diagnosis = code(DIAGNOSIS);
    expect(diagnosis).toMatch(
      /export function assessIdempotency[\s\S]{0,900}idempotencyWalk\(statements\)/,
    );
  });

  it("the walk's notes are uncapped, because a repair has to see all of them", () => {
    const diagnosis = code(DIAGNOSIS);
    const walk = /export function idempotencyWalk[\s\S]*?\n}/.exec(diagnosis)?.[0] ?? "";
    expect(walk).not.toContain("IDEMPOTENCY_ROWS");
  });
});

describe("no patch is offered that was not proved", () => {
  it("the planner asks proveRepair and acts on its answer", () => {
    const pure = code(PURE);
    expect(pure).toMatch(/const proof = proveRepair\(\{[\s\S]{0,200}\}\);/);
    expect(pure).toMatch(/const failure = proof\.held \? null : proof\.why;/);
  });

  it("and a failed proof carries no patch at all", () => {
    const pure = code(PURE);
    const branch = /if \(failure\) \{[\s\S]*?\n {2}\}/.exec(pure)?.[0] ?? "";
    expect(branch).toContain('outcome: "unproven"');
    expect(branch).toContain("patched: null");
  });
});

describe("the act is wired, and it is the only thing that writes", () => {
  it("the server module opens a pull request rather than pushing a branch", () => {
    const server = code(SERVER);
    expect(server).toContain("pulls.create");
    expect(server).not.toContain("updateRef");
  });

  it("it never sends a patched body to a database", () => {
    const server = code(SERVER);
    // It reads the ledger, and that is the ONLY statement it runs.
    expect(server.match(/runSqlOnProject\(/g) ?? []).toHaveLength(1);
    expect(server).toContain("select version from supabase_migrations.schema_migrations");
  });

  it("the patch it commits is the one it just planned, never one it was handed", () => {
    const server = code(SERVER);
    expect(server).toMatch(/planned\s*=\s*await planPrimeMigrationRepair\(supabase, version\)/);
    expect(server).toMatch(/patched\s*=\s*planned\.patched/);
    expect(server).toMatch(/content: Buffer\.from\(patched, "utf8"\)/);
  });

  it("the audit row is written after the pull request exists, never before", () => {
    const server = code(SERVER);
    // The CALL sites, not the imports: `writeAuditLog` is named at the top of
    // every module that uses it, and comparing first mentions would compare
    // import order.
    const pr = server.indexOf("octokit.pulls.create(");
    const audit = server.indexOf("await writeAuditLog({");
    expect(pr).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(pr);
  });

  it("the door hands the plan on without its patch", () => {
    const fn = code(FN);
    expect(fn).toMatch(/const \{ report \}[\s\S]{0,120}await planPrimeMigrationRepair\(/);
    expect(fn).toContain("await openPrimeMigrationRepair(supabaseAdmin, data.version");
  });

  it("the plan spends at the scan floor and the proposal at the actor floor", () => {
    const fn = code(FN);
    const plan = /fetchMigrationRepairPlan[\s\S]*?decideSpend\(\{ role: "(\w+)"/.exec(fn)?.[1];
    const act = /proposePrimeMigrationRepair[\s\S]*?decideSpend\(\{ role: "(\w+)"/.exec(fn)?.[1];
    expect(plan).toBe("scan");
    expect(act).toBe("actor");
  });
});

describe("the page draws it, and the server decides it", () => {
  it("the panel is mounted in the diagnosis body", () => {
    const page = code(PAGE);
    expect(page).toMatch(/<RerunPanel key=\{`rerun-\$\{d\.id\}`\} diagnosis=\{d\} \/>/);
    expect(page).toContain("function RerunPanel(");
  });

  it("the plan is fetched through the door and drawn", () => {
    const page = code(PAGE);
    expect(page).toContain("useServerFn(fetchMigrationRepairPlan)");
    expect(page).toMatch(/queryFn: \(\) => planFn\(\{ data: \{ version: diagnosis\.id \} \}\)/);
    expect(page).toContain("<RepairPlanBody report={report} />");
  });

  it("the button is drawn on the server's own field and never on the outcome word", () => {
    const page = code(PAGE);
    expect(page).toMatch(/\{report\.proposable && <ProposeControl/);
    const body = /function RepairPlanBody[\s\S]*?\n}/.exec(page)?.[0] ?? "";
    expect(body).not.toMatch(/outcome === "healed"/);
    expect(body).not.toMatch(/outcome === "improved"/);
  });

  it("the act is reached, and behind a confirmation", () => {
    const page = code(PAGE);
    expect(page).toContain("useServerFn(proposePrimeMigrationRepair)");
    const control = /function ProposeControl[\s\S]*?\n}\n/.exec(page)?.[0] ?? "";
    expect(control).toContain("setConfirming(true)");
    expect(control).toMatch(/Yes — open it/);
  });

  it("both lists are drawn, so a refusal cannot be hidden by omission", () => {
    const body = /function RepairPlanBody[\s\S]*?\n}/.exec(code(PAGE))?.[0] ?? "";
    expect(body).toContain("plan.repairs.map(");
    expect(body).toContain("plan.refusals.map(");
    expect(body).toContain("plan.refusalCount");
  });

  it("the survey page leads here where the file is not already re-runnable", () => {
    const survey = code(SURVEY);
    expect(survey).toMatch(/search=\{\{ migration: survey\.id \}\}/);
    expect(survey).toMatch(/Diagnose & repair/);
  });
});

describe("one table of words, read by both pages", () => {
  it("neither page keeps a private copy of the re-run vocabulary", () => {
    for (const p of [PAGE, SURVEY]) {
      const src = code(p);
      expect(src).toContain('from "@/lib/migrationRepairLabels"');
      expect(src).not.toMatch(/const RERUN_WORDS\s*[:=]/);
      expect(src).not.toMatch(/const RERUN_TONE\s*[:=]/);
    }
  });

  it("covers exactly the readings and outcomes the judgement can produce", () => {
    const readings: IdempotencyReading[] = [
      "rerunnable",
      "fails_loudly",
      "rewrites_data",
      "unreadable",
    ];
    expect(Object.keys(RERUN_WORDS).sort()).toEqual([...readings].sort());
    expect(Object.keys(RERUN_TONE).sort()).toEqual([...readings].sort());
    expect(Object.keys(REMEDY_WORDS).sort()).toEqual([...REMEDY_OUTCOMES].sort());
    expect(Object.keys(REMEDY_TONE).sort()).toEqual([...REMEDY_OUTCOMES].sort());
    expect(Object.keys(REPAIR_WORDS).sort()).toEqual([...REPAIR_KINDS].sort());
    expect(Object.keys(REFUSAL_WORDS).sort()).toEqual([...REFUSAL_KINDS].sort());
  });

  it("database vocabulary never reaches the operator", () => {
    const rendered = [
      ...Object.values(RERUN_WORDS),
      ...Object.values(REMEDY_WORDS),
      ...Object.values(REPAIR_WORDS),
      ...Object.values(REFUSAL_WORDS),
    ];
    for (const word of rendered) {
      expect(word).not.toMatch(/_/);
      expect(word).toBe(word.toLowerCase());
    }
  });

  it("draws the mild outcome neutrally and the partial one as unfinished", () => {
    // `fails_loudly` writes nothing and stops; colouring it like the one that
    // duplicates rows is what made eleven chips unreadable.
    expect(RERUN_TONE.fails_loudly).toBe("idle");
    expect(RERUN_TONE.rewrites_data).toBe("bad");
    // `improved` is not `healed`, and a green chip would say it was.
    expect(REMEDY_TONE.improved).toBe("warn");
    expect(REMEDY_TONE.healed).toBe("ok");
  });

  it("the words module holds no judgement of its own", () => {
    const labels = code(LABELS);
    // Tables and nothing else. A branch here is a second place a decision
    // gets made, and the whole point of the module is that there is one.
    expect(labels).not.toMatch(/\bfunction\s+\w/);
    expect(labels).not.toContain("=>");
    expect(labels).not.toMatch(/\bif\s*\(/);
    // Types only. A value imported from `src/server/**` cannot cross to the
    // browser, and this module is drawn by two routes.
    expect(labels.match(/^import\b.*$/gm) ?? []).toSatisfy((lines: string[]) =>
      lines.every((l) => l.startsWith("import type ")),
    );
  });
});
