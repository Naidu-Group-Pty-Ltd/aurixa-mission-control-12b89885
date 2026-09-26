import { describe, expect, it } from "vitest";
import { SUBJECT_ROOTS, subjectsNamedBy } from "@/lib/cascade/membrane/membrane.pure";
import {
  MAX_OUTSIDE_ROOT_PROBES,
  outsideRootCandidates,
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

  it("never reads a bare file at the repository root — that is the repository's own configuration", () => {
    const text = [
      `readFileSync('package.json', 'utf8');`,
      `readFileSync(join(ROOT, 'vite.config.ts'));`,
      `const doc = read('CLAUDE.md');`,
      `readFileSync(resolve(__dirname, '../../../../.env.example'))`,
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
      for (const text of [whole, segmented, relative]) {
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
      for (const text of [whole, segmented, relative]) {
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
});
