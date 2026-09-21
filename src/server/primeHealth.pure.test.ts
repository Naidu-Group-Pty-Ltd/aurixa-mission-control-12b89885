import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideCascadeMerge } from "./cascade/autoMergeGate.pure";
import {
  assessCascadeCoverage,
  assessPosture,
  assessPrimeGate,
  checkOutcome,
  commitHeadline,
  isProven,
  readCiForHead,
  readPullRequests,
  REQUIRED_CHECKS,
  safetyTone,
  summariseWorkflowRuns,
  type CascadeEventRef,
  type CheckRun,
  type PrimePullRequest,
  type WorkflowRun,
} from "./primeHealth.pure";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER = "ffffffffffffffffffffffffffffffffffffffff";

const ok = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success" });
const red = (name: string, conclusion = "failure"): CheckRun => ({
  name,
  status: "completed",
  conclusion,
});
const running = (name: string): CheckRun => ({ name, status: "in_progress", conclusion: null });
/** The required jobs, all green — the baseline the gate cases start from. */
const allRequiredGreen = () => REQUIRED_CHECKS.map((n) => ok(n));

describe("assessPrimeGate", () => {
  it("is proven when the required checks ran and passed", () => {
    const gate = assessPrimeGate(allRequiredGreen());
    expect(gate.safety).toBe("proven");
    expect(gate.verdict.merge).toBe(true);
    expect(gate.remedy).toBeNull();
  });

  it("refuses a head with a failing job", () => {
    const gate = assessPrimeGate([ok("verify"), red("security")]);
    expect(gate.safety).toBe("refused");
    expect(gate.remedy).toMatch(/every clone that receives this commit/i);
  });

  it("is in flight while a required check is still running", () => {
    const gate = assessPrimeGate([ok("verify"), running("security")]);
    expect(gate.safety).toBe("in_flight");
    // Still building is not a refusal, so nothing is owed yet.
    expect(gate.remedy).toBeNull();
  });

  it("is in flight when a required check has not reported at all", () => {
    // The asynchronous case the merge gate exists for: the fast checks are
    // green and `verify` has not been created yet.
    const gate = assessPrimeGate([ok("Vercel Preview Comments")]);
    expect(gate.verdict).toMatchObject({ merge: false, reason: "awaiting_required" });
    expect(gate.safety).toBe("in_flight");
  });

  it("is UNPROVEN rather than proven when nothing has built the head", () => {
    // The whole point of the five states: an empty reading is not a pass.
    const gate = assessPrimeGate([]);
    expect(gate.verdict).toMatchObject({ merge: false, reason: "no_checks" });
    expect(gate.safety).toBe("unproven");
    expect(isProven(gate.safety)).toBe(false);
  });

  it("is unproven — not refused — when the jobs never started", () => {
    // A private repo past its Actions spending limit: every job completes as
    // `failure` seconds after creation with no runner assigned. The tree was
    // never built, so sending an operator to read it is the wrong remedy.
    const instant = (name: string): CheckRun => ({
      name,
      status: "completed",
      conclusion: "failure",
      started_at: "2026-09-20T00:00:00Z",
      completed_at: "2026-09-20T00:00:03Z",
    });
    const gate = assessPrimeGate(REQUIRED_CHECKS.map((n) => instant(n)));
    expect(gate.verdict).toMatchObject({ merge: false, reason: "never_started" });
    expect(gate.safety).toBe("unproven");
  });

  it("distinguishes a read that FAILED from a read that found nothing", () => {
    const unreadable = assessPrimeGate(null);
    const empty = assessPrimeGate([]);
    expect(unreadable.safety).toBe("unknown");
    expect(empty.safety).toBe("unproven");
    expect(unreadable.safety).not.toBe(empty.safety);
    // The remedies point at different places: one is a permission, the other
    // is prime's workflows.
    expect(unreadable.remedy).toMatch(/Checks: Read-only/);
    expect(empty.remedy).toMatch(/workflows are enabled/i);
  });

  it("never reports anything but a passing verdict as proven", () => {
    const cases: Array<readonly CheckRun[] | null> = [
      null,
      [],
      [ok("verify"), red("security")],
      [ok("verify"), running("security")],
      [ok("Vercel Preview Comments")],
      [red("verify", "cancelled"), red("security", "timed_out")],
    ];
    for (const checks of cases) {
      expect(isProven(assessPrimeGate(checks).safety)).toBe(false);
    }
    expect(isProven(assessPrimeGate(allRequiredGreen()).safety)).toBe(true);
  });

  it("gives every safety state a distinct tone, and only `proven` is ok", () => {
    expect(safetyTone("proven")).toBe("ok");
    expect(safetyTone("refused")).toBe("bad");
    expect(safetyTone("in_flight")).toBe("live");
    expect(safetyTone("unproven")).toBe("warn");
    expect(safetyTone("unknown")).toBe("idle");
  });
});

