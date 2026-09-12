import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

/*
  `sha256` WAS WRITTEN FROM THE FIRST VERSION OF THE QUEUE AND NEVER READ.

  `schema_migration_queue.sha256`'s own comment says it exists "so what RAN can
  be compared to the repo". Nothing compared it. Measured 12 Sep 2026: 2 of 55
  settled rows already differed from their repository file, and no surface
  anywhere said so.

  Editing a migration that has already applied is the mistake the pipeline
  refuses everywhere else — `enqueue` will not overwrite the SQL of a version it
  holds, and the apply workflow prints a warning for a modified file. But that
  warning fires only for the push that does it, and only if the push went
  through that workflow.

  ## Why it is two halves

  The digests live in Mission Control's database, which this repository cannot
  reach. Reaching it needs `CRON_SECRET` — the credential that authenticates 32
  scheduled workers AND the endpoint that executes SQL as `postgres`. Putting
  that in `ci.yml`, which runs on every pull request, to power a read-only
  comparison is not a trade worth making.

  So: the digests travel as a committed manifest, `check-applied-digests.mjs`
  judges the repository against it offline on every pull request, and
  `refresh-applied-digests.mjs --check` runs in `apply-migrations.yml` — which
  already holds the credential — so the manifest cannot drift from the live
  table unnoticed.

  Both scripts are EXECUTED here, against fixture trees and a stub server, not
  asserted about.
*/

const OFFLINE = resolve("scripts/check-applied-digests.mjs");
const ONLINE = resolve("scripts/refresh-applied-digests.mjs");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A throwaway repo-shaped tree: `supabase/migrations` plus the two data files. */
const tree = (opts: { files: Record<string, string>; manifest: string; baseline?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "digests-"));
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const [name, body] of Object.entries(opts.files)) {
    writeFileSync(join(dir, "supabase", "migrations", name), body);
  }
  writeFileSync(join(dir, "scripts", "applied-migration-digests.txt"), opts.manifest);
  if (opts.baseline !== undefined) {
    writeFileSync(join(dir, "scripts", "applied-digest-baseline.txt"), opts.baseline);
  }
  return dir;
};

/*
  ASYNC, and that is load-bearing rather than stylistic.

  `spawnSync` blocks the calling process's event loop. The stub server below
  lives in THIS process, so a synchronous spawn means the server can never
  accept the child's connection and both sides wait for ever — which is exactly
  what the first version of this file did, until it timed out.
*/
const run = (
  script: string,
  dir: string,
  env: Record<string, string> = {},
  args: string[] = [],
): Promise<{ status: number; out: string }> =>
  new Promise((resolve) => {
    execFile(
      "node",
      [script, ...args],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const status =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ status, out: (stdout ?? "") + (stderr ?? "") });
      },
    );
  });

/** One step of a workflow job, as `js-yaml` gives it back. */
type Step = {
  name?: string;
  uses?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
};

/** Git, synchronously — setup and inspection only, never while a stub must answer. */
const spawnSyncGit = (cwd: string, args: readonly string[]) =>
  spawnSync("git", args as string[], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

/** A Mission Control stand-in. Closed after the file's tests finish. */
const allServers: Server[] = [];
const stubServer = async (handler: (body: unknown) => { status: number; json: unknown }) => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { status, json } = handler(JSON.parse(raw || "{}"));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  allServers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
};
afterAll(() => allServers.forEach((s) => s.close()));

const NAME = "20260101000000_a.sql";
const BODY = "create table public.a ();\n";

