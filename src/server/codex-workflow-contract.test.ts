// The dispatch payloads Mission Control sends must match the workflow files
// the target repos actually run.
//
// Two production failures motivated this file, both of which GitHub reports
// only at dispatch time, as an opaque rejection of the *entire* workflow:
//
//   Invalid Argument - failed to parse workflow: (Line: 50, Col: 24):
//   Unrecognized named-value: 'runner'.
//
//   maximum number of inputs for "workflow_dispatch" event is 10 but 12 are
//   provided.
//
// Nothing in typecheck, lint or the app's own tests can see either one: the
// contract lives half in a YAML file and half in a TypeScript object, and the
// two were free to drift. These tests read the real workflow files in
// .github/workflows and hold them to the same shape the dispatch code sends.
//
// The workflows here are the reference copies that get cloned into every
// managed repo, so a fault in them is a fault in the whole fleet.
import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it, vi } from "vitest";

const requests: { route: string; params: Record<string, unknown> }[] = [];
vi.mock("@/server/github-app.server", () => ({
  getAppOctokit: () => ({
    request: async (route: string, params: Record<string, unknown>) => {
      requests.push({ route, params });
      if (route.startsWith("GET")) return { data: { workflow_runs: [] } };
      return { data: {} };
    },
  }),
}));

/** GitHub rejects the whole file above this; it is not a soft limit. */
const MAX_DISPATCH_INPUTS = 10;

/**
 * Contexts unavailable in `jobs.<job_id>.env`. GitHub's context-availability
 * table allows only github, needs, strategy, matrix, vars, secrets and
 * inputs there — `runner` in particular is what broke the scan workflow.
 */
const JOB_ENV_FORBIDDEN = ["runner", "job", "steps", "env"];

type Workflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } };
  jobs?: Record<string, { env?: Record<string, unknown> }>;
};

function loadWorkflow(file: string): Workflow {
  const full = path.join(process.cwd(), ".github", "workflows", file);
  const doc = loadYaml(readFileSync(full, "utf8")) as Record<string, unknown>;
  // js-yaml 4 keeps `on` a string key under the YAML 1.2 core schema, but a
  // YAML 1.1 resolver turns bare `on` into boolean true (which lands as the
  // "true" property). Accept either so the parser version cannot quietly
  // empty out every assertion below.
  return { ...doc, on: doc.on ?? doc["true"] } as Workflow;
}

function declaredInputs(wf: Workflow): Record<string, { required?: boolean }> {
  return wf.on?.workflow_dispatch?.inputs ?? {};
}

/** Capture the `inputs` object of the dispatch POST a call produced. */
function dispatchedInputs(): Record<string, string> {
  const post = requests.find(({ route }) => route.includes("/dispatches"));
  if (!post) throw new Error("no workflow_dispatch request was made");
  return post.params.inputs as Record<string, string>;
}

const WORKFLOWS = ["codex-security-scan.yml", "codex-remediation.yml"] as const;

describe.each(WORKFLOWS)("%s", (file) => {
  const wf = loadWorkflow(file);

  it("declares workflow_dispatch inputs", () => {
    // Guards every assertion below: a parse change that silently produced an
    // empty object would make the rest of this file vacuously pass.
    expect(Object.keys(declaredInputs(wf)).length).toBeGreaterThan(0);
  });

  it(`stays within GitHub's ${MAX_DISPATCH_INPUTS}-input limit`, () => {
    expect(Object.keys(declaredInputs(wf)).length).toBeLessThanOrEqual(MAX_DISPATCH_INPUTS);
  });

  it("never reads a step-only context from job-level env", () => {
    for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
      for (const [key, value] of Object.entries(job.env ?? {})) {
        for (const context of JOB_ENV_FORBIDDEN) {
          expect(
            String(value),
            `jobs.${jobId}.env.${key} uses the "${context}" context, which does not exist ` +
              `at job level — GitHub rejects the whole workflow at dispatch time`,
          ).not.toMatch(new RegExp(`\\$\\{\\{\\s*${context}\\.`));
        }
      }
    }
  });
});