describe("checkOutcome", () => {
  it("reads the three states a row needs", () => {
    expect(checkOutcome(ok("verify"))).toBe("passing");
    expect(checkOutcome(red("verify"))).toBe("failing");
    expect(checkOutcome(running("verify"))).toBe("running");
  });

  it("agrees with the merge gate about every conclusion it admits", () => {
    // The whole reason this lives beside the gate rather than in the page. If
    // `PASSING_CONCLUSIONS` ever gains or loses a member, this and
    // `decideCascadeMerge` move together or this test fails.
    for (const c of ["success", "neutral", "skipped", "stale"]) {
      expect(checkOutcome(red("verify", c))).toBe("passing");
      expect(decideCascadeMerge(REQUIRED_CHECKS.map((n) => red(n, c))).merge).toBe(true);
    }
    for (const c of ["failure", "cancelled", "timed_out", "action_required"]) {
      expect(checkOutcome(red("verify", c))).toBe("failing");
      expect(decideCascadeMerge(REQUIRED_CHECKS.map((n) => red(n, c))).merge).toBe(false);
    }
  });

  it("calls a conclusion this build has never heard of a failure", () => {
    // Fails closed, for the gate's own stated reason: treating an unfamiliar
    // conclusion as passing is how a gate quietly stops being one.
    expect(checkOutcome(red("verify", "some_new_github_conclusion"))).toBe("failing");
  });
});

