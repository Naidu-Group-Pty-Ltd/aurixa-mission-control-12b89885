import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONFIG_TOML_PATH,
  declaredFunctionCount,
  reconcileConfigToml,
} from "./configTomlReconcile.pure";
import { DEFAULT_MIRROR_EXCLUSIONS } from "./syncExclusions.pure";

const PRIME_REF = "dduzbchuswwbefdunfct";
const CLONE_REF = "umrtusxohxjxzodxorim";

/*
  Shaped like the real files: a top-level `project_id`, the local-development
  tables that are identical on both sides, then the `[functions.*]` blocks that
  are the whole point. The prime declares one function the clone has never
  heard of, and declares it `verify_jwt = false` — which is the case that costs
  something, because an omitted block is read by the CLI as `true`.
*/
const preamble = (ref: string) => `project_id = "${ref}"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public", "aml"]

[auth]
site_url = "http://127.0.0.1:3000"
enable_signup = false
`;

const PRIME = `${preamble(PRIME_REF)}
[functions.aml-cases]
verify_jwt = true

[functions.didit-webhook]
verify_jwt = false

[functions.planning-data-service]
verify_jwt = false
`;

const CLONE = `${preamble(CLONE_REF)}
[functions.aml-cases]
verify_jwt = true

[functions.didit-webhook]
verify_jwt = false
`;

describe("reconciling a clone's config.toml", () => {
  it("carries prime's file and puts the clone's own project_id back", () => {
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: CLONE, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The one line that must not travel.
    expect(r.merged).toContain(`project_id = "${CLONE_REF}"`);
    expect(r.merged).not.toContain(PRIME_REF);
    expect(r.ownRef).toBe(CLONE_REF);
    expect(r.changed).toBe(true);

    // The declaration the clone was missing, at the value prime gives it. An
    // omitted block is read by the CLI as `verify_jwt = true`, so this is the
    // difference between a service being reachable and answering 401.
    expect(r.merged).toContain("[functions.planning-data-service]");
    expect(declaredFunctionCount(CLONE)).toBe(2);
    expect(declaredFunctionCount(r.merged)).toBe(3);
  });

  it("carries everything else in the file too, not only the function blocks", () => {
    // The reconcile is not a per-key policy. Whatever prime changes outside the
    // functions — the exposed schema list, the storage limit, a setting that
    // does not exist yet — arrives, because the only thing held back is the
    // one line that is this deployment's identity.
    const primeWider = PRIME.replace(
      'schemas = ["public", "graphql_public", "aml"]',
      'schemas = ["public", "graphql_public", "aml", "billing"]',
    );
    const r = reconcileConfigToml({
      primeToml: primeWider,
      cloneToml: CLONE,
      ownRef: CLONE_REF,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.merged).toContain('"billing"');
    expect(r.merged).toContain(`project_id = "${CLONE_REF}"`);
  });

  it("reports no change when the clone already matches", () => {
    // A clone whose file is already prime's-with-its-own-id must produce no
    // write at all, or every cascade would commit an identical file for ever.
    const already = PRIME.replace(PRIME_REF, CLONE_REF);
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: already, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.merged).toBe(already);
  });

  it("keeps the clone's own formatting of the line", () => {
    const spaced = CLONE.replace(
      `project_id = "${CLONE_REF}"`,
      `project_id   =    "${CLONE_REF}"`,
    );
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: spaced, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.merged).toContain(`project_id   =    "${CLONE_REF}"`);
  });
});

describe("what it refuses", () => {
  const refusal = (over: Partial<Parameters<typeof reconcileConfigToml>[0]>) =>
    reconcileConfigToml({
      primeToml: PRIME,
      cloneToml: CLONE,
      ownRef: CLONE_REF,
      ...over,
    });

  it("refuses when the file and the registry disagree about the project", () => {
    // Two sources naming different databases is exactly when a reconcile must
    // stop: it has no basis for deciding which one is the deployment's real
    // backend, and picking wrong repoints it.
    const r = refusal({ ownRef: "aaaaaaaaaaaaaaaaaaaa" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("disagree");
    expect(r.reason).toContain(CLONE_REF);
  });

  it("proceeds where no backend is registered, because null is not a disagreement", () => {
    // An unprovisioned clone is an ordinary state. The file is still the
    // authority on what it says, and refusing here would freeze the config of
    // every clone whose backend row has not been written yet.
    const r = refusal({ ownRef: null });
    expect(r.ok).toBe(true);
  });

  it("refuses a clone file with no project_id", () => {
    const r = refusal({ cloneToml: CLONE.replace(/^project_id.*$/m, "") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("this clone's config.toml");
  });

  it("refuses a clone file with two, rather than letting TOML's last-wins decide", () => {
    const r = refusal({ cloneToml: `project_id = "zzzzzzzzzzzzzzzzzzzz"\n${CLONE}` });
    expect(r.ok).toBe(false);
  });

  it("refuses a prime file with no project_id", () => {
    const r = refusal({ primeToml: PRIME.replace(/^project_id.*$/m, "") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("prime's config.toml");
  });

  it("refuses a value that is not a project ref", () => {
    const r = refusal({ cloneToml: CLONE.replace(CLONE_REF, "not-a-ref") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("twenty lowercase letters");
  });

  it("never reads a project_id from inside a table", () => {
    // `project_id` is a top-level key. A same-named key under some future
    // `[table]` is a different setting, and reading it as this one is how a
    // parser that is nearly right writes the wrong database name.
    const nested = `${CLONE}\n[some_future_table]\nproject_id = "qqqqqqqqqqqqqqqqqqqq"\n`;
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: nested, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ownRef).toBe(CLONE_REF);
  });

  it("refuses when the result would name another tenant's project by any other route", () => {
    // The second, independent check. `backendRefsIn` reads a project URL and a
    // JWT `ref` claim — shapes a bare TOML assignment does not have — so it is
    // blind to the substitution above and catches what that one cannot.
    // config.toml has never carried either; if one appears, it needs a person.
    const primeWithUrl = PRIME.replace(
      "[api]",
      `api_url = "https://${PRIME_REF}.supabase.co"\n\n[api]`,
    );
    const r = reconcileConfigToml({
      primeToml: primeWithUrl,
      cloneToml: CLONE,
      ownRef: CLONE_REF,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(PRIME_REF);
  });
});

describe("how it sits beside the exclusion it does not remove", () => {
  it("config.toml is still a protected exclusion, and stays one", () => {
    // This module does not lift the exclusion — the path is still withheld
    // from the ordinary write path, and this is a separate, single-file act
    // with its own read-back. If the exclusion ever went, prime's project_id
    // would travel by the plain route and none of the guards above would run.
    const entry = DEFAULT_MIRROR_EXCLUSIONS.find((e) => e.pattern === CONFIG_TOML_PATH);
    expect(entry, "config.toml must remain in DEFAULT_MIRROR_EXCLUSIONS").toBeDefined();
    expect(entry!.reason).toBe("protected");
  });

  it("the engine performs the reconcile", () => {
    // A pure module nothing calls is a rule that does not exist.
    const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
    expect(engine).toContain("reconcileConfigToml");
    expect(engine).toContain("CONFIG_TOML_PATH");
  });
});
