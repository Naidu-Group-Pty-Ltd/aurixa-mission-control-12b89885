import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
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
  THE RUN THAT MAKES THE MANIFEST STALE IS THE RUN THAT ASKS FOR IT TO BE REFRESHED.

  A migration's digest exists only once it has RUN, so the manifest is
  necessarily short by whatever a push just applied. That gap used to stay open
  until somebody remembered `npm run migrations:digests` — and "somebody
  remembered" is the failure mode every other part of this pipeline exists to
  remove.

  The job used to close it by pushing to `main` itself. `main` is protected
  now and no workflow token may push there, so the job asks Mission Control,
  which proposes the file through its own App as a pull request that merges
  itself once CI passes. The job keeps `contents: read`.

  The script is EXECUTED below against a stub Mission Control, every answer it
  can get, and must leave the run green on every one.
*/
describe("the apply job asks Mission Control to propose the manifest", () => {
  const applyYaml = readFileSync(".github/workflows/apply-migrations.yml", "utf8");
  const doc = loadYaml(applyYaml) as {
    permissions?: Record<string, string>;
    jobs: { apply: { permissions?: Record<string, string>; steps: Step[] } };
  };
  const job = doc.jobs.apply;
  const step = job.steps.find((s) => (s.name ?? "").startsWith("Refresh the digest"));
  const PROPOSE = resolve(".github/scripts/propose-applied-digests.mjs");

  it("exists, and runs after the migrations have actually settled", () => {
    expect(step?.run?.trim()).toBe("node .github/scripts/propose-applied-digests.mjs");
    const order = job.steps.map((s) => s.name ?? s.uses ?? "");
    expect(order.indexOf("Refresh the digest manifest")).toBeGreaterThan(
      order.indexOf("Enqueue and wait"),
    );
  });

  it("holds no write token: not on the job, not on the workflow, and pushes nothing", () => {
    // The job that holds CRON_SECRET used to hold `contents: write` too, to
    // push the manifest to `main`. Protection on `main` refuses that push now,
    // and the write token was never what this job was for.
    expect(job.permissions).toBeUndefined();
    expect(doc.permissions).toEqual({ contents: "read" });
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/\bgit push\b/);
    expect(applyYaml).not.toMatch(/\$\{\{\s*github\.token\s*\}\}/);
    expect(applyYaml).not.toMatch(/secrets\.GITHUB_TOKEN/);
  });

  it("never persists a credential into the checkout", () => {
    // The same job submits SQL; no repository token belongs in `.git/config`.
    const checkout = job.steps.find((s) => (s.uses ?? "").startsWith("actions/checkout"));
    expect((checkout as unknown as { with: Record<string, unknown> }).with).toMatchObject({
      "persist-credentials": false,
    });
  });

  const propose = async (answer: { status: number; json: unknown } | null, env = {}) => {
    let asked: unknown = null;
    const url = answer
      ? await stubServer((body) => {
          asked = body;
          return answer;
        })
      : "http://127.0.0.1:9";
    const dir = mkdtempSync(join(tmpdir(), "propose-"));
    const r = await run(PROPOSE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x", ...env });
    return { ...r, asked };
  };

  it("asks for a proposal, and reports one armed to merge itself", async () => {
    const r = await propose({
      status: 200,
      json: {
        success: true,
        proposal: {
          state: "proposed",
          number: 412,
          url: "https://github.com/o/r/pull/412",
          armed: true,
          detail: "PR #412 carries 61 settled migrations and merges itself once CI passes.",
        },
      },
    });
    expect(r.asked).toEqual({ action: "propose_digests" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("::notice title=Digest manifest proposed::PR #412");
    expect(r.out).toContain("https://github.com/o/r/pull/412");
  });

  it("says so when the manifest already agrees", async () => {
    const r = await propose({
      status: 200,
      json: { success: true, proposal: { state: "current", detail: "already lists all 61" } },
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Manifest already agrees with the queue");
    expect(r.out).not.toContain("::warning");
  });

  it("warns, green, when the proposal waits for a person", async () => {
    const r = await propose({
      status: 200,
      json: {
        success: true,
        proposal: {
          state: "proposed",
          number: 9,
          url: "https://github.com/o/r/pull/9",
          armed: false,
          detail: "Auto-merge could not be armed",
        },
      },
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning title=Digest manifest waits for a merge::");
  });

  it.each([
    [
      "a failed proposal",
      { status: 200, json: { success: false, proposal: { state: "failed", detail: "boom" } } },
      /Manifest not refreshed::boom/,
    ],
    [
      "a deployment older than the action",
      { status: 400, json: { success: false, error: "no migrations submitted" } },
      /does not propose the manifest yet \(HTTP 400/,
    ],
    ["a server error", { status: 500, json: { error: "down" } }, /HTTP 500/],
  ])("warns and leaves the run green on %s", async (_what, answer, said) => {
    // The migrations applied before this ran. Bookkeeping must not undo that.
    const r = await propose(answer);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(said);
    expect(r.out).toContain("migrations:digests");
  });

  it("warns and leaves the run green when Mission Control cannot be reached", async () => {
    const r = await propose(null);
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      "::warning title=Manifest not refreshed::Could not reach Mission Control",
    );
  });

  it("asks nothing without its URL and credential", async () => {
    const r = await propose(
      { status: 200, json: { success: true, proposal: { state: "current", detail: "x" } } },
      { CRON_SECRET: "" },
    );
    expect(r.status).toBe(0);
    expect(r.asked).toBeNull();
    expect(r.out).toContain("CRON_SECRET is empty");
  });

  it("cannot be made to forge a workflow command through what it reports", async () => {
    // GitHub reads a workflow command per line; a newline in a detail would
    // start a command of the detail's choosing.
    const r = await propose({
      status: 200,
      json: {
        success: false,
        proposal: { state: "failed", detail: "x\n::add-mask::y\r\n::error::z" },
      },
    });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/^::add-mask::/m);
    expect(r.out).not.toMatch(/^::error::/m);
    expect(r.out).toContain("x%0A::add-mask::y%0D%0A::error::z");
  });
});

/*
  ONE RENDERER FOR BOTH WRITERS.

  `npm run migrations:digests` writes the manifest here; Mission Control
  proposes it on Prime. Both render through `appliedDigestManifest.pure.ts`, so
  a refresh from either never differs from the other in anything but the
  digests — which is what keeps every proposal a diff of entries, not of
  formatting.
*/
describe("the manifest renderer", () => {
  it("keeps the header, sorts by version, and writes two-space columns", async () => {
    const { renderManifest } = await import("./appliedDigestManifest.pure");
    const existing = "# generated\n# do not edit\n20260101000000  aaa  old.sql\n";
    const out = renderManifest(existing, [
      { version: "20260102000000", sha256: "bbb", name: "b.sql" },
      { version: "20260101000000", sha256: "ccc", name: "a.sql" },
    ]);
    expect(out).toBe(
      "# generated\n# do not edit\n20260101000000  ccc  a.sql\n20260102000000  bbb  b.sql\n",
    );
  });

  it("is what the local script writes", async () => {
    const { renderManifest } = await import("./appliedDigestManifest.pure");
    const live = [
      {
        version: "20260102000000",
        name: "20260102000000_b.sql",
        sha256: sha("b"),
        status: "applied",
      },
      { version: "20260101000000", name: NAME, sha256: sha(BODY), status: "applied" },
    ];
    const url = await stubServer(() => ({ status: 200, json: { success: true, digests: live } }));
    const before = `# generated\n20260101000000  ${sha(BODY)}  ${NAME}\n`;
    const dir = tree({ files: {}, manifest: before });
    const r = await run(ONLINE, dir, { MISSION_CONTROL_URL: url, CRON_SECRET: "x" });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "scripts", "applied-migration-digests.txt"), "utf8")).toBe(
      renderManifest(before, live),
    );
  });
});
