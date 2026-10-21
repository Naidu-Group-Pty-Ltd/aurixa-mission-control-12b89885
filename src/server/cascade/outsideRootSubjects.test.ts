import { describe, expect, it } from "vitest";
import { SUBJECT_ROOTS, subjectsNamedBy } from "@/lib/cascade/membrane/membrane.pure";
import {
  directoriesListedOutsideRoots,
  listedMembers,
  MAX_OUTSIDE_ROOT_PROBES,
  outsideRootCandidates,
  outsideRootSubjectsLeftAsTheCloneHasThem,
  subjectsNamedOutsideRoots,
} from "./outsideRootSubjects.pure";

const SPEC = "src/lib/reportDesign/__tests__/reportTypography.spec.ts";

describe("subjectsNamedOutsideRoots — what a spec names outside the content roots", () => {
  it("reads the document reportTypography.spec.ts diffs, in the words it actually uses", () => {
    // Verbatim from prime@885b324, comment and all: `CLAUDE.md` is named only
    // in prose and at the root, so it is not a subject; the document is.
    const text = [
      "/**",
      " * `CLAUDE.md` names `REPORT_RULES.md` as the thing to read before touching any",
      " * PDF generator.",
      " */",
      "const RULES_DOC = readFileSync(",
      "  resolve(REPO, '.claude/skills/npc-services-design/reports/REPORT_RULES.md'),",
      "  'utf8',",
      ");",
    ].join("\n");
    expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([
      ".claude/skills/npc-services-design/reports/REPORT_RULES.md",
    ]);
  });

  it("reads the segments of one path, which is how geocoderWiring.spec.ts names the CI workflow", () => {
    const text = `expect(read('.github', 'workflows', 'ci.yml')).toContain('npx vitest run src/lib/geocode');`;
    expect(subjectsNamedOutsideRoots(text)).toEqual([".github/workflows/ci.yml"]);
  });

  it("reads a relative literal against the spec's own directory", () => {
    const text = `readFileSync(resolve(__dirname, '../../../../weasyprint-service/app.py'), 'utf8')`;
    expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual(["weasyprint-service/app.py"]);
    // Without the spec's path a relative literal means nothing.
    expect(subjectsNamedOutsideRoots(text)).toEqual([]);
  });

  it("reads the segments of a path after the spec's own directory", () => {
    // No other form reads this one: the first literal opens on a climb, not a
    // top-level directory, and carries no extension of its own.
    const text = `readFileSync(join(__dirname, '../../../../.github/workflows', 'ci.yml'), 'utf8')`;
    expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([".github/workflows/ci.yml"]);
    expect(subjectsNamedOutsideRoots(text)).toEqual([]);
  });

  it("never reads a bare file at the repository root — that is the repository's own configuration", () => {
    const text = [
      `readFileSync('package.json', 'utf8');`,
      `readFileSync(join(ROOT, 'vite.config.ts'));`,
      `const doc = read('CLAUDE.md');`,
      `readFileSync(resolve(__dirname, '../../../../.env.example'))`,
      `readFileSync(join(__dirname, '..', '..', '..', '..', 'package.json'))`,
    ].join("\n");
    expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([]);
  });

  it("never reads a mention in a comment, of either kind", () => {
    const text = [
      "// See .github/workflows/ci.yml and '.github/workflows/deploy.yml' for the steps.",
      "/* the container is built from 'weasyprint-service/Dockerfile.x' */",
      "const a = 1;",
    ].join("\n");
    expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([]);
  });

  it("leaves the content roots to subjectsNamedBy", () => {
    const text = [
      `readFileSync('src/lib/a.ts');`,
      `readFileSync(join(ROOT, 'docs', 'reports', 'A.md'));`,
      `readFileSync(resolve(__dirname, '../../../../supabase/functions/x/index.ts'));`,
    ].join("\n");
    expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([]);
  });

  it("refuses what is not a file in a directory: a directory, a climb, an absolute path", () => {
    const text = [
      `readdirSync('.github/workflows');`,
      `read('.github/../etc/passwd.conf');`,
      `readFileSync('/etc/hosts.conf');`,
      `resolve(__dirname, '../../../../../../outside/the.repo')`,
      `join(__dirname, '../../../../../outside/the', 'repo.md')`,
    ].join("\n");
    expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([]);
  });

  it("is sorted and names each file once", () => {
    const text = [
      `read('weasyprint-service/fly.toml'); read('weasyprint-service/app.py');`,
      `read('weasyprint-service', 'app.py');`,
    ].join("\n");
    expect(subjectsNamedOutsideRoots(text)).toEqual([
      "weasyprint-service/app.py",
      "weasyprint-service/fly.toml",
    ]);
  });
});

