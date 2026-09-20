import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { REPOSITORY_INVARIANTS } from "./cascade/repositoryInvariants.pure";
import {
  DEPENDABOT_CONFIG_PATH,
  GITLEAKS_CONFIG_PATH,
  SHIPPED_BACKEND_PAIR_PATHS,
  RESOLVER_MODULE_CANDIDATES,
  IDENTITY_GUARD_SPEC_PATH,
  CI_WORKFLOW_PATH,
  declaresFallbackPair,
  ciRunsIdentityGuard,
  appendOwnKeyAllowlist,
  backendPairNamesForeignProject,
  gitleaksAllowsKey,
  rewriteBackendPair,
  rewriteConfigTomlProjectId,
  configTomlNamesForeignProject,
  stripWorkflowProjectRefDefault,
  supabaseRefOfJwt,
  workflowHasProjectRefDefault,
} from "./clone-repo-retarget.server";

const PRIME = "dduzbchuswwbefdunfct";
const CLONE = "plisdzywzleljorrphxv";

describe("rewriteConfigTomlProjectId", () => {
  it("points project_id at the clone", () => {
    const out = rewriteConfigTomlProjectId(`project_id = "${PRIME}"\n`, CLONE);
    expect(out).toBe(`project_id = "${CLONE}"\n`);
  });

  it("leaves the [functions.*] blocks alone", () => {
    // config.toml carries one block per edge function — 423 on this prime.
    // A blanket replace of the ref would corrupt every one of them.
    const toml = [
      `project_id = "${PRIME}"`,
      "",
      "[functions.aml-cases]",
      "verify_jwt = false",
      "",
      "[functions.custom-auth-login]",
      "verify_jwt = false",
      "",
    ].join("\n");
    const out = rewriteConfigTomlProjectId(toml, CLONE);
    expect(out).toContain("[functions.aml-cases]");
    expect(out).toContain("[functions.custom-auth-login]");
    expect(out.match(/verify_jwt = false/g)).toHaveLength(2);
    expect(out).toContain(`project_id = "${CLONE}"`);
    expect(out).not.toContain(PRIME);
  });

  it("rewrites only the first assignment", () => {
    const toml = `project_id = "${PRIME}"\n# project_id = "${PRIME}"\n`;
    const out = rewriteConfigTomlProjectId(toml, CLONE);
    expect(out.match(new RegExp(CLONE, "g"))).toHaveLength(1);
  });

  it("tolerates leading whitespace", () => {
    expect(rewriteConfigTomlProjectId(`  project_id = "${PRIME}"`, CLONE)).toContain(CLONE);
  });
});

describe("configTomlNamesForeignProject", () => {
  it("is true while the file names another project", () => {
    expect(configTomlNamesForeignProject(`project_id = "${PRIME}"`, CLONE)).toBe(true);
  });

  it("is false once it names our own", () => {
    expect(configTomlNamesForeignProject(`project_id = "${CLONE}"`, CLONE)).toBe(false);
  });

  it("is false when there is no project_id to disagree with", () => {
    expect(configTomlNamesForeignProject("[functions.x]\nverify_jwt = false\n", CLONE)).toBe(false);
  });
});

describe("stripWorkflowProjectRefDefault", () => {
  const withDefault = `          PROJECT_REF: \${{ vars.SUPABASE_PROJECT_REF || '${PRIME}' }}\n`;

  it("removes the hard-coded fallback", () => {
    expect(stripWorkflowProjectRefDefault(withDefault)).toBe(
      "          PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}\n",
    );
  });

  it("does NOT substitute the clone's ref", () => {
    // The ref belongs in a repository variable, where it changes without a
    // commit. A second hard-coded default is the same bug with a new value.
    const out = stripWorkflowProjectRefDefault(withDefault);
    expect(out).not.toContain(CLONE);
    expect(out).not.toContain(PRIME);
  });

  it("removes every occurrence — the deploy workflow has two", () => {
    const twice = withDefault + "\n" + withDefault;
    expect(workflowHasProjectRefDefault(stripWorkflowProjectRefDefault(twice))).toBe(false);
  });

  it("leaves an already-fixed workflow untouched", () => {
    const clean = "PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF }}\n";
    expect(stripWorkflowProjectRefDefault(clean)).toBe(clean);
  });

  it("tolerates spacing variants", () => {
    const spaced = "${{vars.SUPABASE_PROJECT_REF||'abc'}}";
    expect(stripWorkflowProjectRefDefault(spaced)).toBe("${{ vars.SUPABASE_PROJECT_REF }}");
  });
});