describe("scan dispatch payload", () => {
  it("sends exactly the inputs codex-security-scan.yml declares", async () => {
    requests.length = 0;
    const { dispatchCodexScan } = await import("@/server/codex-security-client.server");
    await dispatchCodexScan({
      owner: "acme",
      repo: "widgets",
      jobId: "job-1",
      kind: "full",
      ref: "main",
      callbackUrl: "https://mc.example/hook",
      callbackSecret: "s3cret",
    } as Parameters<typeof dispatchCodexScan>[0]);

    const declared = Object.keys(declaredInputs(loadWorkflow("codex-security-scan.yml"))).sort();
    expect(Object.keys(dispatchedInputs()).sort()).toEqual(declared);
  });
});

describe("remediation dispatch payload", () => {
  const finding = {
    id: "f-1",
    title: "SQL injection in report builder",
    severity: "critical",
    file: "src/reports.ts",
    line: 42,
    cwe: "CWE-89",
    description: "Concatenated user input into a query.",
    scanner: "semgrep",
    ruleId: "javascript.lang.security.audit.sqli",
    snippet: "db.query(`SELECT * FROM reports WHERE id = ${req.params.id}`)",
  };

  async function dispatch() {
    requests.length = 0;
    const { dispatchRemediationWorkflow } = await import("@/server/codex-remediation.server");
    await dispatchRemediationWorkflow({
      owner: "acme",
      repo: "widgets",
      remediationId: "r-1",
      baseRef: "main",
      branchName: "codex/fix-1",
      finding,
      callbackUrl: "https://mc.example/hook",
      callbackSecret: "s3cret",
    });
    return dispatchedInputs();
  }

  it("sends exactly the inputs codex-remediation.yml declares", async () => {
    const declared = Object.keys(declaredInputs(loadWorkflow("codex-remediation.yml"))).sort();
    expect(Object.keys(await dispatch()).sort()).toEqual(declared);
  });

  it("supplies every input the workflow marks required", async () => {
    const sent = await dispatch();
    const required = Object.entries(declaredInputs(loadWorkflow("codex-remediation.yml")))
      .filter(([, spec]) => spec?.required)
      .map(([name]) => name);
    for (const name of required) {
      expect(sent[name], `required input "${name}" was not dispatched`).toBeTruthy();
    }
  });

  it("packs the finding into one JSON input the workflow can parse", async () => {
    const sent = await dispatch();
    expect(JSON.parse(sent.finding)).toEqual({
      id: "f-1",
      title: "SQL injection in report builder",
      severity: "critical",
      file: "src/reports.ts",
      line: "42",
      cwe: "CWE-89",
      description: "Concatenated user input into a query.",
      // Provenance and the offending source travel as their own fields:
      // a title and a line number alone make for weak patches.
      scanner: "semgrep",
      ruleId: "javascript.lang.security.audit.sqli",
      snippet: "db.query(`SELECT * FROM reports WHERE id = ${req.params.id}`)",
      // No engine named: Codex, which an older workflow also falls back to.
      engine: "codex",
    });
  });

  it("gives the workflow's renderer every field it reads", async () => {
    // The render step clamps a fixed field list; anything the dispatcher
    // sends that it does not know about is silently dropped on the floor.
    const rendered = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "codex-remediation.yml"),
      "utf8",
    );
    for (const field of Object.keys(JSON.parse((await dispatch()).finding))) {
      expect(rendered, `render step ignores finding.${field}`).toContain(`${field}:`);
    }
  });
});

describe("buildFindingInput", () => {
  it("clamps title and description to keep the dispatch within GitHub's limits", async () => {
    const { buildFindingInput } = await import("@/server/codex-remediation.server");
    const packed = JSON.parse(
      buildFindingInput({
        id: "f-2",
        title: "t".repeat(500),
        severity: "low",
        description: "d".repeat(9000),
      }),
    );
    expect(packed.title).toHaveLength(200);
    expect(packed.description).toHaveLength(4000);
  });

  it("renders absent optional fields as empty strings, never null or undefined", async () => {
    const { buildFindingInput } = await import("@/server/codex-remediation.server");
    // The workflow reads these straight into a prompt and a PR body; the
    // string "null" leaking into either is a visible defect.
    const packed = JSON.parse(
      buildFindingInput({ id: "f-3", title: "No location", severity: "medium" }),
    );
    expect(packed).toMatchObject({ file: "", line: "", cwe: "", description: "" });
  });
});
