import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { load as loadYaml } from "js-yaml";

/*
  TWO WAYS A MIGRATION REACHED THIS QUEUE UNJUDGED, AND ONE WAY IT RAN TWICE.

  Both were measured on 12 Sep 2026 against the live queue and the whole
  corpus, not reasoned about.

  ## It ran twice

  `aurixa.drain_schema_migrations()` did `EXECUTE v_row.sql` unconditionally.
  The `INSERT INTO supabase_migrations.schema_migrations … WHERE NOT EXISTS`
  immediately after it reads like an already-applied guard and is not one: it
  prevents a duplicate ledger ROW, not a duplicate APPLY.

  Mission Control is edited in two places, and Lovable APPLIES the migrations
  it authors before committing the file. 141 of 268 files are its work; three
  postdate this queue; two reached it and were replayed. Both replays were
  harmless BY LUCK — `20260909010118`'s own header says every statement in it
  is `IF NOT EXISTS` and the backfill is guarded. The third, `20260909072756`,
  reads "DO NOT REPLAY" because releasing what it releases adds a rollup
  quantity a second time and charges for calls the business absorbs; it escaped
  only because its own count assertion refused and an operator deleted the row.

  The ledger cannot say which files those are. Lovable stamps when it BEGINS
  applying and names the file when it WRITES it, so of those 141 only 36 carry
  their own version in `supabase_migrations.schema_migrations` while 138 have a
  row within ten seconds, skewed -7s to +7s by no constant amount.

  ## It was never judged

  `ci.yml` runs the migration gates and fires on the same push as
  `apply-migrations.yml`. They run CONCURRENTLY and nothing makes the apply
  wait, so a red gate has never stopped a migration executing — and both
  migrations this queue has ever replayed arrived by a DIRECT push to `main`
  from the Lovable app, commit messages "Work in progress" and "Changes", with
  no pull request and so no review at all.
*/

const MIGRATION = "supabase/migrations/20260912150000_recorded_never_replayed.sql";
const WORKFLOW = ".github/workflows/apply-migrations.yml";

const migration = readFileSync(MIGRATION, "utf8");
const workflowText = readFileSync(WORKFLOW, "utf8");

type Step = {
  name?: string;
  uses?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
};
const steps = (loadYaml(workflowText) as { jobs: { apply: { steps: Step[] } } }).jobs.apply.steps;
const stepIndex = (needle: string) => steps.findIndex((s) => (s.name ?? "").includes(needle));
const stepNamed = (needle: string) => steps[stepIndex(needle)];

describe("the drain records a declared-applied migration and never runs it", () => {
  it("guards the EXECUTE, which is the whole change", () => {
    expect(migration).toContain("IF NOT v_row.already_applied THEN");
    expect(migration).toContain("EXECUTE v_row.sql;");
    // The guard must wrap the EXECUTE and nothing else before it.
    const guard = migration.indexOf("IF NOT v_row.already_applied THEN");
    const exec = migration.indexOf("EXECUTE v_row.sql;");
    expect(guard).toBeLessThan(exec);
    expect(migration.slice(guard, exec)).not.toContain("INSERT INTO");
  });

  it("still stamps the ledger on both paths", () => {
    // The stamp is what stops a later replay seeing the version as new. It is
    // owed whether this queue executed the file or was told it had already run.
    //
    // Searched from the EXECUTE rather than from the start of the file: the
    // header QUOTES this statement while explaining why it is not the guard it
    // looks like, and a scan from zero finds the prose.
    const exec = migration.indexOf("EXECUTE v_row.sql;");
    const endif = migration.indexOf("END IF;", exec);
    const stamp = migration.indexOf("INSERT INTO supabase_migrations.schema_migrations", exec);
    expect(endif).toBeGreaterThan(exec);
    expect(stamp).toBeGreaterThan(endif); // outside the guard
  });

  it("gives the two outcomes different statuses", () => {
    expect(migration).toContain(
      "SET status = CASE WHEN v_row.already_applied THEN 'recorded' ELSE 'applied' END",
    );
  });

  it("admits `recorded` at the column, or every such write would be refused", () => {
    expect(migration).toMatch(
      /add constraint schema_migration_queue_status_check[\s\S]*'recorded'/,
    );
    // …and the four that existed keep existing. A constraint rewritten to admit
    // one value and drop another is how a queue stops being able to fail.
    for (const s of ["queued", "running", "applied", "failed"]) {
      expect(migration).toMatch(
        new RegExp(`add constraint schema_migration_queue_status_check[\\s\\S]*'${s}'`),
      );
    }
  });

  it("keeps the recorded path inside the same savepoint as the applied one", () => {
    // A ledger-stamp failure on this path must be handled exactly as one on the
    // other: rolled back, counted as an attempt, terminal on the third. A path
    // that cannot fail is a path whose failures are invisible.
    const guard = migration.indexOf("IF NOT v_row.already_applied THEN");
    const handler = migration.indexOf("EXCEPTION\n      WHEN OTHERS THEN");
    expect(handler).toBeGreaterThan(guard);
  });

  it("declares its own effect, like every migration this queue now records", () => {
    // Load-bearing in a new way: the assertion is what catches a migration that
    // was RECORDED but whose effect never arrived.
    expect(migration).toContain("-- @asserts column:schema_migration_queue.already_applied");
    expect(migration).toContain("-- @asserts check:schema_migration_queue.status=recorded");
  });

  it("adds the column so it can never be null, and defaults to running the file", () => {
    expect(migration).toContain("already_applied boolean not null default false");
  });
});

