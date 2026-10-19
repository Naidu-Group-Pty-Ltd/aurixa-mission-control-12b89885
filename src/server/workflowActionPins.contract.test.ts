// Every action every workflow runs: pinned to a commit, the same commit in
// every file, and a release that runs on Node 24 — on a runner image pinned
// the same way.
//
// GitHub warned on every run that the old pins (checkout v4.3.1, setup-node
// v4.4.0, upload-artifact v4.6.2) target Node 20, which the runners are
// retiring. The table below is what was checked by hand on 19 Oct 2026, by
// reading `runs.using` in each commit's own action.yml: all three say `node24`.
// Bumping a pin means checking the new commit the same way and changing the
// table with it — this test refuses a pin nobody recorded.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const NODE24_PINS: Record<string, { sha: string; version: string }> = {
  "actions/checkout": { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  "actions/setup-node": { sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", version: "v7.1.0" },
  "actions/upload-artifact": {
    sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    version: "v7.0.2",
  },
};

type Step = { uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = {
  "runs-on"?: unknown;
  permissions?: unknown;
  steps?: Step[];
  env?: Record<string, unknown>;
};

/**
 * The runner image every job was verified on. `ubuntu-latest` moves to
 * Ubuntu 26 from 19 Oct 2026; the fix workflow alone depends on `sudo`,
 * `useradd`, `setfacl` and the tool cache's layout, so the image moves when a
 * person moves it, after a test run — not when GitHub relabels it.
 */
const RUNNER = "ubuntu-24.04";

const DIR = join(process.cwd(), ".github", "workflows");
const workflows = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => {
    const text = readFileSync(join(DIR, file), "utf8");
    const doc = loadYaml(text) as { permissions?: unknown; jobs: Record<string, Job> };
    return { file, text, doc };
  });

const usesLines = (text: string) =>
  [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(?:\s+#\s*(\S+))?\s*$/gm)].map((m) => ({
    ref: m[1],
    comment: m[2] ?? null,
  }));

describe("the actions the workflows run", () => {
  it("are found", () => {
    expect(workflows.length).toBeGreaterThanOrEqual(5);
    expect(workflows.flatMap((w) => usesLines(w.text)).length).toBeGreaterThanOrEqual(10);
  });

  it.each(workflows.map((w) => [w.file, w] as const))(
    "%s pins every action to a recorded Node 24 commit, and says which release",
    (_file, w) => {
      for (const { ref, comment } of usesLines(w.text)) {
        if (ref.startsWith("./")) continue;
        const [name, sha] = ref.split("@");
        const pin = NODE24_PINS[name];
        expect(pin, `${ref}: not in the table of checked pins`).toBeDefined();
        expect(sha, ref).toBe(pin.sha);
        expect(comment, `${ref} carries no version comment`).toBe(pin.version);
      }
    },
  );

  it("run on the image they were verified on, never a moving label", () => {
    for (const w of workflows) {
      for (const [name, job] of Object.entries(w.doc.jobs)) {
        expect(job["runs-on"], `${w.file} ${name}`).toBe(RUNNER);
      }
    }
  });

  it("never fetch a dependency cache into a job that holds a secret", () => {
    // setup-node v5 and later can turn caching on by themselves. A cache is
    // written by one run and restored into another, so it has no place in a
    // job holding a fix engine's key or CRON_SECRET.
    for (const w of workflows) {
      for (const [name, job] of Object.entries(w.doc.jobs)) {
        const holdsSecret = /\$\{\{\s*secrets\./.test(JSON.stringify(job));
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("actions/setup-node@") || !holdsSecret) continue;
          expect(step.with?.["package-manager-cache"], `${w.file} ${name}`).toBe(false);
          expect(step.with?.cache, `${w.file} ${name}`).toBeUndefined();
        }
      }
    }
  });

  it("give CI a read-only token and keep it out of the checkout", () => {
    // CI runs every pull request's code. It writes nothing, so its token can
    // write nothing either — and none is left in .git/config for that code.
    const ci = workflows.find((w) => w.file === "ci.yml")!;
    expect(ci.doc.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(ci.doc.jobs)) {
      const checkout = (job.steps ?? []).find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
  });
});
