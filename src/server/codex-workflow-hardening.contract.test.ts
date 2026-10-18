// What the two Codex workflows must never do again, read from the files the
// fleet actually runs (.github/workflows — the reference copies Prime carries
// to every clone).
//
// Each rule is a failure that happened or was one step away:
//   - the callback secret sat in job `env:`, which GitHub prints in every
//     step's log header — every fleet repository's logs held the fleet's key;
//   - `@openai/codex@latest`, unpinned semgrep and unverified gitleaks /
//     osv-scanner downloads meant a clean result could change with no code
//     change, or a compromised release ran with a repository token;
//   - the OpenAI key and a push-capable token were visible to every step,
//     including the ones running code the model had just written.
import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  CODEX_REMEDIATION_WORKFLOW_VERSION,
  CODEX_SCAN_WORKFLOW_VERSION,
  declaredWorkflowVersion,
} from "@/lib/codex-workflow-contract";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
type Job = { env?: Record<string, unknown>; steps?: Step[] };

function read(file: string) {
  const text = readFileSync(path.join(process.cwd(), ".github", "workflows", file), "utf8");
  const doc = loadYaml(text) as { jobs: Record<string, Job> };
  const job = Object.values(doc.jobs)[0];
  return { text, job, steps: job.steps ?? [] };
}

const SCAN = read("codex-security-scan.yml");
const REMEDIATION = read("codex-remediation.yml");

