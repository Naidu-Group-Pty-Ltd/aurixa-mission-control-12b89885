import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  isWorkflowPath,
  judgesTheTree,
  judgingWorkflowHold,
  workflowTriggers,
} from "./judgingWorkflow.pure";

/*
  The `on:` blocks below are VERBATIM from the prime's own workflows, read on
  9 Sep 2026. A hand-simplified fixture would agree with a hand-simplified
  parser and tell us nothing — the shapes that matter here (a `paths:` list one
  level deeper than a trigger, a comment between two triggers, `workflow_dispatch`
  carrying an `inputs:` map) are exactly the ones a tidy example leaves out.
*/

const CI_YML = `name: CI

# Verification gate for the Template Builder rehaul (and the repo generally).

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
`;

const PDF_IMPORT_REGRESSION = `name: PDF import regression

on:
  pull_request:
    paths:
      - 'src/lib/reportTemplate/**'
      - 'docs/pdf-import/**'
      - 'package.json'
      - '.github/workflows/pdf-import-regression.yml'
  workflow_dispatch:

jobs:
  regression:
    runs-on: ubuntu-latest
`;

const PDF_EXTRACTION_V3 = `name: PDF extraction v3 gates

on:
  pull_request:
    paths:
      - 'src/lib/reportTemplate/ingestion/releaseV3/**'
      - '.github/workflows/pdf-extraction-v3-gates.yml'
  push:
    branches: [main]
    paths:
      - 'tests-e2e/pdf-extraction-v3/**'
  schedule:
    - cron: '0 15 * * *' # nightly (UTC)
  workflow_dispatch:

jobs:
  gates:
    runs-on: ubuntu-latest
`;

const AML_SANCTIONS_REFRESH = `name: AML sanctions refresh

on:
  schedule:
    # 18:10 UTC daily ≈ 04:10 next-day Australia/Sydney (AEST/AEDT), i.e.
    # overnight local time, after the publishers' usual update windows.
    - cron: '10 18 * * *'
  workflow_dispatch:
    inputs:
      lists:
        description: 'Comma-separated lists to load'
        required: false
        default: 'un,ofac,dfat'
      dry_run:
        description: 'Parse and report without writing'
        type: boolean

jobs:
  load:
    runs-on: ubuntu-latest
`;

const APPLY_MIGRATION = `name: Apply migration

on:
  workflow_dispatch:
    inputs:
      file:
        description: 'Migration file path, relative to the repo root'
        required: true
        type: string
      record_version:
        description: 'Record the file version in schema_migrations when it succeeds'
        required: false
        type: boolean
        default: true

jobs:
  apply:
    runs-on: ubuntu-latest
`;