describe("the apply workflow gates before it submits", () => {
  it("runs the corpus gates in the same job, ahead of the enqueue", () => {
    const gate = stepIndex("Gate the corpus");
    const enqueue = stepIndex("Enqueue and wait");
    expect(gate).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(gate);
  });

  it("runs every migration gate, not a chosen subset", () => {
    const run = stepNamed("Gate the corpus").run ?? "";
    for (const gate of [
      "check-migration-pipeline",
      "check-migration-secrets",
      "check-migration-replay",
      "check-migration-assertions",
    ]) {
      expect(run).toContain(`node scripts/${gate}.mjs`);
    }
    // `set -e`, or a failing gate is a printed error and a green run.
    expect(run).toContain("set -euo pipefail");
  });

  it("asks for a Node that can run them", () => {
    // `check-migration-assertions` imports the grammar from its `.ts` module
    // rather than keeping a second copy, which needs type stripping (>=22.18).
    const setup = steps.find((s) => (s.uses ?? "").startsWith("actions/setup-node"));
    expect(
      String((setup as unknown as { with: { "node-version": unknown } }).with["node-version"]),
    ).toBe("22");
  });
});

describe("the apply workflow classifies by ACCOUNT, never by the file", () => {
  const classify = stepNamed("Classify each migration");

  it("matches the Lovable app on its numeric account id", () => {
    // A display name can be changed; an account id cannot. Nothing here reads
    // the filename — `migrationProvenance.pure.ts` in this repository was
    // written after a shape heuristic misread six genuine applies, and a UUID
    // filename is a shape. Measured: the two signals disagree on 4 of 268
    // files and the author is right both times.
    expect(classify.env?.LOVABLE_APP_AUTHOR).toContain("159125892");
    expect(classify.run ?? "").toContain("git log --diff-filter=A --format=%ae -1");
    expect(classify.run ?? "").not.toMatch(/\[0-9a-f\]\{8\}|uuid/i);
  });

  it("hands the classification to the submitter", () => {
    expect(stepNamed("Enqueue and wait").env?.RECORD_ONLY).toContain("steps.classify.outputs");
  });

  /*
    Executed against a FIXTURE repository, not against this one.

    The shell body is lifted from the YAML verbatim — a guard nobody has run is
    a guard nobody has tested — but the history it walks is built here, with
    known authors, rather than read from this repository's own log.

    That is not tidiness. The first version of this test read real history and
    passed locally and FAILED in CI, because `ci.yml` checks out at depth 1. A
    depth-1 clone does not answer "who added this file" with silence; it
    answers with the TIP COMMIT'S author, for every file. So the test was
    coupled to a mutable log, and the coupling hid the more interesting fact:
    in a shallow clone the classification is confidently wrong, in the
    direction that records a migration without running it.

    Hence the fixture (deterministic, independent of what this repository's
    history happens to be today) and the shallow-clone refusal below.
  */
  const BOT = "159125892+gpt-engineer-app[bot]@users.noreply.github.com";

  /** A throwaway repo whose history says exactly what a case needs it to say. */
  const fixture = (commits: ReadonlyArray<{ author: string; file: string }>) => {
    const dir = mkdtempSync(join(tmpdir(), "classify-repo-"));
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env } });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    for (const c of commits) {
      writeFileSync(join(dir, c.file), "select 1;\n");
      git("add", "-A");
      git("-c", `user.email=${c.author}`, "-c", "user.name=someone", "commit", "-q", "-m", c.file);
    }
    return dir;
  };

  const runClassifyIn = (cwd: string, files: string) => {
    const body = classify.run ?? "";
    const outFile = join(mkdtempSync(join(tmpdir(), "classify-out-")), "out.txt");
    writeFileSync(outFile, "");
    const out = spawnSync("bash", ["-c", body], {
      cwd,
      env: {
        ...process.env,
        FILES: files,
        LOVABLE_APP_AUTHOR: classify.env?.LOVABLE_APP_AUTHOR ?? "",
        GITHUB_OUTPUT: outFile,
      },
      encoding: "utf8",
    });
    const line = /^record_only=(.*)$/m.exec(readFileSync(outFile, "utf8"));
    return {
      status: out.status,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
      /** Exactly what the enqueue step will receive. */
      recordOnly: (line?.[1] ?? "").trim().split(/\s+/).filter(Boolean),
    };
  };

  it("records a migration the Lovable app added, whatever its filename", () => {
    // The slug-named file is the case a filename rule gets wrong: it is the
    // app's work and a UUID test would have replayed it. Measured on the real
    // corpus, the two signals disagree on 4 of 268 files — one bot-authored
    // file is slug-named and three UUID-named files were added by somebody
    // else — and the author is right every time.
    const uuidName = "supabase/migrations/20260909072756_0ed86dad-0bfc.sql";
    const slugName = "supabase/migrations/20260614071328_clone_backends_safe_view.sql";
    const repo = fixture([
      { author: BOT, file: uuidName },
      { author: BOT, file: slugName },
    ]);
    const r = runClassifyIn(repo, `${uuidName} ${slugName}`);
    expect(r.status).toBe(0);
    expect(r.recordOnly).toEqual([uuidName, slugName]);
  });

  it("executes a migration a person added, even with a UUID filename", () => {
    const uuidName = "supabase/migrations/20260609120000_177b3fee-7c98.sql";
    const repo = fixture([{ author: "someone@example.invalid", file: uuidName }]);
    const r = runClassifyIn(repo, uuidName);
    expect(r.status).toBe(0);
    expect(r.recordOnly).toEqual([]);
    expect(r.stdout).toContain("execute");
  });

  it("keeps the two apart in one batch", () => {
    const mine = "supabase/migrations/20260912100000_mine.sql";
    const theirs = "supabase/migrations/20260912110000_theirs.sql";
    const repo = fixture([
      { author: "someone@example.invalid", file: mine },
      { author: BOT, file: theirs },
    ]);
    const r = runClassifyIn(repo, `${mine} ${theirs}`);
    expect(r.status).toBe(0);
    expect(r.recordOnly).toEqual([theirs]);
  });

  it("executes, and warns, when it cannot read who added the file", () => {
    // The fail-safe direction. Unknown means RUN, which is the behaviour that
    // existed before this — a guard that skipped on doubt would silently leave
    // the schema short of an effect nobody applied.
    //
    // Asserted on the output variable, not the log. A mutation that kept
    // printing "execute" while adding the file to RECORD_ONLY passed the log
    // assertion and failed this one.
    const repo = fixture([{ author: BOT, file: "supabase/migrations/20260101000000_a.sql" }]);
    const r = runClassifyIn(repo, "supabase/migrations/never-committed.sql");
    expect(r.status).toBe(0);
    expect(r.recordOnly).toEqual([]);
    expect(r.stdout).toContain("::warning title=Unattributed migration");
    expect(r.stdout).toContain("author unknown");
  });

  it("refuses a shallow clone rather than attributing every file to the tip", () => {
    // The failure CI found. `git log --diff-filter=A -1 -- <path>` walks only
    // the commits it has, so at depth 1 every file resolves to the tip's
    // author — and a push authored BY the app would then record its whole
    // batch without running any of it.
    const src = fixture([
      { author: "someone@example.invalid", file: "supabase/migrations/20260101000000_a.sql" },
      { author: BOT, file: "supabase/migrations/20260102000000_b.sql" },
    ]);
    const shallow = mkdtempSync(join(tmpdir(), "classify-shallow-"));
    const clone = spawnSync("git", ["clone", "--depth", "1", `file://${src}`, shallow, "-q"], {
      encoding: "utf8",
    });
    expect(clone.status).toBe(0);

    const r = runClassifyIn(shallow, "supabase/migrations/20260101000000_a.sql");
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("::error title=Shallow checkout");
    expect(r.recordOnly).toEqual([]);
  });
});