describe("no surface re-implements what a conclusion means", () => {
  /**
   * A rule that names a word is worthless if something else deletes it.
   *
   * The page drew a row per check and first did it with
   * `["success", "neutral", "skipped", "stale"].includes(...)` inlined twice —
   * a third and fourth copy of `PASSING_CONCLUSIONS`, living in JSX where no
   * unit test reaches them. This asserts the copies stay gone rather than
   * trusting that they do.
   */
  it("keeps the conclusion list out of the page", () => {
    const page = readFileSync(join(__dirname, "..", "routes", "prime.tsx"), "utf8");
    expect(page).not.toMatch(/"success".*"neutral"/s);
    // The page renders the outcome it was handed rather than deriving one.
    expect(page).toMatch(/check\.outcome|\{ outcome \} = check/);
  });

  /**
   * And it cannot derive one even if somebody tries.
   *
   * A route is bundled for the browser, so TanStack Start's import protection
   * refuses a VALUE import of `src/server/**` — the build fails with
   * "Import denied in client environment". That is the correct boundary and it
   * is already enforced by the build; what it does NOT do is fail fast, and the
   * first version of this page hit it only after everything else was green.
   *
   * So the rule is asserted here too: every judgement the page draws is made on
   * the server and travels in the payload, and the only import from `@/server`
   * is the server function itself plus types, which are erased before the
   * boundary exists.
   *
   * The rule is stated as a PROPERTY and not as a list of permitted names. It
   * began as `expect(statement).toMatch(/fetchPrimeHealth/)` and broke the day
   * the page gained a second, equally legitimate server function — which is
   * the shape of gate somebody widens by adding a name, until the list is what
   * is being maintained rather than the rule. "A hand-list cannot see the call
   * it does not mention" is the drain lane's lesson, paid here for the price
   * of one red test.
   *
   * It broke a SECOND time, and the way it broke is worth keeping. The
   * property had been written as "every binding is named `fetch…`", which was
   * true while every server function on this page was a reading — and then the
   * page gained one that ACTS, correctly named `applyPrimeMigration`. A naming
   * convention is a PROXY for the thing being asserted, and a proxy fails at
   * exactly the moment the vocabulary grows.
   *
   * So the property is now the thing itself: a value imported from a
   * `*.functions` module must be a server function this page INVOKES, which is
   * checkable (`useServerFn(<name>)`) and is strictly stronger than the prefix
   * ever was — it also refuses an import nothing calls, which the prefix let
   * straight through.
   */
  it("imports no server value into the route", () => {
    const page = readFileSync(join(__dirname, "..", "routes", "prime.tsx"), "utf8");
    const serverImports = [
      ...page.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@\/server\/([^"]+)";/gm),
    ];
    expect(serverImports.length).toBeGreaterThan(0);
    for (const [, isType, bindings, specifier] of serverImports) {
      if (isType) continue;
      // A value may only come from a `*.functions` module — a `.pure` or
      // `.server` import is the one the build refuses, and it refuses it late.
      expect(specifier, `value import from @/server/${specifier}`).toMatch(/\.functions$/);
      // And it may only be a server function the page actually runs. A
      // constant imported from there would be a rule living in two places,
      // which is what the block above exists to stop; an import nothing calls
      // is the dead export this repository is ratcheted against.
      for (const raw of bindings.split(",")) {
        const name = raw.trim();
        if (!name || name.startsWith("type ")) continue;
        expect(page, `${name} is imported into the route but never invoked`).toContain(
          `useServerFn(${name})`,
        );
      }
    }
  });
});

describe("assessPrimeGate borrows the cascade's own standard", () => {
  it("names the merge gate rather than reimplementing a threshold", () => {
    // The value here is that the two cannot drift. A private copy of the rules
    // would pass this file's tests and disagree with the drain in production,
    // which is the shape the AML `.or()` double already cost this platform.
    const src = readFileSync(join(__dirname, "primeHealth.pure.ts"), "utf8");
    expect(src).toMatch(/from "\.\/cascade\/autoMergeGate\.pure"/);
    expect(src).toMatch(/decideCascadeMerge\(checks, REQUIRED_CHECKS\)/);
  });
});

describe("assessCascadeCoverage", () => {
  const event = (over: Partial<CascadeEventRef> = {}): CascadeEventRef => ({
    id: "evt-1",
    sourceSha: HEAD,
    status: "completed",
    createdAt: "2026-09-20T10:00:00Z",
    ...over,
  });

  it("reports the event that names this commit", () => {
    const c = assessCascadeCoverage({ headSha: HEAD, events: [event()] });
    expect(c.state).toBe("carried");
    expect(c.eventId).toBe("evt-1");
    expect(c.eventStatus).toBe("completed");
  });

  it("matches a short SHA against a full one", () => {
    const c = assessCascadeCoverage({
      headSha: HEAD,
      events: [event({ sourceSha: HEAD.slice(0, 7) })],
    });
    expect(c.state).toBe("carried");
  });

  it("does not match on a stub too short to identify a commit", () => {
    const c = assessCascadeCoverage({ headSha: HEAD, events: [event({ sourceSha: "a1b" })] });
    expect(c.state).toBe("uncarried");
  });

  it("reads an event for this commit that is still running as in flight", () => {
    const c = assessCascadeCoverage({ headSha: HEAD, events: [event({ status: "running" })] });
    expect(c.state).toBe("in_flight");
  });

  it("treats a pending event for ANOTHER sha as covering head — it folds", () => {
    // `createCascadeForAllClones` deliberately folds a push into an unclaimed
    // pending cascade, because that event reads prime's head when it runs.
    // Reporting `uncarried` here would raise a false alarm on the fleet's most
    // ordinary state.
    const c = assessCascadeCoverage({
      headSha: HEAD,
      events: [event({ id: "evt-2", sourceSha: OTHER, status: "pending" })],
    });
    expect(c.state).toBe("in_flight");
    expect(c.eventId).toBe("evt-2");
    expect(c.why).toMatch(/folds into it/);
  });

  it("prefers the exact match over a queued event", () => {
    const c = assessCascadeCoverage({
      headSha: HEAD,
      events: [
        event({ id: "queued", sourceSha: OTHER, status: "pending" }),
        event({ id: "mine", sourceSha: HEAD, status: "completed" }),
      ],
    });
    expect(c.eventId).toBe("mine");
    expect(c.state).toBe("carried");
  });

  it("reports an uncarried head when nothing names it and nothing is queued", () => {
    const c = assessCascadeCoverage({
      headSha: HEAD,
      events: [event({ sourceSha: OTHER, status: "completed" })],
    });
    expect(c.state).toBe("uncarried");
    expect(c.why).toMatch(/webhook did not arrive/i);
  });

  it("an empty ledger is uncarried, and an unreadable one is unknown", () => {
    expect(assessCascadeCoverage({ headSha: HEAD, events: [] }).state).toBe("uncarried");
    expect(assessCascadeCoverage({ headSha: HEAD, events: null }).state).toBe("unknown");
  });

  it("says nothing about coverage when prime's head could not be read", () => {
    const c = assessCascadeCoverage({ headSha: null, events: [event()] });
    expect(c.state).toBe("unknown");
  });
});

describe("summariseWorkflowRuns", () => {
  let id = 0;
  const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
    id: ++id,
    name: "verify",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    headBranch: "main",
    event: "push",
    createdAt: "2026-09-20T10:00:00Z",
    htmlUrl: "https://github.com/o/r/actions/runs/1",
    ...over,
  });

  it("returns a null rate rather than 0% when nothing decided", () => {
    // `absent is never zero` — a workflow with no finished run has no success
    // rate, and rendering 0% would report a healthy repository as totally
    // broken.
    const trend = summariseWorkflowRuns([run({ status: "in_progress", conclusion: null })]);
    expect(trend.totals.successRate).toBeNull();
    expect(trend.workflows[0].successRate).toBeNull();
    expect(trend.empty).toBe(true);
  });

  it("computes the rate over decided runs only", () => {
    const trend = summariseWorkflowRuns([
      run({ conclusion: "success" }),
      run({ conclusion: "failure" }),
      run({ conclusion: "cancelled" }),
      run({ status: "in_progress", conclusion: null }),
    ]);
    // 1 of 2 decided — the cancelled and the running one are neither.
    expect(trend.totals.successRate).toBe(50);
    expect(trend.totals.inconclusive).toBe(1);
    expect(trend.totals.running).toBe(1);
  });

  it("does not count a cancelled or skipped run as a failure", () => {
    const trend = summariseWorkflowRuns([
      run({ conclusion: "cancelled" }),
      run({ conclusion: "skipped" }),
      run({ conclusion: "neutral" }),
      run({ conclusion: "stale" }),
    ]);
    expect(trend.totals.failed).toBe(0);
    expect(trend.totals.inconclusive).toBe(4);
  });

  it("counts timed_out and action_required as failures", () => {
    const trend = summariseWorkflowRuns([
      run({ conclusion: "timed_out" }),
      run({ conclusion: "action_required" }),
    ]);
    expect(trend.totals.failed).toBe(2);
  });

  it("counts the streak of consecutive failures, newest first", () => {
    const trend = summariseWorkflowRuns([
      run({ conclusion: "failure" }),
      run({ conclusion: "failure" }),
      run({ conclusion: "success" }),
      run({ conclusion: "failure" }),
    ]);
    expect(trend.consecutiveFailures).toBe(2);
  });

  it("steps over an inconclusive run rather than breaking the streak", () => {
    // A cancelled run between two failures does not make prime healthy for an
    // instant.
    const trend = summariseWorkflowRuns([
      run({ conclusion: "failure" }),
      run({ conclusion: "cancelled" }),
      run({ conclusion: "failure" }),
      run({ conclusion: "success" }),
    ]);
    expect(trend.consecutiveFailures).toBe(2);
  });

  it("groups by workflow and sorts the worst first", () => {
    const trend = summariseWorkflowRuns([
      run({ name: "security", conclusion: "success" }),
      run({ name: "security", conclusion: "success" }),
      run({ name: "verify", conclusion: "failure" }),
      run({ name: "verify", conclusion: "success" }),
    ]);
    expect(trend.workflows.map((w) => w.name)).toEqual(["verify", "security"]);
    expect(trend.workflows[0].successRate).toBe(50);
    expect(trend.workflows[1].successRate).toBe(100);
  });

  it("sorts an unmeasured workflow beside a bad one, never at the healthy end", () => {
    const trend = summariseWorkflowRuns([
      run({ name: "green", conclusion: "success" }),
      run({ name: "unmeasured", status: "queued", conclusion: null }),
    ]);
    expect(trend.workflows[0].name).toBe("unmeasured");
  });

  it("records when each workflow last failed", () => {
    const trend = summariseWorkflowRuns([
      run({ name: "verify", conclusion: "success", createdAt: "2026-09-20T12:00:00Z" }),
      run({ name: "verify", conclusion: "failure", createdAt: "2026-09-20T09:00:00Z" }),
    ]);
    expect(trend.workflows[0].lastFailureAt).toBe("2026-09-20T09:00:00Z");
    expect(trend.workflows[0].lastConclusion).toBe("success");
  });
});