describe("reading a workflow's triggers", () => {
  it("reads the block form, and does not mistake a trigger's own keys for triggers", () => {
    // `paths:` sits one level under `pull_request:`. A parser that took every
    // indented key would call this workflow's triggers "pull_request, paths,
    // workflow_dispatch" — harmless here, and wrong the moment somebody writes
    // a workflow whose config key happens to be `push`.
    expect(workflowTriggers(PDF_IMPORT_REGRESSION)).toEqual(["pull_request", "workflow_dispatch"]);
  });

  it("reads a block with a comment inside it", () => {
    expect(workflowTriggers(AML_SANCTIONS_REFRESH)).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("reads all four of a workflow that carries every kind", () => {
    expect(workflowTriggers(PDF_EXTRACTION_V3)).toEqual([
      "pull_request",
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
  });

  it("stops at the next top-level key", () => {
    expect(workflowTriggers(CI_YML)).toEqual(["pull_request", "push"]);
  });

  it("reads the inline scalar and flow-sequence forms", () => {
    expect(workflowTriggers("name: x\non: push\njobs:\n  a:\n")).toEqual(["push"]);
    expect(workflowTriggers("on: [push, pull_request]\njobs:\n")).toEqual([
      "push",
      "pull_request",
    ]);
  });

  it("reads the quoted key, because YAML 1.1 makes a bare `on` the boolean true", () => {
    // Several linters require the quotes, and a workflow spelled that way is
    // still a judge. Reading it as "no triggers" would let prime's CI through
    // to a partial tree on a formatting choice.
    expect(workflowTriggers(`"on":\n  pull_request:\n`)).toEqual(["pull_request"]);
    expect(workflowTriggers(`'on':\n  - push\n`)).toEqual(["push"]);
  });

  it("returns nothing for a file with no `on:` block", () => {
    expect(workflowTriggers("name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n")).toEqual([]);
  });
});

describe("which workflows judge the tree", () => {
  it("the four that run on a pull request or a push do", () => {
    expect(judgesTheTree(CI_YML)).toBe(true);
    expect(judgesTheTree(PDF_IMPORT_REGRESSION)).toBe(true);
    expect(judgesTheTree(PDF_EXTRACTION_V3)).toBe(true);
  });

  it("a scheduled loader and a dispatch-only operation do not", () => {
    // These are the eleven that keep cascading. They read `scripts/**` and
    // `package.json`, both repository invariants, and neither can appear as a
    // check on a pull request however incomplete the clone's tree is.
    expect(judgesTheTree(AML_SANCTIONS_REFRESH)).toBe(false);
    expect(judgesTheTree(APPLY_MIGRATION)).toBe(false);
  });
});

describe("the hold", () => {
  const held = (path: string, primeContent: string, scope: "mirror" | "modules") =>
    judgingWorkflowHold({ path, primeContent, scope });

  it("holds prime's CI from a module-scoped clone, and names why in the pull request", () => {
    const hold = held(".github/workflows/ci.yml", CI_YML, "modules");
    expect(hold).not.toBeNull();
    expect(hold!.reason).toBe("manual_reconcile");
    // `manual_reconcile` is withheld AND reported. `protected` would be a claim
    // that the clone owns this file, which it does not — it is a file nobody
    // may send it whole.
    expect(hold!.note).toContain("pull_request");
    expect(hold!.note).toContain("push");
  });

  it("never holds anything from a mirror", () => {
    // A mirror receives the whole tree, so its judge always has its tree. A
    // hold here would freeze that clone's CI at whatever it forked with, which
    // is the failure this module exists to prevent.
    expect(held(".github/workflows/ci.yml", CI_YML, "mirror")).toBeNull();
    expect(held(".github/workflows/pdf-import-regression.yml", PDF_IMPORT_REGRESSION, "mirror"))
      .toBeNull();
  });

  it("lets the scheduled and dispatch-only workflows through to a module clone", () => {
    expect(held(".github/workflows/aml-sanctions-refresh.yml", AML_SANCTIONS_REFRESH, "modules"))
      .toBeNull();
    expect(held(".github/workflows/apply-migration.yml", APPLY_MIGRATION, "modules")).toBeNull();
  });

  it("has no opinion about a path that is not a workflow", () => {
    // The engine calls this on every candidate path. A YAML file elsewhere in
    // the tree, or a source file that happens to contain the word `on:`, must
    // pass straight through.
    expect(held("src/App.tsx", "const on = { push: true };", "modules")).toBeNull();
    expect(held("supabase/config.toml", "on:\n  push:\n", "modules")).toBeNull();
    expect(held(".github/dependabot.yml", "on:\n  push:\n", "modules")).toBeNull();
  });

  it("recognises both YAML extensions", () => {
    expect(isWorkflowPath(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowPath(".github/workflows/ci.yaml")).toBe(true);
    expect(isWorkflowPath(".github/workflows/README.md")).toBe(false);
    expect(isWorkflowPath("docs/workflows/ci.yml")).toBe(false);
  });
});

describe("the engine actually asks", () => {
  it("calls the hold on the module-scope path, beside the backend identity hold", () => {
    // A pure module nothing calls is a rule that does not exist. This is the
    // same contract test `importClosure` carries, for the same reason: both
    // are decided inside one long function whose ordering is the whole safety
    // argument, and a unit test of the module alone cannot see whether it was
    // wired in.
    const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
    expect(engine).toContain("judgingWorkflowHold");
    expect(engine).toContain("backendIdentityHold");
  });
});
