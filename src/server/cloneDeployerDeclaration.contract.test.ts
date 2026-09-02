/**
 * That the declaration is a SWITCH and not a button.
 *
 * The behaviour is tested against `planDeployerDeclaration`'s inputs next
 * door. What a source assertion has to cover is the shape: that something
 * keeps it true on a schedule, that no surface asks a person to press
 * anything, and that the removed control did not survive as a dormant import.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const server = stripComments(read("src/server/cloneDeployerDeclaration.server.ts"));
const pure = stripComments(read("src/server/cloneDeployerDeclaration.pure.ts"));
const cron = stripComments(read("src/routes/hooks.clone-deployer-declaration-reconcile.tsx"));
const card = stripComments(read("src/components/clone-backend-deploy-card.tsx"));
const fns = stripComments(read("src/lib/clone-backend-deploy.functions.ts"));
const migrationSrc = read(
  "supabase/migrations/20260902100000_schedule_clone_deployer_declaration_reconcile.sql",
);
/** The SQL itself. Its `--` prose explains the rules and would trip them. */
const migration = migrationSrc.replace(/^\s*--.*$/gm, "");

describe("something keeps it true without being asked", () => {
  it("a cron-authenticated reconcile exists", () => {
    expect(cron).toContain("verifyCronAuth(request)");
    expect(cron).toContain("reconcileCloneDeployerDeclarations");
  });

  it("it is scheduled, and on the clock the other reconciles use", () => {
    expect(migrationSrc).toContain("@asserts cron:clone-deployer-declaration-reconcile");
    expect(migration).toContain("'*/30 * * * *'");
    // The vault lookup must be INSIDE the command string so it is evaluated on
    // each run — the fault that left `agreements-refresh` answering 401 on
    // every run since it was installed.
    expect(migration).toContain("vault.decrypted_secrets");
    expect(migration).not.toContain("lovable.app");
  });

  it("covers every clone that has a repository, not one the operator picked", () => {
    expect(server).toContain('.from("clones")');
    expect(server).toMatch(/\.not\("github_owner", "is", null\)/);
    expect(server).toMatch(/\.not\("github_repo", "is", null\)/);
  });
});

describe("no surface asks a person to press anything", () => {
  it("the card no longer offers the declaration as an action", () => {
    /*
      The point of the change. A declaration nothing keeps true drifts, and a
      button is the thing that has to be found and remembered — the clone whose
      write GitHub refused had no way back except the next cascade.
    */
    expect(card).not.toContain("Declare Mission Control as the deployer");
    expect(card).not.toContain("declareDeployer");
  });

  it("and does not keep the removed control as a dormant import", () => {
    // A dormant component is one import away from being put back.
    expect(card).not.toContain("declareCloneBackendDeployer");
    expect(fns).not.toContain("declareCloneBackendDeployer");
  });

  it("it still SAYS which of 'not written yet' and 'not permitted' it is", () => {
    // Removing the button must not remove the diagnostic: only one of those
    // two is something a person can act on, and the panel is where they read
    // it. GitHub's own refusal names the remedy; a summary does not.
    // The blocker's TEXT must be rendered, not merely consulted: the panel
    // also reads it to pick a border and an icon, and those would keep a
    // `toContain` green over a card that shows the operator nothing.
    expect(card).toMatch(/\{data\.deployerBlocker\}<\/p>/);

    // …and it is gated on the blocker itself, not on a constant. A `{false &&`
    // leaves every string this file looks for present and the panel dead —
    // the trap this suite has already been caught by once.
    const panel = card.slice(
      card.indexOf("Mission Control is declared as this"),
      card.indexOf("Held true automatically"),
    );
    expect(panel.length).toBeGreaterThan(200);
    expect(panel).toContain("{data.deployerBlocker && (");
    expect(panel).not.toMatch(/\{\s*(?:false|0)\s*&&/);
  });
});

describe("the sweep never writes on a reading nobody has", () => {
  it("a failed variable listing becomes `undefined`, not `null`", () => {
    /*
      `listRepoVariables` answers null when GitHub could not be asked, and
      `??` would silently turn that into "no such variable" — a blind write to
      a repository whose state nobody knows, repeated every half hour.
    */
    expect(server).toMatch(/variables === null \? undefined :/);
  });

  it("the write goes through the reader-back, not the raw variable API", () => {
    // `declareMissionControlDeploysBackend` reads the variable back before
    // reporting success, because a write that returned without throwing and
    // changed nothing is exactly what happened here on 2 Sep.
    expect(server).toContain("declareMissionControlDeploysBackend({ owner, repo })");
    expect(server).not.toContain("putRepoVariable");
  });

  it("permissions are read once for the sweep, not once per clone", () => {
    // They are a property of the App installation, not of a repository.
    const loop = server.slice(server.indexOf("for (const clone of targets)"));
    expect(loop).not.toContain("readInstallationPermissions");
    expect(server).toContain("readInstallationPermissions()");
  });
});

describe("the audit row can tell the two silences apart", () => {
  it("carries what the App's own permission read said", () => {
    /*
      The first live pass reported three repositories as `unknown` and there
      was no way from the outside to tell "the App may not read variables"
      from "GitHub was having a moment" — which need different actions.
    */
    expect(server).toContain("sweep.permission = capabilities.variables.state");
  });

  it("a missing permission is asked about BEFORE a failed reading", () => {
    /*
      `listRepoVariables` answers null for a 403 exactly as it does for an
      outage, so asking about the reading first makes the actionable message
      unreachable in the one case where it is the right one. Both refuse to
      write, so the order costs nothing but the sentence.
    */
    const fn = pure.slice(pure.indexOf("export function planDeployerDeclaration"));
    const missing = fn.indexOf('state === "missing"');
    const unreadable = fn.indexOf("variableValue === undefined");
    expect(missing).toBeGreaterThan(-1);
    expect(unreadable).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(unreadable);
  });
});

describe("GitHub's own refusal still reaches somebody", () => {
  it("a failed write keeps the message verbatim rather than a summary", () => {
    /*
      This property used to live on the button's toast: "Resource not
      accessible by integration" names the remedy and a tidied summary of it
      does not. Removing the button must not remove it, so the sweep carries
      the error through and the audit row keeps it.
    */
    expect(server).toMatch(/sweep\.failed\.push\(\{ repo: label, error: declared\.error \}\)/);
    expect(cron).toContain("metadata: report as unknown as Record<string, unknown>");
  });

  it("and a refusal it could predict is named without being attempted", () => {
    // A write GitHub will refuse, repeated every half hour, is noise. The
    // capability detail is the line an operator acts on.
    expect(server).toMatch(/sweep\.cannot\.push\(\{ repo: label, why: plan\.why \}\)/);
  });
});

describe("a settled fleet is quiet", () => {
  it("the audit row is written only when the pass did something", () => {
    expect(cron).toContain("sweepIsNoteworthy(report)");
  });

  it("and a refusal is a state, not a failed run", () => {
    // 200 with the refusals in the body: a repository Mission Control may not
    // write is not this job failing.
    const ok = cron.indexOf("success: true");
    const fail = cron.indexOf("status: 500");
    expect(ok).toBeGreaterThan(-1);
    expect(fail).toBeGreaterThan(ok);
  });
});