describe("readCiForHead", () => {
  const pr: PrimePullRequest = {
    number: 42,
    title: "Something",
    author: "someone",
    draft: false,
    headSha: HEAD,
    headRef: "feature",
    createdAt: "2026-09-20T08:00:00Z",
    updatedAt: "2026-09-20T09:00:00Z",
    htmlUrl: "https://github.com/o/r/pull/42",
  };
  const runFor = (sha: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
    id: 1,
    name: "verify",
    status: "completed",
    conclusion: "success",
    headSha: sha,
    headBranch: "feature",
    event: "pull_request",
    createdAt: "2026-09-20T09:00:00Z",
    htmlUrl: "https://github.com/o/r/actions/runs/1",
    ...over,
  });

  it("is unobserved — never passing — when no run in the window names the head", () => {
    expect(readCiForHead(pr.headSha, [runFor(OTHER)])).toBe("unobserved");
    expect(readCiForHead(pr.headSha, [])).toBe("unobserved");
  });

  it("reads a failure on the head", () => {
    expect(readCiForHead(pr.headSha, [runFor(HEAD, { conclusion: "failure" })])).toBe("failing");
  });

  it("prefers a failure over a run still going", () => {
    const ci = readCiForHead(pr.headSha, [
      runFor(HEAD, { conclusion: "failure" }),
      runFor(HEAD, { status: "in_progress", conclusion: null }),
    ]);
    expect(ci).toBe("failing");
  });

  it("reads a head whose only runs were cancelled as unobserved", () => {
    // Nothing built it. `passing` here would be the empty-reading defect one
    // level down.
    expect(readCiForHead(pr.headSha, [runFor(HEAD, { conclusion: "cancelled" })])).toBe(
      "unobserved",
    );
  });

  it("reads a green head as passing", () => {
    expect(readCiForHead(pr.headSha, [runFor(HEAD)])).toBe("passing");
  });

  it("decorates a list without dropping any pull request", () => {
    const read = readPullRequests([pr, { ...pr, number: 43, headSha: OTHER }], [runFor(HEAD)]);
    expect(read).toHaveLength(2);
    expect(read[0].ci).toBe("passing");
    expect(read[1].ci).toBe("unobserved");
  });
});

