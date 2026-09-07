import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const server = () => readFileSync("src/server/backendCatchup.server.ts", "utf8");
const route = () => readFileSync("src/routes/hooks.backend-catchup.tsx", "utf8");
const migration = () =>
  readFileSync("supabase/migrations/20260907100000_schedule_backend_catchup.sql", "utf8");
const sync = () => readFileSync("src/server/backendSync.server.ts", "utf8");

describe("the catch-up plans and never advances the baseline", () => {
  it("never writes last_synced_sha", () => {
    /*
     * The rule that would do real damage if it were wrong. `last_synced_sha`
     * means the clone's repository CONTENT is at that prime revision; this
     * sweep deploys FUNCTIONS. Advancing it would tell the next cascade the
     * files are current and skip them, leaving a clone running new functions
     * against old content — worse than being behind on both.
     */
    expect(server()).not.toMatch(/last_synced_sha\s*:/);
    expect(server()).not.toMatch(/\.update\(/);
    expect(server()).not.toMatch(/\.upsert\(/);
    expect(server()).not.toMatch(/\.insert\(/);
    expect(server()).not.toMatch(/\.delete\(/);
  });

  it("reads the baseline rather than inventing one", () => {
    // A clone with no recorded revision owes EVERY backend file, which is the
    // planner's own safe reading. Substituting the clone's own HEAD is the
    // defect that once left two clones reading `failed` for a week.
    const s = server();
    expect(s).toContain("last_synced_sha");
    expect(s).toContain("row.last_synced_sha ?? null");
    expect(s).not.toMatch(/getBranch[\s\S]{0,400}clone/i);
  });

  it("diffs the prime against the PRIME's own HEAD", () => {
    // Both ends of the comparison must be prime revisions or the diff is
    // meaningless and GitHub answers 404.
    const s = server();
    expect(s).toContain('from("prime_config")');
    expect(s).toContain("br.commit.sha");
    expect(s).toContain("toSha: head.sha");
  });
});

describe("a read that failed is not a fleet that owes nothing", () => {
  it("plans nothing when the prime's HEAD cannot be read", () => {
    const s = server();
    const head = s.slice(s.indexOf("async function primeHead"), s.indexOf("export async function runBackendCatchup"));
    // Every exit from the read is either a sha or a named refusal.
    expect(head).toContain("could not read the prime's HEAD");
    expect(head).toContain("prime_not_configured");
    // And the caller stops rather than sweeping with a null sha.
    expect(s).toContain('if ("error" in head)');
    expect(s).toMatch(/refused: head\.error/);
  });

  it("names every per-clone refusal rather than dropping it", () => {
    const s = server();
    expect(s).toContain("refused: request.reason");
    expect(s).toContain("could not list clones");
  });
});

describe("the hook", () => {
  it("is cron-secret gated and answers 200 with its refusals", () => {
    const r = route();
    expect(r).toContain("verifyCronAuth(request)");
    expect(r).toContain("if (!auth.ok) return auth.response");
    // One clone with no Supabase project is a state, not a failed sweep.
    expect(r).toContain("success: true");
    expect(r).toMatch(/status: 500/);
  });

  it("files a breadcrumb only when the sweep did something or could not", () => {
    const r = route();
    expect(r).toMatch(/if \(report\.planned \|\| report\.refused \|\| report\.outcomes\.some/);
  });
});

describe("the schedule", () => {
  it("is scheduled, and offset from the two sweeps it shares a quota with", () => {
    const m = migration();
    expect(m).toContain("@asserts cron:backend-catchup");
    expect(m).toContain("'backend-catchup'");
    // :20/:50 — the fleet secret forward is :15/:45 and the per-clone secret
    // sweep is :07/:37.
    expect(m).toContain("'20,50 * * * *'");
    expect(m).not.toContain("'15,45 * * * *'");
    expect(m).not.toContain("'7,37 * * * *'");
  });

  it("builds its authorisation inside the command, from the vault", () => {
    // Judged on the COMMAND, not the file: the header comment names the
    // lovable.app origin in order to say the URL is not it.
    const m = migration();
    const body = m.slice(m.indexOf("DO $$"));
    expect(body).toContain("decrypted_secrets");
    expect(body).toContain("mission-control.aurixasystems.com.au");
    expect(body).not.toContain("lovable.app");
    // The lookup is inside the command string, so it is evaluated on each run
    // rather than baked in at migration time.
    expect(body).toMatch(/\$f\$[\s\S]*decrypted_secrets[\s\S]*\$f\$/);
  });
});

describe("it reuses the planner rather than copying it", () => {
  it("calls the same function the cascade and the merge drain call", () => {
    // Two copies of "what a clone's backend owes" is how one of them becomes
    // wrong — the rule the class refusals in the fleet secret forward already
    // turn on.
    expect(server()).toContain("requestBackendSyncAfterCascade");
    const s = server();
    expect(s).not.toContain("staleFunctions");
    expect(s).not.toContain("compareCommits");
  });

  it("the planner it calls is still idempotent", () => {
    // The property that lets this run twice an hour: an open run is WIDENED,
    // never duplicated.
    const p = sync();
    expect(p).toContain("already queued");
    expect(p).toMatch(/widened the open run/);
  });
});
