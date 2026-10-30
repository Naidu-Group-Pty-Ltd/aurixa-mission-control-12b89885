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
//     including the ones running code the model had just written;
//   - with fixes merging unattended, the checks ran the model's code as the
//     job's own user, beside files holding the callback key, and on the
//     agent's working copy rather than the tree that is committed.
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
  const doc = loadYaml(text) as { jobs: Record<string, Job>; permissions?: Record<string, string> };
  const job = Object.values(doc.jobs)[0];
  return { text, job, steps: job.steps ?? [], permissions: doc.permissions ?? {} };
}

/** A step's shell commands, with heredoc bodies (prompt text, inline scripts) removed. */
function commands(step: Step | undefined): string {
  return (step?.run ?? "").replace(/<<'(\w+)'[\s\S]*?\n\1(\n|$)/g, "");
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

  it("scans only the lines the patch adds for secrets, and for this run's callback key", () => {
    expect(REMEDIATION.text).toContain('"$RUNNER_TEMP/gitleaks" stdin');
    expect(REMEDIATION.text).toContain('grep -qF -f "$HELPER_DIR/callback.key"');
  });

  it("refuses CI changes (codex-remediation-guards.contract.test.ts runs the guards)", () => {
    const measure = REMEDIATION.steps.find((s) => s.name === "Measure the patch")?.run ?? "";
    expect(measure).toContain("/^\\.github\\//.test(p)");
  });

  it("gives the Anthropic key to the Claude step only", () => {
    expect(stepsReferencing(REMEDIATION.steps, /secrets\.ANTHROPIC_API_KEY/)).toEqual([
      "Author the fix with Claude",
    ]);
  });

  it("runs nothing but Claude Code beside the Anthropic key, restricted to file tools", () => {
    const claude = commands(REMEDIATION.steps.find((s) => s.name === "Author the fix with Claude"));
    expect(claude).toContain("claude -p");
    for (const flag of [
      "--bare",
      "--restricted",
      '--tools "Read,Glob,Grep,Edit,Write"',
      "--permission-mode acceptEdits",
      "--permission-prompts none",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-budget-usd",
    ]) {
      expect(claude, flag).toContain(flag);
    }
    expect(claude).not.toMatch(/Bash|WebFetch|bypassPermissions|dangerously/);
    expect(claude).not.toMatch(/(^|[;&|(]\s*)(git|node|npm|npx)\s/m);
  });

  it("installs both agents pinned, before any key is in reach", () => {
    const install = REMEDIATION.steps.find((s) => s.name === "Install the fix agent");
    expect(JSON.stringify(install?.env ?? {})).not.toContain("secrets.");
    expect(REMEDIATION.job.env?.CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(install?.run).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
    expect(install?.run).toContain('"@openai/codex@${CODEX_CLI_VERSION}"');
    const agents = ["Author the fix with Codex", "Author the fix with Claude"];
    for (const name of agents) {
      expect(commands(REMEDIATION.steps.find((s) => s.name === name))).not.toMatch(/npm install/);
    }
  });

  it("keeps the job's own files from every other user", () => {
    expect(REMEDIATION.steps[0]?.run).toContain('chmod 700 "$RUNNER_TEMP"');
    expect(REMEDIATION.steps[0]?.run).toContain('chmod o-rwx "$HOME"');
  });

  it("stages the patch in a copy of .git taken before the agent ran", () => {
    for (const name of ["Collect the fix", "Measure the patch"]) {
      const run = REMEDIATION.steps.find((s) => s.name === name)?.run ?? "";
      expect(run, name).toContain('--git-dir="$RUNNER_TEMP/collect.git"');
    }
    const record = REMEDIATION.steps.find((s) => s.name === "Record the base commit")?.run ?? "";
    expect(record).toContain('cp -a .git "$RUNNER_TEMP/collect.git"');
  });

  it("checks the committed tree, as a user of its own, and kills what the checks leave", () => {
    const verify = REMEDIATION.steps.find((s) => s.name === "Verify the patched tree")?.run ?? "";
    expect(verify).toContain('cp -a "$RUNNER_TEMP/base-tree" "$VERIFY_DIR"');
    expect(verify).toContain('apply --binary "$RUNNER_TEMP/fix.patch"');
    expect(verify).toContain("sudo -u fixcheck -H env -i");
    expect(verify).toContain("sudo pkill -KILL -u fixcheck");
    // A hosted runner's tool cache is world-writable: closed before the checks run.
    expect(verify).toContain('for d in "${RUNNER_TOOL_CACHE:-}" "${PATH_DIRS[@]}"; do');
    expect(verify.indexOf("chmod -R go-w")).toBeLessThan(verify.indexOf("sudo -u fixcheck"));
    // The lockfile is the one CI installs from: no silent re-resolve.
    expect(verify).toContain('locked ? "npm ci --no-audit --no-fund"');
  });

  it("pushes only a fix that passed its checks", () => {
    const push = REMEDIATION.steps.find((s) => s.name === "Commit and push") as Step & {
      if?: string;
    };
    expect(push.if).toContain("steps.verify.outputs.ok == 'true'");
  });

  it("regenerates lockfiles without running any package's install script", () => {
    const lock = REMEDIATION.steps.find((s) => s.name === "Regenerate lockfiles")?.run ?? "";
    expect(lock).toContain("npm install --package-lock-only --ignore-scripts");
    expect(lock).toContain("install --lockfile-only --ignore-scripts");
    // bun from a prefix of its own: `npx bun` would run one the checkout provides.
    expect(lock).toContain('env -C "$RUNNER_TEMP" npm install --prefix "$RUNNER_TEMP/bun"');
    // bun's lockfile is rebuilt from npm's, so both hold one copy of each package.
    expect(lock).toContain("if [ -f package-lock.json ]; then rm -f bun.lockb bun.lock; fi");
    const code = lock
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/\bnpx\b/);
    expect(REMEDIATION.job.env?.BUN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names the repository's CI for Mission Control and cannot start a workflow itself", () => {
    expect(REMEDIATION.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(REMEDIATION.text).not.toMatch(/gh workflow run|actions\/workflows/);
    const notify = REMEDIATION.steps.find((s) => s.name === "Notify PR opened")?.run ?? "";
    expect(notify).toContain('verification.ci = read("ci.json"');
  });

  it("only ever pushes a codex/fix- or live-audit/fix- branch", () => {
    // Version 5 fixes live-audit defects too, on their own prefix; what each
    // prefix may carry is held by live-audit-remediation.contract.test.ts.
    expect(REMEDIATION.steps[0]?.run).toContain("'^(codex|live-audit)/fix-[A-Za-z0-9._-]{1,180}$'");
  });

  it("reports the head commit it pushed", () => {
    expect(REMEDIATION.text).toContain("head_sha: process.env.HEAD_SHA");
  });
});