describe("assessPosture", () => {
  const gate = (checks: readonly CheckRun[] | null) => assessPrimeGate(checks);
  const coverage = (state: "carried" | "in_flight" | "uncarried" | "unknown") =>
    assessCascadeCoverage(
      state === "unknown"
        ? { headSha: null, events: [] }
        : {
            headSha: HEAD,
            events:
              state === "carried"
                ? [{ id: "e", sourceSha: HEAD, status: "completed" as const, createdAt: "x" }]
                : state === "in_flight"
                  ? [{ id: "e", sourceSha: HEAD, status: "running" as const, createdAt: "x" }]
                  : [],
          },
    );

  it("a red head outranks everything else", () => {
    const p = assessPosture(gate([ok("verify"), red("security")]), coverage("carried"));
    expect(p.tone).toBe("bad");
    expect(p.word).toBe("red");
  });

  it("a red head still outranks a stranded one", () => {
    const p = assessPosture(gate([red("verify"), ok("security")]), coverage("uncarried"));
    expect(p.word).toBe("red");
  });

  it("names a green head that nothing is carrying", () => {
    const p = assessPosture(gate(allRequiredGreen()), coverage("uncarried"));
    expect(p.tone).toBe("warn");
    expect(p.word).toBe("stranded");
    expect(p.sentence).toMatch(/nothing is carrying it/i);
  });

  it("does not read an unreadable gate as settled", () => {
    const p = assessPosture(gate(null), coverage("carried"));
    expect(p.tone).toBe("idle");
    expect(p.word).toBe("unreadable");
  });

  it("does not read an unbuilt head as settled", () => {
    const p = assessPosture(gate([]), coverage("carried"));
    expect(p.tone).toBe("warn");
    expect(p.word).toBe("unproven");
  });

  it("reads a proven, carried head as clear", () => {
    const p = assessPosture(gate(allRequiredGreen()), coverage("carried"));
    expect(p.tone).toBe("ok");
    expect(p.word).toBe("clear");
  });

  it("reads a proven head with a cascade under way as cascading", () => {
    const p = assessPosture(gate(allRequiredGreen()), coverage("in_flight"));
    expect(p.tone).toBe("ok");
    expect(p.word).toBe("cascading");
  });

  it("only ever answers `ok` on a proven gate", () => {
    const states = ["carried", "in_flight", "uncarried", "unknown"] as const;
    const notProven: Array<readonly CheckRun[] | null> = [null, [], [red("verify")]];
    for (const state of states) {
      for (const checks of notProven) {
        expect(assessPosture(gate(checks), coverage(state)).tone).not.toBe("ok");
      }
    }
  });
});

describe("commitHeadline", () => {
  it("takes the first line and drops the body", () => {
    expect(commitHeadline("Fix the thing\n\nA long body\nwith lines")).toBe("Fix the thing");
  });

  it("bounds a long single line", () => {
    expect(commitHeadline("x".repeat(200)).length).toBe(120);
    expect(commitHeadline("x".repeat(200))).toMatch(/…$/);
  });

  it("survives an empty message", () => {
    expect(commitHeadline("")).toBe("");
  });
});
