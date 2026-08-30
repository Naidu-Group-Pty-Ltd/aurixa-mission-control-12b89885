import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decideCloneSecretTarget } from "./cloneSecretTarget.pure";

const CLONE = "11111111-2222-3333-4444-555555555555";
const CLONE_PROJECT = "plisdzywzleljorrphxv";
const PRIME_PROJECT = "dduzbchuswwbefdunfct";
const MISSION_CONTROL = "fgpvagejkaeqedcwvbte";

const base = {
  cloneId: CLONE,
  cloneExists: true,
  backendRef: CLONE_PROJECT,
  ownRef: MISSION_CONTROL,
  primeBackendRef: PRIME_PROJECT,
};

describe("the guarantee: a clone secret write never reaches the prime", () => {
  it("allows a clone's own project", () => {
    expect(decideCloneSecretTarget(base)).toEqual({ ok: true, projectRef: CLONE_PROJECT });
  });

  it("refuses the prime's project even when a clone row names it", () => {
    // The realistic fault: somebody pastes the prime's ref into a clone's
    // backend row, or a provisioning bug records it. The query cannot return
    // the prime — `clone_backends.clone_id` is NOT NULL and the prime's ref
    // lives in `prime_config` — but the VALUE can still be wrong.
    const d = decideCloneSecretTarget({ ...base, backendRef: PRIME_PROJECT });
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toBe("target_is_prime");
    expect(d.ok === false && d.message).toContain(PRIME_PROJECT);
    expect(d.ok === false && d.message).toMatch(/take the prime's sign-in down/);
  });

  it("refuses Mission Control's own project", () => {
    const d = decideCloneSecretTarget({ ...base, backendRef: MISSION_CONTROL });
    expect(d.ok === false && d.reason).toBe("target_is_mission_control");
  });

  it("refuses when the prime ref cannot be resolved — unknown is not a pass", () => {
    for (const primeBackendRef of [null, undefined, "", "   "]) {
      const d = decideCloneSecretTarget({ ...base, primeBackendRef });
      expect(d.ok, String(primeBackendRef)).toBe(false);
      expect(d.ok === false && d.reason).toBe("target_is_prime");
      expect(d.ok === false && d.message).toMatch(/prime_config\.supabase_project_ref/);
    }
  });

  it("compares case- and whitespace-insensitively", () => {
    // A ref pasted with a stray space or a capital must not slip past the
    // comparison and reach the Management API, which would normalise it.
    for (const backendRef of [` ${PRIME_PROJECT} `, PRIME_PROJECT.toUpperCase()]) {
      const d = decideCloneSecretTarget({ ...base, backendRef });
      expect(d.ok, backendRef).toBe(false);
    }
  });

  it("never returns ok for a ref equal to either protected project, under any other input", () => {
    // Exhaustive over the remaining flags: no combination reopens it.
    for (const backendRef of [PRIME_PROJECT, MISSION_CONTROL]) {
      for (const cloneExists of [true, false]) {
        for (const readError of [null, "boom"]) {
          const d = decideCloneSecretTarget({ ...base, backendRef, cloneExists, readError });
          expect(d.ok, `${backendRef}/${cloneExists}/${readError}`).toBe(false);
        }
      }
    }
  });
});

describe("addressing", () => {
  it("refuses a write that names no clone at all", () => {
    // There is deliberately no way to ask for a project directly.
    for (const cloneId of [null, undefined, "", "  "]) {
      const d = decideCloneSecretTarget({ ...base, cloneId });
      expect(d.ok === false && d.reason).toBe("no_clone_id");
    }
  });

  it("keeps a failed read separate from an absent clone", () => {
    const failed = decideCloneSecretTarget({ ...base, readError: "57014 statement timeout" });
    expect(failed.ok === false && failed.reason).toBe("unreadable");
    expect(failed.ok === false && failed.message).toContain("57014");

    const absent = decideCloneSecretTarget({ ...base, cloneExists: false });
    expect(absent.ok === false && absent.reason).toBe("clone_not_found");
  });

  it("says so when the clone has no project yet, rather than writing nowhere", () => {
    expect(
      decideCloneSecretTarget({ ...base, backendRef: null }).ok === false &&
        decideCloneSecretTarget({ ...base, backendRef: null }).ok === false,
    ).toBe(true);
    const d = decideCloneSecretTarget({ ...base, backendRef: null });
    expect(d.ok === false && d.reason).toBe("backend_not_provisioned");
  });

  it("refuses a ref that is not project-ref shaped", () => {
    // A full URL or a display name pasted into the column. The Management API
    // would reject it, but not before the call is made against something.
    for (const backendRef of [
      "https://plisdzywzleljorrphxv.supabase.co",
      "npc-client-dashboard",
      "short",
      `${CLONE_PROJECT}x`,
    ]) {
      const d = decideCloneSecretTarget({ ...base, backendRef });
      expect(d.ok, backendRef).toBe(false);
      expect(d.ok === false && d.reason).toBe("backend_not_provisioned");
    }
  });
});

describe("the sweep cannot enumerate its way to the prime either", () => {
  // The guard above defends the VALUE. This defends the LIST: the back-fill's
  // candidates come from `clone_backends`, and the prime has no row there.
  //
  // Asserted against the schema rather than against the query, because the
  // query is the thing that could change.
  const migration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260422235720_3fe15343-81a9-45a4-8e82-80c547a38d7b.sql",
    ),
    "utf8",
  );

  it("clone_backends.clone_id is NOT NULL, so no row can be un-owned", () => {
    expect(migration).toMatch(/clone_id\s+uuid\s+not\s+null/i);
  });

  it("the prime's project ref lives on prime_config, a different table", () => {
    const primeMigration = readFileSync(
      join(process.cwd(), "supabase/migrations/20260820213000_prime_backend_project_ref.sql"),
      "utf8",
    );
    expect(primeMigration).toMatch(/alter table public\.prime_config/i);
    expect(primeMigration).toMatch(/add column if not exists supabase_project_ref/i);
    // And it is not on clone_backends.
    expect(migration).not.toMatch(/prime/i);
  });
});