describe.each([
  ["codex-security-scan.yml", SCAN, CODEX_SCAN_WORKFLOW_VERSION],
  ["codex-remediation.yml", REMEDIATION, CODEX_REMEDIATION_WORKFLOW_VERSION],
] as const)("%s", (_file, wf, version) => {
  it("declares the workflow version Mission Control expects", () => {
    expect(declaredWorkflowVersion(wf.text)).toBe(version);
    expect(wf.job.env?.WORKFLOW_VERSION).toBe(String(version));
  });

  it("never puts the callback key in an environment block or a script", () => {
    expect(wf.text).not.toMatch(/\$\{\{\s*inputs\.callback_secret\s*\}\}/);
    for (const key of Object.keys(wf.job.env ?? {})) expect(key).not.toMatch(/SECRET|CALLBACK_KEY/);
    for (const step of wf.steps) {
      for (const key of Object.keys(step.env ?? {})) expect(key).not.toMatch(/CALLBACK_SECRET/);
    }
  });

  it("reads the key from the event payload and masks it before anything else runs", () => {
    const first = wf.steps[0]?.run ?? "";
    expect(first).toContain("GITHUB_EVENT_PATH");
    expect(first).toContain("::add-mask::");
    expect(first).toMatch(/mode: 0o600/);
  });

  it("signs a timestamp with every callback", () => {
    expect(wf.text).toContain('"x-codex-timestamp": String(ts)');
    expect(wf.text).toContain("update(`${ts}.${body}`)");
  });

  it("pins every action to a commit", () => {
    const uses = wf.steps.map((s) => s.uses).filter(Boolean) as string[];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("keeps no token in the checkout", () => {
    const checkout = wf.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("evaluates no expression inside a script, where it would be spliced into shell", () => {
    for (const step of wf.steps) expect(step.run ?? "", step.name).not.toContain("${{");
  });

  it("verifies downloaded scanners and pins installed ones", () => {
    expect(wf.job.env?.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(wf.text).toContain('${GITLEAKS_SHA256}  $RUNNER_TEMP/gitleaks.tgz" | sha256sum -c');
    expect(wf.job.env?.CODEX_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(wf.text).toContain('"@openai/codex@${CODEX_CLI_VERSION}"');
    expect(wf.text).not.toMatch(/@latest\b/);
  });
});

function stepsReferencing(steps: Step[], pattern: RegExp): string[] {
  return steps
    .filter((s) => Object.values(s.env ?? {}).some((v) => pattern.test(String(v))))
    .map((s) => s.name ?? s.uses ?? "?");
}

describe("the scan workflow", () => {
  it("gives the OpenAI key to the Codex step and nothing else", () => {
    expect(stepsReferencing(SCAN.steps, /secrets\.OPENAI_API_KEY/)).toEqual([
      "Codex CLI — reasoning pass",
    ]);
    expect(JSON.stringify(SCAN.job.env)).not.toContain("secrets.");
  });

  it("runs the AI review read-only, answering through a schema", () => {
    const codex = SCAN.steps.find((s) => s.name === "Codex CLI — reasoning pass")?.run ?? "";
    expect(codex).toContain("--sandbox read-only");
    expect(codex).toContain("--output-schema");
    expect(codex).toContain("--output-last-message");
  });

  it("verifies osv-scanner and pins semgrep", () => {
    expect(SCAN.job.env?.OSV_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(SCAN.text).toContain('${OSV_SHA256}  $OSV" | sha256sum -c');
    expect(SCAN.job.env?.SEMGREP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCAN.text).toContain('"semgrep==${SEMGREP_VERSION}"');
  });

  it("has every scanner record its own outcome", () => {
    for (const name of ["gitleaks", "semgrep", "osv-scanner", "codex"]) {
      expect(SCAN.text).toContain(`write_status ${name} ok`);
      expect(SCAN.text).toMatch(new RegExp(`write_status ${name} (failed|skipped)`));
    }
  });

  it("maps osv-scanner's exit codes instead of ignoring them", () => {
    const osv = SCAN.steps.find((s) => s.name?.startsWith("osv-scanner"))?.run ?? "";
    expect(osv).toContain("0|1) write_status osv-scanner ok");
    expect(osv).toContain(
      '129) write_status osv-scanner failed "the OSV API could not be reached"',
    );
  });

  it("counts undelivered report batches into the final call", () => {
    expect(SCAN.text).toContain("callback_failures: failures");
    expect(SCAN.text).toContain("batch: { index: i, count: batches.length }");
  });
});

describe("the remediation workflow", () => {
  it("gives the OpenAI key to the Codex step only", () => {
    expect(
      stepsReferencing(REMEDIATION.steps, /secrets\.(OPENAI_API_KEY|CODEX_SECURITY_API_KEY)/),
    ).toEqual(["Author the fix with Codex"]);
    expect(JSON.stringify(REMEDIATION.job.env)).not.toContain("secrets.");
  });

  it("gives the repository token only to the steps that push and open the PR", () => {
    expect(stepsReferencing(REMEDIATION.steps, /secrets\.GITHUB_TOKEN/).sort()).toEqual([
      "Commit and push",
      "Open draft PR",
    ]);
  });

  it("runs nothing but Codex beside the OpenAI key", () => {
    const codex = REMEDIATION.steps.find((s) => s.name === "Author the fix with Codex")?.run ?? "";
    // Heredoc bodies are prompt text, not commands.
    const commands = codex.replace(/<<'(\w+)'[\s\S]*?\n\1(\n|$)/g, "");
    expect(commands).toContain("codex exec");
    expect(commands).not.toMatch(/(^|[;&|(]\s*)git\s/m);
  });

  it("builds the pushed commit from the patch file in a repository of its own", () => {
    const push = REMEDIATION.steps.find((s) => s.name === "Commit and push")?.run ?? "";
    expect(push).toContain('git init -q "$PUSH_DIR"');
    expect(push).toContain("git apply --cached --binary");
    expect(push).toContain("core.hooksPath=/dev/null");
    expect(push).not.toMatch(/--force|\s-f\s/);
  });

  it("scans only the lines the patch adds for secrets, and refuses CI changes", () => {
    expect(REMEDIATION.text).toContain('"$RUNNER_TEMP/gitleaks" stdin');
    expect(REMEDIATION.text).toContain("grep -Eq '^\\.github/workflows/'");
  });

  it("only ever pushes a codex/fix- branch", () => {
    expect(REMEDIATION.steps[0]?.run).toContain("'^codex/fix-[A-Za-z0-9._-]{1,180}$'");
  });

  it("reports the head commit it pushed", () => {
    expect(REMEDIATION.text).toContain("head_sha: process.env.HEAD_SHA");
  });
});
