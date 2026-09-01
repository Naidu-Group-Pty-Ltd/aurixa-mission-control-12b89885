/**
 * The backend half of a cascade, pinned where it is easy to undo by tidying.
 *
 * These are structural properties — where a call sits, what it is handed, and
 * what it is wrapped in — so they are asserted against the source rather than
 * against a Supabase double. That is deliberate: this repository has already
 * paid for a double that emulated PostgREST's `.or()` with a regex, so the code
 * and the test agreed with each other while only the server disagreed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Source with comments removed — a comment quoting code is not code.
 *
 * The credential assertions below would otherwise fail on the planner's own
 * header, which names `SUPABASE_ACCESS_TOKEN` precisely to record why it is
 * not cascaded. Judging prose is the same mistake as judging a column name
 * inside a string literal.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const engine = read("src/server/cascade-engine.server.ts");
const drain = read("src/server/cascadeMergeDrain.server.ts");
const planner = read("src/server/backendSync.server.ts");

describe("both places code reaches a clone's default branch ask for the backend", () => {
  it("the engine asks, beside the frontend rebuild it already asked for", () => {
    expect(engine).toContain("requestBackendSyncAfterCascade");
    expect(engine).toContain("requestRedeployAfterPush");
  });

  it("the merge drain asks too", () => {
    // A pull request merged there reaches `main` exactly as a direct push
    // does. Wiring only the engine would leave every cascade that lands as a
    // PR — which is the mode most of this fleet runs in — with a rebuilt
    // frontend over a stale backend.
    expect(drain).toContain("requestBackendSyncAfterCascade");
  });

  it("the engine asks on succeeded and never on pr_opened", () => {
    /*
      A proposal is not a landing. The branch a deployment builds from does not
      carry the change yet, so deploying its functions would put the prime's
      backend on a clone whose repository has not accepted it — the two halves
      from different revisions, which is the fault this whole change exists to
      remove, inverted.
    */
    const guard = 'if (patch.status === "succeeded") {';
    const at = engine.indexOf(guard);
    expect(at).toBeGreaterThan(-1);
    const block = engine.slice(at, engine.indexOf("\n      } else if", at));
    expect(block).toContain("requestBackendSyncAfterCascade");
  });
});

describe("the revision it diffs from is the one the clone actually had", () => {
  it("the engine captures the previous sha before the update overwrites it", () => {
    const capture = engine.indexOf("const previousSha = clone.last_synced_sha");
    const overwrite = engine.indexOf('last_synced_sha: patch.status === "succeeded"');
    expect(capture).toBeGreaterThan(-1);
    expect(overwrite).toBeGreaterThan(-1);
    // Reversed, the diff would be `sha...sha` — empty — and every cascade
    // would report "no backend work" while the backend fell further behind.
    expect(capture).toBeLessThan(overwrite);
  });

  it("the merge drain captures it before its own update", () => {
    const capture = drain.indexOf("const previousSha = clone.data?.last_synced_sha");
    const overwrite = drain.indexOf("last_synced_sha: newest.source_sha");
    expect(capture).toBeGreaterThan(-1);
    expect(overwrite).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(overwrite);
  });
});

describe("asking cannot fail the cascade that asked", () => {
  for (const [name, source] of [
    ["cascade engine", engine],
    ["merge drain", drain],
  ] as const) {
    it(`${name} wraps the request so a repair row cannot report a good push as failed`, () => {
      const at = source.indexOf("requestBackendSyncAfterCascade");
      const before = source.slice(Math.max(0, at - 400), at);
      expect(before).toContain("try {");
    });
  }

  it("the planner returns a reason rather than throwing on a database fault", () => {
    expect(planner).toContain('reason: "db_error"');
    // A read that FAILED is not a row that is ABSENT: reporting a fault as
    // "this clone has no backend" would stop the fleet catching up silently.
    expect(planner).toContain('if (backendErr) return { requested: false, reason: "db_error" };');
  });
});

describe("no credential is cascaded, which is the point", () => {
  it("the planner never names a Supabase access token", () => {
    /*
      The obvious repair for "the clone's CI cannot deploy" is to seal the
      prime's SUPABASE_ACCESS_TOKEN into every clone repository. Supabase's own
      documentation is why that is the wrong shape: a classic token carries
      "every permission, on every organization and every project you belong to
      today, and on every one you create or join in the future". This design
      exists so the credential stays in one place.
    */
    const bare = stripComments(planner);
    expect(bare).not.toMatch(/SUPABASE_ACCESS_TOKEN/);
    expect(bare).not.toMatch(/putRepoSecret|syncRepoSecrets/);
  });

  it("plans work and never performs it", () => {
    // The two self-healing lanes execute. A second deployer here would be a
    // second implementation of a job that already has one.
    const bare = stripComments(planner);
    expect(bare).not.toMatch(/deployEdgeFunctions?\(/);
    expect(bare).not.toMatch(/applyPrimeMigrations|runSqlOnProject/);
  });
});

describe("the policy is consulted, not imitated", () => {
  it("every planned run's status comes from decideRemediation", () => {
    expect(planner).toContain("decideRemediation");
    // A hand-written policy blob would look like the module had been asked.
    const handWritten = /policy:\s*\{\s*autoExecute/.test(stripComments(planner));
    expect(handWritten).toBe(false);
  });

  it("the migration run defers its assessment to the lane, explicitly", () => {
    /*
      Not a bypass. `executeSqlMigration` loads every PENDING body immediately
      before applying it and parks the batch on the first destructive
      statement — a stronger check than one taken at plan time, because the
      prime moves in between. The flag says WHERE the assessment happens.
    */
    expect(planner).toContain("sqlAssessedByLane: true");
    const lane = read("src/server/self-healing.server.ts");
    expect(lane).toContain("assessSqlDestructiveness(sql)");
    expect(lane).toContain("if (!approvedByHuman) {");
  });

  it("a cascade catch-up is planned at a priority the policy will auto-run", () => {
    // P0/P1 never execute unattended, so planning routine maintenance there
    // would queue work that only ever sits.
    expect(planner).toContain('const CASCADE_PRIORITY = "P3"');
  });
});