describe("the writer never takes a project ref from its caller", () => {
  // If a project ref were ever an argument, every one of the rules above
  // becomes advisory. This asserts the shape of the module rather than its
  // behaviour, because the behaviour cannot be tested once the shape is wrong.
  const src = readFileSync(join(process.cwd(), "src/server/cloneAllowedOrigins.server.ts"), "utf8");

  it("applyCloneAllowedOrigins is addressed by clone id", () => {
    expect(src).toMatch(
      /export async function applyCloneAllowedOrigins\(\s*supabase: Db,\s*cloneId: string,/,
    );
    expect(src).not.toMatch(/applyCloneAllowedOrigins\([^)]*projectRef/);
  });

  it("the only ref handed to setCloneSecretValue is the guard's return value", () => {
    expect(src).toMatch(/setCloneSecretValue\(\s*target\.projectRef,/);
    // `target` comes from resolveCloneSecretTarget and from nowhere else.
    expect(src).toMatch(/target = await resolveCloneSecretTarget\(supabase, cloneId\)/);
  });

  it("writes exactly one secret name", () => {
    expect(src).toMatch(/ALLOWED_ORIGINS_SECRET = "ALLOWED_ORIGINS"/);
  });
});

describe("NO caller anywhere hands setCloneSecretValue a ref of its own", () => {
  // The rule this module states is repo-wide — "the ONE way to obtain a project
  // ref for a clone-scoped secret write" — so asserting it on one module leaves
  // it advisory everywhere else. It WAS advisory: `setCloneBackendSecret` read
  // `clone_backends.supabase_project_ref` itself and wrote to whatever it found,
  // so a ref mistyped or pasted from the prime's settings page was an ordinary
  // row it wrote a tenant's secret onto.
  //
  // Scanned rather than listed, because a list of known-good callers is exactly
  // what a new caller does not appear in.
  const roots = ["src/server", "src/lib", "src/routes"];

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
    });

  const callers = roots
    .flatMap((r) => walk(join(process.cwd(), r)))
    .map((f) => ({ file: f, body: readFileSync(f, "utf8") }))
    // The definition itself is not a call site.
    .filter((f) => !f.file.endsWith("backend-provisioning.server.ts"))
    .filter((f) => f.body.includes("setCloneSecretValue("));

  it("finds the call sites at all — a scan that matches nothing proves nothing", () => {
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  it.each(callers.map((c) => c.file))("%s resolves its ref through the guard", (file) => {
    const body = callers.find((c) => c.file === file)!.body;
    expect(body).toContain("resolveCloneSecretTarget");
    for (const call of body.match(/setCloneSecretValue\(\s*[^,]+,/g) ?? []) {
      // Either the guard's return value directly, or a const bound from it.
      expect(call).toMatch(/setCloneSecretValue\(\s*(target\.projectRef|projectRef)\s*,/);
    }
  });
});

describe("the hostname comes from the ALLOCATED subdomain, never the slug", () => {
  // `reserveCloneSubdomain` does not simply use the slug. It runs it through
  // `normaliseLabel` (lossy), honours an operator-supplied `preferred`
  // instead, and appends a numeric suffix when the name is taken or reserved.
  //
  // The collision case is the dangerous one: a clone slugged `npc` whose
  // allocated subdomain is `npc-2` would, under the old rule, derive
  // `https://npc.aurixasystems.com.au` — ANOTHER TENANT'S HOSTNAME — into its
  // ALLOWED_ORIGINS, trusting that origin for credentialed responses while
  // omitting the host it is actually served on.
  //
  // `clone-provisioning.functions.ts` records the same fallback being removed
  // from the deployment drain. It survived in the provisioning block that
  // became `resolveCloneOrigins`.
  const src = readFileSync(join(process.cwd(), "src/server/cloneAllowedOrigins.server.ts"), "utf8");

  it("selects the allocated subdomain columns", () => {
    expect(src).toMatch(/\.select\("slug, subdomain, subdomain_fqdn, deploy_url/);
  });

  it("prefers the stored FQDN, then the allocated subdomain", () => {
    expect(src).toMatch(/row\?\.subdomain_fqdn\s*\?\?[\s\S]{0,80}cloneFqdn\(\s*row\?\.subdomain,/);
  });

  it("never derives a hostname from the slug", () => {
    // Guessing a hostname before allocation is how you trust somebody else's.
    expect(src).not.toMatch(/cloneFqdn\(\s*row\?\.slug/);
    expect(src).not.toMatch(/plannedFqdn/);
  });
});

describe("the reconciler", () => {
  const src = readFileSync(join(process.cwd(), "src/server/cloneAllowedOrigins.server.ts"), "utf8");
  const hook = readFileSync(
    join(process.cwd(), "src/routes/hooks.allowed-origins-reconcile.tsx"),
    "utf8",
  );

  it("takes its candidates from clone_backends, which cannot hold the prime", () => {
    expect(src).toMatch(/reconcileAllowedOrigins[\s\S]{0,400}from\("clone_backends"\)/);
  });

  it("treats a failed candidate read as a fault, not an empty fleet", () => {
    // On the one job whose purpose is noticing drift, "0 clones, nothing to do"
    // would make a database fault look like a healthy fleet.
    expect(src).toMatch(/Could not list clone backends/);
  });

  it("skips the Management API when the derived value is unchanged", () => {
    expect(src).toMatch(/if \(lastWritten === value\)/);
    expect(src).toMatch(/changed: false/);
  });

  it("does not treat an unreadable last-write as never-written", () => {
    // Returning null there would re-write every clone on every tick during a
    // database fault.
    expect(src).toMatch(/Could not read the last ALLOWED_ORIGINS write/);
  });

  it("requires cron auth and answers 200 with refusals in the body", () => {
    expect(hook).toMatch(/verifyCronAuth\(request\)/);
    expect(hook).toMatch(/success: true, \.\.\.result/);
  });
});