describe("the two readers split the tree at the same line", () => {
  // `subjectsNamedBy` spells SUBJECT_ROOTS inline in three patterns, so this
  // is what keeps the list and the patterns from drifting apart — and what
  // keeps a path from being read by both readers, or by neither.
  for (const root of SUBJECT_ROOTS) {
    it(`reads \`${root}/…\` in the content reader alone, in every form`, () => {
      const whole = `readFileSync('${root}/a/b.ts')`;
      const segmented = `join(ROOT, '${root}', 'a', 'b.ts')`;
      const relative = `resolve(__dirname, '../../../../${root}/a/b.ts')`;
      const specDirectory = `join(__dirname, '..', '..', '..', '..', '${root}', 'a', 'b.ts')`;
      for (const text of [whole, segmented, relative, specDirectory]) {
        expect(subjectsNamedBy(text, SPEC)).toEqual([`${root}/a/b.ts`]);
        expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([]);
      }
    });
  }

  for (const top of [".claude", ".github", "weasyprint-service", "support-kb", "services"]) {
    it(`reads \`${top}/…\` in the outside reader alone, in every form`, () => {
      const whole = `readFileSync('${top}/a/b.md')`;
      const segmented = `join(ROOT, '${top}', 'a', 'b.md')`;
      const relative = `resolve(__dirname, '../../../../${top}/a/b.md')`;
      const specDirectory = `join(__dirname, '..', '..', '..', '..', '${top}', 'a', 'b.md')`;
      for (const text of [whole, segmented, relative, specDirectory]) {
        expect(subjectsNamedBy(text, SPEC)).toEqual([]);
        expect(subjectsNamedOutsideRoots(text, SPEC)).toEqual([`${top}/a/b.md`]);
      }
    });
  }
});

describe("outsideRootCandidates — the only files worth a question to prime's history", () => {
  const DOC = ".claude/skills/npc-services-design/reports/REPORT_RULES.md";
  const CI = ".github/workflows/ci.yml";
  const text = `read('${DOC}'); read('.github', 'workflows', 'ci.yml'); read('support-kb/kb.json');`;
  const primeSha = new Map([
    [DOC, "doc-prime"],
    [CI, "ci-prime"],
    ["support-kb/kb.json", "kb"],
  ]);
  const cloneSha = new Map([
    [DOC, "doc-clone"],
    [CI, "ci-clone"],
    ["support-kb/kb.json", "kb"],
  ]);

  it("is a file both sides hold at different versions that is not crossing", () => {
    expect(
      outsideRootCandidates({
        specPath: SPEC,
        specText: text,
        primeSha,
        cloneSha,
        crossing: new Set(),
      }),
    ).toEqual([DOC, CI]);
  });

  it("is never a file already in the delivery, identical on both sides, or held by one side only", () => {
    expect(
      outsideRootCandidates({
        specPath: SPEC,
        specText: text,
        primeSha,
        cloneSha: new Map([[CI, "ci-clone"]]),
        crossing: new Set([CI]),
      }),
    ).toEqual([]);
  });

  it("is nothing for a file that is not a spec — a module names data, not subjects", () => {
    expect(
      outsideRootCandidates({
        specPath: "src/lib/reportDesign/typography.pure.ts",
        specText: text,
        primeSha,
        cloneSha,
        crossing: new Set(),
      }),
    ).toEqual([]);
  });

  it("asks at most a bounded number of questions a pass", () => {
    expect(MAX_OUTSIDE_ROOT_PROBES).toBeGreaterThan(0);
    expect(MAX_OUTSIDE_ROOT_PROBES).toBeLessThanOrEqual(32);
  });

  it("takes the names from a caller that kept them, and answers as a fresh reading does", () => {
    const asked: string[] = [];
    const readNamed = (t: string, path: string) => {
      asked.push(path);
      return subjectsNamedOutsideRoots(t, path);
    };
    const args = {
      specPath: SPEC,
      specText: text,
      primeSha,
      cloneSha,
      crossing: new Set<string>(),
    };
    expect(outsideRootCandidates({ ...args, readNamed })).toEqual(outsideRootCandidates(args));
    expect(asked).toEqual([SPEC]);
    // And a file that is not a spec is not read at all.
    outsideRootCandidates({ ...args, specPath: "src/lib/a.pure.ts", readNamed });
    expect(asked).toEqual([SPEC]);
  });
});

