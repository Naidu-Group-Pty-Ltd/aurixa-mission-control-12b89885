import { describe, expect, it } from "vitest";
import { subjectsNamedBy, suppliesFixtureContent } from "./membrane.pure";

/**
 * A spec that builds a scratch repository names the files it writes there in
 * the spelling of the files it reads here. Each shape below is verbatim from
 * a prime spec (prime@49248ea, 21 Oct 2026).
 */
const DEPLOY_SPEC = "src/lib/deploy/__tests__/deployWorkflowScenarios.spec.ts";

describe("subjectsNamedBy — a fixture's path is not a subject", () => {
  it("drops the scratch repository deployWorkflowScenarios.spec.ts writes (#381)", () => {
    const text = [
      "function repoWith() {",
      "  return fixtureRepo({",
      "    'supabase/config.toml': 'project_id = \"abcdefghijklmnopqrst\"\\n\\n[functions.aml-reliance]\\nverify_jwt = false\\n',",
      "    'supabase/functions/_shared/auth.ts': 'export const auth = 1;\\n',",
      "    'supabase/functions/aml-reliance/index.ts':",
      "      \"import { surface } from '../_shared/aml/partnerSurface.pure.ts';\\nconsole.log(surface);\\n\",",
      "    'src/App.tsx': 'export default 1;\\n',",
      "  });",
      "}",
      "  repo.write('src/App.tsx', 'export default 2;\\n');",
      "    repo.write(",
      "      'supabase/config.toml',",
      "      'project_id = \"abcdefghijklmnopqrst\"\\n',",
      "    );",
    ].join("\n");
    // What is left is a relative import INSIDE a fixture's content, resolved
    // against the spec's directory: a path no tree holds, which
    // `strandedSubjects` drops (it needs the file on both sides). Before this
    // rule the list also held `src/App.tsx` and `supabase/config.toml` — both
    // held on the clone, so the spec was held while its real subject, the
    // deploy workflow, crossed without it.
    expect(subjectsNamedBy(text, DEPLOY_SPEC)).toEqual([
      "src/lib/deploy/_shared/aml/partnerSurface.pure.ts",
    ]);
  });

  it("keeps a path the spec ALSO reads, whatever it writes there", () => {
    const text = [
      "fixtureRepo({ 'src/App.tsx': 'export default 1;\\n' });",
      "const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');",
    ].join("\n");
    expect(subjectsNamedBy(text, DEPLOY_SPEC)).toEqual(["src/App.tsx"]);
  });

  it("keeps a key whose value is one line: how a spec pins a real file", () => {
    // marketplaceHeroParity.spec.ts maps each file to its digest;
    // property-fields.test.ts maps each page to the columns it selects.
    const text = [
      "const PINNED = {",
      "  'supabase/functions/_shared/builderStock/marketplaceHero.pure.ts': 'e1322677e1ecebfa242d5d5e74c6d605fb3e40a8be337b35975cd0d7',",
      "  'src/lib/marketplaceHero.ts': '39d234b095b11bfbc8baf9599ebc5484dbcbd5772c6c7756593f4b6c',",
      "};",
      "const FIELDS = { 'src/pages/portal/PortalDashboard.tsx': ['id', 'address'] };",
    ].join("\n");
    expect(subjectsNamedBy(text, "src/lib/__tests__/marketplaceHeroParity.spec.ts")).toEqual([
      "src/lib/marketplaceHero.ts",
      "src/pages/portal/PortalDashboard.tsx",
      "supabase/functions/_shared/builderStock/marketplaceHero.pure.ts",
    ]);
  });

  it("keeps a golden map: multi-line values a spec compares REAL files against", () => {
    // The case the review of this change named. Nothing in prime has it yet;
    // the first cut of the rule would have dropped its subject.
    const text = [
      "const expected = { 'docs/a.md': '# A\\n', 'docs/b.md': '# B\\n' };",
      "for (const [file, body] of Object.entries(expected)) {",
      "  expect(readFileSync(join(ROOT, file), 'utf8')).toBe(body);",
      "}",
    ].join("\n");
    expect(subjectsNamedBy(text)).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("keeps a map handed to an assertion, which compares rather than builds", () => {
    const text = "expect(readDocs()).toEqual({ 'docs/a.md': '# A\\n' });";
    expect(subjectsNamedBy(text)).toEqual(["docs/a.md"]);
  });

  it("finds a key deep in a fixture literal, past braces and quotes inside its values", () => {
    const text = [
      "const repo = fixtureRepo({",
      "  'supabase/functions/a/index.ts': 'export const x = { a: \"}\" };\\n',",
      "  'supabase/functions/b/index.ts': `const y = ${'{'};\\n`,",
      "  'src/App.tsx': 'export default 1;\\n', // a } in a comment",
      "});",
    ].join("\n");
    expect(subjectsNamedBy(text)).toEqual([]);
  });

  it("never reads the branch of a ternary as a key", () => {
    const text = "const path = flag ? 'src/lib/a.ts' : 'export const a = 1;\\n';";
    expect(subjectsNamedBy(text)).toEqual(["src/lib/a.ts"]);
  });

  it("keeps a path a call writes TO the repository rather than one a fixture holds", () => {
    // Only `.write(path, …)` — a fixture's own method — names a fixture. A
    // stream's `.write(…)` carries no comma after the literal.
    expect(subjectsNamedBy("stream.write('src/lib/a.ts');")).toEqual(["src/lib/a.ts"]);
  });
});

describe("suppliesFixtureContent — the two positions, and nothing else", () => {
  const at = (text: string, literal: string) => {
    const start = text.indexOf(literal);
    return suppliesFixtureContent(text, start, start + literal.length);
  };

  it("is the first argument of .write(path, …)", () => {
    expect(at("fx.write('docs/guide.md', '# Guide\\n');", "'docs/guide.md'")).toBe(true);
  });

  it("is a key whose value holds a line break, in any quote, starting on the next line or not", () => {
    expect(at("tree({ 'a/b.ts': 'x\\n' })", "'a/b.ts'")).toBe(true);
    expect(at('tree({ "a/b.ts":\n    "x\\n" })', '"a/b.ts"')).toBe(true);
    expect(at("tree({ 'a/b.ts': `line one\nline two` })", "'a/b.ts'")).toBe(true);
    expect(at("tree({ 'a/b.ts': `project_id = \"${REF}\"\\n` })", "'a/b.ts'")).toBe(true);
  });

  it("is a key only in an object literal handed straight to a call", () => {
    expect(at("const files = { 'a/b.ts': 'x\\n' };", "'a/b.ts'")).toBe(false);
    expect(at("expect(x).toEqual({ 'a/b.ts': 'x\\n' })", "'a/b.ts'")).toBe(false);
    // A literal whose brace never closes (text cut short) holds nothing.
    expect(at("tree({ 'a/b.ts': 'x\\n'", "'a/b.ts'")).toBe(false);
  });

  it("is not a key whose value is one line, an array, or not a string", () => {
    expect(at("{ 'a/b.ts': 'digest' }", "'a/b.ts'")).toBe(false);
    expect(at("{ 'a/b.ts': ['x\\n'] }", "'a/b.ts'")).toBe(false);
    expect(at("{ 'a/b.ts': read('x') }", "'a/b.ts'")).toBe(false);
    expect(at("x ? 'a/b.ts' : 'y\\n'", "'a/b.ts'")).toBe(false);
  });

  it("is not a value the spec reads, however it is spelled", () => {
    expect(at("readFileSync('a/b.ts', 'utf8')", "'a/b.ts'")).toBe(false);
    expect(at("const P = 'a/b.ts';", "'a/b.ts'")).toBe(false);
  });
});