describe("workflowHasProjectRefDefault", () => {
  it("detects the shape that made a clone able to deploy into the prime", () => {
    expect(workflowHasProjectRefDefault(`\${{ vars.SUPABASE_PROJECT_REF || '${PRIME}' }}`)).toBe(
      true,
    );
  });

  it("is false once the job fails closed", () => {
    expect(workflowHasProjectRefDefault("${{ vars.SUPABASE_PROJECT_REF }}")).toBe(false);
  });
});

/**
 * Step 5 — the prime's Dependabot config.
 *
 * Read through the source rather than by driving Octokit, which is how the
 * other imperative steps here are already unverified: they are not unit-tested
 * at all. What is asserted is the shape (delete, never rewrite; non-fatal like
 * every other step) and — more importantly — the PREMISE, because the
 * justification for deleting somebody's config file is entirely borrowed.
 */
describe("dropping the prime's Dependabot config from a clone", () => {
  const source = readFileSync("src/server/clone-repo-retarget.server.ts", "utf8");
  const step = source.slice(source.indexOf("// 5. The prime's Dependabot config"));

  it("deletes the file rather than rewriting it", () => {
    // A rewritten config still says somebody decided what it should contain.
    // The decision here is that the repository has no say in its dependencies,
    // and the only honest spelling of that is absence.
    expect(step).toContain("octokit.repos.deleteFile(");
    expect(step).toContain("path: DEPENDABOT_CONFIG_PATH");
    expect(step).not.toContain("createOrUpdateFileContents");
  });

  it("is non-fatal and reports an absent file as absent, like every other step", () => {
    // "a repository that lacks one of these files is not broken, and a partial
    // result is more useful than an abort" — this module's own header.
    expect(step).toMatch(
      /if \(!f\) \{\s*actions\.push\(\{ target: DEPENDABOT_CONFIG_PATH, status: "absent" \}\)/,
    );
    expect(step).toMatch(/\}\s*catch\s*\(e\)\s*\{[\s\S]*status: "failed"/);
  });

  it("names the one path, and names it once", () => {
    expect(DEPENDABOT_CONFIG_PATH).toBe(".github/dependabot.yml");
    // A literal at each end is how two ends drift; the constant is exported so
    // the deletion and anything that later asserts it read the same string.
    expect(step).not.toContain('".github/dependabot.yml"');
  });

  it("THE PREMISE: the dependency graph really is cascaded, so a clone cannot own it", () => {
    /*
      Everything above rests on a fact about a different module. If
      package.json and package-lock.json stop being repository invariants, a
      clone owns its own dependencies, a Dependabot PR there can land, and
      deleting the config becomes removal of a working control rather than of
      dead machinery.

      Asserted rather than trusted, for the same reason `cloneStatusRecovery`
      asserts that the migration lane never writes `clone_backends.status`:
      the reasoning is only as good as the premise, and the premise lives
      somewhere this file does not.
    */
    const patterns = REPOSITORY_INVARIANTS.map((i) => i.pattern);
    expect(patterns).toContain("package.json");
    expect(patterns).toContain("package-lock.json");
  });
});

/**
 * Step 6/7 — the shipped Supabase pair, and the scan that has to learn it.
 *
 * The four artefacts above are build and deploy configuration. These three are
 * the ones a CUSTOMER reaches: `public/` is copied into `dist/` verbatim and
 * served from the clone's own domain, and `env.ts` is what the app falls back
 * to when `VITE_SUPABASE_URL` is unset — the ordinary state of a new
 * deployment. Measured 20 Sep 2026, all three clones shipped the PRIME's URL
 * and anon key in all three files, from their first commit.
 *
 * The keys below are BUILT rather than pasted. A real anon key in a fixture is
 * a real credential in a repository, and the thing under test is the decode —
 * so constructing the token is both safer and a more honest exercise of it.
 */
const jwt = (ref: string) => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role: "anon" })}.sig-${ref}`;
};

const PRIME_KEY = jwt(PRIME);
const CLONE_KEY = jwt(CLONE);

describe("supabaseRefOfJwt", () => {
  it("reads the project a Supabase token names", () => {
    expect(supabaseRefOfJwt(PRIME_KEY)).toBe(PRIME);
  });

  it("is null for a token that names no project", () => {
    // Which is what keeps the rewrite from touching an unrelated credential
    // that happens to share a file. Only a token naming a Supabase project is
    // backend identity.
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
    expect(supabaseRefOfJwt(`${b64({ alg: "HS256" })}.${b64({ sub: "someone" })}.sig`)).toBeNull();
  });

  it("is null rather than throwing on a string that is not a JWT at all", () => {
    expect(supabaseRefOfJwt("eyJnot.a.jwt")).toBeNull();
    expect(supabaseRefOfJwt("")).toBeNull();
  });
});

describe("rewriteBackendPair", () => {
  const embed = [
    "<script>",
    `  var SUPABASE_URL = 'https://${PRIME}.supabase.co';`,
    `  var ANON_KEY = '${PRIME_KEY}';`,
    "</script>",
  ].join("\n");

  it("moves the URL and the key together", () => {
    // The PAIR is what authenticates. A URL from one project with a key from
    // another authenticates to nothing, so a rewrite that moved one would
    // replace a wrong-but-working deployment with a broken one.
    const out = rewriteBackendPair(embed, CLONE, CLONE_KEY);
    expect(out).toContain(`https://${CLONE}.supabase.co`);
    expect(out).toContain(CLONE_KEY);
    expect(out).not.toContain(PRIME);
    expect(out).not.toContain(PRIME_KEY);
  });

  it("rewrites a PARENT's project too, not merely the prime's", () => {
    // The near-miss of 20 Sep 2026: with lineage routing on, a cascade almost
    // wrote npc-client-dashboard's ref and key into its two children. That
    // value is wrong there and is not the prime's — so anything shaped as
    // "replace the prime" would have gone green over the worse value.
    //
    // CLONE above IS npc-client-dashboard, so the child is the target here.
    const child = "umrtusxohxjxzodxorim"; // npc-test-76b3b3
    const childKey = jwt(child);
    const inherited = [`url: https://${CLONE}.supabase.co`, `key: ${CLONE_KEY}`].join("\n");
    const out = rewriteBackendPair(inherited, child, childKey);
    expect(out).not.toContain(CLONE);
    expect(out).not.toContain(CLONE_KEY);
    expect(out).toContain(`https://${child}.supabase.co`);
    expect(out).toContain(childKey);
  });

  it("leaves a token that is not a Supabase JWT exactly as it is", () => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
    const foreign = `${b64({ alg: "HS256" })}.${b64({ aud: "stripe" })}.sig`;
    const text = `supabase: https://${PRIME}.supabase.co\nother: ${foreign}`;
    const out = rewriteBackendPair(text, CLONE, CLONE_KEY);
    expect(out).toContain(foreign);
    expect(out).toContain(`https://${CLONE}.supabase.co`);
  });

  it("is idempotent — a file already naming the clone is byte-identical", () => {
    const already = rewriteBackendPair(embed, CLONE, CLONE_KEY);
    expect(rewriteBackendPair(already, CLONE, CLONE_KEY)).toBe(already);
  });
});