/**
 * `productionCredentialScope.spec.ts` (prime@49248ea), the case this was
 * written for: it names no workflow and asserts about every one.
 */
const CREDENTIAL_SPEC = "src/lib/deploy/__tests__/productionCredentialScope.spec.ts";
const CREDENTIAL_TEXT = [
  "import { readdirSync } from 'node:fs';",
  "import { readWorkflow, REPO_ROOT, runStep, stepScript } from './workflowHarness';",
  "const WORKFLOWS = readdirSync(join(REPO_ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).sort();",
  "  const text = readWorkflow(`.github/workflows/${workflow}`);",
  "      const r = runStep(guard, REPO_ROOT, { REF: 'refs/heads/main' });",
].join("\n");

describe("directoriesListedOutsideRoots — what a spec reads by listing, not by name", () => {
  it("reads the workflows directory productionCredentialScope.spec.ts lists", () => {
    expect(subjectsNamedOutsideRoots(CREDENTIAL_TEXT, CREDENTIAL_SPEC)).toEqual([]);
    // `refs/heads/main` is directory-shaped too; only a tree holding files in
    // it makes one a subject (`listedMembers`).
    expect(directoriesListedOutsideRoots(CREDENTIAL_TEXT)).toEqual([
      ".github/workflows",
      "refs/heads/main",
    ]);
  });

  it("reads the forms networkGuard.spec.ts and scriptProjectRef.spec.ts use", () => {
    expect(
      directoriesListedOutsideRoots(
        "const dir = '.github/workflows';\nconst a = readdirSync(dir);",
      ),
    ).toEqual([".github/workflows"]);
    expect(
      directoriesListedOutsideRoots(
        "readdirSync('.github/scripts').map((name) => readFileSync(`.github/scripts/${name}`, 'utf8'));",
      ),
    ).toEqual([".github/scripts"]);
    expect(directoriesListedOutsideRoots("globSync(join(ROOT, '.github', 'workflows'))")).toEqual([
      ".github/workflows",
    ]);
  });

  it("reads nothing where nothing is listed: a directory mentioned is not a directory read", () => {
    // deployWorkflowScenarios.spec.ts: `expect(on).not.toContain('.github/deploy')`.
    expect(directoriesListedOutsideRoots("expect(on).not.toContain('.github/deploy');")).toEqual(
      [],
    );
  });

  it("never reads a content root, a single segment, a file, a climb, or a comment", () => {
    const text = [
      "readdirSync(x);",
      "'src/lib/aml'; 'supabase/functions'; '.github'; '.github/workflows/ci.yml';",
      "'.github/../etc'; 'weasyprint-service//fonts';",
      "// '.claude/skills'",
    ].join("\n");
    expect(directoriesListedOutsideRoots(text)).toEqual([]);
  });
});

describe("listedMembers — what a listing returns, on either side", () => {
  const prime = new Map([
    [".github/workflows/ci.yml", "a"],
    [".github/workflows/apply-migration.yml", "b"],
    [".github/workflows/nested/x.yml", "c"],
    [".github/dependabot.yml", "d"],
  ]);
  const clone = new Map([
    [".github/workflows/ci.yml", "a"],
    [".github/workflows/set-builder-stock-link-secrets.yml", "e"],
  ]);

  it("is every file directly in the directory, in either tree, once", () => {
    expect(listedMembers([".github/workflows"], prime, clone)).toEqual([
      ".github/workflows/apply-migration.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/set-builder-stock-link-secrets.yml",
    ]);
  });

  it("is nothing for a directory no tree holds files in", () => {
    expect(listedMembers(["refs/heads"], prime, clone)).toEqual([]);
    expect(listedMembers([], prime, clone)).toEqual([]);
  });
});

