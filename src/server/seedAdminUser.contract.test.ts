/**
 * The admin seed has to survive the run that actually needs it: the retry.
 *
 * `seedAdminUser` is step 7 of provisioning. On `npc-client-dashboard` the
 * pipeline died at step 5 — a migration whose dependency the fleet scope had
 * withheld — so step 7 never ran and the clone has 546 tables and no users at
 * all. That is the failure the dependency guard addresses. These two are what
 * the RETRY would then have hit.
 *
 * Both are absences, which is why they are asserted against the source: each
 * one leaves a clone that looks seeded and is not, and no unit test of the
 * happy path can see either.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const provisioning = readFileSync(join(__dirname, "backend-provisioning.server.ts"), "utf8");
const functions = readFileSync(
  join(__dirname, "..", "lib", "backend-provisioning.functions.ts"),
  "utf8",
);

/** Source with comments removed — a comment quoting old code is not old code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The body of `seedAdminUser`, up to the next top-level export. */
function seedBody(): string {
  const start = provisioning.indexOf("export async function seedAdminUser(");
  expect(start, "seedAdminUser must exist").toBeGreaterThan(-1);
  const end = provisioning.indexOf("\n// ─── Full Provisioning Pipeline", start);
  expect(end).toBeGreaterThan(start);
  return stripComments(provisioning.slice(start, end));
}

describe("seedAdminUser grants the role on every path", () => {
  it("does not return before the role grant when the user already exists", () => {
    // The bug: the already-exists branch was `return { userId: null }`, sitting
    // ABOVE the user_roles insert. So the retry after a half-finished run
    // created nobody and granted nothing, leaving an account that can sign in
    // and holds no super_admin — which reads, from every surface, as seeded.
    const body = seedBody();
    const grantAt = body.indexOf("user_roles");
    expect(grantAt, "the role grant must still be here").toBeGreaterThan(-1);

    const before = body.slice(0, grantAt);
    expect(before, "no early `return { userId: null }` may sit above the role grant").not.toMatch(
      /return\s*\{\s*userId:\s*null\s*\}/,
    );
  });

  it("looks the existing user up rather than granting to nothing", () => {
    const body = seedBody();
    expect(body).toContain("findUserIdByEmail");
  });

  it("compares the looked-up email exactly", () => {
    // The Auth Admin filter is a server-side CONTAINS, so `admin@x` also
    // matches `superadmin@x`. Taking users[0] would grant super_admin to
    // whichever neighbour sorted first.
    const bare = stripComments(provisioning);
    const helper = bare.slice(
      bare.indexOf("async function findUserIdByEmail("),
      bare.indexOf("export async function seedAdminUser("),
    );
    expect(helper).toContain(".find(");
    expect(helper).not.toMatch(/users\s*\?\?\s*\[\]\)\s*\[0\]/);
  });
});

describe("a clone_backends row records which account was seeded", () => {
  it("both provisioning paths write admin_email to the row", () => {
    // Only the queued path did. A clone provisioned synchronously carried
    // `admin_email: null` — `npc-client-dashboard` still does — so a resume
    // had no way to know which account to seed, and the one question
    // provisioning cannot answer for itself was unanswerable.
    const writes = functions.split("admin_email:").length - 1;
    expect(
      writes,
      "expected the queued path, the direct path and the audit row",
    ).toBeGreaterThanOrEqual(3);

    // Specifically: the direct path's clone_backends update carries it.
    const directAt = functions.indexOf("migration_version: result.latestMigration");
    expect(directAt).toBeGreaterThan(-1);
    const window = functions.slice(Math.max(0, directAt - 900), directAt);
    expect(window, "the direct path's row update must set admin_email").toContain("admin_email:");
  });
});
