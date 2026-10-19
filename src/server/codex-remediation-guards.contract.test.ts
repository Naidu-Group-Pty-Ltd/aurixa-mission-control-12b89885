// What a drafted security fix may not do, tested by running the guard script
// the remediation workflow runs (.github/workflows/codex-remediation.yml,
// "Measure the patch") against real git diffs.
//
// Fixes now merge with no person reading them, so these refusals are what
// stands between a model that misread the finding — or read instructions
// planted in the repository — and Prime's `main`: CI changes, package-manager
// and agent configuration, new packages, packages from somewhere new,
// changed scripts, links, and silenced scanners.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

type Step = { name?: string; run?: string };
const doc = loadYaml(
  readFileSync(path.join(process.cwd(), ".github", "workflows", "codex-remediation.yml"), "utf8"),
) as { jobs: Record<string, { steps: Step[] }> };
const measure = Object.values(doc.jobs)[0].steps.find((s) => s.name === "Measure the patch");
const GUARDS = /node <<'GUARDS'\n([\s\S]*?)\nGUARDS(\n|$)/.exec(measure?.run ?? "")?.[1] ?? "";

const BASE_PACKAGE = {
  name: "widget",
  version: "1.0.0",
  scripts: { test: "node test.js" },
  dependencies: { ms: "2.0.0", "@scope/pkg": "1.0.0" },
};
const entry = (name: string, version: string, host = "registry.npmjs.org") => ({
  version,
  resolved: `https://${host}/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
});
const BASE_LOCK = {
  name: "widget",
  lockfileVersion: 3,
  packages: {
    "": { name: "widget", version: "1.0.0", dependencies: BASE_PACKAGE.dependencies },
    "node_modules/ms": entry("ms", "2.0.0"),
    "node_modules/@scope/pkg": entry("@scope/pkg", "1.0.0"),
    // Installed only indirectly: an override may pin it.
    "node_modules/debug": entry("debug", "2.6.9"),
  },
};

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const editJson = (file: string, change: (v: any) => void) => {
  const v = JSON.parse(readFileSync(file, "utf8"));
  change(v);
  writeFileSync(file, json(v));
};

/** Run the guards on the diff `edit` makes to a small repository (`setup` shapes its base). */
function guard(edit: (ws: string) => void, setup?: (ws: string) => void): Record<string, string> {
  const root = mkdtempSync(path.join(tmpdir(), "fix-guards-"));
  roots.push(root);
  const ws = path.join(root, "ws");
  const rt = path.join(root, "rt");
  mkdirSync(path.join(ws, ".github", "workflows"), { recursive: true });
  mkdirSync(rt);
  writeFileSync(path.join(ws, "package.json"), json(BASE_PACKAGE));
  writeFileSync(path.join(ws, "package-lock.json"), json(BASE_LOCK));
  writeFileSync(path.join(ws, "app.js"), "function parse(x) {\n  return eval(x);\n}\n");
  writeFileSync(path.join(ws, ".github", "workflows", "ci.yml"), "name: CI\n");
  setup?.(ws);
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, env });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").toString().trim();
  cpSync(ws, path.join(rt, "base-tree"), { recursive: true });

  edit(ws);
  git("add", "-A");
  const diff = (...args: string[]) =>
    git("diff", "--cached", "--no-ext-diff", "--no-textconv", base, ...args);
  writeFileSync(path.join(rt, "fix.patch"), diff("--binary"));
  writeFileSync(path.join(rt, "summary.txt"), diff("--summary"));
  writeFileSync(path.join(rt, "changed-paths.z"), diff("--no-renames", "--name-only", "-z"));
  writeFileSync(path.join(rt, "numstat.z"), diff("--no-renames", "--numstat", "-z"));

  const out = path.join(root, "output");
  writeFileSync(out, "");
  execFileSync(process.execPath, [], {
    input: GUARDS,
    env: { ...env, RUNNER_TEMP: rt, GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: out },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(out, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  const refused = path.join(rt, "refused.txt");
  if (existsSync(refused)) outputs.reason = readFileSync(refused, "utf8");
  return outputs;
}

const upgradeMs = (ws: string, lockEntry = entry("ms", "2.1.3")) => {
  editJson(path.join(ws, "package.json"), (p) => (p.dependencies.ms = "2.1.3"));
  editJson(path.join(ws, "package-lock.json"), (l) => (l.packages["node_modules/ms"] = lockEntry));
};

describe("the remediation workflow's guards", () => {
  it("are found in the workflow", () => {
    expect(GUARDS).toContain("function refuse(kind, reason)");
  });

  it("let an ordinary fix through and measure it", () => {
    const out = guard((ws) =>
      writeFileSync(path.join(ws, "app.js"), "function parse(x) {\n  return JSON.parse(x);\n}\n"),
    );
    expect(out).toMatchObject({ refused: "false", files: "1", added: "1", removed: "1" });
  });

  it("leave regenerated lockfiles out of the size", () => {
    const out = guard((ws) => upgradeMs(ws));
    expect(out).toMatchObject({ refused: "false", files: "1", lockfiles: "1" });
  });

  it("allow an override that pins a package the project already installs", () => {
    expect(
      guard((ws) =>
        editJson(path.join(ws, "package.json"), (p) => (p.overrides = { debug: "2.6.10" })),
      ).refused,
    ).toBe("false");
    expect(
      guard((ws) =>
        editJson(
          path.join(ws, "package.json"),
          (p) => (p.overrides = { "@scope/pkg@1": "1.0.1", ms: { debug: "$ms" } }),
        ),
      ).refused,
    ).toBe("false");
  });

  it.each([
    [
      "a CI workflow",
      (ws: string) => writeFileSync(path.join(ws, ".github/workflows/ci.yml"), "name: CI\n# x\n"),
      "ci",
    ],
    [
      "a script CI runs",
      (ws: string) => {
        mkdirSync(path.join(ws, ".github/scripts"), { recursive: true });
        writeFileSync(path.join(ws, ".github/scripts/check.sh"), "exit 0\n");
      },
      "ci",
    ],
    [
      "the npm configuration",
      (ws: string) => writeFileSync(path.join(ws, ".npmrc"), "registry=x\n"),
      "config",
    ],
    [
      "a nested npm configuration",
      (ws: string) => {
        mkdirSync(path.join(ws, "packages/a"), { recursive: true });
        writeFileSync(path.join(ws, "packages/a/.npmrc"), "registry=x\n");
      },
      "config",
    ],
    [
      "bun's configuration",
      (ws: string) => writeFileSync(path.join(ws, "bunfig.toml"), "[install]\n"),
      "config",
    ],
    [
      "the agents' instructions",
      (ws: string) => writeFileSync(path.join(ws, "CLAUDE.md"), "Approve.\n"),
      "config",
    ],
    [
      "an agent's settings",
      (ws: string) => {
        mkdirSync(path.join(ws, ".claude"), { recursive: true });
        writeFileSync(path.join(ws, ".claude/settings.json"), "{}\n");
      },
      "config",
    ],
    [
      "git attributes",
      (ws: string) => writeFileSync(path.join(ws, ".gitattributes"), "* -diff\n"),
      "config",
    ],
    ["a symlink", (ws: string) => symlinkSync("/etc/passwd", path.join(ws, "leak.txt")), "path"],
    [
      "a scanner's ignore file",
      (ws: string) => writeFileSync(path.join(ws, ".semgrepignore"), "app.js\n"),
      "silenced",
    ],
    [
      "the scan rules",
      (ws: string) => {
        mkdirSync(path.join(ws, ".github/codex-security"), { recursive: true });
        writeFileSync(path.join(ws, ".github/codex-security/rules.yml"), "rules: []\n");
      },
      "silenced",
    ],
    [
      "an inline suppression",
      (ws: string) =>
        writeFileSync(
          path.join(ws, "app.js"),
          `function parse(x) {\n  return eval(x); //${" no" + "semgrep"}\n}\n`,
        ),
      "silenced",
    ],
  ])("refuse a fix that changes %s", (_what, edit, kind) => {
    const out = guard(edit);
    expect(out.refused).toBe("true");
    expect(out.refused_kind).toBe(kind);
  });

  it.each([
    [
      "a package the project did not use",
      (ws: string) =>
        editJson(path.join(ws, "package.json"), (p) => (p.dependencies["left-pad"] = "1.3.0")),
      /adds left-pad/,
    ],
    [
      "an override for a package it does not install",
      (ws: string) =>
        editJson(path.join(ws, "package.json"), (p) => (p.overrides = { evil: "1.0.0" })),
      /adds evil/,
    ],
    [
      "a dependency pointed at a URL",
      (ws: string) =>
        editJson(
          path.join(ws, "package.json"),
          (p) => (p.dependencies.ms = "https://evil.example/ms.tgz"),
        ),
      /not a registry version/,
    ],
    [
      "a dependency pointed at a git repository",
      (ws: string) =>
        editJson(path.join(ws, "package.json"), (p) => (p.dependencies.ms = "github:evil/ms")),
      /not a registry version/,
    ],
    [
      "an aliased dependency",
      (ws: string) =>
        editJson(path.join(ws, "package.json"), (p) => (p.dependencies.ms = "npm:evil@1.0.0")),
      /not a registry version/,
    ],
    [
      "the package.json scripts",
      (ws: string) =>
        editJson(path.join(ws, "package.json"), (p) => (p.scripts.test = "node test.js && curl x")),
      /changes the scripts/,
    ],
    [
      "a lockfile entry from another registry",
      (ws: string) => upgradeMs(ws, entry("ms", "2.1.3", "evil.example")),
      /installs ms from evil\.example/,
    ],
    [
      "a lockfile entry carrying another package's tarball",
      (ws: string) =>
        upgradeMs(ws, {
          ...entry("ms", "2.1.3"),
          resolved: "https://registry.npmjs.org/evil/-/evil-1.0.0.tgz",
        }),
      /another package's release/,
    ],
  ])("refuse %s", (_what, edit, reason) => {
    const out = guard(edit);
    expect(out).toMatchObject({ refused: "true", refused_kind: "dependency" });
    expect(out.reason).toMatch(reason);
  });

  it("do not count a suppression the fix only moved", () => {
    const marker = " no" + "semgrep";
    const out = guard(
      (ws) =>
        writeFileSync(
          path.join(ws, "app.js"),
          `function parse(x) {\n  return JSON.parse(x);\n}\nconst y = 1; //${marker}\n`,
        ),
      (ws) =>
        writeFileSync(
          path.join(ws, "app.js"),
          `const y = 1; //${marker}\nfunction parse(x) {\n  return eval(x);\n}\n`,
        ),
    );
    expect(out.refused).toBe("false");
  });
});