describe("a listed member is a subject on the same terms as a named one", () => {
  const primeSha = new Map([
    [".github/workflows/ci.yml", "ci"],
    [".github/workflows/apply-migration.yml", "apply-prime"],
    [".github/workflows/rotate-internal-edge-secret.yml", "rotate-prime"],
    [".github/workflows/deploy-supabase-functions.yml", "deploy-prime"],
  ]);
  const cloneSha = new Map([
    [".github/workflows/ci.yml", "ci"],
    [".github/workflows/apply-migration.yml", "apply-clone"],
    [".github/workflows/rotate-internal-edge-secret.yml", "rotate-clone"],
    [".github/workflows/deploy-supabase-functions.yml", "deploy-clone"],
    [".github/workflows/set-builder-stock-link-secrets.yml", "stock-clone"],
    [".github/workflows/vcr-prune.yml", "vcr"],
  ]);
  const args = {
    specPath: CREDENTIAL_SPEC,
    specText: CREDENTIAL_TEXT,
    primeSha,
    cloneSha,
    // The deploy workflow is pumped: it crosses, reconciled.
    crossing: new Set([".github/workflows/deploy-supabase-functions.yml"]),
  };

  it("asks prime's history only about members both sides hold at different versions", () => {
    expect(outsideRootCandidates(args)).toEqual([
      ".github/workflows/apply-migration.yml",
      ".github/workflows/rotate-internal-edge-secret.yml",
    ]);
  });

  it("names every member the delivery leaves as the clone has it, prime's or not (#381)", () => {
    expect(
      outsideRootSubjectsLeftAsTheCloneHasThem({
        ...args,
        removing: new Set([".github/workflows/vcr-prune.yml"]),
      }),
    ).toEqual([
      ".github/workflows/apply-migration.yml",
      ".github/workflows/rotate-internal-edge-secret.yml",
      ".github/workflows/set-builder-stock-link-secrets.yml",
    ]);
  });

  it("never names a member that is identical, crossing, being removed, or the clone does not hold", () => {
    expect(
      outsideRootSubjectsLeftAsTheCloneHasThem({
        ...args,
        crossing: new Set([...cloneSha.keys()]),
        removing: new Set(),
      }),
    ).toEqual([]);
    expect(
      outsideRootSubjectsLeftAsTheCloneHasThem({
        ...args,
        cloneSha: new Map([[".github/workflows/ci.yml", "ci"]]),
        removing: new Set(),
      }),
    ).toEqual([]);
  });

  it("is nothing for a file that is not a spec", () => {
    expect(
      outsideRootSubjectsLeftAsTheCloneHasThem({
        ...args,
        specPath: "src/lib/deploy/deployScope.pure.ts",
        removing: new Set(),
      }),
    ).toEqual([]);
  });

  it("takes the listing from a caller that kept it, and answers as a fresh reading does", () => {
    const asked: string[] = [];
    const readListed = (t: string, path: string) => {
      asked.push(path);
      return directoriesListedOutsideRoots(t);
    };
    expect(outsideRootCandidates({ ...args, readListed })).toEqual(outsideRootCandidates(args));
    expect(asked).toEqual([CREDENTIAL_SPEC]);
  });
});

describe("a fixture written outside the content roots is not a file the spec reads", () => {
  it("drops a path only ever WRITTEN, and keeps one the spec also reads", () => {
    // deployWorkflowScenarios.spec.ts (prime@49248ea), lines 21 and 136-137.
    const written = [
      "repo.write('.github/workflows/deploy-supabase-functions.yml', 'name: x\\n');",
      "repo.write('.github/deploy/held-functions.txt', 'aml-reliance\\nother-fn\\n');",
    ].join("\n");
    expect(subjectsNamedOutsideRoots(written)).toEqual([]);
    const read = "const WORKFLOW = '.github/workflows/deploy-supabase-functions.yml';\n" + written;
    expect(subjectsNamedOutsideRoots(read)).toEqual([
      ".github/workflows/deploy-supabase-functions.yml",
    ]);
  });
});