describe("check-applied-digests — the repository against what ran", () => {
  it("passes when every named file is byte-identical", async () => {
    const dir = tree({
      files: { [NAME]: BODY },
      manifest: `# generated\n20260101000000  ${sha(BODY)}  ${NAME}\n`,
    });
    const r = await run(OFFLINE, dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain("1 of 1 settled migration(s) byte-identical");
  });

  it("fails when a migration changed after it applied", async () => {
    const dir = tree({
      files: { [NAME]: BODY + "-- added later\n" },
      manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n`,
    });
    const r = await run(OFFLINE, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("changed after they were applied");
    // The remedy must not be "rewrite the queue", which is history.
    expect(r.out).toContain("NEVER rewrite the queue's copy");
  });

  it("fails when a migration that ran no longer exists in the repo", async () => {
    const dir = tree({ files: {}, manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n` });
    const r = await run(OFFLINE, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("no longer exist in the repo");
  });

  it("judges only what the manifest names", async () => {
    // A migration the queue has not settled — including one added in this very
    // pull request — has no digest to be judged against. Judging it would be
    // judging a file against a row that does not exist.
    const dir = tree({
      files: { [NAME]: BODY, "20260102000000_b.sql": "create table public.b ();\n" },
      manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n`,
    });
    expect((await run(OFFLINE, dir)).status).toBe(0);
  });

  it("accepts a baselined drift, and says how many", async () => {
    const dir = tree({
      files: { [NAME]: BODY + "-- documented afterwards\n" },
      manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n`,
      baseline: "20260101000000  # comment-only, statements verified identical\n",
    });
    const r = await run(OFFLINE, dir);
    expect(r.status).toBe(0);
    expect(r.out).toContain("1 baselined");
  });

  it("fails on a baseline entry that is no longer needed", async () => {
    // An exemption left on a file that matches re-arms silently the next time
    // that file is edited — the guard would be off and nothing would say so.
    const dir = tree({
      files: { [NAME]: BODY },
      manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n`,
      baseline: "20260101000000  # spent\n",
    });
    const r = await run(OFFLINE, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("no longer needed");
  });

  it("fails on a line it cannot read rather than skipping it", async () => {
    // A manifest that silently drops what it cannot parse reports coverage it
    // does not have.
    const dir = tree({
      files: { [NAME]: BODY },
      manifest: `20260101000000  ${sha(BODY)}  ${NAME}\nnot a digest line at all\n`,
    });
    const r = await run(OFFLINE, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("line(s) this cannot read");
  });

  it("fails when the manifest is missing entirely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digests-none-"));
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    const r = await run(OFFLINE, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("is missing");
  });
});

describe("refresh-applied-digests --check — the manifest against the live queue", () => {
  const servers: Server[] = [];
  const stub = async (handler: (body: unknown) => { status: number; json: unknown }) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { status, json } = handler(JSON.parse(raw || "{}"));
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  };
  afterAll(() => servers.forEach((s) => s.close()));

  const digest = (version: string, name: string, body: string) => ({
    version,
    name,
    sha256: sha(body),
    status: "applied",
  });

  it("passes when the manifest agrees, and asks only for digests", async () => {
    let asked: unknown = null;
    const url = await stub((body) => {
      asked = body;
      return {
        status: 200,
        json: { success: true, digests: [digest("20260101000000", NAME, BODY)] },
      };
    });
    const dir = tree({ files: {}, manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n` });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x" }, ["--check"]);
    expect(r.status).toBe(0);
    expect(asked).toEqual({ action: "digests" });
  });

  it("fails when a manifest entry contradicts the queue", async () => {
    // A hand-edited manifest would make the OFFLINE check pass against a digest
    // nothing ever ran. This is the only place that can catch it.
    const url = await stub(() => ({
      status: 200,
      json: { success: true, digests: [digest("20260101000000", NAME, BODY)] },
    }));
    const dir = tree({
      files: {},
      manifest: `20260101000000  ${sha("something else")}  ${NAME}\n`,
    });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x" }, ["--check"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("disagree with the live queue");
  });

  it("fails on an entry naming a version the queue never settled", async () => {
    const url = await stub(() => ({ status: 200, json: { success: true, digests: [] } }));
    const dir = tree({ files: {}, manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n` });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x" }, ["--check"]);
    expect(r.status).toBe(1);
  });

  it("refuses an empty digest list rather than writing it over the manifest", async () => {
    // Zero settled migrations is not a state this queue can be in, so it is a
    // failed read. Writing it would erase the manifest and turn the offline
    // check into a no-op that reports success — the confident-clear-against-
    // nothing shape this platform has already shipped once.
    const url = await stub(() => ({ status: 200, json: { success: true, digests: [] } }));
    const dir = tree({ files: {}, manifest: "# generated\n" });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Refusing an empty digest list");
    expect(readFileSync(join(dir, "scripts", "applied-migration-digests.txt"), "utf8")).toBe(
      "# generated\n",
    );
  });

  it("reports a manifest that is merely BEHIND without failing", async () => {
    // It has to. A migration's digest exists only once it has run, so the
    // manifest is always short by whatever the current push is about to apply.
    const url = await stub(() => ({
      status: 200,
      json: {
        success: true,
        digests: [
          digest("20260101000000", NAME, BODY),
          digest("20260102000000", "20260102000000_b.sql", "create table public.b ();\n"),
        ],
      },
    }));
    const dir = tree({ files: {}, manifest: `20260101000000  ${sha(BODY)}  ${NAME}\n` });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x" }, ["--check"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("::notice title=Digest manifest is behind");
    expect(r.out).toContain("20260102000000");
  });

  it("refuses to guess the origin or the credential", async () => {
    const dir = tree({ files: {}, manifest: "# generated\n" });
    expect(
      (await run(ONLINE, dir, { MISSION_CONTROL_URL: "", CRON_SECRET: "x" }, ["--check"])).out,
    ).toContain("MISSION_CONTROL_URL is empty");
    expect(
      (await run(ONLINE, dir, { MISSION_CONTROL_URL: "http://x", CRON_SECRET: "" }, ["--check"]))
        .out,
    ).toContain("CRON_SECRET is empty");
  });

  it("names the right remedy on a 401 instead of inviting a guess", async () => {
    const url = await stub(() => ({ status: 401, json: { error: "unauthorized" } }));
    const dir = tree({ files: {}, manifest: "# generated\n" });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "wrong" }, [
      "--check",
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Do NOT guess it");
  });

  it("writes the manifest sorted, keeping the header", async () => {
    const url = await stub(() => ({
      status: 200,
      json: {
        success: true,
        digests: [
          digest("20260102000000", "20260102000000_b.sql", "b"),
          digest("20260101000000", NAME, BODY),
        ],
      },
    }));
    const dir = tree({ files: {}, manifest: "# generated — do not edit by hand.\n" });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x" });
    expect(r.status).toBe(0);
    const written = readFileSync(join(dir, "scripts", "applied-migration-digests.txt"), "utf8");
    expect(written).toContain("# generated — do not edit by hand.");
    const versions = [...written.matchAll(/^(\d{14})\s/gm)].map((m) => m[1]);
    expect(versions).toEqual(["20260101000000", "20260102000000"]);
  });
});

describe("the two halves are wired where their credentials allow", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const apply = readFileSync(".github/workflows/apply-migrations.yml", "utf8");

  it("runs the offline check on every pull request", () => {
    expect(ci).toContain("npm run check:applied-digests");
  });

  it("keeps CRON_SECRET out of the pull-request workflow", () => {
    // It authenticates 32 scheduled workers and the endpoint that runs SQL as
    // postgres. A read-only comparison does not justify putting it in a
    // workflow that fires on every pull request.
    //
    // Judged on what the workflow DOES, not on what it says: the first version
    // of this assertion was a `toContain` over the whole file and failed on the
    // comment above explaining why the credential is absent. A guard that fires
    // on prose reports a contradiction about correct code, and those are the
    // guards people learn to silence.
    expect(ci).not.toMatch(/\$\{\{\s*secrets\.CRON_SECRET\s*\}\}/);
    expect(ci).not.toMatch(/^\s*CRON_SECRET\s*:/m);
    expect(ci).not.toMatch(/^\s*run:.*migrations:digests/m);
    expect(ci).not.toMatch(/^\s*run:.*refresh-applied-digests/m);
  });

  it("verifies the manifest where that credential already lives", () => {
    expect(apply).toContain("refresh-applied-digests.mjs --check");
    expect(apply).toContain("CRON_SECRET");
  });

  it("verifies the manifest BEFORE anything is submitted", () => {
    expect(apply.indexOf("refresh-applied-digests.mjs --check")).toBeLessThan(
      apply.indexOf("enqueue-migrations.mjs"),
    );
  });
});

/*
  THE RUN THAT MAKES THE MANIFEST STALE IS THE RUN THAT REFRESHES IT.

  A migration's digest exists only once it has RUN, so the manifest is
  necessarily short by whatever a push just applied. That gap used to stay open
  until somebody remembered `npm run migrations:digests` — and "somebody
  remembered" is the failure mode every other part of this pipeline exists to
  remove.

  The apply job closes it in the same run: the apply has settled, and that job
  is the one place holding the credential to read the new digests.

  The step's shell body is lifted from the YAML and EXECUTED below against a
  real git repository with a real local remote and a stub Mission Control. One
  line is substituted — the `ORIGIN=` URL, which hardcodes github.com — and
  nothing else; the logic under test (regenerate, compare, commit, push, reset,
  retry) runs verbatim.
*/
describe("the apply job refreshes and commits the manifest", () => {
  const applyYaml = readFileSync(".github/workflows/apply-migrations.yml", "utf8");
  const steps = (
    loadYaml(applyYaml) as {
      jobs: { apply: { permissions?: Record<string, string>; steps: Step[] } };
    }
  ).jobs.apply;
  const step = steps.steps.find((s) => (s.name ?? "").startsWith("Refresh the digest"));

  it("exists, and runs after the migrations have actually settled", () => {
    expect(step).toBeDefined();
    const order = steps.steps.map((s) => s.name ?? s.uses ?? "");
    expect(order.indexOf("Refresh the digest manifest and commit it")).toBeGreaterThan(
      order.indexOf("Enqueue and wait"),
    );
  });

  it("takes the write permission on the job, not the workflow", () => {
    // Scoped to the one job that needs it. The workflow-level default stays
    // read, so nothing else this file might grow inherits repository write.
    expect(steps.permissions).toEqual({ contents: "write" });
    expect(loadYaml(applyYaml)).toMatchObject({ permissions: { contents: "read" } });
  });

  it("never persists the push credential into the checkout", () => {
    // The same job submits SQL. Building the authenticated URL in-step keeps a
    // repository token out of `.git/config` for every other step.
    const checkout = steps.steps.find((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect((checkout as unknown as { with: Record<string, unknown> }).with).toMatchObject({
      "persist-credentials": false,
    });
  });

  /** The step body, with only the hardcoded github.com origin redirected. */
  const stepBody = (remote: string) =>
    (step?.run ?? "").replace(/^\s*ORIGIN=.*$/m, `          ORIGIN=${JSON.stringify(remote)}`);

  /** A repo with a bare remote and a manifest, as the job would find it. */
  const repoWithRemote = (manifest: string) => {
    const root = mkdtempSync(join(tmpdir(), "refresh-"));
    const bare = join(root, "remote.git");
    const work = join(root, "work");
    const git = (cwd: string, ...args: string[]) => spawnSyncGit(cwd, args);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "-q", "-b", "main");
    mkdirSync(work, { recursive: true });
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.email", "fixture@example.invalid");
    git(work, "config", "user.name", "fixture");
    mkdirSync(join(work, "scripts"), { recursive: true });
    writeFileSync(join(work, "scripts", "applied-migration-digests.txt"), manifest);
    // The step runs the real script from the repo root it is standing in, so
    // the fixture carries a copy. Committed in the seed, so it survives the
    // `reset --hard` the retry path performs.
    writeFileSync(
      join(work, "scripts", "refresh-applied-digests.mjs"),
      readFileSync(ONLINE, "utf8"),
    );
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "seed");
    git(work, "push", "-q", bare, "main");
    return { root, bare, work };
  };

  const remoteManifest = (bare: string) =>
    spawnSyncGit(bare, ["show", "main:scripts/applied-migration-digests.txt"]).stdout ?? "";

  const runStep = (work: string, bare: string, url: string, env: Record<string, string> = {}) =>
    new Promise<{ status: number; out: string }>((res) => {
      execFile(
        "bash",
        ["-c", stepBody(bare)],
        {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            GH_TOKEN: "unused-for-a-local-remote",
            GITHUB_REPOSITORY: "fixture/repo",
            GITHUB_REF_NAME: "main",
            MANIFEST: "scripts/applied-migration-digests.txt",
            MISSION_CONTROL_URL: url,
            CRON_SECRET: "x",
            ...env,
          },
        },
        (err, stdout, stderr) => {
          const status =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          res({ status, out: (stdout ?? "") + (stderr ?? "") });
        },
      );
    });

  it("commits and pushes the new digests when the manifest is behind", async () => {
    const live = [
      { version: "20260101000000", name: NAME, sha256: sha(BODY), status: "applied" },
      {
        version: "20260102000000",
        name: "20260102000000_b.sql",
        sha256: sha("b"),
        status: "applied",
      },
    ];
    const url = await stubServer(() => ({ status: 200, json: { success: true, digests: live } }));
    const { bare, work } = repoWithRemote(`# generated\n20260101000000  ${sha(BODY)}  ${NAME}\n`);

    const r = await runStep(work, bare, url);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Manifest refreshed and committed");
    // The REMOTE is what matters — a local commit nobody pushed closes nothing.
    expect(remoteManifest(bare)).toContain("20260102000000");
    expect(remoteManifest(bare)).toContain("# generated");
  });

  it("commits nothing when the manifest already agrees", async () => {
    const url = await stubServer(() => ({
      status: 200,
      json: {
        success: true,
        digests: [{ version: "20260101000000", name: NAME, sha256: sha(BODY), status: "applied" }],
      },
    }));
    const { bare, work } = repoWithRemote(`# generated\n20260101000000  ${sha(BODY)}  ${NAME}\n`);
    const before = spawnSyncGit(bare, ["rev-parse", "main"]).stdout?.trim();

    const r = await runStep(work, bare, url);
    expect(r.status).toBe(0);
    // The step's OWN wording, not git's. The first version of this assertion
    // read `toContain("nothing to commit")` and passed against a mutation that
    // removed the guard entirely — because that is what `git commit` prints on
    // an empty index, and stderr is captured here too. A guard asserted through
    // somebody else's error message is not asserted.
    expect(r.out).toContain("Manifest already agrees with the queue");
    expect(r.out).not.toContain("Manifest refreshed and committed");
    expect(spawnSyncGit(bare, ["rev-parse", "main"]).stdout?.trim()).toBe(before);
  });

  it("warns and leaves the run green when the digests cannot be read", async () => {
    // The migrations are applied by the time this is reached. A bookkeeping
    // step that could undo that is worse than a stale file.
    const url = await stubServer(() => ({ status: 500, json: { error: "boom" } }));
    const { bare, work } = repoWithRemote("# generated\n");
    const r = await runStep(work, bare, url);
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning title=Manifest not refreshed");
  });

  it("loses a race, resets to the new tip, and still lands the manifest", async () => {
    const url = await stubServer(() => ({
      status: 200,
      json: {
        success: true,
        digests: [
          { version: "20260101000000", name: NAME, sha256: sha(BODY), status: "applied" },
          {
            version: "20260102000000",
            name: "20260102000000_b.sql",
            sha256: sha("b"),
            status: "applied",
          },
        ],
      },
    }));
    const { root, bare, work } = repoWithRemote(
      `# generated\n20260101000000  ${sha(BODY)}  ${NAME}\n`,
    );

    // Somebody else pushes while this run was working.
    const other = join(root, "other");
    spawnSyncGit(root, ["clone", "-q", bare, other]);
    spawnSyncGit(other, ["config", "user.email", "other@example.invalid"]);
    spawnSyncGit(other, ["config", "user.name", "other"]);
    writeFileSync(join(other, "unrelated.txt"), "landed first\n");
    spawnSyncGit(other, ["add", "-A"]);
    spawnSyncGit(other, ["commit", "-q", "-m", "unrelated"]);
    spawnSyncGit(other, ["push", "-q", "origin", "main"]);

    const r = await runStep(work, bare, url);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Push rejected on attempt 1");
    expect(r.out).toContain("Manifest refreshed and committed");
    // Both survive: the other commit kept, the manifest added on top.
    expect(remoteManifest(bare)).toContain("20260102000000");
    expect(spawnSyncGit(bare, ["show", "main:unrelated.txt"]).stdout).toContain("landed first");
  });
});