describe("backendPairNamesForeignProject", () => {
  it("is true while either half still names somewhere else", () => {
    expect(backendPairNamesForeignProject(`https://${PRIME}.supabase.co`, CLONE)).toBe(true);
    expect(backendPairNamesForeignProject(PRIME_KEY, CLONE)).toBe(true);
  });

  it("is false once both halves are this deployment's", () => {
    // Which is what makes step 6 report `unchanged` rather than churning a
    // commit on a clone provisioned twice, or one corrected by hand.
    expect(
      backendPairNamesForeignProject(`https://${CLONE}.supabase.co\n${CLONE_KEY}`, CLONE),
    ).toBe(false);
  });

  it("is false for a file that names no Supabase project at all", () => {
    expect(backendPairNamesForeignProject("# nothing to see", CLONE)).toBe(false);
  });
});

describe("appendOwnKeyAllowlist", () => {
  const config = [
    "[extend]",
    "useDefault = true",
    "",
    "[[allowlists]]",
    'description = "The prime\'s anon key, in inherited migrations."',
    "regexes = [",
    `  '''${PRIME_KEY}''',`,
    "]",
    "",
  ].join("\n");

  it("teaches the scan this deployment's key", () => {
    const out = appendOwnKeyAllowlist(config, CLONE, CLONE_KEY);
    expect(gitleaksAllowsKey(out, CLONE_KEY)).toBe(true);
  });

  it("KEEPS the prime's literal rather than replacing it", () => {
    // The prime's key appears in the applied migrations a clone inherits, and
    // those cannot be edited without breaking replay. Substituting would fix
    // the shipped file and break the history it arrived with.
    const out = appendOwnKeyAllowlist(config, CLONE, CLONE_KEY);
    expect(out).toContain(PRIME_KEY);
    expect(out).toContain("[extend]");
  });

  it("is idempotent — provisioning run twice does not stack blocks", () => {
    const once = appendOwnKeyAllowlist(config, CLONE, CLONE_KEY);
    expect(appendOwnKeyAllowlist(once, CLONE, CLONE_KEY)).toBe(once);
    expect(once.match(/\[\[allowlists\]\]/g)).toHaveLength(2);
  });

  it("allows the key as ONE literal, so a rotated or service_role key still fails", () => {
    const out = appendOwnKeyAllowlist(config, CLONE, CLONE_KEY);
    const block = out.slice(out.lastIndexOf("[[allowlists]]"));
    expect(block).toContain(CLONE_KEY);
    // No character class, quantifier or wildcard: a pattern would allow a
    // family of keys, and the family includes service_role.
    expect(block).not.toMatch(/\[A-Za-z0-9|\\w|\.\*|\.\+/);
  });
});

/**
 * Step 6 and 7, read through the source — the same treatment steps 1–5 get,
 * for the same reason: they drive Octokit and are not reachable without it.
 */
describe("writing the shipped pair", () => {
  const source = readFileSync("src/server/clone-repo-retarget.server.ts", "utf8");
  const step = source.slice(source.indexOf("// 6. The shipped Supabase pair"));

  it("refuses to half-write the pair when no key was supplied", () => {
    // Not a skip. A clone shipping another tenant's key is not a partial
    // success, so the absent key is reported as `failed` and the caller's
    // own `failedRetarget` check sees it.
    expect(step).toMatch(/if \(!cloneAnonKey\)/);
    const refusal = step.slice(step.indexOf("if (!cloneAnonKey)"), step.indexOf("} else {"));
    expect(refusal).toContain('status: "failed"');
    expect(refusal).not.toContain('status: "unchanged"');
    expect(refusal).not.toContain('status: "absent"');
  });

  it("teaches the scan LAST, after the files that need it are written", () => {
    // A scan taught first would allow a key nothing has written yet — quiet,
    // and wrong in the direction that hides things. Taught last, a failure
    // leaves a repository whose own first pull request says so.
    expect(step.indexOf("SHIPPED_BACKEND_PAIR_PATHS")).toBeLessThan(
      step.indexOf("GITLEAKS_CONFIG_PATH"),
    );
  });

  it("names its paths once, through the exported constants", () => {
    expect([...SHIPPED_BACKEND_PAIR_PATHS]).toEqual([
      "public/lead-magnet-embed.html",
      ".env.example",
    ]);
    expect(GITLEAKS_CONFIG_PATH).toBe(".gitleaks.toml");
    expect(step).not.toContain('"public/lead-magnet-embed.html"');
    expect(step).not.toContain('".gitleaks.toml"');
  });

  it("is non-fatal per file, like every other step", () => {
    expect(step).toMatch(/\}\s*catch\s*\(e\)\s*\{[\s\S]*status: "failed"/);
    expect(step).toContain('status: "absent"');
    expect(step).toContain('status: "unchanged"');
  });
});

describe("the declaring module is discovered, not named", () => {
  // `env.ts` used to be a literal in SHIPPED_BACKEND_PAIR_PATHS. It is not
  // where the pair lives everywhere — `npc-crm-independent` split the reads
  // into `supabaseTarget.pure.ts` — and a named path that has moved reads as
  // `absent`, which does not fail a retarget. Provisioning would have
  // reported `ok` over a clone still falling back to the prime.
  it("no longer hard-codes the resolver module among the fixed paths", () => {
    expect([...SHIPPED_BACKEND_PAIR_PATHS]).not.toContain("src/integrations/supabase/env.ts");
    expect([...SHIPPED_BACKEND_PAIR_PATHS]).not.toContain(
      "src/integrations/supabase/supabaseTarget.pure.ts",
    );
  });

  it("searches both layouts", () => {
    expect([...RESOLVER_MODULE_CANDIDATES]).toEqual([
      "src/integrations/supabase/supabaseTarget.pure.ts",
      "src/integrations/supabase/env.ts",
    ]);
  });

  it("recognises a declaration in either module's idiom", () => {
    expect(declaresFallbackPair("const FALLBACK_URL = 'https://x.supabase.co';")).toBe(true);
    expect(declaresFallbackPair("export const FALLBACK_URL='https://x.supabase.co'")).toBe(true);
    expect(declaresFallbackPair('const FALLBACK_URL = "https://x.supabase.co";')).toBe(true);
  });

  it("does not mistake a mention for a declaration", () => {
    // A module that merely READS the constant is not the one to rewrite.
    expect(declaresFallbackPair("import { FALLBACK_URL } from './supabaseTarget.pure';")).toBe(
      false,
    );
    expect(declaresFallbackPair("return FALLBACK_URL;")).toBe(false);
  });

  it("refuses rather than shrugs when nothing declares the pair", () => {
    // The whole point: absent is not a pass here. A repository where neither
    // candidate declares it has a fallback this step cannot see, so the clone
    // keeps whatever it inherited.
    const src = readFileSync("src/server/clone-repo-retarget.server.ts", "utf8");
    const step = src.slice(src.indexOf("// 6. The shipped Supabase pair"));
    const block = step.slice(step.indexOf("RESOLVER_MODULE_CANDIDATES"));
    expect(block).toContain('status: "failed"');
    expect(block).toContain("No module declares FALLBACK_URL");
  });
});

describe("provisioning confirms the guard arrived and is run", () => {
  // Retargeting sets the values once and nothing re-checks them. A clone that
  // is correct today and unguarded is the state all three clones were in on
  // 20 Sep 2026 — right values, nothing watching them.
  it("asks for the spec and for a CI step that names it", () => {
    expect(IDENTITY_GUARD_SPEC_PATH).toBe("src/lib/__tests__/shippedBackendIdentity.spec.ts");
    expect(CI_WORKFLOW_PATH).toBe(".github/workflows/ci.yml");
  });

  it("reads the wiring off the workflow, by the path it would have to name", () => {
    expect(ciRunsIdentityGuard(`      - run: npx vitest run ${IDENTITY_GUARD_SPEC_PATH}`)).toBe(
      true,
    );
  });

  it("is not satisfied by the directory the guard was lost in", () => {
    // `npx vitest run src/lib/__tests__/builderStock` is the only step that
    // reaches that directory, and it never ran this spec. A check that
    // accepted the directory would report the defect as fixed.
    expect(ciRunsIdentityGuard("      - run: npx vitest run src/lib/__tests__/builderStock")).toBe(
      false,
    );
    expect(ciRunsIdentityGuard("      - run: npx vitest run src/lib/__tests__")).toBe(false);
  });

  it("fails a retarget when the guard is absent or unwired", () => {
    const src = readFileSync("src/server/clone-repo-retarget.server.ts", "utf8");
    const step = src.slice(src.indexOf("// 8. The guard"));
    expect(step).toContain("carries no guard over its own backend identity");
    expect(step).toContain("A test nothing invokes cannot fail.");
    expect(step).toContain('status: "failed"');
  });

  it("writes nothing", () => {
    // The spec is deployment-agnostic — it reads its own ref out of
    // config.toml — so there is nothing here to rewrite, only to confirm.
    const src = readFileSync("src/server/clone-repo-retarget.server.ts", "utf8");
    const step = src.slice(src.indexOf("// 8. The guard"));
    expect(step).not.toContain("writeFile(");
  });
});
